// The secret-field registry checked end to end: every DM-only field carries a planted marker that no
// player GET route nor the player's snapshot may show, and no DM reply carries a player-only setting.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Express } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { DmOnlyFieldId, SecretField } from '../src/core/secret-fields.js';
import type { Db } from '../src/db/connection.js';

interface RealmCell {
  town?: { name: string };
  danger?: { name: string; link: string; seed: number };
}

interface Realm {
  features: Array<{ name: string; hexes: string[] }>;
  hexes: Record<string, RealmCell>;
  [key: string]: unknown;
}

const medium = JSON.parse(readFileSync(new URL('./fixtures/realm-medium.json', import.meta.url), 'utf8')) as Realm;
const cityMap = JSON.parse(readFileSync(new URL('./fixtures/map-city-redham.json', import.meta.url), 'utf8')) as unknown;

/** A marker no fixture or SRD text holds; the closing "q" keeps one marker from being part of another. */
const mark = (tag: string): string => `zqx${tag}q`;
/** The same marker as a capitalised word, for names. */
const markName = (tag: string): string => `Zqx${tag}q`;

/** Numeric secrets carry numbers no reply would hold by chance. */
const RESOURCES_MARKER = 7319046285;
const PLACE_SEED_MARKER = 9182736450;

/** What one DM-only field planted: text that must never reach the player, and keys that must never sit beside a carrier. */
interface Plant {
  markers: string[];
  keyed?: { carrier: string; keys: string[] };
}

interface Call {
  url: string;
  /** Statuses this call may answer with; 200 unless a miss is the expected answer. */
  ok?: number[];
}

interface Fetched {
  url: string;
  status: number;
  text: string;
  json: unknown;
}

interface World {
  campaignId: number;
  pcId: number;
  companionId: number;
  entityIds: number[];
  pcCombatant: number;
  foeCombatant: number;
  secretFactionId: number;
  plants: Record<DmOnlyFieldId, Plant>;
}

/** Every GET /api route the server registers and how the player's window would call it. */
const CALLS: Record<string, (w: World) => Call[]> = {
  '/api/campaigns': () => [{ url: '/api/campaigns' }, { url: '/api/campaigns?include_deleted=1' }],
  '/api/campaigns/:id/glossary': (w) => [{ url: `/api/campaigns/${w.campaignId}/glossary` }],
  '/api/campaigns/:id/rolls': (w) => [{ url: `/api/campaigns/${w.campaignId}/rolls?limit=200` }],
  '/api/campaigns/:id/combat-log': (w) => [{ url: `/api/campaigns/${w.campaignId}/combat-log?encounter=current` }],
  '/api/campaigns/:id/world': (w) => [{ url: `/api/campaigns/${w.campaignId}/world` }],
  '/api/campaigns/:id/entities/:eid/timeline': (w) =>
    w.entityIds.map((eid) => ({ url: `/api/campaigns/${w.campaignId}/entities/${eid}/timeline` })),
  '/api/presets': () => [{ url: '/api/presets' }],
  '/api/srd/options': (w) => [
    { url: `/api/srd/options?campaign_id=${w.campaignId}` },
    { url: `/api/srd/options?campaign_id=${w.campaignId}&class=Fighter&species=Dwarf&background=Soldier` },
  ],
  '/api/campaigns/:id/tactics': (w) => [
    { url: `/api/campaigns/${w.campaignId}/tactics?from=${w.pcCombatant}&to=${w.foeCombatant}` },
  ],
  '/api/campaigns/:id/story': (w) => [{ url: `/api/campaigns/${w.campaignId}/story` }],
  '/api/campaigns/:id/rumours': (w) => [
    { url: `/api/campaigns/${w.campaignId}/rumours?limit=100` },
    ...['world', 'region', 'location'].map((scope) => ({ url: `/api/campaigns/${w.campaignId}/rumours?scope=${scope}` })),
  ],
  '/api/campaigns/:id/entities/:eid/town-map': (w) =>
    w.entityIds.map((eid) => ({ url: `/api/campaigns/${w.campaignId}/entities/${eid}/town-map`, ok: [200, 404] })),
  '/api/campaigns/:id/codex': (w) => [
    { url: `/api/campaigns/${w.campaignId}/codex` },
    { url: `/api/campaigns/${w.campaignId}/codex?kind=faction` },
    // A search for the marker prefix finds any codex row a secret was copied into.
    { url: `/api/campaigns/${w.campaignId}/codex?q=zqx` },
  ],
  '/api/campaigns/:id/entities/:eid': (w) =>
    w.entityIds.map((eid) => ({ url: `/api/campaigns/${w.campaignId}/entities/${eid}` })),
  '/api/campaigns/:id/entities/:eid/tree': (w) =>
    w.entityIds.map((eid) => ({ url: `/api/campaigns/${w.campaignId}/entities/${eid}/tree` })),
  '/api/campaigns/:id/journal': (w) => [{ url: `/api/campaigns/${w.campaignId}/journal?limit=200` }],
  '/api/characters/:id/sheet': (w) => [
    { url: `/api/characters/${w.pcId}/sheet` },
    { url: `/api/characters/${w.companionId}/sheet` },
  ],
  '/api/characters/:id/level-up': (w) => [{ url: `/api/characters/${w.pcId}/level-up` }],
  '/api/campaigns/:id/library': (w) => [{ url: `/api/campaigns/${w.campaignId}/library` }],
  '/api/campaigns/:id/play-profile': (w) => [
    { url: `/api/campaigns/${w.campaignId}/play-profile` },
    { url: `/api/campaigns/${w.campaignId}/play-profile?character_id=${w.pcId}` },
  ],
  '/api/campaigns/:id/region': (w) => [{ url: `/api/campaigns/${w.campaignId}/region` }],
  '/api/campaigns/:id/decisions': (w) => [{ url: `/api/campaigns/${w.campaignId}/decisions` }],
  '/api/srd/spells': (w) => [{ url: `/api/srd/spells?names=Fire%20Bolt,Magic%20Missile&campaign_id=${w.campaignId}` }],
  '/api/campaigns/:id/pending-rolls': (w) => [{ url: `/api/campaigns/${w.campaignId}/pending-rolls` }],
  '/api/campaigns/:id/settings': (w) => [{ url: `/api/campaigns/${w.campaignId}/settings` }],
  '/api/portraits/status': () => [{ url: '/api/portraits/status' }],
  '/api/portraits/creature/:name': (w) => [{ url: `/api/portraits/creature/Goblin%20Warrior?campaign_id=${w.campaignId}` }],
  '/api/campaigns/:id/region-map': (w) => [{ url: `/api/campaigns/${w.campaignId}/region-map` }],
  '/api/campaigns/:id/entities/:eid/buildings': (w) =>
    w.entityIds.map((eid) => ({ url: `/api/campaigns/${w.campaignId}/entities/${eid}/buildings` })),
};

