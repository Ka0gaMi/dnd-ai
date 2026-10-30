// Combat engine: attack option validation for class features.
import type { StatBlockAction } from '../srd/data.js';
import * as srd from '../srd/data.js';
import {
  cunningStrikeCount,
  cunningStrikeOptions,
  CUNNING_STRIKE_COST,
  hasBoon,
  hasFeature,
  hasInvocation,
  pactSlotLevel,
  resourceMax,
  resourceSpec,
  type AttackOptions,
} from './features.js';
import { type CombatSheet } from './sheet.js';
import { type Combatant } from './state.js';
import { requireSlot, requireResource } from './resources.js';

/** The mastery property Tactical Master swings instead of the weapon's own. */
export const swappedMastery = (index: 'push' | 'sap' | 'slow'): srd.WeaponPropertyData | undefined =>
  srd.weaponMasteryProperties().find((property) => property.index === index);

/**
 * The options a player put on one attack, refused before anything is written: a feature the character
 * does not have, a resource with nothing left, a Flurry strike that was never bought.
 */
export function requireAttackOptions(
  sheet: CombatSheet,
  attacker: Combatant,
  action: StatBlockAction,
  options: AttackOptions,
  masteryProperty: 'push' | 'sap' | 'slow' | undefined,
  heldDie: number | null,
): void {
  const missing = (what: string, feature: string): never => {
    throw new Error(`${attacker.name} has no ${feature}, so ${what} is not an option on this attack.`);
  };
  if (options.reckless && !hasFeature(sheet, 'barbarian-reckless-attack')) missing('reckless', 'Reckless Attack');
  if (options.brutal_strike) {
    if (!hasFeature(sheet, 'barbarian-brutal-strike')) missing('brutal_strike', 'Brutal Strike');
    if (!attacker.flags.reckless && !options.reckless) {
      throw new Error(
        'Brutal Strike is bought by giving up the Advantage of Reckless Attack: pass reckless true on the same attack.',
      );
    }
  }
  if (options.brutal_strike) {
    const chosen = Array.isArray(options.brutal_strike) ? options.brutal_strike : [options.brutal_strike];
    const improved = hasFeature(sheet, 'barbarian-improved-brutal-strike-1');
    const newer = chosen.filter((option) => option === 'staggering' || option === 'sundering');
    if (newer.length > 0 && !improved) {
      throw new Error(
        `${newer.join(' and ')} comes with Improved Brutal Strike at Barbarian level 13; ${attacker.name} has Forceful Blow ("forceful") and Hamstring Blow ("hamstring").`,
      );
    }
    const allowed = hasFeature(sheet, 'barbarian-improved-brutal-strike-2') ? 2 : 1;
    if (chosen.length > allowed) {
      throw new Error(
        `Brutal Strike carries ${allowed} effect${allowed === 1 ? '' : 's'} at this level, and ${chosen.length} were named. Two of them need Improved Brutal Strike at level 17.`,
      );
    }
    if (new Set(chosen).size !== chosen.length) {
      throw new Error('Improved Brutal Strike uses two different effects, not the same one twice.');
    }
  }
  if (options.cunning_strike?.length) {
    if (!hasFeature(sheet, 'rogue-cunning-strike')) missing('cunning_strike', 'Cunning Strike');
    const legal = cunningStrikeOptions(sheet);
    const unknown = options.cunning_strike.filter((effect) => !legal.includes(effect));
    if (unknown.length > 0) {
      throw new Error(
        `${attacker.name} has no Cunning Strike effect called ${unknown.join(' or ')}. They may use: ${legal
          .map((effect) => `${effect} (${CUNNING_STRIKE_COST[effect]}d6)`)
          .join(', ')}.`,
      );
    }
    const most = cunningStrikeCount(sheet);
    if (options.cunning_strike.length > most) {
      throw new Error(
        `Cunning Strike carries ${most} effect${most === 1 ? '' : 's'} on one Sneak Attack at this level; Improved Cunning Strike at level 11 makes it two.`,
      );
    }
    const dice = resourceMax(sheet, 'sneak_attack_dice');
    const cost = options.cunning_strike.reduce((sum, effect) => sum + CUNNING_STRIKE_COST[effect], 0);
    if (cost > dice - 1) {
      throw new Error(
        `Those effects cost ${cost}d6 of a ${dice}d6 Sneak Attack, and at least one die has to be left to deal damage with.`,
      );
    }
  }
  if (options.quivering_palm) {
    if (!hasFeature(sheet, 'open-hand-quivering-palm')) missing('quivering_palm', 'Quivering Palm');
    if (!/unarmed strike/i.test(action.name)) {
      throw new Error(`Quivering Palm rides on an Unarmed Strike, and ${action.name} is not one.`);
    }
    if (attacker.flags.quivering_palm_used) {
      throw new Error(`${attacker.name} has already set their Quivering Palm this turn.`);
    }
    requireResource(sheet, attacker, { resource: 'focus_points', amount: 4 }, 'Quivering Palm');
  }
  if (options.hurl_through_hell) {
    if (!hasFeature(sheet, 'fiend-patron-hurl-through-hell')) missing('hurl_through_hell', 'Hurl Through Hell');
    if (attacker.flags.hurl_through_hell_used) {
      throw new Error(`${attacker.name} has already used Hurl Through Hell this turn; it is once per turn.`);
    }
    // The use a long rest, or the Pact Magic slot that buys it back when the use is gone.
    const spec = resourceSpec(sheet, 'hurl_through_hell');
    const row = sheet.features.find((entry) => entry.mechanics?.resource === 'hurl_through_hell');
    const left = (spec?.max ?? 0) - (row?.mechanics?.used ?? 0);
    if (left <= 0) {
      const slot = pactSlotLevel(sheet);
      if (slot <= 0) throw new Error(`${attacker.name} has no Pact Magic slot to buy Hurl Through Hell back with.`);
      requireSlot(sheet, attacker, slot, 'Hurl Through Hell');
    }
  }
  if (options.empowered_strike && !hasFeature(sheet, 'monk-empowered-strikes')) {
    missing('empowered_strike', 'Empowered Strikes');
  }
  if (options.stunning_strike) {
    if (!hasFeature(sheet, 'monk-stunning-strike')) missing('stunning_strike', 'Stunning Strike');
    if (attacker.flags.stunning_strike_used) {
      throw new Error(`${attacker.name} has already tried a Stunning Strike this turn; it is once per turn.`);
    }
    requireResource(sheet, attacker, { resource: 'focus_points', amount: 1 }, 'a Stunning Strike');
  }
  if (options.flurry) {
    if ((attacker.flags.flurry_strikes ?? 0) <= 0) {
      throw new Error(
        `${attacker.name} has no Flurry of Blows strikes left: take the bonus action first with use_action {action_name: "flurry_of_blows"}.`,
      );
    }
    if (!/unarmed strike/i.test(action.name)) {
      throw new Error(`Flurry of Blows throws Unarmed Strikes; ${action.name} is not one.`);
    }
  }
  if (options.sacred_weapon) {
    if (!hasFeature(sheet, 'devotion-sacred-weapon')) missing('sacred_weapon', 'Sacred Weapon');
    if (action.kind !== 'melee_weapon_attack') {
      throw new Error(`Sacred Weapon blesses a Melee weapon, and ${action.name} is not one.`);
    }
    requireResource(sheet, attacker, { resource: 'channel_divinity', amount: 1 }, 'Sacred Weapon');
  }
  if (masteryProperty && !hasFeature(sheet, 'fighter-tactical-master')) {
    missing('mastery_property', 'Tactical Master');
  }
  if (options.eldritch_smite) {
    if (!hasInvocation(sheet, 'Eldritch Smite')) missing('eldritch_smite', 'Eldritch Smite invocation');
    if (!hasInvocation(sheet, 'Pact of the Blade')) {
      throw new Error('Eldritch Smite rides on a pact weapon, and Pact of the Blade is the invocation that makes one.');
    }
    if (attacker.flags.eldritch_smite_used) {
      throw new Error(`${attacker.name} has already used Eldritch Smite this turn; it is once per turn.`);
    }
    const slot = pactSlotLevel(sheet);
    if (slot <= 0) throw new Error(`${attacker.name} has no Pact Magic slots to spend on Eldritch Smite.`);
    requireSlot(sheet, attacker, slot, 'Eldritch Smite');
  }
  if (options.inspiration && heldDie === null) {
    throw new Error(
      `${attacker.name} is holding no Bardic Inspiration die. A Bard hands one out with use_action {action_name: "bardic_inspiration", target_id}.`,
    );
  }
  if (options.peerless_aim) {
    if (!hasBoon(sheet, 'Boon of Combat Prowess')) missing('peerless_aim', 'Boon of Combat Prowess');
    if (attacker.flags.peerless_aim_used) {
      throw new Error(
        `${attacker.name} has already used Peerless Aim; it comes back at the start of their next turn.`,
      );
    }
  }
}
