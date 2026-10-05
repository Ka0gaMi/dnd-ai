// The living world's first day: derive each realm's government, seed the factions the map implies
// and hand every faction one agenda. Every choice comes from dice.ts's seeded generator.
import type { Db } from '../db/connection.js';
import {
  fillText,
  templatesFor,
  type FactionType,
  type TargetRule,
} from './agenda-templates.js';
import { mixSeed, randomSeed, rngInt, rngPick, seededRng } from './dice.js';
import {
  deriveGovernment,
  houseName,
  titlesFor,
  type Government,
  type GovernmentInput,
  type HouseRank,
} from './governments.js';
import { hexNeighbours } from './politics.js';
import { ensurePolitics } from './politics-service.js';
import type { StoredCounty, StoredPolitics } from './politics-store.js';
import { parseHex, placeDistance } from './region-graph.js';
import { getRegion, type RegionView, type WorldPlace } from './region.js';
import { ensureFaiths, hasTemple } from './world-faith-seed.js';
import { getPlaceState, settlementFaithId } from './world-place-state.js';
import {
  excommunicatedUntil,
  getFaith,
  listFaiths,
  type FactionFaith,
  type WorldFaith,
} from './world-faith-store.js';
import {
  currentGameDay,
  getWorldState,
  insertAgenda,
  insertFaction,
  listAgendas,
  listFactions,
  saveWorldState,
  type WorldAgenda,
  type WorldFaction,
} from './world-store.js';

export interface WorldSummary {
  seed: number;
  factions: number;
  agendas: number;
  created: boolean;
}

interface AgendaTarget {
  kind: TargetRule;
  id: number;
  name: string;
}

interface AgendaContext {
  faction: WorldFaction;
  place: WorldPlace | null;
  view: RegionView;
  politics: StoredPolitics;
  allFactions: WorldFaction[];
  faithLinks: Map<number, FactionFaith>;
  faiths: WorldFaith[];
  settlementFaith: (placeId: number) => number | null;
  /** Danger sites whose every brood has already ended, so no hunter would find anything there. */
  clearedDangers: Set<number>;
}

/** Seats this close (60 miles, two days' ride) are neighbours even without a shared county border. */
export const NEIGHBOUR_HEXES = 10;
/** A vassal may turn on its liege only in a season whose roll falls below this, so a revolt stays rare. */
export const REVOLT_CHANCE = 0.05;
/** The revolt roll holds for a whole season, so picking again every idle day cannot re-roll it. */
export const REVOLT_SEASON_DAYS = 90;
const REVOLT_SALT = 6427;
/** Days after a won build before a seat of each size builds again; a seat of unknown size waits as a village. */
export const BUILD_COOLDOWN_DAYS: Record<'city' | 'town' | 'village', number> = { city: 180, town: 360, village: 720 };
/** How many times a claimed county is listed among expansion targets, so the seeded pick favours it. */
const CLAIM_WEIGHT: Record<'weak' | 'strong', number> = { weak: 2, strong: 4 };

/** The map width from which a region counts as XL, the only size where an on-map realm may be an empire. */
const XL_WIDTH = 4800;
/** A region holds a holy city one time in three, drawn from its map seed so every campaign on it agrees. */
const HOLY_CITY_CHANCE = 1 / 3;
const HOLY_CITY_SALT = 2203;
/** One bandit band per BANDIT_SETTLEMENTS settlements up to BANDIT_BANDS, camped BANDIT_GAP hexes from settlements. */
const BANDIT_BANDS = 3;
const BANDIT_SETTLEMENTS = 8;
const BANDIT_GAP = 2;
const BANDIT_SALT = 4517;
const BAND_NOUNS = ['Brigands', 'Outlaws', 'Highwaymen', 'Reavers'] as const;

/** Words that make a danger a beast's lair, each with the kind of brood it implies when no creature is named. */
const LAIR_WORDS: Record<string, string> = {
  lair: 'Beasts',
  den: 'Beasts',
  cave: 'Beasts',
  cavern: 'Beasts',
  grotto: 'Beasts',
  burrow: 'Beasts',
  nest: 'Swarm',
  hive: 'Swarm',
  warren: 'Vermin',
  roost: 'Flock',
  eyrie: 'Flock',
  aerie: 'Flock',
  rookery: 'Flock',
};

