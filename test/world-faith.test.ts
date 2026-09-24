// The living world's monthly faith step: fervor drift, church wins, crown seizures, a spawned
// heresy, an excommunication and its lapse, all replayed from a fixed world seed.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createCampaign } from '../src/core/campaign.js';
import { mixSeed, rngInt, seededRng } from '../src/core/dice.js';
import { getPolitics } from '../src/core/politics-store.js';
import { findPlace, getRegion, importRegion, type WorldPlace } from '../src/core/region.js';
import { placeDistance } from '../src/core/region-graph.js';
import { ensureWorld } from '../src/core/world-seed.js';
import { tickTo } from '../src/core/world-tick.js';
import { faithMonth } from '../src/core/world-faith.js';
import {
  addContest,
  excommunicatedUntil,
  factionFaith,
  getContest,
  getFaith,
  insertFaith,
  listFaiths,
  setExcommunicated,
  setFactionFaith,
  updateFaith,
  type WorldFaith,
} from '../src/core/world-faith-store.js';
import {
  currentGameDay,
  getWorldState,
  insertAgenda,
  insertEvent,
  insertFaction,
  listAgendas,
  listEvents,
  listFactions,
  saveWorldState,
  updateAgenda,
  type WorldEvent,
  type WorldFaction,
} from '../src/core/world-store.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

/** ensureWorld now seeds faiths from a random world seed; these tests build their own, so clear the seeded ones. */
function clearSeededFaiths(target: Db, campaignId: number): void {
  target.prepare('UPDATE world_faction SET faith_id = NULL, influence = NULL WHERE campaign_id = ?').run(campaignId);
  target.prepare('DELETE FROM world_faith WHERE campaign_id = ?').run(campaignId);
}

function withWorld(realm: unknown = dangerous): number {
  const campaignId = createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
  importRegion(db, campaignId, realm, { source: 'generated' });
  ensureWorld(db, campaignId);
  clearSeededFaiths(db, campaignId);
  return campaignId;
}

function addFaith(campaignId: number, patch: Partial<Omit<WorldFaith, 'id'>> = {}): WorldFaith {
  return insertFaith(db, campaignId, {
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

function churchOf(campaignId: number): WorldFaction {
  return listFactions(db, campaignId).find((faction) => faction.type === 'church')!;
}

function realmOf(campaignId: number, realmId: number): WorldFaction {
  return listFactions(db, campaignId).find(
    (faction) => faction.type === 'realm' && faction.realm_id === realmId,
  )!;
}

/** A church faction in a realm, following a faith at a chosen influence. */
function addChurch(
  campaignId: number,
  realmId: number,
  name: string,
  faithId: number,
  influence: 'minor' | 'strong' | 'dominant',
): WorldFaction {
  const church = insertFaction(db, campaignId, {
    name,
    type: 'church',
    realm_id: realmId,
    county_id: null,
    place_id: null,
    secrecy: 'discreet',
    resources: 2,
    capacities: {},
    created_day: 361,
  });
  setFactionFaith(db, campaignId, church.id, faithId, influence);
  return church;
}

function packetCount(campaignId: number, eventId: number): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM world_packet WHERE campaign_id = ? AND event_id = ?').get(campaignId, eventId) as {
      n: number;
    }
  ).n;
}

function eventShape(event: WorldEvent): unknown {
  return {
    day: event.day,
    kind: event.kind,
    text: event.text,
    severity: event.severity,
    place_id: event.place_id,
    faction_id: event.faction_id,
  };
}

/** A seed whose heresy roll succeeds for this faith and day, found by scanning the same generator. */
function seedThatSpawns(faithId: number, day: number): number {
  for (let seed = 1; seed <= 1000; seed += 1) {
    if (seededRng(mixSeed(seed, day, faithId, 4099))() < 0.35) return seed;
  }
  throw new Error('No seed spawns a heresy.');
}

/** The seeded monthly wobble faithMonth applies to a faith on top of the drift. */
function wobbleFor(faithId: number, day: number, seed: number): number {
  return rngInt(seededRng(mixSeed(seed, day, faithId, 5501)), -3, 2);
}

