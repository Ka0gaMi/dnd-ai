// Writes <runDir>/report.md for a playtest run: the systems touched, model cost, tool use, the tool surface, a leak scan of
// what the player window can read, and a transcript digest. Usage: node --import tsx scripts/playtest/report.mts <runDir>
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Express } from 'express';
import { campaignSnapshot } from '../../src/core/campaign.js';
import { DM_ONLY_FIELDS, type DmOnlyFieldId } from '../../src/core/secret-fields.js';
import { showSecrets } from '../../src/core/story.js';
import { migrate, type Db } from '../../src/db/connection.js';
import { createGameServer } from '../../src/mcp/server.js';
import { createApp, HOST } from '../../src/transport/http.js';
import { groupTurns, parseLog, redundantReads, refusalRates, replyTokens, turnStats, type Call } from '../toolstats.mjs';

interface Usage {
  duration_ms?: number | null;
  duration_api_ms?: number | null;
  num_turns?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  total_cost_usd?: number | null;
}

interface Entry {
  turn: number;
  role: 'player' | 'dm';
  text: string;
  tool_calls?: Array<{ name: string; input?: unknown }>;
  at?: string;
  started_at?: string;
  finished_at?: string;
  usage?: Usage | null;
}

interface Turn {
  turn: number;
  player?: Entry;
  dm?: Entry;
  /** Milliseconds since the epoch; NaN when the transcript does not say. */
  start: number;
  end: number;
}

interface Result {
  time: number;
  name: string;
  op?: string;
  error: boolean;
  ms: number;
  bytes: number;
  text: string;
}

interface Payload {
  surface: string;
  route: string;
  status: number;
  hay: string;
}

/** Values shorter than this match too much by chance to call a hit a leak. */
const MIN_LENGTH = 8;
/** Tools that resolve dice in the engine, so a number narrated after one is not invented. */
const DICE_TOOLS = ['roll', 'roll_table', 'attack', 'use_action'];
const NARRATED_ROLL =
  /\b\d+\s+(?:points?\s+of\s+)?(?:[a-z]+\s+)?damage\b|\brol(?:l|ls|led)\s+an?\s+(?:natural\s+)?\d+\b|\b(?:regains?|heals?)\s+\d+\b/i;
const SPOILER_GATED = 'the spoiler toggle is off';

const ISO = String.raw`(\d{4}-\d\d-\d\dT[\d:.]+Z)`;
const CALL_LINE = new RegExp(`^${ISO} tools/call (\\S+) ?(.*)$`);
const RESULT_LINE = new RegExp(`^${ISO} tools/result (\\S+) (ok|error) (\\d+)ms (\\d+)B ?(.*)$`);
const OP = /"op"\s*:\s*"([^"]*)"/;

