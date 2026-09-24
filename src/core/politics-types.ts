// Shared shapes for the political layer: counties grown from seats, the county graph, realms,
// duchies, marches and claims. Pure data; the algorithms live in the politics-* modules.

export interface PoliticsHex {
  id: string;
  q: number;
  r: number;
  terrain: string;
}

export interface PoliticsSettlement {
  place_id: number;
  name: string;
  size: 'village' | 'town' | 'city';
  hex: string;
  coast: boolean;
}

/** A place that can seat a castle lordship where land has no town: a keep or ruin danger. */
export interface PoliticsStronghold {
  place_id: number;
  name: string;
  hex: string;
}

export interface PoliticsInput {
  region_name: string;
  /** Region tags such as civilized, wild, lawful, chaotic, island. */
  tags: string[];
  hexes: PoliticsHex[];
  settlements: PoliticsSettlement[];
  strongholds: PoliticsStronghold[];
  /** Each road as its ordered hex ids; travel along a road costs half. */
  roads: string[][];
  /** Named areas (forests, marshes) with their hexes, used to name duchies. */
  areas: Array<{ name: string; hexes: string[] }>;
  /** Hex ids on the map's outer ring, to tell whether land runs off the map. */
  edge_hexes: string[];
}

export type SeatKind = 'city' | 'town' | 'castle';

export interface ComputedCounty {
  name: string;
  seat_place_id: number;
  seat_kind: SeatKind;
  hexes: string[];
  /** Villages bound to this county's seat. */
  village_place_ids: number[];
  /** Land component (island) index. */
  component: number;
}

export interface CountyEdge {
  a: number;
  b: number;
  /** Mean crossing cost along the shared border, or the sea-lane cost for a port link. */
  cost: number;
  /** A mountain, marsh or water border that realms rarely grow across. */
  hard: boolean;
  sea: boolean;
}

export interface ComputedCounties {
  counties: ComputedCounty[];
  edges: CountyEdge[];
}

export type RealmKind = 'kingdom' | 'free_city' | 'lordship' | 'tribe';

export interface ComputedRealm {
  name: string;
  kind: RealmKind;
  /** Null when the capital lies off the map or the realm has no town. */
  capital_place_id: number | null;
  /** The region is part of a larger realm whose seat is beyond the map. */
  off_map: boolean;
  /** Index of the realm this one owes fealty to, or null when sovereign. */
  liege: number | null;
}

export interface ComputedRealms {
  realms: ComputedRealm[];
  /** Realm index per county index. */
  county_realm: number[];
}

export type JoinedHow = 'core' | 'conquest' | 'union' | 'inheritance';

export interface ComputedDuchy {
  name: string;
  realm: number;
  seat_place_id: number;
  county_indexes: number[];
  /** The crown's own lands around the capital. */
  demesne: boolean;
  joined_how: JoinedHow;
}

export interface ComputedClaim {
  county: number;
  claimant_realm: number;
  strength: 'weak' | 'strong';
  reason: 'inheritance' | 'dowry' | 'recent conquest' | 'ancient kingdom';
}

export interface ComputedHierarchy {
  duchies: ComputedDuchy[];
  /** Duchy index per county index, or null for counties outside any duchy. */
  county_duchy: Array<number | null>;
  march_counties: number[];
  claims: ComputedClaim[];
}
