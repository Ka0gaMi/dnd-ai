// Cleanup found while reviewing the win state: a rewind that puts liege links and duchy seats back, a
// destroyed brood's sieges lifted, and a picker that ignores cleared dangers and ruined or besieged towns.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import type { ComputedCounties, ComputedHierarchy, ComputedRealms } from '../src/core/politics-types.js';
import type { WorldAgenda, WorldFaction } from '../src/core/world-store.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8')) as unknown;

const DAY = 500;

let db: Db;
let openDb: (typeof import('../src/db/connection.js'))['openDb'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let region: typeof import('../src/core/region.js');
let politicsStore: typeof import('../src/core/politics-store.js');
let store: typeof import('../src/core/world-store.js');
let placeState: typeof import('../src/core/world-place-state.js');
let resolve: typeof import('../src/core/world-resolve.js');
let thwart: typeof import('../src/core/world-thwart.js');
let rewind: typeof import('../src/core/rewind.js');
let seed: typeof import('../src/core/world-seed.js');

beforeAll(async () => {
  // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world fresh on the real one.
  vi.resetModules();
  ({ openDb } = await import('../src/db/connection.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  region = await import('../src/core/region.js');
  politicsStore = await import('../src/core/politics-store.js');
  store = await import('../src/core/world-store.js');
  placeState = await import('../src/core/world-place-state.js');
  resolve = await import('../src/core/world-resolve.js');
  thwart = await import('../src/core/world-thwart.js');
  rewind = await import('../src/core/rewind.js');
  seed = await import('../src/core/world-seed.js');
});

beforeEach(() => {
  db = openDb(':memory:');
});

let names = 0;

function withRegion(realm: unknown): number {
  const campaignId = createCampaign(db, { name: `Cleanup ${names}`, story_shape: 'structured' }).campaign_id;
  region.importRegion(db, campaignId, realm, { source: 'generated' });
  return campaignId;
}

function placeId(campaignId: number, name: string): number {
  return region.findPlace(db, campaignId, name)!.id;
}

function faction(campaignId: number, extra: Partial<Omit<WorldFaction, 'id'>> = {}): WorldFaction {
  names += 1;
  return store.insertFaction(db, campaignId, {
    name: `Cleanup Faction ${names}`,
    type: 'house',
    realm_id: null,
    county_id: null,
    place_id: null,
    secrecy: 'open',
    resources: 3,
    capacities: {},
    created_day: DAY - 100,
    ...extra,
  });
}

function agenda(
  campaignId: number,
  owner: WorldFaction,
  extra: Partial<Omit<WorldAgenda, 'id'>> & Pick<WorldAgenda, 'template' | 'target_kind' | 'target_id' | 'target_name'>,
): WorldAgenda {
  return store.insertAgenda(db, campaignId, {
    faction_id: owner.id,
    clock_size: 6,
    clock_filled: 6,
    portents: [{ text: 'Something stirs.', fired_day: DAY - 10, heard: false }],
    status: 'active',
    started_day: DAY - 50,
    ...extra,
  });
}

function win(campaignId: number, finished: WorldAgenda, day = DAY): void {
  resolve.resolveAgenda(db, campaignId, finished, day, 7);
}

/** Abandons every agenda so a faction under test starts with an empty field. */
function abandonAll(campaignId: number): void {
  for (const entry of store.listAgendas(db, campaignId)) {
    store.updateAgenda(db, campaignId, entry.id, { status: 'abandoned' });
  }
}

/** Picks for one faction over many salts, abandoning each pick so the next call starts fresh. */
function pickMany(campaignId: number, factionId: number, day: number, salts: number): WorldAgenda[] {
  const picks: WorldAgenda[] = [];
  for (let salt = 1; salt <= salts; salt += 1) {
    const owner = store.listFactions(db, campaignId).find((entry) => entry.id === factionId);
    if (!owner) break;
    const next = seed.pickAgenda(db, campaignId, owner, day, 7, salt);
    if (next === null) continue;
    picks.push(next);
    store.updateAgenda(db, campaignId, next.id, { status: 'abandoned' });
  }
  return picks;
}

/** Renames the dangerous island's two dungeons as lairs, since only a lair-named danger holds a brood. */
function lairDangers(campaignId: number): void {
  const rename = db.prepare('UPDATE world_place SET name = ? WHERE campaign_id = ? AND name = ?');
  rename.run('Nest Of The Vampire Queen', campaignId, 'Ziggurat Of The Vampire Queen');
  rename.run('Hidden Den', campaignId, 'Hidden Keep');
}

/** A kingdom and a lordship sworn to it, with the lordship's seat in a duchy of the kingdom. */
function twoRealmWorld(): { campaignId: number; ficengwind: number; stormcourtby: number } {
  const campaignId = withRegion(safe);
  const places = {
    ficengwind: placeId(campaignId, 'Ficengwind'),
    hotfield: placeId(campaignId, 'Hotfield'),
    stormcourtby: placeId(campaignId, 'Stormcourtby'),
  };
  const counties: ComputedCounties = {
    counties: [
      { name: 'County of Ficengwind', seat_place_id: places.ficengwind, seat_kind: 'city', hexes: ['q0_r0', 'q4_r11'], village_place_ids: [], component: 0 },
      { name: 'County of Hotfield', seat_place_id: places.hotfield, seat_kind: 'town', hexes: ['q1_r0', 'q12_r11'], village_place_ids: [], component: 0 },
      { name: 'Lordship of Stormcourtby', seat_place_id: places.stormcourtby, seat_kind: 'castle', hexes: ['q2_r0', 'q6_r8'], village_place_ids: [], component: 0 },
    ],
    edges: [],
  };
  const realms: ComputedRealms = {
    realms: [
      { name: 'Kingdom of Ficengwind', kind: 'kingdom', capital_place_id: places.ficengwind, off_map: false, liege: null },
      { name: 'Lordship of Stormcourtby', kind: 'lordship', capital_place_id: places.stormcourtby, off_map: false, liege: 0 },
    ],
    county_realm: [0, 0, 1],
  };
  const hierarchy: ComputedHierarchy = {
    duchies: [
      { name: 'Duchy of Hotfield', realm: 0, seat_place_id: places.hotfield, county_indexes: [1], demesne: false, joined_how: 'core' },
    ],
    county_duchy: [null, 0, null],
    march_counties: [],
    claims: [],
  };
  const stored = politicsStore.saveHierarchy(db, campaignId, { counties, realms, hierarchy });
  const [ficengwind, stormcourtby] = stored.realms.map((realm) => realm.id) as [number, number];
  return { campaignId, ficengwind, stormcourtby };
}

describe('destroying a brood lifts its sieges', () => {
  function besiegingBrood(): { campaignId: number; brood: WorldFaction; target: number; keep: number } {
    const campaignId = withRegion(dangerous);
    const frostcot = placeId(campaignId, 'Frostcot');
    const keep = placeId(campaignId, 'Hidden Keep');
    const brood = faction(campaignId, { type: 'monsters', place_id: keep, resources: 2 });
    win(
      campaignId,
      agenda(campaignId, brood, {
        template: 'monsters_grow',
        target_kind: 'settlement',
        target_id: frostcot,
        target_name: 'Frostcot',
      }),
    );
    return { campaignId, brood, target: frostcot, keep };
  }

  it('via destroyFaction', () => {
    const { campaignId, brood, target } = besiegingBrood();
    expect(placeState.getPlaceState(db, campaignId, target, DAY)?.state).toBe('besieged');

    thwart.destroyFaction(db, campaignId, brood.id, 'wiped out by the party', DAY + 5);

    expect(store.listFactions(db, campaignId, { includeEnded: true }).find((entry) => entry.id === brood.id)!.ended_day).toBe(
      DAY + 5,
    );
    expect(placeState.getPlaceState(db, campaignId, target, DAY + 5)).toBeNull();
  });

  it('via clearDanger', () => {
    const { campaignId, brood, target, keep } = besiegingBrood();
    expect(placeState.getPlaceState(db, campaignId, target, DAY)?.state).toBe('besieged');

    const destroyed = thwart.clearDanger(db, campaignId, keep, DAY + 5);

    expect(destroyed.map((entry) => entry.faction.id)).toEqual([brood.id]);
    expect(placeState.getPlaceState(db, campaignId, target, DAY + 5)).toBeNull();
  });
});

describe('a cleared danger is never targeted', () => {
  it('drops a danger whose every brood has ended', () => {
    const campaignId = withRegion(dangerous);
    lairDangers(campaignId);
    seed.ensureWorld(db, campaignId);
    abandonAll(campaignId);

    const frostcot = placeId(campaignId, 'Frostcot');
    const ziggurat = placeId(campaignId, 'Nest Of The Vampire Queen');
    const hiddenDen = placeId(campaignId, 'Hidden Den');
    // A hunter at Frostcot is nearer the ziggurat than the den, so it hunts the ziggurat while a brood lairs there.
    const hunters = faction(campaignId, { type: 'house', place_id: frostcot });

    const reachable = pickMany(campaignId, hunters.id, DAY, 80).filter((entry) => entry.template === 'hunt_monster');
    expect(reachable.some((entry) => entry.target_id === ziggurat)).toBe(true);

    thwart.clearDanger(db, campaignId, ziggurat, DAY);

    const later = pickMany(campaignId, hunters.id, DAY + 1, 80).filter((entry) => entry.template === 'hunt_monster');
    expect(later.length).toBeGreaterThan(0);
    for (const entry of later) expect(entry.target_id).not.toBe(ziggurat);
    expect(later.some((entry) => entry.target_id === hiddenDen)).toBe(true);
  });
});

describe('a settlement in a state is not targeted', () => {
  it('never sends a raid at a ruined or besieged settlement', () => {
    const campaignId = withRegion(dangerous);
    const frostcot = placeId(campaignId, 'Frostcot');
    const crimsonWharf = placeId(campaignId, 'Crimson Wharf');
    const gang = faction(campaignId, { type: 'gang', place_id: crimsonWharf, secrecy: 'discreet' });
    const raids = (): WorldAgenda[] => pickMany(campaignId, gang.id, DAY, 60).filter((entry) => entry.template === 'raid');

    // Frostcot is the gang's only reachable settlement, so while it is whole a raid on it is possible.
    expect(raids().some((entry) => entry.target_id === frostcot)).toBe(true);

    placeState.setPlaceState(db, campaignId, frostcot, DAY, { state: 'ruined' });
    expect(raids()).toEqual([]);

    placeState.setPlaceState(db, campaignId, frostcot, DAY, { state: 'besieged' });
    expect(raids()).toEqual([]);
  });

  it('never sends monsters_grow at a ruined settlement, but still at a besieged one', () => {
    const campaignId = withRegion(dangerous);
    lairDangers(campaignId);
    seed.ensureWorld(db, campaignId);
    abandonAll(campaignId);

    const brood = store.listFactions(db, campaignId).find((entry) => entry.type === 'monsters')!;
    const grows = (): WorldAgenda[] => pickMany(campaignId, brood.id, DAY, 60).filter((entry) => entry.template === 'monsters_grow');

    const whole = grows();
    expect(whole.length).toBeGreaterThan(0);
    const target = whole[0]!.target_id!;

    placeState.setPlaceState(db, campaignId, target, DAY, { state: 'ruined' });
    expect(grows().some((entry) => entry.target_id === target)).toBe(false);

    placeState.setPlaceState(db, campaignId, target, DAY, { state: 'besieged' });
    expect(grows().some((entry) => entry.target_id === target)).toBe(true);
  });
});

describe('an old checkpoint without the hierarchy part', () => {
  it('still restores counties and leaves liege links and duchy seats as they are', () => {
    const { campaignId, stormcourtby } = twoRealmWorld();
    const checkpointId = rewind.captureCheckpoint(db, campaignId, null);
    const stored = db.prepare('SELECT snapshot_json FROM checkpoint WHERE id = ?').get(checkpointId) as {
      snapshot_json: string;
    };
    const parsed = JSON.parse(stored.snapshot_json) as Record<string, unknown>;
    delete parsed.world_hierarchy;
    db.prepare('UPDATE checkpoint SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(parsed), checkpointId);

    const before = politicsStore.getPolitics(db, campaignId)!;
    const county = before.counties.find((entry) => entry.duchy_id !== null)!;
    const duchy = before.duchies.find((entry) => entry.seat_place_id === county.seat_place_id)!;

    db.prepare('UPDATE world_county SET realm_id = ? WHERE id = ?').run(stormcourtby, county.id);
    db.prepare('UPDATE world_realm SET liege_realm_id = NULL WHERE id = ?').run(stormcourtby);
    db.prepare('UPDATE world_duchy SET seat_place_id = NULL WHERE id = ?').run(duchy.id);

    rewind.rewindToCheckpoint(db, campaignId);

    const after = politicsStore.getPolitics(db, campaignId)!;
    expect(after.counties.find((entry) => entry.id === county.id)!.realm_id).toBe(county.realm_id);
    // The old checkpoint carries no link part, so a rewind leaves the liege and seat changes alone.
    expect(after.realms.find((entry) => entry.id === stormcourtby)!.liege_realm_id).toBeNull();
    expect(after.duchies.find((entry) => entry.id === duchy.id)!.seat_place_id).toBeNull();
  });
});