const pluck = (db: Db, sql: string, ...params: unknown[]): unknown[] => db.prepare(sql).pluck().all(...params);
const strings = (values: unknown[]): string[] => values.filter((v) => v !== null && v !== undefined).map(String);
const parseJson = (text: unknown): unknown => {
  try {
    return typeof text === 'string' ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

/** Free text and each of its lines, so one copied line of a longer secret is still caught. */
function prose(values: unknown[]): string[] {
  return strings(values).flatMap((value) => {
    const lines = value
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
      .filter(Boolean);
    return lines.length > 1 ? [value, ...lines] : [value];
  });
}

/** Names of unidentified items anywhere in the given inventories, containers included. */
function unidentifiedNames(inventories: unknown[]): string[] {
  type Item = { name?: unknown; magic?: { identified?: unknown }; container?: { contents?: Item[] } };
  const walk = (items: unknown): string[] =>
    Array.isArray(items)
      ? (items as Item[]).flatMap((item) => [
          ...(item?.magic?.identified === false && typeof item.name === 'string' ? [item.name] : []),
          ...walk(item?.container?.contents),
        ])
      : [];
  return inventories.flatMap((json) => walk(parseJson(json)));
}

function unheardPortents(agendas: unknown[]): string[] {
  return agendas.flatMap((json) => {
    const portents = parseJson(json);
    if (!Array.isArray(portents)) return [];
    return (portents as Array<{ text?: unknown; heard?: unknown }>)
      .filter((p) => p?.heard !== true && typeof p?.text === 'string')
      .map((p) => p.text as string);
  });
}

type Extract = { values: string[]; note?: string };

/** How to read each DM-only field's live values from a run's database; a field missing here is reported unchecked. */
const EXTRACTORS: Partial<Record<DmOnlyFieldId, (db: Db, id: number) => Extract>> = {
  rumour_truth: (db, id) => ({
    values: strings(pluck(db, 'SELECT truth FROM rumour WHERE campaign_id = ? AND resolved = 0', id)),
    note: 'an enum, never long enough; test/secret-fields.test.ts checks it by key',
  }),
  unheard_rumour: (db, id) => ({
    values: prose(pluck(db, 'SELECT text FROM rumour WHERE campaign_id = ? AND heard_at IS NULL', id)),
  }),
  packet_truth: (db, id) => ({
    values: strings(pluck(db, 'SELECT truth FROM world_packet WHERE campaign_id = ?', id)),
    note: 'an enum, never long enough; test/secret-fields.test.ts checks it by key',
  }),
  outline_secret_notes: (db, id) => ({
    values: prose(pluck(db, 'SELECT secret_notes FROM story_outline WHERE campaign_id = ?', id)),
  }),
  hidden_thread: (db, id) => ({
    values: prose(
      db.prepare('SELECT title, summary FROM plot_thread WHERE campaign_id = ? AND hidden = 1').raw().all(id).flat(),
    ),
  }),
  hidden_clue: (db, id) => ({ values: prose(pluck(db, 'SELECT text FROM clue WHERE campaign_id = ? AND hidden = 1', id)) }),
  codex_hidden_notes: (db, id) => ({
    values: prose(pluck(db, "SELECT hidden_notes FROM entity WHERE campaign_id = ? AND hidden_notes <> ''", id)),
  }),
  unidentified_item_name: (db, id) => ({
    values: unidentifiedNames(pluck(db, 'SELECT inventory_json FROM character WHERE campaign_id = ?', id)),
  }),
  secret_faction: (db, id) => ({
    values: strings(
      pluck(db, "SELECT name FROM world_faction WHERE campaign_id = ? AND secrecy = 'secret' AND ended_day IS NULL", id),
    ),
  }),
  ended_secret_faction: (db, id) => ({
    values: strings(
      pluck(db, "SELECT name FROM world_faction WHERE campaign_id = ? AND secrecy = 'secret' AND ended_day IS NOT NULL", id),
    ),
  }),
  hidden_agenda: () => ({
    values: [],
    note: 'not checked: an agenda has no text of its own, its target name is public and its signs are checked under unheard_portent',
  }),
  unheard_portent: (db, id) => ({
    values: unheardPortents(pluck(db, 'SELECT portents_json FROM world_agenda WHERE campaign_id = ?', id)),
  }),
  faction_resources: (db, id) => ({
    values: strings(pluck(db, 'SELECT resources FROM world_faction WHERE campaign_id = ?', id)),
    note: 'small integers, never long enough',
  }),
  faction_capacities: (db, id) => ({
    values: strings(pluck(db, "SELECT capacities_json FROM world_faction WHERE campaign_id = ? AND capacities_json <> '{}'", id)),
    note: 'whole JSON value only',
  }),
  secret_event: (db, id) => ({
    values: prose(
      pluck(
        db,
        `SELECT text FROM world_event WHERE campaign_id = ? AND visibility = 'secret'
         UNION SELECT p.text FROM world_packet p JOIN world_event e ON e.id = p.event_id
         WHERE p.campaign_id = ? AND e.visibility = 'secret'`,
        id,
        id,
      ),
    ),
  }),
  unknown_danger_name: (db, id) => ({
    values: strings(
      pluck(db, "SELECT name FROM world_place WHERE campaign_id = ? AND kind = 'danger' AND known_to_party = 0", id),
    ),
  }),
  unknown_area_name: (db, id) => ({
    values: strings(pluck(db, "SELECT name FROM world_place WHERE campaign_id = ? AND kind = 'area' AND known_to_party = 0", id)),
  }),
  unknown_county_name: (db, id) => ({
    values: strings(
      pluck(
        db,
        'SELECT c.name FROM world_county c JOIN world_place p ON p.id = c.seat_place_id WHERE c.campaign_id = ? AND p.known_to_party = 0',
        id,
      ),
    ),
  }),
  unknown_place_state: (db, id) => ({
    values: prose(
      pluck(
        db,
        `SELECT e.text FROM world_place_state s JOIN world_place p ON p.id = s.place_id
         JOIN world_event e ON e.id = s.cause_event_id AND e.place_id = s.place_id
         WHERE s.campaign_id = ? AND p.known_to_party = 0`,
        id,
      ),
    ),
    note: 'cause event text only; the state is an enum and the faith name is shared with known places',
  }),
  region_raw_json: (db, id) => ({
    values: strings(pluck(db, 'SELECT raw_json FROM world_region WHERE campaign_id = ?', id)),
    note: 'whole JSON value only',
  }),
  place_seed: (db, id) => ({
    values: strings(pluck(db, 'SELECT seed FROM world_place WHERE campaign_id = ? AND seed IS NOT NULL', id)),
  }),
  place_link: (db, id) => ({
    values: strings(pluck(db, 'SELECT link FROM world_place WHERE campaign_id = ? AND link IS NOT NULL', id)),
  }),
  checkpoint_snapshot: (db, id) => ({
    values: strings(pluck(db, 'SELECT snapshot_json FROM checkpoint WHERE campaign_id = ?', id)),
    note: 'whole JSON value only',
  }),
};

/** A writable in-memory copy of the run's database, so routes that cache as they read never touch the file. */
export function openCopy(file: string): Db {
  const source = new Database(file, { readonly: true, fileMustExist: true });
  const image = source.serialize();
  source.close();
  // An in-memory database cannot run in WAL mode, so the image is marked as a rollback-journal file.
  image[18] = 1;
  image[19] = 1;
  const db = new Database(image);
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** Every route path registered for GET under /api, as test/secret-fields.test.ts walks it. */
function apiGetRoutes(app: Express): string[] {
  const paths: string[] = [];
  for (const layer of app.router.stack) {
    const route = layer.route as unknown as { path: unknown; methods: Record<string, boolean> } | undefined;
    if (route && typeof route.path === 'string' && route.path.startsWith('/api/') && route.methods.get) paths.push(route.path);
  }
  return paths;
}

interface Ids {
  campaign: number;
  characters: number[];
  entities: number[];
  encounters: number[];
  combatants: number[];
  creatures: string[];
  spells: string[];
}

function runIds(db: Db, campaign: number): Ids {
  const numbers = (sql: string) => pluck(db, sql, campaign).map(Number);
  const spells = new Set<string>();
  for (const json of pluck(db, 'SELECT spells_json FROM character WHERE campaign_id = ?', campaign)) {
    const sheet = parseJson(json) as Record<string, unknown> | null;
    for (const key of ['cantrips', 'known', 'prepared']) {
      const list = sheet?.[key];
      if (Array.isArray(list)) for (const name of list) if (typeof name === 'string') spells.add(name);
    }
  }
  return {
    campaign,
    characters: numbers('SELECT id FROM character WHERE campaign_id = ? ORDER BY id'),
    entities: numbers('SELECT id FROM entity WHERE campaign_id = ? ORDER BY id'),
    encounters: numbers('SELECT id FROM encounter WHERE campaign_id = ? ORDER BY id'),
    combatants: numbers(
      "SELECT c.id FROM combatant c JOIN encounter e ON e.id = c.encounter_id WHERE e.campaign_id = ? AND e.status = 'active' ORDER BY c.id",
    ),
    creatures: strings(pluck(db, 'SELECT DISTINCT creature FROM creature_portrait WHERE campaign_id = ?', campaign)),
    spells: [...spells],
  };
}

/** The query strings the window sends to a route, beyond calling it bare. */
const QUERIES: Record<string, (ids: Ids) => string[]> = {
  '/api/campaigns': () => ['', '?include_deleted=1'],
  '/api/campaigns/:id/rolls': () => ['?limit=200'],
  '/api/campaigns/:id/journal': () => ['?limit=200'],
  '/api/campaigns/:id/rumours': () => ['?limit=100', '?scope=world', '?scope=region', '?scope=location'],
  '/api/campaigns/:id/combat-log': (ids) => ['?encounter=current', ...ids.encounters.map((e) => `?encounter=${e}`)],
  '/api/campaigns/:id/tactics': (ids) =>
    ids.combatants.flatMap((from) => ids.combatants.filter((to) => to !== from).map((to) => `?from=${from}&to=${to}`)),
  '/api/campaigns/:id/play-profile': (ids) => ['', ...ids.characters.map((c) => `?character_id=${c}`)],
  '/api/srd/options': (ids) => [`?campaign_id=${ids.campaign}`],
  '/api/srd/spells': (ids) => [`?campaign_id=${ids.campaign}&names=${encodeURIComponent(ids.spells.join(','))}`],
  '/api/portraits/creature/:name': (ids) => [`?campaign_id=${ids.campaign}`],
};

/** The URLs the window would call for one route, or null when it has a parameter this script cannot fill. */
function routeUrls(route: string, ids: Ids): string[] | null {
  let urls = [route];
  const expand = (param: string, values: Array<string | number>) => {
    urls = urls.flatMap((url) => values.map((value) => url.replace(param, encodeURIComponent(String(value)))));
  };
  if (route.startsWith('/api/campaigns/:id')) expand(':id', [ids.campaign]);
  if (route.startsWith('/api/characters/:id')) expand(':id', ids.characters);
  if (route.includes(':eid')) expand(':eid', ids.entities);
  if (route.includes(':name')) expand(':name', ids.creatures);
  if (route.replace(/^\/api\/(campaigns|characters)\/:id/, '').replace(/:(eid|name)\b/g, '').includes(':')) return null;
  const queries = QUERIES[route]?.(ids) ?? [''];
  return urls.flatMap((url) => queries.map((query) => url + query));
}

/** The payload's text plus every string inside it, lowercased, so an escaped string still matches. */
function haystack(text: string): string {
  const leaves: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') leaves.push(value);
    else if (value && typeof value === 'object') for (const inner of Object.values(value)) walk(inner);
  };
  walk(parseJson(text));
  return `${text}\n${leaves.join('\n')}`.toLowerCase();
}

const WORD = /[\p{L}\p{N}]/u;

/** A case-folded match that does not start or end inside a longer word. */
function containsWord(hay: string, needle: string): boolean {
  const open = WORD.test(needle[0]!);
  const close = WORD.test(needle.at(-1)!);
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const before = i > 0 && WORD.test(hay[i - 1]!);
    const after = WORD.test(hay[i + needle.length] ?? ' ');
    if (!(open && before) && !(close && after)) return true;
  }
  return false;
}

/** The WebSocket snapshot and every GET /api reply the player's window can ask for, served in-process. */
async function playerPayloads(
  db: Db,
  campaignId: number,
): Promise<{ payloads: Payload[]; routes: string[]; unfilled: string[] }> {
  const snapshot = JSON.stringify(campaignSnapshot(db, campaignId, { forPlayer: true }));
  const payloads: Payload[] = [{ surface: 'ws snapshot', route: 'ws snapshot', status: 200, hay: haystack(snapshot) }];
  const routes: string[] = [];
  const unfilled: string[] = [];
  const consoleLog = console.log;
  // The app logs every request; a scan makes hundreds.
  console.log = () => {};
  try {
    const { app, mcpHandler } = await createApp(db, randomBytes(16).toString('hex'));
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, HOST, resolve);
    });
    try {
      const base = `http://${HOST}:${(server.address() as AddressInfo).port}`;
      const ids = runIds(db, campaignId);
      for (const route of apiGetRoutes(app)) {
        const urls = routeUrls(route, ids);
        if (!urls) {
          unfilled.push(route);
          continue;
        }
        routes.push(route);
        for (const url of urls) {
          const res = await fetch(base + url);
          payloads.push({ surface: url, route, status: res.status, hay: haystack(await res.text()) });
        }
      }
    } finally {
      await mcpHandler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    console.log = consoleLog;
  }
  return { payloads, routes, unfilled };
}