/** Records a won agenda of the given template for a faction, inside the window faithMonth reads. */
function wonAgenda(target: Db, campaignId: number, factionId: number, template: string, day: number): void {
  const agenda = insertAgenda(target, campaignId, {
    faction_id: factionId,
    template,
    target_kind: 'own_seat',
    target_id: null,
    target_name: 'The temple seat',
    clock_size: 8,
    clock_filled: 8,
    portents: [],
    status: 'won',
    started_day: day - 8,
  });
  insertEvent(target, campaignId, {
    day,
    kind: 'agenda_won',
    text: `The church wins ${template}.`,
    severity: 2,
    place_id: null,
    faction_id: factionId,
    agenda_id: agenda.id,
    causes: [],
    effects: {},
    visibility: 'public',
  });
}

describe('faithMonth drift', () => {
  it('moves fervor one step toward 50 from above and below', () => {
    const campaignId = withWorld(safe);
    const high = addFaith(campaignId, { name: 'The High Sun', fervor: 60 });
    const low = addFaith(campaignId, { name: 'The Low Sun', fervor: 40 });

    faithMonth(db, campaignId, 390, 1);

    expect(getFaith(db, campaignId, high.id)!.fervor).toBe(59 + wobbleFor(high.id, 390, 1));
    expect(getFaith(db, campaignId, low.id)!.fervor).toBe(41 + wobbleFor(low.id, 390, 1));
  });
});

describe('faithMonth and church wins', () => {
  it('raises fervor by 3 for each church win in the window', () => {
    const campaignId = withWorld();
    const faith = addFaith(campaignId, { fervor: 50 });
    const church = churchOf(campaignId);
    setFactionFaith(db, campaignId, church.id, faith.id, 'strong');

    insertEvent(db, campaignId, {
      day: 390,
      kind: 'agenda_won',
      text: 'The temple wins a town.',
      severity: 2,
      place_id: null,
      faction_id: church.id,
      agenda_id: null,
      causes: [],
      effects: {},
      visibility: 'public',
    });

    faithMonth(db, campaignId, 390, 1);

    expect(getFaith(db, campaignId, faith.id)!.fervor).toBe(53 + wobbleFor(faith.id, 390, 1));
  });
});

describe('faithMonth fervor wobble', () => {
  it('lets a quiet faith fall below 40 within three years for at least one of seeds 1..10', () => {
    const campaignId = withWorld();
    // Faith id feeds the wobble seed, so several quiet faiths are needed to show the floor is reachable.
    const faiths = ['The Dawn', 'The Dusk', 'The Ember', 'The Tide', 'The Gale', 'The Stone'].map((name) =>
      addFaith(campaignId, { name, fervor: 50 }),
    );
    let fell = false;

    for (let seed = 1; seed <= 10; seed += 1) {
      for (const faith of faiths) updateFaith(db, campaignId, faith.id, { fervor: 50, last_heresy_day: null });
      let lowest = 50;
      for (let day = 30; day <= 1080; day += 30) {
        faithMonth(db, campaignId, day, seed);
        for (const faith of faiths) {
          const fervor = getFaith(db, campaignId, faith.id)!.fervor;
          expect(fervor).toBeGreaterThanOrEqual(0);
          expect(fervor).toBeLessThanOrEqual(100);
          lowest = Math.min(lowest, fervor);
        }
      }
      if (lowest < 40) fell = true;
    }

    expect(fell).toBe(true);
  });
});

