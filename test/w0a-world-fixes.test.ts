// The W0a review fixes to the world clock: a brood wiped out mid-tick stops acting, hunts go only where a brood
// lairs, bands are named for a town, idle factions retry weekly, a destroy counts and a moved house drops its revolt.
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

let db: Db;
let openDb: (typeof import('../src/db/connection.js'))['openDb'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let updateSettings: (typeof import('../src/core/settings.js'))['updateSettings'];
let region: typeof import('../src/core/region.js');
let placeDistance: (typeof import('../src/core/region-graph.js'))['placeDistance'];
let politicsStore: typeof import('../src/core/politics-store.js');
let ensurePolitics: (typeof import('../src/core/politics-service.js'))['ensurePolitics'];
let store: typeof import('../src/core/world-store.js');
let placeState: typeof import('../src/core/world-place-state.js');
let resolve: typeof import('../src/core/world-resolve.js');
let thwart: typeof import('../src/core/world-thwart.js');
let seeding: typeof import('../src/core/world-seed.js');
let tickTo: (typeof import('../src/core/world-tick.js'))['tickTo'];

beforeAll(async () => {
  // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world fresh on the real one.
  vi.resetModules();
  ({ openDb } = await import('../src/db/connection.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ updateSettings } = await import('../src/core/settings.js'));
  region = await import('../src/core/region.js');
  ({ placeDistance } = await import('../src/core/region-graph.js'));
  politicsStore = await import('../src/core/politics-store.js');
  ({ ensurePolitics } = await import('../src/core/politics-service.js'));
  store = await import('../src/core/world-store.js');
  placeState = await import('../src/core/world-place-state.js');
  resolve = await import('../src/core/world-resolve.js');
  thwart = await import('../src/core/world-thwart.js');
  seeding = await import('../src/core/world-seed.js');
  ({ tickTo } = await import('../src/core/world-tick.js'));
});

beforeEach(() => {
  db = openDb(':memory:');
});

let names = 0;

function withRegion(realm: unknown, target: Db = db): number {
  names += 1;
  const campaignId = createCampaign(target, { name: `World Fixes ${names}`, story_shape: 'structured' }).campaign_id;
  region.importRegion(target, campaignId, realm, { source: 'generated' });
  return campaignId;
}

function placeId(campaignId: number, name: string): number {
  return region.findPlace(db, campaignId, name)!.id;
}

function faction(campaignId: number, extra: Partial<Omit<WorldFaction, 'id'>> = {}): WorldFaction {
  names += 1;
  return store.insertFaction(db, campaignId, {
    name: `Fix Faction ${names}`,
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

/** A finished agenda, its clock full and its one portent fired, so it resolves on its next turn. */
function finished(
  campaignId: number,
  owner: WorldFaction,
  day: number,
  extra: Partial<Omit<WorldAgenda, 'id'>> & Pick<WorldAgenda, 'template' | 'target_kind' | 'target_id' | 'target_name'>,
): WorldAgenda {
  return store.insertAgenda(db, campaignId, {
    faction_id: owner.id,
    clock_size: 6,
    clock_filled: 6,
    portents: [{ text: 'Something stirs.', fired_day: day, heard: false }],
    status: 'active',
    started_day: day - 20,
    ...extra,
  });
}

function factionNow(campaignId: number, id: number): WorldFaction {
  return store.listFactions(db, campaignId, { includeEnded: true }).find((entry) => entry.id === id)!;
}

function agendaNow(campaignId: number, id: number): WorldAgenda {
  return store.listAgendas(db, campaignId).find((entry) => entry.id === id)!;
}

function inPlay(campaignId: number, factionId: number): WorldAgenda[] {
  return store
    .listAgendas(db, campaignId, { factionId })
    .filter((agenda) => agenda.status === 'active' || agenda.status === 'held');
}

interface Lairs {
  campaignId: number;
  today: number;
  frostcot: number;
  crimsonWharf: number;
  den: number;
  ziggurat: number;
  brood: WorldFaction;
}

/** The dangerous island seeded with one brood at Hidden Den and none at the ziggurat, every seeded agenda set aside. */
function lairs(): Lairs {
  const campaignId = withRegion(dangerous);
  db.prepare('UPDATE world_place SET name = ? WHERE campaign_id = ? AND name = ?').run('Hidden Den', campaignId, 'Hidden Keep');
  seeding.ensureWorld(db, campaignId);
  const today = store.currentGameDay(db, campaignId);
  for (const agenda of store.listAgendas(db, campaignId)) {
    store.updateAgenda(db, campaignId, agenda.id, { status: 'abandoned', resolved_day: today });
  }
  const den = placeId(campaignId, 'Hidden Den');
  const brood = store.listFactions(db, campaignId).find((entry) => entry.type === 'monsters' && entry.place_id === den)!;
  expect(brood).toBeDefined();
  return {
    campaignId,
    today,
    frostcot: placeId(campaignId, 'Frostcot'),
    crimsonWharf: placeId(campaignId, 'Crimson Wharf'),
    den,
    ziggurat: placeId(campaignId, 'Ziggurat Of The Vampire Queen'),
    brood,
  };
}

/** Picks for one faction over many salts, setting each pick aside so the next starts from the same field. */
function pickMany(campaignId: number, owner: WorldFaction, day: number, salts: number): WorldAgenda[] {
  const picks: WorldAgenda[] = [];
  for (let salt = 1; salt <= salts; salt += 1) {
    const next = seeding.pickAgenda(db, campaignId, owner, day, 7, salt);
    if (next === null) continue;
    picks.push(next);
    store.updateAgenda(db, campaignId, next.id, { status: 'abandoned' });
  }
  return picks;
}

describe('a brood wiped out by a hunt during a tick', () => {
  it('neither acts again that day nor takes up a new agenda, whichever of the two goes first', () => {
    const fates = new Set<string>();
    for (let seed = 1; seed <= 10; seed += 1) {
      const world = lairs();
      const { campaignId, today, brood } = world;
      store.saveWorldState(db, campaignId, { ...store.getWorldState(db, campaignId)!, seed });
      updateSettings(db, campaignId, { storyteller: 'chaotic' });
      // At 1 the brood falls to the hunt whether or not its own win lands first.
      store.updateFaction(db, campaignId, brood.id, { resources: 1 });
      const hunters = faction(campaignId, { name: `Hunters ${seed}`, place_id: world.frostcot });
      finished(campaignId, hunters, today, {
        template: 'hunt_monster',
        target_kind: 'danger',
        target_id: world.den,
        target_name: 'Hidden Den',
      });
      const grow = finished(campaignId, brood, today, {
        template: 'monsters_grow',
        target_kind: 'settlement',
        target_id: world.frostcot,
        target_name: 'Frostcot',
      });

      const first = tickTo(db, campaignId, today + 1);

      expect(factionNow(campaignId, brood.id).ended_day, `seed ${seed}`).toBe(today + 1);
      const destroyed = store.listEvents(db, campaignId).find((event) => event.kind === 'faction_destroyed')!;
      expect(destroyed.faction_id).toBe(brood.id);
      expect(first.events.map((event) => event.id)).toContain(destroyed.id);
      fates.add(agendaNow(campaignId, grow.id).status);

      tickTo(db, campaignId, today + 30);

      expect(inPlay(campaignId, brood.id), `seed ${seed}`).toEqual([]);
      const afterEnd = store
        .listEvents(db, campaignId)
        .filter((event) => event.faction_id === brood.id && event.id > destroyed.id);
      expect(afterEnd, `seed ${seed}`).toEqual([]);
    }
    // The brood's own win came first on some seeds and was cut off by the hunt on others.
    expect([...fates].sort()).toEqual(['abandoned', 'won']);
  });

  it('counts the destruction against the day and returns it with the win', () => {
    const world = lairs();
    const { campaignId, today, brood } = world;
    updateSettings(db, campaignId, { storyteller: 'steady' });
    store.updateFaction(db, campaignId, brood.id, { resources: 2 });
    const hunters = faction(campaignId, { place_id: world.frostcot });
    // A held hunt resolves before any active agenda, so the day's order is fixed.
    const hunt = finished(campaignId, hunters, today, {
      template: 'hunt_monster',
      target_kind: 'danger',
      target_id: world.den,
      target_name: 'Hidden Den',
      status: 'held',
    });
    const bandits = store.listFactions(db, campaignId).find((entry) => entry.type === 'bandits')!;
    const raid = finished(campaignId, bandits, today, {
      template: 'raid',
      target_kind: 'settlement',
      target_id: world.frostcot,
      target_name: 'Frostcot',
    });

    const { events } = tickTo(db, campaignId, today + 1);

    expect(events.map((event) => [event.kind, event.agenda_id ?? event.faction_id])).toEqual([
      ['agenda_won', hunt.id],
      ['faction_destroyed', brood.id],
    ]);
    // The win and the destruction fill the steady day, so the finished raid waits for tomorrow.
    expect(agendaNow(campaignId, raid.id).status).toBe('active');
    tickTo(db, campaignId, today + 2);
    expect(agendaNow(campaignId, raid.id)).toMatchObject({ status: 'won', resolved_day: today + 2 });
  });
});

describe('a stale agenda or faction', () => {
  it('is refused by resolveAgenda once no longer active or held, writing nothing', () => {
    const world = lairs();
    const { campaignId, today, brood } = world;
    const grow = finished(campaignId, brood, today, {
      template: 'monsters_grow',
      target_kind: 'settlement',
      target_id: world.frostcot,
      target_name: 'Frostcot',
    });
    thwart.destroyFaction(db, campaignId, brood.id, 'its lair was cleared', today);
    const before = store.listEvents(db, campaignId).length;

    expect(() => resolve.resolveAgenda(db, campaignId, grow, today + 1, 7)).toThrow(/already abandoned/);

    expect(agendaNow(campaignId, grow.id).status).toBe('abandoned');
    expect(store.listEvents(db, campaignId)).toHaveLength(before);
    expect(placeState.getPlaceState(db, campaignId, world.frostcot, today + 1)).toBeNull();
  });

  it('gets no agenda from pickAgenda once its faction has ended, even through a copy read before', () => {
    const world = lairs();
    const { campaignId, today, brood } = world;
    expect(pickMany(campaignId, brood, today, 3).length).toBeGreaterThan(0);
    thwart.destroyFaction(db, campaignId, brood.id, 'its lair was cleared', today);
    const before = store.listAgendas(db, campaignId).length;

    expect(seeding.pickAgenda(db, campaignId, brood, today + 1, 7, 1)).toBeNull();
    expect(store.listAgendas(db, campaignId)).toHaveLength(before);
  });
});

describe('hunts and crusades', () => {
  it('aim only at a danger a living brood lairs at', () => {
    const world = lairs();
    const { campaignId, today } = world;
    // Frostcot lies nearer the empty ziggurat than the den, so the old picker sent its hunters to the ziggurat.
    const hunters = faction(campaignId, { place_id: world.frostcot });

    const hunts = pickMany(campaignId, hunters, today, 60).filter((entry) => entry.template === 'hunt_monster');
    expect(hunts.length).toBeGreaterThan(0);
    for (const hunt of hunts) expect(hunt.target_id).toBe(world.den);

    thwart.clearDanger(db, campaignId, world.den, today);
    const later = pickMany(campaignId, hunters, today + 1, 60).filter((entry) => entry.target_kind === 'danger');
    expect(later).toEqual([]);
  });

  it('abandons a hunt left at a danger with no living brood rather than winning it', () => {
    const world = lairs();
    const hunters = faction(world.campaignId, { place_id: world.frostcot });
    const hunt = finished(world.campaignId, hunters, world.today, {
      template: 'hunt_monster',
      target_kind: 'danger',
      target_id: world.ziggurat,
      target_name: 'Ziggurat Of The Vampire Queen',
    });

    const { event, next } = resolve.resolveAgenda(db, world.campaignId, hunt, world.today + 1, 7);

    expect(event).toMatchObject({ kind: 'agenda_abandoned', visibility: 'secret' });
    expect(next).toBeNull();
    expect(agendaNow(world.campaignId, hunt.id).status).toBe('abandoned');
    expect(store.listEvents(db, world.campaignId).some((entry) => entry.kind === 'agenda_won')).toBe(false);
  });
});

describe('bandit band names', () => {
  it('name each band only for the settlement nearest its camp, never an area or a danger', () => {
    for (const realm of [dangerous, large]) {
      const campaignId = withRegion(realm);
      if (realm === dangerous) {
        // With both dungeons made lairs, the island's one campsite is the Shadowscale Ridge area.
        const rename = db.prepare('UPDATE world_place SET name = ? WHERE campaign_id = ? AND name = ?');
        rename.run('Nest Of The Vampire Queen', campaignId, 'Ziggurat Of The Vampire Queen');
        rename.run('Hidden Den', campaignId, 'Hidden Keep');
      }
      seeding.ensureWorld(db, campaignId);
      const view = region.getRegion(db, campaignId)!;
      const settlements = view.places.filter((place) => place.kind === 'settlement');
      const bands = store.listFactions(db, campaignId).filter((entry) => entry.type === 'bandits');
      expect(bands.length).toBeGreaterThan(0);
      if (realm === dangerous) {
        expect(bands.map((band) => band.place_id)).toEqual([placeId(campaignId, 'Shadowscale Ridge')]);
      }
      for (const band of bands) {
        const camp = view.places.find((place) => place.id === band.place_id)!;
        const nearest = [...settlements].sort(
          (a, b) => placeDistance(camp, a) - placeDistance(camp, b) || a.id - b.id,
        )[0]!;
        const named = ['Brigands', 'Outlaws', 'Highwaymen', 'Reavers'].map((noun) => `The ${nearest.name} ${noun}`);
        expect(named).toContain(band.name);
      }
    }
  });
});

describe('a faction left idle', () => {
  it('tries the day after it went idle, then weekly while nothing is open to it', () => {
    const campaignId = withRegion(dangerous);
    const today = store.currentGameDay(db, campaignId);
    // Politics are computed only before a world exists, so they come first in a world built by hand.
    ensurePolitics(db, campaignId);
    store.saveWorldState(db, campaignId, { seed: 7, last_tick_day: today, quiet_until_day: 0 });
    const frostcot = placeId(campaignId, 'Frostcot');
    const gang = faction(campaignId, { type: 'gang', secrecy: 'discreet', place_id: placeId(campaignId, 'Crimson Wharf'), created_day: today });
    // Frostcot is the gang's only prey, and it lies ruined until three days from now.
    placeState.setPlaceState(db, campaignId, frostcot, today, { state: 'ruined' });
    db.prepare('UPDATE world_place_state SET until_day = ? WHERE campaign_id = ? AND place_id = ?').run(today + 3, campaignId, frostcot);

    tickTo(db, campaignId, today + 7);
    expect(store.listAgendas(db, campaignId, { factionId: gang.id })).toEqual([]);

    tickTo(db, campaignId, today + 8);
    expect(inPlay(campaignId, gang.id)).toMatchObject([{ template: 'raid', target_id: frostcot, started_day: today + 8 }]);
  });

  it('leaves the world the same whether it is ticked a day at a time or in one call', () => {
    /** The same world in any database: the world seed comes from Math.random, held still while it is drawn. */
    const seeded = (target: Db): number => {
      const spy = vi.spyOn(Math, 'random').mockReturnValue(0.4242);
      try {
        const campaignId = withRegion(dangerous, target);
        target
          .prepare('UPDATE world_place SET name = ? WHERE campaign_id = ? AND name = ?')
          .run('Hidden Den', campaignId, 'Hidden Keep');
        seeding.ensureWorld(target, campaignId);
        return campaignId;
      } finally {
        spy.mockRestore();
      }
    };
    const run = (target: Db, step: number): unknown[] => {
      const campaignId = seeded(target);
      updateSettings(target, campaignId, { storyteller: 'chaotic' });
      const today = store.currentGameDay(target, campaignId);
      for (let day = today + step; day <= today + 60; day += step) tickTo(target, campaignId, day);
      return [
        target
          .prepare('SELECT day, kind, text, faction_id, agenda_id FROM world_event WHERE campaign_id = ? ORDER BY id')
          .all(campaignId),
        target
          .prepare('SELECT faction_id, template, target_id, status, started_day FROM world_agenda WHERE campaign_id = ? ORDER BY id')
          .all(campaignId),
      ];
    };

    const daily = run(openDb(':memory:'), 1);
    const whole = run(openDb(':memory:'), 60);
    expect((daily[0] as unknown[]).length).toBeGreaterThan(0);
    expect(daily).toEqual(whole);
  });
});

describe('a house carried across by a county transfer', () => {
  it('drops its revolt against the crown it left, and a house that stays keeps its own', () => {
    const campaignId = withRegion(safe);
    const places = {
      ficengwind: placeId(campaignId, 'Ficengwind'),
      hotfield: placeId(campaignId, 'Hotfield'),
      redham: placeId(campaignId, 'Redham'),
      southernLanding: placeId(campaignId, 'Southern Landing'),
    };
    const counties: ComputedCounties = {
      counties: [
        { name: 'County of Ficengwind', seat_place_id: places.ficengwind, seat_kind: 'city', hexes: ['q0_r0', 'q4_r11'], village_place_ids: [], component: 0 },
        { name: 'County of Hotfield', seat_place_id: places.hotfield, seat_kind: 'town', hexes: ['q1_r0', 'q12_r11'], village_place_ids: [], component: 0 },
        { name: 'County of Redham', seat_place_id: places.redham, seat_kind: 'town', hexes: ['q2_r0', 'q6_r8'], village_place_ids: [], component: 0 },
        { name: 'County of Southern Landing', seat_place_id: places.southernLanding, seat_kind: 'town', hexes: ['q3_r0', 'q11_r14'], village_place_ids: [], component: 0 },
      ],
      edges: [],
    };
    const realms: ComputedRealms = {
      realms: [
        { name: 'Kingdom of Ficengwind', kind: 'kingdom', capital_place_id: places.ficengwind, off_map: false, liege: null },
        { name: 'Kingdom of Redham', kind: 'kingdom', capital_place_id: places.redham, off_map: false, liege: null },
      ],
      county_realm: [0, 0, 1, 1],
    };
    const hierarchy: ComputedHierarchy = { duchies: [], county_duchy: [null, null, null, null], march_counties: [], claims: [] };
    const stored = politicsStore.saveHierarchy(db, campaignId, { counties, realms, hierarchy });
    const [realmF, realmR] = stored.realms.map((realm) => realm.id) as [number, number];
    const [cF, cH, cR, cSL] = stored.counties.map((county) => county.id) as [number, number, number, number];
    const crownF = faction(campaignId, { type: 'realm', realm_id: realmF, county_id: cF, place_id: places.ficengwind, resources: 5 });
    const crownR = faction(campaignId, { type: 'realm', realm_id: realmR, county_id: cR, place_id: places.redham, resources: 5 });
    const moved = faction(campaignId, { realm_id: realmF, county_id: cH, place_id: places.hotfield });
    const stays = faction(campaignId, { realm_id: realmR, county_id: cSL, place_id: places.southernLanding });
    const revolt = (house: WorldFaction, crown: WorldFaction): WorldAgenda =>
      finished(campaignId, house, DAY, { template: 'revolt', target_kind: 'rival_faction', target_id: crown.id, target_name: crown.name, clock_filled: 2 });
    const movedRevolt = revolt(moved, crownF);
    const keptRevolt = revolt(stays, crownR);

    const event: WorldEvent = resolve.resolveAgenda(
      db,
      campaignId,
      finished(campaignId, crownR, DAY, { template: 'expand_territory', target_kind: 'neighbour_county', target_id: cH, target_name: 'County of Hotfield' }),
      DAY,
      7,
    ).event;

    expect(event.effects).toMatchObject({ outcome: 'county_transferred', houses: [moved.id], abandoned: [movedRevolt.id] });
    expect(factionNow(campaignId, moved.id).realm_id).toBe(realmR);
    expect(agendaNow(campaignId, movedRevolt.id)).toMatchObject({ status: 'abandoned', resolved_day: DAY });
    expect(agendaNow(campaignId, keptRevolt.id).status).toBe('active');
  });
});
