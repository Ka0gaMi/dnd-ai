// Combat engine: casting plans, free casts, wild shape and familiars.
import { createCompanion, slotsLeft, useSpellSlot } from '../core/character.js';
import { rollDice } from '../core/dice.js';
import { type Ability } from '../core/rules.js';
import type { CreatureStatBlock } from '../srd/data.js';
import * as srd from '../srd/data.js';
import { findSpell } from '../srd/lookup.js';
import type { Db } from '../db/connection.js';
import { initiativeBonus } from './actions.js';
import {
  arcaneApotheosisFree,
  castModifiers,
  chosenOptions,
  hasBoon,
  hasFeature,
  hasInvocation,
  heldInvocations,
  heldMetamagic,
  metamagicCost,
  mysticArcanumLevels,
  resourceSpec,
  signatureKey,
  STACKING_METAMAGIC,
  wildShapeRounds,
  type CastModifier,
  type CastOptions,
  type FeatureCost,
  type SpellInfo,
} from './features.js';
import { type AoeShape } from './grid.js';
import { combatSheet, type CombatSheet } from './sheet.js';
import {
  getCombatant,
  logCombat,
  saveCombatant,
  setCombatantStatBlock,
  type Combatant,
  type CombatLogEntry,
  type EncounterRow,
} from './state.js';
import { requireResource } from './resources.js';
import { statBlockFor, addToEncounter, rollOwnInitiative, reorderInitiative } from './encounter.js';

// --- generic actions, areas and effects ------------------------------------

// --- a spell read off its SRD entry -----------------------------------------

const SAVE_ABILITY: Record<string, Ability> = {
  strength: 'str',
  dexterity: 'dex',
  constitution: 'con',
  intelligence: 'int',
  wisdom: 'wis',
  charisma: 'cha',
};

/** What one casting costs the caster's turn; "long" is anything a fight has no room for. */
export type CastingEconomy = 'action' | 'bonus_action' | 'reaction' | 'long';

export interface SpellFill {
  name: string;
  level: number;
  /** The school the entry files it under, which Sculpt Spells and Empowered Evocation read. */
  school: string;
  /** The class lists it is on, as the SRD entry carries them ("srd-2024_wizard"). */
  classes: string[];
  /** The entry's own casting time, as the SRD writes it: "action", "bonus-action", "reaction", "1minute". */
  casting_time: string;
  /** The action economy that casting time spends. */
  economy: CastingEconomy;
  /** Cast with a spell attack roll rather than a saving throw. */
  attack_roll: boolean;
  /** The slot this casting spends; null for a cantrip. */
  slot_level: number | null;
  damage_expr?: string;
  damage_type?: string;
  heal_expr?: string;
  save_ability?: Ability;
  save_dc?: number;
  half_on_save?: boolean;
  shape?: AoeShape;
  concentration: boolean;
  range_ft: number | null;
  duration_rounds: number | null;
  /** What the engine did and did not scale, said out loud so the DM is never guessing. */
  notes: string[];
}

/** "8d6" plus 2d6 is "10d6"; dice of another size are added on the end instead. */
function addDice(expr: string, count: number, faces: number): string {
  if (count <= 0) return expr;
  const match = expr.match(/^(\d*)d(\d+)/);
  if (match && Number(match[2]) === faces) {
    return expr.replace(/^(\d*)d(\d+)/, `${Number(match[1] || '1') + count}d${faces}`);
  }
  return `${expr} + ${count}d${faces}`;
}

/** The plain "increases by 1dX for each spell slot level above N" scaling, and nothing cleverer. */
function upcastDice(higher: string | null, expr: string, slotLevel: number): { expr: string; note: string | null } {
  const text = (higher ?? '').trim();
  if (!text) return { expr, note: null };
  const match = text.match(/increases by (\d*)d(\d+) for each spell slot level above (\d+)/i);
  if (!match) return { expr, note: `${text} - the engine does not scale that; apply it yourself.` };
  const steps = slotLevel - Number(match[3]);
  if (steps <= 0) return { expr, note: null };
  const count = Number(match[1] || '1') * steps;
  return { expr: addDice(expr, count, Number(match[2])), note: `upcast to level ${slotLevel}: +${count}d${match[2]}` };
}

export const COUNT_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6 };

/**
 * Magic Missile's shape: "three glowing darts", each dealing the entry's dice, "one more dart for each
 * spell slot level above 1", no attack roll. All of them go at the one target, so the dice multiply.
 */
