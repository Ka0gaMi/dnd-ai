// Judges a playtest run as a player would feel it: builds judge-bundle.md from the run folder (the database read-only) and
// has an isolated `claude -p` write judge.md. Usage: node --import tsx scripts/playtest/judge.mts <runDir> [--model opus] [--publish]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { nowState } from '../../src/core/calendar.js';
import { getSettings } from '../../src/core/settings.js';
import { getStoryOutline } from '../../src/core/story.js';
import type { Db } from '../../src/db/connection.js';
import { fullStats, parseLog, type Call } from '../toolstats.mjs';
import { publishRun, reportsRoot } from './publish.mjs';
import { openCopy, systemsSection, verdictOf, writeReport } from './report.mjs';
import { ISOLATION, MCP_PREFIX, parseStream, runClaude, type TranscriptEntry, type Usage } from './run.mjs';
import { SCENARIOS } from './scenarios.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
export const BUNDLE_FILE = 'judge-bundle.md';
export const JUDGE_FILE = 'judge.md';
const JUDGE_TIMEOUT_MS = 30 * 60_000;
/** Tool inputs and results are cut to this many characters; the briefing and saves keep more for the resume checks. */
const SHORT = 300;
const LONG = 1500;
const LONG_RESULTS = ['load_campaign', 'checkpoint'];
/** The Read tool cuts longer lines. */
const MAX_LINE = 1800;

export const SPOILER_WARNING =
  "> **Spoilers.** This judgement quotes the DM's secrets: the outline's secret notes and ending, hidden codex notes, rumour truth. Do not read it before playing this campaign.";

export const JUDGE_PROMPT = `You judge a recorded playtest of a solo D&D 5e game. An AI Dungeon Master (Claude, connected over MCP to a local game server that owns all state and every die) ran it; the player was a list of scripted lines or a Claude model playing a novice. Judge the run as a real player would feel it, and check it against the engine's record.

Everything is in the bundle file named in the user message. Read all of it with the Read tool in chunks of about 500 lines (its contents list gives section line numbers). Then look at screenshots it lists, the player's companion window after each turn: at least the first, the last, one from every fight and any turn where the state changed a lot. You can only read files; your final message is saved as judge.md.

How to judge:
- Judge the DM and the engine, not the player. Scripted lines are fixed in advance and may ignore what the DM just said; judge how the DM handles them. "Let's stop here for today..." and "Let's continue our campaign..." are the harness's session breaks: after one, the DM is a fresh session that knows only what the server returns.
- The state dump is the database at the end of the run and holds DM secrets (outline secret notes and ending, hidden codex notes, rumour truth, secret factions, unheard portents). Use them to check consistency and mystery fairness.
- Some systems are only partly built: NPCs remembering the player beyond the codex notes the DM writes and the attitudes world {op: deed} records, and the player's influence and reputation. When the run needed one and the engine offers nothing, report it as a gap tagged not-built-yet; do not mark the DM down for it.
- Every claim needs evidence: a turn number and a short quote, or a tool result or state row. If the record cannot settle a question, say so rather than guess.
- Score each area 1 to 5 (5: a real player would notice nothing wrong), or "n/a" when the run never exercised it; the Systems touched table shows what ran.

Areas:
1. Narration: atmosphere and sensory detail, pacing, variety (no repeated openings or stock phrases), length a player will read, second person, never playing or deciding for the player's character, each turn ending on a clear "what do you do".
2. Story: hooks and stakes, agency and real choices, consequences that stick, mystery fairness (clues findable, not spoiled, solvable from what the player learns), coherence across session breaks.
3. NPCs: distinct voices, motives, consistent attitudes, memory of the player, reactions to the player's deeds, influence and reputation (unbuilt systems are gaps).
4. World and canon consistency: facts, names, places, the dead stay dead, factions; narration against canon facts and the codex.
5. Rumours: true ones lead somewhere, false ones stay false, the DM keeps their truth straight.
6. Quests and clues: they make sense, steps are achievable, rewards and closure land, objectives track what happened.
7. Rules honesty: narrated numbers match tool results, no invented or re-rolled dice, DCs and ACs never spoken while dc_disclosure is hidden, action economy, fair rulings.
8. Bookkeeping: HP, items, gold, spell slots, XP and level in the narration against tool results and the final state.
9. Combat: fair difficulty, sensible tactics, companions in character, enemies behaving like their kind.
10. Time and place: calendar, weather, travel time, consistent locations.
11. Saves and resume: checkpoints at scene ends, accurate recaps, the resumed session picking up correctly.
12. Table craft: recaps, clarity for a novice, rules explained when they first matter, staying in the fiction (no "server lag" or tool talk), lines and veils respected.
13. Companion window: screenshots match the state and the narration; nothing DM-only shown (the bundle carries the report's leak scan).
14. Efficiency: tool calls per turn, refusals and retries, latency hot spots and the waiting they cost the player.

Write judge.md in Markdown. Its first line, with nothing before it, is:
**Verdict:** <one sentence, free of spoilers: would this be fun and smooth for a real player, and what breaks it first>
Then these sections:
## Scores
A table: Area | Score | Why (one line).
## Findings
One subsection per area: what worked and what did not, each point with turn numbers and short quotes.
## Fix list
A table ranked by how much it hurts a real player: # | Severity (blocker, major, minor, polish) | Area | Tag (engine, prompt-or-guide, data, harness, not-built-yet) | Fix | Evidence.
## Verdict
One paragraph: would this be fun and smooth for a real player, and what breaks it first.

Your final message is the whole of judge.md and nothing else.`;

