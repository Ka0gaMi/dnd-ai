// Combat engine: hit, miss and damage riders and the reactions that mitigate a hit.
import { setTempHp as setPcTempHp, useSpellSlot } from '../core/character.js';
import type { Db } from '../db/connection.js';
import {
  bardicDie,
  hasFeature,
  huntersMarkDie,
  irresistibleOffense,
  resourceSpec,
  type RiderWindow,
  type HitRider,
  type ReactionOffer,
} from './features.js';
import { distanceBetween } from './grid.js';
import { combatSheet, sheetAbilityMod, type CombatSheet } from './sheet.js';
import {
  getCombatant,
  listCombatants,
  listEffects,
  logCombat,
  saveCombatant,
  type Combatant,
  type CombatLogEntry,
  type EncounterRow,
  type Effect,
} from './state.js';
import { partyHp, sheetOf, immuneTo } from './engine-core.js';
import { spendFeatureCost } from './resources.js';
import { criticalExpr, rollDamage } from './damage-math.js';
import { askPlayer, rollSave } from './d20.js';
import { mirrorCharacter, isDowned, damageCombatant } from './hp.js';
import { afterDamage, type EffectInput, endEffect, attachEffect } from './effects.js';
import { droppedToZero, afterKill } from './outcome.js';
import { pushToken } from './movement.js';

/**
 * The effect row for a rider window, which is a question of whose turn edge closes it. "Until the end of
 * its next turn" runs off the target's own turn, which tickEffects already counts down. The two "your
 * next turn" windows run off the source's, and expireSourceRiders counts those: such a row waits on
 * ends 'manual' with the source turn edges still to pass left in remaining_rounds, and tick saying which
 * edge. A rider laid on the source's own turn has this turn's end to get past before the next one's.
 */
function riderWindow(ends: RiderWindow): Pick<EffectInput, 'tick' | 'ends' | 'remaining_rounds'> {
  switch (ends) {
    case 'end_of_its_next_turn':
      return { tick: 'end', ends: 'rounds', remaining_rounds: 1 };
    case 'start_of_your_next_turn':
      return { tick: 'start', ends: 'manual', remaining_rounds: 1 };
    case 'end_of_your_next_turn':
      return { tick: 'end', ends: 'manual', remaining_rounds: 2 };
    case 'minute':
      return { tick: 'end', ends: 'rounds', remaining_rounds: 10 };
    default:
      return { tick: 'end', ends: 'manual' };
  }
}

/** How long a rider's condition stays on, in the effect row's own words. */
function riderEnds(rider: Extract<HitRider, { kind: 'save' }>, attacker: Combatant): Omit<EffectInput, 'target_id'> {
  const base = { name: rider.condition, kind: 'condition' as const, source_id: attacker.id };
  if (rider.ends === 'minute') {
    return { ...base, tick: 'end', ends: 'save', save_ability: rider.ability, save_dc: rider.dc, remaining_rounds: 10 };
  }
  return { ...base, ...riderWindow(rider.ends) };
}

/**
 * The riders whose window the SRD keys to their source's turn rather than their target's: Stunning
 * Strike's Stunned to the start of the Monk's next turn, Hurl Through Hell's Incapacitated to the end of
 * the Warlock's. Each source turn edge takes one off the count riderWindow left on the row.
 */
export function expireSourceRiders(
  db: Db,
  encounter: EncounterRow,
  actor: Combatant,
  when: 'start' | 'end',
): CombatLogEntry[] {
  const entries: CombatLogEntry[] = [];
  for (const effect of listEffects(db, encounter.id)) {
    if (effect.source_id !== actor.id || effect.ends !== 'manual' || effect.remaining_rounds === null) continue;
    if (effect.tick !== when) continue;
    const remaining = effect.remaining_rounds - 1;
    db.prepare('UPDATE effect SET remaining_rounds = ? WHERE id = ?').run(remaining, effect.id);
    if (remaining > 0) continue;
    const target = getCombatant(db, encounter.id, effect.target_id);
    endEffect(db, encounter, effect);
    entries.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: target.id,
        kind: 'effect_end',
        payload: { effect_id: effect.id, name: effect.name },
        text: `${effect.name} ends on ${target.name}: ${actor.name}'s turn ${when === 'start' ? 'begins' : 'ends'}.`,
      }),
    );
  }
  return entries;
}

