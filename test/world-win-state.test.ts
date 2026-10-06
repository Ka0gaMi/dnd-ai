// What a won agenda leaves on the map: raided, besieged and ruined settlements, counties changing hands, a
// vassal going free, a converted town and a destroyed brood, with player-safe news and a rewind that undoes it.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import type { ComputedCounties, ComputedHierarchy, ComputedRealms } from '../src/core/politics-types.js';
import type { WorldAgenda, WorldEvent, WorldFaction } from '../src/core/world-store.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
const safe = fixture('realm-safe.json');
const dangerous = fixture('realm-dangerous.json');
const large = fixture('realm-large.json');

const DAY = 1000;
const SEED = 11;

let db: Db;
let openDb: (typeof import('../src/db/connection.js'))['openDb'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let region: typeof import('../src/core/region.js');
let politicsStore: typeof import('../src/core/politics-store.js');
let playerRegionMap: (typeof import('../src/core/region-view.js'))['playerRegionMap'];
let store: typeof import('../src/core/world-store.js');
let resolve: typeof import('../src/core/world-resolve.js');
let placeState: typeof import('../src/core/world-place-state.js');
let faithStore: typeof import('../src/core/world-faith-store.js');
let thwart: typeof import('../src/core/world-thwart.js');
let rewind: typeof import('../src/core/rewind.js');
let deliverNews: (typeof import('../src/core/world-news.js'))['deliverNews'];
let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let tickTo: (typeof import('../src/core/world-tick.js'))['tickTo'];

beforeAll(async () => {
  // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world fresh on the real one.
  vi.resetModules();
  ({ openDb } = await import('../src/db/connection.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  region = await import('../src/core/region.js');
  politicsStore = await import('../src/core/politics-store.js');
  ({ playerRegionMap } = await import('../src/core/region-view.js'));
  store = await import('../src/core/world-store.js');
  resolve = await import('../src/core/world-resolve.js');
  placeState = await import('../src/core/world-place-state.js');
  faithStore = await import('../src/core/world-faith-store.js');
  thwart = await import('../src/core/world-thwart.js');
  rewind = await import('../src/core/rewind.js');
  ({ deliverNews } = await import('../src/core/world-news.js'));
  ({ ensureWorld } = await import('../src/core/world-seed.js'));
  ({ tickTo } = await import('../src/core/world-tick.js'));
});

beforeEach(() => {
  db = openDb(':memory:');
});

interface BorderWars {
  campaignId: number;
  places: Record<'ficengwind' | 'hotfield' | 'redham' | 'southernLanding' | 'stormcourtby' | 'coldwood', number>;
  /** Ficengwind and Redham are sovereign kingdoms; Stormcourtby is a lordship sworn to Ficengwind. */
  realms: { ficengwind: number; redham: number; stormcourtby: number };
  counties: { ficengwind: number; hotfield: number; redham: number; southernLanding: number; stormcourtby: number };
  duchies: { crownFicengwind: number; hotfield: number; crownRedham: number };
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

/** A finished agenda, its clock full and every portent fired, ready to resolve. */
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

function win(campaignId: number, finished: WorldAgenda, day = DAY): WorldEvent {
  return resolve.resolveAgenda(db, campaignId, finished, day, SEED).event;
}

function factionNow(campaignId: number, id: number): WorldFaction {
  return store.listFactions(db, campaignId, { includeEnded: true }).find((entry) => entry.id === id)!;
}

function agendaNow(campaignId: number, id: number): WorldAgenda {
  return store.listAgendas(db, campaignId).find((entry) => entry.id === id)!;
}

function placeId(campaignId: number, name: string): number {
  return region.findPlace(db, campaignId, name)!.id;
}

/**
 * Two kingdoms in a row of counties (Ficengwind, Hotfield | Redham, Southern Landing) and a lordship sworn to
 * Ficengwind. Hotfield is a duchy's seat held by a house; Redham claims it weakly.
 */
function borderWars(): BorderWars {
  const campaignId = createCampaign(db, { name: `The Border Wars ${names}`, story_shape: 'sandbox' }).campaign_id;
  region.importRegion(db, campaignId, safe, { source: 'generated' });
  const places = {
    ficengwind: placeId(campaignId, 'Ficengwind'),
    hotfield: placeId(campaignId, 'Hotfield'),
    redham: placeId(campaignId, 'Redham'),
    southernLanding: placeId(campaignId, 'Southern Landing'),
    stormcourtby: placeId(campaignId, 'Stormcourtby'),
    coldwood: placeId(campaignId, 'Coldwood'),
  };
  const counties: ComputedCounties = {
    counties: [
      { name: 'County of Ficengwind', seat_place_id: places.ficengwind, seat_kind: 'city', hexes: ['q0_r0', 'q4_r11'], village_place_ids: [], component: 0 },
      { name: 'County of Hotfield', seat_place_id: places.hotfield, seat_kind: 'town', hexes: ['q1_r0', 'q12_r11'], village_place_ids: [], component: 0 },
      { name: 'County of Redham', seat_place_id: places.redham, seat_kind: 'town', hexes: ['q2_r0', 'q6_r8'], village_place_ids: [], component: 0 },
      { name: 'County of Southern Landing', seat_place_id: places.southernLanding, seat_kind: 'town', hexes: ['q3_r0', 'q11_r14'], village_place_ids: [], component: 0 },
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
    county_realm: [0, 0, 1, 1, 2],
  };
  const hierarchy: ComputedHierarchy = {
    duchies: [
      { name: 'Crownlands of Ficengwind', realm: 0, seat_place_id: places.ficengwind, county_indexes: [0], demesne: true, joined_how: 'core' },
      { name: 'Duchy of Hotfield', realm: 0, seat_place_id: places.hotfield, county_indexes: [1], demesne: false, joined_how: 'core' },
      { name: 'Crownlands of Redham', realm: 1, seat_place_id: places.redham, county_indexes: [2, 3], demesne: true, joined_how: 'core' },
    ],
    county_duchy: [0, 1, 2, 2, null],
    march_counties: [],
    claims: [{ county: 1, claimant_realm: 1, strength: 'weak', reason: 'inheritance' }],
  };
  const stored = politicsStore.saveHierarchy(db, campaignId, { counties, realms, hierarchy });
  const [realmF, realmR, realmS] = stored.realms.map((realm) => realm.id) as [number, number, number];
  const [cF, cH, cR, cSL, cS] = stored.counties.map((county) => county.id) as [number, number, number, number, number];
  const [dF, dH, dR] = stored.duchies.map((duchy) => duchy.id) as [number, number, number];
  return {
    campaignId,
    places,
    realms: { ficengwind: realmF, redham: realmR, stormcourtby: realmS },
    counties: { ficengwind: cF, hotfield: cH, redham: cR, southernLanding: cSL, stormcourtby: cS },
    duchies: { crownFicengwind: dF, hotfield: dH, crownRedham: dR },
    crownF: faction(campaignId, { name: 'Kingdom of Ficengwind', type: 'realm', realm_id: realmF, county_id: cF, place_id: places.ficengwind, resources: 5 }),
    crownR: faction(campaignId, { name: 'Kingdom of Redham', type: 'realm', realm_id: realmR, county_id: cR, place_id: places.redham, resources: 5 }),
    lordS: faction(campaignId, { name: 'Lordship of Stormcourtby', type: 'realm', realm_id: realmS, county_id: cS, place_id: places.stormcourtby }),
    houseH: faction(campaignId, { name: 'Ducal House of Hotfield', type: 'house', realm_id: realmF, county_id: cH, place_id: places.hotfield }),
  };
}

interface Lairs {
  campaignId: number;
  frostcot: number;
  crimsonWharf: number;
  keep: number;
  ziggurat: number;
}

/** The dangerous island, its two settlements and its two dungeons; no brood lairs there until a test adds one. */
function lairs(): Lairs {
  const campaignId = createCampaign(db, { name: `The Lairs ${names}`, story_shape: 'structured' }).campaign_id;
  region.importRegion(db, campaignId, dangerous, { source: 'generated' });
  return {
    campaignId,
    frostcot: placeId(campaignId, 'Frostcot'),
    crimsonWharf: placeId(campaignId, 'Crimson Wharf'),
    keep: placeId(campaignId, 'Hidden Keep'),
    ziggurat: placeId(campaignId, 'Ziggurat Of The Vampire Queen'),
  };
}

function addFaith(campaignId: number, name: string): number {
  return faithStore.insertFaith(db, campaignId, {
    name,
    aspect: 'dawn',
    symbol: 'a rising sun',
    head_place_id: null,
    fervor: 50,
    heresy_of: null,
    last_heresy_day: null,
    created_day: DAY,
  }).id;
}

function eventsOf(campaignId: number, kind: string): WorldEvent[] {
  return store.listEvents(db, campaignId).filter((event) => event.kind === kind);
}

describe('a raid', () => {
  it('leaves the settlement raided for RAIDED_DAYS, citing the win', () => {
    const { campaignId, places } = borderWars();
    const gang = faction(campaignId, { type: 'gang', place_id: places.redham, secrecy: 'discreet' });
    const event = win(
      campaignId,
      agenda(campaignId, gang, { template: 'raid', target_kind: 'settlement', target_id: places.hotfield, target_name: 'Hotfield' }),
    );

    expect(event.kind).toBe('agenda_won');
    expect(event.effects).toMatchObject({ outcome: 'raided', place_id: places.hotfield, state: 'raided' });
    expect(event.text).toBe(`${gang.name} raids Hotfield`);
    expect(placeState.getPlaceState(db, campaignId, places.hotfield, DAY)).toEqual({
      state: 'raided',
      until_day: DAY + placeState.RAIDED_DAYS,
      cause_event_id: event.id,
      updated_day: DAY,
    });
    expect(placeState.getPlaceState(db, campaignId, places.hotfield, DAY + placeState.RAIDED_DAYS)).toBeNull();
  });

  it('renews a raid but never eases a siege or a ruin', () => {
    const { campaignId, places } = borderWars();
    const gang = faction(campaignId, { type: 'gang', place_id: places.redham });
    const raid = (target: number, day: number): WorldEvent =>
      win(campaignId, agenda(campaignId, gang, { template: 'raid', target_kind: 'settlement', target_id: target, target_name: 'a town' }), day);

    raid(places.hotfield, DAY);
    const again = raid(places.hotfield, DAY + 30);
    expect(placeState.getPlaceState(db, campaignId, places.hotfield, DAY + 30)).toMatchObject({
      state: 'raided',
      until_day: DAY + 30 + placeState.RAIDED_DAYS,
      cause_event_id: again.id,
    });

    const ruin = placeState.setPlaceState(db, campaignId, places.southernLanding, DAY, { state: 'ruined' });
    const kept = raid(places.southernLanding, DAY + 30);
    expect(kept.effects).toMatchObject({ outcome: 'no_change' });
    expect(placeState.getPlaceState(db, campaignId, places.southernLanding, DAY + 30)).toEqual(ruin);
  });
});

describe('monsters growing', () => {
  it('besiege a settlement first and overrun it once it is already besieged or raided', () => {
    const { campaignId, places } = borderWars();
    const brood = faction(campaignId, { name: 'The Wolves of Coldwood', type: 'monsters', place_id: places.coldwood });
    const grow = (target: number, day: number): WorldEvent =>
      win(
        campaignId,
        agenda(campaignId, brood, { template: 'monsters_grow', target_kind: 'settlement', target_id: target, target_name: 'a town' }),
        day,
      );

    const siege = grow(places.redham, DAY);
    expect(siege.effects).toMatchObject({ outcome: 'besieged', state: 'besieged' });
    expect(siege.text).toBe('A monstrous brood lays siege to a town');
    expect(placeState.getPlaceState(db, campaignId, places.redham, DAY)).toMatchObject({
      state: 'besieged',
      until_day: DAY + placeState.BESIEGED_MAX_DAYS,
      cause_event_id: siege.id,
    });

    const ruin = grow(places.redham, DAY + 20);
    expect(ruin.effects).toMatchObject({ outcome: 'ruined', state: 'ruined' });
    expect(ruin.text).toBe('A monstrous brood overruns a town');
    expect(placeState.getPlaceState(db, campaignId, places.redham, DAY + 20)).toMatchObject({
      state: 'ruined',
      until_day: DAY + 20 + placeState.RUINED_DAYS,
      cause_event_id: ruin.id,
    });

    placeState.setPlaceState(db, campaignId, places.hotfield, DAY, { state: 'raided' });
    expect(grow(places.hotfield, DAY + 1).effects).toMatchObject({ outcome: 'ruined' });
  });
});

describe('an expansion', () => {
  it('takes the county for the winning realm, with its house, and leaves the duchy seated there seatless', () => {
    const world = borderWars();
    const { campaignId, counties, realms, duchies } = world;
    const event = win(
      campaignId,
      agenda(campaignId, world.crownR, {
        template: 'expand_territory',
        target_kind: 'neighbour_county',
        target_id: counties.hotfield,
        target_name: 'County of Hotfield',
        clock_size: 8,
        clock_filled: 8,
      }),
    );

    expect(event.text).toBe('Kingdom of Redham takes control of County of Hotfield');
    expect(event.effects).toMatchObject({
      outcome: 'county_transferred',
      county_id: counties.hotfield,
      from_realm_id: realms.ficengwind,
      to_realm_id: realms.redham,
      houses: [world.houseH.id],
      duchy_unseated: duchies.hotfield,
    });
    const politics = politicsStore.getPolitics(db, campaignId)!;
    const hotfield = politics.counties.find((county) => county.id === counties.hotfield)!;
    expect(hotfield).toMatchObject({ realm_id: realms.redham, duchy_id: null });
    expect(politics.duchies.find((duchy) => duchy.id === duchies.hotfield)!.seat_place_id).toBeNull();
    expect(factionNow(campaignId, world.houseH.id).realm_id).toBe(realms.redham);
    // The taker's claim lapses and the loser keeps a strong one.
    expect(politics.claims.filter((claim) => claim.county_id === counties.hotfield)).toEqual([
      { county_id: counties.hotfield, claimant_realm_id: realms.ficengwind, strength: 'strong', reason: 'recent conquest' },
    ]);
  });

  it('reads as a border victory that moves nothing when the county may not be taken', () => {
    const world = borderWars();
    const { campaignId, counties } = world;
    const before = politicsStore.getPolitics(db, campaignId);
    const event = win(
      campaignId,
      agenda(campaignId, world.crownR, {
        template: 'expand_territory',
        target_kind: 'neighbour_county',
        target_id: counties.ficengwind,
        target_name: 'County of Ficengwind',
      }),
    );

    expect(event.effects).toMatchObject({ outcome: 'border_victory', refused: expect.stringMatching(/capital county/) });
    expect(event.text).toBe('Kingdom of Redham wins a border fight over County of Ficengwind, but the county stays with its holder');
    expect(politicsStore.getPolitics(db, campaignId)).toEqual(before);
    expect(factionNow(campaignId, world.houseH.id).realm_id).toBe(world.realms.ficengwind);
  });

  it('redraws the party map without revealing a place they do not know', () => {
    const world = borderWars();
    const { campaignId, counties, places } = world;
    db.prepare('UPDATE world_place SET known_to_party = 1 WHERE id = ?').run(places.hotfield);
    const map = () =>
      playerRegionMap({
        view: region.getRegion(db, campaignId)!,
        hexes: politicsStore.regionHexes(db, campaignId)!,
        politics: politicsStore.getPolitics(db, campaignId),
        partyPlace: null,
      });
    const before = map();

    win(
      campaignId,
      agenda(campaignId, world.crownR, {
        template: 'expand_territory',
        target_kind: 'neighbour_county',
        target_id: counties.hotfield,
        target_name: 'County of Hotfield',
      }),
    );
    const after = map();

    expect(after.places).toEqual(before.places);
    expect(after.hexes.map((hex) => hex.id)).toEqual(before.hexes.map((hex) => hex.id));
    expect(after.counties.map((county) => county.name)).toEqual(before.counties.map((county) => county.name));
    // The duchy lost its seat with the county, so the map no longer names it.
    for (const duchy of after.duchies) expect(duchy.name).not.toBe('Duchy of Hotfield');
    for (const hidden of ['Southern Landing', 'Stormcourtby', 'Coldwood']) {
      expect(JSON.stringify(after)).not.toContain(hidden);
    }
  });
});

describe('a revolt', () => {
  it('frees a vassal realm from its liege', () => {
    const world = borderWars();
    const { campaignId, realms } = world;
    const event = win(
      campaignId,
      agenda(campaignId, world.lordS, {
        template: 'revolt',
        target_kind: 'rival_faction',
        target_id: world.crownF.id,
        target_name: world.crownF.name,
      }),
    );

    expect(event.text).toBe('Lordship of Stormcourtby throws off the rule of Kingdom of Ficengwind');
    expect(event.effects).toMatchObject({
      outcome: 'independence',
      realm_id: realms.stormcourtby,
      former_liege_realm_id: realms.ficengwind,
    });
    const realm = politicsStore.getPolitics(db, campaignId)!.realms.find((entry) => entry.id === realms.stormcourtby)!;
    expect(realm.liege_realm_id).toBeNull();
    expect(factionNow(campaignId, world.lordS.id).resources).toBe(world.lordS.resources + 1);
    expect(factionNow(campaignId, world.crownF.id).resources).toBe(world.crownF.resources - 1);
  });

  it("wins a house concessions from its crown and creates no realm", () => {
    const world = borderWars();
    const { campaignId } = world;
    const before = politicsStore.getPolitics(db, campaignId);
    const event = win(
      campaignId,
      agenda(campaignId, world.houseH, {
        template: 'revolt',
        target_kind: 'rival_faction',
        target_id: world.crownF.id,
        target_name: world.crownF.name,
      }),
    );

    expect(event.text).toBe('Ducal House of Hotfield wrings concessions from Kingdom of Ficengwind');
    expect(event.effects).toMatchObject({ outcome: 'concessions' });
    expect(politicsStore.getPolitics(db, campaignId)).toEqual(before);
    expect(factionNow(campaignId, world.houseH.id)).toMatchObject({ resources: world.houseH.resources + 1, realm_id: world.realms.ficengwind });
    expect(factionNow(campaignId, world.crownF.id).resources).toBe(world.crownF.resources - 1);
  });
});

describe('a conversion', () => {
  it("turns the settlement to the church's faith", () => {
    const world = borderWars();
    const { campaignId, places } = world;
    const dawn = addFaith(campaignId, 'The Dawnmother');
    const temple = faction(campaignId, { name: 'Temple of the Dawn', type: 'church', realm_id: world.realms.redham, place_id: places.redham });
    faithStore.setFactionFaith(db, campaignId, temple.id, dawn, 'strong');
    expect(placeState.settlementFaithId(db, campaignId, places.southernLanding)).toBe(dawn);
    const oldWays = addFaith(campaignId, 'The Old Ways');
    const rival = faction(campaignId, { name: 'Shrine of the Old Ways', type: 'church', place_id: places.ficengwind });
    faithStore.setFactionFaith(db, campaignId, rival.id, oldWays, 'minor');

    const event = win(
      campaignId,
      agenda(campaignId, rival, { template: 'conversion', target_kind: 'settlement', target_id: places.southernLanding, target_name: 'Southern Landing' }),
    );

    expect(event.text).toBe('Southern Landing turns to the faith of Shrine of the Old Ways');
    expect(event.effects).toMatchObject({ outcome: 'converted', place_id: places.southernLanding, faith_id: oldWays });
    expect(placeState.settlementFaithId(db, campaignId, places.southernLanding)).toBe(oldWays);
    expect(placeState.getPlaceState(db, campaignId, places.southernLanding, DAY)).toBeNull();
  });

  it('only wins converts for a church that holds no faith', () => {
    const { campaignId, places } = borderWars();
    const church = faction(campaignId, { name: 'A Wandering Order', type: 'church', place_id: places.redham });
    const event = win(
      campaignId,
      agenda(campaignId, church, { template: 'conversion', target_kind: 'settlement', target_id: places.hotfield, target_name: 'Hotfield' }),
    );

    expect(event.text).toBe('A Wandering Order wins converts in Hotfield');
    expect(event.effects).toMatchObject({ outcome: 'no_change' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_place_state WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 0 });
  });
});

describe('a hunt or crusade against a brood', () => {
  function brood(world: Lairs, resources: number): WorldFaction {
    return faction(world.campaignId, { name: 'The Beasts of Hidden Keep', type: 'monsters', place_id: world.keep, resources });
  }

  function strike(world: Lairs, template: 'hunt_monster' | 'crusade', day = DAY): WorldEvent {
    const hunters = faction(world.campaignId, { name: `Hunters ${names}`, place_id: world.frostcot });
    return win(
      world.campaignId,
      agenda(world.campaignId, hunters, { template, target_kind: 'danger', target_id: world.keep, target_name: 'Hidden Keep' }),
      day,
    );
  }

  it('destroys a brood whose resources reach 0 and lifts the siege it laid', () => {
    const world = lairs();
    const beasts = brood(world, 2);
    const siege = win(
      world.campaignId,
      agenda(world.campaignId, beasts, { template: 'monsters_grow', target_kind: 'settlement', target_id: world.frostcot, target_name: 'Frostcot' }),
    );
    expect(placeState.getPlaceState(db, world.campaignId, world.frostcot, DAY)?.cause_event_id).toBe(siege.id);
    db.prepare('UPDATE world_faction SET resources = 2 WHERE id = ?').run(beasts.id);

    const event = strike(world, 'hunt_monster', DAY + 5);

    expect(event.effects).toMatchObject({ outcome: 'brood_destroyed', destroyed_faction_id: beasts.id });
    expect(event.text).toMatch(/^Hunters \d+ hunters wipe out the beast in the wilds near /);
    expect(factionNow(world.campaignId, beasts.id).ended_day).toBe(DAY + 5);
    expect(eventsOf(world.campaignId, 'faction_destroyed').map((entry) => entry.faction_id)).toEqual([beasts.id]);
    expect(placeState.getPlaceState(db, world.campaignId, world.frostcot, DAY + 5)).toBeNull();
  });

  it('only strikes at a brood with resources left, and a crusade purges one at 0', () => {
    const world = lairs();
    const beasts = brood(world, 5);
    const blow = strike(world, 'crusade');
    expect(blow.effects).toMatchObject({ outcome: 'no_change' });
    expect(blow.text).toMatch(/crusaders strike at the beast in the wilds near /);
    expect(factionNow(world.campaignId, beasts.id)).toMatchObject({ resources: 3, ended_day: null });

    db.prepare('UPDATE world_faction SET resources = 1 WHERE id = ?').run(beasts.id);
    const purge = strike(world, 'crusade', DAY + 1);
    expect(purge.text).toMatch(/crusaders purge the beast in the wilds near /);
    expect(factionNow(world.campaignId, beasts.id).ended_day).toBe(DAY + 1);
  });
});

describe('the templates with no map state', () => {
  it('describe the deed and write no place, county or realm state', () => {
    const world = borderWars();
    const { campaignId, places } = world;
    const guild = faction(campaignId, { name: "Redham Merchants' Guild", type: 'guild', place_id: places.redham });
    const rivalGuild = faction(campaignId, { name: "Ficengwind Merchants' Guild", type: 'guild', place_id: places.ficengwind });
    const before = politicsStore.getPolitics(db, campaignId);

    const build = win(campaignId, agenda(campaignId, guild, { template: 'build', target_kind: 'own_seat', target_id: places.redham, target_name: 'Redham' }));
    const trade = win(
      campaignId,
      agenda(campaignId, guild, { template: 'trade_monopoly', target_kind: 'rival_faction', target_id: rivalGuild.id, target_name: rivalGuild.name }),
    );
    const feud = win(
      campaignId,
      agenda(campaignId, world.houseH, { template: 'feud', target_kind: 'rival_faction', target_id: world.crownR.id, target_name: world.crownR.name }),
    );

    expect(build.text).toBe("Redham Merchants' Guild pours its coin into works in Redham");
    expect(trade.text).toBe("Redham Merchants' Guild undercuts Ficengwind Merchants' Guild in every market");
    expect(feud.text).toBe('Ducal House of Hotfield humiliates Kingdom of Redham in open feud');
    for (const event of [build, trade, feud]) expect(event.effects).toMatchObject({ outcome: 'no_change' });
    expect(politicsStore.getPolitics(db, campaignId)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_place_state WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 0 });
  });
});

describe('an agenda whose target has ended', () => {
  it('is abandoned, not won, when its rival faction is gone', () => {
    const world = borderWars();
    const { campaignId } = world;
    const rival = faction(campaignId, { name: 'House of the Fallen', place_id: world.places.redham });
    const feud = agenda(campaignId, world.houseH, { template: 'feud', target_kind: 'rival_faction', target_id: rival.id, target_name: rival.name });
    store.updateFaction(db, campaignId, rival.id, { ended_day: DAY - 1 });

    const { event, next } = resolve.resolveAgenda(db, campaignId, feud, DAY, SEED);

    expect(agendaNow(campaignId, feud.id)).toMatchObject({ status: 'abandoned', resolved_day: DAY });
    expect(event).toMatchObject({ kind: 'agenda_abandoned', visibility: 'secret', severity: 1 });
    expect(next).toBeNull();
    expect(eventsOf(campaignId, 'agenda_won')).toEqual([]);
    expect(factionNow(campaignId, world.houseH.id).resources).toBe(world.houseH.resources);
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_packet WHERE event_id = ?').get(event.id)).toEqual({ n: 0 });
  });

  it('is abandoned when every brood at its target danger was cleared', () => {
    const world = lairs();
    const beasts = faction(world.campaignId, { type: 'monsters', place_id: world.keep, resources: 6 });
    const hunters = faction(world.campaignId, { place_id: world.frostcot });
    const hunt = agenda(world.campaignId, hunters, { template: 'hunt_monster', target_kind: 'danger', target_id: world.keep, target_name: 'Hidden Keep' });
    thwart.clearDanger(db, world.campaignId, world.keep, DAY - 1);

    const { event } = resolve.resolveAgenda(db, world.campaignId, hunt, DAY, SEED);

    expect(event.kind).toBe('agenda_abandoned');
    expect(agendaNow(world.campaignId, hunt.id).status).toBe('abandoned');
    expect(eventsOf(world.campaignId, 'agenda_won')).toEqual([]);
    expect(factionNow(world.campaignId, beasts.id).resources).toBe(6);
  });
});

describe('what the player hears of a win', () => {
  it('never names a danger site or a secret faction', () => {
    const world = lairs();
    const { campaignId } = world;
    const beasts = faction(campaignId, { name: 'The Beasts of Hidden Keep', type: 'monsters', place_id: world.keep, resources: 2 });
    const hidden = faction(campaignId, { name: 'The Ashen Hand', type: 'gang', secrecy: 'secret', place_id: world.crimsonWharf });
    const house = faction(campaignId, { name: 'House of the Wharf', place_id: world.crimsonWharf });

    win(campaignId, agenda(campaignId, beasts, { template: 'monsters_grow', target_kind: 'settlement', target_id: world.frostcot, target_name: 'Frostcot' }));
    const plot = win(
      campaignId,
      agenda(campaignId, hidden, { template: 'raid', target_kind: 'settlement', target_id: world.frostcot, target_name: 'Frostcot' }),
      DAY + 1,
    );
    win(
      campaignId,
      agenda(campaignId, house, { template: 'feud', target_kind: 'rival_faction', target_id: hidden.id, target_name: hidden.name }),
      DAY + 2,
    );
    db.prepare('UPDATE world_faction SET resources = 2 WHERE id = ?').run(beasts.id);
    win(
      campaignId,
      agenda(campaignId, house, { template: 'hunt_monster', target_kind: 'danger', target_id: world.keep, target_name: 'Hidden Keep' }),
      DAY + 3,
    );

    // The secret faction's own deed stays in the DM's ledger and sends no news.
    expect(plot.visibility).toBe('secret');
    expect(db.prepare('SELECT COUNT(*) AS n FROM world_packet WHERE event_id = ?').get(plot.id)).toEqual({ n: 0 });
    const packets = (
      db.prepare('SELECT text FROM world_packet WHERE campaign_id = ?').all(campaignId) as Array<{ text: string }>
    ).map((row) => row.text);
    const rumours = [world.frostcot, world.crimsonWharf].flatMap((place) =>
      deliverNews(db, campaignId, place, DAY + 60).map((entry) => entry.text),
    );
    const heard = [...packets, ...rumours];
    expect(packets.length).toBeGreaterThanOrEqual(4);
    expect(heard).toContainEqual(expect.stringContaining('a hidden rival'));
    for (const text of heard) {
      for (const name of ['Hidden Keep', 'Ziggurat Of The Vampire Queen', 'The Ashen Hand', 'Beasts of']) {
        expect(text).not.toContain(name);
      }
    }
  });
});

describe('a rewind', () => {
  it('puts back every state a win wrote', () => {
    const world = borderWars();
    const { campaignId, places, counties } = world;
    const gang = faction(campaignId, { type: 'gang', place_id: places.redham });
    const brood = faction(campaignId, { name: 'The Wolves of Coldwood', type: 'monsters', place_id: places.coldwood, resources: 1 });
    const church = faction(campaignId, { type: 'church', place_id: places.ficengwind });
    faithStore.setFactionFaith(db, campaignId, church.id, addFaith(campaignId, 'The Dawnmother'), 'strong');
    const house = faction(campaignId, { name: 'House of Southern Landing', realm_id: world.realms.redham, county_id: counties.southernLanding, place_id: places.southernLanding });
    const snapshot = () => ({
      politics: politicsStore.getPolitics(db, campaignId),
      places: db.prepare('SELECT * FROM world_place_state WHERE campaign_id = ? ORDER BY place_id').all(campaignId),
      factions: store.listFactions(db, campaignId, { includeEnded: true }),
      agendas: store.listAgendas(db, campaignId),
      events: store.listEvents(db, campaignId),
    });
    const finished = [
      agenda(campaignId, gang, { template: 'raid', target_kind: 'settlement', target_id: places.hotfield, target_name: 'Hotfield' }),
      agenda(campaignId, world.crownF, {
        template: 'expand_territory',
        target_kind: 'neighbour_county',
        target_id: counties.southernLanding,
        target_name: 'County of Southern Landing',
      }),
      agenda(campaignId, church, { template: 'conversion', target_kind: 'settlement', target_id: places.stormcourtby, target_name: 'Stormcourtby' }),
      agenda(campaignId, brood, { template: 'monsters_grow', target_kind: 'settlement', target_id: places.redham, target_name: 'Redham' }),
    ];
    rewind.captureCheckpoint(db, campaignId, null);
    const before = snapshot();

    for (const entry of finished) win(campaignId, entry);
    const after = snapshot();
    expect(after.places).toHaveLength(3);
    expect(factionNow(campaignId, house.id).realm_id).toBe(world.realms.ficengwind);
    expect(after.politics).not.toEqual(before.politics);

    rewind.rewindToCheckpoint(db, campaignId);

    expect(snapshot()).toEqual(before);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('puts back a liege link cleared by a revolt and a duchy seat lost with its county', () => {
    const world = borderWars();
    const { campaignId, realms, counties } = world;
    rewind.captureCheckpoint(db, campaignId, null);
    const before = politicsStore.getPolitics(db, campaignId);

    win(
      campaignId,
      agenda(campaignId, world.lordS, {
        template: 'revolt',
        target_kind: 'rival_faction',
        target_id: world.crownF.id,
        target_name: world.crownF.name,
      }),
    );
    win(
      campaignId,
      agenda(campaignId, world.crownR, {
        template: 'expand_territory',
        target_kind: 'neighbour_county',
        target_id: counties.hotfield,
        target_name: 'County of Hotfield',
      }),
    );

    const changed = politicsStore.getPolitics(db, campaignId)!;
    expect(changed.realms.find((realm) => realm.id === realms.stormcourtby)!.liege_realm_id).toBeNull();
    expect(changed.duchies.find((duchy) => duchy.id === world.duchies.hotfield)!.seat_place_id).toBeNull();

    rewind.rewindToCheckpoint(db, campaignId);

    expect(politicsStore.getPolitics(db, campaignId)).toEqual(before);
  });
});

describe('a year on the large map', () => {
  it('writes only states its wins name, never takes a capital or a last county and keeps danger names out of the news', () => {
    const campaignId = createCampaign(db, { name: 'A Year of Wins', story_shape: 'structured' }).campaign_id;
    region.importRegion(db, campaignId, large, { source: 'generated' });
    ensureWorld(db, campaignId);
    const start = store.currentGameDay(db, campaignId);
    const before = politicsStore.getPolitics(db, campaignId)!;
    for (let call = 1; call <= 6; call += 1) tickTo(db, campaignId, start + 60 * call);

    const wins = eventsOf(campaignId, 'agenda_won');
    expect(wins.length).toBeGreaterThan(0);
    for (const event of wins) expect(typeof event.effects.outcome).toBe('string');

    const capitals = new Map(before.realms.map((realm) => [realm.id, realm.capital_place_id]));
    const seats = new Map(before.counties.map((county) => [county.id, county.seat_place_id]));
    for (const event of wins.filter((entry) => entry.effects.outcome === 'county_transferred')) {
      const seat = seats.get(event.effects.county_id as number);
      expect(seat).not.toBe(capitals.get(event.effects.from_realm_id as number));
      expect(event.effects.to_realm_id).not.toBe(event.effects.from_realm_id);
    }
    const after = politicsStore.getPolitics(db, campaignId)!;
    for (const realm of before.realms.filter((entry) => entry.county_ids.length > 0)) {
      expect(after.realms.find((entry) => entry.id === realm.id)!.county_ids.length, realm.name).toBeGreaterThan(0);
    }

    const byId = new Map(store.listEvents(db, campaignId).map((event) => [event.id, event]));
    const states = db
      .prepare('SELECT state, cause_event_id FROM world_place_state WHERE campaign_id = ? AND state IS NOT NULL')
      .all(campaignId) as Array<{ state: string; cause_event_id: number }>;
    for (const row of states) expect(byId.get(row.cause_event_id)?.effects.state).toBe(row.state);

    const dangers = region.getRegion(db, campaignId)!.places.filter((place) => place.kind === 'danger').map((place) => place.name);
    const packets = (
      db.prepare('SELECT text FROM world_packet WHERE campaign_id = ?').all(campaignId) as Array<{ text: string }>
    ).map((row) => row.text);
    for (const text of packets) for (const danger of dangers) expect(text).not.toContain(danger);
  }, 180000);
});
