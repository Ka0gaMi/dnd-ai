// Hand-set sheet numbers: what the pencil beside a tile sends, and which tiles show the brass dot.
export const OVERRIDE_FIELDS = [
  'ac',
  'speed',
  'initiative_bonus',
  'proficiency_bonus',
  'passive_perception',
  'gold',
  'exhaustion',
] as const;

export type OverrideField = (typeof OVERRIDE_FIELDS)[number];

export type OverrideEdit = { patch: Record<string, number | null> } | { error: string };

/** Fields whose whole-number range is checked before the server ever sees it. */
const BOUNDS: Partial<Record<OverrideField, [number, number]>> = { exhaustion: [0, 6] };

/** Blank clears the hand-set number and gives the computed one back; anything else must be a whole number. */
export function overridePatch(field: OverrideField, typed: string): OverrideEdit {
  const clean = typed.trim();
  if (clean === '') return { patch: { [field]: null } };
  const value = Number(clean);
  if (!Number.isInteger(value)) return { error: 'Whole numbers only' };
  const bounds = BOUNDS[field];
  if (bounds && (value < bounds[0] || value > bounds[1])) return { error: `Must be ${bounds[0]}–${bounds[1]}` };
  return { patch: { [field]: value } };
}

export const isHandSet = (handSet: string[] | undefined, field: string): boolean =>
  (handSet ?? []).includes(field);

/** The brass dot beside a hand-set tile: clearable in cheat mode, a plain marker otherwise. */
export type HandSetDot = 'none' | 'marker' | 'button';

export function handSetDot(cheat: boolean, handSet: string[] | undefined, field: string): HandSetDot {
  if (!isHandSet(handSet, field)) return 'none';
  return cheat ? 'button' : 'marker';
}