/** A rolled rider, kept whole so a stance can come off the attack's total before any of it lands. */
export type RiderRoll = { total: number; expr: string; output: string };

/** A flat negative damage rider, the only kind that folds into the damage instead of landing on its own. */
function flatRider(rider: HitRider): number | null {
  if (rider.kind !== 'damage' || !/^-?\d+$/.test(rider.dice)) return null;
  const value = Number(rider.dice);
  return value < 0 ? value : null;
}

/**
 * Every damage rider rolled ahead of the blow, keyed by the rider it belongs to. When the player rolls
 * their own damage each rider's dice go on their own card exactly as spell damage does, and a card left
 * to time out still comes back as a server roll.
 */
export async function rollRiderDamage(
  db: Db,
  encounter: EncounterRow,
  attacker: Combatant,
  target: Combatant,
  riders: HitRider[],
  critical: boolean,
  tool: string,
): Promise<Map<HitRider, RiderRoll>> {
  const rolled = new Map<HitRider, RiderRoll>();
  for (const rider of riders) {
    if (rider.kind !== 'damage') continue;
    const flat = flatRider(rider);
    if (flat !== null) {
      // A negative flat rider is never rolled or offered to the player: it folds into the damage parts.
      rolled.set(rider, { total: flat, expr: rider.dice, output: rider.dice });
      continue;
    }
    const expr = critical ? criticalExpr(rider.dice) : rider.dice;
    const pre = await askPlayer(db, encounter, attacker, 'damage', {
      tool,
      expr,
      purpose: `Damage: ${expr}${rider.damage_type ? ` (${rider.damage_type})` : ''}`,
      roll_type: 'damage',
      target_id: target.id,
    });
    rolled.set(rider, rollDamage(rider.dice, critical, pre));
  }
  return rolled;
}

/**
 * A negative flat rider folds into the damage instance instead of landing as a part of its own: its
 * magnitude comes off the part of the same type first, then the others in order, no part below 0.
 * Returns the lines logged and the riders folded away, which the caller must not apply again but must
 * still charge for.
 */
export function foldNegativeRiders(
  db: Db,
  encounter: EncounterRow,
  attacker: Combatant,
  target: Combatant,
  parts: Array<{ type: string | null; amount: number }>,
  riderRolls: Map<HitRider, RiderRoll>,
): { log: CombatLogEntry[]; folded: Set<HitRider> } {
  const log: CombatLogEntry[] = [];
  const folded = new Set<HitRider>();
  for (const [rider, rolled] of riderRolls) {
    if (rider.kind !== 'damage' || rolled.total >= 0) continue;
    const requested = -rolled.total;
    const order = [
      ...parts.filter((part) => part.type === rider.damage_type),
      ...parts.filter((part) => part.type !== rider.damage_type),
    ];
    let left = requested;
    const changes: string[] = [];
    for (const part of order) {
      if (left <= 0) break;
      const before = part.amount;
      const off = Math.min(left, before);
      part.amount = before - off;
      left -= off;
      if (off > 0) changes.push(`${before} ${part.type ?? 'untyped'} becomes ${part.amount}`);
    }
    folded.add(rider);
    riderRolls.delete(rider);
    const removed = requested - left;
    const payload = { feature: rider.feature, folded: removed, ...(removed !== requested ? { requested } : {}) };
    const note = rider.note.trimEnd().replace(/\.$/, '');
    // A miss carries no part to reduce: say the rider fired rather than let it vanish.
    if (order.length === 0) {
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: target.id,
          kind: 'feature_note',
          payload,
          text: `${note}: nothing to reduce.`,
        }),
      );
      continue;
    }
    // Nothing could come off (the part was already 0): name it rather than let the rider vanish.
    if (changes.length === 0) changes.push(`0 ${order[0]!.type ?? 'untyped'} becomes 0`);
    // "(floored)" only when part of the rider is still left over once every part has hit 0.
    if (left > 0) changes[changes.length - 1] += ' (floored)';
    log.push(
      logCombat(db, encounter, {
        actor_id: attacker.id,
        target_id: target.id,
        kind: 'feature_note',
        payload,
        text: `${note}, ${changes.join(', ')}.`,
      }),
    );
  }
  return { log, folded };
}

