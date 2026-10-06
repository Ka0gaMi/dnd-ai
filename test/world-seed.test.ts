// The living world's first day: governments, the factions the map implies and one agenda each.
// randomSeed is stubbed so the same world seed can be replayed across two databases.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import type { ComputedCounties, ComputedHierarchy, ComputedRealms } from '../src/core/politics-types.js';
import type { WorldPlace } from '../src/core/region.js';

vi.mock('../src/core/dice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/dice.js')>();
  return { ...actual, randomSeed: () => 12345 };
});

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;
const large = JSON.parse(
  readFileSync(new URL('./fixtures/realm-large.json', import.meta.url), 'utf8'),
) as unknown;

let db: Db;
let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let upsertEntity: (typeof import('../src/core/codex.js'))['upsertEntity'];
let listFactions: (typeof import('../src/core/world-store.js'))['listFactions'];
let listAgendas: (typeof import('../src/core/world-store.js'))['listAgendas'];
let insertAgenda: (typeof import('../src/core/world-store.js'))['insertAgenda'];
let updateAgenda: (typeof import('../src/core/world-store.js'))['updateAgenda'];
let pickAgenda: (typeof import('../src/core/world-seed.js'))['pickAgenda'];
let getRegion: (typeof import('../src/core/region.js'))['getRegion'];
let findPlace: (typeof import('../src/core/region.js'))['findPlace'];
let saveHierarchy: (typeof import('../src/core/politics-store.js'))['saveHierarchy'];
let insertFaction: (typeof import('../src/core/world-store.js'))['insertFaction'];
let insertFaith: (typeof import('../src/core/world-faith-store.js'))['insertFaith'];
let listFaiths: (typeof import('../src/core/world-faith-store.js'))['listFaiths'];
let setFactionFaith: (typeof import('../src/core/world-faith-store.js'))['setFactionFaith'];
let setExcommunicated: (typeof import('../src/core/world-faith-store.js'))['setExcommunicated'];
let factionFaith: (typeof import('../src/core/world-faith-store.js'))['factionFaith'];
let setPlaceState: (typeof import('../src/core/world-place-state.js'))['setPlaceState'];

