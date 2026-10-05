// Place states that lapse lazily, a settlement's own faith over its realm's church, counties changing
// hands between sovereign realms, and how all of it survives a rewind and a region re-import.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { getPolitics, saveHierarchy } from '../src/core/politics-store.js';
import type { ComputedCounties, ComputedHierarchy, ComputedRealms } from '../src/core/politics-types.js';
import { findPlace, getRegion, importRegion } from '../src/core/region.js';
import { captureCheckpoint, rewindToCheckpoint } from '../src/core/rewind.js';
import { insertFaith, setFactionFaith, type WorldFaith } from '../src/core/world-faith-store.js';
import {
  BESIEGED_MAX_DAYS,
  RAIDED_DAYS,
  RUINED_DAYS,
  clearPlaceState,
  getPlaceState,
  setPlaceState,
  settlementFaithId,
  transferCounty,
  type PlaceStateKind,
} from '../src/core/world-place-state.js';
import { insertEvent, insertFaction, type WorldEvent } from '../src/core/world-store.js';
import { openDb, type Db } from '../src/db/connection.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

const safe = fixture('realm-safe.json');
const dangerous = fixture('realm-dangerous.json');
const DAY = 1000;

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

interface Seeded {
  campaignId: number;
  places: Record<'ficengwind' | 'hotfield' | 'redham' | 'southernLanding' | 'stormcourtby' | 'fens' | 'coldwood', number>;
  realms: [number, number, number];
  counties: [number, number, number, number, number];
  duchies: [number, number];
}

/**
 * Two sovereign kingdoms in a row of counties (c0-c1 | c2-c3) and a lordship sworn to the first:
 * c1 and c2 start as marches, and the claims sit on c1 and c3.
 */
function seed(name = 'The Border Wars'): Seeded {
  const campaignId = createCampaign(db, { name, story_shape: 'sandbox' }).campaign_id;
  importRegion(db, campaignId, safe, { source: 'generated' });
  const place = (ref: string): number => findPlace(db, campaignId, ref)!.id;
  const places = {
    ficengwind: place('Ficengwind'),
    hotfield: place('Hotfield'),
    redham: place('Redham'),
    southernLanding: place('Southern Landing'),
    stormcourtby: place('Stormcourtby'),
    fens: place('Ironfall Fens'),
    coldwood: place('Coldwood'),
  };

  const counties: ComputedCounties = {
    counties: [
      { name: 'County of Ficengwind', seat_place_id: places.ficengwind, seat_kind: 'city', hexes: ['q0_r0', 'q4_r11'], village_place_ids: [], component: 0 },
      { name: 'County of Hotfield', seat_place_id: places.hotfield, seat_kind: 'town', hexes: ['q1_r0', 'q9_r5'], village_place_ids: [places.stormcourtby], component: 0 },
      { name: 'County of Redham', seat_place_id: places.redham, seat_kind: 'town', hexes: ['q2_r0', 'q6_r8'], village_place_ids: [], component: 0 },
      { name: 'Southern Landing', seat_place_id: places.southernLanding, seat_kind: 'castle', hexes: ['q3_r0', 'q11_r14'], village_place_ids: [], component: 0 },
      { name: 'Fen Lordship', seat_place_id: places.fens, seat_kind: 'castle', hexes: ['q0_r2'], village_place_ids: [], component: 0 },
    ],
    edges: [],
  };
  const realms: ComputedRealms = {
    realms: [
      { name: 'Kingdom of Ficengwind', kind: 'kingdom', capital_place_id: places.ficengwind, off_map: false, liege: null },
      { name: 'Kingdom of Redham', kind: 'kingdom', capital_place_id: places.redham, off_map: false, liege: null },
      { name: 'Fen Lordship', kind: 'lordship', capital_place_id: null, off_map: false, liege: 0 },
    ],
    county_realm: [0, 0, 1, 1, 2],
  };
  const hierarchy: ComputedHierarchy = {
    duchies: [
      { name: 'Crownlands of Ficengwind', realm: 0, seat_place_id: places.ficengwind, county_indexes: [0, 1], demesne: true, joined_how: 'core' },
      { name: 'Crownlands of Redham', realm: 1, seat_place_id: places.redham, county_indexes: [2, 3], demesne: true, joined_how: 'core' },
    ],
    county_duchy: [0, 0, 1, 1, null],
    march_counties: [1, 2],
    claims: [
      { county: 1, claimant_realm: 1, strength: 'weak', reason: 'inheritance' },
      { county: 3, claimant_realm: 0, strength: 'strong', reason: 'ancient kingdom' },
      { county: 3, claimant_realm: 2, strength: 'weak', reason: 'dowry' },
    ],
  };
  const stored = saveHierarchy(db, campaignId, { counties, realms, hierarchy });
  return {
    campaignId,
    places,
    realms: stored.realms.map((realm) => realm.id) as Seeded['realms'],
    counties: stored.counties.map((county) => county.id) as Seeded['counties'],
    duchies: stored.duchies.map((duchy) => duchy.id) as Seeded['duchies'],
  };
}