/**
 * When a half-on-save, Evasion or Potent Cantrip reduces a spell's roll, a positive rider of the spell's
 * own type folds into the damage before that reduction, and one of another type is reduced on its own.
 * Returns the lines logged and the riders folded away, which the caller must still charge for.
 */
export function foldPositiveRidersForHalving(
  db: Db,
  encounter: EncounterRow,
  attacker: Combatant,
  target: Combatant,
  parts: Array<{ type: string | null; amount: number }>,
  riderRolls: Map<HitRider, RiderRoll>,
  damageType: string | null,
  /** The clause that says why the roll is reduced, printed where "the save" used to be assumed. */
  reduced: string,
  /** True when Evasion takes a successful save to nothing, so another type's rider becomes 0 too. */
  takesNothing: boolean,
): { log: CombatLogEntry[]; folded: Set<HitRider> } {
  const log: CombatLogEntry[] = [];
  const folded = new Set<HitRider>();
  for (const [rider, rolled] of riderRolls) {
    if (rider.kind !== 'damage' || rolled.total <= 0) continue;
    const note = rider.note.trimEnd().replace(/\.$/, '');
    if (rider.damage_type != null && rider.damage_type !== damageType) {
      const after = takesNothing ? 0 : Math.floor(rolled.total / 2);
      // The odd point this rider's own floor loses is carried into the spell's part, so the instance
      // halves once in total: floor((base + sum(rider)) / 2) === floor((base + sum(odd)) / 2) + sum(floor(rider / 2)).
      const carried = takesNothing ? 0 : rolled.total % 2;
      if (carried > 0) parts[0]!.amount += carried;
      riderRolls.set(rider, { ...rolled, total: after });
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: target.id,
          kind: 'feature_note',
          payload: { feature: rider.feature, halved: rolled.total, to: after, ...(carried > 0 ? { carried: 1 } : {}) },
          text:
            carried > 0
              ? `${note}: ${rolled.total} ${rider.damage_type} becomes ${after} because ${reduced}, its odd point carried into the ${damageType ?? 'untyped'} roll before the halving.`
              : `${note}: ${rolled.total} ${rider.damage_type} becomes ${after} because ${reduced}.`,
        }),
      );
      continue;
    }
    parts[0]!.amount += rolled.total;
    folded.add(rider);
    riderRolls.delete(rider);
    log.push(
      logCombat(db, encounter, {
        actor_id: attacker.id,
        target_id: target.id,
        kind: 'feature_note',
        payload: { feature: rider.feature, folded: rolled.total },
        text: `${rider.feature}: +${rolled.total} ${damageType ?? 'untyped'} folded into the roll before ${reduced}.`,
      }),
    );
  }
  return { log, folded };
}

