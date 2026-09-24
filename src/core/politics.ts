// The political pipeline in one place: counties grown from seats, realms grown from capitals, then
// the duchy, march and claim hierarchy over them. Pure and deterministic; no database, no I/O.
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

/** Runs the three stages in order: counties, then realms over them, then the hierarchy over both. */
export function computeHierarchyParts(input: PoliticsInput): HierarchyParts {
  const counties = computeCounties(input);
  const realms = computeRealms(input, counties);
  const hierarchy = computeHierarchy(input, counties, realms);
  return { counties, realms, hierarchy };
}

/** The index of the county holding this hex id, or null when no county claims it. */
export function countyOfHex(counties: ComputedCounties, hex: string): number | null {
  const index = counties.counties.findIndex((county) => county.hexes.includes(hex));
  return index === -1 ? null : index;
}

export type { ComputedCounties, ComputedHierarchy, ComputedRealms, PoliticsInput } from './politics-types.js';
