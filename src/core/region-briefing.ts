// The briefing's region block: the map the DM sets the story in, where the party stands on it and the
// dangers only the DM knows. Empty without a region, and the player's window never reads it.
import { governmentLabel } from './governments.js';
import type { Db } from '../db/connection.js';
import { ensurePolitics } from './politics-service.js';
import type { StoredCounty, StoredPolitics, StoredRealm } from './politics-store.js';
import { getRegion, type RegionView, type WorldPlace, type WorldRoute } from './region.js';
import { locatePlace, MILES_PER_HEX, nearbyPlaces, placeDistance } from './region-graph.js';

const SETTLEMENT_LIMIT = 15;
const AREA_LIMIT = 15;
const ROAD_LIMIT = 10;
const SEA_LIMIT = 5;
const DANGER_LIMIT = 8;
const NEARBY_LIMIT = 8;
const REALM_LIMIT = 6;
const COUNTY_LIMIT = 12;

/** The tail of a cut list: its own bullet, or a comma-separated addition for an inline list. */
function cutTail(count: number, limit: number, prefix: string): string | null {
  return count > limit ? `${prefix}… and ${count - limit} more` : null;
}

/** The county holding a place's anchor hex, or, for a settlement, the one seated there. */
function countyFor(politics: StoredPolitics | null, place: WorldPlace): StoredCounty | undefined {
  if (!politics) return undefined;
  return (
    politics.counties.find((entry) => entry.hexes.includes(place.hexes[0])) ??
    (place.kind === 'settlement' ? politics.counties.find((entry) => entry.seat_place_id === place.id) : undefined)
  );
}

/** The duchy a county belongs to, for the settlement lines that name it. */
function duchyNameOf(politics: StoredPolitics, county: StoredCounty | undefined): string | null {
  if (!county || county.duchy_id === null) return null;
  return politics.duchies.find((entry) => entry.id === county.duchy_id)?.name ?? null;
}

/** A realm's descriptor: the living world's government once assigned, else its map kind. */
function realmDescriptor(realm: StoredRealm): string {
  return governmentLabel(realm.government ?? realm.kind);
}