/** GET /api routes left uncalled, each with the reason. A route in neither list fails the test. */
const EXEMPT: Record<string, string> = {};

/** Leaks a later package fixes, by field and surface: kept out of that surface's check and pinned by their own it.fails. */
const KNOWN_LEAKS: Array<{ field: DmOnlyFieldId; surface: string; reason: string }> = [];

/** A world event's own visibility shares its key with the player's fog-of-war dial, but never its values. */
const WORLD_EVENT_VISIBILITY = new Set(['public', 'discreet', 'secret']);

let db: Db;
let base: string;
let wsUrl: string;
let stop: () => Promise<void>;
let app: Express;
let world: World;
let dmOnly: readonly SecretField[];
let playerOnly: readonly SecretField[];
const fetched = new Map<string, Fetched[]>();
let snapshot: Fetched;
let dmReplies: Array<{ tool: string; structured: unknown; text: string }>;

/** Every route path registered for GET under /api, in registration order. */
function apiGetRoutes(express: Express): string[] {
  const paths: string[] = [];
  for (const layer of express.router.stack) {
    // A mounted sub-router would hide its routes from this walk, so one is refused rather than skipped.
    if ((layer.handle as unknown as { stack?: unknown }).stack !== undefined) throw new Error('a sub-router is mounted');
    const route = layer.route as unknown as { path: unknown; methods: Record<string, boolean> } | undefined;
    if (!route || typeof route.path !== 'string' || !route.path.startsWith('/api/')) continue;
    if (route.methods.get) paths.push(route.path);
  }
  return paths;
}

/** Every plain object in a JSON value, depth first. */
function objectsIn(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(value)) for (const item of value) objectsIn(item, out);
  else if (value && typeof value === 'object') {
    out.push(value as Record<string, unknown>);
    for (const item of Object.values(value)) objectsIn(item, out);
  }
  return out;
}

/** The objects with an own string value containing the carrier text. */
function carriersIn(json: unknown, carrier: string): Array<Record<string, unknown>> {
  const wanted = carrier.toLowerCase();
  return objectsIn(json).filter((object) =>
    Object.values(object).some((value) => typeof value === 'string' && value.toLowerCase().includes(wanted)),
  );
}

interface Leak {
  field: string;
  detail: string;
}