const STOP = new Set(
  'about above after again against also because been before being below between both could does doing down during each from further have having here into just more most only other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your'.split(' '),
);

/** Content-word stems of a text, in order; a known name or a capitalised mid-sentence word becomes '' so a name never forms or joins a phrase. */
function stems(text: string, names: Set<string>): string[] {
  return (text.match(/\p{L}+/gu) ?? [])
    .map((w, i) => (i > 0 && /^\p{Lu}/u.test(w) ? w.toUpperCase() : w.toLowerCase()))
    .filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase()))
    .map((w) => (w === w.toUpperCase() || names.has(w) ? '' : w.replace(/(ing|ers|er|ed|es|s)$/, '')));
}

const bigrams = (tokens: string[]): string[] =>
  tokens.slice(1).flatMap((t, i) => (t && tokens[i] ? [`${tokens[i]} ${t}`] : []));

const sentences = (text: string): string[] => text.split(/[.;!?\r\n]+/).map((x) => x.trim()).filter(Boolean);

export interface Spoiler {
  source: string;
  visible: string;
  secret: string;
  phrase: string;
}

/** Player-visible text written since `since` that shares a two-word content phrase (names excluded) with a campaign secret. */
export function spoilerScan(db: Db, campaignId: number, since = ''): Spoiler[] {
  const names = new Set(
    pluck(
      db,
      `SELECT name FROM entity WHERE campaign_id = ? UNION SELECT name FROM character WHERE campaign_id = ?
       UNION SELECT name FROM world_faction WHERE campaign_id = ? UNION SELECT name FROM world_place WHERE campaign_id = ?`,
      campaignId,
      campaignId,
      campaignId,
      campaignId,
    ).flatMap((name) => String(name).toLowerCase().match(/\p{L}+/gu) ?? []),
  );
  const rows = (sql: string, ...params: string[]): string[] =>
    db.prepare(sql).raw().all(campaignId, ...params).flat().filter((v): v is string => typeof v === 'string');
  const secrets = new Map<string, string>();
  for (const text of [
    ...rows('SELECT secret_notes, ending FROM story_outline WHERE campaign_id = ?'),
    ...rows("SELECT hidden_notes FROM entity WHERE campaign_id = ? AND hidden_notes <> ''"),
    ...rows('SELECT text FROM clue WHERE campaign_id = ? AND hidden = 1'),
  ]) {
    for (const secret of sentences(text)) for (const pair of bigrams(stems(secret, names))) secrets.set(pair, secret);
  }
  const visible: Array<[source: string, sql: string]> = [
    ['thread', 'SELECT title, summary FROM plot_thread WHERE campaign_id = ? AND hidden = 0 AND updated_at >= ?'],
    ['canon fact', 'SELECT fact FROM canon_fact WHERE campaign_id = ? AND active = 1 AND created_at >= ?'],
    ['codex', 'SELECT summary, notes FROM entity WHERE campaign_id = ? AND updated_at >= ?'],
    ['heard rumour', 'SELECT text FROM rumour WHERE campaign_id = ? AND heard_at >= ?'],
    ['scene', 'SELECT title, summary FROM scene WHERE campaign_id = ? AND started_at >= ?'],
    ['recap', 'SELECT recap_text FROM session WHERE campaign_id = ? AND ended_at >= ?'],
    ['deed reason', 'SELECT reason FROM world_attitude WHERE campaign_id = ? AND ? IS NOT NULL'],
  ];
  const found = new Map<string, Spoiler>();
  for (const [source, sql] of visible) {
    for (const text of rows(sql, since)) {
      for (const snippet of sentences(text)) {
        const phrase = bigrams(stems(snippet, names)).find((pair) => secrets.has(pair));
        if (phrase) found.set(`${source}|${snippet}`, { source, visible: snippet, secret: secrets.get(phrase)!, phrase });
      }
    }
  }
  return [...found.values()];
}

