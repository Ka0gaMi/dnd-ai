// Pure per-hex control: a realm's grip on land is its best seat's strength less ten per unit of
// movement cost, banded core, held, frontier, contested or wild. Deterministic; no database or I/O.
import { travelCosts } from './politics-counties.js';
import type { ComputedClaim, ComputedCounty, PoliticsInput, SeatKind } from './politics-types.js';

export type ControlBand = 'core' | 'held' | 'frontier' | 'contested' | 'wild';

/** A seat projecting control. Realm and county are the caller's keys, computed indexes or stored ids alike. */
export interface ControlSeat {
  place_id: number;
  hex: string;
  kind: SeatKind;
  realm: number;
  county: number;
  capital: boolean;
  march: boolean;
}

export interface HexControl {
  /** The legal owner's realm, or the strongest realm on unclaimed land; null when no seat reaches the hex. */
  realm: number | null;
  /** The owner's control, floored at zero. */
  control: number;
  band: ControlBand;
  /** The realm contesting the hex, or null when it is uncontested. */
  rival: number | null;
}

export interface ControlOptions {
  /** Standing claims on counties by other realms. */
  claims: Array<Pick<ComputedClaim, 'county' | 'claimant_realm'>>;
  /** The county whose legal claim covers a hex, or null. */
  claimOf: (hex: string) => number | null;
  /** Added to every seat; defaults to −10 for a wild or dangerous region. */
  tagModifier?: number;
  /** Per-seat additions by place id, such as a raided or besieged seat. */
  seatModifiers?: ReadonlyMap<number, number>;
}

const SEAT_STRENGTH: Record<SeatKind, number> = { city: 90, town: 80, castle: 70 };
const CAPITAL_STRENGTH = 100;
const MARCH_BONUS = 10;
const COST_FACTOR = 10;
const WILD_TAG_MODIFIER = -10;
const CORE = 65;
const HELD = 40;
const FRONTIER = 20;
const RIVAL_MARGIN = 15;

/** Seat strength P before modifiers: capital 100, city 90, town 80, castle 70, plus 10 for a march. */
export function seatStrength(seat: Pick<ControlSeat, 'kind' | 'capital' | 'march'>): number {
  return (seat.capital ? CAPITAL_STRENGTH : SEAT_STRENGTH[seat.kind]) + (seat.march ? MARCH_BONUS : 0);
}

function bandOf(control: number): ControlBand {
  if (control >= CORE) return 'core';
  if (control >= HELD) return 'held';
  if (control >= FRONTIER) return 'frontier';
  return 'wild';
}

/**
 * Control, owner, band and rival for every land hex. A rival contests at 20 or more when within 15
 * of the owner or above, or when it claims the hex's county.
 */
export function computeControl(
  input: PoliticsInput,
  seats: ControlSeat[],
  options: ControlOptions,
): Map<string, HexControl> {
  const shift =
    options.tagModifier ??
    (input.tags.includes('wild') || input.tags.includes('dangerous') ? WILD_TAG_MODIFIER : 0);

  const grip = new Map<number, Map<string, number>>();
  const countyRealm = new Map<number, number>();
  for (const seat of seats) {
    if (!countyRealm.has(seat.county)) countyRealm.set(seat.county, seat.realm);
    const strength = seatStrength(seat) + shift + (options.seatModifiers?.get(seat.place_id) ?? 0);
    const best = grip.get(seat.realm) ?? new Map<string, number>();
    for (const [hex, cost] of travelCosts(input, seat.hex, 1)) {
      const value = strength - COST_FACTOR * cost;
      if (value > (best.get(hex) ?? -Infinity)) best.set(hex, value);
    }
    grip.set(seat.realm, best);
  }
  const realms = [...grip.keys()].sort((a, b) => a - b);

  const claimants = new Map<number, Set<number>>();
  for (const claim of options.claims) {
    const set = claimants.get(claim.county) ?? new Set<number>();
    set.add(claim.claimant_realm);
    claimants.set(claim.county, set);
  }

  const result = new Map<string, HexControl>();
  for (const hex of input.hexes) {
    if (hex.terrain === 'water') continue;
    const controlOf = (realm: number): number => grip.get(realm)?.get(hex.id) ?? -Infinity;
    const county = options.claimOf(hex.id);

    let owner: number | null = county === null ? null : (countyRealm.get(county) ?? null);
    if (owner === null) {
      let strongest = -Infinity;
      for (const realm of realms) {
        const value = controlOf(realm);
        if (value > strongest) {
          strongest = value;
          owner = realm;
        }
      }
    }
    const own = owner === null ? -Infinity : controlOf(owner);

    const claimedBy = county === null ? undefined : claimants.get(county);
    let rival: number | null = null;
    let rivalControl = -Infinity;
    for (const realm of realms) {
      if (realm === owner) continue;
      const value = controlOf(realm);
      if (value < FRONTIER) continue;
      if (value < own - RIVAL_MARGIN && !claimedBy?.has(realm)) continue;
      if (value > rivalControl) {
        rivalControl = value;
        rival = realm;
      }
    }

    const control = Math.max(0, own);
    result.set(hex.id, { realm: owner, control, band: rival === null ? bandOf(control) : 'contested', rival });
  }
  return result;
}

/**
 * A county's bounded land: its claimed core and held hexes, contested ones where the owner holds 40
 * or more, its seat and its villages.
 */
export function boundCounty(
  input: PoliticsInput,
  county: Pick<ComputedCounty, 'hexes' | 'seat_place_id' | 'village_place_ids'>,
  control: Map<string, HexControl>,
): string[] {
  const bound = new Set<string>();
  for (const hex of county.hexes) {
    const entry = control.get(hex);
    if (entry === undefined) continue;
    if (entry.band === 'core' || entry.band === 'held' || (entry.band === 'contested' && entry.control >= HELD)) {
      bound.add(hex);
    }
  }
  const seat =
    input.settlements.find((place) => place.place_id === county.seat_place_id) ??
    input.strongholds.find((place) => place.place_id === county.seat_place_id);
  if (seat !== undefined) bound.add(seat.hex);
  for (const place of input.settlements) {
    if (county.village_place_ids.includes(place.place_id)) bound.add(place.hex);
  }
  return [...bound].sort();
}
