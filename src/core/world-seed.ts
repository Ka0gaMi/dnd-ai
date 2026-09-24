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
import { deriveGovernment, type Government, type GovernmentInput } from './governments.js';
import { hexNeighbours } from './politics.js';
import { ensurePolitics } from './politics-service.js';
import type { StoredCounty, StoredPolitics } from './politics-store.js';
import { parseHex, placeDistance } from './region-graph.js';
import { getRegion, type RegionView, type WorldPlace } from './region.js';
import { ensureFaiths } from './world-faith-seed.js';
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
        ? nearestOtherSettlement(view, place)?.name ?? place.name
        : place?.name ?? target.name;
  const filled = fillText(text, { faction: factionName, target: targetName, place: placeName });
  return filled.charAt(0).toUpperCase() + filled.slice(1);
}

const SETTLING = new Set(['expand_territory', 'conversion']);

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
  };

  // Two factions chasing the same goal on the same target read as one repeated story, so such pairs are skipped.
  // A held goal is still in play, so it counts as taken too.
  const agendas = listAgendas(db, campaignId);
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
      .map((template) => ({
        template,
        targets: targetsFor(template.target, ctx).filter(
          (target) =>
            !taken.has(`${template.id}:${target.kind}:${target.id}`) &&
            !(skipSettled && settled.has(`${template.id}:${target.kind}:${target.id}`)) &&
            !(target.kind === 'rival_faction' && mirrored.has(`${template.id}:${target.id}`)),
        ),
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
      const profile = deriveGovernment({
        region_name: view.name,
        region_tags: view.tags,
        capital: capital ? capitalInput(capital) : null,
        county_count: realm.county_ids.length,
      });
      const codexUsesName =
        db
          .prepare('SELECT 1 AS found FROM entity WHERE campaign_id = ? AND lower(name) = lower(?)')
          .get(campaignId, realm.name) !== undefined;
      const name = codexUsesName ? realm.name : profile.realm_name;
      const faith =
        profile.government === 'theocracy'
          ? `The Holy See of ${capital?.name ?? view.name}`
          : `Church of ${name}`;
      db.prepare(
        'UPDATE world_realm SET government = ?, realm_title = ?, ruler_title = ?, faith = ?, name = ? WHERE id = ? AND campaign_id = ?',
      ).run(profile.government, profile.realm_title, profile.ruler_title, faith, name, realm.id, campaignId);
      realmNames.set(realm.id, name);
      realmGovernments.set(realm.id, profile.government);
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

    for (const county of politics.counties) {
      const seat = view.places.find((place) => place.id === county.seat_place_id);
      const government = realmGovernments.get(county.realm_id);
      if (!seat || !government) continue;
      addFaction({
        name: `${HOUSE_PREFIX[government]} ${seat.name}`,
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