/** Creatures a lair's name may call out, for a brood named after what lives there. */
const CREATURE_WORDS: Record<string, string> = {
  spider: 'Spiders',
  wolf: 'Wolves',
  wolves: 'Wolves',
  rat: 'Rats',
  bat: 'Bats',
  bear: 'Bears',
  boar: 'Boars',
  serpent: 'Serpents',
  snake: 'Serpents',
  lizard: 'Lizards',
  drake: 'Drakes',
  dragon: 'Dragons',
  wyvern: 'Wyverns',
  wyrm: 'Wyrms',
  worm: 'Worms',
  goblin: 'Goblins',
  kobold: 'Kobolds',
  orc: 'Orcs',
  ogre: 'Ogres',
  troll: 'Trolls',
  gnoll: 'Gnolls',
  harpy: 'Harpies',
  harpies: 'Harpies',
  ghoul: 'Ghouls',
  vampire: 'Vampires',
  giant: 'Giants',
  beetle: 'Beetles',
  ant: 'Ants',
  wasp: 'Wasps',
  griffon: 'Griffons',
  manticore: 'Manticores',
};

/** A word's entry in a table, trying it as written and without a plural "s". */
function lookupWord(table: Record<string, string>, word: string): string | undefined {
  return table[word] ?? (word.endsWith('s') ? table[word.slice(0, -1)] : undefined);
}

/** The brood a danger shelters when its name or kind says it is a lair, its kind taken from the name; else null. */
export function lairBrood(place: WorldPlace): string | null {
  if (place.kind !== 'danger') return null;
  const words = `${place.name} ${String(place.tags.kind ?? '')}`.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const lair = words.map((word) => lookupWord(LAIR_WORDS, word)).find((kind) => kind !== undefined);
  if (lair === undefined) return null;
  return words.map((word) => lookupWord(CREATURE_WORDS, word)).find((kind) => kind !== undefined) ?? lair;
}

/** True when the region's map is at least XL_WIDTH wide. */
function isXlRegion(db: Db, campaignId: number): boolean {
  const row = db
    .prepare("SELECT json_extract(raw_json, '$.bp.width') AS width FROM world_region WHERE campaign_id = ?")
    .get(campaignId) as { width: unknown } | undefined;
  return typeof row?.width === 'number' && row.width >= XL_WIDTH;
}

/**
 * The realm whose capital is the region's one holy city, or null in the two regions of three without one.
 * Only a sovereign on-map kingdom qualifies, a capital with a temple building first.
 */
export function holyCityRealm(view: RegionView, politics: StoredPolitics): number | null {
  const rng = seededRng(mixSeed(view.seed, HOLY_CITY_SALT));
  if (rng() >= HOLY_CITY_CHANCE) return null;
  const capitalOf = (id: number | null) => view.places.find((place) => place.id === id);
  const eligible = politics.realms.filter(
    (realm) =>
      realm.kind === 'kingdom' && !realm.off_map && realm.liege_realm_id === null && realm.capital_place_id !== null,
  );
  const templed = eligible.filter((realm) => hasTemple(capitalOf(realm.capital_place_id)));
  const pool = templed.length > 0 ? templed : eligible;
  return pool.length > 0 ? rngPick(rng, pool).id : null;
}

function capitalInput(place: WorldPlace): NonNullable<GovernmentInput['capital']> {
  return {
    name: place.name,
    size: place.tags.size as 'village' | 'town' | 'city',
    walled: place.tags.walled === true,
    coast: place.tags.coast === true,
    link: place.link ?? '',
  };
}

/** The county holding a place's anchor hex, falling back to the county seated there. */
function countyContaining(politics: StoredPolitics, place: WorldPlace): StoredCounty | undefined {
  return (
    politics.counties.find((county) => county.hexes.includes(place.hexes[0])) ??
    (place.kind === 'settlement'
      ? politics.counties.find((county) => county.seat_place_id === place.id)
      : undefined)
  );
}

/** The realm at the top of a liege chain. */
function sovereignOf(politics: StoredPolitics, realmId: number): number {
  const seen = new Set<number>();
  let current = politics.realms.find((realm) => realm.id === realmId);
  while (current && current.liege_realm_id !== null && !seen.has(current.id)) {
    seen.add(current.id);
    const liege = politics.realms.find((realm) => realm.id === current!.liege_realm_id);
    if (!liege) break;
    current = liege;
  }
  return current?.id ?? realmId;
}

/** The ids of counties outside `from` that share a hex border with any county in it. */
function borderingCountyIds(politics: StoredPolitics, from: StoredCounty[]): Set<number> {
  const hexCounty = new Map<string, number>();
  for (const county of politics.counties) for (const hex of county.hexes) hexCounty.set(hex, county.id);
  const inside = new Set(from.map((county) => county.id));
  const bordering = new Set<number>();
  for (const county of from) {
    for (const hex of county.hexes) {
      const { q, r } = parseHex(hex);
      for (const step of hexNeighbours(q, r)) {
        const other = hexCounty.get(`q${step.q}_r${step.r}`);
        if (other !== undefined && !inside.has(other)) bordering.add(other);
      }
    }
  }
  return bordering;
}

/** The item with the smallest distance, ties going to the lower id. */
function nearestBy<T extends { id: number }>(items: T[], distance: (item: T) => number): T | undefined {
  let best: T | undefined;
  let bestDistance = Infinity;
  for (const item of items) {
    const value = distance(item);
    if (value < bestDistance || (value === bestDistance && best !== undefined && item.id < best.id)) {
      best = item;
      bestDistance = value;
    }
  }
  return best;
}