function projectileDarts(entry: { desc: string; higher_level: string | null; attack_roll: boolean }, slotLevel: number): number | null {
  // Chain Lightning's "three bolts" and Storm of Vengeance's "six bolts" each strike a different creature
  // once; only a spell that grows by "one more dart per slot level" pours its darts into one target.
  const more = (entry.higher_level ?? '').match(/one (?:more|additional) (?:dart|beam|ray|bolt) for each spell slot level above (\d+)/i);
  if (!more || entry.attack_roll) return null;
  const base = entry.desc.match(/\b(two|three|four|five|six|\d+)\b[\w\s]{0,20}?\b(darts|beams|rays|bolts)\b/i);
  if (!base) return null;
  const count = COUNT_WORDS[base[1]!.toLowerCase()] ?? Number(base[1]);
  if (!Number.isInteger(count) || count < 2) return null;
  return count + Math.max(0, slotLevel - Number(more[1]));
}

/** "1d4 + 1" three times over is "3d4 + 3": every term of the expression scaled by the dart count. */
function multiplyDice(expr: string, times: number): string {
  return expr.replace(/(\d*)d(\d+)|\d+/g, (term, count: string | undefined, faces: string | undefined) =>
    faces === undefined ? String(Number(term) * times) : `${Number(count || '1') * times}d${faces}`,
  );
}

/** Cantrips grow with the caster's level at the 2024 tiers, when the entry says they do. */
function cantripDice(higher: string | null, expr: string, casterLevel: number): { expr: string; note: string | null } {
  const match = (higher ?? '').match(/increases by (\d*)d(\d+) when you reach level/i);
  if (!match) return { expr, note: null };
  const tier = casterLevel >= 17 ? 3 : casterLevel >= 11 ? 2 : casterLevel >= 5 ? 1 : 0;
  if (tier === 0) return { expr, note: null };
  const count = Number(match[1] || '1') * tier;
  return { expr: addDice(expr, count, Number(match[2])), note: `cantrip at level ${casterLevel}: +${count}d${match[2]}` };
}

const SHAPE_WORDS: Record<string, AoeShape['kind']> = {
  sphere: 'sphere',
  emanation: 'sphere',
  cylinder: 'sphere',
  cone: 'cone',
  cube: 'cube',
  line: 'line',
};

/** "a 20-foot-radius Sphere", "a 15-foot Cone": the area the description spells out. */
function areaOf(desc: string): AoeShape | undefined {
  const match = desc.match(/(\d+)-foot(?:-radius)?[- ](Sphere|Cone|Cube|Line|Emanation|Cylinder)/i);
  if (!match) return undefined;
  return { kind: SHAPE_WORDS[match[2]!.toLowerCase()]!, size_ft: Number(match[1]) };
}

function rangeOf(text: string): number | null {
  if (/^self/i.test(text)) return null;
  if (/^touch/i.test(text)) return 5;
  const match = text.match(/^(\d+)\s*(?:feet|foot|ft)/i);
  return match ? Number(match[1]) : null;
}

/**
 * The action a casting time spends. The SRD entries carry slugs ("action", "bonus-action", "reaction",
 * "1minute", "10minutes", "1hour"); a spell the DM wrote carries prose ("1 bonus action"). Anything
 * longer than an action is "long" and has no place in a fight.
 */
export function castingEconomy(text: string): CastingEconomy {
  const slug = text.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (slug.includes('bonus-action')) return 'bonus_action';
  if (slug.includes('reaction')) return 'reaction';
  if (slug.includes('action')) return 'action';
  return 'long';
}

const ROUNDS_PER: Record<string, number> = { round: 1, minute: 10, hour: 600 };

function durationRounds(text: string): number | null {
  const match = text.match(/^(\d+)\s*(round|minute|hour)/i);
  return match ? Number(match[1]) * ROUNDS_PER[match[2]!.toLowerCase()]! : null;
}

