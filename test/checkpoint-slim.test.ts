// Snapshot v2 keeps the heavy world tables column-wise and a campaign keeps its last three checkpoints;
// the news prefilter only skips route searches, never an arrival.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import type { WorldPlace } from '../src/core/region.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

const large = fixture('realm-large.json');

type Row = Record<string, unknown>;

let openDb: (typeof import('../src/db/connection.js'))['openDb'];
let campaign: typeof import('../src/core/campaign.js');
let region: typeof import('../src/core/region.js');
let rewind: typeof import('../src/core/rewind.js');
let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let tickTo: (typeof import('../src/core/world-tick.js'))['tickTo'];
let store: typeof import('../src/core/world-store.js');
let news: typeof import('../src/core/world-news.js');
let placeState: typeof import('../src/core/world-place-state.js');
let getPolitics: (typeof import('../src/core/politics-store.js'))['getPolitics'];

beforeAll(async () => {
  // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world fresh on the real one.
  vi.resetModules();
  ({ openDb } = await import('../src/db/connection.js'));
  campaign = await import('../src/core/campaign.js');
  region = await import('../src/core/region.js');
  rewind = await import('../src/core/rewind.js');
  ({ ensureWorld } = await import('../src/core/world-seed.js'));
  ({ tickTo } = await import('../src/core/world-tick.js'));
  store = await import('../src/core/world-store.js');
  news = await import('../src/core/world-news.js');
  placeState = await import('../src/core/world-place-state.js');
  ({ getPolitics } = await import('../src/core/politics-store.js'));
});

/** A fresh campaign on the map with its world ticked forward the given number of days. */
function tickedWorld(db: Db, realm: unknown, days = 180): number {
  const campaignId = campaign.createCampaign(db, { name: 'Slim', story_shape: 'sandbox' }).campaign_id;
  region.importRegion(db, campaignId, realm, { source: 'generated' });
  ensureWorld(db, campaignId);
  advance(db, campaignId, days);
  return campaignId;
}

function advance(db: Db, campaignId: number, days: number): void {
  const target = store.getWorldState(db, campaignId)!.last_tick_day + days;
  while (store.getWorldState(db, campaignId)!.last_tick_day < target) tickTo(db, campaignId, target);
}

/** Moves the first county a foreign sovereign may take, so the holders and claims differ from the seeded map. */
function conquer(db: Db, campaignId: number): void {
  const politics = getPolitics(db, campaignId)!;
  for (const county of politics.counties) {
    for (const realm of politics.realms) {
      try {
        placeState.transferCounty(db, campaignId, county.id, realm.id);
        return;
      } catch {
        // Refused and nothing written; try the next pair.
      }
    }
  }
  throw new Error('No county could change hands.');
}

function settlements(db: Db, campaignId: number): WorldPlace[] {
  return region.getRegion(db, campaignId)!.places.filter((place) => place.kind === 'settlement');
}

/** Every world row a rewind restores, each table sorted so row order does not matter. */
function worldDump(db: Db, campaignId: number): Record<string, string[]> {
  const queries: Record<string, string> = {
    world_state: 'SELECT * FROM world_state WHERE campaign_id = ?',
    world_faith: 'SELECT * FROM world_faith WHERE campaign_id = ?',
    world_faction: 'SELECT * FROM world_faction WHERE campaign_id = ?',
    world_agenda: 'SELECT * FROM world_agenda WHERE campaign_id = ?',
    world_event: 'SELECT * FROM world_event WHERE campaign_id = ?',
    world_packet: 'SELECT * FROM world_packet WHERE campaign_id = ?',
    world_packet_arrival:
      'SELECT a.* FROM world_packet_arrival a JOIN world_packet p ON p.id = a.packet_id WHERE p.campaign_id = ?',
    world_attitude: 'SELECT * FROM world_attitude WHERE campaign_id = ?',
    world_visit: 'SELECT * FROM world_visit WHERE campaign_id = ?',
    world_contest: 'SELECT * FROM world_contest WHERE campaign_id = ?',
    world_place_state: 'SELECT * FROM world_place_state WHERE campaign_id = ?',
    world_county: 'SELECT id, realm_id, duchy_id, is_march FROM world_county WHERE campaign_id = ?',
    world_claim: 'SELECT * FROM world_claim WHERE campaign_id = ?',
  };
  return Object.fromEntries(
    Object.entries(queries).map(([table, sql]) => [
      table,
      (db.prepare(sql).all(campaignId) as Row[]).map((row) => JSON.stringify(row)).sort(),
    ]),
  );
}