/** The faith and influence each faction holds, read straight from the table WorldFaction does not carry. */
function faithLinksOf(db: Db, campaignId: number): Map<number, FactionFaith> {
  const rows = db
    .prepare('SELECT id, faith_id, influence FROM world_faction WHERE campaign_id = ?')
    .all(campaignId) as Array<{ id: number; faith_id: number | null; influence: FactionFaith['influence'] }>;
  return new Map(rows.map((row) => [row.id, { faith_id: row.faith_id, influence: row.influence }]));
}

/** The church factions that follow a faith broken from this faction's own, for a persecution. */
function heresyTargets(ctx: AgendaContext): AgendaTarget[] {
  const faithId = ctx.faithLinks.get(ctx.faction.id)?.faith_id;
  if (faithId == null) return [];
  const heresyIds = new Set(
    ctx.faiths.filter((faith) => faith.heresy_of === faithId).map((faith) => faith.id),
  );
  if (heresyIds.size === 0) return [];
  return ctx.allFactions
    .filter(
      (other) =>
        other.id !== ctx.faction.id &&
        other.type === 'church' &&
        heresyIds.has(ctx.faithLinks.get(other.id)?.faith_id ?? -1),
    )
    .map((other) => ({ kind: 'rival_faction', id: other.id, name: other.name }));
}

/** The strong or dominant temples of a realm, for a crown that would seize their lands. */
function churchInRealmTargets(ctx: AgendaContext): AgendaTarget[] {
  if (ctx.faction.realm_id === null) return [];
  return ctx.allFactions
    .filter((other) => {
      if (other.id === ctx.faction.id || other.type !== 'church') return false;
      if (other.realm_id !== ctx.faction.realm_id) return false;
      const influence = ctx.faithLinks.get(other.id)?.influence;
      return influence === 'strong' || influence === 'dominant';
    })
    .map((other) => ({ kind: 'rival_faction', id: other.id, name: other.name }));
}

/** Neighbours of the faction's own type: the same or a bordering county, or a seat within NEIGHBOUR_HEXES. */
function rivalFactionTargets(ctx: AgendaContext): AgendaTarget[] {
  const { faction, politics } = ctx;
  const own = faction.county_id !== null ? politics.counties.find((county) => county.id === faction.county_id) : undefined;
  const bordering = own ? borderingCountyIds(politics, [own]) : new Set<number>();
  return ctx.allFactions
    .filter((other) => {
      if (other.id === faction.id || other.type !== faction.type) return false;
      if (own && other.county_id !== null && (other.county_id === own.id || bordering.has(other.county_id))) return true;
      const seat = other.place_id !== null ? ctx.view.places.find((place) => place.id === other.place_id) : undefined;
      return ctx.place !== null && seat !== undefined && placeDistance(ctx.place, seat) <= NEIGHBOUR_HEXES;
    })
    .map((other) => ({ kind: 'rival_faction', id: other.id, name: other.name }));
}

/**
 * Counties of other sovereigns bordering a sovereign realm's lands, its vassals' included, a claimed one
 * listed more often. A holder's capital or last county is left out, as transferCounty would refuse it.
 */
function expansionTargets(ctx: AgendaContext): AgendaTarget[] {
  const { politics } = ctx;
  const realm = politics.realms.find((entry) => entry.id === ctx.faction.realm_id);
  if (ctx.faction.type !== 'realm' || !realm || realm.liege_realm_id !== null) return [];
  const group = new Set(politics.realms.filter((entry) => sovereignOf(politics, entry.id) === realm.id).map((entry) => entry.id));
  const territory = politics.counties.filter((county) => group.has(county.realm_id));
  const bordering = borderingCountyIds(politics, territory);
  const targets: AgendaTarget[] = [];
  for (const county of politics.counties) {
    if (!bordering.has(county.id)) continue;
    const holder = politics.realms.find((entry) => entry.id === county.realm_id);
    if (!holder || holder.capital_place_id === county.seat_place_id || holder.county_ids.length <= 1) continue;
    const claims = politics.claims.filter((claim) => claim.county_id === county.id && group.has(claim.claimant_realm_id));
    const weight = Math.max(1, ...claims.map((claim) => CLAIM_WEIGHT[claim.strength]));
    for (let copy = 0; copy < weight; copy += 1) {
      targets.push({ kind: 'neighbour_county', id: county.id, name: county.name });
    }
  }
  return targets;
}