/** Everything use_action needs about an SRD spell, at the slot it is cast with. */
export function spellFill(
  name: string,
  sheet: CombatSheet | null,
  slotLevel?: number,
): SpellFill | null {
  const entry = findSpell(name);
  if (!entry) return null;
  const notes: string[] = [];
  const slot = entry.level === 0 ? null : (slotLevel ?? entry.level);
  if (slot !== null && slot < entry.level) {
    throw new Error(`${entry.name} is a level ${entry.level} spell and cannot be cast with a level ${slot} slot.`);
  }
  const healing =
    entry.damage_roll !== null &&
    entry.damage_roll !== '' &&
    entry.damage_types.length === 0 &&
    /regains?|hit points/i.test(entry.desc);
  let dice = entry.damage_roll ?? '';
  const darts = dice && !healing && entry.level > 0 ? projectileDarts(entry, slot ?? entry.level) : null;
  if (dice && darts) {
    notes.push(`${darts} darts x (${dice}) at level ${slot ?? entry.level}, all at the target`);
    dice = multiplyDice(dice, darts);
  } else if (dice) {
    const scaled =
      entry.level === 0
        ? cantripDice(entry.higher_level, dice, sheet?.level ?? 1)
        : upcastDice(entry.higher_level, dice, slot ?? entry.level);
    dice = scaled.expr;
    if (scaled.note) notes.push(scaled.note);
  } else if (entry.higher_level) {
    notes.push(`${entry.higher_level} - the engine does not scale that; apply it yourself.`);
  }
  const save = entry.saving_throw_ability ? SAVE_ABILITY[entry.saving_throw_ability.toLowerCase()] : undefined;
  return {
    name: entry.name,
    level: entry.level,
    school: entry.school,
    classes: entry.classes,
    casting_time: entry.casting_time,
    economy: castingEconomy(entry.casting_time),
    attack_roll: entry.attack_roll,
    slot_level: slot,
    ...(dice && !healing ? { damage_expr: dice } : {}),
    ...(entry.damage_types[0] ? { damage_type: entry.damage_types[0] } : {}),
    ...(dice && healing ? { heal_expr: dice } : {}),
    ...(save ? { save_ability: save } : {}),
    ...(save && sheet?.spells.save_dc ? { save_dc: sheet.spells.save_dc } : {}),
    ...(save ? { half_on_save: /half as much damage/i.test(entry.desc) } : {}),
    ...(areaOf(entry.desc) ? { shape: areaOf(entry.desc) } : {}),
    concentration: entry.concentration,
    range_ft: rangeOf(entry.range_text),
    duration_rounds: durationRounds(entry.duration),
    notes,
  };
}

/** Refuses a casting whose slot is not there, before a single sorcery point has been spent on it. */
export function requireSlotFor(caster: Combatant, sheet: CombatSheet | null, spell: SpellFill): void {
  if (spell.slot_level === null || !sheet || caster.character_id === null) return;
  const slot = sheet.spell_slots[String(spell.slot_level)];
  if (slot && slotsLeft(slot) > 0) return;
  const open = Object.entries(sheet.spell_slots)
    .filter(([, entry]) => slotsLeft(entry) > 0)
    .map(([level, entry]) => `level ${level} (${slotsLeft(entry)} left)`);
  throw new Error(
    `${sheet.name} has no level ${spell.slot_level} spell slot left for ${spell.name}. Slots remaining: ${
      open.length > 0 ? open.join(', ') : 'none'
    }.`,
  );
}

/** Spends the slot the casting costs, on the caster's own sheet, and says what is left. */
export function spendSlotFor(
  db: Db,
  encounter: EncounterRow,
  caster: Combatant,
  sheet: CombatSheet | null,
  spell: SpellFill,
): CombatLogEntry | null {
  if (spell.slot_level === null) return null;
  if (!sheet || caster.character_id === null) return null;
  // Boon of Spell Recall: roll 1d4 on a level 1-4 slot, and on the slot's own level it is not expended.
  if (hasBoon(sheet, 'Boon of Spell Recall') && spell.slot_level <= 4) {
    const rolled = rollDice('1d4', { roll_type: 'other' });
    if (rolled.total === spell.slot_level) {
      return logCombat(db, encounter, {
        actor_id: caster.id,
        kind: 'spell_slot',
        payload: { spell: spell.name, level: spell.slot_level, feature: 'Boon of Spell Recall', kept: true },
        text: `${caster.name} casts ${spell.name} and the slot is not expended at all: Boon of Spell Recall rolled a ${rolled.total} (${rolled.output}).`,
      });
    }
  }
  const spent = useSpellSlot(db, {
    campaign_id: encounter.campaign_id,
    character_id: caster.character_id,
    level: spell.slot_level,
  });
  return logCombat(db, encounter, {
    actor_id: caster.id,
    kind: 'spell_slot',
    payload: { spell: spell.name, level: spell.slot_level, remaining: spent.remaining },
    text: `${caster.name} spends a level ${spell.slot_level} slot on ${spell.name} (${spent.remaining} left at that level).`,
  });
}

/** The castings a class feature pays for instead of a spell slot, by the spell's own name. */
const FREE_CASTS: Record<string, { resource: string; feature: string }> = {
  'divine smite': { resource: 'paladins_smite', feature: "Paladin's Smite" },
  "hunter's mark": { resource: 'favored_enemies', feature: 'Favored Enemy' },
};

/** What is left of a class resource on this sheet. */
function resourceLeft(sheet: CombatSheet, resource: string): number {
  const spec = resourceSpec(sheet, resource);
  const row = sheet.features.find((f) => f.mechanics?.resource === resource);
  const max = spec?.max ?? row?.mechanics?.max ?? 0;
  return max - (row?.mechanics?.used ?? 0);
}

