// Combat engine: the standard actions and the Unarmed Strike options.
import { type Advantage } from '../core/dice.js';
import { abilityMod, type Ability } from '../core/rules.js';
import type { Db } from '../db/connection.js';
import { STANDARD_ACTIONS } from './actions.js';
import { conditionRule, isIncapacitated, speedZeroBy } from './conditions.js';
import { coverBetween, distanceBetween, type Point } from './grid.js';
import { sheetAbilityMod, sheetSkillBonus } from './sheet.js';
import {
  encounterMap,
  getCombatant,
  listCombatants,
  listEffects,
  logCombat,
  saveCombatant,
  type Combatant,
  type CombatLogEntry,
  type EncounterRow,
} from './state.js';
import { type PreRoll, sheetOf, profBonusOf } from './engine-core.js';
import { saveBonus, type SaveResult, rollSave, rollCheck } from './d20.js';
import { dropCondition } from './hp.js';
import { endEffect, attachEffect } from './effects.js';
import { footprintSizes, reachOf, pushToken } from './movement.js';

// --- the standard actions and the Unarmed Strike options ---------------------

/** Nothing at all happens on a turn a creature is incapacitated: no action, bonus action or reaction. */
export function refuseIfIncapacitated(actor: Combatant): void {
  if (!isIncapacitated(actor.conditions)) return;
  const why = actor.conditions.filter((c) => conditionRule(c)?.incapacitated);
  throw new Error(
    `${actor.name} is ${why.join(' and ')} and takes no action, bonus action or reaction. End the condition first with condition{op: set, active: false} or effect {op: end}.`,
  );
}

const STANDARD_ALIASES: Record<string, string> = {
  stand_up: 'stand',
  escape: 'escape_grapple',
  escape_the_grapple: 'escape_grapple',
  'break_free': 'escape_grapple',
};

/** The standard action a name asks for, or null when it is a spell, a weapon or a stat-block action. */
export function standardId(name: string): string | null {
  const key = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const id = STANDARD_ALIASES[key] ?? key;
  return id in STANDARD_ACTIONS ? id : null;
}

/** Attacking, casting or making noise ends a Hide, and the Invisible it granted goes with it. */
export function revealHidden(db: Db, encounter: EncounterRow, actor: Combatant, doing: string): CombatLogEntry[] {
  if (!actor.flags.hidden) return [];
  const hide = listEffects(db, encounter.id).find(
    (e) => e.kind === 'condition' && e.name === 'invisible' && e.target_id === actor.id && e.source_id === actor.id,
  );
  if (hide) endEffect(db, encounter, hide);
  const fresh = getCombatant(db, encounter.id, actor.id);
  fresh.flags = { ...fresh.flags, hidden: false };
  saveCombatant(db, fresh);
  actor.conditions = fresh.conditions;
  actor.flags = fresh.flags;
  return [
    logCombat(db, encounter, {
      actor_id: actor.id,
      kind: 'hide_end',
      payload: { reason: doing },
      text: `${actor.name} is seen again: ${doing}.`,
    }),
  ];
}

/** An out-of-turn action by a combatant holding a readied one is that readied action going off. */
export function releaseReady(db: Db, encounter: EncounterRow, actor: Combatant, reaction: string | null): CombatLogEntry[] {
  const ready = actor.flags.ready;
  if (!reaction || !ready) return [];
  actor.flags = { ...actor.flags, ready: undefined };
  saveCombatant(db, actor);
  return [
    logCombat(db, encounter, {
      actor_id: actor.id,
      kind: 'ready_release',
      payload: { trigger: ready.trigger, action: ready.action },
      text: `${actor.name} releases the readied ${ready.action} (trigger: ${ready.trigger}).`,
    }),
  ];
}

const strModOf = (db: Db, combatant: Combatant): number => {
  const sheet = sheetOf(db, combatant);
  return sheet ? sheetAbilityMod(sheet, 'str') : abilityMod(combatant.stat_block?.abilities.str ?? 10);
};

/** 8 + STR modifier + proficiency bonus: the DC an Unarmed Strike's grapple or shove is saved against. */
const unarmedDc = (db: Db, combatant: Combatant): number => 8 + strModOf(db, combatant) + profBonusOf(db, combatant);

/** What a standard action answers with; the web reads these straight off the tool result. */
export interface StandardActionData {
  movement_left?: number;
  cost_ft?: number;
  disengaged?: boolean;
  dodging?: boolean;
  utilized?: boolean;
  ally_id?: number;
  against_id?: number;
  trigger?: string;
  readied_action?: string;
  hidden?: boolean;
  dc?: number;
  check?: { total: number; natural: number | null; bonus: number; success: boolean; advantage: Advantage; notes: string[] };
  effect_id?: number;
  grappler_id?: number;
  escaped?: boolean;
  target_id?: number;
  save?: SaveResult;
  applied?: boolean;
  escape_dc?: number;
  prone?: boolean;
  pushed_ft?: number;
  to?: Point;
  ruling?: string;
}