/** Everything a feature adds to a hit, resolved in the order the registry returned it. */
export async function applyHitRiders(
  db: Db,
  encounter: EncounterRow,
  attacker: Combatant,
  target: Combatant,
  sheet: CombatSheet,
  riders: HitRider[],
  rolls: Map<HitRider, RiderRoll>,
  critical: boolean,
  /** True when the caller sums this rider damage with the rest of the hit and makes one concentration save. */
  deferAfterDamage = false,
): Promise<{ log: CombatLogEntry[]; applied: Array<Record<string, unknown>>; damage: number }> {
  const log: CombatLogEntry[] = [];
  const applied: Array<Record<string, unknown>> = [];
  let damageDealt = 0;
  // A creature that already dropped takes no more riders, and one line names what the blow left unspent.
  const suppressed: string[] = [];
  for (const rider of riders) {
    if (!target.alive) {
      suppressed.push(rider.feature);
      continue;
    }
    if (rider.spend) log.push(spendFeatureCost(db, encounter, attacker, sheet, rider.spend, rider.feature));
    // A rider that burns a spell slot: Eldritch Smite, and nothing else.
    if (rider.spend_slot !== undefined && attacker.character_id) {
      const spent = useSpellSlot(db, {
        campaign_id: encounter.campaign_id,
        character_id: attacker.character_id,
        level: rider.spend_slot,
      });
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          kind: 'spell_slot',
          payload: { feature: rider.feature, level: rider.spend_slot, remaining: spent.remaining },
          text: `${attacker.name} spends a level ${rider.spend_slot} Pact Magic slot on ${rider.feature} (${spent.remaining} left).`,
        }),
      );
    }
    if (rider.kind === 'condition') {
      const immune = immuneTo(db, encounter, target, rider.condition);
      if (immune) {
        log.push(
          logCombat(db, encounter, {
            actor_id: attacker.id,
            target_id: target.id,
            kind: 'note',
            payload: { condition: rider.condition, immune: true },
            text: `${immune} ${rider.feature} leaves no ${rider.condition} on it.`,
          }),
        );
        continue;
      }
      const created = attachEffect(db, encounter, {
        name: rider.condition,
        kind: 'condition',
        source_id: attacker.id,
        // "for N rounds" counts its own rounds; every other window is a turn edge the engine knows.
        ...(rider.rounds === undefined
          ? riderWindow(rider.ends)
          : { tick: 'end' as const, ends: 'rounds' as const, remaining_rounds: rider.rounds }),
        target_id: target.id,
      });
      target.conditions = getCombatant(db, encounter.id, target.id).conditions;
      applied.push({ feature: rider.feature, condition: rider.condition, applied: true });
      log.push(created.entry, ...created.landed);
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: target.id,
          kind: 'feature_note',
          payload: { feature: rider.feature, condition: rider.condition },
          text: rider.note,
        }),
      );
      continue;
    }
    if (rider.kind === 'temp_hp') {
      if (attacker.character_id) {
        setPcTempHp(db, {
          campaign_id: encounter.campaign_id,
          character_id: attacker.character_id,
          amount: rider.amount,
          mirror: false,
        });
        mirrorCharacter(db, attacker);
        saveCombatant(db, attacker);
      }
      applied.push({ feature: rider.feature, temp_hp: rider.amount });
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          kind: 'temp_hp',
          payload: { feature: rider.feature, amount: rider.amount },
          text: rider.note,
        }),
      );
      continue;
    }
    if (rider.kind === 'damage') {
      const rolled = rolls.get(rider) ?? rollDamage(rider.dice, critical);
      const boon = irresistibleOffense(sheet);
      const physical = ['bludgeoning', 'piercing', 'slashing'].includes((rider.damage_type ?? '').toLowerCase());
      const result = damageCombatant(db, encounter, target, {
        amount: rolled.total,
        type: rider.damage_type,
        source: `${attacker.name}'s ${rider.feature}`,
        critical,
        ...(boon && physical ? { ignore_resistance: true } : {}),
      });
      applied.push({
        feature: rider.feature,
        damage: result.applied,
        expr: rolled.expr,
        type: rider.damage_type,
        note: rider.note,
      });
      damageDealt += result.applied;
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: target.id,
          kind: 'feature_damage',
          payload: { feature: rider.feature, ...result, type: rider.damage_type, expr: rolled.expr },
          text: `${rider.note} ${target.name} takes ${result.applied} more (${rolled.output})${partyHp(target, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
        }),
      );
      if (!deferAfterDamage) log.push(...(await afterDamage(db, encounter, target, result.applied, 'attack')));
      if (result.dead) log.push(...afterKill(db, encounter, target, attacker, `${attacker.name}'s ${rider.feature}`));
      else if (!deferAfterDamage && isDowned(db, encounter, target.id)) log.push(...droppedToZero(db, encounter, target, attacker));
      continue;
    }
    if (rider.kind === 'save') {
      const immune = immuneTo(db, encounter, target, rider.condition);
      const save = await rollSave(db, encounter, target, rider.ability, rider.dc, { tool: 'attack' });
      applied.push({ feature: rider.feature, save, condition: rider.condition, applied: !save.success && !immune });
      if (save.success || immune) {
        log.push(
          logCombat(db, encounter, {
            actor_id: attacker.id,
            target_id: target.id,
            kind: 'feature_save',
            payload: { feature: rider.feature, save, applied: false },
            text: immune
              ? `${immune} (${rider.ability.toUpperCase()} save ${save.total} vs DC ${rider.dc}.)`
              : `${target.name} shrugs off ${rider.feature} (${rider.ability.toUpperCase()} save ${save.total} vs DC ${rider.dc})${
                  rider.on_success ? `: ${rider.on_success}` : ''
                }.`,
          }),
        );
        continue;
      }
      // A failed save that also hurts: Hurl Through Hell's 8d10, which a Fiend does not feel.
      if (rider.damage) {
        const spared = rider.damage.unless_type
          ? new RegExp(rider.damage.unless_type, 'i').test(target.stat_block?.type ?? '')
          : false;
        if (spared) {
          log.push(
            logCombat(db, encounter, {
              actor_id: attacker.id,
              target_id: target.id,
              kind: 'note',
              payload: { feature: rider.feature, spared: rider.damage.unless_type },
              text: `${target.name} is ${rider.damage.unless_type} and takes no ${rider.damage.type} damage from ${rider.feature}.`,
            }),
          );
        } else {
          const rolled = rollDamage(rider.damage.expr, false);
          const result = damageCombatant(db, encounter, target, {
            amount: rolled.total,
            type: rider.damage.type,
            source: `${attacker.name}'s ${rider.feature}`,
          });
          applied.push({ feature: rider.feature, damage: result.applied, expr: rolled.expr, type: rider.damage.type });
          damageDealt += result.applied;
          log.push(
            logCombat(db, encounter, {
              actor_id: attacker.id,
              target_id: target.id,
              kind: 'feature_damage',
              payload: { feature: rider.feature, ...result, type: rider.damage.type, expr: rolled.expr },
              text: `${target.name} takes ${result.applied} ${rider.damage.type} damage (${rolled.output})${partyHp(target, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
            }),
          );
          if (!deferAfterDamage) log.push(...(await afterDamage(db, encounter, target, result.applied, 'attack')));
          if (result.dead) log.push(...afterKill(db, encounter, target, attacker, `${attacker.name}'s ${rider.feature}`));
          else if (!deferAfterDamage && isDowned(db, encounter, target.id)) log.push(...droppedToZero(db, encounter, target, attacker));
        }
      }
      const created = attachEffect(db, encounter, { ...riderEnds(rider, attacker), target_id: target.id });
      target.conditions = getCombatant(db, encounter.id, target.id).conditions;
      log.push(created.entry, ...created.landed);
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: target.id,
          kind: 'feature_save',
          payload: { feature: rider.feature, save, applied: true, condition: rider.condition },
          text: `${rider.note} ${target.name} fails (${rider.ability.toUpperCase()} save ${save.total} vs DC ${rider.dc}) and is ${rider.condition}.`,
        }),
      );
      continue;
    }
    if (rider.kind === 'stance') {
      const on = rider.on === 'self' ? attacker : getCombatant(db, encounter.id, target.id);
      // "You can have only one creature under the effect of this feature at a time": the new one replaces it.
      const dropped = rider.flags.quivering_palm ? clearOtherPalms(db, encounter, attacker, on) : null;
      // Divine Smite's dice double on a critical hit, so the armed flag remembers the hit's criticality.
      const flags = rider.flags.smite_ready
        ? { ...rider.flags, smite_ready: { ...rider.flags.smite_ready, critical } }
        : rider.flags;
      on.flags = { ...on.flags, ...flags };
      saveCombatant(db, on);
      if (rider.on === 'target') target.flags = on.flags;
      applied.push({ feature: rider.feature, stance: flags, ...(dropped ? { replaced: dropped.name } : {}) });
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: rider.on === 'target' ? target.id : null,
          kind: 'feature_note',
          payload: { feature: rider.feature, flags, ...(dropped ? { replaced: dropped.name } : {}) },
          text: dropped
            ? `${rider.note} The vibrations leave ${dropped.name}: only one creature carries them at a time.`
            : rider.note,
        }),
      );
      continue;
    }
    if (rider.kind === 'push') {
      const moved = pushToken(db, encounter, attacker, target, rider.ft);
      applied.push({ feature: rider.feature, pushed_ft: moved });
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: target.id,
          kind: 'feature_note',
          payload: { feature: rider.feature, pushed_ft: moved },
          text: `${rider.note} ${target.name} lands at (${target.x},${target.y}), ${moved} ft back.`,
        }),
      );
      continue;
    }
    if (rider.kind === 'move') {
      attacker.movement_left += rider.ft;
      saveCombatant(db, attacker);
      applied.push({ feature: rider.feature, movement_ft: rider.ft });
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          kind: 'feature_note',
          payload: { feature: rider.feature, movement_ft: rider.ft },
          text: `${rider.note} ${attacker.name} has ${attacker.movement_left} ft of movement.`,
        }),
      );
      continue;
    }
    applied.push({ feature: rider.feature, note: rider.note, ...(rider.reminder ? { reminder: rider.reminder } : {}) });
    log.push(
      logCombat(db, encounter, {
        // A reminder is a fight-log line and nothing else: it never reaches the player's story feed.
        kind: rider.reminder ? 'reminder' : 'feature_note',
        actor_id: attacker.id,
        target_id: target.id,
        payload: { feature: rider.feature, ...(rider.reminder ? { reason: rider.reminder } : {}) },
        text: rider.note,
      }),
    );
  }
  // The dead take no riders: name what was left unspent so the DM can read the blow for what it was.
  if (suppressed.length > 0) {
    log.push(
      logCombat(db, encounter, {
        actor_id: attacker.id,
        target_id: target.id,
        kind: 'note',
        payload: { already_down: target.name, suppressed },
        text: `${suppressed.join(', ')} ${suppressed.length === 1 ? 'is' : 'are'} not applied: ${target.name} already dropped.`,
      }),
    );
  }
  return { log, applied, damage: damageDealt };
}