/**
 * The class feature that would pay for this casting instead of a spell slot: a feature with uses left
 * (Paladin's Smite, Favored Enemy), or an Eldritch Invocation that simply casts it free.
 */
export function freeCastOf(sheet: CombatSheet, spellName: string): { resource?: string; feature: string } | null {
  const wanted = spellName.trim().toLowerCase();
  const free = FREE_CASTS[wanted];
  if (free && resourceLeft(sheet, free.resource) > 0) return free;
  for (const held of heldInvocations(sheet)) {
    const mechanics = srd.findInvocation(held)?.mechanics;
    if (mechanics?.free_spell?.toLowerCase() !== wanted) continue;
    // Gift of the Depths counts its free castings; the rest are as often as the warlock likes.
    if (!mechanics.free_spell_resource) return { feature: held };
    if (resourceLeft(sheet, mechanics.free_spell_resource) > 0) return { feature: held, resource: mechanics.free_spell_resource };
  }
  return null;
}

/** The feature a free_cast names as paying for the whole casting. */
export type NamedFreeCast =
  | 'divine_intervention'
  | 'natural_recovery'
  | 'wild_companion'
  | 'pact_of_the_chain'
  | 'mystic_arcanum'
  | 'spell_mastery'
  | 'signature_spell';

/** The free casts that give the spell a casting time of their own; both of these are a Magic action. */
export const FREE_CAST_ECONOMY: Partial<Record<NamedFreeCast, CastingEconomy>> = {
  wild_companion: 'action',
  pact_of_the_chain: 'action',
};

/** The Find Familiar forms the spell names that the bundled creature data carries a stat block for. */
const FAMILIAR_FORMS = ['Bat', 'Cat', 'Frog', 'Hawk', 'Lizard', 'Octopus', 'Owl', 'Rat', 'Raven', 'Spider', 'Weasel'];

/**
 * Wild Companion and Pact of the Chain both cast Find Familiar as a Magic action: the Druid pays a use of
 * Wild Shape for it, the Warlock pays nothing at all, and the form the familiar takes is named with option.
 */
function planFamiliarCast(
  actor: Combatant,
  sheet: CombatSheet,
  spell: SpellFill,
  which: 'wild_companion' | 'pact_of_the_chain',
  option: string | undefined,
): { cost?: FeatureCost; feature: string; familiar: string } {
  const chain = which === 'pact_of_the_chain';
  const feature = chain ? 'Pact of the Chain' : 'Wild Companion';
  const held = chain ? hasInvocation(sheet, 'Pact of the Chain') : hasFeature(sheet, 'druid-wild-companion');
  if (!held) {
    throw new Error(
      `${actor.name} has no ${feature}; it is ${chain ? 'an Eldritch Invocation' : 'a Druid feature taken at level 2'}.`,
    );
  }
  if (!/^find familiar$/i.test(spell.name)) {
    throw new Error(`${feature} casts Find Familiar and nothing else; ${spell.name} is a different spell.`);
  }
  const form = FAMILIAR_FORMS.find((name) => name.toLowerCase() === (option ?? '').trim().toLowerCase());
  if (!form) {
    throw new Error(
      `Find Familiar needs the animal form to take: pass option with one of ${FAMILIAR_FORMS.join(', ')}.`,
    );
  }
  spell.slot_level = null;
  spell.notes.push(
    `${feature}: Find Familiar cast as a Magic action with no spell slot${chain ? '' : ' and no Material components'}.`,
  );
  if (chain) return { feature, familiar: form };
  requireResource(sheet, actor, { resource: 'wild_shape', amount: 1 }, feature);
  return { cost: { resource: 'wild_shape', amount: 1 }, feature, familiar: form };
}

/**
 * Divine Intervention and Natural Recovery pay for a whole casting out of their own once-a-rest use, and
 * neither has a spell of its own: the DM names the spell and the feature with free_cast. This settles
 * what the casting costs and refuses it outright; the use itself is spent once nothing can refuse it.
 */
