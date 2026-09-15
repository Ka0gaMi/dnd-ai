// The words the battle map needs: what a cell is, what a feature means, and what a token's tooltip says.
import { flagChips, visibleHp } from './combat.svelte';
import { tacticsLine, type Tactics } from './tactics';
import type { Combatant, MapFeature, Visibility } from './types';

const CELL_FT = 5;

/** What each map kind means in play; anything else falls back to the DM's own label. */
const FEATURE_WORDING: Record<string, string> = {
  pillars: 'blocks movement and sight (full cover)',
  pillar: 'blocks movement and sight (full cover)',
  column: 'blocks movement and sight (full cover)',
  wall: 'blocks movement and sight (full cover)',
  statue: 'blocks movement, half cover behind it',
  rubble: 'difficult terrain (double cost)',
  debris: 'difficult terrain (double cost)',
  thicket: 'difficult terrain, light cover',
  brush: 'difficult terrain, light cover',
  fire: 'burning, ongoing fire damage if entered',
  river: 'difficult, may need a swim',
  water: 'difficult, may need a swim',
  road: 'open ground, normal movement',
  pit: 'a fall if you step in',
};

const sentence = (text: string): string => {
  const clean = text.trim().replace(/[_-]+/g, ' ');
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : '';
};

/** Matches the whole kind, then its last word, singular or plural ("stone pillars" → pillars). */
function wordingFor(kind: string): string | null {
  const clean = kind.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (!clean) return null;
  const words = clean.split(/\s+/);
  for (const candidate of [clean, ...words.reverse()]) {
    const hit = FEATURE_WORDING[candidate] ?? FEATURE_WORDING[candidate.replace(/s$/, '')];
    if (hit) return hit;
  }
  return null;
}

export interface FeatureNote {
  /** 1-based: the number drawn in the pin on the map. */
  index: number;
  name: string;
  text: string;
}

export function featureNotes(features: MapFeature[]): FeatureNote[] {
  return features.map((feature, i) => {
    const label = feature.label.trim();
    const name = sentence(feature.kind) || sentence(label) || 'Feature';
    return { index: i + 1, name, text: wordingFor(feature.kind) ?? (label || 'feature on the map') };
  });
}

export const terrainWord = (cell: string): string =>
  cell === '#' ? 'Blocked, full cover' : cell === '~' ? 'Difficult ground, double cost' : 'Open ground';

export interface LegendItem {
  key: string;
  text: string;
}

/** The key under the map, in drawing order: terrain first, then what a token looks like. */
export const LEGEND_ITEMS: LegendItem[] = [
  { key: 'open', text: 'Open' },
  { key: 'difficult', text: 'Difficult (dotted)' },
  { key: 'blocked', text: 'Blocked (hatched)' },
  { key: 'reach', text: 'Reachable this turn' },
  { key: 'party', text: 'Party (circle)' },
  { key: 'enemy', text: 'Enemy (square)' },
  { key: 'active', text: 'Active (brass ring)' },
  { key: 'down', text: 'Down (struck marker)' },
  { key: 'attack', text: 'Last attack (line)' },
];

/** How hurt someone looks when the player may not see numbers. */
export function woundWord(fraction: number): string {
  if (fraction <= 0) return 'Down';
  if (fraction >= 1) return 'Unhurt';
  if (fraction >= 0.5) return 'Lightly wounded';
  if (fraction >= 0.25) return 'Bloodied';
  return 'Near death';
}

/** Chebyshev distance between two footprints, in feet: the same diagonal-is-one-step rule the engine uses. */
export function distanceFt(a: Combatant, b: Combatant): number {
  const gap = (aMin: number, aSpan: number, bMin: number, bSpan: number): number =>
    Math.max(0, aMin - (bMin + bSpan - 1), bMin - (aMin + aSpan - 1));
  const dx = gap(a.x, a.footprint, b.x, b.footprint);
  const dy = gap(a.y, a.footprint, b.y, b.footprint);
  return Math.max(dx, dy) * CELL_FT;
}

export interface TooltipContext {
  visibility: Visibility;
  /** The player's own character and whoever is acting: both get a distance line. */
  pc?: Combatant | null;
  active?: Combatant | null;
  tactics?: Tactics;
  /** Names for the state line: who is grappling whom. */
  nameOf?: (id: number) => string;
}

/** The tooltip for one token, line by line; `tactics` adds the cover and range line for a hovered foe. */
export function tokenTooltip(combatant: Combatant, context: TooltipContext): string[] {
  const hp = visibleHp(combatant, context.visibility);
  const lines: string[] = [];

  if (!combatant.alive) lines.push('Down');
  else if (hp.numbers) {
    const temp = combatant.temp_hp > 0 ? ` +${combatant.temp_hp} temp` : '';
    lines.push(`${combatant.hp_current} / ${combatant.hp_max} HP${temp}`);
  } else if (hp.bar) lines.push(woundWord(hp.fraction));
  else if (hp.bloodied) lines.push('Bloodied');

  if (hp.ac) lines.push(`AC ${combatant.ac}`);
  if (combatant.conditions.length > 0) lines.push(combatant.conditions.join(', '));
  const states = flagChips(combatant, context.nameOf ?? ((id) => `#${id}`));
  if (states.length > 0) lines.push(states.map((state) => state.label).join(' · '));
  if (combatant.team === 'party' && combatant.armor_penalty) lines.push('Armour: not proficient');
  if (combatant.concentration) lines.push(`Concentrating: ${combatant.concentration.name}`);

  const ownSpeed = combatant.team === 'party' || context.visibility === 'full';
  if (ownSpeed) lines.push(`Speed ${combatant.speed} ft · ${combatant.movement_left} ft left`);

  const { pc, active } = context;
  if (pc && pc.id !== combatant.id) lines.push(`${distanceFt(pc, combatant)} ft from ${pc.name}`);
  if (active && active.id !== combatant.id && active.id !== pc?.id) {
    lines.push(`${distanceFt(active, combatant)} ft from ${active.name}`);
  }

  if (context.tactics) lines.push(tacticsLine(context.tactics));
  return lines;
}