export interface StandardActionInput {
  target_id?: number;
  ally_target_id?: number;
  trigger?: string;
  readied_action?: string;
  shove_prone?: boolean;
  ruling?: { reason: string; push_ft?: number; advantage?: boolean };
  rolls?: Record<string, PreRoll>;
}

const SHOVE_FT = 5;
const HIDE_DC = 15;

/**
 * Grapple and Shove, the 2024 Unarmed Strike options: the target saves with the better of STR and DEX
 * against 8 + the attacker's STR modifier + its proficiency bonus.
 */
async function grappleOrShove(
  db: Db,
  encounter: EncounterRow,
  actor: Combatant,
  id: 'grapple' | 'shove',
  input: StandardActionInput,
): Promise<{ log: CombatLogEntry[]; data: StandardActionData }> {
  if (input.target_id === undefined) throw new Error(`${id} needs target_id: who ${actor.name} takes hold of.`);
  const target = getCombatant(db, encounter.id, input.target_id);
  const reach = reachOf(db, actor);
  const distance = distanceBetween(actor, target);
  if (distance > reach) {
    throw new Error(`${target.name} is ${distance} ft away, beyond ${actor.name}'s ${reach} ft reach; move closer first.`);
  }
  if (footprintSizes(target.size) - footprintSizes(actor.size) > 1) {
    throw new Error(`${target.name} is ${target.size} and more than one size larger than ${actor.name}: too big to ${id}.`);
  }
  const ruling = input.ruling?.reason.trim();
  if (input.ruling && !ruling) throw new Error('A DM ruling needs a reason: what the player did to earn it.');
  const dc = unarmedDc(db, actor);
  // The target picks the save it is better at, so the engine rolls the better of the two.
  const ability: Ability = saveBonus(db, target, 'dex') > saveBonus(db, target, 'str') ? 'dex' : 'str';
  const save = await rollSave(db, encounter, target, ability, dc, {
    ...(input.ruling?.advantage ? { advantage: 'disadvantage' as Advantage } : {}),
    roll: input.rolls?.[String(target.id)],
    tool: 'use_action',
  });
  const log: CombatLogEntry[] = [];
  const data: StandardActionData = { target_id: target.id, dc, save, ...(ruling ? { ruling } : {}) };

  if (save.success) {
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: target.id,
        kind: id,
        payload: { ...data, applied: false },
        text: `${ruling ? `DM ruling: ${ruling}. ` : ''}${target.name} resists ${actor.name}'s ${id} (${ability.toUpperCase()} save ${save.total} vs DC ${dc}).`,
      }),
    );
    return { log, data: { ...data, applied: false } };
  }

  if (id === 'grapple') {
    const created = attachEffect(db, encounter, {
      target_id: target.id,
      source_id: actor.id,
      name: 'grappled',
      kind: 'condition',
      tick: 'end',
      ends: 'manual',
    });
    const held = getCombatant(db, encounter.id, target.id);
    held.flags = { ...held.flags, grappled_by: actor.id };
    held.movement_left = 0;
    saveCombatant(db, held);
    actor.flags = { ...actor.flags, grappling: [...(actor.flags.grappling ?? []), target.id] };
    log.push(created.entry);
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: target.id,
        kind: 'grapple',
        payload: { ...data, applied: true, escape_dc: dc },
        text: `${actor.name} grapples ${target.name} (${ability.toUpperCase()} save ${save.total} vs DC ${dc}): speed 0 until it escapes with a DC ${dc} STR (Athletics) or DEX (Acrobatics) check.`,
      }),
    );
    return { log, data: { ...data, applied: true, escape_dc: dc, effect_id: created.effect.id } };
  }

  if (input.shove_prone) {
    const created = attachEffect(db, encounter, {
      target_id: target.id,
      source_id: actor.id,
      name: 'prone',
      kind: 'condition',
      tick: 'end',
      ends: 'manual',
    });
    log.push(created.entry);
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: target.id,
        kind: 'shove',
        payload: { ...data, applied: true, prone: true },
        text: `${ruling ? `DM ruling: ${ruling}. ` : ''}${actor.name} shoves ${target.name} to the ground (${ability.toUpperCase()} save ${save.total} vs DC ${dc}).`,
      }),
    );
    return { log, data: { ...data, applied: true, prone: true } };
  }

  const wanted = input.ruling?.push_ft ?? SHOVE_FT;
  const pushed = pushToken(db, encounter, actor, target, wanted);
  log.push(
    logCombat(db, encounter, {
      actor_id: actor.id,
      target_id: target.id,
      kind: 'shove',
      payload: { ...data, applied: true, pushed_ft: pushed, to: { x: target.x, y: target.y } },
      text: `${ruling ? `DM ruling: ${ruling}. ` : ''}${actor.name} shoves ${target.name} ${pushed} ft back to (${target.x},${target.y}) (${ability.toUpperCase()} save ${save.total} vs DC ${dc}).`,
    }),
  );
  return { log, data: { ...data, applied: true, pushed_ft: pushed } };
}

