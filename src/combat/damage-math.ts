// Combat engine: damage and healing arithmetic, resistances and damage notes.
import { rollDice } from '../core/dice.js';
import * as srd from '../srd/data.js';
import type { Db } from '../db/connection.js';
import { hasProperty, shieldEquipped } from './actions.js';
import { conditionDamageResistances } from './conditions.js';
import {
  featureResistances,
  flagResistances,
  maximisesHealing,
  ragingResistances,
} from './features.js';
import { combatSheet, type CombatSheet } from './sheet.js';
import { type Combatant } from './state.js';
import { wildShapeSheet } from './engine-core.js';

/**
 * Hit points a feature or a spell restores. Supreme Healing does not roll them: every die comes up at its
 * highest face, which is what the feature's own text asks for.
 */
export function rollHealing(expr: string, sheet: CombatSheet | null): { total: number; expr: string; output: string } {
  if (!sheet || !maximisesHealing(sheet)) {
    const rolled = rollDamage(expr, false);
    return { total: rolled.total, expr: rolled.expr, output: rolled.output };
  }
  const flat = expr.replace(/(\d*)d(\d+)/gi, (_match, count: string, faces: string) =>
    String(Number(count || '1') * Number(faces)),
  );
  const total = flat
    .split('+')
    .map((part) => Number(part.trim()) || 0)
    .reduce((sum, part) => sum + part, 0);
  return { total, expr, output: `${total} (Supreme Healing: every die at its highest)` };
}

/** Overchannel: every damage die at its highest face, the critical's doubling included. */
export function maximumDamage(expr: string, critical: boolean): { total: number; expr: string; output: string; dice: number[] } {
  const rolled = critical ? criticalExpr(expr) : expr;
  const flat = rolled.replace(/(\d*)d(\d+)/gi, (_match, count: string, faces: string) =>
    String(Number(count || '1') * Number(faces)),
  );
  const total = flat
    .split('+')
    .map((part) => Number(part.trim()) || 0)
    .reduce((sum, part) => sum + part, 0);
  return { total, expr: rolled, output: `${total} (Overchannel: every die at its highest)`, dice: [] };
}

/** Doubles every damage die for a critical hit; the flat modifiers stay as they are. */
export function criticalExpr(expr: string): string {
  return expr.replace(/(\d*)d(\d+)/gi, (_match, count: string, faces: string) => `${(Number(count || '1') * 2)}d${faces}`);
}

export function rollDamage(
  expr: string,
  critical: boolean,
  pre?: { total: number; output?: string },
): { total: number; expr: string; output: string; dice: number[] } {
  const rolled = critical ? criticalExpr(expr) : expr;
  // A die the player rolled themselves comes back as a total, so there is nothing to read off it.
  if (pre) return { total: Math.max(0, pre.total), expr: rolled, output: pre.output ?? String(pre.total), dice: [] };
  const detail = rollDice(rolled, { roll_type: 'damage' });
  const dice = detail.groups.flatMap((group) =>
    typeof group === 'object' && group !== null && 'dice' in group ? group.dice.map((die) => die.value) : [],
  );
  return { total: Math.max(0, detail.total), expr: rolled, output: detail.output, dice };
}

/**
 * Great Weapon Fighting: a 1 or a 2 on a damage die of a two-handed melee weapon counts as a 3. It is
 * worked out from the dice that were rolled, so a damage roll the player made themselves keeps its own.
 */
export function greatWeaponBonus(
  sheet: CombatSheet | null,
  equipment: srd.EquipmentData | undefined,
  melee: boolean,
  grip: 'one_hand' | 'two_hands' | undefined,
  dice: number[],
): number {
  if (!sheet || !equipment || !melee || grip === 'one_hand' || dice.length === 0) return 0;
  const style = sheet.features.some((f) => f.mechanics?.fighting_style === 'Great Weapon Fighting');
  if (!style) return 0;
  const twoHanded = hasProperty(equipment, 'two-handed');
  const versatile = hasProperty(equipment, 'versatile') && !shieldEquipped(sheet);
  if (!twoHanded && !versatile) return 0;
  return dice.reduce((sum, value) => sum + (value < 3 ? 3 - value : 0), 0);
}

// --- damage, healing and saves ---------------------------------------------