function faith(campaignId: number, name: string, heresyOf: number | null = null): WorldFaith {
  return insertFaith(db, campaignId, {
    name,
    aspect: 'dawn',
    symbol: 'a rising sun',
    head_place_id: null,
    fervor: 50,
    heresy_of: heresyOf,
    last_heresy_day: null,
    created_day: DAY,
  });
}

function event(campaignId: number, text: string, placeId: number): WorldEvent {
  return insertEvent(db, campaignId, {
    day: DAY,
    kind: 'agenda_won',
    text,
    severity: 3,
    place_id: placeId,
    faction_id: null,
    agenda_id: null,
    causes: [],
    effects: {},
    visibility: 'public',
  });
}

function placeRows(campaignId: number): unknown[] {
  return db
    .prepare(
      'SELECT place_id, state, until_day, faith_id, cause_event_id, updated_day FROM world_place_state WHERE campaign_id = ? ORDER BY place_id',
    )
    .all(campaignId);
}

function holders(campaignId: number): Array<{ id: number; realm_id: number; duchy_id: number | null; is_march: boolean }> {
  return getPolitics(db, campaignId)!.counties.map((county) => ({
    id: county.id,
    realm_id: county.realm_id,
    duchy_id: county.duchy_id,
    is_march: county.is_march,
  }));
}

describe('place state', () => {
  it('uses the owner-set spans', () => {
    expect(RAIDED_DAYS).toBe(90);
    expect(BESIEGED_MAX_DAYS).toBe(180);
    expect(RUINED_DAYS).toBe(730);
  });

  const spans: Array<[PlaceStateKind, number]> = [
    ['raided', RAIDED_DAYS],
    ['besieged', BESIEGED_MAX_DAYS],
    ['ruined', RUINED_DAYS],
  ];

  it.each(spans)('reads %s until its span runs out, then reads as nothing without any tick', (state, span) => {
    const { campaignId, places } = seed();
    const cause = event(campaignId, 'Raiders burn the granary.', places.redham);

    const set = setPlaceState(db, campaignId, places.redham, DAY, { state, cause_event_id: cause.id });
    expect(set).toEqual({ state, until_day: DAY + span, cause_event_id: cause.id, updated_day: DAY });
    expect(getPlaceState(db, campaignId, places.redham, DAY + span - 1)?.state).toBe(state);
    expect(getPlaceState(db, campaignId, places.redham, DAY + span)).toBeNull();
    expect(getPlaceState(db, campaignId, places.hotfield, DAY)).toBeNull();
  });

  it('lets a later state replace an earlier one and a cleared siege end at once', () => {
    const { campaignId, places } = seed();
    setPlaceState(db, campaignId, places.redham, DAY, { state: 'besieged' });
    expect(setPlaceState(db, campaignId, places.redham, DAY + 40, { state: 'ruined' })).toMatchObject({
      state: 'ruined',
      until_day: DAY + 40 + RUINED_DAYS,
    });

    setPlaceState(db, campaignId, places.hotfield, DAY, { state: 'besieged' });
    clearPlaceState(db, campaignId, places.hotfield, DAY + 10);
    expect(getPlaceState(db, campaignId, places.hotfield, DAY + 10)).toBeNull();
    expect(placeRows(campaignId).map((row) => (row as { place_id: number }).place_id)).toEqual([places.redham]);
  });

  it('refuses a place, faith or cause from elsewhere and writes nothing', () => {
    const { campaignId, places } = seed();
    const other = seed('Another Table');
    const foreignFaith = faith(other.campaignId, 'The Far Flame');
    const foreignEvent = event(other.campaignId, 'Elsewhere, a fire.', other.places.redham);

    expect(() => setPlaceState(db, campaignId, other.places.redham, DAY, { state: 'raided' })).toThrow(/No place/);
    expect(() => setPlaceState(db, campaignId, places.redham, DAY, { faith_id: foreignFaith.id })).toThrow(/No faith/);
    expect(() => setPlaceState(db, campaignId, places.redham, DAY, { state: 'raided', cause_event_id: foreignEvent.id })).toThrow(
      /No world event/,
    );
    expect(() => setPlaceState(db, campaignId, places.redham, DAY, { state: 'burning' as PlaceStateKind })).toThrow(
      /Unknown place state/,
    );
    expect(placeRows(campaignId)).toEqual([]);
  });
});