/** The realm faction a vassal owes fealty to: a house's own crown, or a vassal realm's liege. */
function liegeTargets(ctx: AgendaContext): AgendaTarget[] {
  const { faction } = ctx;
  const realm = ctx.politics.realms.find((entry) => entry.id === faction.realm_id);
  const liegeRealmId = faction.type === 'house' ? realm?.id : faction.type === 'realm' ? realm?.liege_realm_id : null;
  if (liegeRealmId == null) return [];
  const liege = ctx.allFactions.find(
    (other) => other.id !== faction.id && other.type === 'realm' && other.realm_id === liegeRealmId,
  );
  return liege ? [{ kind: 'rival_faction', id: liege.id, name: liege.name }] : [];
}

function settlementTargets(ctx: AgendaContext): AgendaTarget[] {
  const settlements = ctx.view.places.filter((place) => place.kind === 'settlement');
  if (ctx.faction.type === 'gang') {
    // A gang preys on the towns around its own, never on its own.
    if (!ctx.place) return [];
    return settlements
      .filter((place) => place.id !== ctx.place!.id && placeDistance(ctx.place!, place) <= 5)
      .map((place) => ({ kind: 'settlement', id: place.id, name: place.name }));
  }
  if (ctx.faction.type === 'church') {
    // A church preaches only where another faith holds, and never in its own seat.
    const faithId = ctx.faithLinks.get(ctx.faction.id)?.faith_id;
    if (faithId == null) return [];
    return settlements
      .filter((place) => place.id !== ctx.place?.id && ctx.settlementFaith(place.id) !== faithId)
      .map((place) => ({ kind: 'settlement', id: place.id, name: place.name }));
  }
  if (ctx.faction.type === 'monsters') {
    if (!ctx.place) return [];
    const nearest = nearestBy(settlements, (place) => placeDistance(ctx.place!, place));
    return nearest ? [{ kind: 'settlement', id: nearest.id, name: nearest.name }] : [];
  }
  if (ctx.faction.type === 'bandits') {
    // Bandits prey on the settlements around their camp, or the nearest one when none is close.
    if (!ctx.place) return [];
    const nearby = settlements.filter((place) => placeDistance(ctx.place!, place) <= 5);
    const nearest = nearestBy(settlements, (place) => placeDistance(ctx.place!, place));
    const pool = nearby.length > 0 ? nearby : nearest ? [nearest] : [];
    return pool.map((place) => ({ kind: 'settlement', id: place.id, name: place.name }));
  }
  return settlements
    .filter((place) => place.id !== ctx.place?.id)
    .map((place) => ({ kind: 'settlement', id: place.id, name: place.name }));
}

function dangerTargets(ctx: AgendaContext): AgendaTarget[] {
  if (!ctx.place) return [];
  const dangers = ctx.view.places.filter(
    (place) => place.kind === 'danger' && !ctx.clearedDangers.has(place.id),
  );
  const nearest = nearestBy(dangers, (place) => placeDistance(ctx.place!, place));
  if (!nearest || placeDistance(ctx.place, nearest) > 10) return [];
  return [{ kind: 'danger', id: nearest.id, name: nearest.name }];
}

function ownSeatTargets(ctx: AgendaContext): AgendaTarget[] {
  return ctx.place ? [{ kind: 'own_seat', id: ctx.place.id, name: ctx.place.name }] : [];
}

function targetsFor(kind: TargetRule, ctx: AgendaContext): AgendaTarget[] {
  switch (kind) {
    case 'rival_faction':
      return rivalFactionTargets(ctx);
    case 'neighbour_county':
      return expansionTargets(ctx);
    case 'settlement':
      return settlementTargets(ctx);
    case 'danger':
      return dangerTargets(ctx);
    case 'own_seat':
      return ownSeatTargets(ctx);
    case 'heresy':
      return heresyTargets(ctx);
    case 'church_in_realm':
      return churchInRealmTargets(ctx);
    case 'liege':
      return liegeTargets(ctx);
  }
}

/** Picks one template and target for a faction from the seeded generator; null when nothing fits. */
/** The settlement nearest to a place other than itself, for where a seat's works draw from. */
function nearestOtherSettlement(view: RegionView, place: WorldPlace): WorldPlace | undefined {
  const others = view.places.filter((entry) => entry.kind === 'settlement' && entry.id !== place.id);
  return nearestBy(others, (entry) => placeDistance(place, entry));
}

/** Wild places a bandit band may camp at: areas and lairless dangers, measured from their anchor hex. */
function banditSites(view: RegionView): WorldPlace[] {
  const settlements = view.places.filter((place) => place.kind === 'settlement');
  return view.places.filter((place) => {
    if (place.kind === 'settlement' || lairBrood(place) !== null) return false;
    const camp = { ...place, hexes: place.hexes.slice(0, 1) };
    return settlements.every((settlement) => placeDistance(camp, settlement) >= BANDIT_GAP);
  });
}

