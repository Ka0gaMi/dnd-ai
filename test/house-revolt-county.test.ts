// A house that wins a revolt takes its seat's county as a lordship sworn to the same crown, and a house holding two
// counties becomes that crown's vassal realm; a vassal realm's win and a lost revolt keep their old effects.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import type { ComputedCounties, ComputedHierarchy, ComputedRealms } from '../src/core/politics-types.js';
import type { WorldAgenda, WorldEvent, WorldFaction } from '../src/core/world-store.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;

const DAY = 1000;
const SEED = 11;

let db: Db;
let openDb: (typeof import('../src/db/connection.js'))['openDb'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let region: typeof import('../src/core/region.js');
let politicsStore: typeof import('../src/core/politics-store.js');
let store: typeof import('../src/core/world-store.js');
let resolve: typeof import('../src/core/world-resolve.js');
let placeState: typeof import('../src/core/world-place-state.js');
let thwart: typeof import('../src/core/world-thwart.js');
let faithStore: typeof import('../src/core/world-faith-store.js');
let seeding: typeof import('../src/core/world-seed.js');
let worldBriefing: (typeof import('../src/core/world-briefing.js'))['worldBriefing'];
let worldDigest: (typeof import('../src/core/world-digest.js'))['worldDigest'];

beforeAll(async () => {
  // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world fresh on the real one.
  vi.resetModules();
  ({ openDb } = await import('../src/db/connection.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  region = await import('../src/core/region.js');
  politicsStore = await import('../src/core/politics-store.js');
  store = await import('../src/core/world-store.js');
  resolve = await import('../src/core/world-resolve.js');
  placeState = await import('../src/core/world-place-state.js');
  thwart = await import('../src/core/world-thwart.js');
  faithStore = await import('../src/core/world-faith-store.js');
  seeding = await import('../src/core/world-seed.js');
  ({ worldBriefing } = await import('../src/core/world-briefing.js'));
  ({ worldDigest } = await import('../src/core/world-digest.js'));
});

beforeEach(() => {
  db = openDb(':memory:');
});

interface Crowns {
  campaignId: number;
  places: Record<'ficengwind' | 'hotfield' | 'redham' | 'southernLanding' | 'stormcourtby', number>;
  /** Ficengwind and Redham are sovereign kingdoms; Stormcourtby is a lordship sworn to Ficengwind. */
  realms: { ficengwind: number; redham: number; stormcourtby: number };
  counties: { ficengwind: number; hotfield: number; southernLanding: number; redham: number; stormcourtby: number };
  duchies: { crownFicengwind: number; hotfield: number };
  crownF: WorldFaction;
  crownR: WorldFaction;
  lordS: WorldFaction;
  houseH: WorldFaction;
}

let names = 0;

function faction(campaignId: number, extra: Partial<Omit<WorldFaction, 'id'>> = {}): WorldFaction {
  names += 1;
  return store.insertFaction(db, campaignId, {
    name: `Test Faction ${names}`,
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

/** A finished revolt, its clock full and its portent fired, ready to resolve. */
function revolt(campaignId: number, rebel: WorldFaction, liege: WorldFaction): WorldAgenda {
  return store.insertAgenda(db, campaignId, {
    faction_id: rebel.id,
    template: 'revolt',
    target_kind: 'rival_faction',
    target_id: liege.id,
    target_name: liege.name,
    clock_size: 8,
    clock_filled: 8,
    portents: [{ text: 'Something stirs.', fired_day: DAY - 10, heard: false }],
    status: 'active',
    started_day: DAY - 50,
  });
}

function win(campaignId: number, finished: WorldAgenda): WorldEvent {
  return resolve.resolveAgenda(db, campaignId, finished, DAY, SEED).event;
}

function factionNow(campaignId: number, id: number): WorldFaction {
  return store.listFactions(db, campaignId, { includeEnded: true }).find((entry) => entry.id === id)!;
}

function realmOf(campaignId: number, countyId: number) {
  const politics = politicsStore.getPolitics(db, campaignId)!;
  const county = politics.counties.find((entry) => entry.id === countyId)!;
  return politics.realms.find((realm) => realm.id === county.realm_id)!;
}

/**
 * Ficengwind holds its capital, Hotfield (a duchy seat held by a house) and Southern Landing in its crownlands;
 * Redham is a one-county kingdom and Stormcourtby a lordship sworn to Ficengwind.
 */
function crowns(): Crowns {
  const campaignId = createCampaign(db, { name: `The Rebel Houses ${names}`, story_shape: 'sandbox' }).campaign_id;
  region.importRegion(db, campaignId, safe, { source: 'generated' });
  const placeId = (name: string): number => region.findPlace(db, campaignId, name)!.id;
  const places = {
    ficengwind: placeId('Ficengwind'),
    hotfield: placeId('Hotfield'),
    redham: placeId('Redham'),
    southernLanding: placeId('Southern Landing'),
    stormcourtby: placeId('Stormcourtby'),
  };
  const counties: ComputedCounties = {
    counties: [
      { name: 'County of Ficengwind', seat_place_id: places.ficengwind, seat_kind: 'city', hexes: ['q0_r0', 'q4_r11'], village_place_ids: [], component: 0 },
      { name: 'County of Hotfield', seat_place_id: places.hotfield, seat_kind: 'town', hexes: ['q1_r0', 'q12_r11'], village_place_ids: [], component: 0 },
      { name: 'County of Southern Landing', seat_place_id: places.southernLanding, seat_kind: 'town', hexes: ['q2_r0', 'q11_r14'], village_place_ids: [], component: 0 },
      { name: 'County of Redham', seat_place_id: places.redham, seat_kind: 'town', hexes: ['q3_r0', 'q6_r8'], village_place_ids: [], component: 0 },
      { name: 'Lordship of Stormcourtby', seat_place_id: places.stormcourtby, seat_kind: 'castle', hexes: ['q4_r0', 'q9_r5'], village_place_ids: [], component: 0 },
    ],
    edges: [],
  };
  const realms: ComputedRealms = {
    realms: [
      { name: 'Kingdom of Ficengwind', kind: 'kingdom', capital_place_id: places.ficengwind, off_map: false, liege: null },
      { name: 'Kingdom of Redham', kind: 'kingdom', capital_place_id: places.redham, off_map: false, liege: null },
      { name: 'Lordship of Stormcourtby', kind: 'lordship', capital_place_id: places.stormcourtby, off_map: false, liege: 0 },
    ],
    county_realm: [0, 0, 0, 1, 2],
  };
  const hierarchy: ComputedHierarchy = {
    duchies: [
      { name: 'Crownlands of Ficengwind', realm: 0, seat_place_id: places.ficengwind, county_indexes: [0, 2], demesne: true, joined_how: 'core' },
      { name: 'Duchy of Hotfield', realm: 0, seat_place_id: places.hotfield, county_indexes: [1], demesne: false, joined_how: 'core' },
    ],
    county_duchy: [0, 1, 0, null, null],
    march_counties: [],
    claims: [],
  };
  const stored = politicsStore.saveHierarchy(db, campaignId, { counties, realms, hierarchy });
  const [realmF, realmR, realmS] = stored.realms.map((realm) => realm.id) as [number, number, number];
  const [cF, cH, cSL, cR, cS] = stored.counties.map((county) => county.id) as [number, number, number, number, number];
  const [dF, dH] = stored.duchies.map((duchy) => duchy.id) as [number, number];
  return {
    campaignId,
    places,
    realms: { ficengwind: realmF, redham: realmR, stormcourtby: realmS },
    counties: { ficengwind: cF, hotfield: cH, southernLanding: cSL, redham: cR, stormcourtby: cS },
    duchies: { crownFicengwind: dF, hotfield: dH },
    crownF: faction(campaignId, { name: 'Kingdom of Ficengwind', type: 'realm', realm_id: realmF, county_id: cF, place_id: places.ficengwind, resources: 5 }),
    crownR: faction(campaignId, { name: 'Kingdom of Redham', type: 'realm', realm_id: realmR, county_id: cR, place_id: places.redham, resources: 5 }),
    lordS: faction(campaignId, { name: 'Lordship of Stormcourtby', type: 'realm', realm_id: realmS, county_id: cS, place_id: places.stormcourtby }),
    houseH: faction(campaignId, { name: 'Ducal House of Hotfield', type: 'house', realm_id: realmF, county_id: cH, place_id: places.hotfield }),
  };
}

describe('a house that wins a revolt', () => {
  it("takes its seat's county as a lordship sworn to the same crown, beside the concessions", () => {
    const world = crowns();
    const { campaignId, counties, realms } = world;
    const event = win(campaignId, revolt(campaignId, world.houseH, world.crownF));

    const holding = realmOf(campaignId, counties.hotfield);
    expect(event.text).toBe('Ducal House of Hotfield wrings concessions from Kingdom of Ficengwind and takes Hotfield as a lordship under it');
    expect(event.effects).toEqual({
      resources: 1,
      target_resources: -1,
      outcome: 'concessions',
      county_id: counties.hotfield,
      from_realm_id: realms.ficengwind,
      to_realm_id: holding.id,
      house_id: world.houseH.id,
      duchy_unseated: world.duchies.hotfield,
      promoted: false,
    });
    expect(holding).toMatchObject({
      name: 'Lordship of Hotfield',
      kind: 'lordship',
      capital_place_id: world.places.hotfield,
      liege_realm_id: realms.ficengwind,
      county_ids: [counties.hotfield],
    });

    const politics = politicsStore.getPolitics(db, campaignId)!;
    expect(politics.counties.find((county) => county.id === counties.hotfield)!.duchy_id).toBeNull();
    // The duchy the county seated is left vacant, as when a county is taken in war.
    expect(politics.duchies.find((duchy) => duchy.id === world.duchies.hotfield)!.seat_place_id).toBeNull();
    expect(politics.realms.find((realm) => realm.id === realms.ficengwind)!.county_ids).toEqual([
      counties.ficengwind,
      counties.southernLanding,
    ]);
    // The crown keeps no claim against its own vassal.
    expect(politics.claims).toEqual([]);

    // One county keeps it a house of the crown, now one county richer and the crown one resource poorer.
    expect(factionNow(campaignId, world.houseH.id)).toMatchObject({
      type: 'house',
      realm_id: realms.ficengwind,
      resources: world.houseH.resources + 1,
    });
    expect(factionNow(campaignId, world.crownF.id).resources).toBe(world.crownF.resources - 1);
  });

  it('becomes a vassal realm of that crown once it holds two counties', () => {
    const world = crowns();
    const { campaignId, counties, realms } = world;
    const first = placeState.transferCountyToHouse(db, campaignId, counties.southernLanding, world.houseH.id);
    expect(first).toMatchObject({ county_id: counties.southernLanding, duchy_unseated: null, promoted: false });
    expect(factionNow(campaignId, world.houseH.id).type).toBe('house');

    const event = win(campaignId, revolt(campaignId, world.houseH, world.crownF));

    expect(event.effects).toMatchObject({
      outcome: 'concessions',
      county_id: counties.hotfield,
      to_realm_id: first.to_realm_id,
      promoted: true,
    });
    const holding = realmOf(campaignId, counties.hotfield);
    expect(holding).toMatchObject({
      id: first.to_realm_id,
      liege_realm_id: realms.ficengwind,
      county_ids: [counties.hotfield, counties.southernLanding],
    });
    expect(factionNow(campaignId, world.houseH.id)).toMatchObject({ type: 'realm', realm_id: holding.id });
    expect(realmOf(campaignId, counties.ficengwind).county_ids).toEqual([counties.ficengwind]);

    // As a vassal realm it now goes free if it wins against the crown again.
    const freed = win(campaignId, revolt(campaignId, factionNow(campaignId, world.houseH.id), world.crownF));
    expect(freed.effects).toMatchObject({ outcome: 'independence', realm_id: holding.id, former_liege_realm_id: realms.ficengwind });
  });

  it('takes nothing from a crown it was carried away from', () => {
    const world = crowns();
    const { campaignId, counties, realms } = world;
    // Redham takes Hotfield in war, so the house now serves Redham; a revolt against Ficengwind is all it has left.
    placeState.transferCounty(db, campaignId, counties.hotfield, realms.redham);
    db.prepare('UPDATE world_faction SET realm_id = ? WHERE id = ?').run(realms.redham, world.houseH.id);
    const before = politicsStore.getPolitics(db, campaignId);

    const event = win(campaignId, revolt(campaignId, factionNow(campaignId, world.houseH.id), world.crownF));

    expect(event.effects).toEqual({ resources: 1, target_resources: -1, outcome: 'concessions' });
    expect(politicsStore.getPolitics(db, campaignId)).toEqual(before);
  });

  it('keeps only the concessions when its county is the crown capital', () => {
    const world = crowns();
    const { campaignId, counties, realms } = world;
    const courtiers = faction(campaignId, { realm_id: realms.ficengwind, county_id: counties.ficengwind, place_id: world.places.ficengwind });
    const before = politicsStore.getPolitics(db, campaignId);

    const event = win(campaignId, revolt(campaignId, courtiers, world.crownF));

    expect(event.effects).toMatchObject({ outcome: 'concessions', refused: expect.stringMatching(/capital county/) });
    expect(event.text).toBe(`${courtiers.name} wrings concessions from Kingdom of Ficengwind`);
    expect(politicsStore.getPolitics(db, campaignId)).toEqual(before);
    expect(factionNow(campaignId, courtiers.id)).toMatchObject({ type: 'house', resources: courtiers.resources + 1 });
  });
});

describe('a revolt that moves no county', () => {
  it('still frees a vassal realm from its liege', () => {
    const world = crowns();
    const { campaignId, realms } = world;
    const before = politicsStore.getPolitics(db, campaignId)!;

    const event = win(campaignId, revolt(campaignId, world.lordS, world.crownF));

    expect(event.text).toBe('Lordship of Stormcourtby throws off the rule of Kingdom of Ficengwind');
    expect(event.effects).toMatchObject({ outcome: 'independence', realm_id: realms.stormcourtby, former_liege_realm_id: realms.ficengwind });
    const after = politicsStore.getPolitics(db, campaignId)!;
    expect(after.realms.find((realm) => realm.id === realms.stormcourtby)!.liege_realm_id).toBeNull();
    expect(after.counties).toEqual(before.counties);
    expect(after.realms.map((realm) => realm.id)).toEqual(before.realms.map((realm) => realm.id));
  });

  it('changes nothing on the map when the house loses', () => {
    const world = crowns();
    const { campaignId } = world;
    const before = politicsStore.getPolitics(db, campaignId);
    const lost = revolt(campaignId, world.houseH, world.crownF);

    thwart.thwartAgenda(db, campaignId, lost.id, 'The crown hangs its ringleaders.', DAY);

    expect(politicsStore.getPolitics(db, campaignId)).toEqual(before);
    expect(factionNow(campaignId, world.houseH.id)).toMatchObject({ type: 'house', realm_id: world.realms.ficengwind });
  });
});

describe("a house's lordship and its faith", () => {
  it("keeps its seat's faith and stays out of its crown's church's conversions", () => {
    const world = crowns();
    const { campaignId, places } = world;
    const dawn = faithStore.insertFaith(db, campaignId, {
      name: 'The Dawnmother',
      aspect: 'dawn',
      symbol: 'a rising sun',
      head_place_id: null,
      fervor: 50,
      heresy_of: null,
      last_heresy_day: null,
      created_day: DAY,
    }).id;
    const temple = faction(campaignId, { name: 'Temple of the Dawn', type: 'church', realm_id: world.realms.ficengwind, place_id: places.ficengwind });
    faithStore.setFactionFaith(db, campaignId, temple.id, dawn, 'strong');
    expect(placeState.settlementFaithId(db, campaignId, places.hotfield)).toBe(dawn);

    win(campaignId, revolt(campaignId, world.houseH, world.crownF));

    expect(placeState.settlementFaithId(db, campaignId, places.hotfield)).toBe(dawn);
    const conversions: WorldAgenda[] = [];
    for (let salt = 1; salt <= 40; salt += 1) {
      const next = seeding.pickAgenda(db, campaignId, temple, DAY + 1, SEED, salt);
      if (next === null) continue;
      if (next.template === 'conversion') conversions.push(next);
      store.updateAgenda(db, campaignId, next.id, { status: 'abandoned' });
    }
    // The church still preaches beyond its crown's lands, just never in its vassal's seat.
    expect(conversions.length).toBeGreaterThan(0);
    expect(conversions.map((agenda) => agenda.target_id)).not.toContain(places.hotfield);
  });
});

describe("a house's county in the DM's transfer lists", () => {
  it('shows a house revolt that took land, but not an independence win or a refused house revolt', () => {
    const world = crowns();
    const { campaignId, counties, realms } = world;
    const today = store.currentGameDay(db, campaignId);
    store.saveWorldState(db, campaignId, { seed: 7, last_tick_day: today, quiet_until_day: 0 });
    const courtiers = faction(campaignId, { realm_id: realms.ficengwind, county_id: counties.ficengwind, place_id: world.places.ficengwind });
    const resolveToday = (finished: WorldAgenda): WorldEvent => resolve.resolveAgenda(db, campaignId, finished, today, SEED).event;

    expect(resolveToday(revolt(campaignId, world.houseH, world.crownF)).effects).toMatchObject({ county_id: counties.hotfield });
    expect(resolveToday(revolt(campaignId, world.lordS, world.crownF)).effects).toMatchObject({ outcome: 'independence' });
    expect(resolveToday(revolt(campaignId, courtiers, world.crownF)).effects).toMatchObject({ refused: expect.any(String) });

    const line = 'County of Hotfield passes from Kingdom of Ficengwind to Lordship of Hotfield';
    const block = worldBriefing(db, campaignId, null);
    expect(block).toContain(`Recent county transfers: ${line} (day ${today})`);
    expect(block.match(/passes from/g)).toHaveLength(1);

    const digest = worldDigest(db, campaignId);
    expect(digest.data.transfers).toEqual([
      { day: today, county: 'County of Hotfield', from: 'Kingdom of Ficengwind', to: 'Lordship of Hotfield' },
    ]);
    expect(digest.text).toContain(`- day ${today}: ${line}`);
  });
});