/** Searches every player payload for every DM-only value the registry names, and renders the findings. */
async function leakScan(db: Db, campaignId: number, runStart: string): Promise<{ lines: string[]; leaks: number }> {
  const spoilers = showSecrets(db, campaignId) ? [] : spoilerScan(db, campaignId, runStart);
  const { payloads, routes, unfilled } = await playerPayloads(db, campaignId);
  const spoilersOn = showSecrets(db, campaignId);
  const rows: string[] = [];
  const found: string[] = [];
  for (const field of DM_ONLY_FIELDS) {
    const extract = EXTRACTORS[field.id];
    if (!extract) {
      rows.push(`| ${field.id} | ${cell(field.source)} | - | - | - | - | no extractor in this script: not checked |`);
      continue;
    }
    if (field.secret_while === SPOILER_GATED && spoilersOn) {
      rows.push(`| ${field.id} | ${cell(field.source)} | - | - | - | - | spoiler toggle on: the player may see it |`);
      continue;
    }
    const { values, note } = extract(db, campaignId);
    const unique = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
    const checked = unique.filter((v) => v.length >= MIN_LENGTH);
    let hits = 0;
    for (const value of checked) {
      const needle = value.toLowerCase();
      const where = payloads.filter((p) => containsWord(p.hay, needle)).map((p) => p.surface);
      if (where.length === 0) continue;
      hits++;
      const shown = where.slice(0, 3).map((s) => `\`${s}\``);
      if (where.length > 3) shown.push(`and ${where.length - 3} more`);
      found.push(`- **${field.id}**: "${cell(excerpt(value, 100))}" in ${shown.join(', ')}`);
    }
    rows.push(
      `| ${field.id} | ${cell(field.source)} | ${unique.length} | ${checked.length} | ${unique.length - checked.length} | ${hits} | ${cell(note ?? '')} |`,
    );
  }

  const statuses = new Map<string, Map<number, number>>(['ws snapshot', ...routes].map((r) => [r, new Map()]));
  for (const p of payloads) {
    const tally = statuses.get(p.route)!;
    tally.set(p.status, (tally.get(p.status) ?? 0) + 1);
  }
  const lines = [
    '## Leak scan',
    '',
    `Leaks found: **${found.length}**.`,
    '',
    `Scanned ${payloads.length} player-facing payloads: the WebSocket snapshot (\`campaignSnapshot\` with \`forPlayer\`) and every GET /api route the app registers, called in-process the way the window calls it. ` +
      `Each DM-only value the secret-field registry names is searched for verbatim (case-insensitive, not inside a longer word); values under ${MIN_LENGTH} characters are skipped as too likely to match by chance, and multi-line text is also searched line by line. ` +
      'A hit can also mean the DM narrated the secret without recording that the party learned it.',
    '',
    '| Registry field | Source | Values | Checked | Skipped (short) | Leaks | Note |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '### Leaks',
    '',
    ...(found.length ? found : ['None.']),
    '',
    `**Spoilers found: ${spoilers.length}.** Player-visible text the DM wrote during the run (threads, canon facts, codex, heard rumours, scenes, recaps, deed reasons) sharing a two-word content phrase, names excluded, with an outline secret, hidden codex note or hidden clue.`,
    '',
    ...spoilers.map(
      (x) => `- **spoiler** (${x.source}, "${x.phrase}"): "${cell(excerpt(x.visible, 100))}" echoes secret "${cell(excerpt(x.secret, 100))}"`,
    ),
    ...(spoilers.length ? [''] : []),
    '### Surfaces scanned',
    '',
    '| Route | Calls | Statuses |',
    '| --- | --- | --- |',
    ...[...statuses].map(([route, tally]) => {
      const calls = sum([...tally.values()]);
      const shown = calls ? [...tally].map(([s, n]) => `${s}: ${n}`).join(', ') : 'nothing to fill it with in this run';
      return `| \`${route}\` | ${calls} | ${shown} |`;
    }),
    '',
    `Not scanned: ${[
      ...unfilled.map((r) => `\`${r}\` (a parameter this script cannot fill)`),
      'live WebSocket events (they are not kept in the database)',
      'POST replies',
      'the rendered window and its screenshots',
    ].join('; ')}.`,
  ];
  return { lines, leaks: found.length };
}

/** Tool results with their duration and text, each given the op of the oldest open call of its tool. */
function parseResults(lines: string[]): Result[] {
  const open = new Map<string, Array<string | undefined>>();
  const out: Result[] = [];
  for (const line of lines) {
    const call = CALL_LINE.exec(line);
    if (call) {
      open.set(call[2]!, [...(open.get(call[2]!) ?? []), OP.exec(call[3]!)?.[1]]);
      continue;
    }
    const r = RESULT_LINE.exec(line);
    if (!r) continue;
    const [, ts, name, outcome, ms, bytes, text] = r;
    out.push({
      time: Date.parse(ts!),
      name: name!,
      op: open.get(name!)?.shift(),
      error: outcome === 'error',
      ms: Number(ms),
      bytes: Number(bytes),
      text: text!,
    });
  }
  return out;
}

const time = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);
const firstFinite = (...values: number[]): number => values.find(Number.isFinite) ?? NaN;

function readTurns(entries: Entry[]): Turn[] {
  const byTurn = new Map<number, Turn>();
  for (const entry of entries) {
    const turn = byTurn.get(entry.turn) ?? { turn: entry.turn, start: NaN, end: NaN };
    if (entry.role === 'player') turn.player ??= entry;
    else if (entry.role === 'dm') turn.dm ??= entry;
    byTurn.set(entry.turn, turn);
  }
  const turns = [...byTurn.values()].sort((a, b) => a.turn - b.turn);
  for (const t of turns) {
    t.start = firstFinite(time(t.dm?.started_at), time(t.player?.at));
    t.end = firstFinite(time(t.dm?.finished_at), time(t.dm?.at));
  }
  return turns;
}

const within = (at: number, t: Turn): boolean => at >= t.start && at <= t.end;
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const num = (value: number | null | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const seconds = (ms: number | null): string => (ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`);
const count = (n: number | null): string => (n === null ? '-' : String(Math.round(n)));
const money = (usd: number | null): string => (usd === null ? '-' : `$${usd.toFixed(4)}`);
const f1 = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ');
const excerpt = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
};
const bareTool = (name: string): string => name.split('__').at(-1)!;

