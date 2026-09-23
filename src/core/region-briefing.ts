// The briefing's region block: the map the DM sets the story in, where the party stands on it and the
// dangers only the DM knows. Empty without a region, and the player's window never reads it.
import type { Db } from '../db/connection.js';
import { ensurePolitics } from './politics-service.js';
import type { StoredPolitics, StoredRealm } from './politics-store.js';
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
function countyOf(politics: StoredPolitics | null, place: WorldPlace): string | null {
  if (!politics) return null;
  const county =
    politics.counties.find((entry) => entry.hexes.includes(place.hexes[0])) ??
    (place.kind === 'settlement' ? politics.counties.find((entry) => entry.seat_place_id === place.id) : undefined);
  return county?.name ?? null;
}

function realmPart(realm: StoredRealm, capitals: Map<number, string>, counties: string[]): string {
  const capital = realm.capital_place_id === null ? undefined : capitals.get(realm.capital_place_id);
  const crown = capital === undefined ? 'no crown' : `capital ${capital}`;
  return counties.length === 0 ? `${realm.name} (${crown})` : `${realm.name} (${crown}; ${counties.join(', ')})`;
}

/** The realms line, capped at 6 realms and 12 counties across them; the tail names what was cut. */
function realmsLine(politics: StoredPolitics, places: WorldPlace[]): string {
  const capitals = new Map(places.map((place) => [place.id, place.name]));
  const countyNames = new Map(
    politics.counties
      .filter((county) => county.hexes.length > 0)
      .map((county) => [county.id, county.name]),
  );
  const realms = politics.realms.slice(0, REALM_LIMIT);
  const parts: string[] = [];
  let budget = COUNTY_LIMIT;
  let droppedCounties = 0;
  let droppedRealms = politics.realms.length - realms.length;

  for (let index = 0; index < realms.length; index += 1) {
    const realm = realms[index];
    const names = realm.county_ids
      .map((id) => countyNames.get(id))
      .filter((name): name is string => name !== undefined);
    if (names.length > budget) {
      if (budget === 0) {
        droppedRealms += realms.length - index;
        break;
      }
      parts.push(realmPart(realm, capitals, names.slice(0, budget)));
      droppedCounties += names.length - budget;
      budget = 0;
      continue;
    }
    parts.push(realmPart(realm, capitals, names));
    budget -= names.length;
  }

  const tails = [
    droppedCounties > 0 ? `${droppedCounties} more counties` : null,
    droppedRealms > 0 ? `${droppedRealms} more realms` : null,
  ].filter((part): part is string => part !== null);
  const line = `Realms: ${parts.join('; ')}`;
  return tails.length > 0 ? `${line}; … and ${tails.join(' and ')}` : line;
}

function settlementLine(place: WorldPlace, county: string | null): string {
  const tags = place.tags;
  const flags = [String(tags.size ?? '')];
  if (tags.walled === true) flags.push('walled');
  if (tags.coast === true) flags.push('coast');
  const info = place.info.trim();
  return `- ${place.name} (${flags.filter((flag) => flag.length > 0).join(', ')}; ${String(tags.terrain)}${
    county === null ? '' : `; ${county}`
  })${info ? ` - ${info}` : ''}${place.known_to_party ? ' [known]' : ''}`;
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

  if (politics && politics.realms.length > 0) lines.push(realmsLine(politics, view.places));

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
      lines.push(settlementLine(place, countyOf(politics, place)));
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
      lines.push(dangerLine(danger, settlements, countyOf(politics, danger)));
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