/** Each DM-only field a payload gives away, with how. */
function leaksIn(payload: Fetched): Leak[] {
  const lower = payload.text.toLowerCase();
  const found: Leak[] = [];
  for (const [field, plant] of Object.entries(world.plants)) {
    for (const marker of plant.markers) {
      if (lower.includes(marker.toLowerCase())) found.push({ field, detail: `"${marker}" in ${payload.url}` });
    }
    if (!plant.keyed) continue;
    for (const object of carriersIn(payload.json, plant.keyed.carrier)) {
      for (const key of plant.keyed.keys) {
        if (key in object) found.push({ field, detail: `key "${key}" beside "${plant.keyed.carrier}" in ${payload.url}` });
      }
    }
  }
  return found;
}

/** The leaks on a surface that no KNOWN_LEAKS entry already pins. */
function unexpectedLeaks(surface: string, leaks: Leak[]): string[] {
  return leaks
    .filter((leak) => !KNOWN_LEAKS.some((known) => known.surface === surface && known.field === leak.field))
    .map((leak) => `${leak.field}: ${leak.detail}`);
}

/** Paths where a player-only setting key turns up in a DM reply. */
function playerKeysIn(value: unknown, keys: readonly string[], path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => playerKeysIn(item, keys, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  const found: string[] = [];
  for (const [key, inner] of Object.entries(value)) {
    const eventVisibility = key === 'visibility' && typeof inner === 'string' && WORLD_EVENT_VISIBILITY.has(inner);
    if (keys.includes(key) && !eventVisibility) found.push(`${path}.${key}`);
    found.push(...playerKeysIn(inner, keys, `${path}.${key}`));
  }
  return found;
}

/** Player-only setting names a DM text body spells out; the visibility dial only counts with one of its values. */
function playerKeysInText(text: string, keys: readonly string[]): string[] {
  return keys.filter((key) =>
    key === 'visibility' ? /visibility\W{0,4}(full|bars|hidden)\b/i.test(text) : text.includes(key),
  );
}

/** Every row of every table, as one lowercase string, to prove a marker was really written. */
function databaseText(): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return tables
    .map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()))
    .join('\n')
    .toLowerCase();
}

async function getJson(url: string): Promise<Fetched> {
  const res = await fetch(`${base}${url}`);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { url, status: res.status, text, json };
}

function playerSnapshot(campaignId: number): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    socket.once('error', reject);
    socket.once('open', () => socket.send(JSON.stringify({ type: 'subscribe', campaignId })));
    socket.on('message', (raw) => {
      const text = String(raw);
      const message = JSON.parse(text) as { type: string; data?: unknown };
      if (message.type !== 'snapshot') return;
      socket.close();
      resolve({ url: 'ws snapshot', status: 200, text: JSON.stringify(message.data), json: message.data });
    });
  });
}