beforeAll(async () => {
  // With isolate: false an earlier file in this worker may have cached dice.ts without the stub, so
  // drop the module cache and import the world seed fresh under the mock.
  vi.resetModules();
  ({ ensureWorld, pickAgenda } = await import('../src/core/world-seed.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion, getRegion, findPlace } = await import('../src/core/region.js'));
  ({ saveHierarchy } = await import('../src/core/politics-store.js'));
  ({ upsertEntity } = await import('../src/core/codex.js'));
  ({ listFactions, listAgendas, insertAgenda, insertFaction, updateAgenda } = await import(
    '../src/core/world-store.js'
  ));
  ({ insertFaith, listFaiths, setFactionFaith, setExcommunicated, factionFaith } = await import(
    '../src/core/world-faith-store.js'
  ));
  ({ setPlaceState } = await import('../src/core/world-place-state.js'));
});

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(target: Db = db, name = 'The Ashfall Road'): number {
  return createCampaign(target, { name, story_shape: 'structured' }).campaign_id;
}

function withRegion(realm: unknown, target: Db = db): number {
  const campaignId = newCampaign(target);
  importRegion(target, campaignId, realm, { source: 'generated' });
  return campaignId;
}

/** Renames the dangerous island's two dungeons as lairs, since only a lair-named danger holds a brood. */
function lairDangers(campaignId: number): void {
  const rename = db.prepare('UPDATE world_place SET name = ? WHERE campaign_id = ? AND name = ?');
  rename.run('Nest Of The Vampire Queen', campaignId, 'Ziggurat Of The Vampire Queen');
  rename.run('Hidden Den', campaignId, 'Hidden Keep');
}

function realmRow(campaignId: number): { name: string; government: string | null; ruler_title: string | null } {
  return db
    .prepare('SELECT name, government, ruler_title FROM world_realm WHERE campaign_id = ?')
    .get(campaignId) as { name: string; government: string | null; ruler_title: string | null };
}

describe('ensureWorld without a region', () => {
  it('returns null', () => {
    expect(ensureWorld(db, newCampaign())).toBeNull();
  });
});

describe('ensureWorld on the safe realm', () => {
  it('seeds governments, factions and an agenda for each that can find a goal', () => {
    const campaignId = withRegion(safe);
    const summary = ensureWorld(db, campaignId)!;
    expect(summary).toEqual({ seed: 12345, factions: 6, agendas: 6, created: true });

    // The capital county is the crown's own, so it has no house; only the city keeps a gang.
    const factions = listFactions(db, campaignId);
    expect(factions.map((faction) => faction.name)).toEqual([
      'Theocracy of Ficengwind',
      'Bishopric of Redham',
      'Bishopric of Southern Landing',
      "Redham Merchants' Guild",
      "Ficengwind Merchants' Guild",
      'The Ficengwind Knives',
    ]);
    expect(factions.filter((faction) => faction.type === 'church')).toEqual([]);
    expect(factions.find((faction) => faction.name === 'The Ficengwind Knives')?.secrecy).toBe('discreet');

    expect(realmRow(campaignId)).toMatchObject({
      name: 'Theocracy of Ficengwind',
      government: 'theocracy',
      ruler_title: 'Pontiff',
    });

    const agendas = listAgendas(db, campaignId);
    expect(agendas).toHaveLength(6);
    // The six factions compete for a fixed pool of goals, so one may find every target taken.
    for (const faction of factions) {
      expect(agendas.filter((agenda) => agenda.faction_id === faction.id).length).toBeLessThanOrEqual(1);
    }
    const factionsWithAgenda = factions.filter((faction) =>
      agendas.some((agenda) => agenda.faction_id === faction.id),
    ).length;
    expect(factionsWithAgenda).toBeGreaterThanOrEqual(factions.length - 1);
    for (const agenda of agendas) {
      expect(agenda.status).toBe('active');
      expect(agenda.portents.length).toBeGreaterThan(0);
      for (const portent of agenda.portents) expect(portent.text).not.toContain('{');
    }
  });

  it('reports the existing world on a second call without adding rows', () => {
    const campaignId = withRegion(safe);
    ensureWorld(db, campaignId);

    const again = ensureWorld(db, campaignId)!;
    expect(again).toEqual({ seed: 12345, factions: 6, agendas: 6, created: false });
    expect(listFactions(db, campaignId)).toHaveLength(6);
    expect(listAgendas(db, campaignId)).toHaveLength(6);
  });
});

describe('ensureWorld on the dangerous realm', () => {
  it('seeds a lordship as its realm alone, a bandit band in the wild, a temple and two broods at the lairs', () => {
    const campaignId = withRegion(dangerous);
    lairDangers(campaignId);
    expect(ensureWorld(db, campaignId)!.created).toBe(true);

    const factions = listFactions(db, campaignId);
    expect(factions.map((faction) => faction.name)).toEqual([
      'Lordship of Crimson Wharf',
      'The Vampires of Nest Of The Vampire Queen',
      'The Beasts of Hidden Den',
      'The Crimson Wharf Reavers',
      'Temple of Crimson Wharf',
    ]);
    const bandits = factions.find((faction) => faction.type === 'bandits')!;
    expect(bandits).toMatchObject({ secrecy: 'discreet', place_id: findPlace(db, campaignId, 'Shadowscale Ridge')!.id });

    const monsterAgendas = listAgendas(db, campaignId).filter((agenda) =>
      factions.some((faction) => faction.id === agenda.faction_id && faction.type === 'monsters'),
    );
    expect(monsterAgendas).toHaveLength(2);
    for (const agenda of monsterAgendas) {
      expect(['Frostcot', 'Crimson Wharf']).toContain(agenda.target_name);
    }
  });
});

interface LargePlaces {
  winterburg: WorldPlace;
  underfield: WorldPlace;
  redfield: WorldPlace;
  shatteredCitadel: WorldPlace;
  az: WorldPlace;
  palewood: WorldPlace;
}

/** A kingdom with a ducal seat, a march and a castle lordship, plus a free city and an off-map realm. */
function handcraftedLarge(places: LargePlaces): {
  counties: ComputedCounties;
  realms: ComputedRealms;
  hierarchy: ComputedHierarchy;
} {
  const county = (name: string, seat: WorldPlace, seat_kind: 'city' | 'town' | 'castle') => ({
    name,
    seat_place_id: seat.id,
    seat_kind,
    hexes: [seat.hexes[0]],
    village_place_ids: [],
    component: 0,
  });

  return {
    counties: {
      counties: [
        county('County of Winterburg', places.winterburg, 'town'),
        county('County of Underfield', places.underfield, 'city'),
        county('Redfield March', places.redfield, 'town'),
        county('Citadel Lordship', places.shatteredCitadel, 'castle'),
        county('Free City of Az', places.az, 'city'),
        county('Palewood County', places.palewood, 'town'),
      ],
      edges: [],
    },
    realms: {
      realms: [
        {
          name: 'Empire of Winterburg',
          kind: 'kingdom',
          capital_place_id: places.winterburg.id,
          off_map: false,
          liege: null,
        },
        {
          name: 'Free City of Az',
          kind: 'free_city',
          capital_place_id: places.az.id,
          off_map: false,
          liege: null,
        },
        {
          name: 'The Kingdom beyond Pank',
          kind: 'kingdom',
          capital_place_id: null,
          off_map: true,
          liege: null,
        },
      ],
      county_realm: [0, 0, 0, 0, 1, 2],
    },
    hierarchy: {
      duchies: [
        {
          name: 'Crownlands of Winterburg',
          realm: 0,
          seat_place_id: places.winterburg.id,
          county_indexes: [0],
          demesne: true,
          joined_how: 'core',
        },
        {
          name: 'Duchy of Underfield',
          realm: 0,
          seat_place_id: places.underfield.id,
          county_indexes: [1, 2, 3],
          demesne: false,
          joined_how: 'conquest',
        },
      ],
      county_duchy: [0, 1, 1, 1, null, null],
      march_counties: [2],
      claims: [],
    },
  };
}

describe('ensureWorld on a handcrafted hierarchy', () => {
  it('gives each realm kind a fitting government and each county a fitting house', () => {
    const campaignId = withRegion(large);
    saveHierarchy(db, campaignId, handcraftedLarge({
      winterburg: findPlace(db, campaignId, 'Winterburg')!,
      underfield: findPlace(db, campaignId, 'Underfield')!,
      redfield: findPlace(db, campaignId, 'Redfield')!,
      shatteredCitadel: findPlace(db, campaignId, 'Shattered Citadel')!,
      az: findPlace(db, campaignId, 'Az')!,
      palewood: findPlace(db, campaignId, 'Palewood')!,
    }));
    expect(ensureWorld(db, campaignId)!.created).toBe(true);

    const names = listFactions(db, campaignId).map((faction) => faction.name);
    expect(names).toEqual(
      expect.arrayContaining(['Ducal House of Underfield', 'Margraves of Redfield', 'House of Palewood']),
    );
    // The crown holds its capital county and a free city is its own realm, so neither has a house.
    expect(names).not.toContain('House of Winterburg');
    expect(names).not.toContain('Magistracy of Az');

    const realms = db
      .prepare('SELECT name, government, ruler_title FROM world_realm WHERE campaign_id = ? ORDER BY id')
      .all(campaignId) as Array<{ name: string; government: string; ruler_title: string }>;
    expect(realms).toHaveLength(3);
    // Four counties make an empire only on an XL map, and this one is large.
    expect(realms[0]).toMatchObject({ name: 'Kingdom of Winterburg', government: 'kingdom', ruler_title: 'King' });
    expect(realms[1]).toMatchObject({ name: 'Free City of Az', government: 'free_city' });
    // With no capital on the map the off-map realm derives a league, so it keeps a Speaker.
    expect(realms[2]).toMatchObject({
      name: 'The Kingdom beyond Pank',
      government: 'kingdom',
      ruler_title: 'High King',
    });
  });

  it('crowns a principality and keeps an off-map government its own ruler', () => {
    const campaignId = withRegion(large);
    const az = findPlace(db, campaignId, 'Az')!;
    const winterburg = findPlace(db, campaignId, 'Winterburg')!;
    const ecthel = findPlace(db, campaignId, 'Ecthel')!;
    const [underfield, redfield, palewood, thundercross] = ['Underfield', 'Redfield', 'Palewood', 'Thundercross'].map(
      (name) => findPlace(db, campaignId, name)!,
    );
    const county = (name: string, seat: WorldPlace, seat_kind: 'city' | 'town') => ({
      name,
      seat_place_id: seat.id,
      seat_kind,
      hexes: [seat.hexes[0]],
      village_place_ids: [],
      component: 0,
    });

    saveHierarchy(db, campaignId, {
      counties: {
        counties: [
          county('Principality Seat', az, 'city'),
          county('Winterburg County', winterburg, 'town'),
          county('Underfield County', underfield, 'city'),
          county('Redfield County', redfield, 'town'),
          county('Palewood County', palewood, 'town'),
          county('Thundercross County', thundercross, 'city'),
        ],
        edges: [],
      },
      realms: {
        realms: [
          {
            name: 'Principality of Az',
            kind: 'lordship',
            capital_place_id: az.id,
            off_map: false,
            liege: null,
          },
          {
            name: 'Empire beyond the Hills',
            kind: 'kingdom',
            capital_place_id: ecthel.id,
            off_map: true,
            liege: null,
          },
          {
            name: 'The Kingdom beyond Pank',
            kind: 'kingdom',
            capital_place_id: winterburg.id,
            off_map: true,
            liege: null,
          },
        ],
        county_realm: [0, 2, 1, 1, 1, 1],
      },
      hierarchy: {
        duchies: [],
        county_duchy: [null, null, null, null, null, null],
        march_counties: [],
        claims: [],
      },
    });
    expect(ensureWorld(db, campaignId)!.created).toBe(true);

    const realms = db
      .prepare(
        'SELECT name, government, realm_title, ruler_title FROM world_realm WHERE campaign_id = ? ORDER BY id',
      )
      .all(campaignId) as Array<{ name: string; government: string; realm_title: string; ruler_title: string }>;
    expect(realms).toHaveLength(3);
    expect(realms[0]).toMatchObject({
      name: 'Principality of Az',
      government: 'kingdom',
      realm_title: 'Principality',
      ruler_title: 'Prince',
    });
    // An off-map realm of four counties may be an empire on any map, and keeps its Emperor.
    expect(realms[1]).toMatchObject({
      name: 'Empire beyond the Hills',
      government: 'empire',
      ruler_title: 'Emperor',
    });
    expect(realms[2]).toMatchObject({
      name: 'The Kingdom beyond Pank',
      government: 'kingdom',
      ruler_title: 'High King',
    });
  });
});

describe('ensureWorld determinism', () => {
  it('replays identical factions and agendas for the same world seed', () => {
    const first = openDb(':memory:');
    const second = openDb(':memory:');
    const a = withRegion(safe, first);
    const b = withRegion(safe, second);
    ensureWorld(first, a);
    ensureWorld(second, b);

    const names = (target: Db, campaignId: number): string[] =>
      listFactions(target, campaignId).map((faction) => faction.name);
    const agendaOf = (target: Db, campaignId: number): Array<{ template: string; target_name: string }> =>
      listAgendas(target, campaignId).map((agenda) => ({
        template: agenda.template,
        target_name: agenda.target_name,
      }));

    expect(names(first, a)).toEqual(names(second, b));
    expect(agendaOf(first, a)).toEqual(agendaOf(second, b));
  });
});

describe('ensureWorld and the codex', () => {
  it('keeps a realm name the codex already uses', () => {
    const campaignId = withRegion(safe);
    upsertEntity(db, { campaign_id: campaignId, kind: 'faction', name: 'Kingdom of Ficengwind' });

    ensureWorld(db, campaignId);

    expect(realmRow(campaignId)).toMatchObject({
      name: 'Kingdom of Ficengwind',
      government: 'theocracy',
      ruler_title: 'Pontiff',
    });
  });
});

describe('pickAgenda after a settling win', () => {
  it('never sends a faction back after a settling win', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const temple = listFactions(db, campaignId).find((faction) => faction.type === 'church')!;
    const settlement = getRegion(db, campaignId)!.places.find((place) => place.kind === 'settlement')!;
    const first = insertAgenda(db, campaignId, {
      faction_id: temple.id,
      template: 'conversion',
      target_kind: 'settlement',
      target_id: settlement.id,
      target_name: settlement.name,
      clock_size: 6,
      clock_filled: 0,
      portents: [{ text: 'Preachers arrive.', fired_day: null, heard: false }],
      status: 'active',
      started_day: 1,
    });
    updateAgenda(db, campaignId, first.id, { status: 'won', resolved_day: 1 });

    // The island keeps one faith and the temple's hunt and the crown's work at its seat are in play, so it idles.
    const day = 1 + 365;
    for (let salt = 1; salt <= 20; salt += 1) {
      expect(pickAgenda(db, campaignId, temple, day, 7, salt)).toBeNull();
    }

    // With the town of another faith again and its other goals free, it still never goes back there.
    const stranger = insertFaith(db, campaignId, {
      name: 'The Drowned Choir',
      aspect: 'sea',
      symbol: 'sunken bell',
      head_place_id: null,
      fervor: 50,
      heresy_of: null,
      last_heresy_day: null,
      created_day: 1,
    });
    setPlaceState(db, campaignId, settlement.id, day, { faith_id: stranger.id });
    for (const agenda of listAgendas(db, campaignId, { status: 'active' })) {
      updateAgenda(db, campaignId, agenda.id, { status: 'abandoned' });
    }
    let picks = 0;
    for (let salt = 1; salt <= 20; salt += 1) {
      const next = pickAgenda(db, campaignId, temple, day, 7, salt);
      if (next === null) continue;
      picks += 1;
      expect(`${next.template}:${next.target_id}`).not.toBe(`conversion:${settlement.id}`);
      updateAgenda(db, campaignId, next.id, { status: 'abandoned' });
    }
    expect(picks).toBeGreaterThan(0);
  });
});

describe('pickAgenda public portents', () => {
  it('names a settlement, not the danger, in a monsters_grow portent', () => {
    const campaignId = withRegion(dangerous);
    lairDangers(campaignId);
    ensureWorld(db, campaignId);
    abandonAll(campaignId);
    const brood = listFactions(db, campaignId).find((faction) => faction.type === 'monsters')!;
    const view = getRegion(db, campaignId)!;
    const settlements = view.places.filter((place) => place.kind === 'settlement').map((place) => place.name);
    const dangers = view.places.filter((place) => place.kind === 'danger').map((place) => place.name);

    let grow: ReturnType<typeof pickAgenda> = null;
    for (let salt = 1; salt <= 60 && grow === null; salt += 1) {
      const next = pickAgenda(db, campaignId, brood, 100, 7, salt);
      if (next === null) continue;
      if (next.template === 'monsters_grow') grow = next;
      updateAgenda(db, campaignId, next.id, { status: 'abandoned' });
    }
    expect(grow).not.toBeNull();

    const portent = grow!.portents[0]!.text;
    expect(settlements.some((name) => portent.includes(name))).toBe(true);
    for (const danger of dangers) expect(portent).not.toContain(danger);
    expect(portent).not.toContain('The Vampires of');
    expect(portent).not.toContain('The Beasts of');
  });
});

describe('pickAgenda and held goals', () => {
  it('never picks a goal another faction is holding', () => {
    const campaignId = withRegion(dangerous);
    lairDangers(campaignId);
    ensureWorld(db, campaignId);
    for (const agenda of listAgendas(db, campaignId)) {
      updateAgenda(db, campaignId, agenda.id, { status: 'abandoned' });
    }
    const broods = listFactions(db, campaignId).filter((faction) => faction.type === 'monsters');
    const holder = broods[0]!;
    const picker = broods[1]!;

    // Both monster templates share one target: the settlement nearest the brood's danger.
    const sample = pickAgenda(db, campaignId, picker, 100, 7, 1)!;
    updateAgenda(db, campaignId, sample.id, { status: 'abandoned' });
    const heldTarget = sample.target_id!;

    insertAgenda(db, campaignId, {
      faction_id: holder.id,
      template: 'raid',
      target_kind: 'settlement',
      target_id: heldTarget,
      target_name: sample.target_name,
      clock_size: 4,
      clock_filled: 4,
      portents: [{ text: 'Held.', fired_day: null, heard: false }],
      status: 'held',
      started_day: 1,
    });

    let picked = 0;
    for (let salt = 1; salt <= 40; salt += 1) {
      const next = pickAgenda(db, campaignId, picker, 100, 7, salt);
      if (next === null) continue;
      picked += 1;
      expect(`${next.template}:${next.target_kind}:${next.target_id}`).not.toBe(`raid:settlement:${heldTarget}`);
      updateAgenda(db, campaignId, next.id, { status: 'abandoned' });
    }
    expect(picked).toBe(40);
  });
});

type PickedAgenda = NonNullable<ReturnType<typeof pickAgenda>>;

/** Abandons every seeded agenda so a faction under test starts with an empty field. */
function abandonAll(campaignId: number): void {
  for (const agenda of listAgendas(db, campaignId)) {
    updateAgenda(db, campaignId, agenda.id, { status: 'abandoned' });
  }
}

/** Picks for one faction over many salts, abandoning each pick so the next call starts fresh. */
function pickMany(campaignId: number, factionId: number, day: number, salts: number): PickedAgenda[] {
  const picks: PickedAgenda[] = [];
  for (let salt = 1; salt <= salts; salt += 1) {
    const faction = listFactions(db, campaignId).find((entry) => entry.id === factionId);
    if (!faction) break;
    const next = pickAgenda(db, campaignId, faction, day, 7, salt);
    if (next === null) continue;
    picks.push(next);
    updateAgenda(db, campaignId, next.id, { status: 'abandoned' });
  }
  return picks;
}

describe('pickAgenda and faith politics', () => {
  /** A faction acts from its seat, so one whose realm has no capital needs one for seat-bound goals. */
  function seatFaction(campaignId: number, factionId: number): void {
    db.prepare('UPDATE world_faction SET place_id = ? WHERE id = ? AND campaign_id = ?').run(
      findPlace(db, campaignId, 'Frostcot')!.id,
      factionId,
      campaignId,
    );
  }

  /** A breakaway faith and the discreet church faction that follows it. */
  function addHeresy(campaignId: number, parentFaithId: number): { heresyFactionId: number } {
    const heresy = insertFaith(db, campaignId, {
      name: 'The Sunless Path',
      aspect: 'sun',
      symbol: 'eclipsed sun',
      head_place_id: null,
      fervor: 70,
      heresy_of: parentFaithId,
      last_heresy_day: null,
      created_day: 361,
    });
    const faction = insertFaction(db, campaignId, {
      name: 'The Sunless Path',
      type: 'church',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'discreet',
      resources: 2,
      capacities: {},
      created_day: 361,
    });
    setFactionFaith(db, campaignId, faction.id, heresy.id, 'minor');
    return { heresyFactionId: faction.id };
  }

  function templeRealmAndFaith(campaignId: number): {
    temple: ReturnType<typeof listFactions>[number];
    realm: ReturnType<typeof listFactions>[number];
    faith: ReturnType<typeof listFaiths>[number];
  } {
    const factions = listFactions(db, campaignId);
    return {
      temple: factions.find((faction) => faction.type === 'church')!,
      realm: factions.find((faction) => faction.type === 'realm')!,
      faith: listFaiths(db, campaignId)[0]!,
    };
  }

  it('never lets a minor temple call a crusade or hunt heretics', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const { temple, faith } = templeRealmAndFaith(campaignId);
    seatFaction(campaignId, temple.id);
    addHeresy(campaignId, faith.id);
    setFactionFaith(db, campaignId, temple.id, faith.id, 'minor');
    abandonAll(campaignId);

    const templates = pickMany(campaignId, temple.id, 500, 60).map((agenda) => agenda.template);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates).not.toContain('crusade');
    expect(templates).not.toContain('persecute');
  });

  it('lets a strong temple call a crusade and raise a cathedral', () => {
    const campaignId = withRegion(dangerous);
    // A crusade marches only on a danger a living brood lairs at.
    lairDangers(campaignId);
    ensureWorld(db, campaignId);
    const { temple, faith } = templeRealmAndFaith(campaignId);
    seatFaction(campaignId, temple.id);
    // A cathedral rises only in a city, and this island has none, so the temple's seat becomes one.
    db.prepare("UPDATE world_place SET tags_json = json_set(tags_json, '$.size', 'city') WHERE campaign_id = ? AND name = ?").run(
      campaignId,
      'Frostcot',
    );
    setFactionFaith(db, campaignId, temple.id, faith.id, 'strong');
    abandonAll(campaignId);

    const templates = pickMany(campaignId, temple.id, 500, 80).map((agenda) => agenda.template);
    expect(templates).toContain('crusade');
    expect(templates).toContain('raise_cathedral');
  });

  it('lets a strong orthodox temple persecute a heresy', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const { temple, faith } = templeRealmAndFaith(campaignId);
    const { heresyFactionId } = addHeresy(campaignId, faith.id);
    setFactionFaith(db, campaignId, temple.id, faith.id, 'strong');
    abandonAll(campaignId);

    const persecutions = pickMany(campaignId, temple.id, 500, 80).filter(
      (agenda) => agenda.template === 'persecute',
    );
    expect(persecutions.length).toBeGreaterThan(0);
    for (const agenda of persecutions) {
      expect(agenda.target_kind).toBe('rival_faction');
      expect(agenda.target_id).toBe(heresyFactionId);
    }
  });

  it('lets a crown seize church lands only once its realm holds a strong temple', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const { temple, realm, faith } = templeRealmAndFaith(campaignId);
    setFactionFaith(db, campaignId, temple.id, faith.id, 'minor');
    abandonAll(campaignId);

    const minorPicks = pickMany(campaignId, realm.id, 500, 60).map((agenda) => agenda.template);
    expect(minorPicks.length).toBeGreaterThan(0);
    expect(minorPicks).not.toContain('seize_church_lands');

    setFactionFaith(db, campaignId, temple.id, faith.id, 'strong');
    const strongPicks = pickMany(campaignId, realm.id, 500, 60).map((agenda) => agenda.template);
    expect(strongPicks).toContain('seize_church_lands');
  });

  it('never lets a templeless theocracy seize church lands', () => {
    const campaignId = withRegion(safe);
    ensureWorld(db, campaignId);
    const factions = listFactions(db, campaignId);
    expect(factions.some((faction) => faction.type === 'church')).toBe(false);
    const realm = factions.find((faction) => faction.type === 'realm')!;
    abandonAll(campaignId);

    const templates = pickMany(campaignId, realm.id, 500, 60).map((agenda) => agenda.template);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates).not.toContain('seize_church_lands');
  });

  it("lets a theocracy's ruling realm raise a cathedral and persecute a heresy", () => {
    const campaignId = withRegion(safe);
    ensureWorld(db, campaignId);
    const realm = listFactions(db, campaignId).find((faction) => faction.type === 'realm')!;
    expect(factionFaith(db, campaignId, realm.id)).toEqual({
      faith_id: expect.any(Number),
      influence: 'dominant',
    });
    const faith = listFaiths(db, campaignId)[0]!;
    const { heresyFactionId } = addHeresy(campaignId, faith.id);
    abandonAll(campaignId);

    // The safe realm holds no danger, so a crusade has no target there.
    const picks = pickMany(campaignId, realm.id, 500, 120);
    const templates = picks.map((agenda) => agenda.template);
    expect(templates).toContain('raise_cathedral');
    const persecutions = picks.filter((agenda) => agenda.template === 'persecute');
    expect(persecutions.length).toBeGreaterThan(0);
    for (const agenda of persecutions) expect(agenda.target_id).toBe(heresyFactionId);
  });

  it('never lets a non-theocracy realm run the faith goals, even under a strong faith', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const { realm, faith } = templeRealmAndFaith(campaignId);
    // Seat the crown and give it a strong faith with a heresy in reach, so only the dominance gate blocks it.
    seatFaction(campaignId, realm.id);
    setFactionFaith(db, campaignId, realm.id, faith.id, 'strong');
    addHeresy(campaignId, faith.id);
    abandonAll(campaignId);

    const templates = pickMany(campaignId, realm.id, 500, 120).map((agenda) => agenda.template);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates).not.toContain('crusade');
    expect(templates).not.toContain('persecute');
    expect(templates).not.toContain('raise_cathedral');
  });

  it('never sends a faction back to raise a second cathedral at the same seat', () => {
    const campaignId = withRegion(safe);
    ensureWorld(db, campaignId);
    const realm = listFactions(db, campaignId).find((faction) => faction.type === 'realm')!;
    abandonAll(campaignId);

    const first = pickMany(campaignId, realm.id, 500, 200).find(
      (agenda) => agenda.template === 'raise_cathedral',
    );
    expect(first).toBeDefined();
    updateAgenda(db, campaignId, first!.id, { status: 'won', resolved_day: 500 });

    const later = pickMany(campaignId, realm.id, 500, 200);
    expect(later.length).toBeGreaterThan(0);
    for (const agenda of later) {
      expect(`${agenda.template}:${agenda.target_kind}:${agenda.target_id}`).not.toBe(
        `raise_cathedral:own_seat:${first!.target_id}`,
      );
    }
  });

  it('blocks a crown from seizing church lands for a year after it last did', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const { temple, realm, faith } = templeRealmAndFaith(campaignId);
    setFactionFaith(db, campaignId, temple.id, faith.id, 'strong');
    abandonAll(campaignId);

    const day = 500;
    const first = pickMany(campaignId, realm.id, day, 200).find(
      (agenda) => agenda.template === 'seize_church_lands',
    );
    expect(first).toBeDefined();
    updateAgenda(db, campaignId, first!.id, { status: 'won', resolved_day: day - 100 });

    const blocked = pickMany(campaignId, realm.id, day, 100).map((agenda) => agenda.template);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked).not.toContain('seize_church_lands');

    updateAgenda(db, campaignId, first!.id, { status: 'won', resolved_day: day - 400 });
    const allowed = pickMany(campaignId, realm.id, day, 100).map((agenda) => agenda.template);
    expect(allowed).toContain('seize_church_lands');
  });

  it('never lets an excommunicated realm seize church lands', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const { temple, realm, faith } = templeRealmAndFaith(campaignId);
    setFactionFaith(db, campaignId, temple.id, faith.id, 'strong');
    abandonAll(campaignId);

    const day = 500;
    const before = pickMany(campaignId, realm.id, day, 100).map((agenda) => agenda.template);
    expect(before).toContain('seize_church_lands');

    setExcommunicated(db, campaignId, realm.realm_id!, day + 180);
    const after = pickMany(campaignId, realm.id, day, 100).map((agenda) => agenda.template);
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toContain('seize_church_lands');
  });
});