/** The judge's claude arguments: the DM's isolation flags, the Read tool only, Opus unless told otherwise. */
export function judgeArgs(o: { prompt: string; model: string }): string[] {
  return [
    ...['-p', o.prompt, '--model', o.model, '--system-prompt', JUDGE_PROMPT],
    ...['--tools', 'Read', '--allowedTools', 'Read', ...ISOLATION],
    ...['--output-format', 'stream-json', '--verbose'],
  ];
}

const parseJson = (text: unknown): unknown => {
  try {
    return typeof text === 'string' ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};
const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
};
const readLines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []);
const secs = (ms: unknown): string => (typeof ms === 'number' ? `${(ms / 1000).toFixed(1)} s` : '-');
const usd = (n: unknown): string => (typeof n === 'number' ? `$${n.toFixed(3)}` : '-');

interface ToolLine {
  name: string;
  input: string;
  ok: boolean | null;
  result: string;
}

/** The DM's tool calls in one stream-json file, each paired with its result. */
export function streamToolLines(raw: string): ToolLine[] {
  const calls = new Map<string, ToolLine>();
  for (const line of raw.split(/\r?\n/)) {
    const event = parseJson(line) as Record<string, any> | null;
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (event!.type === 'assistant' && block?.type === 'tool_use' && !calls.has(block.id)) {
        const name = String(block.name);
        calls.set(block.id, {
          name: name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name,
          input: JSON.stringify(block.input ?? {}),
          ok: null,
          result: '',
        });
      }
      const call = event!.type === 'user' && block?.type === 'tool_result' ? calls.get(block.tool_use_id) : undefined;
      if (call) {
        call.ok = block.is_error !== true;
        call.result = Array.isArray(block.content)
          ? block.content.map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : '')).join(' ')
          : String(block.content ?? '');
      }
    }
  }
  return [...calls.values()];
}

function toolLine(t: ToolLine): string {
  const outcome = t.ok === null ? 'no result' : t.ok ? 'ok' : 'REFUSED';
  return clip(`- ${t.name} ${clip(t.input, SHORT)} -> ${outcome}: ${clip(t.result, LONG_RESULTS.includes(t.name) ? LONG : SHORT)}`, MAX_LINE);
}