/** The realm, duchy and county hierarchy, capped by REALM_LIMIT and COUNTY_LIMIT; tails name what was cut. */
export function realmHierarchyLines(politics: StoredPolitics, places: WorldPlace[]): string[] {
  const placeName = (id: number | null): string | null =>
    id === null ? null : (places.find((place) => place.id === id)?.name ?? null);
  const realmNames = new Map(politics.realms.map((realm) => [realm.id, realm.name]));
  const counties = new Map(politics.counties.map((county) => [county.id, county]));
  const named = (ids: number[]): string[] =>
    ids
      .map((id) => counties.get(id))
      .filter((county): county is StoredCounty => county !== undefined && county.hexes.length > 0)
      .map((county) => county.name);

  const lines = ['Realms:'];
  let budget = COUNTY_LIMIT;
  let droppedCounties = 0;

  const take = (names: string[]): string[] => {
    if (names.length <= budget) {
      budget -= names.length;
      return names;
    }
    const shown = names.slice(0, Math.max(budget, 0));
    droppedCounties += names.length - shown.length;
    budget = 0;
    return shown;
  };

  for (const realm of politics.realms.slice(0, REALM_LIMIT)) {
    const capital =
      realm.off_map
        ? 'capital off the map'
        : realm.capital_place_id === null
          ? 'no crown'
          : `capital ${placeName(realm.capital_place_id)}`;
    const liege = realm.liege_realm_id === null ? null : realmNames.get(realm.liege_realm_id);
    const vassal = liege === null || liege === undefined ? '' : `, vassal of ${liege}`;
    lines.push(`${realm.name} (${realmDescriptor(realm)}, ${capital}${vassal})`);

    const held = new Set<number>();
    for (const duchy of politics.duchies.filter((entry) => entry.realm_id === realm.id)) {
      const ids = duchy.county_ids.filter((id) => (counties.get(id)?.hexes.length ?? 0) > 0);
      ids.forEach((id) => held.add(id));
      const flags = [`seat ${placeName(duchy.seat_place_id) ?? 'unseated'}`];
      if (duchy.demesne) flags.push('crownlands');
      if (duchy.joined_how !== 'core') flags.push(`joined by ${duchy.joined_how}`);
      const shown = take(named(ids));
      lines.push(`  ${duchy.name} (${flags.join(', ')}): ${shown.join(', ') || 'no counties'}`);
    }

    const outside = take(named(realm.county_ids.filter((id) => !held.has(id))));
    if (outside.length > 0) lines.push(`  Outside duchies: ${outside.join(', ')}`);
  }

  const droppedRealms = politics.realms.length - Math.min(politics.realms.length, REALM_LIMIT);
  const tails = [
    droppedCounties > 0 ? `${droppedCounties} more counties` : null,
    droppedRealms > 0 ? `${droppedRealms} more realms` : null,
  ].filter((part): part is string => part !== null);
  if (tails.length > 0) lines.push(`… and ${tails.join(' and ')}`);

  const marches = politics.counties
    .filter((county) => county.is_march && county.hexes.length > 0)
    .map((county) => county.name);
  if (marches.length > 0) {
    lines.push(`Marches: ${marches.slice(0, COUNTY_LIMIT).join(', ')}${cutTail(marches.length, COUNTY_LIMIT, ', ') ?? ''}`);
  }

  for (const claim of politics.claims.slice(0, COUNTY_LIMIT)) {
    const county = counties.get(claim.county_id);
    const claimant = realmNames.get(claim.claimant_realm_id);
    if (!county || claimant === undefined) continue;
    lines.push(`Contested: ${county.name} — claimed by ${claimant} (${claim.reason}, ${claim.strength})`);
  }
  if (politics.claims.length > COUNTY_LIMIT) lines.push(`… and ${politics.claims.length - COUNTY_LIMIT} more claims`);

  return lines;
}

function settlementLine(place: WorldPlace, county: string | null, duchy: string | null): string {
  const tags = place.tags;
  const flags = [String(tags.size ?? '')];
  if (tags.walled === true) flags.push('walled');
  if (tags.coast === true) flags.push('coast');
  const town = tags.size === 'town' || tags.size === 'city';
  const holds = county === null ? '' : `; ${county}${town && duchy !== null ? `, ${duchy}` : ''}`;
  const info = place.info.trim();
  return `- ${place.name} (${flags.filter((flag) => flag.length > 0).join(', ')}; ${String(tags.terrain)}${holds})${
    info ? ` - ${info}` : ''
  }${tags.coast === true ? ' [port]' : ''}${place.known_to_party ? ' [known]' : ''}`;
}

/** A route endpoint reads as the settlement on that hex; any other endpoint is where the route leaves the map. */
function routeEndpoint(view: RegionView, hex: string): string {
  const settlement = view.places.find((p) => p.kind === 'settlement' && p.hexes.includes(hex));
  return settlement?.name ?? 'the map edge';
}

function routeItem(view: RegionView, route: WorldRoute): string {
  return `${routeEndpoint(view, route.from_hex)}-${routeEndpoint(view, route.to_hex)} ${route.hexes.length - 1} hexes`;
}

/** A danger with its distance to the nearest settlement, ties going to the first in place order. */
function dangerLine(danger: WorldPlace, settlements: WorldPlace[], county: string | null): string {
  let nearest: WorldPlace | null = null;
  let distance = Infinity;
  for (const settlement of settlements) {
    const hexes = placeDistance(danger, settlement);
    if (hexes < distance) {
      nearest = settlement;
      distance = hexes;
    }
  }
  const suffix = county === null ? '' : `, in ${county}`;
  const where = nearest ? `, ${distance} hexes from ${nearest.name}${suffix}` : '';
  return `- ${danger.name} (dungeon${where})${danger.known_to_party ? ' [known]' : ''}`;
}