describe('faithMonth temple growth', () => {
  it('steps a minor temple to strong on a won cathedral', () => {
    const campaignId = withWorld();
    const faith = addFaith(campaignId, { fervor: 50 });
    const church = churchOf(campaignId);
    setFactionFaith(db, campaignId, church.id, faith.id, 'minor');

    wonAgenda(db, campaignId, church.id, 'raise_cathedral', 390);
    faithMonth(db, campaignId, 390, 1);

    expect(factionFaith(db, campaignId, church.id)).toEqual({ faith_id: faith.id, influence: 'strong' });
  });

  it('lifts a strong temple to dominant only when the realm is a theocracy', () => {
    const controlId = withWorld();
    const controlFaith = addFaith(controlId, { fervor: 50 });
    const controlChurch = churchOf(controlId);
    setFactionFaith(db, controlId, controlChurch.id, controlFaith.id, 'strong');
    db.prepare('UPDATE world_realm SET government = ? WHERE id = ?').run('monarchy', controlChurch.realm_id!);
    wonAgenda(db, controlId, controlChurch.id, 'conversion', 390);
    faithMonth(db, controlId, 390, 1);
    expect(factionFaith(db, controlId, controlChurch.id)).toEqual({ faith_id: controlFaith.id, influence: 'strong' });

    const theocracyId = withWorld();
    const faith = addFaith(theocracyId, { fervor: 50 });
    const church = churchOf(theocracyId);
    setFactionFaith(db, theocracyId, church.id, faith.id, 'strong');
    db.prepare('UPDATE world_realm SET government = ? WHERE id = ?').run('theocracy', church.realm_id!);
    wonAgenda(db, theocracyId, church.id, 'conversion', 390);
    faithMonth(db, theocracyId, 390, 1);
    expect(factionFaith(db, theocracyId, church.id)).toEqual({ faith_id: faith.id, influence: 'dominant' });
  });
});