/** A DM turn's wall time: the usage figure when there is one, else its start to finish. */
const wallMs = (t: Turn): number | null =>
  num(t.dm?.usage?.duration_ms) ?? num(time(t.dm?.finished_at) - time(t.dm?.started_at));

function modelSection(turns: Turn[]): string[] {
  const rows = turns.filter((t) => t.dm?.usage);
  const lines = ['## Model side per turn', ''];
  if (rows.length === 0) return [...lines, 'No usage recorded in transcript.jsonl.'];
  const cols: Array<[string, (t: Turn) => number | null, (n: number | null) => string]> = [
    ['Wall', wallMs, seconds],
    ['Model', (t) => num(t.dm!.usage!.duration_api_ms), seconds],
    ['Hops', (t) => num(t.dm!.usage!.num_turns), count],
    ['Input', (t) => num(t.dm!.usage!.input_tokens), count],
    ['Output', (t) => num(t.dm!.usage!.output_tokens), count],
    ['Cache read', (t) => num(t.dm!.usage!.cache_read_input_tokens), count],
    ['Cache write', (t) => num(t.dm!.usage!.cache_creation_input_tokens), count],
    ['Cost', (t) => num(t.dm!.usage!.total_cost_usd), money],
  ];
  const total = (get: (t: Turn) => number | null) => {
    const values = rows.map(get).filter((v): v is number => v !== null);
    return { total: values.length ? sum(values) : null, mean: values.length ? sum(values) / values.length : null };
  };
  lines.push(
    `| Turn | ${cols.map(([h]) => h).join(' | ')} |`,
    `| --- | ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map((t) => `| ${t.turn} | ${cols.map(([, get, show]) => show(get(t))).join(' | ')} |`),
    `| **Total** | ${cols.map(([, get, show]) => show(total(get).total)).join(' | ')} |`,
    `| **Mean** | ${cols.map(([, get, show]) => show(total(get).mean)).join(' | ')} |`,
    '',
  );
  const slowest = rows
    .filter((t) => wallMs(t) !== null)
    .sort((a, b) => wallMs(b)! - wallMs(a)!)
    .slice(0, 5)
    .map((t) => `turn ${t.turn} (${seconds(wallMs(t))})`);
  lines.push(`Slowest turns by wall time: ${slowest.join(', ') || 'none timed'}.`);
  const players = turns.map((t) => t.player?.usage).filter((u): u is Usage => !!u);
  if (players.length) {
    const add = (get: (u: Usage) => number | null | undefined) => sum(players.map((u) => num(get(u)) ?? 0));
    lines.push(
      '',
      `Player model (${players.length} turns with usage): ${money(add((u) => u.total_cost_usd))}, ` +
        `${count(add((u) => u.input_tokens))} input and ${count(add((u) => u.output_tokens))} output tokens, ` +
        `${seconds(add((u) => u.duration_api_ms))} model time.`,
    );
  }
  return lines;
}

function timeSplitSection(turns: Turn[], results: Result[]): string[] {
  const lines = ['## Time split per turn', ''];
  const timed = turns.filter((t) => t.dm && Number.isFinite(t.start) && Number.isFinite(t.end));
  if (timed.length === 0) return [...lines, 'No turn has both a start and a finish time in transcript.jsonl.'];
  lines.push(
    'Tool time sums the `tools/result` durations in server.log that fall inside the turn. Overhead is wall time minus model and tool time (client, transport, the rest); it goes negative when tool calls overlap.',
    '',
    '| Turn | Wall | Model | Tools | Overhead | Tool calls |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  let wallTotal = 0;
  let modelTotal = 0;
  let toolTotal = 0;
  for (const t of timed) {
    const inside = results.filter((r) => within(r.time, t));
    const tools = sum(inside.map((r) => r.ms));
    const wall = wallMs(t);
    const model = num(t.dm!.usage?.duration_api_ms);
    const overhead = wall !== null && model !== null ? wall - model - tools : null;
    if (wall !== null && model !== null) {
      wallTotal += wall;
      modelTotal += model;
      toolTotal += tools;
    }
    lines.push(`| ${t.turn} | ${seconds(wall)} | ${seconds(model)} | ${seconds(tools)} | ${seconds(overhead)} | ${inside.length} |`);
  }
  if (wallTotal > 0) {
    const pct = (n: number) => `${((n / wallTotal) * 100).toFixed(1)}%`;
    lines.push(
      '',
      `Over the turns with both figures: model ${pct(modelTotal)}, tools ${pct(toolTotal)}, overhead ${pct(wallTotal - modelTotal - toolTotal)} of ${seconds(wallTotal)} wall time.`,
    );
  }
  return lines;
}

async function toolUseSection(logLines: string[], calls: Call[], results: Result[], turns: Turn[]): Promise<string[]> {
  const lines = ['## Tool use', ''];
  if (calls.length === 0) return [...lines, 'No `tools/call` lines in server.log.'];
  const windows = turns.filter((t) => Number.isFinite(t.start) && Number.isFinite(t.end));
  const windowed = windows.length > 0;
  const perTurn = windowed ? windows.map((t) => calls.filter((c) => within(c.time, t))) : groupTurns(calls);
  const outside = windowed ? calls.filter((c) => !windows.some((t) => within(c.time, t))).length : 0;
  const s = turnStats(perTurn);
  const answered = calls.filter((c) => c.error !== undefined).length;
  const errors = calls.filter((c) => c.error).length;
  lines.push(
    `${calls.length} calls, ${answered} answered, ${errors} refused.`,
    '',
    `Calls per player turn (${windowed ? 'transcript turn windows' : 'idle gaps of 20 s; the transcript gives no usable turn times'}): ` +
      `${s.turns} turns, mean ${f1(s.mean)}, median ${f1(s.median)}, max ${s.max}.` +
      (outside ? ` ${outside} calls fell outside every turn.` : ''),
    '',
    '### Reply tokens (bytes/4), top 10',
    '',
    '| Tool | Calls | Mean | Max | Total |',
    '| --- | --- | --- | --- | --- |',
    ...replyTokens(calls).map((r) => `| ${r.name} | ${r.calls} | ${f1(r.mean)} | ${f1(r.max)} | ${f1(r.total)} |`),
    '',
    '### Refusals',
    '',
  );
  const refused = refusalRates(calls).filter((r) => r.errors > 0);
  if (refused.length === 0) lines.push('None.');
  else {
    lines.push(
      '| Tool / op | Calls | Errors | Rate |',
      '| --- | --- | --- | --- |',
      ...refused.map((r) => `| ${r.key} | ${r.calls} | ${r.errors} | ${(r.rate * 100).toFixed(1)}% |`),
      '',
      'Refusal messages:',
      '',
    );
    const messages = new Map<string, number>();
    for (const r of results.filter((x) => x.error)) {
      const key = `\`${r.op ? `${r.name}.${r.op}` : r.name}\`: ${excerpt(r.text, 300) || '(no text)'}`;
      messages.set(key, (messages.get(key) ?? 0) + 1);
    }
    for (const [message, n] of messages) lines.push(`- ${message}${n > 1 ? ` (${n}x)` : ''}`);
  }
  const redundant = [...redundantReads(calls)].sort((a, b) => b[1] - a[1]);
  lines.push('', '### Redundant reads (identical repeat, no change between)', '');
  if (redundant.length === 0) lines.push('None.');
  else lines.push('| Tool | Repeats |', '| --- | --- |', ...redundant.map(([name, n]) => `| ${name} | ${n} |`));
  lines.push('', '### Full tool stats', '', ...(await fullToolStats(logLines)));
  return lines;
}