/** The settlement nearest to a place, for describing a danger by where it lurks. */
function nearestSettlement(view: RegionView, place: WorldPlace): WorldPlace | undefined {
  const settlements = view.places.filter((entry) => entry.kind === 'settlement');
  return nearestBy(settlements, (entry) => placeDistance(place, entry));
}

/** The name public text may use for a place: a danger site is named only by its nearest settlement. */
function publicPlaceName(view: RegionView, place: WorldPlace): string | undefined {
  return place.kind === 'danger' ? nearestSettlement(view, place)?.name : place.name;
}

/** Replaces every danger site name with the settlement nearest it, so no public text reveals the site. */
function redactDangerNames(view: RegionView, text: string): string {
  let redacted = text;
  for (const place of view.places) {
    if (place.kind !== 'danger' || !redacted.includes(place.name)) continue;
    redacted = redacted.replaceAll(place.name, nearestSettlement(view, place)?.name ?? 'the wilds');
  }
  return redacted;
}

/** A danger named only by its surroundings, so a portent never reveals the site itself. */
function dangerDescription(view: RegionView, id: number | null): string {
  const danger = id !== null ? view.places.find((entry) => entry.id === id) : undefined;
  const settlement = danger ? nearestSettlement(view, danger) : undefined;
  return settlement ? `the beast in the wilds near ${settlement.name}` : 'the beast in the wilds';
}

/** Fills a template with the names a player may hear, hiding monster factions and danger sites. */
export function publicText(
  view: RegionView,
  faction: WorldFaction,
  target: { kind: string; id: number | null; name: string },
  place: WorldPlace | null,
  text: string,
): string {
  const factionName = faction.type === 'monsters' ? 'a monstrous brood' : faction.name;
  const targetName = target.kind === 'danger' ? dangerDescription(view, target.id) : target.name;
  const placeName =
    faction.type === 'monsters'
      ? (place ? nearestSettlement(view, place)?.name : undefined) ?? target.name
      : target.kind === 'own_seat' && place
        ? nearestOtherSettlement(view, place)?.name ?? publicPlaceName(view, place) ?? target.name
        : (place ? publicPlaceName(view, place) : undefined) ?? target.name;
  const filled = fillText(text, { faction: factionName, target: targetName, place: placeName });
  const redacted = redactDangerNames(view, filled);
  return redacted.charAt(0).toUpperCase() + redacted.slice(1);
}

const SETTLING = new Set(['expand_territory', 'conversion', 'raise_cathedral']);

/** The danger sites where every brood has ended, so a hunter would strike at nothing. */
function clearedDangerIds(db: Db, campaignId: number): Set<number> {
  const byDanger = new Map<number, WorldFaction[]>();
  for (const faction of listFactions(db, campaignId, { includeEnded: true })) {
    if (faction.type !== 'monsters' || faction.place_id === null) continue;
    const list = byDanger.get(faction.place_id) ?? [];
    list.push(faction);
    byDanger.set(faction.place_id, list);
  }
  return new Set(
    [...byDanger.entries()]
      .filter(([, broods]) => broods.every((brood) => brood.ended_day != null))
      .map(([placeId]) => placeId),
  );
}

/** True when a settlement's unexpired state rules out this goal: a ruin stops raids and growth, a siege stops raids. */
function settlementStateBlocks(
  db: Db,
  campaignId: number,
  templateId: string,
  target: AgendaTarget,
  day: number,
): boolean {
  if (target.kind !== 'settlement') return false;
  const state = getPlaceState(db, campaignId, target.id, day)?.state ?? null;
  if (state === 'ruined') return templateId === 'raid' || templateId === 'monsters_grow';
  return state === 'besieged' && templateId === 'raid';
}

