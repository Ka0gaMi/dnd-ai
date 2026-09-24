// The monthly faith step of the living world: fervor drifts and reacts to church wins and to crowns
// seizing church lands, a low faith may spawn a heresy, and a full contest excommunicates a realm.
import type { Db } from '../db/connection.js';
import { mixSeed, rngInt, rngPick, seededRng } from './dice.js';
import { heresyName } from './faith-names.js';
import { getPolitics, type StoredPolitics } from './politics-store.js';
import { placeDistance } from './region-graph.js';
import { getRegion, type RegionView, type WorldPlace } from './region.js';
import { emitPacket } from './world-news.js';
import { pickAgenda } from './world-seed.js';
import {
  insertEvent,
  insertFaction,
  listAgendas,
  listEvents,
  listFactions,
  type WorldEvent,
  type WorldFaction,
} from './world-store.js';
import {
  addContest,
  excommunicatedUntil,
  factionFaith,
  getFaith,
  insertFaith,
  listFaiths,
  resetContest,
  setExcommunicated,
  setFactionFaith,
  updateFaith,
  type FaithInfluence,
  type WorldFaith,
} from './world-faith-store.js';

/** The window of agenda wins a monthly step reacts to: the thirty days ending today. */
const WINDOW_DAYS = 30;
/** A low faith spawns a heresy only on this roll. */
const HERESY_CHANCE = 0.35;
/** A faith may spawn a new heresy no more often than this. */
const HERESY_COOLDOWN_DAYS = 180;
/** How long an excommunication lasts before the realm is received back. */
const EXCOMMUNICATION_DAYS = 180;
/** Keeps the heresy roll apart from every other seeded decision. */
const HERESY_SALT = 4099;
/** Keeps the monthly fervor wobble apart from every other seeded decision. */
const WOBBLE_SALT = 5501;

const STEP_DOWN: Record<FaithInfluence, FaithInfluence> = {
  dominant: 'strong',
  strong: 'minor',
  minor: 'minor',
};

/** The faith a faction holds and the influence it holds there, as read from the faction table. */
interface FaithLink {
  faith_id: number;
  influence: FaithInfluence | null;
}

/** One point toward the middle: faiths cool when they burn hot and recover when they run cold. */
function drift(fervor: number): number {
  if (fervor < 50) return 1;
  if (fervor > 50) return -1;
  return 0;
}

/** The influence a won cathedral or conversion grants: a minor temple rises, and only a theocracy lifts a strong one. */
function stepUp(influence: FaithInfluence, theocracy: boolean): FaithInfluence {
  if (influence === 'minor') return 'strong';
  if (influence === 'strong' && theocracy) return 'dominant';
  return influence;
}

/** True when the realm a faction belongs to is recorded as a theocracy. */
function isTheocracy(db: Db, campaignId: number, realmId: number | null): boolean {
  if (realmId === null) return false;
  const row = db
    .prepare('SELECT government FROM world_realm WHERE campaign_id = ? AND id = ?')
    .get(campaignId, realmId) as { government: string | null } | undefined;
  return row?.government === 'theocracy';
}

/** The faith and influence each faction holds, read straight from the table WorldFaction does not carry. */
function faithLinks(db: Db, campaignId: number): Map<number, FaithLink> {
  const rows = db
    .prepare('SELECT id, faith_id, influence FROM world_faction WHERE campaign_id = ?')
    .all(campaignId) as Array<{ id: number; faith_id: number | null; influence: FaithInfluence | null }>;
  const links = new Map<number, FaithLink>();
  for (const row of rows) {
    if (row.faith_id !== null) links.set(row.id, { faith_id: row.faith_id, influence: row.influence });
  }
  return links;
}

/** True when a faction holds its faith as a temple: a church, or a theocracy's dominant realm faction. */
function holdsFaith(faction: WorldFaction, link: FaithLink | undefined): boolean {
  if (!link) return false;
  return faction.type === 'church' || (faction.type === 'realm' && link.influence === 'dominant');
}

/** True once a church faction follows a faith that broke from the given parent. */
function hasHeresy(
  faiths: WorldFaith[],
  factions: WorldFaction[],
  faithOf: Map<number, FaithLink>,
  parentId: number,
): boolean {
  const heresyIds = new Set(faiths.filter((faith) => faith.heresy_of === parentId).map((faith) => faith.id));
  if (heresyIds.size === 0) return false;
  for (const faction of factions) {
    if (faction.type !== 'church' || faction.resources <= 0) continue;
    const faithId = faithOf.get(faction.id)?.faith_id;
    if (faithId !== undefined && heresyIds.has(faithId)) return true;
  }
  return false;
}