/** Builds the campaign the player and the DM read, with a marker planted in every DM-only field. */
async function plantWorld(): Promise<World> {
  const { createCampaign, saveCheckpoint, addGlossaryEntry } = await import('../src/core/campaign.js');
  const { updateSettings } = await import('../src/core/settings.js');
  const { addItem, createCharacter, createCompanion } = await import('../src/core/character.js');
  const { importRegion, findPlace } = await import('../src/core/region.js');
  const { revealPlace } = await import('../src/core/region-reveal.js');
  const { ensureWorld } = await import('../src/core/world-seed.js');
  const { currentGameDay, insertAgenda, insertEvent, insertFaction, listAgendas, listFactions, updateAgenda } =
    await import('../src/core/world-store.js');
  const { insertFaith } = await import('../src/core/world-faith-store.js');
  const { setPlaceState } = await import('../src/core/world-place-state.js');
  const { addAttitude } = await import('../src/core/world-memory.js');
  const { emitPacket } = await import('../src/core/world-news.js');
  const { ensureFactionEntity } = await import('../src/core/world-codex.js');
  const { linkEntities, upsertEntity } = await import('../src/core/codex.js');
  const { addJournalEntry, addPlotThread, addRumour, openChapter, plantClue, setStoryOutline, tagSceneChapter } =
    await import('../src/core/story.js');
  const { captureCheckpoint } = await import('../src/core/rewind.js');
  const { savePlaceMap } = await import('../src/core/place-map.js');
  const { startEncounter } = await import('../src/combat/engine.js');
  const { activeEncounter, getBattleState, listCombatants } = await import('../src/combat/state.js');

  const campaignId = createCampaign(db, { name: 'The Bell Tithe', story_shape: 'structured' }).campaign_id;
  // The player's dials leave their defaults so a DM reply could only carry them by leaking; the spoiler toggle stays off.
  updateSettings(db, campaignId, {
    cheat_mode: true,
    luck_bias: 2,
    roll_mode: 'auto',
    player_rolls: 'd20_only',
    roll_timeout_s: 77,
    visibility: 'full',
    show_secrets: false,
    auto_portraits: false,
  });

  const pcId = createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  }).character!.id;
  const companionId = createCompanion(db, { campaign_id: campaignId, name: 'Rook', source: { creature: 'Mastiff' } })
    .companion!.id;
  addItem(db, {
    campaign_id: campaignId,
    name: markName('itemname'),
    magic: { rarity: 'uncommon', base: 'Longsword', bonus: 1 },
    unidentified: true,
    equipped: true,
  });
  addItem(db, {
    campaign_id: campaignId,
    character_id: companionId,
    name: markName('itemcompanion'),
    magic: { rarity: 'rare' },
    unidentified: true,
  });

  // The map is imported with its secrets already in it, so every name derived from it carries them too.
  const realm = structuredClone(medium);
  realm.zqx_dm_note = mark('rawjson');
  const dangerMarkers: string[] = [];
  for (const cell of Object.values(realm.hexes)) {
    if (!cell.danger) continue;
    const tag = `danger${'abc'[dangerMarkers.length]}`;
    // The first danger is named a lair, so a brood faction is named after it.
    const renamed = dangerMarkers.length === 0 ? `${markName(tag)} Nest` : `${markName(tag)} Keep`;
    realm.features.find((feature) => feature.name === cell.danger!.name)!.name = renamed;
    cell.danger.name = renamed;
    dangerMarkers.push(mark(tag));
  }
  realm.features.push({ name: `${markName('area')} Wood`, hexes: ['q25_r16', 'q26_r16', 'q25_r17'] });
  importRegion(db, campaignId, realm, { source: 'generated' });
  ensureWorld(db, campaignId);
  const today = currentGameDay(db, campaignId);

  db.prepare(
    "UPDATE world_place SET link = 'https://example.invalid/' || ? || '/' || id, seed = ? WHERE campaign_id = ?",
  ).run(mark('placelink'), PLACE_SEED_MARKER, campaignId);
  const goldcaster = findPlace(db, campaignId, 'Goldcaster')!;
  const kaz = findPlace(db, campaignId, 'Kaz')!;
  const countyMarkers: string[] = [];
  const counties = db
    .prepare('SELECT id FROM world_county WHERE campaign_id = ? AND seat_place_id <> ? ORDER BY id')
    .all(campaignId, goldcaster.id) as Array<{ id: number }>;
  for (const county of counties) {
    const tag = `county${'abcdefghijklmnoprstuvwxyz'[countyMarkers.length]}`;
    db.prepare('UPDATE world_county SET name = ? WHERE id = ?').run(`County of ${markName(tag)}`, county.id);
    countyMarkers.push(mark(tag));
  }
  revealPlace(db, campaignId, goldcaster.id);

  openChapter(db, { campaign_id: campaignId, title: 'The Gilded Road' });
  setStoryOutline(db, {
    campaign_id: campaignId,
    premise: 'A city of bells.',
    secret_notes: `The abbot is ${mark('outline')} in disguise.`,
  });
  const visibleThread = addPlotThread(db, { campaign_id: campaignId, title: 'Find the missing bell' });
  const hiddenThread = addPlotThread(db, {
    campaign_id: campaignId,
    title: `The ${markName('threadtitle')} conspiracy`,
    summary: `${markName('threadsummary')} melts the bells.`,
    hidden: true,
  });
  plantClue(db, { campaign_id: campaignId, text: 'A torn ledger page.', thread_id: visibleThread.id });
  plantClue(db, {
    campaign_id: campaignId,
    text: `${markName('clue')} wax under the altar.`,
    thread_id: hiddenThread.id,
    hidden: true,
  });
  const rumourCarrier = 'Bell-founder Oskar drinks with smugglers.';
  const rumour = addRumour(db, { campaign_id: campaignId, text: rumourCarrier, truth: 'twisted', scope: 'location' });
  db.prepare('UPDATE rumour SET heard_at = ? WHERE id = ?').run(new Date().toISOString(), rumour.id);

  const realmEntity = db
    .prepare("SELECT id FROM entity WHERE campaign_id = ? AND kind = 'faction' ORDER BY id LIMIT 1")
    .get(campaignId) as { id: number };
  const abbot = upsertEntity(db, {
    campaign_id: campaignId,
    kind: 'npc',
    name: 'Abbot Hollis',
    summary: 'Keeper of the bells.',
    hidden_notes: `${markName('hiddennotes')} is his true name.`,
  }).entity;
  linkEntities(db, { campaign_id: campaignId, from: abbot.id, to: realmEntity.id, type: 'serves' });

  const factions = listFactions(db, campaignId);
  const guild = factions.find((faction) => faction.name === "Goldcaster Merchants' Guild")!;
  const crown = factions.find((faction) => faction.type === 'realm' && faction.place_id === goldcaster.id)!;
  const brood = factions.find((faction) => faction.type === 'monsters')!;
  const guildEntity = ensureFactionEntity(db, campaignId, guild)!;
  linkEntities(db, { campaign_id: campaignId, from: abbot.id, to: guildEntity, type: 'member_of' });
  // The brood's codex entry is named for its surroundings; its lair's name must stay out of it.
  ensureFactionEntity(db, campaignId, brood);
  const secretName = `The ${markName('secretfaction')} Circle`;
  const secret = insertFaction(db, campaignId, {
    name: secretName,
    type: 'gang',
    realm_id: crown.realm_id,
    county_id: null,
    place_id: goldcaster.id,
    secrecy: 'secret',
    resources: 1,
    capacities: {},
    created_day: today,
  });
  const endedName = `The ${markName('endedfaction')} Hand`;
  const ended = insertFaction(db, campaignId, {
    name: endedName,
    type: 'gang',
    realm_id: crown.realm_id,
    county_id: null,
    place_id: goldcaster.id,
    secrecy: 'secret',
    resources: 1,
    capacities: {},
    created_day: today - 30,
    ended_day: today - 1,
  });
  const portent = (text: string, heard: boolean) => ({ text, fired_day: today, heard });
  const agenda = (input: Parameters<typeof insertAgenda>[2]) => insertAgenda(db, campaignId, input);
  agenda({
    faction_id: secret.id,
    template: 'raid',
    target_kind: 'settlement',
    target_id: goldcaster.id,
    target_name: goldcaster.name,
    clock_size: 4,
    clock_filled: 1,
    portents: [portent(`Riders of ${secretName} watch the gates.`, true)],
    status: 'active',
    known_to_party: true,
    started_day: today,
  });
  agenda({
    faction_id: guild.id,
    template: 'feud',
    target_kind: 'rival_faction',
    target_id: secret.id,
    target_name: secretName,
    clock_size: 6,
    clock_filled: 2,
    portents: [
      portent('The guild hires sellswords.', true),
      portent(`${markName('unheardportent')} knives are sharpened.`, false),
    ],
    status: 'active',
    known_to_party: true,
    started_day: today,
  });
  agenda({
    faction_id: crown.id,
    template: 'feud',
    target_kind: 'rival_faction',
    target_id: ended.id,
    target_name: endedName,
    clock_size: 6,
    clock_filled: 1,
    portents: [portent('Heralds read a writ of outlawry.', true)],
    status: 'active',
    known_to_party: true,
    started_day: today,
  });
  agenda({
    faction_id: guild.id,
    template: 'feud',
    target_kind: 'rival_faction',
    target_id: null,
    target_name: `${markName('hiddenagenda')} Syndicate`,
    clock_size: 6,
    clock_filled: 3,
    portents: [portent(`${markName('hiddenportent')} ledgers are burned.`, false)],
    status: 'active',
    known_to_party: false,
    started_day: today,
  });
  const broodAgenda = listAgendas(db, campaignId).find((entry) => entry.faction_id === brood.id);
  if (broodAgenda) {
    updateAgenda(db, campaignId, broodAgenda.id, {
      known_to_party: true,
      portents: broodAgenda.portents.map((entry, i) => ({ ...entry, heard: i === 0 })),
    });
  }
  for (const [faction, value, reason] of [
    [guild, 2, 'Recovered their ledgers'],
    [secret, 3, 'Kept a masked stranger safe'],
    [ended, -2, 'Crossed a masked stranger'],
    [brood, 1, 'Left an offering'],
  ] as const) {
    addAttitude(db, campaignId, { kind: 'faction', id: faction.id }, { value, reason, day: today });
  }
  db.prepare('UPDATE world_faction SET resources = ?, capacities_json = json_object(?, 2) WHERE campaign_id = ?').run(
    RESOURCES_MARKER,
    mark('capacity'),
    campaignId,
  );

  const event = (text: string, visibility: 'public' | 'secret', placeId: number) =>
    insertEvent(db, campaignId, {
      day: today,
      kind: 'plot',
      text,
      severity: 2,
      place_id: placeId,
      faction_id: guild.id,
      agenda_id: null,
      causes: [],
      effects: {},
      visibility,
    });
  const secretEvent = event(`${markName('secretevent')} meets the abbot by night.`, 'secret', goldcaster.id);
  // A heard packet for a secret event is one the engine never emits; it proves the timeline filters on the event too.
  const secretPacket = Number(
    db
      .prepare("INSERT INTO world_packet (campaign_id, event_id, origin_place_id, truth, text) VALUES (?, ?, ?, 'true', ?)")
      .run(campaignId, secretEvent.id, goldcaster.id, `${markName('secretpacket')} was seen at the gate.`).lastInsertRowid,
  );
  db.prepare('INSERT INTO world_packet_arrival (packet_id, place_id, day, heard) VALUES (?, ?, ?, 1)').run(
    secretPacket,
    goldcaster.id,
    today,
  );
  const packetCarrier = 'Word spreads that the guild melts down temple bells.';
  emitPacket(db, campaignId, event('The guild buys every bell in the city.', 'public', goldcaster.id), {
    truth: 'twisted',
    text: packetCarrier,
  });

  const faith = insertFaith(db, campaignId, {
    name: `Church of the ${markName('statefaith')}`,
    aspect: 'storms',
    symbol: 'a cracked bell',
    head_place_id: null,
    fervor: 50,
    heresy_of: null,
    last_heresy_day: null,
    created_day: today,
  });
  const cause = event(`${markName('statecause')} rings Kaz with siege lines.`, 'public', kaz.id);
  setPlaceState(db, campaignId, kaz.id, today, { state: 'besieged', faith_id: faith.id, cause_event_id: cause.id });

  savePlaceMap(db, campaignId, goldcaster.id, { kind: 'city', url: 'https://example.invalid/city', raw: cityMap });
  db.prepare('INSERT INTO creature_portrait (creature, campaign_id, path, created_at) VALUES (?, ?, ?, ?)').run(
    'Goblin Warrior',
    campaignId,
    `/portraits/${campaignId}/goblin-warrior.png`,
    new Date().toISOString(),
  );
  addJournalEntry(db, { campaign_id: campaignId, text: 'The bells rang thirteen times.' });
  addGlossaryEntry(db, { campaign_id: campaignId, term: 'Bell-tithe', definition: 'The tax every parish pays in bronze.' });

  // The party walks into Goldcaster, which hears the news waiting there and saves the checkpoint a rewind restores.
  const saved = saveCheckpoint(db, {
    campaign_id: campaignId,
    scene_title: 'Under the bells',
    scene_location: 'Goldcaster',
    scene_summary: 'The party rode into Goldcaster as the bells rang.',
  });
  tagSceneChapter(db, campaignId, saved.scene.id);
  captureCheckpoint(db, campaignId, saved.scene.id);
  db.prepare("UPDATE checkpoint SET snapshot_json = json_set(snapshot_json, '$.zqx_dm_note', ?) WHERE campaign_id = ?").run(
    mark('snapshot'),
    campaignId,
  );

  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior' }],
  });
  const encounterId = activeEncounter(db, campaignId)!.id;
  const combatants = listCombatants(db, encounterId);
  const pcCombatant = combatants.find((combatant) => combatant.kind === 'pc')!.id;
  // On the PC's turn the snapshot lists its weapon attacks, where an unidentified blade must keep its kind.
  const pcTurn = getBattleState(db, campaignId)!.combatants.findIndex((combatant) => combatant.id === pcCombatant);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(pcTurn, encounterId);

  // The DM stores a rumour to hand out later, mid-scene, so the party has not heard it yet.
  addRumour(db, { campaign_id: campaignId, text: `${markName('unheardrumour')} says the duke is dead.`, truth: 'false' });

  const entityIds = (
    db.prepare('SELECT id FROM entity WHERE campaign_id = ? ORDER BY id').all(campaignId) as Array<{ id: number }>
  ).map((row) => row.id);

  return {
    campaignId,
    pcId,
    companionId,
    entityIds,
    pcCombatant,
    foeCombatant: combatants.find((combatant) => combatant.team === 'enemy')!.id,
    secretFactionId: secret.id,
    plants: {
      rumour_truth: { markers: [], keyed: { carrier: rumourCarrier, keys: ['truth'] } },
      unheard_rumour: { markers: [mark('unheardrumour')] },
      packet_truth: { markers: [], keyed: { carrier: packetCarrier, keys: ['truth'] } },
      outline_secret_notes: { markers: [mark('outline')] },
      hidden_thread: { markers: [mark('threadtitle'), mark('threadsummary')] },
      hidden_clue: { markers: [mark('clue')] },
      codex_hidden_notes: { markers: [mark('hiddennotes')] },
      unidentified_item_name: { markers: [mark('itemname'), mark('itemcompanion')] },
      secret_faction: { markers: [mark('secretfaction')] },
      ended_secret_faction: { markers: [mark('endedfaction')] },
      hidden_agenda: { markers: [mark('hiddenagenda'), mark('hiddenportent')] },
      unheard_portent: { markers: [mark('unheardportent')] },
      faction_resources: { markers: [String(RESOURCES_MARKER)] },
      faction_capacities: { markers: [mark('capacity')] },
      secret_event: { markers: [mark('secretevent'), mark('secretpacket')] },
      unknown_danger_name: { markers: dangerMarkers },
      unknown_area_name: { markers: [mark('area')] },
      unknown_county_name: { markers: countyMarkers },
      unknown_place_state: {
        markers: [mark('statefaith'), mark('statecause')],
        keyed: { carrier: kaz.name, keys: ['state', 'until_day'] },
      },
      region_raw_json: { markers: [mark('rawjson')] },
      place_seed: { markers: [String(PLACE_SEED_MARKER)] },
      place_link: { markers: [mark('placelink')] },
      checkpoint_snapshot: { markers: [mark('snapshot')] },
    },
  };
}

