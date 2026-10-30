// Combat engine: 2024 weapon mastery effects.
import type { StatBlockAction } from '../srd/data.js';
import * as srd from '../srd/data.js';
import { weaponMastery } from '../srd/lookup.js';
import type { Db } from '../db/connection.js';
import { weaponOfAction } from './actions.js';
import { distanceBetween } from './grid.js';
import { type CombatSheet } from './sheet.js';
import {
  activeCombatant,
  getCombatant,
  listCombatants,
  logCombat,
  saveCombatant,
  type Combatant,
  type CombatFlags,
  type CombatLogEntry,
  type EncounterRow,
} from './state.js';
import { signed, partyHp, immuneTo, profBonusOf } from './engine-core.js';
import { type DamageResult } from './damage-math.js';
import { type SaveResult, rollSave } from './d20.js';
import { isDowned, damageCombatant } from './hp.js';
import { afterDamage, killEntry, attachEffect } from './effects.js';
import { footprintSizes, pushToken } from './movement.js';

// --- 2024 weapon mastery ----------------------------------------------------

/** Cleave carries into a creature within 5 ft of the first target; Push shoves 10 ft and Slow costs 10. */
const CLEAVE_FT = 5;
const PUSH_FT = 10;
const SLOW_FT = 10;

/** What a mastery property did, as the attack result and the fight log carry it. */
export interface MasteryEffect {
  property: string;
  /** Graze: the damage a miss still deals, the attacker's ability modifier, with no roll. */
  damage?: DamageResult & { type: string | null };
  pushed_ft?: number;
  save?: SaveResult;
  prone?: boolean;
  sapped?: boolean;
  slowed_ft?: number;
  vex?: boolean;
  /** Cleave: the other creatures this swing may carry on into, by id. */
  cleave_targets?: number[];
}

/**
 * The mastery property this swing carries: the weapon's own, and only for an attacker whose sheet names
 * that weapon. A monster fights from a stat block and never has mastery.
 */
export function masteryFor(sheet: CombatSheet | null, action: StatBlockAction): srd.WeaponPropertyData | null {
  const weapon = sheet ? weaponOfAction(action.name, sheet) : undefined;
  if (!sheet || !weapon) return null;
  const known = sheet.mastery_weapons.some((name) => name.trim().toLowerCase() === weapon.name.toLowerCase());
  return known ? weaponMastery(weapon.name) : null;
}

/** Cleave is one extra attack a turn, into a second creature beside the first: this is what refuses it. */
export function requireCleave(
  db: Db,
  encounter: EncounterRow,
  attacker: Combatant,
  target: Combatant,
  fromId: number,
  mastery: srd.WeaponPropertyData | null,
  action: StatBlockAction,
): void {
  if (mastery?.index !== 'cleave') {
    throw new Error(
      `cleave_from follows a hit with a Cleave weapon ${attacker.name} has mastery with; ${action.name} is not one.`,
    );
  }
  if (attacker.flags.cleaved) {
    throw new Error(`${attacker.name} has already cleaved this turn: Cleave gives one extra attack per turn.`);
  }
  if (fromId === target.id) {
    throw new Error(
      'Cleave strikes a second creature: pass cleave_from as the first target and target_id as the other one.',
    );
  }
  const first = getCombatant(db, encounter.id, fromId);
  const ready = attacker.flags.cleave_ready;
  if (ready?.target_id !== fromId || ready.weapon !== action.name) {
    throw new Error(`no Cleave to follow up: hit ${first.name} with ${action.name} first this turn.`);
  }
  const gap = distanceBetween(first, target);
  if (gap > CLEAVE_FT) {
    throw new Error(
      `${target.name} is ${gap} ft from ${first.name}; Cleave only carries into a creature within ${CLEAVE_FT} ft of the first target.`,
    );
  }
}

/** Cleave's extra swing deals the weapon's damage without the ability modifier, unless that is negative. */
export function withoutAbilityMod(dice: string, mod: number): string {
  if (mod <= 0) return dice;
  const match = /^(.*?)([+-]\d+)$/.exec(dice);
  if (!match) return dice;
  const flat = Number(match[2]) - mod;
  return flat === 0 ? match[1]! : `${match[1]}${signed(flat)}`;
}

/**
 * The 2024 mastery property, resolved after the swing: Graze pays out on a miss, the rest on a hit.
 * Nick is not here - it rides on two-weapon fighting, which the engine does not run yet.
 */