/** Renders `fullStats` from scripts/toolstats.mts when that export exists. */
async function fullToolStats(logLines: string[]): Promise<string[]> {
  const toolstats = (await import('../toolstats.mjs')) as unknown as {
    fullStats?: (entries: unknown) => unknown;
    fullStatsMarkdown?: (stats: unknown) => string;
    parseLog: (lines: string[]) => unknown;
  };
  if (typeof toolstats.fullStats !== 'function') {
    return ['`fullStats` is not in scripts/toolstats.mts yet; the tables above use its base exports.'];
  }
  try {
    const out = await toolstats.fullStats(toolstats.parseLog(logLines));
    if (typeof toolstats.fullStatsMarkdown === 'function') return [toolstats.fullStatsMarkdown(out)];
    if (typeof out === 'string') return [out];
    const markdown = (out as { markdown?: unknown } | null)?.markdown;
    if (typeof markdown === 'string') return [markdown];
    return ['```json', JSON.stringify(out, null, 2), '```'];
  } catch (err) {
    return [`fullStats failed: ${(err as Error).message}`];
  }
}

/** Every tool the server lists, with the bytes its definition costs in each tools/list. */
async function listedTools(db: Db): Promise<Array<{ name: string; bytes: number }>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'playtest-report', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools: Array<{ name: string; bytes: number }> = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const tool of page.tools) tools.push({ name: tool.name, bytes: Buffer.byteLength(JSON.stringify(tool), 'utf8') });
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close();
  }
}