/** Quivering Palm takes its vibrations off whoever carried them before, so one Monk sets only one. */
function clearOtherPalms(db: Db, encounter: EncounterRow, monk: Combatant, keeping: Combatant): Combatant | null {
  for (const other of listCombatants(db, encounter.id)) {
    if (other.id === keeping.id || other.flags.quivering_palm?.monk_id !== monk.id) continue;
    other.flags = { ...other.flags, quivering_palm: undefined };
    saveCombatant(db, other);
    return other;
  }
  return null;
}

/** Uncanny Dodge and Deflect Attacks, both declared before the blow: what they take off it. */
export function mitigateHit(
  db: Db,
  encounter: EncounterRow,
  target: Combatant,
  damageType: string | null,
): { halve: boolean; reduce: number; log: CombatLogEntry[] } | null {
  const sheet = sheetOf(db, target);
  if (!sheet) return null;
  const physical = ['bludgeoning', 'piercing', 'slashing'];
  const deflects =
    target.flags.deflect_ready === true &&
    (damageType === null || physical.includes(damageType.toLowerCase()) || hasFeature(sheet, 'monk-deflect-energy'));
  const dodges = target.flags.uncanny_dodge_ready === true;
  // Superior Hunter's Defense: Resistance to this blow, and to that type for the rest of the turn.
  const braced = target.flags.hunters_defense_ready === true;
  if (!deflects && !dodges && !braced) return null;
  const log: CombatLogEntry[] = [];
  let reduce = 0;
  if (deflects) {
    const rolled = rollDamage(`1d10+${sheetAbilityMod(sheet, 'dex') + sheet.level}`, false);
    reduce = rolled.total;
    log.push(
      logCombat(db, encounter, {
        actor_id: target.id,
        kind: 'feature_note',
        payload: { feature: 'Deflect Attacks', reduce },
        text: `${target.name} deflects the blow: ${reduce} off the damage (${rolled.output}).`,
      }),
    );
  }
  if (dodges) {
    log.push(
      logCombat(db, encounter, {
        actor_id: target.id,
        kind: 'feature_note',
        payload: { feature: 'Uncanny Dodge' },
        text: `${target.name} rolls with it: Uncanny Dodge halves the damage.`,
      }),
    );
  }
  if (braced) {
    log.push(
      logCombat(db, encounter, {
        actor_id: target.id,
        kind: 'feature_note',
        payload: { feature: "Superior Hunter's Defense", damage_type: damageType },
        text: `${target.name} takes the blow head on: Resistance to ${
          damageType ?? 'that damage'
        } now and for the rest of the turn (Superior Hunter's Defense).`,
      }),
    );
  }
  const fresh = getCombatant(db, encounter.id, target.id);
  fresh.flags = {
    ...fresh.flags,
    deflect_ready: undefined,
    uncanny_dodge_ready: undefined,
    hunters_defense_ready: undefined,
    ...(braced && damageType ? { resisting: { type: damageType.toLowerCase(), rounds_left: 1 } } : {}),
  };
  saveCombatant(db, fresh);
  target.flags = fresh.flags;
  return { halve: dodges || braced, reduce, log };
}

