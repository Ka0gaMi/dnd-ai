// The world block on a large map after a year: within WORLD_BRIEFING, must-act items first, attitudes as
// bands, what the party is known for in its realm, fetch hints last, and the least important sections trimmed first.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import type { WorldPlace } from '../src/core/region.js';
import type { WorldFaction } from '../src/core/world-store.js';

const large = JSON.parse(readFileSync(new URL('./fixtures/realm-large.json', import.meta.url), 'utf8')) as unknown;

const HEADER = 'World (DM only; weave these in, never read them out):';
const HELD = 'Held clocks (full; each waits until the party hears two of its signs):';
const HINTS = 'Fetch more when a scene needs it:';
/** Every section key in display order, which is also the order of importance. */
const ORDER = [
  'Held clocks',
  'Portents near the party',
  'Attitudes toward the party',
  'Known for in',
  'Known clocks',
  'Troubled settlements',
  'Recent county transfers',
  'Heard news',
  'Faith here',
  'While you were away from',
  'Fetch more when a scene needs it',
];

let campaign: typeof import('../src/core/campaign.js');
let store: typeof import('../src/core/world-store.js');
let memory: typeof import('../src/core/world-memory.js');
let resolve: typeof import('../src/core/world-resolve.js');
let tokens: typeof import('../src/core/token-budget.js');
let worldBriefing: (typeof import('../src/core/world-briefing.js'))['worldBriefing'];

let base: Db;
let campaignId: number;
let dione: WorldPlace;
let realm: { id: number; name: string };
let today: number;
let since: number;
let wary: WorldFaction;
let friendly: WorldFaction;
let elsewhere: WorldFaction;

beforeAll(async () => {
  // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world fresh on the real one.
  vi.resetModules();
  const { openDb } = await import('../src/db/connection.js');
  campaign = await import('../src/core/campaign.js');
  store = await import('../src/core/world-store.js');
  memory = await import('../src/core/world-memory.js');
  resolve = await import('../src/core/world-resolve.js');
  tokens = await import('../src/core/token-budget.js');
  ({ worldBriefing } = await import('../src/core/world-briefing.js'));
  const region = await import('../src/core/region.js');
  const seed = await import('../src/core/world-seed.js');
  const politics = await import('../src/core/politics-service.js');
  const { advanceTime } = await import('../src/core/calendar.js');

  // Pin the world's seed so every run builds and ticks the same year.
  let state = 42;
  const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
  try {
    base = openDb(':memory:');
    campaignId = campaign.createCampaign(base, { name: 'The Long Year', story_shape: 'sandbox' }).campaign_id;
    region.importRegion(base, campaignId, large, { source: 'generated' });
    seed.ensureWorld(base, campaignId);
    campaign.saveCheckpoint(base, { campaign_id: campaignId, scene_summary: 'Arrive.', scene_location: 'Dione' });
    campaign.saveCheckpoint(base, { campaign_id: campaignId, scene_summary: 'Ride out.', scene_location: 'Blackhall' });
    for (let month = 0; month < 6; month += 1) advanceTime(base, campaignId, { days: 60 });
    campaign.saveCheckpoint(base, { campaign_id: campaignId, scene_summary: 'Home again.', scene_location: 'Dione' });
  } finally {
    spy.mockRestore();
  }

  today = store.currentGameDay(base, campaignId);
  dione = region.findPlace(base, campaignId, 'Dione')!;
  since = memory.lastVisit(base, campaignId, dione.id)!;
  realm = politics.placePolitics(base, campaignId, dione).realm!;
  const factions = store.listFactions(base, campaignId);
  [wary, friendly, elsewhere] = [factions[0]!, factions[1]!, factions[2]!];
  const otherRealm = (base.prepare('SELECT id FROM world_realm WHERE campaign_id = ? AND id != ? ORDER BY id').get(
    campaignId,
    realm.id,
  ) as { id: number }).id;

  // Deeds as the world tool records them: at the party's place, in its realm.
  const deed = { day: today, place_id: dione.id, realm_id: realm.id };
  const regard = (faction: WorldFaction, value: number, reason: string): void => {
    memory.addAttitude(base, campaignId, { kind: 'faction', id: faction.id }, { ...deed, value, reason });
  };
  regard(wary, -3, 'burned the granary');
  regard(friendly, 4, 'broke the siege of the bridge');
  memory.addAttitude(
    base,
    campaignId,
    { kind: 'faction', id: elsewhere.id },
    { day: today, value: 2, reason: 'cleared the toll road', realm_id: otherRealm },
  );
}, 180_000);

