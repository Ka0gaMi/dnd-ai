// The political pipeline in one place: counties grown from seats, realms grown from capitals, the
// duchy, march and claim hierarchy over them, then counties bounded to held land. Pure; no database, no I/O.
import { boundCounty, computeControl, type ControlSeat } from './politics-control.js';
import { computeCounties } from './politics-counties.js';
import { computeHierarchy } from './politics-duchies.js';
import { computeRealms } from './politics-realms.js';
import type { ComputedCounties, ComputedHierarchy, ComputedRealms, PoliticsInput } from './politics-types.js';

export interface HierarchyParts {
  counties: ComputedCounties;
  realms: ComputedRealms;
  hierarchy: ComputedHierarchy;
}

/** Even-r offset neighbours: even rows step one way, odd rows the other. */
export function hexNeighbours(q: number, r: number): Array<{ q: number; r: number }> {
  const offsets =
    r % 2 === 0
      ? [
          [1, 0],
          [-1, 0],
          [0, -1],
          [1, -1],
          [0, 1],
          [1, 1],
        ]
      : [
          [1, 0],
          [-1, 0],
          [-1, -1],
          [0, -1],
          [-1, 1],
          [0, 1],
        ];
  return offsets.map(([dq, dr]) => ({ q: q + dq, r: r + dr }));
}

/**
 * Runs the stages in order: counties, realms over them, the hierarchy over both, then bounds each county
 * to the land its realm holds. Everything before the last stage sees the unbounded claim, kept as catchment.
 */
export function computeHierarchyParts(input: PoliticsInput): HierarchyParts {
  const claimed = computeCounties(input);
  const realms = computeRealms(input, claimed);
  const hierarchy = computeHierarchy(input, claimed, realms);
  return { counties: boundCounties(input, claimed, realms, hierarchy), realms, hierarchy };
}

/** Each county's hexes cut to its held land, with the unbounded claim kept as its catchment. */
function boundCounties(
  input: PoliticsInput,
  claimed: ComputedCounties,
  realms: ComputedRealms,
  hierarchy: ComputedHierarchy,
): ComputedCounties {
  const hexOf = new Map([...input.settlements, ...input.strongholds].map((place) => [place.place_id, place.hex]));
  const march = new Set(hierarchy.march_counties);
  const seats: ControlSeat[] = [];
  claimed.counties.forEach((county, index) => {
    const hex = hexOf.get(county.seat_place_id);
    const realm = realms.county_realm[index];
    if (hex === undefined || realm === undefined) return;
    seats.push({
      place_id: county.seat_place_id,
      hex,
      kind: county.seat_kind,
      realm,
      county: index,
      capital: realms.realms[realm]?.capital_place_id === county.seat_place_id,
      march: march.has(index),
    });
  });
  const claimOf = new Map<string, number>();
  claimed.counties.forEach((county, index) => county.hexes.forEach((hex) => claimOf.set(hex, index)));
  const control = computeControl(input, seats, {
    claims: hierarchy.claims,
    claimOf: (hex) => claimOf.get(hex) ?? null,
  });

  return {
    counties: claimed.counties.map((county) => ({
      ...county,
      hexes: boundCounty(input, county, control),
      catchment: county.hexes,
    })),
    edges: claimed.edges,
  };
}

/** The index of the county holding this hex id, or null when no county holds it. */
export function countyOfHex(counties: ComputedCounties, hex: string): number | null {
  const index = counties.counties.findIndex((county) => county.hexes.includes(hex));
  return index === -1 ? null : index;
}

export type { ComputedCounties, ComputedHierarchy, ComputedRealms, PoliticsInput } from './politics-types.js';