function storedJson(db: Db, checkpointId: number): string {
  return (db.prepare('SELECT snapshot_json FROM checkpoint WHERE id = ?').get(checkpointId) as { snapshot_json: string })
    .snapshot_json;
}

/** The same snapshot as the v1 format wrote it: every table as row objects and no version. */
function asV1(json: string): string {
  const { version: _version, ...snapshot } = JSON.parse(json) as {
    version?: number;
    tables: Record<string, Row[] | { columns: string[]; rows: unknown[][] }>;
  };
  for (const [table, value] of Object.entries(snapshot.tables)) {
    if (Array.isArray(value)) continue;
    snapshot.tables[table] = value.rows.map((row) =>
      Object.fromEntries(value.columns.map((column, index) => [column, row[index]])),
    );
  }
  return JSON.stringify(snapshot);
}

/** A raid citing a world event, a conquest, then a checkpoint; returns the world as it was saved. */
function checkpointWithPlaceAndCounty(db: Db, campaignId: number): { id: number; before: Record<string, string[]> } {
  const today = store.currentGameDay(db, campaignId);
  const [first] = settlements(db, campaignId);
  const cause = store.listEvents(db, campaignId)[0]!;
  placeState.setPlaceState(db, campaignId, first!.id, today, { state: 'raided', cause_event_id: cause.id });
  conquer(db, campaignId);
  const id = rewind.captureCheckpoint(db, campaignId, null);
  return { id, before: worldDump(db, campaignId) };
}

/** What happens after the checkpoint: two more months of news, a siege and another conquest. */
function laterWar(db: Db, campaignId: number): void {
  const today = store.currentGameDay(db, campaignId);
  const places = settlements(db, campaignId);
  placeState.setPlaceState(db, campaignId, places[1]!.id, today, { state: 'besieged' });
  conquer(db, campaignId);
  advance(db, campaignId, 60);
}

describe('snapshot v2', () => {
  it('stores the event and packet tables column-wise and round-trips place states and counties', () => {
    const db = openDb(':memory:');
    const campaignId = tickedWorld(db, large, 60);
    const { id, before } = checkpointWithPlaceAndCounty(db, campaignId);

    const stored = JSON.parse(storedJson(db, id)) as {
      version: number;
      tables: Record<string, unknown>;
      world_counties: { holders: unknown[]; claims: unknown[] };
    };
    expect(stored.version).toBe(2);
    for (const table of ['world_event', 'world_packet', 'world_packet_arrival']) {
      const value = stored.tables[table] as { columns: string[]; rows: unknown[][] };
      expect(value.columns.length, table).toBeGreaterThan(0);
      expect(value.rows.length, table).toBeGreaterThan(0);
      expect(value.rows.every((row) => row.length === value.columns.length), table).toBe(true);
    }
    expect(Array.isArray(stored.tables.world_faction)).toBe(true);
    expect(stored.tables.world_place_state).toContainEqual(expect.objectContaining({ state: 'raided' }));
    expect(stored.world_counties.claims.length).toBeGreaterThan(0);

    laterWar(db, campaignId);
    expect(worldDump(db, campaignId)).not.toEqual(before);

    rewind.rewindToCheckpoint(db, campaignId);

    expect(worldDump(db, campaignId)).toEqual(before);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  }, 60000);

  it('still restores a v1 snapshot identically', () => {
    const db = openDb(':memory:');
    const campaignId = tickedWorld(db, large, 60);
    const { id, before } = checkpointWithPlaceAndCounty(db, campaignId);
    db.prepare('UPDATE checkpoint SET snapshot_json = ? WHERE id = ?').run(asV1(storedJson(db, id)), id);
    expect(JSON.parse(storedJson(db, id))).not.toHaveProperty('version');

    laterWar(db, campaignId);
    rewind.rewindToCheckpoint(db, campaignId);

    expect(worldDump(db, campaignId)).toEqual(before);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  }, 60000);
});