beforeAll(async () => {
  // Route modules load through a fresh module graph, as the other route tests do under isolate: false.
  vi.resetModules();
  ({ DM_ONLY_FIELDS: dmOnly, PLAYER_ONLY_FIELDS: playerOnly } = await import('../src/core/secret-fields.js'));
  const { openDb } = await import('../src/db/connection.js');
  const { HOST, startHttpServer } = await import('../src/transport/http.js');
  const { createGameServer } = await import('../src/mcp/server.js');
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'secretfields0123456789abcdef012' });
  base = `http://${HOST}:${started.port}`;
  wsUrl = `ws://${HOST}:${started.port}/ws`;
  stop = started.close;
  app = started.server.listeners('request')[0] as Express;

  const realRandom = Math.random;
  let step = 0;
  // A golden-ratio walk: spread out like random draws, but the same world every run.
  Math.random = () => (++step * 0.6180339887498949) % 1;
  try {
    world = await plantWorld();
  } finally {
    Math.random = realRandom;
  }

  // The DM's deed against the secret faction is real work: run it before the player reads, so any backlash
  // reason it writes sits on the surfaces the checks below scan. Its rival must not learn the secret's name.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'secret-fields', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  dmReplies = [];
  for (const [tool, args] of [
    ['load_campaign', { campaign_id: world.campaignId }],
    [
      'world',
      {
        campaign_id: world.campaignId,
        op: 'deed',
        target: world.secretFactionId,
        value: -3,
        reason: 'Routed a ring of smugglers',
      },
    ],
    ['world', { campaign_id: world.campaignId, op: 'get' }],
  ] as const) {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text ?? '';
    if (result.isError) throw new Error(`${tool} failed: ${text}`);
    dmReplies.push({ tool, structured: result.structuredContent, text });
  }
  await client.close();

  for (const route of Object.keys(CALLS)) {
    const results: Fetched[] = [];
    for (const call of CALLS[route]!(world)) results.push(await getJson(call.url));
    fetched.set(route, results);
  }
  snapshot = await playerSnapshot(world.campaignId);
}, 120_000);