describe('faithMonth crusades and persecutions', () => {
  it('adds two fervor on top of the church-win bonus, compared against a matching control', () => {
    const seed = 5;
    const day = 390;

    const setUp = (template: string): { target: Db; campaignId: number; faithId: number } => {
      const target = openDb(':memory:');
      const campaignId = createCampaign(target, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
      importRegion(target, campaignId, dangerous, { source: 'generated' });
      ensureWorld(target, campaignId);
      clearSeededFaiths(target, campaignId);
      const faith = insertFaith(target, campaignId, {
        name: 'The Sunfather',
        aspect: 'sun',
        symbol: 'radiant sun',
        head_place_id: null,
        fervor: 50,
        heresy_of: null,
        last_heresy_day: null,
        created_day: 361,
      });
      const church = listFactions(target, campaignId).find((faction) => faction.type === 'church')!;
      setFactionFaith(target, campaignId, church.id, faith.id, 'strong');
      wonAgenda(target, campaignId, church.id, template, day);
      return { target, campaignId, faithId: faith.id };
    };

    const crusade = setUp('crusade');
    const persecution = setUp('persecute');
    const control = setUp('hunt_monster');

    for (const run of [crusade, persecution, control]) faithMonth(run.target, run.campaignId, day, seed);

    // A plain church win is +3; a crusade or persecution is +5, so both sit two above the control.
    const controlFervor = getFaith(control.target, control.campaignId, control.faithId)!.fervor;
    expect(getFaith(crusade.target, crusade.campaignId, crusade.faithId)!.fervor).toBe(controlFervor + 2);
    expect(getFaith(persecution.target, persecution.campaignId, persecution.faithId)!.fervor).toBe(controlFervor + 2);
  });
});

describe('faithMonth and seized church lands', () => {
  it('steps influence down, fills the contest and lowers fervor', () => {
    const campaignId = withWorld();
    const faith = addFaith(campaignId, { fervor: 50 });
    const church = churchOf(campaignId);
    setFactionFaith(db, campaignId, church.id, faith.id, 'strong');
    const realm = realmOf(campaignId, church.realm_id!);

    const agenda = insertAgenda(db, campaignId, {
      faction_id: realm.id,
      template: 'seize_church_lands',
      target_kind: 'own_seat',
      target_id: null,
      target_name: 'The temple lands',
      clock_size: 6,
      clock_filled: 6,
      portents: [],
      status: 'won',
      started_day: 361,
    });
    insertEvent(db, campaignId, {
      day: 390,
      kind: 'agenda_won',
      text: 'The crown seizes the temple lands.',
      severity: 4,
      place_id: null,
      faction_id: realm.id,
      agenda_id: agenda.id,
      causes: [],
      effects: {},
      visibility: 'public',
    });

    faithMonth(db, campaignId, 390, 1);

    expect(factionFaith(db, campaignId, church.id)).toEqual({ faith_id: faith.id, influence: 'minor' });
    expect(getContest(db, campaignId, church.realm_id!, faith.id)).toEqual({ filled: 3, size: 6 });
    expect(getFaith(db, campaignId, faith.id)!.fervor).toBe(47 + wobbleFor(faith.id, 390, 1));
  });

  it("never fills a contest when a heresy's lands are seized", () => {
    const campaignId = withWorld();
    const faith = addFaith(campaignId, { fervor: 50 });
    const church = churchOf(campaignId);
    setFactionFaith(db, campaignId, church.id, faith.id, 'strong');
    const heresy = addFaith(campaignId, { name: 'The Sunless Path', heresy_of: faith.id, fervor: 50 });
    addChurch(campaignId, church.realm_id!, 'The Sunless Chapel', heresy.id, 'strong');
    const realm = realmOf(campaignId, church.realm_id!);

    wonAgenda(db, campaignId, realm.id, 'seize_church_lands', 390);
    faithMonth(db, campaignId, 390, 1);

    expect(getContest(db, campaignId, church.realm_id!, heresy.id)).toEqual({ filled: 0, size: 6 });
    expect(getContest(db, campaignId, church.realm_id!, faith.id)).toEqual({ filled: 3, size: 6 });
    expect(factionFaith(db, campaignId, church.id)).toEqual({ faith_id: faith.id, influence: 'minor' });
  });
});

describe('faithMonth and heresy', () => {
  /** Runs faithMonth for increasing seeds until a heresy appears, resetting the parent each try. */
  function spawnHeresyScan(campaignId: number, faithId: number, day: number): { seed: number; events: WorldEvent[] } {
    for (let seed = 1; seed <= 200; seed += 1) {
      updateFaith(db, campaignId, faithId, { fervor: 30, last_heresy_day: null });
      const events = faithMonth(db, campaignId, day, seed);
      if (events.some((event) => event.kind === 'heresy')) return { seed, events };
    }
    throw new Error('No heresy seed found.');
  }

  function setUpLowFaith(): { campaignId: number; faith: WorldFaith; head: WorldPlace; church: WorldFaction } {
    const campaignId = withWorld();
    const head = findPlace(db, campaignId, 'Frostcot')!;
    const faith = addFaith(campaignId, { fervor: 30, head_place_id: head.id });
    const church = churchOf(campaignId);
    setFactionFaith(db, campaignId, church.id, faith.id, 'dominant');
    return { campaignId, faith, head, church };
  }

  it('spawns a heresy for a faith with no head seat, in one of its own towns', () => {
    const { campaignId, faith } = setUpLowFaith();
    db.prepare('UPDATE world_faith SET head_place_id = NULL WHERE id = ?').run(faith.id);

    const { events } = spawnHeresyScan(campaignId, faith.id, 390);
    const heresyEvent = events.find((event) => event.kind === 'heresy');
    expect(heresyEvent).toBeDefined();
    const heresyFaith = listFaiths(db, campaignId).find((entry) => entry.heresy_of === faith.id)!;
    expect(getRegion(db, campaignId)!.places.find((place) => place.id === heresyFaith.head_place_id)?.kind).toBe('settlement');
  });

  it('spawns a heresy from a low faith, farthest from the parent head', () => {
    const { campaignId, faith, head, church } = setUpLowFaith();
    const day = 390;

    const { events } = spawnHeresyScan(campaignId, faith.id, day);
    const heresyEvent = events.find((event) => event.kind === 'heresy')!;
    const heresyFaith = listFaiths(db, campaignId).find((entry) => entry.heresy_of === faith.id)!;

    expect(heresyFaith.name).not.toBe(faith.name);
    expect(heresyFaith.aspect).toBe(faith.aspect);
    expect(heresyFaith.symbol).toBe(faith.symbol);
    expect(heresyFaith.fervor).toBe(70);
    expect(heresyFaith.last_heresy_day).toBeNull();
    expect(heresyFaith.created_day).toBe(day);

    // The breakaway sits in the eligible settlement farthest from the parent's head.
    const view = getRegion(db, campaignId)!;
    const politics = getPolitics(db, campaignId)!;
    const counties = politics.counties.filter((county) => county.realm_id === church.realm_id);
    const eligible = view.places.filter(
      (place) =>
        place.kind === 'settlement' &&
        counties.some((county) => county.hexes.includes(place.hexes[0]) || county.seat_place_id === place.id),
    );
    const chosen = view.places.find((place) => place.id === heresyFaith.head_place_id)!;
    expect(eligible.map((place) => place.id)).toContain(chosen.id);
    expect(placeDistance(head, chosen)).toBe(Math.max(...eligible.map((place) => placeDistance(head, place))));

    const faction = listFactions(db, campaignId).find((entry) => entry.id === heresyEvent.faction_id)!;
    expect(faction.name).toBe(heresyFaith.name.charAt(0).toUpperCase() + heresyFaith.name.slice(1));
    expect(faction.type).toBe('church');
    expect(faction.secrecy).toBe('discreet');
    expect(faction.resources).toBe(2);
    expect(faction.capacities).toEqual({});
    expect(faction.place_id).toBe(chosen.id);
    expect(faction.created_day).toBe(day);
    expect(factionFaith(db, campaignId, faction.id)).toEqual({ faith_id: heresyFaith.id, influence: 'minor' });
    expect(listAgendas(db, campaignId, { factionId: faction.id, status: 'active' })).toHaveLength(1);

    expect(heresyEvent.severity).toBe(3);
    expect(heresyEvent.text).toBe(`Preachers in ${chosen.name} speak against ${faith.name}.`);
    expect(heresyEvent.visibility).toBe('public');
    expect(packetCount(campaignId, heresyEvent.id)).toBeGreaterThan(0);
    expect(getFaith(db, campaignId, faith.id)!.last_heresy_day).toBe(day);
  });

  it('keeps one heresy per faith at a time', () => {
    const { campaignId, faith } = setUpLowFaith();
    const day = 390;
    const { seed } = spawnHeresyScan(campaignId, faith.id, day);
    expect(listFaiths(db, campaignId).filter((entry) => entry.heresy_of === faith.id)).toHaveLength(1);

    // Clear the cooldown so only the existing heresy can block a second.
    updateFaith(db, campaignId, faith.id, { fervor: 30, last_heresy_day: null });
    const again = faithMonth(db, campaignId, day, seed);

    expect(again.filter((event) => event.kind === 'heresy')).toEqual([]);
    expect(listFaiths(db, campaignId).filter((entry) => entry.heresy_of === faith.id)).toHaveLength(1);
  });

  it('waits 180 days before another heresy', () => {
    const { campaignId, faith } = setUpLowFaith();
    const day = 390;
    const seed = seedThatSpawns(faith.id, day);

    updateFaith(db, campaignId, faith.id, { fervor: 30, last_heresy_day: day - 100 });
    expect(faithMonth(db, campaignId, day, seed).filter((event) => event.kind === 'heresy')).toEqual([]);

    updateFaith(db, campaignId, faith.id, { fervor: 30, last_heresy_day: day - 180 });
    expect(faithMonth(db, campaignId, day, seed).some((event) => event.kind === 'heresy')).toBe(true);
  });
});

describe('faithMonth and excommunication', () => {
  it('casts a realm out on a full contest and receives it back when it lapses', () => {
    const campaignId = withWorld();
    const faith = addFaith(campaignId, { fervor: 50 });
    const church = churchOf(campaignId);
    setFactionFaith(db, campaignId, church.id, faith.id, 'strong');
    const realm = realmOf(campaignId, church.realm_id!);
    const capital = findPlace(db, campaignId, 'Frostcot')!;
    db.prepare('UPDATE world_realm SET capital_place_id = ? WHERE id = ?').run(capital.id, realm.realm_id!);
    const realmRow = db
      .prepare('SELECT name, ruler_title, capital_place_id FROM world_realm WHERE id = ?')
      .get(realm.realm_id!) as { name: string; ruler_title: string | null; capital_place_id: number | null };

    addContest(db, campaignId, realm.realm_id!, faith.id, 6);
    const day = 390;
    const events = faithMonth(db, campaignId, day, 1);
    const excommunication = events.find((event) => event.kind === 'excommunication')!;

    expect(excommunicatedUntil(db, campaignId, realm.realm_id!)).toBe(day + 180);
    expect(getContest(db, campaignId, realm.realm_id!, faith.id)).toEqual({ filled: 0, size: 6 });
    expect(getFaith(db, campaignId, faith.id)!.fervor).toBe(45 + wobbleFor(faith.id, 390, 1));
    expect(excommunication.severity).toBe(4);
    expect(excommunication.text).toBe(
      `${faith.name} casts out the ${realmRow.ruler_title ?? 'ruler'} of ${realmRow.name}.`,
    );
    expect(excommunication.place_id).toBe(realmRow.capital_place_id);
    expect(excommunication.faction_id).toBe(realm.id);
    expect(packetCount(campaignId, excommunication.id)).toBeGreaterThan(0);

    const lapseDay = day + 180;
    const lapsed = faithMonth(db, campaignId, lapseDay, 1);
    const reconciled = lapsed.find((event) => event.kind === 'reconciled')!;

    expect(excommunicatedUntil(db, campaignId, realm.realm_id!)).toBeNull();
    expect(reconciled.severity).toBe(2);
    expect(reconciled.text).toBe(`${realmRow.name} is received back into ${faith.name}.`);
    expect(packetCount(campaignId, reconciled.id)).toBeGreaterThan(0);
  });

  it('never excommunicates a realm on a heresy faith contest', () => {
    const campaignId = withWorld();
    const faith = addFaith(campaignId, { fervor: 50 });
    const church = churchOf(campaignId);
    setFactionFaith(db, campaignId, church.id, faith.id, 'strong');
    const heresy = addFaith(campaignId, { name: 'The Sunless Path', heresy_of: faith.id, fervor: 50 });
    addChurch(campaignId, church.realm_id!, 'The Sunless Chapel', heresy.id, 'strong');
    const realm = realmOf(campaignId, church.realm_id!);

    addContest(db, campaignId, realm.realm_id!, heresy.id, 6);
    const events = faithMonth(db, campaignId, 390, 1);

    expect(events.filter((event) => event.kind === 'excommunication')).toEqual([]);
    expect(excommunicatedUntil(db, campaignId, realm.realm_id!)).toBeNull();
  });

  it('does not excommunicate a realm already cast out, and clears its contest', () => {
    const campaignId = withWorld();
    const faith = addFaith(campaignId, { fervor: 50 });
    const church = churchOf(campaignId);
    setFactionFaith(db, campaignId, church.id, faith.id, 'strong');
    const realm = realmOf(campaignId, church.realm_id!);
    const day = 390;
    setExcommunicated(db, campaignId, realm.realm_id!, day + 100);

    addContest(db, campaignId, realm.realm_id!, faith.id, 6);
    const events = faithMonth(db, campaignId, day, 1);

    expect(events.filter((event) => event.kind === 'excommunication')).toEqual([]);
    expect(excommunicatedUntil(db, campaignId, realm.realm_id!)).toBe(day + 100);
    expect(getContest(db, campaignId, realm.realm_id!, faith.id)).toEqual({ filled: 0, size: 6 });
  });

  it('excommunicates a realm at most once a month', () => {
    const campaignId = withWorld();
    const first = addFaith(campaignId, { name: 'The Sunfather', fervor: 50 });
    const church = churchOf(campaignId);
    setFactionFaith(db, campaignId, church.id, first.id, 'strong');
    const second = addFaith(campaignId, { name: 'The Moonmother', fervor: 50 });
    addChurch(campaignId, church.realm_id!, 'Temple of the Moon', second.id, 'strong');
    const realm = realmOf(campaignId, church.realm_id!);

    addContest(db, campaignId, realm.realm_id!, first.id, 6);
    addContest(db, campaignId, realm.realm_id!, second.id, 6);
    const day = 390;
    const events = faithMonth(db, campaignId, day, 1);

    expect(events.filter((event) => event.kind === 'excommunication')).toHaveLength(1);
    expect(excommunicatedUntil(db, campaignId, realm.realm_id!)).toBe(day + 180);
  });
});

describe('faithMonth through tickTo', () => {
  it('runs the faith month on every thirtieth day', () => {
    const campaignId = withWorld(safe);
    const faith = addFaith(campaignId, { fervor: 60 });
    // Abandon the seeded agendas so no church win disturbs the pure drift under test.
    for (const agenda of listAgendas(db, campaignId)) {
      updateAgenda(db, campaignId, agenda.id, { status: 'abandoned' });
    }
    saveWorldState(db, campaignId, { ...getWorldState(db, campaignId)!, seed: 7 });

    const today = currentGameDay(db, campaignId);
    tickTo(db, campaignId, today + 60);

    expect(getFaith(db, campaignId, faith.id)!.fervor).toBe(
      58 + wobbleFor(faith.id, 390, 7) + wobbleFor(faith.id, 420, 7),
    );
  });
});

describe('faithMonth determinism', () => {
  it('replays identical events and fervor for identical inputs', () => {
    const first = openDb(':memory:');
    const second = openDb(':memory:');

    const setup = (target: Db): { campaignId: number; faithId: number } => {
      const campaignId = createCampaign(target, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
      importRegion(target, campaignId, dangerous, { source: 'generated' });
      ensureWorld(target, campaignId);
      clearSeededFaiths(target, campaignId);
      const faith = insertFaith(target, campaignId, {
        name: 'The Sunfather',
        aspect: 'sun',
        symbol: 'radiant sun',
        head_place_id: findPlace(target, campaignId, 'Frostcot')!.id,
        fervor: 30,
        heresy_of: null,
        last_heresy_day: null,
        created_day: 361,
      });
      const church = listFactions(target, campaignId).find((faction) => faction.type === 'church')!;
      setFactionFaith(target, campaignId, church.id, faith.id, 'dominant');
      return { campaignId, faithId: faith.id };
    };

    const a = setup(first);
    const b = setup(second);
    const seed = seedThatSpawns(1, 390);
    const eventsA = faithMonth(first, a.campaignId, 390, seed);
    const eventsB = faithMonth(second, b.campaignId, 390, seed);

    expect(eventsA.map(eventShape)).toEqual(eventsB.map(eventShape));
    expect(getFaith(first, a.campaignId, a.faithId)!.fervor).toBe(
      getFaith(second, b.campaignId, b.faithId)!.fervor,
    );
    expect(listFaiths(first, a.campaignId).map((entry) => entry.name)).toEqual(
      listFaiths(second, b.campaignId).map((entry) => entry.name),
    );
    expect(listEvents(first, a.campaignId).map(eventShape)).toEqual(listEvents(second, b.campaignId).map(eventShape));
  });
});

describe('faithMonth three-year sanity run', () => {
  /** Runs one fixture for 1080 days from a forced seed, keeping the faiths ensureWorld seeded. */
  function runWorld(
    realm: unknown,
    seed: number,
  ): { excommunications: number; seizures: number; maxCathedrals: number } {
    const campaignId = createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
    importRegion(db, campaignId, realm, { source: 'generated' });
    ensureWorld(db, campaignId);
    saveWorldState(db, campaignId, { ...getWorldState(db, campaignId)!, seed });

    const today = currentGameDay(db, campaignId);
    for (let day = today + 60; day <= today + 1080; day += 60) tickTo(db, campaignId, day);

    const excommunications = listEvents(db, campaignId, { fromDay: today, toDay: today + 1080 }).filter(
      (event) => event.kind === 'excommunication',
    ).length;
    const cathedralsByFaction = new Map<number, number>();
    let seizures = 0;
    for (const agenda of listAgendas(db, campaignId)) {
      if (agenda.status !== 'won') continue;
      if (agenda.template === 'seize_church_lands') seizures += 1;
      if (agenda.template === 'raise_cathedral') {
        cathedralsByFaction.set(agenda.faction_id, (cathedralsByFaction.get(agenda.faction_id) ?? 0) + 1);
      }
    }
    return { excommunications, seizures, maxCathedrals: Math.max(0, ...cathedralsByFaction.values()) };
  }

  it('keeps excommunications and seizures rare on the dangerous realm', () => {
    for (const seed of [2, 3]) {
      const run = runWorld(dangerous, seed);
      expect(run.excommunications, `seed ${seed} excommunications`).toBeLessThanOrEqual(3);
      expect(run.seizures, `seed ${seed} seizures`).toBeLessThanOrEqual(6);
    }
  }, 120000);

  it('never lets one faction consecrate more than three cathedrals on the safe realm', () => {
    for (const seed of [2, 3]) {
      const run = runWorld(safe, seed);
      expect(run.maxCathedrals, `seed ${seed} cathedrals`).toBeLessThanOrEqual(3);
    }
  }, 120000);
});