export async function resolveMastery(
  db: Db,
  encounter: EncounterRow,
  attacker: Combatant,
  target: Combatant,
  input: {
    mastery: srd.WeaponPropertyData;
    action: StatBlockAction;
    ability_mod: number;
    damage_type: string | null;
    hit: boolean;
    /** Slow and Vex need a hit that dealt damage; Push, Sap and Topple ride on the hit alone. */
    damage_dealt: number;
    melee: boolean;
    reach_ft: number;
    no_push?: boolean;
  },
): Promise<{ effect: MasteryEffect; log: CombatLogEntry[] }> {
  const log: CombatLogEntry[] = [];
  const effect: MasteryEffect = { property: input.mastery.name };
  const note = (text: string, payload: Record<string, unknown> = {}): void => {
    log.push(
      logCombat(db, encounter, {
        actor_id: attacker.id,
        target_id: target.id,
        kind: 'mastery',
        payload: { property: input.mastery.name, action: input.action.name, ...payload },
        text,
      }),
    );
  };

  if (input.mastery.index === 'graze') {
    const amount = Math.max(0, input.ability_mod);
    if (input.hit || amount === 0) return { effect, log };
    const source = `${attacker.name}'s ${input.action.name} (Graze)`;
    const result = damageCombatant(db, encounter, target, { amount, type: input.damage_type, source });
    effect.damage = { ...result, type: input.damage_type };
    note(
      `The blow grazes ${target.name} for ${result.applied} ${input.damage_type ?? ''} damage${partyHp(target, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
      { damage: result },
    );
    log.push(...(await afterDamage(db, encounter, target, result.applied, 'attack')));
    if (result.dead) log.push(killEntry(db, encounter, target, source));
    else if (isDowned(db, encounter, target.id)) {
      log.push(
        logCombat(db, encounter, {
          target_id: target.id,
          kind: 'downed',
          payload: { name: target.name },
          text: `${target.name} drops to 0 HP and falls unconscious.`,
        }),
      );
    }
    return { effect, log };
  }
  if (!input.hit) return { effect, log };
  // Cleave springs from the hit itself; the rest need a creature still on its feet to land on.
  const standing = target.alive && target.hp_current > 0;
  if (input.mastery.index !== 'cleave' && !standing) return { effect, log };

  switch (input.mastery.index) {
    case 'push': {
      if (input.no_push || footprintSizes(target.size) > footprintSizes('L')) break;
      const pushed = pushToken(db, encounter, attacker, target, PUSH_FT);
      effect.pushed_ft = pushed;
      note(`${attacker.name} drives ${target.name} ${pushed} ft back to (${target.x},${target.y}).`, {
        pushed_ft: pushed,
        to: { x: target.x, y: target.y },
      });
      break;
    }
    case 'sap': {
      target.flags = { ...target.flags, sapped_by: { attacker_id: attacker.id } };
      saveCombatant(db, target);
      effect.sapped = true;
      note(`${target.name} is sapped: Disadvantage on its next attack roll before ${attacker.name}'s next turn.`, {
        sapped_by: attacker.id,
      });
      break;
    }
    case 'slow': {
      if (input.damage_dealt <= 0) break;
      // No stacking: a creature already slowed has the window pushed out, not another 10 ft taken off.
      const already = target.flags.slowed_by !== undefined;
      target.flags = { ...target.flags, slowed_by: { attacker_id: attacker.id, ft: SLOW_FT } };
      if (!already) target.movement_left = Math.max(0, target.movement_left - SLOW_FT);
      saveCombatant(db, target);
      effect.slowed_ft = SLOW_FT;
      note(`${target.name} is slowed: ${SLOW_FT} ft off its speed until ${attacker.name}'s next turn.`, {
        slowed_by: attacker.id,
        ft: SLOW_FT,
      });
      break;
    }
    case 'topple': {
      const dc = 8 + input.ability_mod + profBonusOf(db, attacker);
      const save = await rollSave(db, encounter, target, 'con', dc, { tool: 'attack' });
      effect.save = save;
      if (save.success) {
        note(`${target.name} keeps its feet (CON save ${save.total} vs DC ${dc}).`, { save, prone: false });
        break;
      }
      const immune = immuneTo(db, encounter, target, 'prone');
      if (immune) {
        note(`${immune} (CON save ${save.total} vs DC ${dc}).`, { save, prone: false });
        break;
      }
      const created = attachEffect(db, encounter, {
        target_id: target.id,
        source_id: attacker.id,
        name: 'prone',
        kind: 'condition',
        tick: 'end',
        ends: 'manual',
      });
      log.push(created.entry);
      effect.prone = true;
      target.conditions = getCombatant(db, encounter.id, target.id).conditions;
      note(`${target.name} is knocked Prone (CON save ${save.total} vs DC ${dc}).`, { save, prone: true });
      break;
    }
    case 'vex': {
      if (input.damage_dealt <= 0) break;
      // A Vex granted out of turn runs out at the end of the attacker's next turn, not this round's.
      const ownTurn = activeCombatant(listCombatants(db, encounter.id), encounter.turn_index)?.id === attacker.id;
      attacker.flags = {
        ...attacker.flags,
        vex_against: { target_id: target.id, round: encounter.round, ...(ownTurn ? { granted_in_own_turn: true } : {}) },
      };
      saveCombatant(db, attacker);
      effect.vex = true;
      note(`${attacker.name} has Advantage on its next attack against ${target.name}.`, { vex_against: target.id });
      break;
    }
    case 'cleave': {
      if (!input.melee || attacker.flags.cleaved) break;
      attacker.flags = { ...attacker.flags, cleave_ready: { target_id: target.id, weapon: input.action.name } };
      saveCombatant(db, attacker);
      const beside = listCombatants(db, encounter.id).filter(
        (c) =>
          c.id !== target.id &&
          c.id !== attacker.id &&
          c.alive &&
          c.hp_current > 0 &&
          distanceBetween(c, target) <= CLEAVE_FT &&
          distanceBetween(attacker, c) <= input.reach_ft,
      );
      if (beside.length === 0) break;
      effect.cleave_targets = beside.map((c) => c.id);
      note(
        `${attacker.name} may cleave on into ${beside.map((c) => `${c.name} (${c.id})`).join(' or ')}: attack {cleave_from: ${target.id}} swings again without spending another attack.`,
        { cleave_targets: effect.cleave_targets },
      );
      break;
    }
    default:
      break;
  }
  return { effect, log };
}