/** Settlements inside the counties of realms whose church, or dominant crown, follows the faith. */
function eligibleSettlements(
  view: RegionView,
  politics: StoredPolitics,
  factions: WorldFaction[],
  faithOf: Map<number, FaithLink>,
  faithId: number,
): WorldPlace[] {
  const realmIds = new Set<number>();
  for (const faction of factions) {
    const link = faithOf.get(faction.id);
    if (faction.realm_id !== null && link?.faith_id === faithId && holdsFaith(faction, link)) {
      realmIds.add(faction.realm_id);
    }
  }
  const counties = politics.counties.filter((county) => realmIds.has(county.realm_id));
  return view.places.filter(
    (place) =>
      place.kind === 'settlement' &&
      counties.some((county) => county.hexes.includes(place.hexes[0]) || county.seat_place_id === place.id),
  );
}

/** The settlement farthest from a place, ties going to the lower id. */
function farthestFrom(head: WorldPlace, settlements: WorldPlace[]): WorldPlace | undefined {
  let best: WorldPlace | undefined;
  let bestDistance = -1;
  for (const settlement of settlements) {
    const distance = placeDistance(head, settlement);
    if (distance > bestDistance || (distance === bestDistance && best !== undefined && settlement.id < best.id)) {
      best = settlement;
      bestDistance = distance;
    }
  }
  return best;
}

interface RealmRow {
  id: number;
  name: string;
  ruler_title: string | null;
  capital_place_id: number | null;
}

/** A breakaway faith and its discreet church faction, founded in the settlement farthest from home. */
function spawnHeresy(
  db: Db,
  campaignId: number,
  day: number,
  seed: number,
  parent: WorldFaith,
  factions: WorldFaction[],
  faithOf: Map<number, FaithLink>,
  rng: () => number,
): WorldEvent | null {
  const view = getRegion(db, campaignId);
  const politics = getPolitics(db, campaignId);
  if (!view || !politics) return null;
  const head = parent.head_place_id !== null ? view.places.find((place) => place.id === parent.head_place_id) : undefined;
  const eligible = eligibleSettlements(view, politics, factions, faithOf, parent.id);
  // A faith with no head seat (a region with no city) still breeds dissent, in a seeded town of its own.
  const settlement = head ? farthestFrom(head, eligible) : eligible.length > 0 ? rngPick(rng, eligible) : undefined;
  if (!settlement) return null;

  const name = heresyName(parent, rng);
  const factionName = capitalise(name);
  const taken = new Set(listFaiths(db, campaignId).map((faith) => faith.name.toLowerCase()));
  if (taken.has(name.toLowerCase())) return null;
  const factionTaken = db
    .prepare('SELECT 1 AS found FROM world_faction WHERE campaign_id = ? AND lower(name) = lower(?)')
    .get(campaignId, factionName);
  if (factionTaken) return null;

  const county = politics.counties.find(
    (entry) => entry.hexes.includes(settlement.hexes[0]) || entry.seat_place_id === settlement.id,
  );
  const heresy = insertFaith(db, campaignId, {
    name,
    aspect: parent.aspect,
    symbol: parent.symbol,
    head_place_id: settlement.id,
    fervor: 70,
    heresy_of: parent.id,
    last_heresy_day: null,
    created_day: day,
  });
  const faction = insertFaction(db, campaignId, {
    name: factionName,
    type: 'church',
    realm_id: county?.realm_id ?? null,
    county_id: county?.id ?? null,
    place_id: settlement.id,
    secrecy: 'discreet',
    resources: 2,
    capacities: {},
    created_day: day,
  });
  setFactionFaith(db, campaignId, faction.id, heresy.id, 'minor');
  pickAgenda(db, campaignId, faction, day, seed, 1);
  updateFaith(db, campaignId, parent.id, { last_heresy_day: day });

  const event = insertEvent(db, campaignId, {
    day,
    kind: 'heresy',
    text: `Preachers in ${settlement.name} speak against ${parent.name}.`,
    severity: 3,
    place_id: settlement.id,
    faction_id: faction.id,
    agenda_id: null,
    causes: [],
    effects: {},
    visibility: 'public',
  });
  emitPacket(db, campaignId, event);
  return event;
}