export function planNamedFreeCast(
  actor: Combatant,
  sheet: CombatSheet,
  spell: SpellFill,
  which: NamedFreeCast,
  option: string | undefined,
): { cost?: FeatureCost; feature: string; familiar?: string } {
  if (which === 'wild_companion' || which === 'pact_of_the_chain') {
    return planFamiliarCast(actor, sheet, spell, which, option);
  }
  if (which === 'mystic_arcanum') {
    if (!hasFeature(sheet, 'warlock-mystic-arcanum')) {
      throw new Error(`${actor.name} has no Mystic Arcanum; it is a Warlock feature taken at level 11.`);
    }
    const levels = mysticArcanumLevels(sheet.level);
    if (!levels.includes(spell.level)) {
      throw new Error(
        `A Mystic Arcanum is a Warlock spell of level ${levels.join(', ')} at this level, and ${spell.name} is level ${spell.level}.`,
      );
    }
    if (!spell.classes.some((entry) => entry.endsWith('_warlock'))) {
      throw new Error(`A Mystic Arcanum is chosen from the Warlock list, and ${spell.name} is not on it.`);
    }
    const chosen = chosenOptions(sheet, 'Mystic Arcanum');
    if (chosen.length > 0 && !chosen.some((name) => name.toLowerCase() === spell.name.toLowerCase())) {
      throw new Error(`${actor.name}'s Mystic Arcanum is ${chosen.join(' and ')}, not ${spell.name}.`);
    }
    const cost = { resource: `mystic_arcanum_${spell.level}`, amount: 1 };
    requireResource(sheet, actor, cost, `the level ${spell.level} Mystic Arcanum`);
    spell.slot_level = null;
    spell.notes.push(`Mystic Arcanum: ${spell.name} is cast without a spell slot, once a long rest.`);
    return { cost, feature: `Mystic Arcanum (level ${spell.level})` };
  }
  if (which === 'spell_mastery') {
    if (!hasFeature(sheet, 'wizard-spell-mastery')) {
      throw new Error(`${actor.name} has no Spell Mastery; it is a Wizard feature taken at level 18.`);
    }
    const chosen = chosenOptions(sheet, 'Spell Mastery');
    if (chosen.length > 0 && !chosen.some((name) => name.toLowerCase() === spell.name.toLowerCase())) {
      throw new Error(`Spell Mastery covers ${chosen.join(' and ')}, not ${spell.name}.`);
    }
    if (spell.level < 1 || spell.level > 2) {
      throw new Error(`Spell Mastery masters a level 1 and a level 2 spell; ${spell.name} is level ${spell.level}.`);
    }
    if (spell.slot_level !== null && spell.slot_level > spell.level) {
      throw new Error(`Spell Mastery casts ${spell.name} at its lowest level for nothing; a higher slot is spent as usual.`);
    }
    spell.slot_level = null;
    spell.notes.push(`Spell Mastery: ${spell.name} is cast at level ${spell.level} at will, with no slot.`);
    return { feature: 'Spell Mastery' };
  }
  if (which === 'signature_spell') {
    if (!hasFeature(sheet, 'wizard-signature-spells')) {
      throw new Error(`${actor.name} has no Signature Spells; it is a Wizard feature taken at level 20.`);
    }
    const chosen = chosenOptions(sheet, 'Signature Spells');
    if (chosen.length > 0 && !chosen.some((name) => name.toLowerCase() === spell.name.toLowerCase())) {
      throw new Error(`${actor.name}'s signature spells are ${chosen.join(' and ')}, not ${spell.name}.`);
    }
    if (spell.level !== 3) {
      throw new Error(`A signature spell is a level 3 spell; ${spell.name} is level ${spell.level}.`);
    }
    const cost = { resource: signatureKey(spell.name), amount: 1 };
    requireResource(sheet, actor, cost, `${spell.name} as a signature spell`);
    spell.slot_level = null;
    spell.notes.push(`Signature Spells: ${spell.name} is cast at level 3 with no slot, once before a rest.`);
    return { cost, feature: 'Signature Spells' };
  }
  if (which === 'divine_intervention') {
    if (!hasFeature(sheet, 'cleric-divine-intervention')) {
      throw new Error(`${actor.name} has no Divine Intervention; it is a Cleric feature taken at level 10.`);
    }
    // Greater Divine Intervention, at level 20, is the one thing that reaches past the Cleric list: Wish.
    const wish = /^wish$/i.test(spell.name) && hasFeature(sheet, 'cleric-greater-divine-intervention');
    if (!wish && !spell.classes.some((entry) => entry.endsWith('_cleric'))) {
      throw new Error(`Divine Intervention casts a Cleric spell, and ${spell.name} is not on the Cleric list.`);
    }
    if (spell.level > 5 && !wish) {
      throw new Error(
        `Divine Intervention casts a Cleric spell of level 5 or lower; ${spell.name} is level ${spell.level}.${
          hasFeature(sheet, 'cleric-greater-divine-intervention') ? ' Only Wish is excepted, at level 20.' : ''
        }`,
      );
    }
    if (wish) {
      spell.notes.push('Greater Divine Intervention: Divine Intervention cannot be used again until 2d4 Long Rests have passed.');
    }
    requireResource(sheet, actor, { resource: 'divine_intervention', amount: 1 }, 'Divine Intervention');
    spell.slot_level = null;
    spell.notes.push('Divine Intervention: no spell slot and no Material components.');
    return { cost: { resource: 'divine_intervention', amount: 1 }, feature: 'Divine Intervention' };
  }
  if (!hasFeature(sheet, 'land-natural-recovery')) {
    throw new Error(`${actor.name} has no Natural Recovery; it is a Circle of the Land feature taken at level 6.`);
  }
  if (spell.level < 1) {
    throw new Error(`Natural Recovery casts one of your prepared Circle spells of level 1 or higher; ${spell.name} is a cantrip.`);
  }
  requireResource(sheet, actor, { resource: 'natural_recovery', amount: 1 }, 'Natural Recovery');
  spell.slot_level = null;
  spell.notes.push('Natural Recovery: this Circle spell costs no spell slot.');
  return { cost: { resource: 'natural_recovery', amount: 1 }, feature: 'Natural Recovery' };
}

