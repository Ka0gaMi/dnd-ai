// Pure assembly of the region as the player may see it: only hexes near known places, known places
// and routes, politics named on visible land, and the party's own position.
import { hexDistance, parseHex, type Hex } from './region-graph.js';
import { hexNeighbours } from './politics.js';
import type { StoredPolitics } from './politics-store.js';
import type { RegionView, WorldPlace } from './region.js';

export interface PlayerRegionMap {
  name: string;
  width: number;
  height: number;
  hexes: Array<{ id: string; q: number; r: number; terrain: string; county: number | null }>;
  counties: Array<{ name: string | null; realm: number }>;
  realms: Array<{ name: string | null }>;
  duchies: Array<{
    id: number;
    name: string | null;
    /** Border segments between two known hexes of different duchies, as hex-id pairs. */
    border: Array<{ from: string; to: string }>;
    /** The duchy's known hexes, so the client can place its name at the known centroid. */
    hexes: string[];
  }>;
  places: Array<{
    name: string;
    kind: 'settlement' | 'area' | 'danger';
    size: string | null;
    port: boolean;
    q: number;
    r: number;
  }>;
  routes: Array<{ kind: 'road' | 'searoute'; hexes: string[] }>;
  party: { q: number; r: number } | null;
}

const anchorOf = (place: WorldPlace): string => `q${place.q}_r${place.r}`;

