// The words a faction's attitude toward the party falls into, on the same thresholds the window uses.

export const ATTITUDE_BANDS = ['hostile', 'wary', 'neutral', 'friendly', 'devoted'] as const;

export type AttitudeBand = (typeof ATTITUDE_BANDS)[number];

/** How a faction reads the party: hostile <= -6, wary <= -2, neutral < 2, friendly < 6, devoted at 6 or more. */
export function attitudeBand(total: number): AttitudeBand {
  if (total <= -6) return 'hostile';
  if (total <= -2) return 'wary';
  if (total < 2) return 'neutral';
  if (total < 6) return 'friendly';
  return 'devoted';
}