export function regionBriefing(db: Db, campaignId: number, locationName: string | null): string {
  const view = getRegion(db, campaignId);
  if (!view) return '';

  const politics = ensurePolitics(db, campaignId);
  const settlements = view.places.filter((p) => p.kind === 'settlement');
  const areas = view.places.filter((p) => p.kind === 'area');
  const dangers = view.places.filter((p) => p.kind === 'danger');

  const lines = [
    `## Region: ${view.name} (${view.tags.join(', ')}; 1 hex = ${MILES_PER_HEX} miles)`,
    'Set the story in this region: open scenes in or between these places, and name new places (an inn, a farm, a shrine) only inside it. Look a place up with region {op: get, place}; when the party learns of one, region {op: reveal, place}.',
  ];

  if (politics && politics.realms.length > 0) lines.push(...realmHierarchyLines(politics, view.places));

  let at: WorldPlace | undefined;
  if (locationName !== null && locationName.trim().length > 0) {
    at = locatePlace(view, locationName);
    if (!at) {
      lines.push(`Party is at "${locationName}", which is not on the region map.`);
    } else if (at.name.toLowerCase() === locationName.trim().toLowerCase()) {
      lines.push(`Party is at: ${at.name} (${at.kind})`);
    } else {
      lines.push(`Party is around: ${at.name} (${at.kind}), from the scene location "${locationName}"`);
    }
  }

  if (settlements.length > 0) {
    lines.push('Settlements:');
    for (const place of settlements.slice(0, SETTLEMENT_LIMIT)) {
      const county = countyFor(politics, place);
      lines.push(settlementLine(place, county?.name ?? null, politics ? duchyNameOf(politics, county) : null));
    }
    const tail = cutTail(settlements.length, SETTLEMENT_LIMIT, '- ');
    if (tail) lines.push(tail);
  }

  if (areas.length > 0) {
    const shown = areas.slice(0, AREA_LIMIT).map((area) => `${area.name} (${String(area.tags.terrain)})`);
    lines.push(`Areas: ${shown.join(', ')}${cutTail(areas.length, AREA_LIMIT, ', ') ?? ''}`);
  }

  if (view.routes.length > 0) {
    const roads = view.routes.filter((route) => route.kind === 'road');
    const seas = view.routes.filter((route) => route.kind === 'searoute');
    const roadsPart =
      roads.slice(0, ROAD_LIMIT).map((route) => routeItem(view, route)).join(', ') +
      (cutTail(roads.length, ROAD_LIMIT, ', ') ?? '');
    const seasPart =
      seas.slice(0, SEA_LIMIT).map((route) => routeItem(view, route)).join(', ') +
      (cutTail(seas.length, SEA_LIMIT, ', ') ?? '');
    let line = `Routes: ${roadsPart}`;
    if (seas.length > 0) line += `${roads.length > 0 ? '; ' : ''}sea: ${seasPart}`;
    lines.push(line);
  }

  if (dangers.length > 0) {
    lines.push('Dangers (DM only):');
    for (const danger of dangers.slice(0, DANGER_LIMIT)) {
      lines.push(dangerLine(danger, settlements, countyFor(politics, danger)?.name ?? null));
    }
    const tail = cutTail(dangers.length, DANGER_LIMIT, '- ');
    if (tail) lines.push(tail);
  }

  if (at) {
    const near = nearbyPlaces(view, at, 3);
    if (near.length > 0) {
      const shown = near
        .slice(0, NEARBY_LIMIT)
        .map((entry) => `${entry.place.name} (${entry.place.kind}, ${entry.hexes} hexes)`);
      lines.push(`Near the party: ${shown.join(', ')}${cutTail(near.length, NEARBY_LIMIT, ', ') ?? ''}`);
    }
  }

  return lines.join('\n');
}