/** What a casting comes out as once Metamagic and the caster's own features have had their say. */
interface CastPlan {
  modifiers: CastModifier[];
  economy: CastingEconomy;
  range_ft: number | null;
  save_dc: number | undefined;
  damage_type: string | null;
  /** Creatures Careful Spell or Sculpt Spells carved out: they succeed and take nothing. */
  auto_success: Set<number>;
  /** Creatures Heightened Spell leaves saving with Disadvantage. */
  save_disadvantage: Set<number>;
  attack_advantage: boolean;
  /** A flat bonus on this casting's attack roll: what `bonus {to: spell_attack}` is worth. */
  attack_bonus: number;
  reroll_attack: boolean;
  reroll_damage: number;
  slot_increase: number;
  duration_multiplier: number;
  /** Extended Spell: Advantage on the Constitution saves that keep this casting's Concentration up. */
  concentration_advantage: boolean;
  extra_targets: Array<{ id: number; feature: string; within_ft?: number }>;
  /** What the casting's own features charge for it, each under the name of the feature that asked. */
  costs: Array<FeatureCost & { feature: string }>;
  /** Arcane Apotheosis paid for one Metamagic option of this turn, and the turn remembers it. */
  free_metamagic?: boolean;
  notes: string[];
}

/** The spell as the registry is told about it. */
export const spellInfoOf = (spell: SpellFill): SpellInfo => ({
  name: spell.name,
  level: spell.level,
  slot_level: spell.slot_level,
  school: spell.school,
  damage_type: spell.damage_type ?? null,
  attack_roll: spell.attack_roll,
  ...(spell.save_ability ? { save_ability: spell.save_ability } : {}),
  concentration: spell.concentration,
  range_ft: spell.range_ft,
  classes: spell.classes,
});

/**
 * Metamagic is refused before anything is written: an option this Sorcerer does not know, more options
 * than the text allows on one casting, or more sorcery points than they have.
 */
export function requireMetamagic(sheet: CombatSheet, actor: Combatant, names: string[], damageExpr?: string): void {
  if (names.length === 0) return;
  // Empowered Spell rerolls dice, so a fixed total cannot ride with it: refuse before anything is spent.
  if (
    damageExpr !== undefined &&
    /^\s*\d+\s*$/.test(damageExpr) &&
    names.some((name) => name.trim().toLowerCase() === 'empowered spell')
  ) {
    throw new Error(
      `Empowered Spell rerolls dice, and damage_expr "${damageExpr}" carries none: drop damage_expr and let the engine roll, or drop Empowered Spell.`,
    );
  }
  const known = heldMetamagic(sheet);
  if (known.length === 0) {
    throw new Error(`${actor.name} knows no Metamagic; it is a Sorcerer feature taken at level 2.`);
  }
  for (const name of names) {
    if (!known.some((held) => held.toLowerCase() === name.trim().toLowerCase())) {
      throw new Error(`${actor.name} does not know ${name}. They know: ${known.join(', ')}.`);
    }
  }
  // "Only one Metamagic option on a spell unless otherwise noted": Empowered and Seeking say otherwise,
  // and Sorcery Incarnate allows a second while Innate Sorcery runs.
  const counted = names.filter((name) => !STACKING_METAMAGIC.some((free) => free.toLowerCase() === name.toLowerCase()));
  const allowed = hasFeature(sheet, 'sorcerer-sorcery-incarnate') && actor.flags.innate_sorcery ? 2 : 1;
  if (counted.length > allowed) {
    throw new Error(
      `Only ${allowed} Metamagic option${allowed === 1 ? '' : 's'} may ride on one casting${
        allowed === 1 ? ' unless the option says otherwise' : ''
      }; ${counted.join(', ')} is ${counted.length}. Empowered Spell and Seeking Spell may always come along.`,
    );
  }
  const total = names.reduce((sum, name) => sum + metamagicCost(name), 0);
  requireResource(sheet, actor, { resource: 'sorcery_points', amount: total }, `${names.join(' and ')}`);
}