async function surfaceSection(db: Db, calls: Call[]): Promise<string[]> {
  const tools = (await listedTools(db)).sort((a, b) => b.bytes - a.bytes);
  const usage = new Map<string, { calls: number; errors: number; replies: number; replyBytes: number }>();
  for (const c of calls) {
    const u = usage.get(c.name) ?? { calls: 0, errors: 0, replies: 0, replyBytes: 0 };
    u.calls++;
    if (c.error) u.errors++;
    if (c.bytes !== undefined) {
      u.replies++;
      u.replyBytes += c.bytes;
    }
    usage.set(c.name, u);
  }
  const perCall = (name: string): number | null => {
    const u = usage.get(name);
    return u && u.replies ? u.replyBytes / u.replies : null;
  };
  const schemaBytes = sum(tools.map((t) => t.bytes));
  const unused = tools.filter((t) => !usage.has(t.name)).map((t) => t.name);
  const unlisted = [...usage.keys()].filter((name) => !tools.some((t) => t.name === name));
  const heaviest = [...usage.keys()]
    .filter((name) => perCall(name) !== null)
    .sort((a, b) => perCall(b)! - perCall(a)!)
    .slice(0, 5)
    .map((name) => `${name} (${Math.round(perCall(name)!)} B over ${usage.get(name)!.replies} replies)`);
  return [
    '## Surface cost vs use',
    '',
    `${tools.length} tools listed; their definitions weigh ${schemaBytes} bytes (~${Math.round(schemaBytes / 4)} tokens) in every tools/list.`,
    '',
    '| Tool | Schema bytes | ~Tokens | Calls | Errors | Reply bytes/call |',
    '| --- | --- | --- | --- | --- | --- |',
    ...tools.map((t) => {
      const u = usage.get(t.name);
      const bytes = perCall(t.name);
      return `| ${t.name} | ${t.bytes} | ${Math.round(t.bytes / 4)} | ${u?.calls ?? 0} | ${u?.errors ?? 0} | ${bytes === null ? '-' : Math.round(bytes)} |`;
    }),
    '',
    `Never used this run (${unused.length}): ${unused.join(', ') || 'none'}.`,
    '',
    `Heaviest replies by bytes per call: ${heaviest.join(', ') || 'none'}.`,
    ...(unlisted.length ? ['', `Called but not listed by this server: ${unlisted.join(', ')}.`] : []),
  ];
}

function digestSection(turns: Turn[], calls: Call[]): string[] {
  const lines = [
    '## Transcript digest',
    '',
    `Flags are a heuristic: the DM's text narrates a rolled number ("you take 7 damage", "rolls a 15") while none of ${DICE_TOOLS.join(', ')} ran in that turn.`,
  ];
  if (turns.length === 0) return [...lines, '', 'No transcript.jsonl entries.'];
  for (const t of turns) {
    const names = [
      ...(t.dm?.tool_calls ?? []).map((c) => bareTool(c.name)),
      ...(t.dm?.tool_calls?.length ? [] : calls.filter((c) => within(c.time, t)).map((c) => c.name)),
    ];
    const tally = new Map<string, number>();
    for (const name of names) tally.set(name, (tally.get(name) ?? 0) + 1);
    const tools = [...tally].map(([name, n]) => (n > 1 ? `${name} x${n}` : name)).join(', ');
    lines.push('', `### Turn ${t.turn}`, '');
    lines.push(`- Player: ${t.player ? excerpt(t.player.text, 500) : '(none)'}`);
    lines.push(`- DM: ${t.dm ? excerpt(t.dm.text, 200) : '(none)'}`);
    lines.push(`- Tools: ${tools || 'none'}`);
    const narrated = t.dm ? NARRATED_ROLL.exec(t.dm.text) : null;
    if (narrated && !names.some((name) => DICE_TOOLS.includes(name))) {
      lines.push(`- **Flag (heuristic):** narrates "${narrated[0]}" with no dice tool in this turn`);
    }
  }
  return lines;
}

function summarySection(meta: Record<string, unknown>, leaks: number): string[] {
  const show = (key: string, value: unknown): string => {
    if (key === 'secret') return '(redacted)';
    if (value !== null && typeof value === 'object') return `\`${JSON.stringify(value)}\``;
    return cell(String(value));
  };
  const lines = ['## Run summary', '', '| Field | Value |', '| --- | --- |'];
  for (const [key, value] of Object.entries(meta)) lines.push(`| ${key} | ${show(key, value)} |`);
  const span = time(meta.finished_at as string | undefined) - time(meta.started_at as string | undefined);
  if (Number.isFinite(span)) lines.push(`| duration | ${seconds(span)} |`);
  lines.push('', `Leaks found: **${leaks}** (see Leak scan).`);
  return lines;
}