/** One turn's DM tool calls: from its stream when kept, else from server.log inside the turn, else names only. */
function dmTools(runDir: string, turn: number, dm: TranscriptEntry, calls: Call[]): ToolLine[] {
  const stream = join(runDir, 'streams', `dm-${String(turn).padStart(2, '0')}.jsonl`);
  if (existsSync(stream)) return streamToolLines(readFileSync(stream, 'utf8'));
  const from = Date.parse(dm.started_at ?? '');
  const to = Date.parse(dm.finished_at ?? dm.at);
  if (Number.isFinite(from) && Number.isFinite(to)) {
    return calls
      .filter((c) => c.time >= from && c.time <= to)
      .map((c) => ({ name: c.name, input: c.args, ok: c.error === undefined ? null : !c.error, result: c.text ?? '' }));
  }
  return (dm.tool_calls ?? []).map((c) => ({ name: c.name, input: JSON.stringify(c.input ?? {}), ok: null, result: '' }));
}

function transcriptSection(runDir: string, entries: TranscriptEntry[], calls: Call[]): string[] {
  const turns = new Map<number, Partial<Record<TranscriptEntry['role'], TranscriptEntry>>>();
  for (const e of entries) turns.set(e.turn, { [e.role]: e, ...turns.get(e.turn) });
  const lines = ['## Transcript', ''];
  for (const [turn, t] of [...turns].sort((a, b) => a[0] - b[0])) {
    if (t.session) lines.push(`---- Session break: ${t.session.text} ----`, '');
    const u = t.dm?.usage;
    const wall = u?.duration_ms ?? Date.parse(t.dm?.finished_at ?? '') - Date.parse(t.dm?.started_at ?? '');
    const head = t.dm ? ` (DM ${secs(Number.isFinite(wall) ? wall : null)}, ${u?.num_turns ?? '-'} model hops, ${usd(u?.total_cost_usd)})` : '';
    lines.push(`### Turn ${turn}${head}`, '', `**Player:** ${t.player?.text.trim() ?? '(none)'}`, '');
    if (!t.dm) continue;
    lines.push('**DM:**', '', t.dm.text.trim() || '(nothing)', '');
    const tools = dmTools(runDir, turn, t.dm, calls);
    lines.push(`DM tool calls (${tools.length}):`, ...tools.map(toolLine), '');
  }
  return lines;
}

function runSection(runDir: string, meta: Record<string, any>): string[] {
  const scenario = SCENARIOS[meta.scenario];
  const t = meta.totals ?? {};
  const breaks = (meta.session_breaks ?? []) as Array<{ turn: number }>;
  return [
    '## Run',
    '',
    `- Folder: ${runDir}`,
    `- Scenario: ${meta.scenario}${scenario ? `; the player's goal: ${scenario.goal}` : ''}`,
    ...(scenario?.playerBrief ? [`- The player's aims over the whole game: ${scenario.playerBrief}`] : []),
    `- Player: ${meta.player === 'claude' ? `Claude (${meta.player_model}), a novice persona with no tools` : 'scripted lines, fixed in advance'}`,
    `- DM model: ${meta.dm_model}; code: ${meta.git_branch ?? '?'} @ ${meta.git_commit ?? '?'}`,
    `- Turns played: ${meta.turns_played}, from ${meta.started_at} to ${meta.finished_at}`,
    `- DM totals: wall ${secs(t.wall_ms)}, model ${secs(t.duration_api_ms)}, ${t.num_turns ?? '-'} model hops, ${usd(t.total_cost_usd)} list price`,
    `- Session breaks at turns: ${breaks.map((b) => b.turn).join(', ') || 'none'}`,
    `- Run error: ${meta.error ?? 'none'}; stalled: ${meta.stalled ? JSON.stringify(meta.stalled) : 'no'}`,
    `- Window: ${meta.window_error ?? 'healthy'}; rolls it missed: ${(meta.window_missed_rolls ?? []).join(', ') || 'none'}`,
  ];
}