describe('settlementFaithId', () => {
  function withChurches(): Seeded & { dawn: number; lantern: number; heresy: number } {
    const seeded = seed();
    const { campaignId, realms, counties } = seeded;
    const dawn = faith(campaignId, 'The Dawnmother').id;
    const lantern = faith(campaignId, 'The Lantern Court').id;
    const heresy = faith(campaignId, 'The Grey Lantern', lantern).id;
    const faction = (name: string, type: 'church' | 'realm', realmId: number, countyId: number | null): number =>
      insertFaction(db, campaignId, {
        name,
        type,
        realm_id: realmId,
        county_id: countyId,
        place_id: null,
        secrecy: 'open',
        resources: 3,
        capacities: {},
        created_day: DAY,
      }).id;
    setFactionFaith(db, campaignId, faction('Temple of Ficengwind', 'church', realms[0], null), dawn, 'strong');
    setFactionFaith(db, campaignId, faction('Holy Crown of Redham', 'realm', realms[1], counties[2]), lantern, 'dominant');
    setFactionFaith(db, campaignId, faction('The Grey Lanterns', 'church', realms[1], counties[3]), heresy, 'minor');
    return { ...seeded, dawn, lantern, heresy };
  }

  it("follows the realm's church, or its dominant crown, wherever the settlement lies", () => {
    const { campaignId, places, dawn, lantern } = withChurches();
    expect(settlementFaithId(db, campaignId, places.ficengwind)).toBe(dawn);
    expect(settlementFaithId(db, campaignId, places.stormcourtby)).toBe(dawn);
    expect(settlementFaithId(db, campaignId, places.redham)).toBe(lantern);
    // A minor heresy in the county does not displace the realm's dominant faith.
    expect(settlementFaithId(db, campaignId, places.southernLanding)).toBe(lantern);
    expect(settlementFaithId(db, campaignId, places.fens)).toBeNull();
    expect(settlementFaithId(db, campaignId, places.coldwood)).toBeNull();
  });

  it("lets a settlement's own faith override its realm's and outlast any state", () => {
    const { campaignId, places, dawn, lantern } = withChurches();
    setPlaceState(db, campaignId, places.redham, DAY, { faith_id: dawn });
    expect(settlementFaithId(db, campaignId, places.redham)).toBe(dawn);

    setPlaceState(db, campaignId, places.redham, DAY, { state: 'raided' });
    expect(getPlaceState(db, campaignId, places.redham, DAY + RAIDED_DAYS)).toBeNull();
    expect(settlementFaithId(db, campaignId, places.redham)).toBe(dawn);
    clearPlaceState(db, campaignId, places.redham, DAY + 1);
    expect(settlementFaithId(db, campaignId, places.redham)).toBe(dawn);

    setPlaceState(db, campaignId, places.redham, DAY + 2, { faith_id: null });
    expect(settlementFaithId(db, campaignId, places.redham)).toBe(lantern);
    expect(placeRows(campaignId)).toEqual([]);
  });

  it('follows a county to its new realm', () => {
    const { campaignId, places, realms, counties, lantern } = withChurches();
    transferCounty(db, campaignId, counties[1], realms[1]);
    expect(settlementFaithId(db, campaignId, places.hotfield)).toBe(lantern);
    expect(settlementFaithId(db, campaignId, places.stormcourtby)).toBe(lantern);
  });
});