export function playerRegionMap(input: {
  view: RegionView;
  hexes: Array<{ id: string; q: number; r: number; terrain: string }>;
  politics: StoredPolitics | null;
  partyPlace: WorldPlace | null;
}): PlayerRegionMap {
  const { view, hexes, politics, partyPlace } = input;

  const knownPlaces = view.places.filter((place) => place.known_to_party);
  const knownSettlements = knownPlaces.filter((place) => place.kind === 'settlement');
  const knownPlaceIds = new Set(knownPlaces.map((place) => place.id));
  const knownSettlementAnchors = new Set(knownSettlements.map(anchorOf));

  const places: PlayerRegionMap['places'] = knownPlaces.map((place) => ({
    name: place.name,
    kind: place.kind,
    size: place.kind === 'settlement' ? ((place.tags.size as string | undefined) ?? null) : null,
    port: place.kind === 'settlement' && place.tags.coast === true,
    q: place.q,
    r: place.r,
  }));

  const routes: PlayerRegionMap['routes'] = view.routes
    .filter((route) => knownSettlementAnchors.has(route.from_hex) && knownSettlementAnchors.has(route.to_hex))
    .map((route) => ({ kind: route.kind, hexes: route.hexes }));

  const nearKnown = knownPlaces
    .filter((place) => place.kind === 'settlement' || place.kind === 'danger')
    .flatMap((place) => place.hexes)
    .map(parseHex);
  const nearAreas = knownPlaces
    .filter((place) => place.kind === 'area')
    .flatMap((place) => place.hexes)
    .map(parseHex);
  const routeHexes = new Set(routes.flatMap((route) => route.hexes));
  const partyAnchor = partyPlace ? { q: partyPlace.q, r: partyPlace.r } : null;

  const visible: Array<{ id: string; q: number; r: number; terrain: string }> = [];
  for (const hex of hexes) {
    const within = (sources: Hex[], max: number): boolean =>
      sources.some((source) => hexDistance(hex, source) <= max);
    const isVisible =
      within(nearKnown, 2) ||
      within(nearAreas, 1) ||
      routeHexes.has(hex.id) ||
      (partyAnchor !== null && hexDistance(hex, partyAnchor) <= 1);
    if (isVisible) visible.push(hex);
  }

  const storedCountyOfHex = new Map<string, number>();
  if (politics) {
    politics.counties.forEach((county, stored) => {
      for (const id of county.hexes) if (!storedCountyOfHex.has(id)) storedCountyOfHex.set(id, stored);
    });
  }

  const countyIndex = new Map<number, number>();
  const realmIndex = new Map<number, number>();
  const counties: PlayerRegionMap['counties'] = [];
  const realms: PlayerRegionMap['realms'] = [];

  if (politics) {
    const referenced = politics.counties
      .map((county, stored) => ({ county, stored }))
      .filter(({ stored }) => visible.some((hex) => storedCountyOfHex.get(hex.id) === stored))
      .map(({ stored }) => stored);
    const referencedRealmIds = new Set(referenced.map((stored) => politics.counties[stored].realm_id));

    politics.realms.forEach((realm) => {
      if (!referencedRealmIds.has(realm.id)) return;
      const named = politics.counties
        .filter((county) => county.realm_id === realm.id)
        .some((county) =>
          knownSettlements.some((seat) => county.seat_place_id === seat.id || county.hexes.includes(anchorOf(seat))),
        );
      realmIndex.set(realm.id, realms.length);
      realms.push({ name: named ? realm.name : null });
    });

    for (const stored of referenced) {
      const county = politics.counties[stored];
      countyIndex.set(stored, counties.length);
      counties.push({
        name: knownPlaceIds.has(county.seat_place_id) ? county.name : null,
        realm: realmIndex.get(county.realm_id) ?? 0,
      });
    }
  }

  const duchies: PlayerRegionMap['duchies'] = [];
  if (politics) {
    const duchyIdOf = (hexId: string): number | null | undefined => {
      const stored = storedCountyOfHex.get(hexId);
      return stored === undefined ? undefined : politics.counties[stored].duchy_id;
    };

    // A duchy is named once its own seat is known, and its border only runs between two known hexes.
    const duchyIndex = new Map<number, number>();
    politics.duchies.forEach((duchy) => {
      const owned = visible.filter((hex) => duchyIdOf(hex.id) === duchy.id).map((hex) => hex.id);
      if (owned.length === 0) return;
      duchyIndex.set(duchy.id, duchies.length);
      duchies.push({
        id: duchy.id,
        name: duchy.seat_place_id !== null && knownPlaceIds.has(duchy.seat_place_id) ? duchy.name : null,
        border: [],
        hexes: owned,
      });
    });

    const visibleIds = new Set(visible.map((hex) => hex.id));
    const borderSeen = new Set<string>();
    for (const hex of visible) {
      const duchy = duchyIdOf(hex.id);
      if (duchy === undefined) continue;
      for (const neighbour of hexNeighbours(hex.q, hex.r)) {
        const otherId = `q${neighbour.q}_r${neighbour.r}`;
        if (!visibleIds.has(otherId)) continue;
        const other = duchyIdOf(otherId);
        if (other === undefined || other === duchy) continue;
        const key = hex.id < otherId ? `${hex.id}|${otherId}` : `${otherId}|${hex.id}`;
        if (borderSeen.has(key)) continue;
        borderSeen.add(key);
        const from = hex.id;
        const to = otherId;
        const own = duchy === null ? undefined : duchyIndex.get(duchy);
        if (own !== undefined) duchies[own].border.push({ from, to });
        const across = other === null ? undefined : duchyIndex.get(other);
        if (across !== undefined) duchies[across].border.push({ from, to });
      }
    }
  }

  const visibleHexes: PlayerRegionMap['hexes'] = visible.map((hex) => {
    const stored = politics ? storedCountyOfHex.get(hex.id) : undefined;
    return {
      id: hex.id,
      q: hex.q,
      r: hex.r,
      terrain: hex.terrain,
      county: stored === undefined ? null : (countyIndex.get(stored) ?? null),
    };
  });

  return {
    name: view.name,
    width: hexes.reduce((max, hex) => Math.max(max, hex.q), -1) + 1,
    height: hexes.reduce((max, hex) => Math.max(max, hex.r), -1) + 1,
    hexes: visibleHexes,
    counties,
    realms,
    duchies,
    places,
    routes,
    party: partyPlace ? { q: partyPlace.q, r: partyPlace.r } : null,
  };
}
