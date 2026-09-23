// The briefing's region block: the map the DM sets the story in, where the party stands on it and the
// dangers only the DM knows. Empty without a region, and the player's window never reads it.
import type { Db } from '../db/connection.js';
import { getRegion, type RegionView, type WorldPlace, type WorldRoute } from './region.js';
import { locatePlace, MILES_PER_HEX, nearbyPlaces, placeDistance } from './region-graph.js';

const SETTLEMENT_LIMIT = 15;
const AREA_LIMIT = 15;
const ROUTE_LIMIT = 15;
const DANGER_LIMIT = 8;
const NEARBY_LIMIT = 8;

/** The tail of a cut list: its own bullet, or a comma-separated addition for an inline list. */
function cutTail(count: number, limit: number, prefix: string): string | null {
  return count > limit ? `${prefix}… and ${count - limit} more` : null;
}

function settlementLine(place: WorldPlace): string {
  const tags = place.tags;
  const flags = [String(tags.size ?? '')];
  if (tags.walled === true) flags.push('walled');
  if (tags.coast === true) flags.push('coast');
  const info = place.info.trim();
  return `- ${place.name} (${flags.filter((flag) => flag.length > 0).join(', ')}; ${String(tags.terrain)})${
    info ? ` - ${info}` : ''
  }${place.known_to_party ? ' [known]' : ''}`;
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
function dangerLine(danger: WorldPlace, settlements: WorldPlace[]): string {
  let nearest: WorldPlace | null = null;
  let distance = Infinity;
  for (const settlement of settlements) {
    const hexes = placeDistance(danger, settlement);
    if (hexes < distance) {
      nearest = settlement;
      distance = hexes;
    }
  }
  const where = nearest ? `, ${distance} hexes from ${nearest.name}` : '';
  return `- ${danger.name} (dungeon${where})${danger.known_to_party ? ' [known]' : ''}`;
}

export function regionBriefing(db: Db, campaignId: number, locationName: string | null): string {
  const view = getRegion(db, campaignId);
  if (!view) return '';

  const settlements = view.places.filter((p) => p.kind === 'settlement');
  const areas = view.places.filter((p) => p.kind === 'area');
  const dangers = view.places.filter((p) => p.kind === 'danger');

  const lines = [
    `## Region: ${view.name} (${view.tags.join(', ')}; 1 hex = ${MILES_PER_HEX} miles)`,
    'Set the story in this region: open scenes in or between these places, and name new places (an inn, a farm, a shrine) only inside it. Look a place up with region {op: get, place}; when the party learns of one, region {op: reveal, place}.',
  ];

  let at: WorldPlace | undefined;
  if (locationName !== null && locationName.trim().length > 0) {
    at = locatePlace(view, locationName);
    lines.push(
      at ? `Party is at: ${at.name} (${at.kind})` : `Party is at "${locationName}", which is not on the region map.`,
    );
  }

  if (settlements.length > 0) {
    lines.push('Settlements:');
    for (const place of settlements.slice(0, SETTLEMENT_LIMIT)) lines.push(settlementLine(place));
    const tail = cutTail(settlements.length, SETTLEMENT_LIMIT, '- ');
    if (tail) lines.push(tail);
  }

  if (areas.length > 0) {
    const shown = areas.slice(0, AREA_LIMIT).map((area) => `${area.name} (${String(area.tags.terrain)})`);
    lines.push(`Areas: ${shown.join(', ')}${cutTail(areas.length, AREA_LIMIT, ', ') ?? ''}`);
  }

  if (view.routes.length > 0) {
    const kept = view.routes.slice(0, ROUTE_LIMIT);
    const roads = kept.filter((route) => route.kind === 'road').map((route) => routeItem(view, route));
    const seas = kept.filter((route) => route.kind === 'searoute').map((route) => routeItem(view, route));
    let line = `Routes: ${roads.join(', ')}`;
    if (seas.length > 0) line += `${roads.length > 0 ? '; ' : ''}sea: ${seas.join(', ')}`;
    lines.push(`${line}${cutTail(view.routes.length, ROUTE_LIMIT, ', ') ?? ''}`);
  }

  if (dangers.length > 0) {
    lines.push('Dangers (DM only):');
    for (const danger of dangers.slice(0, DANGER_LIMIT)) lines.push(dangerLine(danger, settlements));
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