describe('transferCounty', () => {
  it('moves a county, recomputes the marches around it and moves its claims', () => {
    const { campaignId, realms, counties, duchies } = seed();
    const [kingA, kingB, lordship] = realms;

    expect(transferCounty(db, campaignId, counties[1], kingB, { duchy_id: duchies[1] })).toEqual({
      county_id: counties[1],
      from_realm_id: kingA,
      to_realm_id: kingB,
    });

    expect(holders(campaignId)).toEqual([
      { id: counties[0], realm_id: kingA, duchy_id: duchies[0], is_march: true },
      { id: counties[1], realm_id: kingB, duchy_id: duchies[1], is_march: true },
      { id: counties[2], realm_id: kingB, duchy_id: duchies[1], is_march: false },
      { id: counties[3], realm_id: kingB, duchy_id: duchies[1], is_march: false },
      { id: counties[4], realm_id: lordship, duchy_id: null, is_march: false },
    ]);
    expect(getPolitics(db, campaignId)!.claims).toEqual([
      { county_id: counties[1], claimant_realm_id: kingA, strength: 'strong', reason: 'recent conquest' },
      { county_id: counties[3], claimant_realm_id: kingA, strength: 'strong', reason: 'ancient kingdom' },
      { county_id: counties[3], claimant_realm_id: lordship, strength: 'weak', reason: 'dowry' },
    ]);
    const realmCounties = getPolitics(db, campaignId)!.realms.map((realm) => realm.county_ids);
    expect(realmCounties).toEqual([[counties[0]], [counties[1], counties[2], counties[3]], [counties[4]]]);
  });

  it("leaves the county outside any duchy by default and drops the taker's claim", () => {
    const { campaignId, realms, counties } = seed();
    const [kingA, kingB, lordship] = realms;

    transferCounty(db, campaignId, counties[3], kingA, { former_claim: null });

    expect(holders(campaignId).find((county) => county.id === counties[3])).toEqual({
      id: counties[3],
      realm_id: kingA,
      duchy_id: null,
      is_march: true,
    });
    expect(holders(campaignId).find((county) => county.id === counties[2])?.is_march).toBe(true);
    expect(getPolitics(db, campaignId)!.claims).toEqual([
      { county_id: counties[1], claimant_realm_id: kingB, strength: 'weak', reason: 'inheritance' },
      { county_id: counties[3], claimant_realm_id: lordship, strength: 'weak', reason: 'dowry' },
    ]);
  });

  it('refuses an invalid transfer and writes nothing', () => {
    const { campaignId, realms, counties, duchies } = seed();
    const other = seed('Another Table');
    const [kingA, kingB, lordship] = realms;
    const before = getPolitics(db, campaignId);

    const refusals: Array<[() => unknown, RegExp]> = [
      [() => transferCounty(db, campaignId, counties[0], kingB), /capital county of Kingdom of Ficengwind/],
      [() => transferCounty(db, campaignId, counties[3], kingB), /already lies within Kingdom of Redham/],
      [() => transferCounty(db, campaignId, counties[3], lordship), /Fen Lordship owes fealty/],
      [() => transferCounty(db, campaignId, counties[4], kingA), /already lies within Kingdom of Ficengwind/],
      [() => transferCounty(db, campaignId, counties[4], kingB), /last county of Fen Lordship/],
      [() => transferCounty(db, campaignId, counties[3], kingA, { duchy_id: duchies[1] }), /not a duchy of Kingdom of Ficengwind/],
      [() => transferCounty(db, campaignId, 999999, kingA), /No county 999999/],
      [() => transferCounty(db, campaignId, counties[3], 999999), /No realm 999999/],
      [() => transferCounty(db, campaignId, other.counties[3], kingA), /No county/],
      [() => transferCounty(db, campaignId, counties[3], other.realms[0]), /No realm/],
    ];
    for (const [attempt, message] of refusals) expect(attempt).toThrow(message);

    expect(getPolitics(db, campaignId)).toEqual(before);
  });
});