/** The system each tool drives; a tool missing here counts under "other". */
const SYSTEMS: Array<[string, string[]]> = [
  [
    'combat',
    ['start_encounter', 'add_combatant', 'get_battle_state', 'find_position', 'move_token', 'attack', 'use_action', 'effect', 'advance_turn', 'undo_last_combat_action', 'end_encounter'],
  ],
  ['rolls/checks', ['roll', 'roll_table', 'inspiration']],
  ['hp/conditions', ['hp', 'condition']],
  ['rests', ['rest']],
  ['level-up', ['xp', 'level_up', 'propose_level_up_options', 'grant_feature']],
  ['spells', ['spells']],
  ['inventory/shop/gold', ['inventory']],
  ['companions/party', ['party']],
  ['codex/NPCs', ['entity', 'get_codex', 'generate_portrait']],
  ['canon facts', ['remember']],
  ['rumours', ['rumour']],
  ['quests/objectives', ['update_objectives', 'thread']],
  ['story/chapters', ['story', 'mark_story_filled']],
  ['world/factions/deeds', ['world']],
  ['region/travel/time', ['region', 'time']],
  ['checkpoint/sessions', ['checkpoint', 'load_campaign']],
  ['journal/play notes', ['log_event', 'read_journal', 'note_play']],
  ['campaign/character setup', ['create_campaign', 'create_character', 'list_character_options', 'language']],
  ['homebrew', ['propose', 'check_mechanics', 'revise_mechanics', 'library']],
  ['guides/reads', ['read_guide', 'srd_lookup', 'get_character_sheet']],
];

/** The coverage table: tool calls grouped by the system they drive, and the systems this run never touched. */
export function systemsSection(calls: Call[]): string[] {
  const known = new Set(SYSTEMS.flatMap(([, tools]) => tools));
  const groups: Array<[string, Call[]]> = [
    ...SYSTEMS.map(([system, tools]): [string, Call[]] => [system, calls.filter((c) => tools.includes(c.name))]),
    ['other', calls.filter((c) => !known.has(c.name))],
  ];
  const touched = groups.filter(([, group]) => group.length > 0);
  const never = SYSTEMS.map(([system]) => system).filter((system) => !touched.some(([t]) => t === system));
  const row = ([system, group]: [string, Call[]]): string => {
    const tally = new Map<string, number>();
    for (const key of group.map((c) => (c.op ? `${c.name}.${c.op}` : c.name))) tally.set(key, (tally.get(key) ?? 0) + 1);
    const tools = [...tally].sort((a, b) => b[1] - a[1]).map(([key, n]) => (n > 1 ? `${key} x${n}` : key));
    return `| ${system} | ${group.length} | ${group.filter((c) => c.error).length} | ${tools.join(', ')} |`;
  };
  return [
    '## Systems touched',
    '',
    'Tool calls in server.log, grouped by the system each tool drives.',
    '',
    '| System | Calls | Refused | Tools |',
    '| --- | --- | --- | --- |',
    ...touched.map(row),
    '',
    `Never touched: ${never.join(', ') || 'none'}.`,
  ];
}

/** The judge's verdict line from judge.md, or null when it has none. */
export function verdictOf(judge: string): string | null {
  return /^\*\*Verdict:\*\*\s*(.+)$/m.exec(judge)?.[1]?.trim() || null;
}

function judgeSection(runDir: string): string[] {
  const file = join(runDir, 'judge.md');
  if (!existsSync(file)) return [];
  const verdict = verdictOf(readFileSync(file, 'utf8'));
  return ['## Judge', '', `[judge.md](judge.md) (spoilers)${verdict ? `: ${verdict}` : ''}`];
}

function screenshotSection(runDir: string): string[] {
  const dir = join(runDir, 'screenshots');
  if (!existsSync(dir)) return [];
  const images = readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
    .sort();
  return [
    '## Screenshots',
    '',
    ...(images.length ? images.map((f) => `![${f}](screenshots/${encodeURIComponent(f)})`) : ['The folder is empty.']),
  ];
}

const readLines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []);

export async function writeReport(runDir: string): Promise<{ reportPath: string; leaks: number }> {
  const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as Record<string, unknown>;
  const campaignId = Number(meta.campaign_id);
  if (!Number.isInteger(campaignId)) throw new Error(`meta.json has no campaign_id: ${runDir}`);
  const logLines = readLines(join(runDir, 'server.log'));
  // A run that stopped mid-write can leave a torn last line, which is skipped rather than fatal.
  const entries = readLines(join(runDir, 'transcript.jsonl'))
    .map((line) => parseJson(line) as Entry | null)
    .filter((entry): entry is Entry => typeof entry?.turn === 'number');
  const calls = parseLog(logLines);
  const results = parseResults(logLines);
  const turns = readTurns(entries);

  const db = openCopy(join(runDir, 'game.sqlite'));
  try {
    // Rows older than the first turn are the scenario's seed, not the DM's writing.
    const runStart = entries.map((e) => e.started_at ?? e.at).filter((t): t is string => typeof t === 'string').sort()[0] ?? '';
    const scan = await leakScan(db, campaignId, runStart);
    const sections = [
      ['# Playtest report'],
      summarySection(meta, scan.leaks),
      judgeSection(runDir),
      systemsSection(calls),
      modelSection(turns),
      timeSplitSection(turns, results),
      await toolUseSection(logLines, calls, results, turns),
      await surfaceSection(db, calls),
      scan.lines,
      digestSection(turns, calls),
      screenshotSection(runDir),
    ].filter((section) => section.length > 0);
    const reportPath = join(runDir, 'report.md');
    writeFileSync(reportPath, `${sections.map((s) => s.join('\n')).join('\n\n')}\n`, 'utf8');
    return { reportPath, leaks: scan.leaks };
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith('report.mts')) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error('usage: node --import tsx scripts/playtest/report.mts <runDir>');
    process.exitCode = 2;
  } else {
    writeReport(runDir).then(
      ({ reportPath, leaks }) => console.log(`${reportPath}: ${leaks} leak(s)`),
      (err: unknown) => {
        console.error(err);
        process.exitCode = 1;
      },
    );
  }
}