function statsSection(calls: Call[]): string[] {
  const s = fullStats(calls);
  const t = s.time.perTurnMs;
  return [
    '## Tool statistics (server.log)',
    '',
    `${s.calls} calls, ${calls.filter((c) => c.error).length} refused. Tool time per burst of calls: mean ${Math.round(t.mean)} ms, max ${t.max} ms.`,
    '',
    'Per tool: calls, refused, p50 / max ms',
    ...s.perTool.map((k) => `- ${k.key}: ${k.calls}, ${k.errors}, ${k.latencyMs.p50} / ${k.latencyMs.max}`),
    '',
    'Refusal texts:',
    ...(s.refuseRetry.errorTexts.length ? s.refuseRetry.errorTexts.map((e) => `- (${e.count}x) ${e.text}`) : ['- none']),
    '',
    'Refused then retried (same tool and op within 3 calls):',
    ...(s.refuseRetry.perKey.length
      ? s.refuseRetry.perKey.map((r) => `- ${r.key}: ${r.errors} refused, ${r.retried} retried, ${r.retrySucceeded} then succeeded`)
      : ['- none']),
    '',
    'Slowest calls:',
    ...s.time.slowest.map((c) => `- ${c.tool}${c.op ? `.${c.op}` : ''}: ${c.ms} ms`),
  ];
}

/** The leak scan's verdict and findings from report.md, when the report was written. */
function leakSection(runDir: string): string[] {
  const lines = readLines(join(runDir, 'report.md'));
  const count = lines.find((l) => l.startsWith('Leaks found:'));
  if (!count) return ['## Leak scan', '', 'No report.md leak scan for this run.'];
  const start = lines.indexOf('### Leaks');
  const end = lines.findIndex((l, i) => i > start && l.startsWith('#'));
  return ['## Leak scan (from report.md)', '', count, ...(start >= 0 ? lines.slice(start + 1, end > start ? end : undefined) : [])];
}

function screenshotSection(runDir: string): string[] {
  const dir = join(runDir, 'screenshots');
  const images = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort() : [];
  return ['## Screenshots', '', ...(images.length ? images.map((f) => `- ${join(dir, f)}`) : ['None were taken.'])];
}

/** One row as a JSON line, with its *_json columns parsed. */
function row(r: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(r)) {
    out[key.replace(/_json$/, '')] = key.endsWith('_json') && typeof value === 'string' ? (parseJson(value) ?? value) : value;
  }
  return `- ${clip(JSON.stringify(out), MAX_LINE)}`;
}

const table = (db: Db, title: string, sql: string, ...params: unknown[]): string[] => {
  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return [`### ${title} (${rows.length})`, '', ...(rows.length ? rows.map(row) : ['(none)']), ''];
};

type Item = { name?: unknown; qty?: unknown; equipped?: unknown; magic?: { identified?: unknown }; container?: { contents?: unknown } };