describe('rewind', () => {
  /** A raid citing an event and a converted town, then a checkpoint. */
  function checkpointed(): Seeded & { dawn: number } {
    const seeded = seed();
    const { campaignId, places } = seeded;
    const dawn = faith(campaignId, 'The Dawnmother').id;
    const raid = event(campaignId, 'Raiders burn the granary.', places.redham);
    setPlaceState(db, campaignId, places.redham, DAY, { state: 'raided', cause_event_id: raid.id });
    setPlaceState(db, campaignId, places.hotfield, DAY, { faith_id: dawn });
    captureCheckpoint(db, campaignId, null);
    return { ...seeded, dawn };
  }

  /** What happens after the checkpoint: a new event and faith cited by new states, and a conquest. */
  function laterWar(seeded: Seeded): void {
    const { campaignId, places, realms, counties } = seeded;
    const siege = event(campaignId, 'An army rings Southern Landing.', places.southernLanding);
    const heresy = faith(campaignId, 'The Ashen Way');
    setPlaceState(db, campaignId, places.southernLanding, DAY + 10, { state: 'besieged', cause_event_id: siege.id });
    setPlaceState(db, campaignId, places.redham, DAY + 10, { state: 'ruined', faith_id: heresy.id });
    setPlaceState(db, campaignId, places.hotfield, DAY + 10, { faith_id: null });
    transferCounty(db, campaignId, counties[1], realms[1]);
  }

  it('puts place states, county holders and claims back', () => {
    const seeded = checkpointed();
    const { campaignId } = seeded;
    const rowsBefore = placeRows(campaignId);
    const politicsBefore = getPolitics(db, campaignId);
    expect(rowsBefore).toHaveLength(2);

    laterWar(seeded);
    expect(placeRows(campaignId)).not.toEqual(rowsBefore);
    expect(getPolitics(db, campaignId)).not.toEqual(politicsBefore);

    rewindToCheckpoint(db, campaignId);

    expect(placeRows(campaignId)).toEqual(rowsBefore);
    expect(getPolitics(db, campaignId)).toEqual(politicsBefore);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('still restores a checkpoint written before place states and county holders were captured', () => {
    const seeded = checkpointed();
    const { campaignId, realms, counties } = seeded;
    const checkpoint = db.prepare('SELECT id, snapshot_json FROM checkpoint WHERE campaign_id = ?').get(campaignId) as {
      id: number;
      snapshot_json: string;
    };
    const snapshot = JSON.parse(checkpoint.snapshot_json) as { tables: Record<string, unknown>; world_counties?: unknown };
    delete snapshot.tables.world_place_state;
    delete snapshot.world_counties;
    db.prepare('UPDATE checkpoint SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(snapshot), checkpoint.id);

    laterWar(seeded);
    expect(() => rewindToCheckpoint(db, campaignId)).not.toThrow();

    // The rewound world takes its later states with it; the holders it never knew stay as they are.
    expect(placeRows(campaignId)).toEqual([]);
    expect(holders(campaignId).find((county) => county.id === counties[1])?.realm_id).toBe(realms[1]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('importRegion', () => {
  it('clears place states before the events, faiths and places they point at', () => {
    const { campaignId, places } = seed();
    const dawn = faith(campaignId, 'The Dawnmother');
    const raid = event(campaignId, 'Raiders burn the granary.', places.redham);
    setPlaceState(db, campaignId, places.redham, DAY, { state: 'raided', cause_event_id: raid.id, faith_id: dawn.id });

    expect(() => importRegion(db, campaignId, dangerous, { source: 'uploaded', replace: true })).not.toThrow();

    expect(placeRows(campaignId)).toEqual([]);
    expect(getRegion(db, campaignId)!.name).toBe('Ta Isle');
  });
});