afterAll(async () => {
  await stop();
});

describe('the secret-field registry', () => {
  it('plants every DM-only field, and nothing the registry does not name', () => {
    const ids = dmOnly.map((field) => field.id).sort();
    expect(Object.keys(world.plants).sort()).toEqual(ids);
    for (const [id, plant] of Object.entries(world.plants)) {
      expect(plant.markers.length > 0 || plant.keyed !== undefined, `${id} plants nothing`).toBe(true);
    }
  });

  it('really writes every marker into the database', () => {
    const stored = databaseText();
    const missing = Object.entries(world.plants).flatMap(([id, plant]) =>
      plant.markers.filter((marker) => !stored.includes(marker.toLowerCase())).map((marker) => `${id}: ${marker}`),
    );
    expect(missing).toEqual([]);
  });

  it('names exactly the player-only settings as player-only', async () => {
    const { PLAYER_ONLY_SETTINGS } = await import('../src/core/settings.js');
    expect(playerOnly.map((field) => field.id)).toEqual([...PLAYER_ONLY_SETTINGS]);
  });
});

describe('every GET /api route is read as the player', () => {
  it('calls or exempts every GET /api route the server registers', () => {
    const registered = apiGetRoutes(app);
    expect(registered.length).toBeGreaterThan(20);
    const planned = [...Object.keys(CALLS), ...Object.keys(EXEMPT)];
    expect(registered.filter((route) => !planned.includes(route)), 'routes neither called nor exempted').toEqual([]);
    expect(planned.filter((route) => !registered.includes(route)), 'planned routes the server no longer has').toEqual([]);
    for (const [route, reason] of Object.entries(EXEMPT)) expect(reason.trim(), route).not.toBe('');
  });

  for (const route of Object.keys(CALLS)) {
    it(`${route} answers without a DM-only secret`, () => {
      const results = fetched.get(route)!;
      const calls = CALLS[route]!(world);
      results.forEach((result, i) => {
        expect(calls[i]!.ok ?? [200], `${result.url} answered ${result.status}: ${result.text.slice(0, 200)}`).toContain(
          result.status,
        );
      });
      // A route whose calls may miss still has to answer one of them for real.
      expect(results.some((result) => result.status === 200), `${route} never answered 200`).toBe(true);
      expect(unexpectedLeaks(route, results.flatMap(leaksIn))).toEqual([]);
    });
  }

  it('keeps every DM-only secret out of the WebSocket snapshot', () => {
    expect(snapshot.json).toBeTruthy();
    expect(unexpectedLeaks('ws snapshot', leaksIn(snapshot))).toEqual([]);
  });

  it('keeps a secret faction out of the rival backlash the player reads', () => {
    // The deed against the secret faction wrote backlash on its open rival, whose reasons the player sees.
    const backlash = db
      .prepare('SELECT reason FROM world_attitude WHERE campaign_id = ? AND rival_of = ?')
      .get(world.campaignId, world.secretFactionId) as { reason: string } | undefined;
    expect(backlash?.reason).toBe('Routed a ring of smugglers (rival of a hidden rival)');
    const worldPayload = fetched.get('/api/campaigns/:id/world')![0]!;
    expect(leaksIn(worldPayload).filter((leak) => leak.field === 'secret_faction')).toEqual([]);
    expect(leaksIn(snapshot).filter((leak) => leak.field === 'secret_faction')).toEqual([]);
  });

  it('pins each known leak to a registry field and a surface this test reads', () => {
    const surfaces = [...Object.keys(CALLS), 'ws snapshot'];
    for (const known of KNOWN_LEAKS) {
      expect(dmOnly.map((field) => field.id), known.reason).toContain(known.field);
      expect(surfaces, known.reason).toContain(known.surface);
    }
  });

  for (const known of KNOWN_LEAKS) {
    // Fails while the leak stands; once it is fixed it.fails reports the pass and the entry above can go.
    it.fails(`${known.surface} keeps ${known.field} out (known leak: ${known.reason})`, () => {
      const payloads = known.surface === 'ws snapshot' ? [snapshot] : fetched.get(known.surface)!;
      expect(payloads.flatMap(leaksIn).filter((leak) => leak.field === known.field)).toEqual([]);
    });
  }

  it('shows every keyed carrier to the player somewhere, so each key check bites', () => {
    const payloads = [...[...fetched.values()].flat(), snapshot];
    for (const [id, plant] of Object.entries(world.plants)) {
      if (!plant.keyed) continue;
      const seen = payloads.some((payload) => carriersIn(payload.json, plant.keyed!.carrier).length > 0);
      expect(seen, `${id}: "${plant.keyed.carrier}" never reached the player`).toBe(true);
    }
  });
});