/** Inventory as short names: quantity, equipped, unidentified, and container contents. */
function items(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return (list as Item[]).map((item) => {
    const qty = Number(item?.qty);
    const name = [
      String(item?.name),
      qty > 1 ? `x${qty}` : '',
      item?.equipped ? '(equipped)' : '',
      item?.magic?.identified === false ? '(unidentified)' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const inside = items(item?.container?.contents);
    return inside.length ? `${name} [${inside.join(', ')}]` : name;
  });
}

function combatLog(db: Db, campaignId: number): string[] {
  const lines = ['### Combat log', ''];
  const encounters = db
    .prepare('SELECT id, status, round, outcome, started_at, ended_at FROM encounter WHERE campaign_id = ? ORDER BY id')
    .all(campaignId) as Array<Record<string, unknown>>;
  if (!encounters.length) return [...lines, '(no encounters)', ''];
  for (const e of encounters) {
    lines.push(`Encounter ${e.id}: ${row(e).slice(2)}`);
    for (const c of db
      .prepare('SELECT name, team, kind, hp_current, hp_max, ac, alive FROM combatant WHERE encounter_id = ? ORDER BY id')
      .all(e.id) as Array<Record<string, unknown>>) {
      lines.push(`- combatant ${row(c).slice(2)}`);
    }
    const log = db
      .prepare("SELECT round, kind, text FROM combat_log WHERE encounter_id = ? AND kind NOT IN ('turn_start', 'turn_end') ORDER BY id")
      .all(e.id) as Array<{ round: number; kind: string; text: string }>;
    lines.push(...log.map((l) => `- r${l.round} ${l.kind}: ${clip(l.text ?? '', SHORT)}`), '');
  }
  return lines;
}

/** The run's database at the end of the run, DM secrets included. */
function stateSection(db: Db, id: number): string[] {
  const outline = getStoryOutline(db, id);
  const characters = (db
    .prepare(
      `SELECT id, name, role, is_pc, status, species, class, subclass, level, xp, hp_current, hp_max, temp_hp, ac, gold, coins_json,
              spell_slots_json, spells_json, conditions_json, exhaustion, inspiration, hit_dice_json, concentration_json, inventory_json
         FROM character WHERE campaign_id = ? ORDER BY id`,
    )
    .all(id) as Array<Record<string, unknown>>).flatMap((c) => {
    const { inventory_json, ...rest } = c;
    return [row(rest), `  inventory: ${clip(items(parseJson(inventory_json)).join('; ') || '(empty)', MAX_LINE)}`];
  });
  return [
    '## State dump (game.sqlite at the end of the run; DM secrets included)',
    '',
    ...table(db, 'Campaign', 'SELECT id, name, story_shape, premise, created_at, current_session_id, current_scene_id FROM campaign WHERE id = ?', id),
    '### Settings', '', row(getSettings(db, id) as unknown as Record<string, unknown>), '',
    '### Now', '', row(nowState(db, id) as unknown as Record<string, unknown>), '',
    '### Story outline', '',
    `- Premise: ${outline.premise || '(none)'}`,
    `- Ending: ${outline.ending || '(none)'}`,
    '- Secret notes:',
    ...(outline.secret_notes ? outline.secret_notes.split(/\r?\n/).map((l) => `  ${l}`) : ['  (none)']),
    '',
    ...table(db, 'Acts', 'SELECT id, number, title, goal, status FROM act WHERE campaign_id = ? ORDER BY number', id),
    ...table(db, 'Chapters', 'SELECT id, act_id, number, title, goal, summary, status, started_at, closed_at FROM chapter WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Sessions and their recaps', 'SELECT id, number, started_at, ended_at, recap_text FROM session WHERE campaign_id = ? ORDER BY number', id),
    ...table(db, 'Scenes', 'SELECT id, session_id, chapter_id, title, location_name, summary, started_at, ended_at FROM scene WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Checkpoints', 'SELECT id, scene_id, created_at, length(snapshot_json) AS snapshot_bytes FROM checkpoint WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Quests', `SELECT q.id, q.title, q.kind, q.status, q.summary,
        (SELECT json_group_array(json_object('text', s.text, 'done', s.done)) FROM (SELECT text, done FROM quest_step WHERE quest_id = q.id ORDER BY sort, id) s) AS steps_json
        FROM quest q WHERE q.campaign_id = ? ORDER BY q.id`, id),
    ...table(db, 'Plot threads', 'SELECT id, title, status, hidden, summary FROM plot_thread WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Clues', 'SELECT id, thread_id, text, hidden, status, found_at_scene_id FROM clue WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Canon facts', 'SELECT id, subject, fact, active, superseded_by, chapter_id FROM canon_fact WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Glossary terms', 'SELECT term, definition FROM glossary_entry WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Rumours', 'SELECT id, scope, truth, text, source_kind, thread_id, heard_at, resolved FROM rumour WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Codex entities', 'SELECT id, kind, name, status, summary, notes, hidden_notes, voice_json, character_id FROM entity WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Relations', `SELECT r.type, a.name AS from_name, b.name AS to_name, r.notes, r.active
        FROM relationship r JOIN entity a ON a.id = r.from_id JOIN entity b ON b.id = r.to_id WHERE r.campaign_id = ? ORDER BY r.id`, id),
    '### Characters', '', ...(characters.length ? characters : ['(none)']), '',
    ...combatLog(db, id),
    ...table(db, 'Rolls', 'SELECT id, purpose, expr, total, dc, outcome, overridden, ts FROM roll WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Player roll cards', 'SELECT id, purpose, expr, dc, roll_type, source, created_at, resolved_at FROM pending_roll WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Realms', 'SELECT id, name, kind, government, ruler_title, faith, off_map FROM world_realm WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Factions', 'SELECT id, name, type, secrecy, resources, influence, realm_id, place_id, ended_day, capacities_json FROM world_faction WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Agendas', `SELECT a.id, f.name AS faction, a.template, a.target_kind, a.target_name, a.clock_filled, a.clock_size, a.status,
        a.known_to_party, a.portents_json, a.started_day, a.resolved_day
        FROM world_agenda a LEFT JOIN world_faction f ON f.id = a.faction_id WHERE a.campaign_id = ? ORDER BY a.id`, id),
    ...table(db, 'Attitudes and deeds', `SELECT a.subject_kind, COALESCE(f.name, e.name) AS subject, a.value, a.reason, a.day, a.fade_days, a.permanent, a.rival_of
        FROM world_attitude a LEFT JOIN world_faction f ON a.subject_kind = 'faction' AND f.id = a.subject_id
        LEFT JOIN entity e ON a.subject_kind = 'entity' AND e.id = a.subject_id WHERE a.campaign_id = ? ORDER BY a.id`, id),
    ...table(db, 'World events', 'SELECT day, kind, severity, visibility, text FROM world_event WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'News packets', `SELECT p.id, p.truth, p.text,
        (SELECT count(*) FROM world_packet_arrival x WHERE x.packet_id = p.id AND x.heard = 1) AS heard_at_places
        FROM world_packet p WHERE p.campaign_id = ? ORDER BY p.id`, id),
    ...table(db, 'Places', 'SELECT id, kind, name, info, known_to_party FROM world_place WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Faiths', 'SELECT name, aspect, fervor FROM world_faith WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Journal', 'SELECT chapter_id, text, created_at FROM journal_entry WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Play notes', 'SELECT character_id, tags_json, text FROM play_note WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Homebrew', 'SELECT kind, name, scope, power_label FROM homebrew WHERE campaign_id = ? ORDER BY id', id),
    ...table(db, 'Pending decisions', 'SELECT kind, created_at, resolved_at FROM pending_decision WHERE campaign_id = ? ORDER BY id', id),
    // Fight events repeat the combat log above.
    ...table(db, 'Events', "SELECT id, session_id, scene_id, kind, substr(text, 1, 300) AS text, reverted FROM event WHERE campaign_id = ? AND kind <> 'combat' ORDER BY id", id),
  ];
}

/** The judge's input as Markdown: run facts, tool statistics, the transcript with each turn's tool calls, and the state dump. */
export function buildBundle(runDir: string): string {
  const meta = JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as Record<string, any>;
  const campaignId = Number(meta.campaign_id);
  if (!Number.isInteger(campaignId)) throw new Error(`meta.json has no campaign_id: ${runDir}`);
  const calls = parseLog(readLines(join(runDir, 'server.log')));
  const entries = readLines(join(runDir, 'transcript.jsonl'))
    .map((line) => parseJson(line) as TranscriptEntry | null)
    .filter((e): e is TranscriptEntry => typeof e?.turn === 'number');
  const instructions = join(REPO, 'docs', 'dm-instructions.md');
  const db = openCopy(join(runDir, 'game.sqlite'));
  let sections: string[][];
  try {
    sections = [
      runSection(runDir, meta),
      systemsSection(calls),
      statsSection(calls),
      leakSection(runDir),
      screenshotSection(runDir),
      transcriptSection(runDir, entries, calls),
      stateSection(db, campaignId),
      [
        "## The DM's instructions (docs/dm-instructions.md in the judging checkout; an older run may have had another copy)",
        '',
        ...readLines(instructions),
      ],
    ];
  } finally {
    db.close();
  }
  const head = ['# Judge bundle', '', 'DM-only: this file holds every secret of the run. Contents (line numbers):', ''];
  const blocks = sections.map((s) => s.join('\n'));
  let at = head.length + blocks.length + 2;
  const contents = blocks.map((block, i) => {
    const line = `- line ${at}: ${sections[i]![0]!.replace(/^#+\s*/, '')}`;
    at += block.split('\n').length + 1;
    return line;
  });
  return [...head, ...contents, '', blocks.join('\n\n')].join('\n');
}

export interface JudgeOptions {
  model?: string;
  timeoutMs?: number;
  /** Runs the claude child; tests pass a fake so no model is called. */
  runner?: typeof runClaude;
}

/** Writes judge-bundle.md and has the judge write judge.md, prefixed with a spoiler warning. */
export async function judgeRun(runDir: string, opts: JudgeOptions = {}): Promise<{ judgePath: string; verdict: string | null; usage: Usage }> {
  const model = opts.model ?? 'opus';
  const timeoutMs = opts.timeoutMs ?? JUDGE_TIMEOUT_MS;
  const bundle = buildBundle(runDir);
  const bundlePath = join(runDir, BUNDLE_FILE);
  writeFileSync(bundlePath, bundle);
  mkdirSync(join(runDir, 'streams'), { recursive: true });
  const prompt = `Judge the playtest run in ${runDir}. Its bundle is ${bundlePath} (${bundle.split('\n').length} lines); read all of it, then the screenshots it lists.`;
  const run = await (opts.runner ?? runClaude)(judgeArgs({ prompt, model }), runDir, join(runDir, 'streams', 'judge.jsonl'), timeoutMs);
  if (run.stalled) throw new Error(`the judge ran past ${Math.round(timeoutMs / 60_000)} min and was stopped`);
  const parsed = parseStream(run.raw);
  if (parsed.isError || !parsed.text.trim()) throw new Error(`judge claude failed (exit ${run.code}): ${run.stderr.slice(-500) || parsed.text}`);
  const secret = (JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as { secret?: unknown }).secret;
  // The run folder's mcp.json holds the MCP secret, so it is struck in case the judge opened it.
  const text = typeof secret === 'string' && secret ? parsed.text.trim().split(secret).join('<secret>') : parsed.text.trim();
  const u = parsed.usage;
  const stamp = `_Judged by ${parsed.init?.model ?? model} on ${new Date().toISOString().slice(0, 10)}: ${secs(u.duration_ms)}, ${usd(u.total_cost_usd)} list price._`;
  const judgePath = join(runDir, JUDGE_FILE);
  writeFileSync(judgePath, `${SPOILER_WARNING}\n\n${stamp}\n\n${text}\n`);
  return { judgePath, verdict: verdictOf(text), usage: u };
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { model: { type: 'string', default: 'opus' }, publish: { type: 'boolean', default: false } },
  });
  if (positionals.length !== 1) {
    console.error('usage: node --import tsx scripts/playtest/judge.mts <runDir> [--model opus] [--publish]');
    return 2;
  }
  const runDir = resolve(positionals[0]!);
  console.log(`Judging ${runDir} with ${values.model}...`);
  const { judgePath, verdict, usage } = await judgeRun(runDir, { model: values.model });
  console.log(`Judge: ${judgePath} (${secs(usage.duration_ms)}, ${usd(usage.total_cost_usd)})${verdict ? `\nVerdict: ${verdict}` : ''}`);
  // Written again so the report points at the verdict.
  console.log(`Report: ${(await writeReport(runDir)).reportPath}`);
  if (values.publish) console.log(`Published: ${await publishRun(runDir, reportsRoot())}`);
  return 0;
}

if (process.argv[1]?.endsWith('judge.mts')) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (err: Error) => {
      console.error(err.message);
      process.exitCode = 1;
    },
  );
}