/** The adjustments a creature's damage lines give, kept apart so Resistance can floor before Vulnerability doubles. */
type DamageFactor = { immune: boolean; resistant: boolean; vulnerable: boolean; note: string | null };

interface DamageLines {
  damage_vulnerabilities: string;
  damage_resistances: string;
  damage_immunities: string;
}

/** Petrified's "Resistance to all damage" is every SRD type; the condition table writes it as "all". */
const conditionResistanceLine = (conditions: string[]): string =>
  conditionDamageResistances(conditions)
    .flatMap((type) => (type === 'all' ? DAMAGE_TYPES : [type]))
    .join(', ');

/** A monster carries its own stat block; a character's lines come off its features and its anchor. */
export function damageLinesOf(db: Db, combatant: Combatant): DamageLines | null {
  const fromConditions = conditionResistanceLine(combatant.conditions);
  if (combatant.stat_block) {
    const druid = wildShapeSheet(db, combatant);
    const lines = fromConditions
      ? { ...combatant.stat_block, damage_resistances: [combatant.stat_block.damage_resistances, fromConditions].filter(Boolean).join(', ') }
      : combatant.stat_block;
    // Wild Shape keeps the Druid's class features, so what those make them resist holds inside the Beast.
    if (!druid) return lines;
    return {
      ...lines,
      damage_resistances: [lines.damage_resistances, ...featureResistances(druid)].filter(Boolean).join(', '),
    };
  }
  if (!combatant.character_id) return null;
  const sheet = combatSheet(db, combatant.character_id);
  return {
    damage_vulnerabilities: sheet.vulnerabilities.join(', '),
    // A running Rage resists bludgeoning, piercing and slashing for as long as it lasts, and a feature
    // that declares its own resistances (Elemental Affinity, Fiendish Resilience) says so in its passive.
    damage_resistances: [
      ...sheet.resistances,
      ...featureResistances(sheet),
      ...ragingResistances(sheet, combatant),
      ...flagResistances(sheet, combatant),
      fromConditions,
    ].filter(Boolean).join(', '),
    damage_immunities: sheet.immunities.join(', '),
  };
}

/** The SRD damage types; anything else is the DM inventing one, which the log says out loud. */
const DAMAGE_TYPES = [
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
  'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder',
];

export const damageTypeNote = (type: string | null | undefined): string | null =>
  type && !DAMAGE_TYPES.includes(type.trim().toLowerCase())
    ? `"${type}" is not an SRD damage type, so resistances and immunities cannot apply to it. The SRD types are ${DAMAGE_TYPES.join(', ')}.`
    : null;

/** Resistance, immunity and vulnerability read straight off the damage lines. */
export function damageFactor(lines: DamageLines | null, type: string | null): DamageFactor {
  if (!lines || !type) return { immune: false, resistant: false, vulnerable: false, note: null };
  const wanted = type.trim().toLowerCase();
  const has = (line: string): boolean =>
    line
      .toLowerCase()
      .split(/[,;]/)
      .map((part) => part.trim())
      .some((part) => part === wanted || part.split(' ').includes(wanted));
  if (has(lines.damage_immunities)) return { immune: true, resistant: false, vulnerable: false, note: 'immune' };
  const resistant = has(lines.damage_resistances);
  const vulnerable = has(lines.damage_vulnerabilities);
  return {
    immune: false,
    resistant,
    vulnerable,
    note: resistant && vulnerable ? 'resistant and vulnerable' : resistant ? 'resistant' : vulnerable ? 'vulnerable' : null,
  };
}

/** The note the log shows: what adjusted the damage, and what a boon let through untouched. */
export function damageNote(read: DamageFactor, ignoredResistance: boolean, ignoredImmunity: boolean): string | null {
  if (ignoredImmunity && read.immune) return 'immune - and the damage ignores it';
  if (ignoredResistance && read.resistant) {
    return read.vulnerable
      ? 'resistant and vulnerable - and the damage ignores the resistance'
      : 'resistant - and the damage ignores it';
  }
  return read.note;
}

export interface DamageResult {
  rolled: number;
  applied: number;
  absorbed_by_temp_hp: number;
  resistance: string | null;
  hp_current: number;
  hp_max: number;
  downed: boolean;
  dead: boolean;
}
