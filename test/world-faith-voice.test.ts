// A faith's voice in the living world: which wins move its fervor, how far it drifts, the storyteller's cap
// over faith news, idle factions taking up new agendas, and the church that receives a realm back.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/connection.js';
import type { WorldFaith } from '../src/core/world-faith-store.js';
import type { WorldFaction } from '../src/core/world-store.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const medium = JSON.parse(readFileSync(new URL('./fixtures/realm-medium.json', import.meta.url), 'utf8')) as unknown;

let db: Db;
let openDb: (typeof import('../src/db/connection.js'))['openDb'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let updateSettings: (typeof import('../src/core/settings.js'))['updateSettings'];
let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let tickTo: (typeof import('../src/core/world-tick.js'))['tickTo'];
let dice: typeof import('../src/core/dice.js');
let faiths: typeof import('../src/core/world-faith.js');
let faithStore: typeof import('../src/core/world-faith-store.js');
let store: typeof import('../src/core/world-store.js');
let thwart: typeof import('../src/core/world-thwart.js');

beforeAll(async () => {
  // With isolate: false an earlier file may have cached a stubbed dice.ts, so import the world fresh on the real one.
  vi.resetModules();
  ({ openDb } = await import('../src/db/connection.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion } = await import('../src/core/region.js'));
  ({ updateSettings } = await import('../src/core/settings.js'));
  ({ ensureWorld } = await import('../src/core/world-seed.js'));
  ({ tickTo } = await import('../src/core/world-tick.js'));
  dice = await import('../src/core/dice.js');
  faiths = await import('../src/core/world-faith.js');
  faithStore = await import('../src/core/world-faith-store.js');
  store = await import('../src/core/world-store.js');
  thwart = await import('../src/core/world-thwart.js');
});

beforeEach(() => {
  db = openDb(':memory:');
});

/** A world on the given map whose seeded faiths are cleared, since they come from a random world seed. */
function withWorld(realm: unknown): number {
  const campaignId = createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
  importRegion(db, campaignId, realm, { source: 'generated' });
  ensureWorld(db, campaignId);
  db.prepare('UPDATE world_faction SET faith_id = NULL, influence = NULL WHERE campaign_id = ?').run(campaignId);
  db.prepare('DELETE FROM world_faith WHERE campaign_id = ?').run(campaignId);
  return campaignId;
}

function addFaith(campaignId: number, patch: Partial<Omit<WorldFaith, 'id'>> = {}): WorldFaith {
  return faithStore.insertFaith(db, campaignId, {
    name: 'The Sunfather',
    aspect: 'sun',
    symbol: 'radiant sun',
    head_place_id: null,
    fervor: 50,
    heresy_of: null,
    last_heresy_day: null,
    created_day: 361,
    ...patch,
  });
}

function crownOf(campaignId: number, realmId: number): WorldFaction {
  return store.listFactions(db, campaignId).find((faction) => faction.type === 'realm' && faction.realm_id === realmId)!;
}

/** A church faction seated in a realm, keeping a faith at the given influence. */
function addChurch(
  campaignId: number,
  realmId: number,
  name: string,
  faithId: number,
  influence: 'minor' | 'strong' | 'dominant',
): WorldFaction {
  const church = store.insertFaction(db, campaignId, {
    name,
    type: 'church',
    realm_id: realmId,
    county_id: null,
    place_id: null,
    secrecy: 'open',
    resources: 3,
    capacities: {},
    created_day: 361,
  });
  faithStore.setFactionFaith(db, campaignId, church.id, faithId, influence);
  return church;
}

/** Records a won agenda of the given template for a faction, as resolveAgenda would leave it. */
function wonAgenda(campaignId: number, factionId: number, template: string, day: number): void {
  const agenda = store.insertAgenda(db, campaignId, {
    faction_id: factionId,
    template,
    target_kind: 'own_seat',
    target_id: null,
    target_name: 'The seat',
    clock_size: 6,
    clock_filled: 6,
    portents: [],
    status: 'won',
    started_day: day - 6,
  });
  store.insertEvent(db, campaignId, {
    day,
    kind: 'agenda_won',
    text: `A ${template} is won.`,
    severity: 2,
    place_id: null,
    faction_id: factionId,
    agenda_id: agenda.id,
    causes: [],
    effects: {},
    visibility: 'public',
  });
}

/** The seeded monthly wobble faithMonth adds to a faith on top of its drift. */
function wobbleFor(faithId: number, day: number, seed: number): number {
  return dice.rngInt(dice.seededRng(dice.mixSeed(seed, day, faithId, 5501)), -3, 2);
}

/** A world seed whose heresy roll succeeds for this faith on this day. */
function seedThatSpawns(faithId: number, day: number): number {
  for (let seed = 1; seed <= 1000; seed += 1) {
    if (dice.seededRng(dice.mixSeed(seed, day, faithId, 4099))() < 0.35) return seed;
  }
  throw new Error('No seed spawns a heresy.');
}

function realmName(campaignId: number, realmId: number): string {
  return (db.prepare('SELECT name FROM world_realm WHERE campaign_id = ? AND id = ?').get(campaignId, realmId) as { name: string })
    .name;
}

/** The medium map's theocracy and the principality that answers to it. */
function theocracyAndVassal(campaignId: number): { root: number; vassal: number } {
  const rows = db
    .prepare('SELECT id, liege_realm_id, government FROM world_realm WHERE campaign_id = ? ORDER BY id')
    .all(campaignId) as Array<{ id: number; liege_realm_id: number | null; government: string | null }>;
  const root = rows.find((row) => row.liege_realm_id === null && row.government === 'theocracy')!;
  const vassal = rows.find((row) => row.liege_realm_id === root.id)!;
  expect(root).toBeDefined();
  expect(vassal).toBeDefined();
  return { root: root.id, vassal: vassal.id };
}

function busyAgendas(campaignId: number, factionId: number) {
  return store
    .listAgendas(db, campaignId, { factionId })
    .filter((agenda) => agenda.status === 'active' || agenda.status === 'held');
}

describe('whose wins speak for a faith', () => {
  it("leaves fervor alone when a theocratic crown wins a war, a work or a win of no agenda", () => {
    const campaignId = withWorld(safe);
    const faith = addFaith(campaignId);
    const crown = crownOf(campaignId, 1);
    faithStore.setFactionFaith(db, campaignId, crown.id, faith.id, 'dominant');

    wonAgenda(campaignId, crown.id, 'expand_territory', 380);
    wonAgenda(campaignId, crown.id, 'build', 390);
    store.insertEvent(db, campaignId, {
      day: 385,
      kind: 'agenda_won',
      text: 'The crown wins something.',
      severity: 2,
      place_id: null,
      faction_id: crown.id,
      agenda_id: null,
      causes: [],
      effects: {},
      visibility: 'public',
    });
    faiths.faithMonth(db, campaignId, 390, 1);

    expect(faithStore.getFaith(db, campaignId, faith.id)!.fervor).toBe(50 + wobbleFor(faith.id, 390, 1));
  });

  for (const [template, gain] of [
    ['crusade', 5],
    ['persecute', 5],
    ['raise_cathedral', 3],
    ['conversion', 3],
  ] as const) {
    it(`raises fervor by ${gain} when the crown wins a ${template}`, () => {
      const campaignId = withWorld(safe);
      const faith = addFaith(campaignId);
      const crown = crownOf(campaignId, 1);
      faithStore.setFactionFaith(db, campaignId, crown.id, faith.id, 'dominant');

      wonAgenda(campaignId, crown.id, template, 390);
      faiths.faithMonth(db, campaignId, 390, 1);

      expect(faithStore.getFaith(db, campaignId, faith.id)!.fervor).toBe(50 + gain + wobbleFor(faith.id, 390, 1));
    });
  }

  it("still counts a temple's win whatever its goal", () => {
    const campaignId = withWorld(safe);
    const faith = addFaith(campaignId);
    const temple = addChurch(campaignId, 1, 'Temple of the Dawn', faith.id, 'strong');

    wonAgenda(campaignId, temple.id, 'build', 390);
    faiths.faithMonth(db, campaignId, 390, 1);

    expect(faithStore.getFaith(db, campaignId, faith.id)!.fervor).toBe(53 + wobbleFor(faith.id, 390, 1));
  });

  it("counts a win on the last month day, which came after that month's step, but not one before", () => {
    const campaignId = withWorld(safe);
    const faith = addFaith(campaignId);
    const temple = addChurch(campaignId, 1, 'Temple of the Dawn', faith.id, 'strong');

    wonAgenda(campaignId, temple.id, 'build', 389);
    wonAgenda(campaignId, temple.id, 'build', 390);
    faiths.faithMonth(db, campaignId, 420, 1);

    expect(faithStore.getFaith(db, campaignId, faith.id)!.fervor).toBe(53 + wobbleFor(faith.id, 420, 1));
  });
});

describe('fervor drift', () => {
  it('lets a cold faith stay cold, moved only by its wobble', () => {
    const campaignId = withWorld(safe);
    const faith = addFaith(campaignId, { fervor: 30 });
    let expected = 30;

    for (let day = 390; day <= 720; day += 30) {
      faiths.faithMonth(db, campaignId, day, 3);
      expected = Math.max(0, Math.min(100, expected + wobbleFor(faith.id, day, 3)));
      expect(faithStore.getFaith(db, campaignId, faith.id)!.fervor, `day ${day}`).toBe(expected);
    }
  });

  it('cools a hot faith a point a month only while it is above 60', () => {
    const campaignId = withWorld(safe);
    const faith = addFaith(campaignId, { fervor: 75 });
    let expected = 75;

    for (let day = 390; day <= 1080; day += 30) {
      faiths.faithMonth(db, campaignId, day, 5);
      const cooled = expected > 60 ? expected - 1 : expected;
      expected = Math.max(0, Math.min(100, cooled + wobbleFor(faith.id, day, 5)));
      expect(faithStore.getFaith(db, campaignId, faith.id)!.fervor, `day ${day}`).toBe(expected);
    }
  });
});

describe('the storyteller cap over faith news', () => {
  it('keeps a calm day to one event and fires the waiting news on the next days of its month', () => {
    const campaignId = withWorld(medium);
    const { root, vassal } = theocracyAndVassal(campaignId);
    updateSettings(db, campaignId, { storyteller: 'calm' });
    const faith = addFaith(campaignId, { fervor: 30 });
    const crown = crownOf(campaignId, root);
    faithStore.setFactionFaith(db, campaignId, crown.id, faith.id, 'dominant');
    // Day 390 owes three items: a heresy, the theocracy's excommunication and the vassal's lapse.
    faithStore.addContest(db, campaignId, root, faith.id, 6);
    faithStore.setExcommunicated(db, campaignId, vassal, 390);
    store.saveWorldState(db, campaignId, { ...store.getWorldState(db, campaignId)!, seed: seedThatSpawns(faith.id, 390) });

    tickTo(db, campaignId, 390);
    expect(store.listEvents(db, campaignId, { fromDay: 390, toDay: 390 }).map((event) => event.kind)).toEqual(['heresy']);
    expect(faithStore.excommunicatedUntil(db, campaignId, root)).toBeNull();

    tickTo(db, campaignId, 419);

    const perDay = db
      .prepare('SELECT day, COUNT(*) AS n FROM world_event WHERE campaign_id = ? GROUP BY day HAVING COUNT(*) > 1')
      .all(campaignId);
    expect(perDay).toEqual([]);
    const news = store
      .listEvents(db, campaignId)
      .filter((event) => ['heresy', 'excommunication', 'reconciled'].includes(event.kind))
      .map((event) => ({ day: event.day, kind: event.kind, faction_id: event.faction_id }));
    expect(news).toEqual([
      { day: 390, kind: 'heresy', faction_id: expect.any(Number) },
      { day: 391, kind: 'excommunication', faction_id: crown.id },
      { day: 392, kind: 'reconciled', faction_id: crownOf(campaignId, vassal).id },
    ]);
    // A deferred interdict still runs from its month day, so its lapse lands on a month day too.
    expect(faithStore.excommunicatedUntil(db, campaignId, root)).toBe(570);
    expect(faithStore.excommunicatedUntil(db, campaignId, vassal)).toBeNull();
  });

  it('never passes the calm cap with faith news due every month, over several world seeds', () => {
    for (let seed = 1; seed <= 4; seed += 1) {
      const campaignId = withWorld(medium);
      const { root, vassal } = theocracyAndVassal(campaignId);
      updateSettings(db, campaignId, { storyteller: 'calm' });
      const faith = addFaith(campaignId, { fervor: 30 });
      faithStore.setFactionFaith(db, campaignId, crownOf(campaignId, root).id, faith.id, 'dominant');
      store.saveWorldState(db, campaignId, { ...store.getWorldState(db, campaignId)!, seed });

      for (let monthDay = 390; monthDay <= 480; monthDay += 30) {
        faithStore.addContest(db, campaignId, root, faith.id, 6);
        faithStore.addContest(db, campaignId, vassal, faith.id, 6);
        tickTo(db, campaignId, monthDay + 29);
      }

      const over = db
        .prepare('SELECT day, COUNT(*) AS n FROM world_event WHERE campaign_id = ? GROUP BY day HAVING COUNT(*) > 1')
        .all(campaignId);
      expect(over, `seed ${seed}`).toEqual([]);
      expect(
        store.listEvents(db, campaignId).filter((event) => event.kind === 'excommunication').length,
        `seed ${seed}`,
      ).toBeGreaterThan(0);
    }
  }, 60000);
});

describe('factions left without an agenda', () => {
  // A gang always has a town to raid again, so its re-pick never depends on a goal being free elsewhere.
  const gangAgenda = (campaignId: number) => {
    const gangs = new Set(
      store.listFactions(db, campaignId).filter((faction) => faction.type === 'gang').map((faction) => faction.id),
    );
    return store.listAgendas(db, campaignId, { status: 'active' }).find((entry) => gangs.has(entry.faction_id))!;
  };

  it('takes up a new agenda only once its thwart cooldown is over', () => {
    const campaignId = withWorld(safe);
    const today = store.currentGameDay(db, campaignId);
    const agenda = gangAgenda(campaignId);
    const { cooldown_until } = thwart.thwartAgenda(db, campaignId, agenda.id, 'The party burned the ledgers.', today);
    expect(cooldown_until).toBe(today + 30);

    tickTo(db, campaignId, cooldown_until - 1);
    expect(busyAgendas(campaignId, agenda.faction_id)).toEqual([]);

    tickTo(db, campaignId, cooldown_until);
    const picked = busyAgendas(campaignId, agenda.faction_id);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.started_day).toBe(cooldown_until);
    // A fresh clock is empty, so its first portent waits for a later day's roll and that day's budget.
    expect(picked[0]!.portents.every((portent) => portent.fired_day === null)).toBe(true);
    expect(store.listEvents(db, campaignId).filter((event) => event.agenda_id === picked[0]!.id)).toEqual([]);
  });

  it('takes up a new agenda the next day after its old one was abandoned', () => {
    const campaignId = withWorld(safe);
    const today = store.currentGameDay(db, campaignId);
    const agenda = gangAgenda(campaignId);
    store.updateAgenda(db, campaignId, agenda.id, { status: 'abandoned', resolved_day: today });

    tickTo(db, campaignId, today + 1);

    const picked = busyAgendas(campaignId, agenda.faction_id);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.started_day).toBe(today + 1);
  });

  it('never hands a destroyed faction a new agenda', () => {
    const campaignId = withWorld(safe);
    const today = store.currentGameDay(db, campaignId);
    const agenda = store.listAgendas(db, campaignId, { status: 'active' })[0]!;
    thwart.destroyFaction(db, campaignId, agenda.faction_id, 'The party broke it.', today);

    tickTo(db, campaignId, today + 40);

    expect(busyAgendas(campaignId, agenda.faction_id)).toEqual([]);
  });
});

describe('the church that receives a realm back', () => {
  it("names a theocracy's orthodox crown, not a heresy church seated there", () => {
    const campaignId = withWorld(safe);
    const faith = addFaith(campaignId);
    const heresy = addFaith(campaignId, { name: 'The Sunless Path', heresy_of: faith.id });
    const crown = crownOf(campaignId, 1);
    faithStore.setFactionFaith(db, campaignId, crown.id, faith.id, 'dominant');
    addChurch(campaignId, 1, 'The Sunless Chapel', heresy.id, 'strong');
    faithStore.setExcommunicated(db, campaignId, 1, 390);

    const events = faiths.faithMonth(db, campaignId, 390, 1);

    expect(faiths.realmChurch(db, campaignId, 1)).toMatchObject({
      faction: { id: crown.id },
      faith: { id: faith.id },
      influence: 'dominant',
    });
    expect(events.find((event) => event.kind === 'reconciled')!.text).toBe(
      `${realmName(campaignId, 1)} is received back into ${faith.name}.`,
    );
  });

  it('prefers the most influential orthodox church of a realm, then the older', () => {
    const campaignId = withWorld(medium);
    const { vassal } = theocracyAndVassal(campaignId);
    const faith = addFaith(campaignId);
    const heresy = addFaith(campaignId, { name: 'The Sunless Path', heresy_of: faith.id });
    addChurch(campaignId, vassal, 'The Sunless Chapel', heresy.id, 'dominant');
    addChurch(campaignId, vassal, 'Shrine of the Dawn', faith.id, 'minor');
    const first = addChurch(campaignId, vassal, 'Temple of the Dawn', faith.id, 'strong');
    addChurch(campaignId, vassal, 'Abbey of the Dawn', faith.id, 'strong');

    expect(faiths.realmChurch(db, campaignId, vassal)?.faction.id).toBe(first.id);
  });

  it("falls back to its liege's church for a vassal without its own", () => {
    const campaignId = withWorld(medium);
    const { root, vassal } = theocracyAndVassal(campaignId);
    const faith = addFaith(campaignId);
    const heresy = addFaith(campaignId, { name: 'The Sunless Path', heresy_of: faith.id });
    const crown = crownOf(campaignId, root);
    faithStore.setFactionFaith(db, campaignId, crown.id, faith.id, 'dominant');
    addChurch(campaignId, vassal, 'The Sunless Chapel', heresy.id, 'strong');
    faithStore.setExcommunicated(db, campaignId, vassal, 390);

    const events = faiths.faithMonth(db, campaignId, 390, 1);

    expect(faiths.realmChurch(db, campaignId, vassal)).toMatchObject({ faction: { id: crown.id }, faith: { id: faith.id } });
    expect(events.find((event) => event.kind === 'reconciled')!.text).toBe(
      `${realmName(campaignId, vassal)} is received back into ${faith.name}.`,
    );
  });

  it('finds no church for a realm with none up its chain', () => {
    const campaignId = withWorld(medium);
    const { vassal } = theocracyAndVassal(campaignId);

    expect(faiths.realmChurch(db, campaignId, vassal)).toBeNull();
  });
});