/** A private copy of the ticked year, so each test's additions stay its own. */
function fresh(): Db {
  const db = new Database(base.serialize());
  db.pragma('foreign_keys = ON');
  return db;
}

/** Each section of the block by its key (the heading up to its first colon), with its lines. */
function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('- ')) {
      current.push(line);
      continue;
    }
    current = [line];
    out.set(line.slice(0, line.indexOf(':')), current);
  }
  return out;
}

/** The ORDER key a section heading belongs to. */
function orderKey(heading: string): string {
  return ORDER.find((key) => heading.startsWith(key)) ?? heading;
}

function heldAgenda(db: Db, faction: WorldFaction, sign: string, firedDay = today - 4): void {
  store.insertAgenda(db, campaignId, {
    faction_id: faction.id,
    template: 'raid',
    target_kind: 'settlement',
    target_id: dione.id,
    target_name: 'Dione',
    clock_size: 4,
    clock_filled: 4,
    portents: [
      { text: 'Smoke rises on the ridge.', fired_day: firedDay - 2, heard: true },
      { text: sign, fired_day: firedDay, heard: false },
    ],
    status: 'held',
    started_day: firedDay - 20,
  });
}

function threat(db: Db, faction: WorldFaction, sign: string): void {
  store.insertAgenda(db, campaignId, {
    faction_id: faction.id,
    template: 'settlement_scheme',
    target_kind: 'settlement',
    target_id: dione.id,
    target_name: 'Dione',
    clock_size: 6,
    clock_filled: 2,
    portents: [{ text: sign, fired_day: today - 1, heard: false }],
    status: 'active',
    started_day: today - 10,
  });
}