const CUTTING_WORDS_FT = 60;

/**
 * Cutting Words, declared ahead of the roll it spoils: the Bardic Inspiration die a bard within 60 ft
 * already spent comes off this attack roll, and the declaration goes with it.
 */
export function cuttingWords(
  db: Db,
  encounter: EncounterRow,
  attacker: Combatant,
  combatants: Combatant[],
): { amount: number; note: string; log: CombatLogEntry[] } | null {
  const bard = combatants.find(
    (c) =>
      c.flags.cutting_words_ready !== undefined &&
      c.team !== attacker.team &&
      c.alive &&
      c.hp_current > 0 &&
      distanceBetween(c, attacker) <= CUTTING_WORDS_FT,
  );
  if (!bard) return null;
  const rolled = rollDamage(`1d${bard.flags.cutting_words_ready!.die}`, false);
  const fresh = getCombatant(db, encounter.id, bard.id);
  fresh.flags = { ...fresh.flags, cutting_words_ready: undefined };
  saveCombatant(db, fresh);
  return {
    amount: rolled.total,
    note: `Cutting Words from ${bard.name}: -${rolled.total}`,
    log: [
      logCombat(db, encounter, {
        actor_id: bard.id,
        target_id: attacker.id,
        kind: 'feature_note',
        payload: { feature: 'Cutting Words', amount: rolled.total },
        text: `${bard.name} cuts ${attacker.name} down with a word: ${rolled.total} off the attack roll (${rolled.output}).`,
      }),
    ],
  };
}