/** Dash, Disengage, Dodge, Help, Hide, Ready, Utilize, standing up, grappling and escaping one. */
export async function standardAction(
  db: Db,
  encounter: EncounterRow,
  actor: Combatant,
  id: string,
  input: StandardActionInput,
): Promise<{ log: CombatLogEntry[]; data: StandardActionData }> {
  const log: CombatLogEntry[] = [];
  let data: StandardActionData = {};
  const note = (text: string, payload: StandardActionData = {}): void => {
    log.push(
      logCombat(db, encounter, { actor_id: actor.id, kind: 'action', payload: { action: id, ...payload }, text }),
    );
  };

  switch (id) {
    case 'dash': {
      actor.movement_left += actor.speed;
      actor.flags = { ...actor.flags, dashed: true };
      data = { movement_left: actor.movement_left };
      note(`${actor.name} dashes: ${actor.speed} ft more, ${actor.movement_left} ft of movement left.`, data);
      break;
    }
    case 'disengage': {
      actor.flags = { ...actor.flags, disengaged: true };
      data = { disengaged: true };
      note(`${actor.name} disengages: leaving reach draws no opportunity attack for the rest of this turn.`, data);
      break;
    }
    case 'dodge': {
      const stuck = speedZeroBy(actor.conditions);
      if (stuck.length > 0) throw new Error(`${actor.name} is ${stuck.join(' and ')} at speed 0, so Dodge does nothing.`);
      actor.flags = { ...actor.flags, dodging: true };
      data = { dodging: true };
      note(`${actor.name} dodges: attacks against them have disadvantage and their DEX saves advantage until their next turn.`, data);
      break;
    }
    case 'help': {
      if (input.target_id === undefined) throw new Error('help needs target_id: the ally being helped.');
      const ally = getCombatant(db, encounter.id, input.target_id);
      if (!ally.alive) throw new Error(`${ally.name} is out of the fight and cannot be helped.`);
      let against: Combatant | null = null;
      if (input.ally_target_id !== undefined) {
        against = getCombatant(db, encounter.id, input.ally_target_id);
        const away = distanceBetween(actor, against);
        if (away > 5) {
          throw new Error(
            `Helping with an attack needs the enemy within 5 ft of ${actor.name}; ${against.name} is ${away} ft away. Help with a check instead by leaving ally_target_id out.`,
          );
        }
      }
      ally.flags = {
        ...ally.flags,
        helped_by: { id: actor.id, name: actor.name, ...(against ? { against_id: against.id } : {}) },
      };
      saveCombatant(db, ally);
      data = { ally_id: ally.id, ...(against ? { against_id: against.id } : {}) };
      note(
        `${actor.name} helps ${ally.name}: advantage on their next ${against ? `attack against ${against.name}` : 'ability check'}.`,
        data,
      );
      break;
    }
    case 'hide': {
      const map = encounterMap(encounter);
      const combatants = listCombatants(db, encounter.id);
      // 2024: hiding needs Three-Quarters or Total Cover from everyone who could see you; half is not enough.
      const seen = combatants.filter((c) => {
        if (!c.alive || c.team === actor.team) return false;
        const cover = coverBetween(map, combatants, c, actor).cover;
        return cover !== 'three_quarters' && cover !== 'total';
      });
      if (seen.length > 0) {
        throw new Error(
          `${actor.name} is in plain sight of ${seen.map((c) => c.name).join(', ')}: hiding needs three-quarters cover, total cover or heavy obscurement. Move behind something first - find_position with cover_from finds the cell.`,
        );
      }
      const check = await rollCheck(db, encounter, actor, {
        ability: 'dex',
        skill: 'stealth',
        dc: HIDE_DC,
        purpose: 'Stealth check to hide',
        tool: 'use_action',
      });
      data = { check, dc: HIDE_DC, hidden: check.success };
      if (check.success) {
        const created = attachEffect(db, encounter, {
          target_id: actor.id,
          source_id: actor.id,
          name: 'invisible',
          kind: 'condition',
          tick: 'end',
          ends: 'manual',
        });
        log.push(created.entry);
        const fresh = getCombatant(db, encounter.id, actor.id);
        actor.conditions = fresh.conditions;
        actor.flags = { ...actor.flags, hidden: true };
        data = { ...data, effect_id: created.effect.id };
        note(`${actor.name} hides: Stealth ${check.total} against DC ${HIDE_DC} - unseen until they attack, cast or make noise.`, data);
      } else {
        note(`${actor.name} fails to hide: Stealth ${check.total} against DC ${HIDE_DC}.`, data);
      }
      break;
    }
    case 'ready': {
      const trigger = input.trigger?.trim();
      const readied = input.readied_action?.trim();
      if (!trigger || !readied) {
        throw new Error('ready needs trigger ("when the goblin steps into the doorway") and readied_action ("Shortbow").');
      }
      actor.flags = { ...actor.flags, ready: { trigger, action: readied } };
      data = { trigger, readied_action: readied };
      note(`${actor.name} readies ${readied}, triggered by: ${trigger}. Release it out of turn; it spends the reaction.`, data);
      break;
    }
    case 'utilize': {
      data = { utilized: true };
      note(`${actor.name} uses an object.`, data);
      break;
    }
    case 'stand': {
      if (!actor.conditions.includes('prone')) throw new Error(`${actor.name} is not prone.`);
      const cost = Math.floor(actor.speed / 2);
      if (actor.movement_left < cost) {
        throw new Error(`Standing up costs ${cost} ft of movement and ${actor.name} has ${actor.movement_left} ft left.`);
      }
      actor.movement_left -= cost;
      dropCondition(db, encounter, actor, 'prone');
      data = { cost_ft: cost, movement_left: actor.movement_left };
      note(`${actor.name} stands up for ${cost} ft of movement, ${actor.movement_left} ft left.`, data);
      break;
    }
    case 'escape_grapple': {
      const grapplerId = actor.flags.grappled_by;
      if (grapplerId === undefined) throw new Error(`${actor.name} is not grappled.`);
      const grappler = getCombatant(db, encounter.id, grapplerId);
      const dc = unarmedDc(db, grappler);
      // The escaper picks Athletics or Acrobatics, so the engine rolls whichever it is better at.
      const sheet = sheetOf(db, actor);
      const athleticsBonus = sheet
        ? sheetSkillBonus(sheet, 'athletics', 'str')
        : (actor.stat_block?.skills.athletics ?? abilityMod(actor.stat_block?.abilities.str ?? 10));
      const acrobaticsBonus = sheet
        ? sheetSkillBonus(sheet, 'acrobatics', 'dex')
        : (actor.stat_block?.skills.acrobatics ?? abilityMod(actor.stat_block?.abilities.dex ?? 10));
      const better: { ability: Ability; skill: string } =
        acrobaticsBonus > athleticsBonus ? { ability: 'dex', skill: 'acrobatics' } : { ability: 'str', skill: 'athletics' };
      const athletics = await rollCheck(db, encounter, actor, {
        ...better,
        dc,
        purpose: `Escape ${grappler.name}'s grapple: ${better.skill}`,
        tool: 'use_action',
      });
      data = { grappler_id: grappler.id, dc, check: athletics, escaped: athletics.success };
      if (athletics.success) {
        releaseGrapple(db, encounter, grappler, actor);
        note(`${actor.name} breaks free of ${grappler.name} (check ${athletics.total} vs DC ${dc}).`, data);
      } else {
        note(`${actor.name} stays in ${grappler.name}'s grip (check ${athletics.total} vs DC ${dc}).`, data);
      }
      break;
    }
    case 'grapple':
    case 'shove': {
      const done = await grappleOrShove(db, encounter, actor, id, input);
      log.push(...done.log);
      data = done.data;
      break;
    }
    default:
      throw new Error(`"${id}" is not a standard action.`);
  }

  saveCombatant(db, actor);
  return { log, data };
}

/** Unhooks a grapple from both sides: the condition, the grappled flag and the grappler's list. */
export function releaseGrapple(db: Db, encounter: EncounterRow, grappler: Combatant, target: Combatant): void {
  dropCondition(db, encounter, target, 'grappled');
  const held = getCombatant(db, encounter.id, target.id);
  held.flags = { ...held.flags, grappled_by: undefined };
  saveCombatant(db, held);
  const holder = getCombatant(db, encounter.id, grappler.id);
  holder.flags = { ...holder.flags, grappling: (holder.flags.grappling ?? []).filter((id) => id !== target.id) };
  saveCombatant(db, holder);
  if (grappler.id === target.id) return;
  grappler.flags = holder.flags;
  target.flags = held.flags;
  target.conditions = held.conditions;
}
