// The living world's first day: derive each realm's government, seed the factions the map implies
// and hand every faction one agenda. Every choice comes from dice.ts's seeded generator.
import type { Db } from '../db/connection.js';
import {
  fillText,
  templatesFor,
  type FactionType,
  type TargetRule,
} from './agenda-templates.js';
import { mixSeed, randomSeed, rngPick, seededRng } from './dice.js';
import { deriveGovernment, titlesFor, type Government, type GovernmentInput } from './governments.js';
import { hexNeighbours } from './politics.js';
import { ensurePolitics } from './politics-service.js';
import type { StoredCounty, StoredPolitics } from './politics-store.js';
import { parseHex, placeDistance } from './region-graph.js';
import { getRegion, type RegionView, type WorldPlace } from './region.js';
import { ensureFaiths } from './world-faith-seed.js';
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
  ownCounty: StoredCounty | undefined;
  faithLinks: Map<number, FactionFaith>;
  faiths: WorldFaith[];
}

const HOUSE_PREFIX: Record<Government, string> = {
  kingdom: 'House of',
  empire: 'House of',
  theocracy: 'Bishopric of',
  merchant_republic: 'Magistracy of',
  free_city: 'Magistracy of',
  tribal_confederation: 'Clan of',
  league: 'Elders of',
};

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

function ownCountyOf(
  politics: StoredPolitics,
  view: RegionView,
  faction: WorldFaction,
): StoredCounty | undefined {
  if (faction.type === 'realm') {
    const realm = politics.realms.find((entry) => entry.id === faction.realm_id);
    const capital =
      realm?.capital_place_id != null
        ? view.places.find((place) => place.id === realm.capital_place_id)
        : undefined;
    return capital ? countyContaining(politics, capital) : undefined;
  }
  return faction.county_id !== null
    ? politics.counties.find((county) => county.id === faction.county_id)
    : undefined;
}

/** True when any hex of one county is a neighbour of any hex of the other. */
function sharesBorder(a: StoredCounty, b: StoredCounty): boolean {
  const bHexes = new Set(b.hexes);
  for (const hex of a.hexes) {
    const { q, r } = parseHex(hex);
    for (const neighbour of hexNeighbours(q, r)) {
      if (bHexes.has(`q${neighbour.q}_r${neighbour.r}`)) return true;
    }
  }
  return false;
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

function rivalFactionTargets(all: WorldFaction[], faction: WorldFaction): AgendaTarget[] {
  const sameType = all.filter((other) => other.id !== faction.id && other.type === faction.type);
  const pool =
    sameType.length > 0
      ? sameType
      : all.filter(
          (other) =>
            other.id !== faction.id && other.type !== 'monsters' && other.realm_id === faction.realm_id,
        );
  return pool.map((other) => ({ kind: 'rival_faction', id: other.id, name: other.name }));
}

function neighbourCountyTargets(
  politics: StoredPolitics,
  own: StoredCounty | undefined,
): AgendaTarget[] {
  const others = politics.counties.filter((county) => county.id !== own?.id);
  const bordering = own ? others.filter((county) => sharesBorder(own, county)) : [];
  const pool = bordering.length > 0 ? bordering : others;
  return pool.map((county) => ({ kind: 'neighbour_county', id: county.id, name: county.name }));
}

function settlementTargets(ctx: AgendaContext): AgendaTarget[] {
  const settlements = ctx.view.places.filter((place) => place.kind === 'settlement');
  if (ctx.faction.type === 'gang') {
    if (!ctx.place) return [];
    const nearby = settlements.filter(
      (place) => place.id !== ctx.place!.id && placeDistance(ctx.place!, place) <= 5,
    );
    const pool = nearby.length > 0 ? nearby : settlements.filter((place) => place.id === ctx.place!.id);
    return pool.map((place) => ({ kind: 'settlement', id: place.id, name: place.name }));
  }
  if (ctx.faction.type === 'monsters') {
    if (!ctx.place) return [];
    const nearest = nearestBy(settlements, (place) => placeDistance(ctx.place!, place));
    return nearest ? [{ kind: 'settlement', id: nearest.id, name: nearest.name }] : [];
  }
  return settlements.map((place) => ({ kind: 'settlement', id: place.id, name: place.name }));
}

function dangerTargets(ctx: AgendaContext): AgendaTarget[] {
  if (!ctx.place) return [];
  const dangers = ctx.view.places.filter((place) => place.kind === 'danger');
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
      return rivalFactionTargets(ctx.allFactions, ctx.faction);
    case 'neighbour_county':
      return neighbourCountyTargets(ctx.politics, ctx.ownCounty);
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
  }
}

/** Picks one template and target for a faction from the seeded generator; null when nothing fits. */
/** The settlement nearest to a place other than itself, for where a seat's works draw from. */
function nearestOtherSettlement(view: RegionView, place: WorldPlace): WorldPlace | undefined {
  const others = view.places.filter((entry) => entry.kind === 'settlement' && entry.id !== place.id);
  return nearestBy(others, (entry) => placeDistance(place, entry));
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
    ownCounty: ownCountyOf(politics, view, faction),
    faithLinks: faithLinksOf(db, campaignId),
    faiths: listFaiths(db, campaignId),
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
    const realmCapitals = new Map<number, WorldPlace | null>();
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
        });
        government = profile.government;
        realmTitle = profile.realm_title;
        // Only an off-map kingdom takes a High King; other governments keep their own ruler.
        rulerTitle = government === 'kingdom' ? 'High King' : profile.ruler_title;
        computedName = realm.name;
      } else {
        const profile = deriveGovernment({
          region_name: view.name,
          region_tags: view.tags,
          capital: capital ? capitalInput(capital) : null,
          county_count: realm.county_ids.length,
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
      realmCapitals.set(realm.id, capital);
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
    for (const county of politics.counties) {
      const seat = view.places.find((place) => place.id === county.seat_place_id);
      const government = realmGovernments.get(county.realm_id);
      // A county seated at an undiscovered danger has no house named after it, so the dungeon stays secret.
      if (!seat || seat.kind !== 'settlement' || !government) continue;
      const houseName =
        ducalSeats.has(seat.id)
            ? `Ducal House of ${seat.name}`
            : county.is_march
              ? `Margraves of ${seat.name}`
              : `${HOUSE_PREFIX[government]} ${seat.name}`;
      addFaction({
        name: houseName,
        type: 'house',
        realm_id: county.realm_id,
        county_id: county.id,
        place_id: seat.id,
        secrecy: 'open',
        resources: seat.tags.size === 'city' ? 4 : 3,
      });
    }

    for (const realm of politics.realms) {
      if (realmGovernments.get(realm.id) === 'theocracy') continue;
      const capital = realmCapitals.get(realm.id) ?? null;
      addFaction({
        name: `Temple of ${capital?.name ?? view.name}`,
        type: 'church',
        realm_id: realm.id,
        county_id: null,
        place_id: capital?.id ?? null,
        secrecy: 'open',
        resources: 3,
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
      if (place.kind !== 'settlement') continue;
      if (place.tags.size !== 'town' && place.tags.size !== 'city') continue;
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
      if (place.kind !== 'danger') continue;
      const county = countyContaining(politics, place);
      addFaction({
        name: `The Brood of ${place.name}`,
        type: 'monsters',
        realm_id: county?.realm_id ?? null,
        county_id: county?.id ?? null,
        place_id: place.id,
        secrecy: 'open',
        resources: 2,
      });
    }

    const factions = listFactions(db, campaignId);
    ensureFaiths(db, campaignId);
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