/** Adds `amount` to a faith's fervor, clamped by the store, relative to whatever it now holds. */
function adjustFervor(db: Db, campaignId: number, faithId: number, amount: number): void {
  const faith = getFaith(db, campaignId, faithId);
  if (faith) updateFaith(db, campaignId, faithId, { fervor: faith.fervor + amount });
}

/** Faith names open with a lower-case article, so a sentence that starts with one needs its first letter raised. */
const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Advances every faith one month: drift, church wins, crown seizures, a possible heresy, an
 * excommunication on a full contest, and the lapse of one that has run its course.
 */
export function faithMonth(db: Db, campaignId: number, day: number, seed: number): WorldEvent[] {
  return db.transaction(() => {
    const events: WorldEvent[] = [];
    const faiths = listFaiths(db, campaignId);
    const faithById = new Map(faiths.map((faith) => [faith.id, faith]));
    const factions = listFactions(db, campaignId);
    const faithOf = faithLinks(db, campaignId);
    const factionById = new Map(factions.map((faction) => [faction.id, faction]));

    const recentWins = listEvents(db, campaignId, { fromDay: day - WINDOW_DAYS + 1, toDay: day }).filter(
      (event) => event.kind === 'agenda_won',
    );

    const agendaById = new Map(listAgendas(db, campaignId).map((agenda) => [agenda.id, agenda]));

    // 1. Drift, then a small seeded wobble that leans downward.
    for (const faith of faiths) {
      adjustFervor(db, campaignId, faith.id, drift(faith.fervor));
      const wobble = rngInt(seededRng(mixSeed(seed, day, faith.id, WOBBLE_SALT)), -3, 2);
      adjustFervor(db, campaignId, faith.id, wobble);
    }

    // 2. A church win raises its faith's fervor, and a cathedral or conversion grows its temple.
    for (const event of recentWins) {
      const faction = event.faction_id !== null ? factionById.get(event.faction_id) : undefined;
      if (!faction) continue;
      const link = faithOf.get(faction.id);
      if (!link || !holdsFaith(faction, link)) continue;
      const faithId = link.faith_id;
      adjustFervor(db, campaignId, faithId, 3);
      const template = event.agenda_id !== null ? agendaById.get(event.agenda_id)?.template : undefined;
      if (template === 'crusade' || template === 'persecute') adjustFervor(db, campaignId, faithId, 2);
      // A theocracy's crown already holds its faith dominantly, so only a temple still has room to grow.
      if (faction.type === 'church' && (template === 'raise_cathedral' || template === 'conversion')) {
        const { influence } = factionFaith(db, campaignId, faction.id);
        if (influence !== null) {
          const next = stepUp(influence, isTheocracy(db, campaignId, faction.realm_id));
          if (next !== influence) setFactionFaith(db, campaignId, faction.id, faithId, next);
        }
      }
    }

    // 3. A realm seizing a church's lands steps that church down and lowers its faith, and only an
    //    established faith's crown dispute fills the contest, and only while the realm is not cast out.
    for (const event of recentWins) {
      if (event.agenda_id === null) continue;
      const agenda = agendaById.get(event.agenda_id);
      if (agenda?.template !== 'seize_church_lands') continue;
      const realmFaction = event.faction_id !== null ? factionById.get(event.faction_id) : undefined;
      if (!realmFaction || realmFaction.type !== 'realm' || realmFaction.realm_id === null) continue;
      const target =
        agenda.target_kind === 'rival_faction' && agenda.target_id !== null
          ? factionById.get(agenda.target_id)
          : undefined;
      if (!target || target.type !== 'church') continue;
      const link = faithOf.get(target.id);
      if (!link) continue;
      const faithId = link.faith_id;
      const realmUntil = excommunicatedUntil(db, campaignId, realmFaction.realm_id);
      const underInterdict = realmUntil !== null && realmUntil > event.day;
      const { influence } = factionFaith(db, campaignId, target.id);
      if (influence !== null) setFactionFaith(db, campaignId, target.id, faithId, STEP_DOWN[influence]);
      const faith = faithById.get(faithId);
      if (faith && faith.heresy_of === null && !underInterdict) {
        addContest(db, campaignId, realmFaction.realm_id, faithId, 3);
      }
      adjustFervor(db, campaignId, faithId, -3);
    }

    // 4. A low faith that has not broken away may spawn a heresy.
    for (const faith of faiths) {
      const current = getFaith(db, campaignId, faith.id);
      if (!current || current.heresy_of !== null || current.fervor >= 40) continue;
      if (hasHeresy(faiths, factions, faithOf, faith.id)) continue;
      if (current.last_heresy_day !== null && day - current.last_heresy_day < HERESY_COOLDOWN_DAYS) continue;
      const rng = seededRng(mixSeed(seed, day, faith.id, HERESY_SALT));
      if (rng() >= HERESY_CHANCE) continue;
      const event = spawnHeresy(db, campaignId, day, seed, current, factions, faithOf, rng);
      if (event) events.push(event);
    }

    // 5. A full contest of an established faith casts the realm out, at most once a month; a realm
    //    already under interdict is left be, and its full contest clears rather than piling up.
    const contests = db
      .prepare(
        'SELECT realm_id, faith_id FROM world_contest WHERE campaign_id = ? AND filled >= size ORDER BY realm_id, faith_id',
      )
      .all(campaignId) as Array<{ realm_id: number; faith_id: number }>;
    const excommunicatedThisMonth = new Set<number>();
    for (const contest of contests) {
      const faith = getFaith(db, campaignId, contest.faith_id);
      if (!faith || faith.heresy_of !== null) continue;
      const until = excommunicatedUntil(db, campaignId, contest.realm_id);
      if ((until !== null && until > day) || excommunicatedThisMonth.has(contest.realm_id)) {
        resetContest(db, campaignId, contest.realm_id, contest.faith_id);
        continue;
      }
      const realm = db
        .prepare('SELECT id, name, ruler_title, capital_place_id FROM world_realm WHERE campaign_id = ? AND id = ?')
        .get(campaignId, contest.realm_id) as RealmRow | undefined;
      if (!realm) continue;
      excommunicatedThisMonth.add(realm.id);
      setExcommunicated(db, campaignId, realm.id, day + EXCOMMUNICATION_DAYS);
      resetContest(db, campaignId, realm.id, faith.id);
      adjustFervor(db, campaignId, faith.id, -5);
      const realmFaction = factions.find(
        (faction) => faction.type === 'realm' && faction.realm_id === realm.id,
      );
      const event = insertEvent(db, campaignId, {
        day,
        kind: 'excommunication',
        text: capitalise(`${faith.name} casts out the ${realm.ruler_title ?? 'ruler'} of ${realm.name}.`),
        severity: 4,
        place_id: realm.capital_place_id,
        faction_id: realmFaction?.id ?? null,
        agenda_id: null,
        causes: [],
        effects: {},
        visibility: 'public',
      });
      emitPacket(db, campaignId, event);
      events.push(event);
    }

    // 6. An excommunication lapses on its day.
    const lapsed = db
      .prepare(
        'SELECT id, name, capital_place_id FROM world_realm WHERE campaign_id = ? AND excommunicated_until IS NOT NULL AND excommunicated_until <= ? ORDER BY id',
      )
      .all(campaignId, day) as Array<{ id: number; name: string; capital_place_id: number | null }>;
    for (const realm of lapsed) {
      setExcommunicated(db, campaignId, realm.id, null);
      const temple = factions.find(
        (faction) => faction.type === 'church' && faction.realm_id === realm.id && faithOf.has(faction.id),
      );
      const realmFaction = factions.find(
        (faction) => faction.type === 'realm' && faction.realm_id === realm.id,
      );
      const templeLink = temple ? faithOf.get(temple.id) : undefined;
      const crownLink = realmFaction ? faithOf.get(realmFaction.id) : undefined;
      const faithId = templeLink?.faith_id ?? crownLink?.faith_id;
      const faith = faithId !== undefined ? getFaith(db, campaignId, faithId) : undefined;
      const event = insertEvent(db, campaignId, {
        day,
        kind: 'reconciled',
        text: `${realm.name} is received back into ${faith?.name ?? 'the faith'}.`,
        severity: 2,
        place_id: realm.capital_place_id,
        faction_id: realmFaction?.id ?? null,
        agenda_id: null,
        causes: [],
        effects: {},
        visibility: 'public',
      });
      emitPacket(db, campaignId, event);
      events.push(event);
    }

    return events;
  })();
}