/**
 * Sap, Vex and Studied Attacks are spent on the one attack roll they moved, hit or miss: a weapon swing
 * or a spell. Studied Attacks buys "your next attack roll against that creature", and this is it.
 */
export function spendSapVex(db: Db, attacker: Combatant, target: Combatant): void {
  const vexed = attacker.flags.vex_against?.target_id === target.id;
  const studied = attacker.flags.studied_target?.target_id === target.id;
  if (!attacker.flags.sapped_by && !vexed && !studied) return;
  attacker.flags = {
    ...attacker.flags,
    sapped_by: undefined,
    ...(vexed ? { vex_against: undefined } : {}),
    ...(studied ? { studied_target: undefined } : {}),
  };
  saveCombatant(db, attacker);
}

/** Sap and Slow last until the start of the attacker's next turn; Vex until the end of it. */
export function expireMastery(db: Db, encounter: EncounterRow, actor: Combatant, when: 'start' | 'end'): CombatLogEntry[] {
  const entries: CombatLogEntry[] = [];
  const clear = (on: Combatant, flags: CombatFlags, text: string, payload: Record<string, unknown>): void => {
    on.flags = flags;
    saveCombatant(db, on);
    entries.push(logCombat(db, encounter, { actor_id: actor.id, target_id: on.id, kind: 'mastery_end', payload, text }));
  };
  if (when === 'end') {
    const vex = actor.flags.vex_against;
    // The Advantage lasts through the attacker's whole next turn: one granted on this turn survives it.
    if (vex && (vex.round < encounter.round || !vex.granted_in_own_turn)) {
      clear(actor, { ...actor.flags, vex_against: undefined }, `${actor.name} loses the Advantage Vex gave it.`, {
        property: 'Vex',
        target_id: vex.target_id,
      });
    }
    return entries;
  }
  for (const other of listCombatants(db, encounter.id)) {
    if (other.flags.sapped_by?.attacker_id === actor.id) {
      clear(other, { ...other.flags, sapped_by: undefined }, `${other.name} shakes off the Sap.`, { property: 'Sap' });
    }
    const slowed = other.flags.slowed_by;
    if (slowed?.attacker_id === actor.id) {
      const fresh = getCombatant(db, encounter.id, other.id);
      clear(fresh, { ...fresh.flags, slowed_by: undefined }, `${other.name} has its full speed back.`, {
        property: 'Slow',
        ft: slowed.ft,
      });
    }
  }
  return entries;
}