function news(db: Db, text: string): void {
  db.prepare(
    `INSERT INTO rumour (campaign_id, scope, text, source_kind, heard_at, created_at)
     VALUES (?, 'location', ?, 'world', ?, ?)`,
  ).run(campaignId, text, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
}

function awayEvent(db: Db, text: string): void {
  store.insertEvent(db, campaignId, {
    day: since + 1,
    kind: 'disaster',
    text,
    severity: 1,
    place_id: dione.id,
    faction_id: null,
    agenda_id: null,
    causes: [],
    effects: {},
    visibility: 'public',
  });
}

describe('the world block after a year on the large map', () => {
  it('fits within WORLD_BRIEFING without trimming, and stays off the player snapshot', () => {
    const db = fresh();
    const text = worldBriefing(db, campaignId, 'Dione');

    expect(text.startsWith(HEADER)).toBe(true);
    expect(tokens.estimateTokens(text)).toBeLessThanOrEqual(tokens.WORLD_BRIEFING);
    expect(text).not.toContain('trimmed to fit');
    expect(campaign.campaignSnapshot(db, campaignId, { forPlayer: true }).world_briefing).toBe('');
  });

  it('opens with the held clocks and nearby portents, and keeps every section in order', () => {
    const db = fresh();
    const [holder, schemer] = store.listFactions(db, campaignId).slice(3, 5) as [WorldFaction, WorldFaction];
    heldAgenda(db, holder, 'Horses gather at the ford.');
    threat(db, schemer, 'Strangers count the gate guards.');

    const text = worldBriefing(db, campaignId, 'Dione');
    const headings = [...sections(text).keys()].slice(1).map(orderKey);

    expect(headings.slice(0, 2)).toEqual(['Held clocks', 'Portents near the party']);
    expect(headings.at(-1)).toBe('Fetch more when a scene needs it');
    const positions = headings.map((key) => ORDER.indexOf(key));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    const held = store
      .listAgendas(db, campaignId, { status: 'held' })
      .find((agenda) => agenda.faction_id === holder.id)!;
    expect(text).toContain(
      `${HELD}\n- ${holder.name}: raid -> Dione [4/4], agenda ${held.id}; 1/2 signs heard, lands by day ${
        today - 4 + resolve.HOLD_TIMEOUT_DAYS
      }; next sign: Horses gather at the ford.`,
    );
    expect(text).toContain(`- Strangers count the gate guards. (${schemer.name}, 0 hexes away)`);
    expect(text).toContain(
      '- world {op: setback, agenda: <id>} or {op: thwart, agenda: <id>} when the party acts against a held clock',
    );
    // A held clock is listed once, under its own heading, never again as a portent.
    expect(text).not.toContain('Smoke rises on the ridge.');
    expect(text).not.toContain(`Horses gather at the ford. (${holder.name}`);
  });

  it('shows each attitude as a band with its total and strongest reason', () => {
    const text = worldBriefing(fresh(), campaignId, 'Dione');
    const attitudes = sections(text).get('Attitudes toward the party')!;

    expect(attitudes).toContain(`- ${wary.name} — wary (-3, burned the granary)`);
    expect(attitudes).toContain(`- ${friendly.name} — friendly (+4, broke the siege of the bridge)`);
    expect(text).not.toContain(`${wary.name}: -3`);
  });

  it("names what the party is known for in the party's realm only", () => {
    const text = worldBriefing(fresh(), campaignId, 'Dione');
    const known = sections(text).get(`Known for in ${realm.name}`)!;

    expect(known.slice(1)).toEqual([
      `- broke the siege of the bridge (helped ${friendly.name})`,
      `- burned the granary (harmed ${wary.name})`,
    ]);
    expect(text).toContain(`- ${elsewhere.name} — friendly (+2, cleared the toll road)`);
  });

  it('ends with where to fetch more', () => {
    const text = worldBriefing(fresh(), campaignId, 'Dione');
    const lines = text.split('\n');
    const hints = lines.indexOf(HINTS);

    expect(hints).toBeGreaterThan(0);
    expect(lines.slice(hints + 1).length).toBeGreaterThan(0);
    expect(lines.slice(hints + 1).every((line) => line.startsWith('- '))).toBe(true);
    expect(text).toContain("- world {op: get, faction: <name>} for one faction's agendas, signs and regard");
    expect(text).toContain('- world {op: get, near: "Dione"} for the factions and agendas around the party');
  });
});

describe('trimming the world block to its budget', () => {
  it('drops the least important sections first and keeps every must-act item', () => {
    const db = fresh();
    const factions = store.listFactions(db, campaignId);
    heldAgenda(db, factions[3]!, 'Horses gather at the ford.');
    heldAgenda(db, factions[4]!, 'A black banner hangs from the mill.');
    for (let i = 0; i < 5; i += 1) {
      threat(db, factions[5 + i]!, `Sign ${i}: strangers pace out the walls of Dione at night.`);
    }
    const before = sections(worldBriefing(db, campaignId, 'Dione'));

    const filler = (tag: string): string => `${tag} ${'the long road winds through ash and rain; '.repeat(30)}`;
    for (let i = 0; i < 5; i += 1) news(db, filler(`News ${i}:`));
    for (let i = 0; i < 6; i += 1) awayEvent(db, filler(`Away ${i}:`));

    const text = worldBriefing(db, campaignId, 'Dione');
    const after = sections(text);

    expect(tokens.estimateTokens(text)).toBeLessThanOrEqual(tokens.WORLD_BRIEFING);
    expect(after.get('Held clocks (full; each waits until the party hears two of its signs)')!.length).toBe(3);
    expect(after.get('Portents near the party')!.length).toBe(6);
    // The least important sections went first: the away log and the faith line are gone, the news only cut short.
    expect([...after.keys()].some((key) => key.startsWith('While you were away'))).toBe(false);
    expect(after.has('Faith here')).toBe(false);
    expect(after.get('Heard news')!.length).toBeGreaterThan(1);
    expect(after.get('Heard news')!.length).toBeLessThan(6);
    for (const [key, lines] of before) {
      if (['Heard news', 'Faith here', 'Fetch more when a scene needs it'].includes(key)) continue;
      if (key.startsWith('While you were away')) continue;
      expect(after.get(key)).toEqual(lines);
    }
    expect(after.get('Fetch more when a scene needs it')!.at(-1)).toMatch(
      /^- trimmed to fit: while you were away \(6\), faith \(1\), news \(\d\)$/,
    );
  });

  it('keeps every held clock even when they alone exceed the budget', () => {
    const db = fresh();
    const factions = store.listFactions(db, campaignId);
    const sign = (i: number): string =>
      `Sign ${i}: ${'riders without banners water their horses at the ford; '.repeat(12)}`;
    for (let i = 0; i < 12; i += 1) heldAgenda(db, factions[3 + i]!, sign(i), today - 4 - i);

    const text = worldBriefing(db, campaignId, 'Dione');
    const kept = [...sections(text).keys()].slice(1).map(orderKey);

    expect(text.split('\n').filter((line) => line.includes('next sign: Sign '))).toHaveLength(12);
    expect(kept[0]).toBe('Held clocks');
    expect(kept.at(-1)).toBe('Fetch more when a scene needs it');
    const mustActAndHints = ['Held clocks', 'Portents near the party', 'Fetch more when a scene needs it'];
    expect(kept.every((key) => mustActAndHints.includes(key))).toBe(true);
    expect(text).toMatch(/^- trimmed to fit: while you were away \(\d+\), .*, attitudes \(\d+\)$/m);
  });
});