/** The bards who may still spoil this attacker's next roll, as offers on the result of this one. */
export function cuttingWordsOffers(db: Db, encounter: EncounterRow, attacker: Combatant): ReactionOffer[] {
  const out: ReactionOffer[] = [];
  for (const combatant of listCombatants(db, encounter.id)) {
    if (!combatant.character_id || combatant.team === attacker.team) continue;
    if (!combatant.alive || combatant.hp_current === 0 || combatant.reaction_used) continue;
    if (combatant.flags.cutting_words_ready || distanceBetween(combatant, attacker) > CUTTING_WORDS_FT) continue;
    const sheet = combatSheet(db, combatant.character_id);
    if (!hasFeature(sheet, 'lore-cutting-words')) continue;
    const left = resourceSpec(sheet, 'bardic_inspiration');
    const row = sheet.features.find((f) => f.mechanics?.resource === 'bardic_inspiration');
    if ((left?.max ?? 0) - (row?.mechanics?.used ?? 0) <= 0) continue;
    out.push({
      action: 'cutting_words',
      name: 'Cutting Words',
      hint: `${combatant.name} may spend their reaction and a use of Bardic Inspiration to take a d${bardicDie(
        sheet,
      )} off ${attacker.name}'s next attack roll: use_action {actor_id: ${combatant.id}, action_name: "cutting_words", out_of_turn: true, reason: "Cutting Words"}.`,
    });
  }
  return out;
}

/** Rage lasts until the end of your next turn, and attacking or forcing a save pushes that out again. */
export function extendRage(db: Db, encounter: EncounterRow, actor: Combatant): void {
  const raging = actor.flags.raging;
  if (!raging || raging.extended_round >= encounter.round) return;
  actor.flags = { ...actor.flags, raging: { ...raging, extended_round: encounter.round } };
  saveCombatant(db, actor);
}

/** Hunter's Mark: the spell rides on every weapon hit its caster lands on the marked creature. */
export function huntersMarkRider(
  effects: Effect[],
  attacker: Combatant,
  target: Combatant,
  sheet: CombatSheet,
): HitRider | null {
  const mark = effects.find(
    (e) => e.active && e.target_id === target.id && e.source_id === attacker.id && /hunter.s mark/i.test(e.name),
  );
  if (!mark) return null;
  const die = huntersMarkDie(sheet);
  return {
    kind: 'damage',
    feature: "Hunter's Mark",
    dice: `1d${die}`,
    damage_type: 'force',
    note: `Hunter's Mark: 1d${die} force damage to ${target.name}.`,
  };
}