/** Folds everything the caster's features do to this casting into one plan the spell path then follows. */
export function planCast(
  sheet: CombatSheet,
  actor: Combatant,
  spell: SpellFill,
  targets: Combatant[],
  options: CastOptions,
  base: { save_dc: number | undefined; damage_type: string | null },
): CastPlan {
  const modifiers = castModifiers(sheet, {
    actor,
    spell: spellInfoOf(spell),
    targets,
    options,
  });
  const plan: CastPlan = {
    modifiers,
    economy: spell.economy,
    range_ft: spell.range_ft,
    save_dc: base.save_dc,
    damage_type: base.damage_type,
    auto_success: new Set<number>(),
    save_disadvantage: new Set<number>(),
    attack_advantage: false,
    attack_bonus: 0,
    reroll_attack: false,
    reroll_damage: 0,
    slot_increase: 0,
    duration_multiplier: 1,
    concentration_advantage: false,
    extra_targets: [],
    costs: [],
    notes: [],
  };
  // Arcane Apotheosis: the first Metamagic option of the turn is free while Innate Sorcery runs.
  let freeMetamagic = arcaneApotheosisFree(sheet, actor);
  for (const modifier of modifiers) {
    if (modifier.spend && freeMetamagic && modifier.spend.resource === 'sorcery_points') {
      freeMetamagic = false;
      plan.free_metamagic = true;
      plan.notes.push(`Arcane Apotheosis: ${modifier.feature} costs no Sorcery Points this turn.`);
      plan.notes.push(modifier.note);
      continue;
    }
    if (modifier.spend) plan.costs.push({ ...modifier.spend, feature: modifier.feature });
    plan.notes.push(modifier.note);
    switch (modifier.kind) {
      case 'economy':
        plan.economy = modifier.economy === 'bonus_action' ? 'bonus_action' : 'action';
        break;
      case 'range':
        plan.range_ft =
          plan.range_ft === null
            ? (modifier.least_ft ?? null)
            : Math.max(plan.range_ft * (modifier.multiplier ?? 1), modifier.least_ft ?? 0);
        break;
      case 'save_dc':
        if (plan.save_dc !== undefined) plan.save_dc += modifier.bonus;
        break;
      case 'attack_advantage':
        plan.attack_advantage = true;
        break;
      case 'attack_bonus':
        plan.attack_bonus += modifier.bonus;
        break;
      case 'reroll_attack':
        plan.reroll_attack = true;
        break;
      case 'extra_target':
        plan.extra_targets.push({
          id: modifier.target_id,
          feature: modifier.feature,
          ...(modifier.within_ft === undefined ? {} : { within_ft: modifier.within_ft }),
        });
        break;
      case 'slot_level':
        plan.slot_increase += modifier.increase;
        break;
      case 'duration':
        plan.duration_multiplier *= modifier.multiplier;
        if (modifier.concentration_advantage) plan.concentration_advantage = true;
        break;
      case 'save_disadvantage':
        plan.save_disadvantage.add(modifier.target_id);
        break;
      case 'auto_success':
        for (const id of modifier.target_ids) plan.auto_success.add(id);
        break;
      case 'damage_type':
        plan.damage_type = modifier.to;
        break;
      case 'reroll_damage':
        plan.reroll_damage = Math.max(plan.reroll_damage, modifier.dice);
        break;
      default:
        break;
    }
  }
  return plan;
}

/**
 * Empowered Spell: damage dice below the die's average are rolled again, lowest first, and the new
 * rolls stand. A roll the player made themselves comes back as a total with no dice to reread, so it says so instead.
 */
export function rerollLowest(
  expr: string,
  dice: number[],
  count: number,
): { delta: number; note: string } {
  const faces = Number(/d(\d+)/i.exec(expr)?.[1] ?? 0);
  if (faces === 0 || dice.length === 0) {
    return { delta: 0, note: 'Empowered Spell: the dice were rolled elsewhere, so reroll them yourself.' };
  }
  const belowAverage = dice.filter((value) => value < (faces + 1) / 2).sort((a, b) => a - b);
  if (belowAverage.length === 0) {
    return { delta: 0, note: 'Empowered Spell: every die is already above average, nothing rerolled.' };
  }
  // "A number of those dice up to your Charisma modifier (minimum of one)": only a die below its average is worth rerolling.
  let delta = 0;
  const swapped: string[] = [];
  for (const die of belowAverage.slice(0, Math.max(count, 1))) {
    const again = rollDice(`1d${faces}`, { roll_type: 'damage' });
    delta += again.total - die;
    swapped.push(`${die} -> ${again.total}`);
  }
  return { delta, note: `Empowered Spell: ${swapped.join(', ')}.` };
}