describe('seeded bandit bands never carry a hidden place name', () => {
  it('names every bandit band after a settlement, never the area or danger it camps at', () => {
    const settlements = (
      db
        .prepare("SELECT name FROM world_place WHERE campaign_id = ? AND kind = 'settlement'")
        .all(world.campaignId) as Array<{ name: string }>
    ).map((row) => row.name);
    const hidden = db
      .prepare("SELECT name FROM world_place WHERE campaign_id = ? AND kind IN ('area', 'danger')")
      .all(world.campaignId) as Array<{ name: string }>;
    const bands = db
      .prepare("SELECT name FROM world_faction WHERE campaign_id = ? AND type = 'bandits'")
      .all(world.campaignId) as Array<{ name: string }>;
    expect(bands.length).toBeGreaterThan(0);
    for (const band of bands) {
      for (const place of hidden) expect(band.name, place.name).not.toContain(place.name);
      expect(settlements.some((name) => band.name.includes(name)), band.name).toBe(true);
    }
  });
});

describe('DM replies carry no player-only setting', () => {
  it('the player window really holds every player-only setting', () => {
    const settings = fetched.get('/api/campaigns/:id/settings')![0]!.json as Record<string, unknown>;
    for (const field of playerOnly) expect(settings, field.id).toHaveProperty(field.id);
  });

  it.each(['load_campaign', 'world'])('%s carries no player-only key in its structured reply or its text', (tool) => {
    const reply = dmReplies.find((entry) => entry.tool === tool)!;
    const keys = playerOnly.map((field) => field.id);
    expect(reply.structured).toBeTruthy();
    expect(playerKeysIn(reply.structured, keys)).toEqual([]);
    expect(playerKeysInText(reply.text, keys)).toEqual([]);
  });
});