export function pickAgenda(
  db: Db,
  campaignId: number,
  faction: WorldFaction,
  day: number,
  seed: number,
  salt: number,
): WorldAgenda | null {
  const view = getRegion(db, campaignId);
  const politics = ensurePolitics(db, campaignId);
  if (!view || !politics) return null;

  const place =
    faction.place_id !== null
      ? view.places.find((entry) => entry.id === faction.place_id) ?? null
      : null;
  const ctx: AgendaContext = {
    faction,
    place,
    view,
    politics,
    allFactions: listFactions(db, campaignId),
    faithLinks: faithLinksOf(db, campaignId),
    faiths: listFaiths(db, campaignId),
    settlementFaith: (placeId) => settlementFaithId(db, campaignId, placeId),
    clearedDangers: clearedDangerIds(db, campaignId),
  };

  const agendas = listAgendas(db, campaignId);

  // A temple without real power cannot preach a holy war, and a heresy does not hunt its own kind.
  // A crown may run the faith's goals only when its faith is dominant, as in a theocracy.
  const blocked = new Set<string>();
  if (faction.type === 'church') {
    const own = ctx.faithLinks.get(faction.id);
    if (own?.influence !== 'strong' && own?.influence !== 'dominant') {
      blocked.add('crusade');
      blocked.add('persecute');
    }
    const faith = own?.faith_id != null ? getFaith(db, campaignId, own.faith_id) : undefined;
    if (faith?.heresy_of != null) blocked.add('persecute');
  }
  if (faction.type === 'realm') {
    const own = ctx.faithLinks.get(faction.id);
    if (own?.influence !== 'dominant') {
      blocked.add('crusade');
      blocked.add('persecute');
      blocked.add('raise_cathedral');
    }
    // A realm under interdict, or one that stripped its temples in the last year, does not seize again.
    if (faction.realm_id !== null && (excommunicatedUntil(db, campaignId, faction.realm_id) ?? 0) > day) {
      blocked.add('seize_church_lands');
    }
    if (
      agendas.some(
        (agenda) =>
          agenda.faction_id === faction.id &&
          agenda.template === 'seize_church_lands' &&
          agenda.status === 'won' &&
          (agenda.resolved_day ?? -Infinity) > day - 360,
      )
    ) {
      blocked.add('seize_church_lands');
    }
  }
  // A cathedral rises only in a city, and a seat builds again only once its size's cooldown has passed.
  if (place?.tags.size !== 'city') blocked.add('raise_cathedral');
  const size = place?.tags.size;
  const buildCooldown = size === 'city' || size === 'town' ? BUILD_COOLDOWN_DAYS[size] : BUILD_COOLDOWN_DAYS.village;
  const lastBuild = Math.max(
    -Infinity,
    ...agendas
      .filter((agenda) => agenda.faction_id === faction.id && agenda.template === 'build' && agenda.status === 'won')
      .map((agenda) => agenda.resolved_day ?? -Infinity),
  );
  if (day - lastBuild < buildCooldown) blocked.add('build');
  // A vassal turns on its liege only in a rare season, rolled apart from the main pick.
  const season = Math.floor(day / REVOLT_SEASON_DAYS);
  if (seededRng(mixSeed(seed, faction.id, season, REVOLT_SALT))() >= REVOLT_CHANCE) blocked.add('revolt');

  // Two factions chasing the same goal on the same target read as one repeated story, so such pairs are skipped.
  // A held goal is still in play, so it counts as taken too.
  const taken = new Set(
    agendas
      .filter((agenda) => agenda.status === 'active' || agenda.status === 'held')
      .map((agenda) => `${agenda.template}:${agenda.target_kind}:${agenda.target_id}`),
  );
  // A faction does not chase a goal it won in the last season, nor answer a rival's goal with the same goal against it.
  const recentWins = new Set(
    agendas
      .filter((agenda) => agenda.faction_id === faction.id && agenda.status === 'won' && (agenda.resolved_day ?? -Infinity) > day - 90)
      .map((agenda) => agenda.template),
  );
  // Taking a county or converting a town settles it, so the same faction never chases that pair again.
  const settled = new Set(
    agendas
      .filter((agenda) => agenda.faction_id === faction.id && agenda.status === 'won' && SETTLING.has(agenda.template))
      .map((agenda) => `${agenda.template}:${agenda.target_kind}:${agenda.target_id}`),
  );
  const mirrored = new Set(
    agendas
      .filter((agenda) => agenda.status === 'active' && agenda.target_kind === 'rival_faction' && agenda.target_id === faction.id)
      .map((agenda) => `${agenda.template}:${agenda.faction_id}`),
  );
  const candidatesWith = (skipSettled: boolean) =>
    templatesFor(faction.type as FactionType)
      .filter((template) => !blocked.has(template.id))
      .map((template) => ({
        template,
        targets: targetsFor(template.target, ctx).filter((target) => {
          const key = `${template.id}:${target.kind}:${target.id}`;
          // A consecrated cathedral is a one-off work, so it never returns even when nothing else is left.
          const settledHere = settled.has(key) && (skipSettled || template.id === 'raise_cathedral');
          return (
            !taken.has(key) &&
            !settledHere &&
            !settlementStateBlocks(db, campaignId, template.id, target, day) &&
            !(target.kind === 'rival_faction' && mirrored.has(`${template.id}:${target.id}`))
          );
        }),
      }))
      .filter((candidate) => candidate.targets.length > 0);
  // A faction that has settled everything within reach goes back to holding what it took rather than idling.
  const strict = candidatesWith(true);
  const candidates = strict.length > 0 ? strict : candidatesWith(false);
  const fresh = candidates.filter((candidate) => !recentWins.has(candidate.template.id));
  const pool = fresh.length > 0 ? fresh : candidates;
  if (candidates.length === 0) return null;

  const rng = seededRng(mixSeed(seed, faction.id, day, salt));
  const chosen = rngPick(rng, pool);
  const target = rngPick(rng, chosen.targets);

  return insertAgenda(db, campaignId, {
    faction_id: faction.id,
    template: chosen.template.id,
    target_kind: target.kind,
    target_id: target.id,
    target_name: target.name,
    clock_size: chosen.template.clock_size,
    clock_filled: 0,
    portents: chosen.template.portents.map((portent) => ({
      text: publicText(view, faction, target, place, portent),
      fired_day: null,
      heard: false,
    })),
    status: 'active',
    started_day: day,
  });
}