describe('checkpoint history', () => {
  it('keeps only the last three checkpoints of a campaign and leaves other campaigns alone', () => {
    const db = openDb(':memory:');
    const create = (name: string): number =>
      campaign.createCampaign(db, { name, story_shape: 'sandbox' }).campaign_id;
    const kept = create('Kept');
    const other = create('Other');
    const save = (campaignId: number, summary: string): number => {
      const saved = campaign.saveCheckpoint(db, { campaign_id: campaignId, scene_summary: summary });
      return rewind.captureCheckpoint(db, campaignId, saved.scene.id);
    };
    const ids = (campaignId: number): number[] =>
      (
        db.prepare('SELECT id FROM checkpoint WHERE campaign_id = ? ORDER BY id').all(campaignId) as Array<{
          id: number;
        }>
      ).map((row) => row.id);

    const otherIds = [save(other, 'One.'), save(other, 'Two.')];
    const keptIds: number[] = [];
    for (let scene = 1; scene <= 5; scene += 1) keptIds.push(save(kept, `Scene ${scene}.`));

    expect(ids(kept)).toEqual(keptIds.slice(-3));
    expect(ids(other)).toEqual(otherIds);
    expect(rewind.rewindToCheckpoint(db, kept).checkpoint_id).toBe(keptIds.at(-1));
  });
});

describe('on a ticked large map', () => {
  let db: Db;
  let campaignId: number;

  beforeAll(() => {
    db = openDb(':memory:');
    campaignId = tickedWorld(db, large);
  }, 120000);

  it('writes a v2 snapshot at most 60% of the size of v1', () => {
    const id = rewind.captureCheckpoint(db, campaignId, null);
    const v2 = storedJson(db, id);
    const v1 = asV1(v2);
    const arrivals = (JSON.parse(v1) as { tables: { world_packet_arrival: unknown[] } }).tables.world_packet_arrival;

    expect(arrivals.length).toBeGreaterThan(1000);
    expect(v2.length).toBeLessThanOrEqual(v1.length * 0.6);
  });

  it('gives the same arrivals with the hex prefilter as with a route search to every settlement', () => {
    const view = region.getRegion(db, campaignId)!;
    const towns = view.places.filter((place) => place.kind === 'settlement');
    const days = new Map<string, number>();
    const travel = (from: WorldPlace, to: WorldPlace): number => {
      const key = `${from.id}:${to.id}`;
      if (!days.has(key)) days.set(key, news.travelDays(view, from, to));
      return days.get(key)!;
    };
    /** Every settlement within the radius by a full route search, as emitPacket found them before the prefilter. */
    const unfiltered = (originId: number, day: number, radius: number): string[] => {
      const origin = view.places.find((place) => place.id === originId)!;
      return towns
        .filter((place) => travel(origin, place) <= radius)
        .map((place) => `${place.id}@${day + travel(origin, place)}`)
        .sort();
    };
    const arrivalsOf = (packetId: number): string[] =>
      (
        db.prepare('SELECT place_id, day FROM world_packet_arrival WHERE packet_id = ?').all(packetId) as Array<{
          place_id: number;
          day: number;
        }>
      )
        .map((row) => `${row.place_id}@${row.day}`)
        .sort();

    // The packets the ticked world sent; a held agenda that went ahead anyway spreads its news without limit.
    const packets = db
      .prepare(
        `SELECT p.id, p.origin_place_id, e.day, e.severity FROM world_packet p JOIN world_event e ON e.id = p.event_id
          WHERE p.campaign_id = ?`,
      )
      .all(campaignId) as Array<{ id: number; origin_place_id: number; day: number; severity: number }>;
    expect(packets.length).toBeGreaterThan(100);
    for (const packet of packets) {
      const stored = arrivalsOf(packet.id);
      const bySeverity = unfiltered(packet.origin_place_id, packet.day, news.newsRadiusDays(packet.severity));
      if (stored.length !== bySeverity.length) {
        expect(stored, `packet ${packet.id}`).toEqual(unfiltered(packet.origin_place_id, packet.day, Infinity));
      } else {
        expect(stored, `packet ${packet.id}`).toEqual(bySeverity);
      }
    }

    // Every settlement as an origin at every severity, rolled back afterwards.
    const template = store.listEvents(db, campaignId)[0]!;
    db.exec('SAVEPOINT prefilter');
    try {
      for (const origin of towns) {
        for (const severity of [1, 2, 3, 4, 5]) {
          const event = { ...template, place_id: origin.id, severity, visibility: 'public' as const };
          const { packet_id } = news.emitPacket(db, campaignId, event);
          expect(arrivalsOf(packet_id!), `${origin.name} severity ${severity}`).toEqual(
            unfiltered(origin.id, event.day, news.newsRadiusDays(severity)),
          );
        }
      }
    } finally {
      db.exec('ROLLBACK TO prefilter');
      db.exec('RELEASE prefilter');
    }
  }, 60000);
});