/** The Beast whose statistics Wild Shape takes, refused when the Druid's level does not allow that one. */
export function beastForm(name: string, limits: { max_cr: number; fly: boolean }): CreatureStatBlock {
  const block = statBlockFor(name);
  if (!/beast/i.test(block.type)) {
    throw new Error(`${block.name} is a ${block.type}, and Wild Shape takes the form of a Beast.`);
  }
  if (block.cr > limits.max_cr) {
    throw new Error(
      `${block.name} is CR ${block.cr}, and Wild Shape reaches CR ${limits.max_cr} at this level. Name a smaller Beast.`,
    );
  }
  if (!limits.fly && (block.speed.fly ?? 0) > 0) {
    throw new Error(`${block.name} has a Fly Speed, and Wild Shape takes no flying form until Druid level 8.`);
  }
  return block;
}

/** Wild Shape: the Beast's game statistics go on the combatant row, and the Druid's own are kept to come back to. */
export function enterWildShape(db: Db, encounter: EncounterRow, actor: Combatant, sheet: CombatSheet, block: CreatureStatBlock): void {
  const fresh = getCombatant(db, encounter.id, actor.id);
  fresh.flags = {
    ...fresh.flags,
    wild_shape: {
      form: block.name,
      base_ac: fresh.ac,
      base_speed: fresh.speed,
      rounds_left: wildShapeRounds(sheet.level),
    },
  };
  fresh.ac = block.ac;
  fresh.speed = block.speed.walk ?? fresh.speed;
  fresh.movement_left = Math.min(fresh.movement_left, fresh.speed);
  setCombatantStatBlock(db, fresh.id, block);
  saveCombatant(db, fresh);
  actor.flags = fresh.flags;
  actor.ac = fresh.ac;
  actor.speed = fresh.speed;
  actor.stat_block = block;
}

/** Out of the Beast form and back into the Druid's own, however it ended. */
export function revertWildShape(db: Db, encounter: EncounterRow, actor: Combatant, why: string): CombatLogEntry[] {
  const fresh = getCombatant(db, encounter.id, actor.id);
  const shape = fresh.flags.wild_shape;
  if (!shape) return [];
  fresh.flags = { ...fresh.flags, wild_shape: undefined };
  fresh.ac = shape.base_ac;
  fresh.speed = shape.base_speed;
  fresh.movement_left = Math.min(fresh.movement_left, fresh.speed);
  setCombatantStatBlock(db, fresh.id, null);
  saveCombatant(db, fresh);
  actor.flags = fresh.flags;
  actor.ac = fresh.ac;
  actor.speed = fresh.speed;
  actor.stat_block = null;
  return [
    logCombat(db, encounter, {
      actor_id: fresh.id,
      kind: 'feature_note',
      payload: { feature: 'Wild Shape', ended: true, form: shape.form, reason: why },
      text: `${fresh.name} drops the ${shape.form} form: ${why}.`,
    }),
  ];
}

/** Find Familiar through Wild Companion or Pact of the Chain: the familiar joins the fight as a companion. */
export async function summonFamiliar(
  db: Db,
  encounter: EncounterRow,
  actor: Combatant,
  form: string,
  feature: string,
): Promise<CombatLogEntry[]> {
  const created = createCompanion(db, {
    campaign_id: encounter.campaign_id,
    name: `${actor.name}'s ${form}`,
    source: { creature: form },
  });
  const sheet = combatSheet(db, created.companion!.id);
  const token = addToEncounter(db, encounter, {
    kind: 'companion',
    name: sheet.name,
    team: actor.team,
    sheet,
    preferX: actor.x,
  });
  const roll = await rollOwnInitiative(db, encounter, token, initiativeBonus(token, sheet), 'use_action');
  token.initiative = roll.total;
  saveCombatant(db, token);
  reorderInitiative(db, encounter, token.id);
  return [
    logCombat(db, encounter, {
      actor_id: actor.id,
      target_id: token.id,
      kind: 'join',
      payload: { feature, familiar: form, combatant_id: token.id, character_id: sheet.id, initiative: roll.total },
      text: `${sheet.name} appears at (${token.x},${token.y}) and joins the fight on initiative ${roll.total} (${feature}).`,
    }),
  ];
}
