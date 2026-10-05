// What the living world seeds on day one, checked on the fixtures: governments, houses, gangs, bandits,
// church branches and broods. The real dice module is used so every campaign draws its own world seed.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import type { StoredPolitics } from '../src/core/politics-store.js';
import type { RegionView, WorldPlace } from '../src/core/region.js';
import type { WorldFaction } from '../src/core/world-store.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/realm-${name}.json`, import.meta.url), 'utf8')) as unknown;
const large = fixture('large');
const medium = fixture('medium');
const dangerous = fixture('dangerous');

let db: Db;

let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let holyCityRealm: (typeof import('../src/core/world-seed.js'))['holyCityRealm'];
let lairBrood: (typeof import('../src/core/world-seed.js'))['lairBrood'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let getRegion: (typeof import('../src/core/region.js'))['getRegion'];
let ensurePolitics: (typeof import('../src/core/politics-service.js'))['ensurePolitics'];
let listFactions: (typeof import('../src/core/world-store.js'))['listFactions'];
let listAgendas: (typeof import('../src/core/world-store.js'))['listAgendas'];
let factionFaith: (typeof import('../src/core/world-faith-store.js'))['factionFaith'];
let placeDistance: (typeof import('../src/core/region-graph.js'))['placeDistance'];

beforeAll(async () => {
  // With isolate: false an earlier file in this worker may have cached dice.ts under its own mock, so
  // reload the modules here to get the real generator.
  vi.resetModules();
  ({ ensureWorld, holyCityRealm, lairBrood } = await import('../src/core/world-seed.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion, getRegion } = await import('../src/core/region.js'));
  ({ ensurePolitics } = await import('../src/core/politics-service.js'));
  ({ listFactions, listAgendas } = await import('../src/core/world-store.js'));
  ({ factionFaith } = await import('../src/core/world-faith-store.js'));
  ({ placeDistance } = await import('../src/core/region-graph.js'));
});

beforeEach(() => {
  db = openDb(':memory:');
});

interface RealmRow {
  id: number;
  name: string;
  kind: string;
  liege_realm_id: number | null;
  government: string;
  ruler_title: string;
  capital_place_id: number | null;
}

interface Seeded {
  campaignId: number;
  view: RegionView;
  politics: StoredPolitics;
  realms: RealmRow[];
  factions: WorldFaction[];
}

/** Imports a fixture, lets `prepare` adjust the map, then seeds the world. */
function seed(realm: unknown, prepare?: (campaignId: number) => void): Seeded {
  const campaignId = createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
  importRegion(db, campaignId, realm, { source: 'generated' });
  prepare?.(campaignId);
  ensureWorld(db, campaignId);
  const realms = db
    .prepare(
      'SELECT id, name, kind, liege_realm_id, government, ruler_title, capital_place_id FROM world_realm WHERE campaign_id = ? ORDER BY id',
    )
    .all(campaignId) as RealmRow[];
  return {
    campaignId,
    view: getRegion(db, campaignId)!,
    politics: ensurePolitics(db, campaignId)!,
    realms,
    factions: listFactions(db, campaignId),
  };
}

/** A region seed that draws a holy city for this map's realms. */
function holySeed(campaignId: number): number {
  const view = getRegion(db, campaignId)!;
  const politics = ensurePolitics(db, campaignId)!;
  for (let candidate = 0; candidate < 200; candidate += 1) {
    if (holyCityRealm({ ...view, seed: candidate }, politics) !== null) return candidate;
  }
  throw new Error('no region seed draws a holy city');
}

const placeOf = (world: Seeded, faction: WorldFaction): WorldPlace =>
  world.view.places.find((place) => place.id === faction.place_id)!;

const ofType = (world: Seeded, type: string): WorldFaction[] => world.factions.filter((faction) => faction.type === type);

const hasTemple = (place: WorldPlace | undefined): boolean => place?.link?.includes('temple=1') ?? false;

/** The sovereign at the top of a realm's liege chain. */
function rootOf(realms: RealmRow[], realmId: number): number {
  let realm = realms.find((entry) => entry.id === realmId)!;
  while (realm.liege_realm_id !== null) realm = realms.find((entry) => entry.id === realm.liege_realm_id)!;
  return realm.id;
}

describe('governments on day one', () => {
  it('never makes a temple city a theocracy without the holy city draw', () => {
    const world = seed(large);
    const kingdoms = world.realms.filter((realm) => realm.kind === 'kingdom');
    expect(kingdoms.length).toBe(2);
    for (const realm of kingdoms) {
      expect(hasTemple(world.view.places.find((place) => place.id === realm.capital_place_id))).toBe(true);
    }
    expect(holyCityRealm(world.view, world.politics)).toBeNull();
    expect(world.realms.filter((realm) => realm.government === 'theocracy')).toEqual([]);
    expect(world.realms.filter((realm) => realm.ruler_title === 'Pontiff')).toEqual([]);
  });

  it('raises at most one theocracy per region, the same one whatever the world seed', () => {
    const holy = (campaignId: number) =>
      db.prepare('UPDATE world_region SET seed = ? WHERE campaign_id = ?').run(holySeed(campaignId), campaignId);
    const theocracies = (world: Seeded): string[] =>
      world.realms.filter((realm) => realm.government === 'theocracy').map((realm) => realm.name);

    // The large map has two temple-capital kingdoms, yet only one becomes the holy city, in every campaign.
    const largeRuns = [seed(large, holy), seed(large, holy), seed(large, holy)].map(theocracies);
    for (const names of largeRuns) expect(names).toHaveLength(1);
    expect(new Set(largeRuns.map((names) => names[0])).size).toBe(1);
    expect(['Theocracy of Darkforge', 'Theocracy of Dione']).toContain(largeRuns[0]![0]);

    // The medium map's own seed draws a holy city.
    expect([seed(medium), seed(medium)].map(theocracies)).toEqual([['Theocracy of Goldcaster'], ['Theocracy of Goldcaster']]);
  });

  it('crowns no empire below an XL map, and lets an XL map raise one', () => {
    const plain = seed(large);
    expect(plain.realms.filter((realm) => realm.government === 'empire')).toEqual([]);

    const xl = seed(large, (campaignId) =>
      db
        .prepare("UPDATE world_region SET raw_json = json_set(raw_json, '$.bp.width', 4800) WHERE campaign_id = ?")
        .run(campaignId),
    );
    const empires = xl.realms.filter((realm) => realm.government === 'empire');
    expect(empires.map((realm) => realm.name)).toContain('Empire of Darkforge');
    for (const empire of empires) {
      expect(empire.ruler_title).toBe('Emperor');
      expect(xl.politics.realms.find((realm) => realm.id === empire.id)!.county_ids.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('houses on day one', () => {
  it('seats no house on a capital county, crown land, a lordship or a free city', () => {
    for (const world of [seed(large), seed(medium)]) {
      const houses = ofType(world, 'house');
      expect(houses.length).toBeGreaterThan(0);
      const crownDuchies = new Set(world.politics.duchies.filter((duchy) => duchy.demesne).map((duchy) => duchy.id));
      for (const house of houses) {
        const county = world.politics.counties.find((entry) => entry.id === house.county_id)!;
        const realm = world.realms.find((entry) => entry.id === county.realm_id)!;
        expect(county.seat_place_id).not.toBe(realm.capital_place_id);
        expect(county.duchy_id === null || !crownDuchies.has(county.duchy_id)).toBe(true);
        expect(['lordship', 'free_city']).not.toContain(realm.kind);
      }
    }
  });

  it('gives a free city no separate magistracy', () => {
    const world = seed(large);
    const freeCity = world.realms.find((realm) => realm.kind === 'free_city')!;
    expect(world.factions.filter((faction) => faction.name.startsWith('Magistracy of'))).toEqual([]);
    expect(world.factions.filter((faction) => faction.realm_id === freeCity.id && faction.type === 'house')).toEqual([]);
    expect(world.factions.filter((faction) => faction.type === 'realm' && faction.realm_id === freeCity.id)).toHaveLength(1);
  });

  it('names a theocracy\'s houses as sees, never ducal houses or margraves', () => {
    const world = seed(medium);
    const theocracy = world.realms.find((realm) => realm.government === 'theocracy')!;
    const houses = ofType(world, 'house').filter((house) => house.realm_id === theocracy.id);
    expect(houses.map((house) => house.name)).toContain('Archbishopric of Silverburg');
    for (const house of houses) expect(house.name).toMatch(/^(Archbishopric|Bishopric) of /);
  });
});

describe('lordships on day one', () => {
  it('leaves a lordship its realm faction alone, with a temple only for a faith of its own', () => {
    for (let run = 0; run < 3; run += 1) {
      const world = seed(large);
      const lordships = world.realms.filter((realm) => realm.kind === 'lordship');
      expect(lordships.length).toBeGreaterThan(0);
      for (const lordship of lordships) {
        const own = world.factions.filter((faction) => faction.realm_id === lordship.id);
        expect(own.filter((faction) => faction.type === 'realm')).toHaveLength(1);
        expect(own.filter((faction) => faction.type === 'house')).toEqual([]);
        const faithOf = (realmId: number) =>
          db.prepare('SELECT faith FROM world_realm WHERE id = ?').get(realmId) as { faith: string };
        const sharers = world.realms.filter(
          (realm) =>
            realm.id !== lordship.id &&
            rootOf(world.realms, realm.id) === rootOf(world.realms, lordship.id) &&
            faithOf(realm.id).faith === faithOf(lordship.id).faith,
        );
        if (sharers.length > 0) expect(own.filter((faction) => faction.type === 'church')).toEqual([]);
      }
    }
  });
});

describe('gangs and bandits on day one', () => {
  it('keeps one gang in each city and none in a town or village', () => {
    for (const world of [seed(large), seed(medium)]) {
      const cities = world.view.places.filter((place) => place.kind === 'settlement' && place.tags.size === 'city');
      const gangs = ofType(world, 'gang');
      expect(gangs.map((gang) => gang.place_id).sort()).toEqual(cities.map((city) => city.id).sort());
    }
  });

  it('camps a few bandit bands in the wild, away from every settlement and never at a lair', () => {
    for (const world of [seed(large), seed(medium), seed(dangerous)]) {
      const bandits = ofType(world, 'bandits');
      expect(bandits.length).toBeGreaterThanOrEqual(1);
      expect(bandits.length).toBeLessThanOrEqual(3);
      const settlements = world.view.places.filter((place) => place.kind === 'settlement');
      for (const band of bandits) {
        const camp = placeOf(world, band);
        expect(camp.kind).not.toBe('settlement');
        expect(lairBrood(camp)).toBeNull();
        const anchor = { ...camp, hexes: camp.hexes.slice(0, 1) };
        for (const settlement of settlements) expect(placeDistance(anchor, settlement)).toBeGreaterThanOrEqual(2);
        expect(band.secrecy).toBe('discreet');
        // A camp at a danger is named for a settlement, so neither the band's name nor its portents reveal the site.
        if (camp.kind === 'danger') expect(band.name).not.toContain(camp.name);
        const raids = listAgendas(db, world.campaignId).filter((agenda) => agenda.faction_id === band.id);
        for (const agenda of raids) expect(agenda.template).toBe('raid');
        for (const portent of raids.flatMap((agenda) => agenda.portents)) {
          for (const danger of world.view.places.filter((place) => place.kind === 'danger')) {
            expect(portent.text).not.toContain(danger.name);
          }
        }
      }
    }
  });
});

describe('churches on day one', () => {
  it('founds one church per faith and realm group, none for a theocracy\'s own faith', () => {
    const worlds = [seed(large), seed(large), seed(large), seed(medium), seed(dangerous)];
    for (const world of worlds) {
      const faithIdOf = (realmId: number): number => {
        const row = db.prepare('SELECT faith FROM world_realm WHERE id = ?').get(realmId) as { faith: string };
        return (db.prepare('SELECT id FROM world_faith WHERE campaign_id = ? AND name = ?').get(world.campaignId, row.faith) as { id: number }).id;
      };
      const expected = new Set<string>();
      for (const realm of world.realms) {
        const root = world.realms.find((entry) => entry.id === rootOf(world.realms, realm.id))!;
        if (root.government === 'theocracy' && faithIdOf(root.id) === faithIdOf(realm.id)) continue;
        expected.add(`${root.id}:${faithIdOf(realm.id)}`);
      }
      const churches = ofType(world, 'church').map(
        (church) => `${rootOf(world.realms, church.realm_id!)}:${factionFaith(db, world.campaignId, church.id).faith_id}`,
      );
      expect(churches.length).toBe(new Set(churches).size);
      expect(new Set(churches)).toEqual(expected);
    }
  });
});

describe('broods on day one', () => {
  it('shelters a brood only at a lair-named danger, named for its kind', () => {
    const world = seed(large);
    expect(ofType(world, 'monsters').map((brood) => [brood.name, placeOf(world, brood).name])).toEqual([
      ['The Beasts of Den Of Knowledge', 'Den Of Knowledge'],
    ]);
    expect(ofType(seed(medium), 'monsters')).toEqual([]);
  });

  it("takes a brood's kind from a creature in the lair's name, else from the lair word", () => {
    const danger = (name: string, kind = 'dungeon'): WorldPlace => ({
      id: 1,
      kind: 'danger',
      name,
      q: 0,
      r: 0,
      hexes: ['q0_r0'],
      tags: { kind },
      info: '',
      link: null,
      seed: null,
      known_to_party: false,
      entity_id: null,
    });
    expect(lairBrood(danger('Spider Nest'))).toBe('Spiders');
    expect(lairBrood(danger('Den Of The Wolves'))).toBe('Wolves');
    expect(lairBrood(danger('Hive Of The Wasp Queen'))).toBe('Wasps');
    expect(lairBrood(danger('Den Of Knowledge'))).toBe('Beasts');
    expect(lairBrood(danger('Crow Roost'))).toBe('Flock');
    expect(lairBrood(danger('Old Warrens'))).toBe('Vermin');
    expect(lairBrood(danger('Sunken Hall', 'lair'))).toBe('Beasts');
    expect(lairBrood(danger('Library Of The Lizard Lord'))).toBeNull();
    expect(lairBrood(danger('Ziggurat Of The Vampire Queen'))).toBeNull();
    expect(lairBrood({ ...danger('Bear Den'), kind: 'settlement' })).toBeNull();
  });
});

describe('an already-seeded world', () => {
  it('stays as it was on a later ensureWorld', () => {
    const world = seed(large);
    expect(ensureWorld(db, world.campaignId)!.created).toBe(false);
    expect(listFactions(db, world.campaignId)).toEqual(world.factions);
  });
});