/** Creates the living world on first use, or reports the existing one without touching it. */
export function ensureWorld(db: Db, campaignId: number): WorldSummary | null {
  const view = getRegion(db, campaignId);
  if (!view) return null;
  const politics = ensurePolitics(db, campaignId);
  if (!politics) return null;

  const existing = getWorldState(db, campaignId);
  if (existing) {
    ensureFaiths(db, campaignId);
    return {
      seed: existing.seed,
      factions: listFactions(db, campaignId).length,
      agendas: listAgendas(db, campaignId).length,
      created: false,
    };
  }

  return db.transaction(() => {
    const seed = randomSeed();
    const today = currentGameDay(db, campaignId);
    saveWorldState(db, campaignId, { seed, last_tick_day: today, quiet_until_day: 0 });

    const realmNames = new Map<number, string>();
    const realmGovernments = new Map<number, Government>();
    const holyRealm = holyCityRealm(view, politics);
    const xl = isXlRegion(db, campaignId);
    for (const realm of politics.realms) {
      const capital =
        realm.capital_place_id !== null
          ? view.places.find((place) => place.id === realm.capital_place_id) ?? null
          : null;

      // The realm's kind decides its government; only a plain kingdom defers to the region's traits.
      let government: Government;
      let realmTitle: string;
      let rulerTitle: string;
      let computedName: string;
      if (realm.kind === 'free_city') {
        government = 'free_city';
        realmTitle = 'Free City';
        rulerTitle = titlesFor('free_city').ruler;
        computedName = realm.name;
      } else if (realm.kind === 'tribe') {
        government = 'tribal_confederation';
        realmTitle = 'Confederation';
        rulerTitle = titlesFor('tribal_confederation').ruler;
        computedName = realm.name;
      } else if (realm.kind === 'lordship') {
        government = 'kingdom';
        // A city-seated small realm is a principality rather than a lordship.
        const principality = realm.name.startsWith('Principality of');
        realmTitle = principality ? 'Principality' : 'Lordship';
        rulerTitle = principality ? 'Prince' : 'Lord';
        computedName = realm.name;
      } else if (realm.off_map) {
        const profile = deriveGovernment({
          region_name: view.name,
          region_tags: view.tags,
          capital: capital ? capitalInput(capital) : null,
          county_count: realm.county_ids.length,
          holy_city: false,
          xl,
          off_map: true,
        });
        // A distant overlord with no seat on this map is read as a kingdom; a known capital can make it something else.
        government = capital ? profile.government : 'kingdom';
        realmTitle = capital ? profile.realm_title : 'Kingdom';
        // Only an off-map kingdom takes a High King; other governments keep their own ruler.
        rulerTitle = government === 'kingdom' ? 'High King' : profile.ruler_title;
        computedName = realm.name;
      } else {
        const profile = deriveGovernment({
          region_name: view.name,
          region_tags: view.tags,
          capital: capital ? capitalInput(capital) : null,
          county_count: realm.county_ids.length,
          holy_city: realm.id === holyRealm,
          xl,
          off_map: false,
        });
        government = profile.government;
        realmTitle = profile.realm_title;
        rulerTitle = profile.ruler_title;
        computedName = profile.realm_name;
      }

      const codexUsesName =
        db
          .prepare('SELECT 1 AS found FROM entity WHERE campaign_id = ? AND lower(name) = lower(?)')
          .get(campaignId, realm.name) !== undefined;
      const name = codexUsesName ? realm.name : computedName;
      const faith =
        government === 'theocracy'
          ? `The Holy See of ${capital?.name ?? view.name}`
          : `Church of ${name}`;
      db.prepare(
        'UPDATE world_realm SET government = ?, realm_title = ?, ruler_title = ?, faith = ?, name = ? WHERE id = ? AND campaign_id = ?',
      ).run(government, realmTitle, rulerTitle, faith, name, realm.id, campaignId);
      realmNames.set(realm.id, name);
      realmGovernments.set(realm.id, government);
    }

    const addFaction = (
      faction: Omit<Parameters<typeof insertFaction>[2], 'capacities' | 'created_day'>,
    ): void => {
      insertFaction(db, campaignId, { ...faction, capacities: {}, created_day: today });
    };

    for (const realm of politics.realms) {
      addFaction({
        name: realmNames.get(realm.id)!,
        type: 'realm',
        realm_id: realm.id,
        // The realm acts from its capital: its levies muster and its works rise there.
        county_id: politics.counties.find((county) => county.seat_place_id === realm.capital_place_id)?.id ?? null,
        place_id: realm.capital_place_id,
        secrecy: 'open',
        resources: 5,
      });
    }

    // A duchy's own seat, when it is not the crown's demesne, names the house that holds it.
    const ducalSeats = new Set(
      politics.duchies
        .filter((duchy) => !duchy.demesne && duchy.seat_place_id !== null)
        .map((duchy) => duchy.seat_place_id),
    );
    const crownDuchies = new Set(politics.duchies.filter((duchy) => duchy.demesne).map((duchy) => duchy.id));
    for (const county of politics.counties) {
      const seat = view.places.find((place) => place.id === county.seat_place_id);
      const realm = politics.realms.find((entry) => entry.id === county.realm_id);
      const government = realmGovernments.get(county.realm_id);
      // A county seated at an undiscovered danger has no house named after it, so the dungeon stays secret.
      if (!seat || seat.kind !== 'settlement' || !realm || !government) continue;
      // A lordship or free city is its realm faction alone, and the crown itself holds its capital and crown lands.
      if (realm.kind === 'lordship' || realm.kind === 'free_city') continue;
      if (county.seat_place_id === realm.capital_place_id) continue;
      if (county.duchy_id !== null && crownDuchies.has(county.duchy_id)) continue;
      const rank: HouseRank = ducalSeats.has(seat.id) ? 'duke' : county.is_march ? 'margrave' : 'count';
      addFaction({
        name: houseName(government, rank, seat.name),
        type: 'house',
        realm_id: county.realm_id,
        county_id: county.id,
        place_id: seat.id,
        secrecy: 'open',
        resources: seat.tags.size === 'city' ? 4 : 3,
      });
    }

    for (const place of view.places) {
      if (place.kind !== 'settlement') continue;
      const isCity = place.tags.size === 'city';
      const coastalTown = place.tags.size === 'town' && place.tags.coast === true;
      if (!isCity && !coastalTown) continue;
      const county = countyContaining(politics, place);
      addFaction({
        name: `${place.name} Merchants' Guild`,
        type: 'guild',
        realm_id: county?.realm_id ?? null,
        county_id: county?.id ?? null,
        place_id: place.id,
        secrecy: 'open',
        resources: 3,
      });
    }

    for (const place of view.places) {
      if (place.kind !== 'settlement' || place.tags.size !== 'city') continue;
      const county = countyContaining(politics, place);
      addFaction({
        name: `The ${place.name} Knives`,
        type: 'gang',
        realm_id: county?.realm_id ?? null,
        county_id: county?.id ?? null,
        place_id: place.id,
        secrecy: 'discreet',
        resources: 2,
      });
    }

    for (const place of view.places) {
      const brood = lairBrood(place);
      if (brood === null) continue;
      const county = countyContaining(politics, place);
      addFaction({
        name: `The ${brood} of ${place.name}`,
        type: 'monsters',
        realm_id: county?.realm_id ?? null,
        county_id: county?.id ?? null,
        place_id: place.id,
        secrecy: 'open',
        resources: 2,
      });
    }

    const taken = new Set(listFactions(db, campaignId).map((faction) => faction.name.toLowerCase()));
    const banditRng = seededRng(mixSeed(seed, BANDIT_SALT));
    const sites = banditSites(view);
    const settlementCount = view.places.filter((place) => place.kind === 'settlement').length;
    const bands = Math.min(BANDIT_BANDS, Math.ceil(settlementCount / BANDIT_SETTLEMENTS));
    for (let band = 0; band < bands && sites.length > 0; band += 1) {
      const site = sites.splice(rngInt(banditRng, 0, sites.length - 1), 1)[0]!;
      const first = rngInt(banditRng, 0, BAND_NOUNS.length - 1);
      // A camp at a danger is named for the nearest settlement, so the site itself stays secret.
      const anchor = site.kind === 'danger' ? nearestSettlement(view, site)?.name : site.name;
      if (anchor === undefined) continue;
      const name = BAND_NOUNS.map((_, step) => `The ${anchor} ${BAND_NOUNS[(first + step) % BAND_NOUNS.length]}`)
        .find((candidate) => !taken.has(candidate.toLowerCase()));
      if (name === undefined) continue;
      taken.add(name.toLowerCase());
      const county = countyContaining(politics, site);
      addFaction({
        name,
        type: 'bandits',
        realm_id: county?.realm_id ?? null,
        county_id: county?.id ?? null,
        place_id: site.id,
        secrecy: 'discreet',
        resources: 2,
      });
    }

    ensureFaiths(db, campaignId, true);
    const factions = listFactions(db, campaignId);
    for (const faction of factions) {
      pickAgenda(db, campaignId, faction, today, seed, 1);
    }

    return {
      seed,
      factions: factions.length,
      agendas: listAgendas(db, campaignId).length,
      created: true,
    };
  })();
}
