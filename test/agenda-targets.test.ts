// Agenda targets follow the political hierarchy and the size of a seat: only sovereign realms expand,
// vassals revolt, rivals are neighbours, churches preach to other faiths and seats build by their size.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import type { WorldPlace } from '../src/core/region.js';
import type { WorldAgenda, WorldFaction } from '../src/core/world-store.js';

const large = JSON.parse(readFileSync(new URL('./fixtures/realm-large.json', import.meta.url), 'utf8')) as unknown;

let db: Db;
let seeding: typeof import('../src/core/world-seed.js');
let templatesFor: (typeof import('../src/core/agenda-templates.js'))['templatesFor'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let region: typeof import('../src/core/region.js');
let politicsStore: typeof import('../src/core/politics-store.js');
let store: typeof import('../src/core/world-store.js');
let faithStore: typeof import('../src/core/world-faith-store.js');
let placeState: typeof import('../src/core/world-place-state.js');
let placeDistance: (typeof import('../src/core/region-graph.js'))['placeDistance'];
let tickTo: (typeof import('../src/core/world-tick.js'))['tickTo'];

beforeAll(async () => {
  // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world fresh on the real one.
  vi.resetModules();
  seeding = await import('../src/core/world-seed.js');
  ({ templatesFor } = await import('../src/core/agenda-templates.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  region = await import('../src/core/region.js');
  politicsStore = await import('../src/core/politics-store.js');
  store = await import('../src/core/world-store.js');
  faithStore = await import('../src/core/world-faith-store.js');
  placeState = await import('../src/core/world-place-state.js');
  ({ placeDistance } = await import('../src/core/region-graph.js'));
  ({ tickTo } = await import('../src/core/world-tick.js'));
});

beforeEach(() => {
  db = openDb(':memory:');
});

const SEED = 7;

/** Four realms over six counties in west-to-east bands of the large map; the vassal answers to the crown. */
const REALMS = [
  { name: 'Westrealm', kind: 'kingdom', capital: 'Blackhall', liege: null },
  { name: 'Crownrealm', kind: 'kingdom', capital: 'Dione', liege: null },
  { name: 'Vassalrealm', kind: 'lordship', capital: 'Az', liege: 1 },
  { name: 'Eastrealm', kind: 'kingdom', capital: 'Palewood', liege: null },
] as const;
const BANDS = [
  { county: 'West March', from: 0, to: 8, seat: 'Blackhall', realm: 0 },
  { county: 'West Reach', from: 9, to: 15, seat: 'Thundercross', realm: 0 },
  { county: 'Crown Land', from: 16, to: 22, seat: 'Dione', realm: 1 },
  { county: 'Vassal Land', from: 23, to: 28, seat: 'Az', realm: 2 },
  { county: 'East Reach', from: 29, to: 34, seat: 'Darkforge', realm: 3 },
  { county: 'East March', from: 35, to: 42, seat: 'Palewood', realm: 3 },
] as const;

interface World {
  campaignId: number;
  place: (name: string) => WorldPlace;
  realmId: (name: string) => number;
  countyId: (name: string) => number;
}

/** The large map under the hand-built hierarchy above, with the crown holding a strong claim on East Reach. */
function handBuilt(): World {
  const campaignId = createCampaign(db, { name: 'The Drawn Borders', story_shape: 'structured' }).campaign_id;
  region.importRegion(db, campaignId, large, { source: 'generated' });
  const places = region.getRegion(db, campaignId)!.places;
  const place = (name: string): WorldPlace => places.find((entry) => entry.name === name)!;
  const hexes = (from: number, to: number): string[] => {
    const band: string[] = [];
    for (let q = from; q <= to; q += 1) for (let r = 0; r < 50; r += 1) band.push(`q${q}_r${r}`);
    return band;
  };

  politicsStore.saveHierarchy(db, campaignId, {
    counties: {
      counties: BANDS.map((band) => ({
        name: band.county,
        seat_place_id: place(band.seat).id,
        seat_kind: place(band.seat).tags.size === 'city' ? ('city' as const) : ('town' as const),
        hexes: hexes(band.from, band.to),
        village_place_ids: [],
        component: 0,
      })),
      edges: [],
    },
    realms: {
      realms: REALMS.map((realm) => ({
        name: realm.name,
        kind: realm.kind,
        capital_place_id: place(realm.capital).id,
        off_map: false,
        liege: realm.liege,
      })),
      county_realm: BANDS.map((band) => band.realm),
    },
    hierarchy: {
      duchies: [],
      county_duchy: BANDS.map(() => null),
      march_counties: [],
      claims: [{ county: 4, claimant_realm: 1, strength: 'strong', reason: 'ancient kingdom' }],
    },
  });

  const politics = politicsStore.getPolitics(db, campaignId)!;
  return {
    campaignId,
    place,
    realmId: (name) => politics.realms.find((realm) => realm.name === name)!.id,
    countyId: (name) => politics.counties.find((county) => county.name === name)!.id,
  };
}

function addFaction(
  world: World,
  name: string,
  type: string,
  realm: string | null,
  county: string | null,
  seat: string | null,
): WorldFaction {
  return store.insertFaction(db, world.campaignId, {
    name,
    type,
    realm_id: realm === null ? null : world.realmId(realm),
    county_id: county === null ? null : world.countyId(county),
    place_id: seat === null ? null : world.place(seat).id,
    secrecy: 'open',
    resources: 3,
    capacities: {},
    created_day: 0,
  });
}

/** Picks for one faction over many salts, abandoning each pick so the next starts from the same field. */
function pickMany(campaignId: number, faction: WorldFaction, day: number, salts: number): WorldAgenda[] {
  const picks: WorldAgenda[] = [];
  for (let salt = 1; salt <= salts; salt += 1) {
    const next = seeding.pickAgenda(db, campaignId, faction, day, SEED, salt);
    if (next === null) continue;
    picks.push(next);
    store.updateAgenda(db, campaignId, next.id, { status: 'abandoned' });
  }
  return picks;
}

function ofTemplate(picks: WorldAgenda[], template: string): WorldAgenda[] {
  return picks.filter((agenda) => agenda.template === template);
}

/** Another faction's goal in play, which takes that goal from everyone else. */
function holdGoal(world: World, holder: WorldFaction, template: string, kind: string, target: WorldPlace): void {
  store.insertAgenda(db, world.campaignId, {
    faction_id: holder.id,
    template,
    target_kind: kind,
    target_id: target.id,
    target_name: target.name,
    clock_size: 8,
    clock_filled: 0,
    portents: [{ text: 'Work goes on.', fired_day: null, heard: false }],
    status: 'active',
    started_day: 0,
  });
}

describe('expansion', () => {
  it("aims a realm only at other sovereigns' bordering counties, reaching through its vassal and favouring a claim", () => {
    const world = handBuilt();
    const crown = addFaction(world, 'The Crown', 'realm', 'Crownrealm', 'Crown Land', 'Dione');

    const expansions = ofTemplate(pickMany(world.campaignId, crown, 500, 120), 'expand_territory');
    const counts = new Map<string, number>();
    for (const agenda of expansions) counts.set(agenda.target_name, (counts.get(agenda.target_name) ?? 0) + 1);
    // East Reach borders only the vassal's land; the crown's own and its vassal's counties are never goals.
    expect([...counts.keys()].sort()).toEqual(['East Reach', 'West Reach']);
    expect(counts.get('East Reach')!).toBeGreaterThan(2 * counts.get('West Reach')!);
  });

  it("spares a holder's capital and last county, and never lets a vassal realm or a house expand", () => {
    const world = handBuilt();
    const factions = [
      // The west's only foreign neighbour is the crown's capital county, and the east's the vassal's one county.
      addFaction(world, 'The West', 'realm', 'Westrealm', 'West March', 'Blackhall'),
      addFaction(world, 'The East', 'realm', 'Eastrealm', 'East March', 'Palewood'),
      addFaction(world, 'The Vassal', 'realm', 'Vassalrealm', 'Vassal Land', 'Az'),
      addFaction(world, 'House Reach', 'house', 'Westrealm', 'West Reach', 'Thundercross'),
    ];
    expect(templatesFor('house').map((template) => template.id)).not.toContain('expand_territory');

    for (const faction of factions) {
      const picks = pickMany(world.campaignId, faction, 500, 40);
      expect(picks.length, faction.name).toBeGreaterThan(0);
      expect(ofTemplate(picks, 'expand_territory'), faction.name).toEqual([]);
    }
  });
});

describe('revolt', () => {
  it('opens to a vassal only in a rare season, the same on every day of it, and aims at its liege', () => {
    const world = handBuilt();
    const crown = addFaction(world, 'The Crown', 'realm', 'Crownrealm', 'Crown Land', 'Dione');
    const vassal = addFaction(world, 'The Vassal', 'realm', 'Vassalrealm', 'Vassal Land', 'Az');
    const guild = addFaction(world, 'Az Guild', 'guild', 'Vassalrealm', 'Vassal Land', 'Az');
    // The guild's work at Az takes the vassal's only other goal, so each pick is a revolt or nothing.
    holdGoal(world, guild, 'build', 'own_seat', world.place('Az'));

    const seasons = 200;
    let open = 0;
    for (let season = 0; season < seasons; season += 1) {
      // An idle faction picks again every day, so every day of a season must agree.
      const picks = [0, 45, 89].map((offset) => {
        const day = season * seeding.REVOLT_SEASON_DAYS + offset;
        const pick = seeding.pickAgenda(db, world.campaignId, vassal, day, SEED, 1);
        if (pick) store.updateAgenda(db, world.campaignId, pick.id, { status: 'abandoned' });
        return pick;
      });
      expect(new Set(picks.map((pick) => pick?.template ?? null)).size).toBe(1);
      if (picks[0] === null) continue;
      open += 1;
      expect(picks[0]).toMatchObject({ template: 'revolt', target_kind: 'rival_faction', target_id: crown.id });
    }
    expect(open).toBeGreaterThan(0);
    expect(open).toBeLessThan(seasons * seeding.REVOLT_CHANCE * 3);
  });

  it('sets a house against its own crown, and never a sovereign against anyone', () => {
    const world = handBuilt();
    const west = addFaction(world, 'The West', 'realm', 'Westrealm', 'West March', 'Blackhall');
    const crown = addFaction(world, 'The Crown', 'realm', 'Crownrealm', 'Crown Land', 'Dione');
    const house = addFaction(world, 'House Reach', 'house', 'Westrealm', 'West Reach', 'Thundercross');

    const revoltsOf = (faction: WorldFaction): WorldAgenda[] => {
      const found: WorldAgenda[] = [];
      for (let season = 0; season < 60 && found.length === 0; season += 1) {
        found.push(...ofTemplate(pickMany(world.campaignId, faction, season * seeding.REVOLT_SEASON_DAYS, 4), 'revolt'));
      }
      return found;
    };
    const houseRevolts = revoltsOf(house);
    expect(houseRevolts.length).toBeGreaterThan(0);
    for (const agenda of houseRevolts) expect(agenda).toMatchObject({ target_kind: 'rival_faction', target_id: west.id });
    expect(revoltsOf(crown)).toEqual([]);
    expect(revoltsOf(west)).toEqual([]);
  }, 20000);
});

describe('rivals', () => {
  it('sets a house feuding only with a house of the same or a bordering county', () => {
    const world = handBuilt();
    const march = addFaction(world, 'House March', 'house', 'Westrealm', 'West March', 'Red Mill');
    const reach = addFaction(world, 'House Reach', 'house', 'Westrealm', 'West Reach', 'Thundercross');
    const east = addFaction(world, 'House East', 'house', 'Eastrealm', 'East Reach', 'Darkforge');
    addFaction(world, 'Blackhall Guild', 'guild', 'Westrealm', 'West March', 'Blackhall');
    expect(placeDistance(world.place('Red Mill'), world.place('Thundercross'))).toBeGreaterThan(seeding.NEIGHBOUR_HEXES);

    const feuds = ofTemplate(pickMany(world.campaignId, reach, 500, 60), 'feud');
    expect(feuds.length).toBeGreaterThan(0);
    for (const agenda of feuds) expect(agenda.target_id).toBe(march.id);
    // Two counties apart and far beyond a short ride, the eastern house has no one to feud with.
    expect(ofTemplate(pickMany(world.campaignId, east, 500, 60), 'feud')).toEqual([]);
  });

  it('sets a guild only against neighbouring guilds, by county border or a short ride', () => {
    const world = handBuilt();
    const az = addFaction(world, 'Az Guild', 'guild', 'Vassalrealm', 'Vassal Land', 'Az');
    const dark = addFaction(world, 'Darkforge Guild', 'guild', 'Eastrealm', 'East Reach', 'Darkforge');
    const road = addFaction(world, 'Road Guild', 'guild', null, null, 'Twilight Road');
    const black = addFaction(world, 'Blackhall Guild', 'guild', 'Westrealm', 'West March', 'Blackhall');
    addFaction(world, 'House Reach', 'house', 'Westrealm', 'West Reach', 'Thundercross');
    expect(placeDistance(world.place('Twilight Road'), world.place('Az'))).toBeLessThanOrEqual(seeding.NEIGHBOUR_HEXES);
    expect(placeDistance(world.place('Twilight Road'), world.place('Darkforge'))).toBeGreaterThan(seeding.NEIGHBOUR_HEXES);

    const targetsOf = (faction: WorldFaction): Set<number | null> =>
      new Set(ofTemplate(pickMany(world.campaignId, faction, 500, 90), 'trade_monopoly').map((agenda) => agenda.target_id));
    expect(targetsOf(az)).toEqual(new Set([dark.id, road.id]));
    expect(targetsOf(road)).toEqual(new Set([az.id]));
    // Its only neighbour is a noble house, which a guild never forces out of trade.
    expect(targetsOf(black)).toEqual(new Set());
  });
});

describe('settlement goals', () => {
  it('preaches only in towns of another faith, never in its own seat', () => {
    const world = handBuilt();
    const faith = (name: string) =>
      faithStore.insertFaith(db, world.campaignId, {
        name,
        aspect: 'sun',
        symbol: 'sun',
        head_place_id: null,
        fervor: 50,
        heresy_of: null,
        last_heresy_day: null,
        created_day: 0,
      });
    const dawn = faith('The Dawn');
    const night = faith('The Night');
    const temple = addFaction(world, 'Temple of Dawn', 'church', 'Crownrealm', null, 'Dione');
    const rival = addFaction(world, 'Temple of Night', 'church', 'Eastrealm', null, 'Palewood');
    faithStore.setFactionFaith(db, world.campaignId, temple.id, dawn.id, 'minor');
    faithStore.setFactionFaith(db, world.campaignId, rival.id, night.id, 'strong');
    // An eastern town that already turned to the Dawn is no longer a field for it.
    placeState.setPlaceState(db, world.campaignId, world.place('Redfield').id, 0, { faith_id: dawn.id });

    const conversions = ofTemplate(pickMany(world.campaignId, temple, 500, 80), 'conversion');
    expect(conversions.length).toBeGreaterThan(0);
    const faiths = conversions.map((agenda) => placeState.settlementFaithId(db, world.campaignId, agenda.target_id!));
    expect(faiths).not.toContain(dawn.id);
    expect(faiths).toContain(night.id);
    const names = conversions.map((agenda) => agenda.target_name);
    for (const name of ['Dione', 'Whitehurst', 'Redfield']) expect(names).not.toContain(name);
  }, 20000);

  it('never sends a gang to raid its own town, nor anywhere when no town is near', () => {
    const world = handBuilt();
    const gang = addFaction(world, 'Darkforge Knives', 'gang', 'Eastrealm', 'East Reach', 'Darkforge');
    const raids = ofTemplate(pickMany(world.campaignId, gang, 500, 40), 'raid');
    expect(raids.length).toBeGreaterThan(0);
    for (const agenda of raids) {
      expect(agenda.target_id).not.toBe(world.place('Darkforge').id);
      expect(placeDistance(world.place('Darkforge'), world.place(agenda.target_name))).toBeLessThanOrEqual(5);
    }

    const settlements = region.getRegion(db, world.campaignId)!.places.filter((place) => place.kind === 'settlement');
    const lonely = settlements.find((place) =>
      settlements.every((other) => other.id === place.id || placeDistance(place, other) > 5),
    )!;
    expect(lonely).toBeDefined();
    const loner = addFaction(world, 'Lonely Knives', 'gang', null, null, lonely.name);
    expect(ofTemplate(pickMany(world.campaignId, loner, 500, 40), 'raid')).toEqual([]);
  });
});

describe('size gating', () => {
  it('raises a cathedral only at a city seat', () => {
    const world = handBuilt();
    expect(world.place('Dione').tags.size).toBe('city');
    expect(world.place('Palewood').tags.size).toBe('town');
    const city = addFaction(world, 'Temple of Dione', 'church', 'Crownrealm', null, 'Dione');
    const town = addFaction(world, 'Temple of Palewood', 'church', 'Eastrealm', null, 'Palewood');
    const crown = addFaction(world, 'The East', 'realm', 'Eastrealm', 'East March', 'Palewood');
    const faith = faithStore.insertFaith(db, world.campaignId, {
      name: 'The Dawn',
      aspect: 'sun',
      symbol: 'sun',
      head_place_id: null,
      fervor: 50,
      heresy_of: null,
      last_heresy_day: null,
      created_day: 0,
    });
    faithStore.setFactionFaith(db, world.campaignId, city.id, faith.id, 'strong');
    faithStore.setFactionFaith(db, world.campaignId, town.id, faith.id, 'strong');
    // Even a crown holding its faith as a theocracy raises none in a town.
    faithStore.setFactionFaith(db, world.campaignId, crown.id, faith.id, 'dominant');

    expect(ofTemplate(pickMany(world.campaignId, city, 500, 60), 'raise_cathedral').length).toBeGreaterThan(0);
    for (const faction of [town, crown]) {
      const picks = pickMany(world.campaignId, faction, 500, 60);
      expect(picks.length, faction.name).toBeGreaterThan(0);
      expect(ofTemplate(picks, 'raise_cathedral'), faction.name).toEqual([]);
    }
  }, 20000);

  it('builds again only after a cooldown scaled to the size of the seat', () => {
    const world = handBuilt();
    for (const [seat, size] of [
      ['Dione', 'city'],
      ['Palewood', 'town'],
      ['Red Mill', 'village'],
    ] as const) {
      expect(world.place(seat).tags.size).toBe(size);
      const guild = addFaction(world, `${seat} Guild`, 'guild', null, null, seat);
      const built = store.insertAgenda(db, world.campaignId, {
        faction_id: guild.id,
        template: 'build',
        target_kind: 'own_seat',
        target_id: world.place(seat).id,
        target_name: seat,
        clock_size: 8,
        clock_filled: 8,
        portents: [{ text: 'Scaffolding rises.', fired_day: 990, heard: false }],
        status: 'active',
        started_day: 900,
      });
      store.updateAgenda(db, world.campaignId, built.id, { status: 'won', resolved_day: 1000 });

      const wait = seeding.BUILD_COOLDOWN_DAYS[size];
      expect(ofTemplate(pickMany(world.campaignId, guild, 1000 + wait - 1, 30), 'build'), seat).toEqual([]);
      expect(ofTemplate(pickMany(world.campaignId, guild, 1000 + wait, 30), 'build').length, seat).toBeGreaterThan(0);
    }
    expect(seeding.BUILD_COOLDOWN_DAYS.city).toBeLessThan(seeding.BUILD_COOLDOWN_DAYS.town);
    expect(seeding.BUILD_COOLDOWN_DAYS.town).toBeLessThan(seeding.BUILD_COOLDOWN_DAYS.village);
  });
});

describe('a year on the large map', () => {
  it("never has a realm take its own or a vassal's county, nor a house expand", () => {
    const campaignId = createCampaign(db, { name: 'A Year Abroad', story_shape: 'structured' }).campaign_id;
    region.importRegion(db, campaignId, large, { source: 'generated' });
    seeding.ensureWorld(db, campaignId);
    const start = store.currentGameDay(db, campaignId);
    for (let call = 1; call <= 6; call += 1) tickTo(db, campaignId, start + 60 * call);

    // A few extra picks for every realm make sure expansion was really tried, whatever the world seed.
    const factions = store.listFactions(db, campaignId);
    for (const realm of factions.filter((faction) => faction.type === 'realm')) {
      pickMany(campaignId, realm, start + 361, 20);
    }

    const politics = politicsStore.getPolitics(db, campaignId)!;
    const sovereignOf = (realmId: number): number => {
      let realm = politics.realms.find((entry) => entry.id === realmId)!;
      while (realm.liege_realm_id !== null) realm = politics.realms.find((entry) => entry.id === realm.liege_realm_id)!;
      return realm.id;
    };
    const expansions = store.listAgendas(db, campaignId).filter((agenda) => agenda.template === 'expand_territory');
    expect(expansions.length).toBeGreaterThan(0);
    const ownTaking = expansions.filter((agenda) => {
      const faction = factions.find((entry) => entry.id === agenda.faction_id)!;
      const county = politics.counties.find((entry) => entry.id === agenda.target_id)!;
      return faction.type !== 'realm' || sovereignOf(county.realm_id) === sovereignOf(faction.realm_id!);
    });
    expect(ownTaking).toEqual([]);
  }, 120000);
});
