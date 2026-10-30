// The combat engine: initiative, movement, attacks, saves, damage, effects, turns and the fight log.
import { logEvent } from '../core/campaign.js';
import {
  deathSave as pcDeathSave,
  grantInspiration,
  grantInspirationDie,
  heldInspirationDie,
  restoreFeatureResource,
  restoreSpellSlot,
  setCondition as setPcCondition,
  setTempHp as setPcTempHp,
  spendInspirationDie,
  useSpellSlot,
} from '../core/character.js';
import { rollDice, type Advantage } from '../core/dice.js';
import { customSpellAction, findHomebrewSpell } from '../core/progression.js';
import { netAdvantage } from '../core/rolls.js';
import { type Ability } from '../core/rules.js';
import type { StatBlockAction } from '../srd/data.js';
import * as srd from '../srd/data.js';
import { findSpell } from '../srd/lookup.js';
import type { Db } from '../db/connection.js';
import {
  actionsFor,
  findAction,
  gripDamage,
  hasProperty,
  shieldEquipped,
  isAttack,
  legalActions,
  weaponAbility,
  weaponOfAction,
  STANDARD_ACTIONS,
} from './actions.js';
import { exhaustionPenalty, isIncapacitated, rulesOf, speedZeroBy } from './conditions.js';
import {
  attackBonusOf,
  auraHalfCover,
  bardicDie,
  classFeatures,
  critRangeOf,
  cunningStrikeCount,
  cunningStrikeOptions,
  CUNNING_STRIKE_COST,
  attackSources as featureAttackSources,
  defenceSources,
  allFeatureActionIds,
  featureActionIds,
  findFeatureAction,
  hasBoon,
  hasEvasion,
  hasFeature,
  hasInvocation,
  healRiders,
  hitRiders,
  holyNimbusDamage,
  huntersMarkDie,
  irresistibleOffense,
  isRaging,
  isWildShaped,
  missRiders,
  pactSlotLevel,
  reactionOffers,
  resourceMax,
  resourceSpec,
  sacredWeaponBlessing,
  saveMitigation,
  saveSucceededOutcomes,
  damageTakenOutcomes,
  spellDamageRiders,
  turnOutcomes,
  type AttackOptions,
  type BrutalStrikeOption,
  type CastOptions,
  type CunningStrikeOption,
  type RiderWindow,
  type FeatureAction,
  type FeatureCost,
  type FeatureHandler,
  type FeatureOutcome,
  type HitRider,
  type ReactionOffer,
  type RollSource,
} from './features.js';
import {
  aoeTargets,
  distanceToPoint,
  coverBetween,
  distanceBetween,
  type AoeShape,
  type Point,
  type Token,
} from './grid.js';
import { logFor } from './log-view.js';
import { anchorMechanics, combatSheet, sheetAbilityMod, type CombatSheet } from './sheet.js';
import { boostsFor, type ClauseCtx } from './homebrew.js';

import { dropSnapshot, lastSnapshot, restoreSnapshot, underSnapshot } from './undo.js';
import {
  activeCombatant,
  activeEncounter,
  battleState,
  combatLog,
  encounterMap,
  getCombatant,
  listCombatants,
  listEffects,
  logCombat,
  requireEncounter,
  saveCombatant,
  type Combatant,
  type CombatFlags,
  type CombatLogEntry,
  type EncounterRow,
  type Effect,
  type Team,
} from './state.js';
import {
  ATTACK_HOOKS,
  CAST_HOOKS,
  spentSlotThisTurn,
  type PreRoll,
  type RollOutcome,
  signed,
  nowIso,
  partyHp,
  xpForCr,
  refresh,
  finish,
  sheetOf,
  auraSources,
  pcLuck,
  immuneTo,
} from './engine-core.js';
import {
  requireTurn,
  attacksAllowed,
  requireEconomy,
  spendResource,
  requireReaction,
  reactionText,
  spendFeatureCost,
  spendChosenBoosts,
  requireSlot,
  requireSlotLevel,
  requireResource,
} from './resources.js';
import {
  rollHealing,
  maximumDamage,
  criticalExpr,
  rollDamage,
  greatWeaponBonus,
  damageLinesOf,
  damageTypeNote,
  type DamageResult,
} from './damage-math.js';
import {
  charmedBy,
  d20Context,
  rollD20,
  askPlayer,
  type SaveResult,
  applyD20Stance,
  rollSave,
} from './d20.js';
import {
  characterOf,
  mirrorCharacter,
  isDowned,
  damageCombatant,
  refreshVitals,
  healCombatant,
  dropCondition,
} from './hp.js';
import {
  endConcentration,
  afterDamage,
  type EffectInput,
  endEffect,
  tickEffects,
  killEntry,
  attachEffect,
} from './effects.js';
import { droppedToZero, afterKill, applyOutcome, remindersOf } from './outcome.js';
import {
  type CastingEconomy,
  COUNT_WORDS,
  castingEconomy,
  spellFill,
  requireSlotFor,
  spendSlotFor,
  freeCastOf,
  type NamedFreeCast,
  FREE_CAST_ECONOMY,
  planNamedFreeCast,
  spellInfoOf,
  requireMetamagic,
  planCast,
  rerollLowest,
  beastForm,
  enterWildShape,
  revertWildShape,
  summonFamiliar,
} from './spells.js';
import { crowdedShot, reachOf, pushToken } from './movement.js';
import {
  type MasteryEffect,
  masteryFor,
  requireCleave,
  withoutAbilityMod,
  resolveMastery,
  spendSapVex,
  expireMastery,
} from './mastery.js';
import {
  refuseIfIncapacitated,
  standardId,
  revealHidden,
  releaseReady,
  type StandardActionData,
  type StandardActionInput,
  standardAction,
  releaseGrapple,
} from './standard-actions.js';
export { type StandardActionData, type StandardActionInput } from './standard-actions.js';
export { type MasteryEffect } from './mastery.js';
export {
  type PositionIntent,
  type PositionCandidate,
  hasIntent,
  findPositions,
  type TacticsView,
  tacticsBetween,
  moveToken,
} from './movement.js';
export { type CastingEconomy, type SpellFill, castingEconomy, spellFill } from './spells.js';
export {
  type EnemySpec,
  type StartEncounterInput,
  statBlockFor,
  type PersistentRageOffer,
  startEncounter,
  addCombatant,
} from './encounter.js';
export {
  type EffectInput,
  tickEffects,
  applyEffect,
  endEffectById,
  setCombatCondition,
} from './effects.js';
export { damageCombatant } from './hp.js';
export { type D20Context, type SaveResult } from './d20.js';
export { criticalExpr, type DamageResult } from './damage-math.js';
export { type PreRoll, type RollOutcome, xpForCr } from './engine-core.js';

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
function expireSourceRiders(
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
type RiderRoll = { total: number; expr: string; output: string };

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
async function rollRiderDamage(
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
function foldNegativeRiders(
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
function foldPositiveRidersForHalving(
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
async function applyHitRiders(
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
function mitigateHit(
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
function cuttingWords(
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
function cuttingWordsOffers(db: Db, encounter: EncounterRow, attacker: Combatant): ReactionOffer[] {
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
function extendRage(db: Db, encounter: EncounterRow, actor: Combatant): void {
  const raging = actor.flags.raging;
  if (!raging || raging.extended_round >= encounter.round) return;
  actor.flags = { ...actor.flags, raging: { ...raging, extended_round: encounter.round } };
  saveCombatant(db, actor);
}

/** Hunter's Mark: the spell rides on every weapon hit its caster lands on the marked creature. */
function huntersMarkRider(
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

/** The mastery property Tactical Master swings instead of the weapon's own. */
const swappedMastery = (index: 'push' | 'sap' | 'slow'): srd.WeaponPropertyData | undefined =>
  srd.weaponMasteryProperties().find((property) => property.index === index);

/**
 * The options a player put on one attack, refused before anything is written: a feature the character
 * does not have, a resource with nothing left, a Flurry strike that was never bought.
 */
function requireAttackOptions(
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

// --- attacks ----------------------------------------------------------------

export async function attack(db: Db, input: Parameters<typeof runAttack>[1]) {
  return underSnapshot(db, requireEncounter(db, input.campaign_id), 'attack', () => runAttack(db, input));
}

async function runAttack(
  db: Db,
  input: {
    campaign_id: number;
    attacker_id: number;
    target_id: number;
    action_name: string;
    advantage?: Advantage;
    roll?: PreRoll;
    /** A versatile weapon swings two-handed unless a shield says otherwise; one_hand takes the smaller die. */
    grip?: 'one_hand' | 'two_hands';
    /** Pull the blow: a melee hit that would drop the target leaves it unconscious and stable instead. */
    knock_out?: boolean;
    /** Cleave: the creature just hit, whose neighbour this swing carries on into, free of the Attack action. */
    cleave_from?: number;
    /** Push: leave the target where it stands instead of driving it 10 ft back. */
    no_push?: boolean;
    /** Barbarian: attack recklessly, for Advantage on Strength attacks and Advantage on attacks against you. */
    reckless?: boolean;
    /** Rogue: false keeps the turn's one Sneak Attack back for a better swing. */
    sneak_attack?: boolean;
    /** Monk: spend a Focus Point on this hit to try to stun. */
    stunning_strike?: boolean;
    /** Barbarian 9: give up the Advantage on this swing for the dice and a Brutal Strike effect. */
    brutal_strike?: BrutalStrikeOption | BrutalStrikeOption[];
    /** Rogue 5: Sneak Attack dice traded for these effects, at the die cost each one lists. */
    cunning_strike?: CunningStrikeOption[];
    /** Monk 17: spend 4 Focus Points on this Unarmed Strike to set Quivering Palm going. */
    quivering_palm?: boolean;
    /** Warlock 14: try to hurl the creature this hit lands on through the Lower Planes. */
    hurl_through_hell?: boolean;
    /** Ranger 11: the second creature within 30 ft of the marked one the mark's damage jumps to. */
    prey_target_id?: number;
    /** Monk 6: this Unarmed Strike deals Force damage instead of its own type. */
    empowered_strike?: boolean;
    /** Monk 2: one of the Unarmed Strikes a Flurry of Blows bought, free of the Attack action. */
    flurry?: boolean;
    /** Paladin 3: spend a Channel Divinity to bless this weapon before the swing (Sacred Weapon). */
    sacred_weapon?: boolean;
    /** Warlock: spend a Pact Magic slot on this pact-weapon hit (Eldritch Smite). */
    eldritch_smite?: boolean;
    /** Add the Bardic Inspiration die this attacker is holding, if the roll would otherwise miss. */
    inspiration?: boolean;
    /** Boon of Combat Prowess: turn this attack into a hit if it misses, once until your next turn starts. */
    peerless_aim?: boolean;
    /** Homebrew clauses the roller chose for this swing, by their boost id; each is spent before the roll. */
    boosts?: string[];
    /** Fighter 9: swing this weapon with Push, Sap or Slow instead of its own mastery property. */
    mastery_property?: 'push' | 'sap' | 'slow';
    out_of_turn?: boolean;
    reason?: string;
  },
) {
  const encounter = requireEncounter(db, input.campaign_id);
  const attacker = getCombatant(db, encounter.id, input.attacker_id);
  const target = getCombatant(db, encounter.id, input.target_id);
  if (!attacker.alive || attacker.hp_current === 0) throw new Error(`${attacker.name} is down and cannot attack.`);
  if (!target.alive) throw new Error(`${target.name} is already dead.`);
  requireTurn(db, encounter, attacker, input.out_of_turn);
  const reaction = requireReaction(attacker, input.out_of_turn, input.reason);

  refuseIfIncapacitated(attacker);
  if (charmedBy(db, encounter, attacker, target)) {
    throw new Error(
      `${attacker.name} is charmed by ${target.name} and cannot attack them; end the Charmed condition first with effect {op: end} or condition{op: set, active: false}.`,
    );
  }
  if (standardId(input.action_name)) {
    throw new Error(
      `"${input.action_name}" is a standard action, not a weapon: resolve it with use_action {actor_id, action_name: "${standardId(input.action_name)}"}.`,
    );
  }
  const sheet = sheetOf(db, attacker);
  const action = findAction(attacker, sheet, input.action_name);
  if (!isAttack(action)) {
    throw new Error(`"${action.name}" is not an attack. Use use_action for spells, areas and abilities.`);
  }
  const swings = attacksAllowed(attacker, sheet);
  const melee = action.kind === 'melee_weapon_attack';
  const options: AttackOptions = {
    ...(input.reckless === undefined ? {} : { reckless: input.reckless }),
    ...(input.sneak_attack === undefined ? {} : { sneak_attack: input.sneak_attack }),
    ...(input.stunning_strike === undefined ? {} : { stunning_strike: input.stunning_strike }),
    ...(input.brutal_strike === undefined ? {} : { brutal_strike: input.brutal_strike }),
    ...(input.cunning_strike === undefined ? {} : { cunning_strike: input.cunning_strike }),
    ...(input.quivering_palm === undefined ? {} : { quivering_palm: input.quivering_palm }),
    ...(input.hurl_through_hell === undefined ? {} : { hurl_through_hell: input.hurl_through_hell }),
    ...(input.empowered_strike === undefined ? {} : { empowered_strike: input.empowered_strike }),
    ...(input.flurry === undefined ? {} : { flurry: input.flurry }),
    ...(input.sacred_weapon === undefined ? {} : { sacred_weapon: input.sacred_weapon }),
    ...(input.eldritch_smite === undefined ? {} : { eldritch_smite: input.eldritch_smite }),
    ...(input.inspiration === undefined ? {} : { inspiration: input.inspiration }),
    ...(input.peerless_aim === undefined ? {} : { peerless_aim: input.peerless_aim }),
  };
  // The Bardic Inspiration die this attacker is holding, if any: it is read before anything is written.
  const heldDie =
    sheet && attacker.character_id ? heldInspirationDie(db, encounter.campaign_id, attacker.character_id) : null;
  if (sheet) requireAttackOptions(sheet, attacker, action, options, input.mastery_property, heldDie);
  // Cleave's extra swing is part of the attack that earned it: it spends no action and no attack of one.
  const cleaving = input.cleave_from !== undefined;
  // A Flurry of Blows strike is paid for by the Focus Point already spent on the bonus action.
  const free = cleaving || input.flurry === true;
  if (!input.out_of_turn && !free) {
    requireEconomy(attacker, action.kind === 'bonus_action' ? 'bonus' : 'action', action.name, swings);
  }
  // "When you take the Attack action": Sacred Weapon rides on one of that action's own attacks.
  if (input.sacred_weapon && (free || input.out_of_turn || action.kind === 'bonus_action')) {
    throw new Error(
      'Sacred Weapon is taken when you take the Attack action: not on a bonus action, a Flurry strike, a cleave or a swing out of turn.',
    );
  }
  const blessing: CombatLogEntry[] = [
    ...spendChosenBoosts(db, encounter, attacker, sheet, input.boosts, { kind: 'attack', target, melee }),
  ];
  if (input.sacred_weapon && sheet) {
    const blessed = sacredWeaponBlessing(sheet, action.name);
    blessing.push(
      spendFeatureCost(db, encounter, attacker, sheet, { resource: 'channel_divinity', amount: 1 }, 'Sacred Weapon'),
    );
    attacker.flags = { ...attacker.flags, sacred_weapon: blessed };
    saveCombatant(db, attacker);
    blessing.push(
      logCombat(db, encounter, {
        actor_id: attacker.id,
        kind: 'feature_note',
        payload: { feature: 'Sacred Weapon', ...blessed },
        text: `${attacker.name} sanctifies ${action.name}: +${blessed.bonus} to attack rolls with it for 10 minutes, Radiant damage at will, and bright light in a 20 ft radius.`,
      }),
    );
  }
  // Reckless Attack is declared with the first swing and rides on every Strength attack until your next turn.
  if (input.reckless && !attacker.flags.reckless) {
    attacker.flags = { ...attacker.flags, reckless: true };
    saveCombatant(db, attacker);
  }
  if (input.knock_out && action.kind !== 'melee_weapon_attack') {
    throw new Error('knock_out needs a melee hit: a creature can only be knocked out by a blow within reach.');
  }
  const combatants = listCombatants(db, encounter.id);
  const map = encounterMap(encounter);
  const distance = distanceBetween(attacker, target);

  const extra: RollSource[] = [];
  const weapon = sheet ? weaponOfAction(action.name, sheet) : undefined;
  if (input.grip === 'two_hands' && sheet && shieldEquipped(sheet)) {
    throw new Error(`${attacker.name} has a shield in the other hand and cannot swing ${action.name} two-handed.`);
  }
  const own = masteryFor(sheet, action);
  // Tactical Master: a Fighter may swap the weapon's own mastery property for Push, Sap or Slow.
  const mastery = input.mastery_property ? (swappedMastery(input.mastery_property) ?? own) : own;
  if (cleaving) requireCleave(db, encounter, attacker, target, input.cleave_from!, own, action);
  // The ability behind the swing: Rage rides on it, Graze deals it, Topple saves against it.
  const ability = sheet ? weaponAbility(sheet, weapon) : 'str';
  const abilityMod = sheet ? sheetAbilityMod(sheet, ability) : 0;
  const parts = gripDamage(action, weapon, input.grip) ?? action.damage ?? [];
  const swung = cleaving ? parts.map((p) => ({ ...p, dice: withoutAbilityMod(p.dice, abilityMod) })) : parts;
  // Empowered Strikes: a Monk's Unarmed Strike may deal Force damage instead of its own type.
  const empowered =
    options.empowered_strike === true && sheet !== null && hasFeature(sheet, 'monk-empowered-strikes') && !weapon;
  const damageParts = empowered ? swung.map((p) => ({ ...p, type: 'force' })) : swung;
  // Heavy weapons need STR 13 in melee or DEX 13 at range, or they swing wild.
  if (sheet && hasProperty(weapon, 'heavy')) {
    const ability = action.kind === 'ranged_weapon_attack' ? 'dex' : 'str';
    const score = sheet.abilities[ability]?.score ?? 10;
    if (score < 13) {
      extra.push({ advantage: 'disadvantage', note: `${action.name} is heavy and ${attacker.name} has ${ability.toUpperCase()} ${score}` });
    }
  }
  if (action.kind === 'melee_weapon_attack') {
    const reach = action.reach_ft ?? 5;
    if (distance > reach) throw new Error(`${target.name} is ${distance} ft away, beyond the ${reach} ft reach of ${action.name}.`);
  } else {
    const crowded = crowdedShot(db, encounter, attacker);
    if (crowded) extra.push({ advantage: 'disadvantage', note: `${crowded}, so the shot is rushed` });
    const normal = action.range_ft ?? 30;
    const long = action.long_range_ft ?? normal;
    if (distance > long) throw new Error(`${target.name} is ${distance} ft away, beyond the ${long} ft long range of ${action.name}.`);
    // Long range imposes disadvantage, which cancels advantage instead of stacking with it.
    if (distance > normal) extra.push({ advantage: 'disadvantage', note: `${distance} ft is long range for ${action.name}` });
  }
  const effects = listEffects(db, encounter.id);
  if (sheet) {
    extra.push(
      ...featureAttackSources(sheet, {
        actor: attacker,
        target,
        action,
        weapon,
        ability,
        melee,
        distance_ft: distance,
        combatants,
        effects,
        options,
      }),
    );
  }
  // What the target's own features do to the roll: a raging Barbarian that attacked recklessly is easier to hit.
  const targetSheet = sheetOf(db, target);
  if (targetSheet) extra.push(...defenceSources(targetSheet, target));
  // The boosts this swing offers, worked out before the card goes out and again once it has been paid
  // for: the reply lists what is left, not what was on the table when the call started.
  const boostCtx: Omit<ClauseCtx, 'sheet'> = {
    kind: 'attack',
    target,
    melee,
    distance_ft: distance,
    source: weapon ? 'weapon' : 'unarmed',
    ...(sheet ? {} : {}),
  };
  const attackBoosts = sheet ? boostsFor(sheet, sheet.features, boostCtx, ATTACK_HOOKS) : [];
  const context = d20Context(db, encounter, attacker, {
    kind: 'attack',
    target,
    distance_ft: distance,
    advantage: input.advantage,
    extra,
  });
  let advantage = context.advantage;

  const cover = coverBetween(map, combatants, attacker, target);
  if (!cover.line_of_sight) {
    throw new Error(`${target.name} has total cover from ${attacker.name}: no line of sight, so move first.`);
  }
  // Smite of Protection: a paladin's aura lends Half Cover to whoever stands in it, cover or none.
  const auraCover = auraHalfCover(target, auraSources(db, encounter));
  const coverBonus = auraCover ? Math.max(cover.ac_bonus, 2) : cover.ac_bonus;
  const effectiveAc = target.ac + coverBonus;
  const blessed = sheet ? attackBonusOf(sheet, attacker, action, melee) : 0;
  // Sundering Blow: the Barbarian's last hit put +5 on the next attack roll anybody else makes.
  const sundering = target.flags.sundering_blow;
  const sundered = sundering && sundering.by_id !== attacker.id ? 5 : 0;
  // context.bonus is what a homebrew clause puts on the roll, the way a Fighting Style would.
  let bonus = (action.attack_bonus ?? 0) + context.penalty + blessed + sundered + context.bonus;
  const pre =
    input.roll ??
    (await askPlayer(db, encounter, attacker, 'attack', {
      tool: 'attack',
      expr: `1d20${signed(bonus)}`,
      purpose: `Attack: ${action.name}`,
      roll_type: 'attack',
      dc: effectiveAc,
      advantage,
      advantage_sources: context.advantage_sources,
      target_id: target.id,
      ...(attackBoosts.length ? { boosts_available: attackBoosts } : {}),
    }));
  // The player took a boost on their own card: it is spent here, inside this call's own snapshot.
  const cardBoosts = pre?.boosts_chosen?.length
    ? spendChosenBoosts(db, encounter, attacker, sheet, pre.boosts_chosen, boostCtx, ATTACK_HOOKS)
    : [];
  // The card was read after the context was worked out, so what it bought goes on the roll here: the
  // result and the log line carry the boosted Advantage and the boosted expression, not the old ones.
  const taken = attackBoosts.filter((one) => (pre?.boosts_chosen ?? []).includes(one.id) && !one.spend_on_fire);
  // A boost's Advantage is a source like any other, so it joins the list a later stance reroll re-nets.
  const advantageSources = [...context.advantage_sources];
  if (taken.some((one) => one.advantage)) {
    advantageSources.push('advantage');
    advantage = netAdvantage(advantageSources);
  }
  bonus += taken.reduce((sum, one) => sum + one.bonus, 0);
  const rolled = rollD20(
    bonus,
    { advantage, dc: effectiveAc, kind: 'attack', luck_bias: pcLuck(db, encounter, attacker) },
    pre,
  );
  // Cutting Words comes off the roll before it is read, and a Bardic Inspiration die goes on after:
  // the die is only rolled for a swing that would otherwise miss, and only spent when it turns one.
  const cut = cuttingWords(db, encounter, attacker, combatants);
  let total = rolled.total - (cut?.amount ?? 0);
  let inspired: { die: number; roll: number } | null = null;
  if (input.inspiration && heldDie !== null && rolled.natural !== 1 && total < effectiveAc) {
    const die = rollDamage(`1d${heldDie}`, false);
    if (total + die.total >= effectiveAc) {
      spendInspirationDie(db, encounter.campaign_id, attacker.character_id ?? undefined);
      inspired = { die: heldDie, roll: die.total };
      total += die.total;
    }
  }
  let natural = rolled.natural;
  let stanceNotes: string[] = [];
  if (natural !== 20 && total < effectiveAc) {
    const stance = await applyD20Stance(db, encounter, attacker, 'attack', rolled, {
      total,
      bonus,
      dc: effectiveAc,
      advantage,
      advantage_sources: advantageSources,
      tool: 'attack',
      purpose: action.name,
    });
    if (stance) {
      total = stance.total;
      natural = stance.natural;
      stanceNotes = stance.notes;
    }
  }
  let hit = natural === 20 || (natural !== 1 && total >= effectiveAc);
  // Boon of Combat Prowess: "you can hit instead" - asked for on the swing, and once until your next turn.
  let peerlessAim = false;
  if (!hit && input.peerless_aim) {
    hit = true;
    peerlessAim = true;
    attacker.flags = { ...attacker.flags, peerless_aim_used: true };
    saveCombatant(db, attacker);
  }
  if (sundered) {
    const fresh = getCombatant(db, encounter.id, target.id);
    fresh.flags = { ...fresh.flags, sundering_blow: undefined };
    saveCombatant(db, fresh);
    target.flags = fresh.flags;
  }
  // A hit on a paralyzed or unconscious target from within 5 ft is a critical hit.
  const helpless = distance <= 5 && rulesOf(target.conditions).some((r) => r.crit_within_5ft);
  // Improved Critical widens the range a natural die crits on; everyone else crits on a 20.
  const critRange = sheet ? critRangeOf(sheet) : 20;
  const critical = natural === 20 || (hit && natural !== null && natural >= critRange) || (hit && helpless);
  // Help is spent on the attack it was given for, and a hidden attacker gives itself away.
  const helped = attacker.flags.helped_by;
  if (helped && (helped.against_id === undefined || helped.against_id === target.id)) {
    attacker.flags = { ...attacker.flags, helped_by: undefined };
    saveCombatant(db, attacker);
  }
  spendSapVex(db, attacker, target);

  const swingNotes = [
    ...context.notes,
    ...(auraCover ? [auraCover] : []),
    ...(sundered ? ['Sundering Blow: +5 on this attack roll'] : []),
    ...(cut ? [cut.note] : []),
    ...(inspired ? [`Bardic Inspiration: +${inspired.roll} from the d${inspired.die} ${attacker.name} was holding`] : []),
    ...stanceNotes,
    ...(peerlessAim ? ['Boon of Combat Prowess: the miss is turned into a hit (Peerless Aim)'] : []),
  ];
  const log: CombatLogEntry[] = [
    ...cardBoosts,
    ...blessing,
    ...(cut ? cut.log : []),
    ...revealHidden(db, encounter, attacker, `attacks ${target.name}`),
    ...releaseReady(db, encounter, attacker, reaction),
    logCombat(db, encounter, {
      actor_id: attacker.id,
      target_id: target.id,
      kind: 'attack',
      payload: {
        action: action.name,
        roll: { ...rolled, total, natural },
        natural,
        advantage,
        target_ac: target.ac,
        effective_ac: effectiveAc,
        cover: cover.cover,
        hit,
        critical,
        distance_ft: distance,
        notes: swingNotes,
        ...(input.grip ? { grip: input.grip } : {}),
        ...(helpless && hit ? { auto_crit: true } : {}),
        ...(reaction ? { out_of_turn: true, reason: reaction } : {}),
      },
      text: reactionText(
        reaction,
        `${attacker.name} attacks ${target.name} with ${action.name}: ${total} vs AC ${effectiveAc}${
          cover.cover === 'none' ? '' : ` (${cover.cover.replace('_', '-')} cover)`
        } - ${critical ? 'critical hit' : hit ? 'hit' : 'miss'}.${swingNotes.length ? ` (${swingNotes.join('; ')})` : ''}`,
      ),
    }),
  ];

  const damage: Array<DamageResult & { type: string | null; expr: string; output: string }> = [];
  // Colossus Slayer asks whether the target was already wounded, which means before this swing landed.
  const targetHpBefore = target.hp_current;

  // Every part of the swing is rolled before any of it lands. Uncanny Dodge halves the attack's damage
  // and Deflect Attacks reduces the attack's total damage, which means the riders too, so the total has
  // to exist first; what the stance takes off comes out of the parts in order, weapon damage before riders.
  const dealt: Array<{ type: string | null; amount: number; expr: string; output: string }> = [];
  if (hit) {
    for (const part of damageParts) {
      const damageExpr = critical ? criticalExpr(part.dice) : part.dice;
      const rolledDamage = rollDamage(
        part.dice,
        critical,
        await askPlayer(db, encounter, attacker, 'damage', {
          tool: 'attack',
          expr: damageExpr,
          purpose: `Damage: ${damageExpr}${part.type ? ` (${part.type})` : ''}`,
          roll_type: 'damage',
          target_id: target.id,
          ...(critical ? { dice_notes: [`Doubled on a critical hit: ${part.dice} becomes ${damageExpr}`] } : {}),
        }),
      );
      dealt.push({
        type: part.type,
        amount: rolledDamage.total + greatWeaponBonus(sheet, weapon, melee, input.grip, rolledDamage.dice),
        expr: rolledDamage.expr,
        output: rolledDamage.output,
      });
    }
  }

  // What the attacker's own features add: Sneak Attack, Rage Damage, Stunning Strike, a smite - and what
  // a miss still leaves behind, which nothing martial uses yet and R4b's Graze-like features will.
  const riderAsk = {
    actor: attacker,
    target,
    action,
    weapon,
    ability,
    melee,
    distance_ft: distance,
    combatants,
    effects,
    options,
    advantage,
    critical,
    damage_type: damageParts[0]?.type ?? null,
    target_hp_before: targetHpBefore,
    roll: { natural, total, dc: effectiveAc, success: hit },
  };
  const riders = sheet ? (hit ? hitRiders(sheet, riderAsk) : missRiders(sheet, riderAsk)) : [];
  let marked: Extract<HitRider, { kind: 'damage' }> | null = null;
  if (hit && sheet && weapon) {
    const rider = huntersMarkRider(effects, attacker, target, sheet);
    if (rider?.kind === 'damage') {
      marked = rider;
      riders.push(rider);
    }
  }
  const riderRolls = await rollRiderDamage(db, encounter, attacker, target, riders, critical, 'attack');
  // A negative flat rider comes off the parts it rides on before any of them lands, and is dropped from
  // what applyHitRiders will apply; a positive rider is unchanged.
  const foldedRiders = foldNegativeRiders(db, encounter, attacker, target, dealt, riderRolls);
  log.push(...foldedRiders.log);
  // A folded rider fired, so its use is still spent even though its damage never lands on its own.
  if (sheet) {
    for (const rider of foldedRiders.folded) {
      if (rider.spend) log.push(spendFeatureCost(db, encounter, attacker, sheet, rider.spend, rider.feature));
    }
  }
  const ridersToApply = riders.filter((rider) => !foldedRiders.folded.has(rider));

  // Uncanny Dodge and Deflect Attacks are declared ahead of the blow, and come off its whole damage.
  const mitigation = hit ? mitigateHit(db, encounter, target, damageParts[0]?.type ?? null) : null;
  let redirect: { attacker_id: number; within_ft: number } | null = null;
  if (mitigation) {
    log.push(...mitigation.log);
    const total =
      dealt.reduce((sum, part) => sum + part.amount, 0) +
      [...riderRolls.values()].reduce((sum, rolled) => sum + rolled.total, 0);
    const kept = Math.max(0, (mitigation.halve ? Math.floor(total / 2) : total) - mitigation.reduce);
    let loss = total - kept;
    for (const part of dealt) {
      const off = Math.min(loss, part.amount);
      part.amount -= off;
      loss -= off;
    }
    for (const [rider, rolled] of riderRolls) {
      const off = Math.min(loss, rolled.total);
      riderRolls.set(rider, { ...rolled, total: rolled.total - off });
      loss -= off;
    }
    // A Deflect Attacks that takes the blow to nothing may throw the force back for a Focus Point.
    if (mitigation.reduce > 0 && kept === 0) {
      // A melee attack is thrown back within 5 ft, a ranged one at anything within 60 ft.
      redirect = { attacker_id: attacker.id, within_ft: melee ? 5 : 60 };
      const braced = getCombatant(db, encounter.id, target.id);
      braced.flags = {
        ...braced.flags,
        deflect_redirect: { ...redirect, damage_type: damageParts[0]?.type ?? null },
      };
      saveCombatant(db, braced);
      target.flags = braced.flags;
    }
  }

  // Boon of Irresistible Offense: physical damage this character deals is never halved by Resistance.
  const irresistible = sheet ? irresistibleOffense(sheet) : null;
  const overcomes = (type: string | null): boolean =>
    irresistible !== null && type !== null && ['bludgeoning', 'piercing', 'slashing'].includes(type.toLowerCase());
  // Overwhelming Strike: a natural 20 also deals damage equal to the score the boon raised.
  if (hit && natural === 20 && irresistible && dealt.length > 0) {
    dealt.push({
      type: dealt[0]!.type,
      amount: irresistible.score,
      expr: String(irresistible.score),
      output: `${irresistible.score} (Overwhelming Strike, your ${irresistible.ability.toUpperCase()} score)`,
    });
  }
  // Every part of one hit and every rider it carries are one instance of damage, so they owe one
  // concentration save between them, against the damage they add up to.
  let instanceDamage = 0;
  for (const part of dealt) {
    // The dead are not killed twice: a blow with more than one part logs one kill, not one per part.
    const wasAlive = target.alive;
    const result = damageCombatant(db, encounter, target, {
      amount: part.amount,
      type: part.type,
      source: `${attacker.name}'s ${action.name}`,
      critical,
      ...(overcomes(part.type) ? { ignore_resistance: true } : {}),
      ...(input.knock_out ? { knock_out: true } : {}),
    });
    damage.push({ ...result, type: part.type, expr: part.expr, output: part.output });
    instanceDamage += result.applied;
    log.push(
      logCombat(db, encounter, {
        actor_id: attacker.id,
        target_id: target.id,
        kind: 'damage',
        payload: { action: action.name, ...result, type: part.type, expr: part.expr },
        text: `${target.name} takes ${result.applied} ${part.type ?? ''} damage (${part.output}${
          result.resistance ? `, ${result.resistance}` : ''
        })${partyHp(target, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
      }),
    );
    if (wasAlive && result.dead) log.push(...afterKill(db, encounter, target, attacker, `${attacker.name}'s ${action.name}`));
  }

  let featureEffects: Array<Record<string, unknown>> = [];
  if (sheet && ridersToApply.length > 0) {
    const resolved = await applyHitRiders(db, encounter, attacker, target, sheet, ridersToApply, riderRolls, critical, true);
    log.push(...resolved.log);
    featureEffects = resolved.applied;
    instanceDamage += resolved.damage;
  }
  // A miss that dealt nothing calls nothing: only a landed blow or damage a rider landed on a miss
  // owes the concentration save.
  if (hit || instanceDamage > 0) log.push(...(await afterDamage(db, encounter, target, instanceDamage, 'attack')));
  // Relentless Rage can stand a Barbarian back up inside afterDamage, so a drop to 0 is read from the
  // row as it now stands: a blow whose 0 HP was undone is no drop and triggers nothing keyed to one.
  if (targetHpBefore > 0 && isDowned(db, encounter, target.id)) {
    log.push(
      logCombat(db, encounter, {
        target_id: target.id,
        kind: 'downed',
        payload: { name: target.name },
        text: `${target.name} drops to 0 HP and falls unconscious.`,
      }),
      ...droppedToZero(db, encounter, target, attacker),
    );
  }

  // Superior Hunter's Prey: once a turn, the Hunter's Mark damage also lands on a creature beside the marked one.
  if (marked && sheet && hasFeature(sheet, 'hunter-superior-hunters-prey') && !attacker.flags.superior_prey_used) {
    const second = input.prey_target_id === undefined ? null : getCombatant(db, encounter.id, input.prey_target_id);
    if (second && second.id !== target.id) {
      const away = distanceBetween(target, second);
      if (away > 30) {
        throw new Error(
          `Superior Hunter's Prey reaches a creature within 30 ft of ${target.name}, and ${second.name} is ${away} ft away.`,
        );
      }
      const rolled = rollDamage(marked.dice, false);
      const result = damageCombatant(db, encounter, second, {
        amount: rolled.total,
        type: 'force',
        source: `${attacker.name}'s Superior Hunter's Prey`,
      });
      attacker.flags = { ...attacker.flags, superior_prey_used: true };
      saveCombatant(db, attacker);
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          target_id: second.id,
          kind: 'feature_damage',
          payload: { feature: "Superior Hunter's Prey", ...result, type: 'force', expr: rolled.expr },
          text: `Superior Hunter's Prey: the mark's power leaps to ${second.name} for ${result.applied} force damage (${rolled.output})${partyHp(second, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
        }),
      );
      log.push(...(await afterDamage(db, encounter, second, result.applied, 'attack')));
      if (result.dead) log.push(...afterKill(db, encounter, second, attacker, `${attacker.name}'s Superior Hunter's Prey`));
      else if (isDowned(db, encounter, second.id)) log.push(...droppedToZero(db, encounter, second, attacker));
    } else if (!second) {
      log.push(
        logCombat(db, encounter, {
          actor_id: attacker.id,
          kind: 'feature_note',
          payload: { feature: "Superior Hunter's Prey" },
          text: `Superior Hunter's Prey: the mark's extra damage may also land on a creature within 30 ft of ${target.name} - name it with attack {prey_target_id}.`,
        }),
      );
    }
  }

  // The cleave swing spends the turn's one cleave before mastery resolves, so it offers no second one.
  if (cleaving) attacker.flags = { ...attacker.flags, cleaved: true, cleave_ready: undefined };
  let masteryEffect: MasteryEffect | null = null;
  if (mastery) {
    const resolved = await resolveMastery(db, encounter, attacker, target, {
      mastery,
      action,
      ability_mod: abilityMod,
      damage_type: damageParts[0]?.type ?? null,
      hit,
      damage_dealt: damage.reduce((sum, d) => sum + d.applied, 0),
      melee,
      reach_ft: melee ? (action.reach_ft ?? 5) : 0,
      ...(input.no_push ? { no_push: true } : {}),
    });
    masteryEffect = resolved.effect;
    log.push(...resolved.log);
  }

  if (input.flurry) {
    attacker.flags = { ...attacker.flags, flurry_strikes: Math.max(0, (attacker.flags.flurry_strikes ?? 1) - 1) };
  }
  if (!free) {
    if (!input.out_of_turn && action.kind !== 'bonus_action') {
      attacker.flags = { ...attacker.flags, attacks_used: (attacker.flags.attacks_used ?? 0) + 1 };
    }
    spendResource(attacker, action.kind === 'bonus_action' ? 'bonus' : 'action', input.out_of_turn);
  }
  // An attack roll against an enemy is one of the three things that keep a Rage going another round.
  extendRage(db, encounter, attacker);
  // Dropping a creature may have paid the attacker in temporary hit points: keep what the row says.
  refreshVitals(db, encounter, attacker);
  saveCombatant(db, attacker);

  const after = getCombatant(db, encounter.id, target.id);
  const afterSheet = sheetOf(db, after);
  const damageTaken = damage.reduce((sum, d) => sum + d.applied, 0);
  const damageOutcomes = hit && afterSheet && after.alive && damageTaken > 0
    ? damageTakenOutcomes(afterSheet, {
        actor: after, attacker, damage: damageTaken, damage_type: damageParts[0]?.type ?? null, distance_ft: distance,
      })
    : [];
  for (const outcome of damageOutcomes) log.push(...applyOutcome(db, encounter, after, afterSheet!, outcome));
  // What is still on offer after everything this call spent; the sheet has followed every spend.
  const leftToSpend = sheet ? boostsFor(sheet, sheet.features, boostCtx, ATTACK_HOOKS) : [];
  // The reactions the one who was hit may still take; a stance is declared before the next blow lands.
  const reactions: ReactionOffer[] =
    hit && afterSheet && after.alive && after.hp_current > 0
      ? reactionOffers(afterSheet, {
          actor: after,
          attacker,
          damage: damage.reduce((sum, d) => sum + d.applied, 0),
          damage_type: damageParts[0]?.type ?? null,
          distance_ft: distance,
        })
      : [];
  // Cutting Words is taken by a bard watching, not by the one who was hit, so its offer is found here.
  reactions.push(...cuttingWordsOffers(db, encounter, attacker));
  return finish(db, encounter, 'attack', `${attacker.name} attacks ${target.name}.`, log, {
    attacker_id: attacker.id,
    target_id: target.id,
    action: action.name,
    roll: { ...rolled, total, natural },
    advantage,
    cover: cover.cover,
    effective_ac: effectiveAc,
    hit,
    critical,
    damage,
    notes: swingNotes,
    ...(cut ? { cutting_words: cut.amount } : {}),
    ...(inspired ? { bardic_inspiration_spent: inspired } : {}),
    ...(!inspired && heldDie !== null && !hit
      ? {
          bardic_inspiration_available: {
            die: heldDie,
            hint: `${attacker.name} is holding a d${heldDie} of Bardic Inspiration: pass inspiration true on the next attack and it is added when the swing would otherwise miss.`,
          },
        }
      : {}),
    attacks_used: attacker.flags.attacks_used ?? 0,
    attacks_per_action: swings,
    total_damage: damage.reduce((sum, d) => sum + d.applied, 0),
    target_hp: { current: after.hp_current, max: after.hp_max, alive: after.alive },
    ...(masteryEffect ? { mastery: masteryEffect } : {}),
    ...(masteryEffect?.cleave_targets ? { cleave_available: { targets: masteryEffect.cleave_targets } } : {}),
    ...(cleaving ? { cleave_from: input.cleave_from } : {}),
    ...(featureEffects.length ? { features: featureEffects } : {}),
    ...(remindersOf(featureEffects).length ? { reminders: remindersOf(featureEffects) } : {}),
    ...(leftToSpend.length ? { boosts_available: leftToSpend } : {}),
    ...(reactions.length ? { reactions_available: reactions } : {}),
    ...(attacker.flags.smite_ready ? { smite_ready: attacker.flags.smite_ready } : {}),
    ...(redirect
      ? {
          deflect_redirect_available: {
            ...redirect,
            hint: `${after.name} took the blow to 0 and may spend 1 Focus Point to throw the force back: use_action {action_name: "deflect_redirect", target_id, out_of_turn: true, reason: "Deflect Attacks"} before the next turn.`,
          },
        }
      : {}),
    ...(attacker.flags.flurry_strikes ? { flurry_strikes_left: attacker.flags.flurry_strikes } : {}),
    ...(sheet ? { class_features: classFeatures(sheet, attacker) } : {}),
    ...(reaction ? { out_of_turn: true, reason: reaction } : {}),
  });
}

/** A class feature with an action of its own: Rage, Second Wind, Flurry of Blows, Lay On Hands. */
async function runFeatureActionCall(
  db: Db,
  encounter: EncounterRow,
  actor: Combatant,
  sheet: CombatSheet,
  found: { handler: FeatureHandler; action: FeatureAction; option?: string },
  input: {
    target_id?: number;
    amount?: number;
    option?: string;
    slot_level?: number;
    point?: Point;
    rolls?: Record<string, PreRoll>;
    roll?: PreRoll;
    advantage?: Advantage;
    out_of_turn?: boolean;
    reason?: string;
  } & StandardActionInput,
  reaction: string | null,
) {
  const { handler, action } = found;
  // A homebrew clause that is out of uses is off the legal-actions list; naming it anyway is refused by
  // name, the way a class resource is, rather than resolving to a no-op that hides the reason.
  if (handler.index.startsWith('homebrew:') && action.cost) requireResource(sheet, actor, action.cost, action.name);
  const combatants = listCombatants(db, encounter.id);
  const target = input.target_id === undefined ? null : getCombatant(db, encounter.id, input.target_id);
  // Rage is entered once and extended after that, so a second use spends nothing.
  const extending = handler.index === 'barbarian-rage' && isRaging(actor);
  const outcome: FeatureOutcome = extending
    ? {
        economy: 'bonus_action',
        text: `${actor.name} keeps the Rage going for another round.`,
        flags: { raging: { ...actor.flags.raging!, extended_round: encounter.round } },
      }
    : handler.resolve!({
        sheet,
        actor,
        feature: sheet.features.find((f) => f.name === handler.name) ?? { name: handler.name },
        target,
        combatants,
        round: encounter.round,
        action_id: action.id,
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        ...(input.slot_level === undefined ? {} : { slot_level: input.slot_level }),
        ...(input.point === undefined ? {} : { point: input.point }),
        ...(found.option ?? input.option ? { option: found.option ?? input.option! } : {}),
      });

  if (outcome.action_effect) {
    return runGenericUseAction(db, {
      campaign_id: encounter.campaign_id,
      actor_id: actor.id,
      action_name: action.name,
      ...(input.target_id === undefined ? {} : { target_id: input.target_id }),
      ...(input.point === undefined ? {} : { point: input.point }),
      ...(input.rolls === undefined ? {} : { rolls: input.rolls }),
      ...(input.roll === undefined ? {} : { roll: input.roll }),
      ...(input.advantage === undefined ? {} : { advantage: input.advantage }),
      ...(input.out_of_turn === undefined ? {} : { out_of_turn: input.out_of_turn }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      _feature_effect: { outcome, handler, action },
    }, encounter, actor, sheet, reaction, undefined);
  }

  // Nothing is written before the refusals: the economy first, then the resource.
  if (outcome.economy === 'action' || outcome.economy === 'bonus_action') {
    if (!input.out_of_turn) requireEconomy(actor, outcome.economy === 'bonus_action' ? 'bonus' : 'action', action.name);
  }
  if (outcome.economy === 'reaction' && actor.reaction_used) {
    throw new Error(
      `${actor.name} has already used their reaction this round, so ${action.name} has to wait for their next turn.`,
    );
  }
  const costs = outcome.spend ? (Array.isArray(outcome.spend) ? outcome.spend : [outcome.spend]) : [];
  for (const cost of costs) requireResource(sheet, actor, cost, action.name);
  // A stance spends nothing here: the refusal happens now so the declaration cannot promise what is gone.
  if (outcome.d20_stance?.spend) requireResource(sheet, actor, outcome.d20_stance.spend, action.name);
  // A spell slot the feature burns is refused before anything is written, as a resource is.
  if (outcome.spend_slot !== undefined) requireSlot(sheet, actor, outcome.spend_slot, action.name);
  // And one it creates: Font of Magic and Wild Resurgence pay only once the slot is certain to appear.
  if (outcome.gain_slot !== undefined) requireSlotLevel(sheet, actor, outcome.gain_slot, action.name);
  // The Beast is looked up before the use is spent, so a form this Druid cannot take costs nothing.
  const shape = outcome.shape && 'form' in outcome.shape ? beastForm(outcome.shape.form, outcome.shape) : null;

  const log: CombatLogEntry[] = [];
  // A Rage holds no Concentration: entering one drops whatever the Barbarian was holding.
  if (handler.index === 'barbarian-rage' && !extending && actor.concentration) {
    log.push(...endConcentration(db, encounter, actor, `${actor.name} rages and cannot concentrate`));
  }
  for (const cost of costs) log.push(spendFeatureCost(db, encounter, actor, sheet, cost, action.name));
  if (outcome.d20_stance) {
    actor.flags = { ...actor.flags, d20_stance: outcome.d20_stance };
    saveCombatant(db, actor);
  }
  if (outcome.flags) {
    actor.flags = { ...actor.flags, ...outcome.flags };
    // Action Surge buys a whole second action, Extra Attack and all - but never the Magic action.
    if (outcome.flags.action_surged) {
      actor.action_used = false;
      actor.flags = { ...actor.flags, attacks_used: 0, surge_action_pending: true };
    }
    saveCombatant(db, actor);
  }
  const data: StandardActionData & Record<string, unknown> = { feature: handler.index, action: action.id };
  if (outcome.d20_stance) data.d20_stance = outcome.d20_stance;

  for (const id of outcome.standard ?? []) {
    const done = await standardAction(db, encounter, actor, id, input);
    log.push(...done.log);
    Object.assign(data, done.data);
  }
  if (outcome.movement_ft) {
    actor.movement_left += outcome.movement_ft;
    saveCombatant(db, actor);
    data.movement_left = actor.movement_left;
  }
  // Steady Aim buys its Advantage with the rest of the turn's movement.
  if (handler.index === 'rogue-steady-aim') {
    actor.movement_left = 0;
    saveCombatant(db, actor);
    data.movement_left = 0;
  }
  // The same row twice would let the stale actor overwrite the healing, so healing the self heals actor.
  const healed = target && target.id !== actor.id ? target : actor;
  const heal = outcome.heal_amount ?? (outcome.heal_expr ? rollHealing(outcome.heal_expr, sheet).total : 0);
  if (heal > 0) {
    healCombatant(db, encounter, healed, Math.max(1, heal));
    const after = getCombatant(db, encounter.id, healed.id);
    data.healed = Math.max(1, heal);
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: healed.id,
        kind: 'heal',
        payload: { action: action.name, amount: Math.max(1, heal), hp_current: after.hp_current },
        text: `${healed.name} regains ${Math.max(1, heal)} HP${partyHp(healed, ` (${after.hp_current}/${after.hp_max})`)}.`,
      }),
    );
  }
  if (outcome.temp_hp_expr && healed.character_id) {
    const rolled = rollDamage(outcome.temp_hp_expr, false);
    setPcTempHp(db, {
      campaign_id: encounter.campaign_id,
      character_id: healed.character_id,
      amount: rolled.total,
      mirror: false,
    });
    mirrorCharacter(db, healed);
    saveCombatant(db, healed);
    data.temp_hp = rolled.total;
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: healed.id,
        kind: 'temp_hp',
        payload: { action: action.name, amount: rolled.total },
        text: `${healed.name} gains ${rolled.total} temporary hit points (${rolled.output}).`,
      }),
    );
  }
  for (const condition of outcome.remove_conditions ?? []) {
    if (!healed.conditions.includes(condition)) continue;
    dropCondition(db, encounter, healed, condition);
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: healed.id,
        kind: 'condition',
        payload: { condition, active: false, feature: handler.name },
        text: `${healed.name} is no longer ${condition} (${handler.name}).`,
      }),
    );
  }
  // A condition the feature puts on its taker, for the rounds its own text gives it: Nature's Veil.
  if (outcome.self_condition) {
    const created = attachEffect(db, encounter, {
      name: outcome.self_condition.name,
      kind: 'condition',
      source_id: actor.id,
      tick: 'end',
      ends: 'rounds',
      remaining_rounds: outcome.self_condition.rounds,
      target_id: actor.id,
    });
    actor.conditions = getCombatant(db, encounter.id, actor.id).conditions;
    log.push(created.entry, ...created.landed);
  }
  // The slot a feature burns and the one it hands back: Font of Magic, Font of Inspiration, Wild Resurgence.
  if (outcome.spend_slot !== undefined && actor.character_id) {
    const spent = useSpellSlot(db, {
      campaign_id: encounter.campaign_id,
      character_id: actor.character_id,
      level: outcome.spend_slot,
    });
    data.spell_slots = spent.spell_slots;
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        kind: 'spell_slot',
        payload: { feature: handler.name, level: outcome.spend_slot, remaining: spent.remaining },
        text: `${actor.name} burns a level ${outcome.spend_slot} slot on ${action.name} (${spent.remaining} left at that level).`,
      }),
    );
  }
  if (outcome.gain_slot !== undefined && actor.character_id) {
    const back = restoreSpellSlot(db, {
      campaign_id: encounter.campaign_id,
      character_id: actor.character_id,
      level: outcome.gain_slot,
    });
    data.spell_slots = back.spell_slots;
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        kind: 'spell_slot',
        payload: { feature: handler.name, level: outcome.gain_slot, remaining: back.remaining, gained: true },
        text: `${actor.name} gains a level ${outcome.gain_slot} spell slot (${back.remaining} open at that level).`,
      }),
    );
  }
  // Uses handed back to another class resource: Font of Inspiration, Wild Resurgence.
  if (outcome.restore_resource && actor.character_id) {
    const back = restoreFeatureResource(db, {
      campaign_id: encounter.campaign_id,
      character_id: actor.character_id,
      resource: outcome.restore_resource.key,
      amount: outcome.restore_resource.amount,
    });
    if (back) {
      data.resource = { resource: back.resource, left: back.left, max: back.max };
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          kind: 'feature_resource',
          payload: { feature: handler.name, resource: back.resource, left: back.left, max: back.max },
          text: `${actor.name} gets ${outcome.restore_resource.amount} ${back.name} back: ${back.left} of ${back.max}.`,
        }),
      );
    }
  }
  // Wild Shape: into the Beast's own statistics, or back out of them.
  if (shape) {
    enterWildShape(db, encounter, actor, sheet, shape);
    data.wild_shape = { form: shape.name, ac: shape.ac, speed: shape.speed, attacks: shape.actions.map((a) => a.name) };
  }
  if (outcome.shape && 'revert' in outcome.shape) {
    log.push(...revertWildShape(db, encounter, actor, 'they drop it as a Bonus Action'));
    data.wild_shape = null;
  }
  if (outcome.temp_hp_amount !== undefined && actor.character_id) {
    setPcTempHp(db, {
      campaign_id: encounter.campaign_id,
      character_id: actor.character_id,
      amount: outcome.temp_hp_amount,
      mirror: false,
    });
    mirrorCharacter(db, actor);
    saveCombatant(db, actor);
    data.temp_hp = outcome.temp_hp_amount;
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        kind: 'temp_hp',
        payload: { action: action.name, amount: outcome.temp_hp_amount },
        text: `${actor.name} gains ${outcome.temp_hp_amount} temporary hit points.`,
      }),
    );
  }
  // A Bardic Inspiration die is held on the sheet of whoever was inspired, not on the bard's.
  if (outcome.inspire) {
    const held = grantInspirationDie(db, {
      campaign_id: encounter.campaign_id,
      character_id: getCombatant(db, encounter.id, outcome.inspire.target_id).character_id!,
      die: outcome.inspire.die,
      from: actor.name,
    });
    data.inspiration_die = held;
  }
  if (outcome.target_flags && target) {
    const on = getCombatant(db, encounter.id, target.id);
    on.flags = { ...on.flags, ...outcome.target_flags };
    saveCombatant(db, on);
    target.flags = on.flags;
  }
  // Hit points poured into named creatures: Preserve Life, Land's Aid, Divine Spark.
  const healedRows: Array<Record<string, unknown>> = [];
  for (const pour of outcome.heals ?? []) {
    const who = getCombatant(db, encounter.id, pour.target_id);
    const rolled = pour.expr ? rollHealing(pour.expr, sheet) : null;
    const amount = Math.max(0, pour.amount ?? rolled?.total ?? 0);
    if (amount <= 0) continue;
    healCombatant(db, encounter, who, amount);
    const after = getCombatant(db, encounter.id, who.id);
    healedRows.push({ target_id: who.id, name: who.name, healed: amount, hp_current: after.hp_current });
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: who.id,
        kind: 'heal',
        payload: { action: action.name, amount, hp_current: after.hp_current },
        text: `${who.name} regains ${amount} HP${rolled ? ` (${rolled.output})` : ''}${partyHp(who, ` (${after.hp_current}/${after.hp_max})`)}.`,
      }),
    );
  }
  if (healedRows.length) data.healed_targets = healedRows;
  // The saving throw a feature's action forces: Divine Spark, Turn Undead, Land's Aid.
  const saveRows: Array<Record<string, unknown>> = [];
  for (const id of outcome.save?.target_ids ?? []) {
    const forced = outcome.save!;
    const who = getCombatant(db, encounter.id, id);
    const save = await rollSave(db, encounter, who, forced.ability, forced.dc, {
      roll: input.rolls?.[String(id)],
      tool: 'use_action',
    });
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: who.id,
        kind: 'save',
        payload: { action: action.name, save },
        text: `${who.name} rolls ${save.total} on a ${forced.ability.toUpperCase()} save vs DC ${forced.dc}: ${
          save.success ? 'success' : 'failure'
        }.`,
      }),
    );
    const row: Record<string, unknown> = { target_id: who.id, name: who.name, save };
    if (forced.damage_expr && (!save.success || forced.half_on_save)) {
      const rolled = rollDamage(forced.damage_expr, false);
      const amount = save.success ? Math.floor(rolled.total / 2) : rolled.total;
      const result = damageCombatant(db, encounter, who, {
        amount,
        type: forced.damage_type ?? null,
        source: `${actor.name}'s ${action.name}`,
      });
      row.damage = result;
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: who.id,
          kind: 'damage',
          payload: { action: action.name, ...result, type: forced.damage_type ?? null, expr: rolled.expr },
          text: `${who.name} takes ${result.applied} ${forced.damage_type ?? ''} damage (${rolled.output})${partyHp(who, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
        }),
      );
      log.push(...(await afterDamage(db, encounter, who, result.applied, 'use_action')));
      if (result.dead) log.push(...afterKill(db, encounter, who, actor, `${actor.name}'s ${action.name}`));
    }
    if (!save.success && forced.extra_expr) {
      const rolled = rollDamage(forced.extra_expr, false);
      const result = damageCombatant(db, encounter, who, {
        amount: rolled.total,
        type: forced.extra_type ?? null,
        source: `${actor.name}'s ${forced.extra_note ?? action.name}`,
      });
      row.extra_damage = result;
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: who.id,
          kind: 'feature_damage',
          payload: { feature: forced.extra_note ?? action.name, ...result, type: forced.extra_type ?? null, expr: rolled.expr },
          text: `${forced.extra_note ?? action.name}: ${who.name} takes ${result.applied} ${forced.extra_type ?? ''} damage (${rolled.output})${partyHp(who, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
        }),
      );
      if (result.dead) log.push(...afterKill(db, encounter, who, actor, `${actor.name}'s ${forced.extra_note ?? action.name}`));
    }
    if (!save.success) {
      const laid: number[] = [];
      for (const condition of forced.conditions ?? []) {
        const immune = immuneTo(db, encounter, who, condition);
        if (immune) {
          log.push(
            logCombat(db, encounter, {
              actor_id: actor.id,
              target_id: who.id,
              kind: 'note',
              payload: { condition, immune: true },
              text: `${immune} ${action.name} leaves no ${condition} on it.`,
            }),
          );
          continue;
        }
        const created = attachEffect(db, encounter, {
          name: condition,
          kind: 'condition',
          source_id: actor.id,
          tick: 'end',
          // A minute is a minute: Turn Undead's own text gives no repeat save, only the end on damage.
          // Intimidating Presence and its like say otherwise, and ask for the save at each turn's end.
          ...(forced.ends === 'minute'
            ? forced.repeat_save
              ? {
                  ends: 'save' as const,
                  save_ability: forced.ability,
                  save_dc: forced.dc,
                  remaining_rounds: 10,
                }
              : { ends: 'rounds' as const, remaining_rounds: 10 }
            : forced.ends === 'start_of_next_turn'
              ? { tick: 'start' as const, ends: 'rounds' as const, remaining_rounds: 1 }
              : { ends: 'manual' as const }),
          target_id: who.id,
        });
        laid.push(created.effect.id);
        log.push(created.entry, ...created.landed);
      }
      if (forced.ends_on_damage && laid.length > 0) {
        const fresh = getCombatant(db, encounter.id, who.id);
        fresh.flags = { ...fresh.flags, turned: { effect_ids: laid, feature: action.name } };
        saveCombatant(db, fresh);
      }
    }
    saveRows.push(row);
  }
  if (saveRows.length) data.save_targets = saveRows;

  if (outcome.restore_focus && actor.character_id) {
    const back = restoreFeatureResource(db, {
      campaign_id: encounter.campaign_id,
      character_id: actor.character_id,
      resource: 'focus_points',
    });
    if (back) data.focus_points = back.max;
  }
  if (outcome.grant_inspiration && actor.kind === 'pc') {
    grantInspiration(db, { campaign_id: encounter.campaign_id, character_id: actor.character_id ?? undefined });
    data.inspiration = 1;
  }
  if (outcome.read_traits && target) {
    const lines = damageLinesOf(db, target);
    data.traits = {
      name: target.name,
      resistances: lines?.damage_resistances ?? '',
      immunities: lines?.damage_immunities ?? '',
      vulnerabilities: lines?.damage_vulnerabilities ?? '',
    };
  }

  log.push(
    logCombat(db, encounter, {
      actor_id: actor.id,
      ...(target ? { target_id: target.id } : {}),
      kind: 'feature_action',
      payload: { feature: handler.index, action: action.id, ...(outcome.notes ? { notes: outcome.notes } : {}) },
      text: reactionText(reaction, `${outcome.text}${outcome.notes?.length ? ` ${outcome.notes.join(' ')}` : ''}`),
    }),
  );

  if (outcome.economy === 'action' || outcome.economy === 'bonus_action') {
    spendResource(actor, outcome.economy === 'bonus_action' ? 'bonus' : 'action', input.out_of_turn);
  }
  if (outcome.economy === 'reaction') actor.reaction_used = true;
  // The feature may have healed or hurt its own taker: keep what the row says over what this object holds.
  refreshVitals(db, encounter, actor);
  saveCombatant(db, actor);

  return finish(db, encounter, 'use_action', `${actor.name} uses ${action.name}.`, log, {
    actor_id: actor.id,
    action: action.id,
    targets: [] as Array<Record<string, unknown>>,
    ...data,
    ...(outcome.notes ? { notes: outcome.notes } : {}),
    class_features: classFeatures(sheet, getCombatant(db, encounter.id, actor.id)),
    ...(reaction ? { out_of_turn: true, reason: reaction } : {}),
  });
}

/**
 * Deflect Attacks, second half: a hit the Monk took to 0 may have its force thrown back for 1 Focus
 * Point. It is part of the reaction the deflection already spent, so it asks for no second one.
 */
async function runDeflectRedirect(
  db: Db,
  encounter: EncounterRow,
  actor: Combatant,
  sheet: CombatSheet | null,
  input: { target_id?: number; roll?: PreRoll },
) {
  if (!sheet || !hasFeature(sheet, 'monk-deflect-attacks')) {
    throw new Error(`${actor.name} has no Deflect Attacks, so there is nothing to redirect.`);
  }
  const window = actor.flags.deflect_redirect;
  if (!window) {
    throw new Error(
      `${actor.name} has no deflected attack to throw back: the redirect is offered under Offers on a hit Deflect Attacks took to 0, and only until the next turn.`,
    );
  }
  const cost: FeatureCost = { resource: 'focus_points', amount: 1 };
  requireResource(sheet, actor, cost, 'the Deflect Attacks redirect');
  const target = getCombatant(db, encounter.id, input.target_id ?? window.attacker_id);
  if (!target.alive) throw new Error(`${target.name} is already dead.`);
  const away = distanceBetween(actor, target);
  if (away > window.within_ft) {
    throw new Error(
      `The deflected force reaches ${window.within_ft} ft and ${target.name} is ${away} ft away. Name a creature within ${window.within_ft} ft with target_id.`,
    );
  }
  // The redirect needs a creature the Monk can see: total cover is no line of sight at all.
  const seen = coverBetween(encounterMap(encounter), listCombatants(db, encounter.id), actor, target);
  if (!seen.line_of_sight) {
    throw new Error(
      `${target.name} has total cover from ${actor.name}, and the deflected force needs a creature you can see. Name another with target_id.`,
    );
  }
  const dc = 8 + sheetAbilityMod(sheet, 'wis') + sheet.proficiency_bonus;
  const expr = `2d${resourceMax(sheet, 'martial_arts_die')}${signed(sheetAbilityMod(sheet, 'dex'))}`;
  const log: CombatLogEntry[] = [spendFeatureCost(db, encounter, actor, sheet, cost, 'Deflect Attacks')];
  const save = await rollSave(db, encounter, target, 'dex', dc, { roll: input.roll, tool: 'use_action' });
  let damage: DamageResult | null = null;
  if (!save.success) {
    const rolled = rollDamage(expr, false);
    damage = damageCombatant(db, encounter, target, {
      amount: rolled.total,
      type: window.damage_type,
      source: `${actor.name}'s Deflect Attacks`,
    });
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: target.id,
        kind: 'feature_damage',
        payload: { feature: 'Deflect Attacks', ...damage, type: window.damage_type, expr: rolled.expr, save },
        text: `${actor.name} throws the deflected force at ${target.name}, who fails a DEX save (${save.total} vs DC ${dc}) and takes ${damage.applied} (${rolled.output})${partyHp(target, ` - ${damage.hp_current}/${damage.hp_max} HP`)}.`,
      }),
    );
    log.push(...(await afterDamage(db, encounter, target, damage.applied, 'use_action')));
    if (damage.dead) log.push(killEntry(db, encounter, target, `${actor.name}'s Deflect Attacks`));
  } else {
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        target_id: target.id,
        kind: 'feature_save',
        payload: { feature: 'Deflect Attacks', save, applied: false },
        text: `${target.name} slips the deflected force (DEX save ${save.total} vs DC ${dc}).`,
      }),
    );
  }
  actor.flags = { ...actor.flags, deflect_redirect: undefined };
  saveCombatant(db, actor);
  return finish(db, encounter, 'use_action', `${actor.name} redirects a deflected attack.`, log, {
    actor_id: actor.id,
    action: 'deflect_redirect',
    targets: [{ target_id: target.id, name: target.name, save, damage }],
    class_features: classFeatures(sheet, getCombatant(db, encounter.id, actor.id)),
  });
}

export async function useAction(db: Db, input: Parameters<typeof runUseAction>[1]) {
  return underSnapshot(db, requireEncounter(db, input.campaign_id), 'use_action', () => runUseAction(db, input));
}

async function runUseAction(
  db: Db,
  input: {
    campaign_id: number;
    actor_id: number;
    action_name: string;
    target_id?: number;
    point?: Point;
    shape?: AoeShape;
    damage_expr?: string;
    damage_type?: string;
    save_ability?: Ability;
    save_dc?: number;
    half_on_save?: boolean;
    heal_expr?: string;
    concentration?: boolean;
    effect?: Omit<EffectInput, 'target_id'>;
    out_of_turn?: boolean;
    reason?: string;
    rolls?: Record<string, PreRoll>;
    /** The d20 for a spell attack roll, when the player rolled it themselves. */
    roll?: PreRoll;
    advantage?: Advantage;
    /** An SRD spell name: its dice, save, DC, area, range, concentration and duration are read from the entry. */
    spell?: string;
    /** The slot to cast it with; defaults to the spell's own level. */
    slot_level?: number;
    /** Lay On Hands: how many hit points to pour out of the pool. */
    amount?: number;
    /** Which of a feature's options to take: "poison" for Lay On Hands, the weapon for Sacred Weapon. */
    option?: string;
    /** Sorcerer: the Metamagic options this casting is bent with. */
    metamagic?: string[];
    /** Evoker: the creatures Sculpt Spells carves out of the evocation. */
    sculpt?: number[];
    /** Careful Spell: the creatures the caster protects from their own spell. */
    careful_targets?: number[];
    /** Twinned Spell: the second creature the spell reaches. */
    twin_target?: number;
    /** Heightened Spell: the creature that saves with Disadvantage. */
    heighten_target?: number;
    /** Transmuted Spell: the damage type the spell deals instead of its own. */
    transmute_to?: string;
    /** The feature paying for this casting instead of a spell slot. */
    free_cast?: NamedFreeCast;
    /** Evoker 14 Overchannel: a damaging Wizard spell of slot level 1 to 5 deals its maximum damage. */
    overchannel?: boolean;
    /** Homebrew clauses the actor chose for this action, by their boost id; each is spent up front. */
    boosts?: string[];
    /** Internal handoff: a feature action whose payload uses the shared custom-spell resolver below. */
    _feature_effect?: { outcome: FeatureOutcome; handler: FeatureHandler; action: FeatureAction };
  } & StandardActionInput,
) {
  const encounter = requireEncounter(db, input.campaign_id);
  const actor = getCombatant(db, encounter.id, input.actor_id);
  if (!actor.alive || actor.hp_current === 0) throw new Error(`${actor.name} is down and cannot act.`);
  refuseIfIncapacitated(actor);
  requireTurn(db, encounter, actor, input.out_of_turn);
  const sheet = sheetOf(db, actor);
  const wantedFeature = input.action_name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  // The Deflect Attacks redirect rides on the reaction already spent on the deflection, not on a new one.
  if (wantedFeature === 'deflect_redirect') return await runDeflectRedirect(db, encounter, actor, sheet, input);
  const reaction = requireReaction(actor, input.out_of_turn, input.reason);
  const known = actionsFor(actor, sheet).find((a) => a.name.toLowerCase() === input.action_name.trim().toLowerCase());
  // Dash, Dodge, Disengage, Help, Hide, Ready, Utilize, standing up, grappling, shoving and escaping.
  const standard = standardId(input.action_name);
  // A class feature with an action of its own comes first: rage, second_wind, flurry_of_blows, lay_on_hands.
  const feature = !input._feature_effect && !standard && sheet ? findFeatureAction(sheet, input.action_name) : null;
  if (feature && sheet) return await runFeatureActionCall(db, encounter, actor, sheet, feature, input, reaction);

  if (standard) {
    // Standing up costs half the speed as movement and no action, so it is legal after the Action is spent.
    const freeOfEconomy = standard === 'stand';
    if (!input.out_of_turn && !freeOfEconomy) {
      requireEconomy(actor, known?.kind === 'bonus_action' ? 'bonus' : 'action', input.action_name);
    }
    const released = releaseReady(db, encounter, actor, reaction);
    const done = await standardAction(db, encounter, actor, standard, input);
    // Standing up is movement, not the Action; out of turn it still costs the reaction.
    if (!freeOfEconomy || input.out_of_turn) spendResource(actor, 'action', input.out_of_turn);
    saveCombatant(db, actor);
    const entries = [...released, ...done.log];
    return finish(
      db,
      encounter,
      'use_action',
      `${actor.name} uses ${STANDARD_ACTIONS[standard]!.label}.`,
      entries,
      {
        actor_id: actor.id,
        action: standard,
        // The same shape a spell or an area answers with, so one caller reads both.
        targets: [] as Array<Record<string, unknown>>,
        ...(done.data as StandardActionData),
        ...(reaction ? { out_of_turn: true, reason: reaction } : {}),
      },
    );
  }

  return runGenericUseAction(db, input, encounter, actor, sheet, reaction, known);
}

async function runGenericUseAction(
  db: Db,
  input: Parameters<typeof runUseAction>[1],
  encounter: EncounterRow,
  actor: Combatant,
  sheet: CombatSheet | null,
  reaction: string | null,
  known: ReturnType<typeof actionsFor>[number] | undefined,
) {
  const wantedFeature = input.action_name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const combatants = listCombatants(db, encounter.id);
  const map = encounterMap(encounter);

  // A spell the DM wrote is executed from its own schema; anything the caller passed still wins.
  const declaredEffect = input._feature_effect?.outcome.action_effect;
  const custom = declaredEffect
    ? {
        kind: declaredEffect.effect.kind,
        ...(declaredEffect.effect.kind === 'attack' ? { attack_roll: true } : {}),
        ...(declaredEffect.effect.damage
          ? { damage_expr: declaredEffect.effect.damage.dice, damage_type: declaredEffect.effect.damage.type }
          : {}),
        ...(declaredEffect.effect.save_ability ? { save_ability: declaredEffect.effect.save_ability } : {}),
        ...(declaredEffect.effect.save_ability && sheet?.spells.save_dc !== null
          ? { save_dc: sheet?.spells.save_dc ?? undefined }
          : {}),
        ...(declaredEffect.effect.half_on_save === undefined
          ? {}
          : { half_on_save: declaredEffect.effect.half_on_save }),
        ...(declaredEffect.effect.shape ? { shape: declaredEffect.effect.shape } : {}),
        ...(declaredEffect.effect.healing ? { heal_expr: declaredEffect.effect.healing.dice } : {}),
        ...(declaredEffect.concentration ? { concentration: true } : {}),
        ...(declaredEffect.effect.targets === undefined ? {} : { targets: declaredEffect.effect.targets }),
        ...(declaredEffect.effect.condition
          ? {
              effect: {
                name: declaredEffect.effect.condition.name.trim().toLowerCase(),
                kind: 'condition' as const,
                tick: 'end' as const,
                ends: declaredEffect.concentration
                  ? ('concentration' as const)
                  : declaredEffect.duration_rounds
                    ? ('rounds' as const)
                    : ('manual' as const),
                ...(declaredEffect.duration_rounds ? { remaining_rounds: declaredEffect.duration_rounds } : {}),
              },
            }
          : {}),
      }
    : sheet
      ? customSpellAction(db, encounter.campaign_id, input.action_name, sheet.spells.save_dc)
      : null;
  const spell = input.spell && !custom ? spellFill(input.spell, sheet, input.slot_level) : null;
  if (input.spell && !spell && !custom) {
    throw new Error(
      `No SRD spell called "${input.spell}". Look it up with srd_lookup {kind: "spell"}, or pass the dice and the DC yourself.`,
    );
  }
  if (spell && sheet?.armor_penalty.penalty) {
    throw new Error(`${actor.name} cannot cast ${spell.name}: ${sheet.armor_penalty.reason}.`);
  }
  // A raging Barbarian casts nothing and concentrates on nothing, spell or hand-written action.
  if ((spell || custom || input.concentration) && isRaging(actor)) {
    throw new Error(
      `${actor.name} is raging and cannot cast spells or hold Concentration. End the Rage first, or do something else with the action.`,
    );
  }
  // A Druid in a Beast form casts nothing either, until Beast Spells at level 18 says otherwise.
  if ((spell || custom) && isWildShaped(actor) && !(sheet && hasFeature(sheet, 'druid-beast-spells'))) {
    throw new Error(
      `${actor.name} is in the ${actor.flags.wild_shape!.form} form and cannot cast spells. Drop the form first with use_action {action_name: "wild_shape_revert"}.`,
    );
  }
  // A name shaped like a class feature action, that this character cannot take, is refused rather than
  // narrated into being: the generic path below would spend the Action on nothing at all.
  const idShaped = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(input.action_name.trim());
  if (!known && !custom && !input.spell && (idShaped || allFeatureActionIds().includes(wantedFeature))) {
    const mine = sheet ? featureActionIds(sheet) : [];
    throw new Error(
      `${actor.name} has no class feature action called "${wantedFeature}". ${
        mine.length ? `They may take: ${mine.join(', ')}.` : 'They have no class feature actions at all.'
      } Anything else is named in words, with its own dice and DC.`,
    );
  }
  // What the casting costs: the spell's own casting time, or the entry's kind for everything else.
  const customCastingTime = custom
    ? input._feature_effect
      ? input._feature_effect.outcome.economy === 'bonus_action'
        ? 'bonus action'
        : input._feature_effect.outcome.economy === 'reaction'
          ? 'reaction'
          : 'action'
      : ((findHomebrewSpell(db, encounter.campaign_id, input.action_name)?.schema as { casting_time?: string } | undefined)
          ?.casting_time ?? 'action')
    : null;
  // Wild Companion and Pact of the Chain cast Find Familiar as a Magic action, its own hour notwithstanding.
  const freeCastEconomy = input.free_cast ? FREE_CAST_ECONOMY[input.free_cast] : undefined;
  if (spell && freeCastEconomy) spell.economy = freeCastEconomy;
  const casting: CastingEconomy | 'free' | null = input._feature_effect?.outcome.economy === 'free'
    ? 'free'
    : spell
    ? spell.economy
    : customCastingTime !== null
      ? castingEconomy(customCastingTime)
      : null;
  if (casting === 'long') {
    throw new Error(
      `${spell?.name ?? input.action_name} takes ${(spell?.casting_time ?? customCastingTime ?? '').replace(
        /^(\d+)/,
        '$1 ',
      )} to cast; not in a fight - package R8 will handle long casting times. Cast it between encounters.`,
    );
  }
  if (casting === 'reaction' && !input.out_of_turn) {
    throw new Error(
      `${spell?.name ?? input.action_name} is cast as a Reaction: pass out_of_turn true with reason naming what triggered it.`,
    );
  }
  // Divine Smite rides on the melee hit that has just landed, inside the same turn.
  const smiting = spell !== null && /^divine smite$/i.test(spell.name);
  if (smiting) {
    const ready = actor.flags.smite_ready;
    if (!ready) {
      throw new Error(
        `Divine Smite is cast after hitting with a melee weapon or an Unarmed Strike; ${actor.name} has not landed one this turn. Attack first, then smite the creature the hit's log names as ready.`,
      );
    }
    if (input.target_id !== undefined && input.target_id !== ready.target_id) {
      throw new Error(
        `Divine Smite lands on the creature just hit (combatant ${ready.target_id}), not on ${input.target_id}.`,
      );
    }
    input.target_id = ready.target_id;
  }
  // Divine Smite carries the criticality of the melee hit that armed it; every other cast reads its own roll.
  const smiteCritical = smiting && actor.flags.smite_ready?.critical === true;
  // Hunter's Mark marks its quarry; the extra 1d6 rides on every later weapon hit, not on the casting.
  const marking = spell !== null && /hunter.s mark/i.test(spell.name);
  if (marking && spell) {
    spell.attack_roll = false;
    spell.damage_expr = undefined;
  }
  let damageExpr = input.damage_expr ?? custom?.damage_expr ?? spell?.damage_expr ?? known?.damage?.[0]?.dice;
  const shape = input.shape ?? custom?.shape ?? spell?.shape;
  const healExpr = input.heal_expr ?? custom?.heal_expr ?? spell?.heal_expr;
  const concentration = input.concentration ?? custom?.concentration ?? spell?.concentration;

  // The targets come first now: Metamagic and Sculpt Spells name creatures, and what the casting costs
  // is settled only once the plan below has had its say.
  let targets: Combatant[];
  if (input.point && shape) {
    const point = input.point;
    const hit = aoeTargets(combatants, { x: actor.x, y: actor.y }, point, shape);
    targets = hit.map((t) => combatants.find((c) => c.id === t.id)!);
    // A healing area reaches only the caster's team, never an enemy standing in it. A text cap such as
    // "up to six creatures" keeps the nearest allies, ties by combatant id.
    if (healExpr !== undefined && !damageExpr) {
      targets = targets.filter((c) => c.team === actor.team);
      const cap = spell
        ? findSpell(spell.name)?.desc.match(/\bup to\s+(two|three|four|five|six|\d+)\s+creatures?\b/i)
        : null;
      const limit = cap ? (COUNT_WORDS[cap[1]!.toLowerCase()] ?? Number(cap[1])) : null;
      if (limit !== null && targets.length > limit) {
        const origin = shape.kind === 'cone' || shape.kind === 'line' ? { x: actor.x, y: actor.y } : point;
        const away = (c: Combatant): number => Math.hypot(c.x - origin.x, c.y - origin.y);
        targets = [...targets].sort((a, b) => away(a) - away(b) || a.id - b.id).slice(0, limit);
      }
    }
  } else if (input.target_id !== undefined) {
    targets = [getCombatant(db, encounter.id, input.target_id)];
  } else {
    targets = [];
  }
  if (custom) {
    if (shape && !input.point) throw new Error(`${input.action_name} has a ${shape.kind} area: pass point for its origin.`);
    if (input.point && !shape) throw new Error(`${input.action_name} has no area shape, so point cannot place it.`);
    const needsTarget = custom.kind !== 'utility' || custom.effect !== undefined;
    if (needsTarget && targets.length === 0) throw new Error(`${input.action_name} needs target_id${shape ? ' or point' : ''}.`);
    if (custom?.targets !== undefined && targets.length > custom.targets) {
      throw new Error(`${input.action_name} affects at most ${custom.targets} target${custom.targets === 1 ? '' : 's'}; this point reaches ${targets.length}.`);
    }
    if (declaredEffect && !shape && (custom.targets ?? 1) > 1) {
      throw new Error(`${input.action_name} names ${custom.targets} targets, but use_action accepts one target_id.`);
    }
    if (custom.kind === 'save' && !custom.save_ability) {
      throw new Error(`${input.action_name} is a save effect and needs save_ability.`);
    }
    if (custom.kind === 'save' && custom.save_dc === undefined) {
      throw new Error(`${actor.name} has no spell save DC for ${input.action_name}.`);
    }
    if (custom.kind === 'heal' && !custom.heal_expr) {
      throw new Error(`${input.action_name} is a healing effect and needs healing dice.`);
    }
    if (
      (custom.kind === 'attack' || custom.kind === 'auto') &&
      !custom.damage_expr &&
      !custom.effect
    ) {
      throw new Error(`${input.action_name} needs damage or a condition; use utility for one that does neither.`);
    }
  }

  const options: CastOptions = {
    metamagic: input.metamagic ?? [],
    ...(input.sculpt ? { sculpt: input.sculpt } : {}),
    ...(input.careful_targets ? { careful_targets: input.careful_targets } : {}),
    ...(input.twin_target === undefined ? {} : { twin_target: input.twin_target }),
    ...(input.heighten_target === undefined ? {} : { heighten_target: input.heighten_target }),
    ...(input.transmute_to ? { transmute_to: input.transmute_to } : {}),
  };
  if (options.metamagic.length > 0 || options.sculpt?.length) {
    if (!spell || !sheet) {
      throw new Error('Metamagic and Sculpt Spells shape an SRD spell: pass spell with its name.');
    }
  }
  if (sheet) requireMetamagic(sheet, actor, options.metamagic, input.damage_expr);
  const saveAbility = input.save_ability ?? custom?.save_ability ?? spell?.save_ability;
  // The casting's own moment, so a clause narrowed to an attack or to this spell is on offer here. It is
  // read, refused and marked before the plan: what the DM took is part of what the plan works out, and
  // the use it costs rides on the modifier, paid for with everything else the casting spends.
  const castBoostCtx: Omit<ClauseCtx, 'sheet'> = {
    source: spell ? 'spell' : undefined,
    ...(spell?.attack_roll && !saveAbility ? { kind: 'attack' as const } : {}),
    ...(targets[0] ? { target: targets[0] } : {}),
    ...(spell ? { spell: { name: spell.name, school: spell.school, level: spell.level } } : {}),
    ...(spell ? { melee: (spell.range_ft ?? 0) <= 5 } : {}),
  };
  // Read before they are paid for, so what the DM took is on the roll this casting makes.
  const castTaken = sheet
    ? boostsFor(sheet, sheet.features, castBoostCtx, CAST_HOOKS).filter((one) => (input.boosts ?? []).includes(one.id))
    : [];
  const castBoostLog = spendChosenBoosts(db, encounter, actor, sheet, input.boosts, castBoostCtx, CAST_HOOKS);
  const plan =
    spell && sheet
      ? planCast(sheet, actor, spell, targets, options, {
          save_dc: input.save_dc ?? custom?.save_dc ?? spell.save_dc,
          damage_type: input.damage_type ?? custom?.damage_type ?? spell.damage_type ?? null,
        })
      : null;
  // Twinned Spell casts the spell a level higher, which is what buys the second creature.
  if (plan && plan.slot_increase > 0 && spell) {
    if (spell.slot_level === null) {
      throw new Error(
        `${spell.name} is a cantrip, and Twinned Spell raises a spell's level with a slot: name a level 1+ spell.`,
      );
    }
    const higher = spellFill(spell.name, sheet, spell.slot_level + plan.slot_increase)!;
    spell.slot_level = higher.slot_level;
    spell.damage_expr = higher.damage_expr;
    spell.notes.push(...higher.notes.filter((note) => !spell.notes.includes(note)));
    damageExpr = input.damage_expr ?? higher.damage_expr ?? damageExpr;
  }
  for (const extra of plan?.extra_targets ?? []) {
    if (targets.some((t) => t.id === extra.id)) continue;
    const second = getCombatant(db, encounter.id, extra.id);
    const first = targets[0];
    if (extra.within_ft !== undefined && first) {
      const away = distanceBetween(first, second);
      if (away > extra.within_ft) {
        throw new Error(
          `${extra.feature} reaches a second creature within ${extra.within_ft} ft of ${first.name}, and ${second.name} is ${away} ft away.`,
        );
      }
    }
    targets.push(second);
  }
  if (plan && spell && plan.duration_multiplier > 1 && spell.duration_rounds) {
    spell.duration_rounds *= plan.duration_multiplier;
  }

  const damageType = plan?.damage_type ?? input.damage_type ?? custom?.damage_type ?? spell?.damage_type ?? known?.damage?.[0]?.type ?? null;
  const saveDc = plan?.save_dc ?? input.save_dc ?? custom?.save_dc ?? spell?.save_dc;
  const halfOnSave = input.half_on_save ?? custom?.half_on_save ?? spell?.half_on_save;

  // What the casting costs, after Quickened Spell has had its say.
  const economy: CastingEconomy | 'free' | null = plan ? plan.economy : casting;
  const spends: 'action' | 'bonus' =
    economy === 'bonus_action' || (economy === null && known?.kind === 'bonus_action') ? 'bonus' : 'action';
  // Action Surge buys one more action on this turn, and the SRD excepts the Magic action from it.
  if (economy !== null && spends === 'action' && !input.out_of_turn && actor.flags.surge_action_pending) {
    throw new Error(
      `Action Surge gives ${actor.name} one more action, the Magic action excepted, so ${
        spell?.name ?? input.action_name
      } cannot be cast with it. Spend the surged action on something else, and cast on another turn.`,
    );
  }
  // Quickened Spell: no level 1+ spell before it on this turn, and none after it either.
  const quickened = plan?.modifiers.some((modifier) => modifier.feature === 'Quickened Spell') ?? false;
  const levelled = spell !== null && spell.level >= 1;
  if (quickened && actor.flags.cast_levelled_spell) {
    throw new Error(
      `${actor.name} has already cast a level 1+ spell this turn, and Quickened Spell may not follow one. Cast it plainly, or wait for your next turn.`,
    );
  }
  if (levelled && actor.flags.quickened_this_turn) {
    throw new Error(
      `${actor.name} quickened a spell this turn, and no level 1+ spell may follow it. Take another action, or wait for your next turn.`,
    );
  }
  if (!input.out_of_turn && economy !== 'free' && economy !== 'reaction') requireEconomy(actor, spends, input.action_name);

  const fromSpell: Omit<EffectInput, 'target_id'> | undefined =
    input.effect && spell && input.effect.ends === undefined
      ? {
          ...input.effect,
          ...(concentration
            ? { ends: 'concentration' as const }
            : spell.duration_rounds
              ? { ends: 'rounds' as const, remaining_rounds: input.effect.remaining_rounds ?? spell.duration_rounds }
              : {}),
        }
      : input.effect;
  const markEffect: Omit<EffectInput, 'target_id'> | undefined = marking
    ? { name: "Hunter's Mark", kind: 'buff', tick: 'end', ends: 'concentration' }
    : undefined;
  const ongoing: Omit<EffectInput, 'target_id'> | undefined = fromSpell ?? custom?.effect ?? markEffect;

  // Range is checked before the slot is spent: a cast the engine refuses must cost nothing.
  const reachOfSpell = plan?.range_ft ?? spell?.range_ft ?? null;
  if (reachOfSpell !== null && spell) {
    const reach = input.point
      ? distanceToPoint(actor, input.point)
      : input.target_id === undefined
        ? 0
        : distanceBetween(actor, getCombatant(db, encounter.id, input.target_id));
    if (reach > reachOfSpell) {
      throw new Error(`${spell.name} reaches ${reachOfSpell} ft and the target is ${reach} ft away; move closer first.`);
    }
  }
  if (declaredEffect?.range_ft !== null && declaredEffect?.range_ft !== undefined && targets.length > 0) {
    const reach = input.point ? distanceToPoint(actor, input.point) : distanceBetween(actor, targets[0]!);
    if (reach > declaredEffect.range_ft) {
      throw new Error(`${input.action_name} reaches ${declaredEffect.range_ft} ft and the target is ${reach} ft away; move closer first.`);
    }
  }

  // Overchannel: everything it needs is checked here, before a slot or a sorcery point has moved.
  const overchannel = input.overchannel === true;
  let backlash = 0;
  if (overchannel) {
    if (!sheet || !hasFeature(sheet, 'evoker-overchannel')) {
      throw new Error(`${actor.name} has no Overchannel; it is an Evoker feature taken at Wizard level 14.`);
    }
    if (!spell || spell.slot_level === null || spell.slot_level > 5) {
      throw new Error('Overchannel empowers an SRD Wizard spell cast with a slot of level 1 to 5: pass spell and slot_level.');
    }
    if (!spell.classes.some((entry) => entry.endsWith('_wizard'))) {
      throw new Error(`Overchannel empowers a Wizard spell, and ${spell.name} is not on the Wizard list.`);
    }
    if (!damageExpr) throw new Error(`${spell.name} deals no damage, so there is nothing for Overchannel to maximise.`);
    requireResource(sheet, actor, { resource: 'overchannel', amount: 1 }, 'Overchannel');
    // The first use each long rest is free; every one after it burns the Evoker, a die more each time.
    const already = sheet.features.find((entry) => entry.mechanics?.resource === 'overchannel')?.mechanics?.used ?? 0;
    backlash = already === 0 ? 0 : (1 + already) * spell.slot_level;
  }

  const prelude: CombatLogEntry[] = [];
  if (input._feature_effect && sheet) {
    const costs = input._feature_effect.outcome.spend
      ? Array.isArray(input._feature_effect.outcome.spend)
        ? input._feature_effect.outcome.spend
        : [input._feature_effect.outcome.spend]
      : [];
    for (const cost of costs) requireResource(sheet, actor, cost, input._feature_effect.action.name);
    for (const cost of costs) {
      prelude.push(spendFeatureCost(db, encounter, actor, sheet, cost, input._feature_effect.action.name));
    }
  }
  let familiar: { form: string; feature: string } | null = null;
  if (spell) {
    // Every refusal happens before a single spend: a casting the engine turns down has to cost nothing.
    // A feature that pays for the whole casting: Divine Intervention and Natural Recovery, named outright.
    const named = input.free_cast && sheet ? planNamedFreeCast(actor, sheet, spell, input.free_cast, input.option) : null;
    // Paladin's Smite and Favored Enemy pay for a casting a long rest out of their own feature, not a slot.
    const free = input.slot_level === undefined && sheet && !input.free_cast ? freeCastOf(sheet, spell.name) : null;
    if (free) {
      spell.slot_level = null;
      spell.notes.push(`${free.feature}: this casting costs no spell slot.`);
    }
    // One spell slot a turn: a cast that would spend a second one is refused, while a cantrip or a
    // feature that pays for the casting itself (slot_level null) spends nothing and stays allowed.
    if (spell.slot_level !== null && spentSlotThisTurn(actor)) {
      throw new Error(
        `${actor.name} has already expended a spell slot this turn, and a turn allows only one: ${spell.name} has to wait for their next turn.`,
      );
    }
    requireSlotFor(actor, sheet, spell);
    if (plan?.notes.length) spell.notes.push(...plan.notes);
    // Nothing can refuse the casting now, so the feature uses, the sorcery points and the slot go together.
    if (named?.cost && sheet) prelude.push(spendFeatureCost(db, encounter, actor, sheet, named.cost, named.feature));
    if (free?.resource && sheet) {
      prelude.push(spendFeatureCost(db, encounter, actor, sheet, { resource: free.resource, amount: 1 }, free.feature));
    }
    for (const { feature, ...cost } of plan?.costs ?? []) {
      if (!sheet) break;
      prelude.push(spendFeatureCost(db, encounter, actor, sheet, cost, feature));
    }
    const slotEntry = spendSlotFor(db, encounter, actor, sheet, spell);
    if (slotEntry) prelude.push(slotEntry);
    if (overchannel && sheet) {
      prelude.push(spendFeatureCost(db, encounter, actor, sheet, { resource: 'overchannel', amount: 1 }, 'Overchannel'));
      spell.notes.push(
        `Overchannel: ${spell.name} deals its maximum damage${backlash ? `, and ${backlash}d12 Necrotic comes back on the caster` : ' with no adverse effect this time'}.`,
      );
    }
    if (named?.familiar) familiar = { form: named.familiar, feature: named.feature };
    if (spell.notes.length > 0) {
      prelude.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          kind: 'spell_entry',
          payload: { spell: spell.name, level: spell.level, slot_level: spell.slot_level, notes: spell.notes },
          text: `${spell.name}: ${spell.notes.join('; ')}.`,
        }),
      );
    }
  }
  const typeNote = damageTypeNote(input.damage_type);
  if (typeNote) {
    prelude.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        kind: 'note',
        payload: { damage_type: input.damage_type },
        text: typeNote,
      }),
    );
  }
  prelude.push(...castBoostLog);
  prelude.push(...revealHidden(db, encounter, actor, `casts ${input.action_name}`));
  prelude.push(...releaseReady(db, encounter, actor, reaction));
  // A second concentration spell ends the first, effects and all - the same spell recast included.
  if (concentration && actor.concentration) {
    prelude.push(...endConcentration(db, encounter, actor, `${actor.name} starts concentrating on ${input.action_name}`));
  }

  const log: CombatLogEntry[] = [
    ...prelude,
    logCombat(db, encounter, {
      actor_id: actor.id,
      kind: 'action',
      payload: {
        action: input.action_name,
        point: input.point ?? null,
        shape: shape ?? null,
        targets: targets.map((t) => t.id),
        ...(spell ? { spell: spell.name, slot_level: spell.slot_level, damage_expr: damageExpr ?? null } : {}),
        ...(reaction ? { out_of_turn: true, reason: reaction } : {}),
      },
      text: reactionText(
        reaction,
        `${actor.name} uses ${input.action_name}${
          shape && input.point ? ` (${shape.size_ft} ft ${shape.kind} at ${input.point.x},${input.point.y})` : ''
        }${targets.length ? ` on ${targets.map((t) => t.name).join(', ')}` : ''}.`,
      ),
    }),
  ];
  // Wild Companion and Pact of the Chain conjure the familiar itself: it fights as a companion of the party.
  if (familiar) log.push(...(await summonFamiliar(db, encounter, actor, familiar.form, familiar.feature)));

  const results: Array<Record<string, unknown>> = [];
  // "One damage roll of that spell" and "the caster regains hit points" happen once, not once a target.
  const spentOnce = new Set<string>();
  // A holder's damage-taken clause applies once per cast rather than once per target, the way a
  // rationed rider does; the fit for unlimited clauses is decided per target.
  const holderOnce = new Set<string>();
  const spellFeatures: Array<Record<string, unknown>> = [];
  let healedCaster = false;
  // SRD "Saving Throws and Damage": roll the damage once for all the targets. The first target that
  // needs it rolls it and every later target of the same casting reads those numbers; Empowered
  // Spell's reroll lands on that one roll rather than on each target's own copy of it.
  const sharedDamage = new Map<string, { rolled: ReturnType<typeof rollDamage>; total: number }>();
  let empoweredLogged = false;
  const damageForCast = async (expr: string, critical: boolean): Promise<{ rolled: ReturnType<typeof rollDamage>; total: number }> => {
    const key = `${critical ? 'critical' : 'normal'}:${expr}`;
    const cached = sharedDamage.get(key);
    if (cached) return cached;
    const askExpr = critical ? criticalExpr(expr) : expr;
    // The spell's own dice notes in the player's words: the scaled dice at this level or slot, Magic
    // Missile's darts as spellFill puts them, plus the crit's doubling.
    const playerNote = (note: string): string | null => {
      const cantrip = /^cantrip at level (\d+)/.exec(note);
      if (cantrip) return `${expr} at level ${cantrip[1]}`;
      const upcast = /^upcast to level (\d+)/.exec(note);
      if (upcast) return `${expr} with a level ${upcast[1]} slot`;
      return /^\d+ darts x \(/.test(note) ? note : null;
    };
    const diceNotes = [
      ...(spell?.notes ?? []).map(playerNote).filter((note): note is string => note !== null),
      ...(critical ? [`Doubled on a critical hit: ${expr} becomes ${askExpr}`] : []),
    ];
    const rolled = overchannel
      ? maximumDamage(expr, critical)
      : rollDamage(
          expr,
          critical,
          await askPlayer(db, encounter, actor, 'damage', {
            tool: 'use_action',
            expr: askExpr,
            purpose: `Damage: ${askExpr}${damageType ? ` (${damageType})` : ''}`,
            roll_type: 'damage',
            ...(diceNotes.length ? { dice_notes: diceNotes } : {}),
          }),
        );
    const empowered = plan?.reroll_damage ? rerollLowest(rolled.expr, rolled.dice, plan.reroll_damage) : null;
    if (empowered && !empoweredLogged) {
      empoweredLogged = true;
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          kind: 'feature_note',
          payload: { feature: 'Empowered Spell', delta: empowered.delta },
          text: empowered.note,
        }),
      );
    }
    const entry = { rolled, total: Math.max(0, rolled.total + (empowered?.delta ?? 0)) };
    sharedDamage.set(key, entry);
    return entry;
  };
  // Cover is measured from the effect's own origin: the point an area bursts from, or the caster for a
  // spell aimed at one creature. A cone or line starts at the caster, so it keeps them as the origin.
  const areaCast = shape !== undefined && input.point !== undefined;
  const areaOrigin: Token | null =
    shape && input.point && shape.kind !== 'cone' && shape.kind !== 'line'
      ? { id: -1, x: input.point.x, y: input.point.y, size: 'M', alive: true }
      : null;
  for (const target of targets) {
    // Divine Smite hits a Fiend or an Undead a die harder.
    const unholy = smiting && /fiend|undead/i.test(target.stat_block?.type ?? '');
    const cover = coverBetween(map, combatants, areaOrigin ?? actor, target);
    // Careful Spell and Sculpt Spells carve creatures out: they succeed without rolling and take nothing.
    const carved = plan?.auto_success.has(target.id) ?? false;
    let save: SaveResult | null = null;
    if (saveAbility && saveDc !== undefined && carved) {
      save = {
        ability: saveAbility,
        dc: saveDc,
        total: saveDc,
        natural: null,
        bonus: 0,
        success: true,
        advantage: 'none',
        auto_fail: null,
        notes: ['carved out of the spell'],
      };
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: target.id,
          kind: 'save',
          payload: { action: input.action_name, save, auto_success: true },
          text: `${target.name} is carved out of ${input.action_name}: the save succeeds and no damage lands.`,
        }),
      );
    } else if (saveAbility && saveDc !== undefined) {
      // Total Cover bars a spell aimed at a creature, though an area still reaches it; the snapshot
      // makes a refused casting cost nothing.
      if (!areaCast && !cover.line_of_sight) {
        throw new Error(`${target.name} has total cover from ${actor.name}: no line of sight, so move first.`);
      }
      // Smite of Protection's Half Cover lends to the save as well as to AC.
      const auraCover = auraHalfCover(target, auraSources(db, encounter));
      save = await rollSave(db, encounter, target, saveAbility, saveDc, {
        coverBonus: auraCover ? Math.max(cover.ac_bonus, 2) : cover.ac_bonus,
        roll: input.rolls?.[String(target.id)],
        tool: 'use_action',
        ...(plan?.save_disadvantage.has(target.id) ? { advantage: 'disadvantage' as Advantage } : {}),
      });
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: target.id,
          kind: 'save',
          payload: { action: input.action_name, save },
          text: `${target.name} rolls ${save.total} on a ${saveAbility.toUpperCase()} save vs DC ${saveDc}: ${save.success ? 'success' : 'failure'}.`,
        }),
      );
    }

    // A spell cast with an attack roll: the entry says so, and the sheet carries the bonus.
    let spellAttack: { roll: RollOutcome; hit: boolean; critical: boolean; ac: number; advantage: Advantage } | null = null;
    if ((spell?.attack_roll || custom?.attack_roll) && !saveAbility) {
      // A spell attack roll needs to see its target, exactly as a weapon swing does.
      if (!cover.line_of_sight) {
        throw new Error(`${target.name} has total cover from ${actor.name}: no line of sight, so move first.`);
      }
      const away = distanceBetween(actor, target);
      // The crowded-shot rule is for ranged attack rolls; a touch spell is swung, not shot.
      const attackRange = spell?.range_ft ?? declaredEffect?.range_ft;
      const ranged = attackRange === null || attackRange === undefined || attackRange > 5;
      const crowded = ranged ? crowdedShot(db, encounter, actor) : null;
      const attackContext = d20Context(db, encounter, actor, {
        kind: 'attack',
        target,
        distance_ft: away,
        advantage: input.advantage,
        extra: [
          ...(crowded ? [{ advantage: 'disadvantage' as Advantage, note: `${crowded}, so the spell is rushed` }] : []),
          // Innate Sorcery: Advantage on the attack rolls of Sorcerer spells while it runs.
          ...(plan?.attack_advantage ? [{ advantage: 'advantage' as Advantage, note: 'Innate Sorcery' }] : []),
          // A homebrew boost the DM took for this casting rides on its attack roll.
          ...castTaken
            .filter((one) => one.advantage)
            .map((one) => ({ advantage: 'advantage' as Advantage, note: `${one.name}: ${one.describe}` })),
        ],
      });
      const attackBonus =
        (sheet?.spells.attack_bonus ?? 0) +
        attackContext.penalty +
        (plan?.attack_bonus ?? 0) +
        castTaken.reduce((sum, one) => sum + one.bonus, 0);
      // Smite of Protection's Half Cover lends to a spell attack's AC as it does to a weapon swing.
      const auraCover = auraHalfCover(target, auraSources(db, encounter));
      const ac = target.ac + (auraCover ? Math.max(cover.ac_bonus, 2) : cover.ac_bonus);
      const spellBoostCtx: Omit<ClauseCtx, 'sheet'> = { ...castBoostCtx, kind: 'attack', target };
      const spellBoosts = sheet ? boostsFor(sheet, sheet.features, spellBoostCtx, ATTACK_HOOKS) : [];
      const pre =
        input.roll ??
        (await askPlayer(db, encounter, actor, 'attack', {
          tool: 'use_action',
          expr: `1d20${signed(attackBonus)}`,
          purpose: `Spell attack: ${spell?.name ?? input.action_name}`,
          roll_type: 'attack',
          dc: ac,
          advantage: attackContext.advantage,
          advantage_sources: attackContext.advantage_sources,
          target_id: target.id,
          ...(spellBoosts.length ? { boosts_available: spellBoosts } : {}),
        }));
      if (pre?.boosts_chosen?.length) {
        log.push(...spendChosenBoosts(db, encounter, actor, sheet, pre.boosts_chosen, spellBoostCtx, ATTACK_HOOKS));
      }
      let rolled = rollD20(
        attackBonus,
        { advantage: attackContext.advantage, dc: ac, kind: 'attack', luck_bias: pcLuck(db, encounter, actor) },
        pre,
      );
      let landed = rolled.natural === 20 || (rolled.natural !== 1 && rolled.total >= ac);
      // Seeking Spell: a missed spell attack roll is rolled again once, and the new roll stands.
      if (!landed && plan?.reroll_attack) {
        const again = await askPlayer(db, encounter, actor, 'attack', {
          tool: 'use_action',
          expr: `1d20${signed(attackBonus)}`,
          purpose: `Seeking Spell: ${spell?.name ?? input.action_name} rerolled`,
          roll_type: 'attack',
          dc: ac,
          advantage: attackContext.advantage,
          advantage_sources: attackContext.advantage_sources,
          target_id: target.id,
        });
        rolled = rollD20(
          attackBonus,
          {
            advantage: attackContext.advantage,
            dc: ac,
            kind: 'attack',
            luck_bias: pcLuck(db, encounter, actor),
          },
          again,
        );
        landed = rolled.natural === 20 || (rolled.natural !== 1 && rolled.total >= ac);
        attackContext.notes.push(`Seeking Spell: the missed roll is rerolled to ${rolled.total}`);
      }
      const helpless = away <= 5 && rulesOf(target.conditions).some((r) => r.crit_within_5ft);
      spellAttack = {
        roll: rolled,
        hit: landed,
        critical: rolled.natural === 20 || (landed && helpless),
        ac,
        advantage: attackContext.advantage,
      };
      spendSapVex(db, actor, target);
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: target.id,
          kind: 'attack',
          payload: {
            action: spell?.name ?? input.action_name,
            ...(spell ? { spell: spell.name } : {}),
            roll: rolled,
            advantage: attackContext.advantage,
            effective_ac: ac,
            cover: cover.cover,
            hit: landed,
            critical: spellAttack.critical,
            notes: attackContext.notes,
          },
          text: `${actor.name} uses ${spell?.name ?? input.action_name} at ${target.name}: spell attack ${rolled.total} vs AC ${ac} - ${
            spellAttack.critical ? 'critical hit' : landed ? 'hit' : 'miss'
          }.${attackContext.notes.length ? ` (${attackContext.notes.join('; ')})` : ''}`,
        }),
      );
    }

    let damage: DamageResult | null = null;
    const expr = damageExpr && unholy ? `${damageExpr} + 1d8` : damageExpr;
    // Potent Cantrip: a creature that saved, or was missed, still takes half a cantrip's damage.
    const mitigation =
      spell && sheet && (save?.success === true || (spellAttack !== null && !spellAttack.hit)) && !carved
        ? saveMitigation(sheet, {
            actor,
            spell: spellInfoOf(spell),
            target,
            missed: spellAttack !== null && !spellAttack.hit,
          })
        : null;
    const landedOrHalved = !(spellAttack && !spellAttack.hit) || mitigation !== null;
    const savedOut = save?.success === true && !halfOnSave && mitigation === null;
    // A Smite has no attack roll of its own, so it doubles on the critical hit it followed.
    const criticalCast = spellAttack?.critical ?? smiteCritical;
    if (expr && landedOrHalved && !savedOut && !carved) {
      const { rolled: rolledDamage, total: rolledTotal } = await damageForCast(expr, criticalCast);
      // What the caster's own features add is rolled before the damage lands, so a negative flat rider
      // can come off the part it rides on instead of being applied as a damage part of its own.
      // Riders read the target as it stood before this damage, exactly as they do on an attack.
      const riders =
        spell && sheet
          ? spellDamageRiders(sheet, { actor, spell: spellInfoOf(spell), target, damage_type: damageType }).filter(
              (rider) => !(rider.once_per_cast && spentOnce.has(rider.feature)),
            )
          : [];
      for (const rider of riders) if (rider.once_per_cast) spentOnce.add(rider.feature);
      const riderRolls =
        riders.length > 0
          ? await rollRiderDamage(db, encounter, actor, target, riders, criticalCast, 'use_action')
          : new Map<HitRider, RiderRoll>();
      const parts = [{ type: damageType, amount: rolledTotal }];
      const foldedRiders = foldNegativeRiders(db, encounter, actor, target, parts, riderRolls);
      log.push(...foldedRiders.log);
      // Evasion: a DEX save for half takes nothing at all on a success, and half on a failure.
      const dodgerSheet = sheetOf(db, target);
      const evasion = halfOnSave === true && saveAbility === 'dex' && dodgerSheet !== null && hasEvasion(dodgerSheet);
      // A successful save halves the whole damage roll, a positive rider included; so does a failed Evasion.
      const halved = save?.success === true || mitigation !== null;
      const takesNothing = halved && evasion && save?.success === true;
      const reduced =
        save?.success === true
          ? takesNothing
            ? 'Evasion took it to nothing'
            : 'the save halved it'
          : evasion
            ? 'Evasion halved it'
            : `${mitigation?.feature ?? 'the save'} halved it`;
      const foldedPositive =
        halved || evasion
          ? foldPositiveRidersForHalving(db, encounter, actor, target, parts, riderRolls, damageType, reduced, takesNothing)
          : { log: [], folded: new Set<HitRider>() };
      log.push(...foldedPositive.log);
      // A folded rider fired, so its use is still spent even though its damage never lands on its own.
      if (sheet) {
        for (const rider of [...foldedRiders.folded, ...foldedPositive.folded]) {
          if (rider.spend) log.push(spendFeatureCost(db, encounter, actor, sheet, rider.spend, rider.feature));
        }
      }
      const foldedAll = new Set([...foldedRiders.folded, ...foldedPositive.folded]);
      const ridersToApply = riders.filter((rider) => !foldedAll.has(rider));
      const foldedTotal = parts[0]!.amount;
      const amount = halved
        ? evasion && save?.success === true
          ? 0
          : Math.floor(foldedTotal / 2)
        : evasion
          ? Math.floor(foldedTotal / 2)
          : foldedTotal;
      damage = damageCombatant(db, encounter, target, {
        amount,
        type: damageType,
        source: `${actor.name}'s ${input.action_name}`,
        critical: criticalCast,
      });
      if (mitigation) {
        log.push(
          logCombat(db, encounter, {
            actor_id: actor.id,
            target_id: target.id,
            kind: 'feature_note',
            payload: { feature: mitigation.feature },
            text: mitigation.note,
          }),
        );
      }
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: target.id,
          kind: 'damage',
          payload: { action: input.action_name, ...damage, type: damageType, expr: rolledDamage.expr },
          text: `${target.name} takes ${damage.applied} ${damageType ?? ''} damage (${rolledDamage.output}${
            damage.resistance ? `, ${damage.resistance}` : ''
          })${partyHp(target, ` - ${damage.hp_current}/${damage.hp_max} HP`)}.`,
        }),
      );
      // A spell's own damage and every rider it carries are one instance, so they owe one concentration
      // save between them, against the damage they add up to.
      let instanceDamage = damage.applied;
      if (sheet && ridersToApply.length > 0) {
        const resolved = await applyHitRiders(
          db,
          encounter,
          actor,
          getCombatant(db, encounter.id, target.id),
          sheet,
          ridersToApply,
          riderRolls,
          criticalCast,
          true,
        );
        log.push(...resolved.log);
        spellFeatures.push(...resolved.applied);
        instanceDamage += resolved.damage;
      }
      log.push(...(await afterDamage(db, encounter, target, instanceDamage, 'use_action')));
      if (damage.dead) log.push(...afterKill(db, encounter, target, actor, `${actor.name}'s ${input.action_name}`));
      else if (isDowned(db, encounter, target.id)) log.push(...droppedToZero(db, encounter, target, actor));

      // A holder's damage-taken clause rides on this damage the way it rides on a weapon hit, once
      // per cast on the first hurt creature it fits.
      const hurt = getCombatant(db, encounter.id, target.id);
      const hurtSheet = sheetOf(db, hurt);
      if (damage.applied > 0 && hurtSheet && hurt.alive && !damage.dead) {
        const raw = damageTakenOutcomes(hurtSheet, {
          actor: hurt, attacker: actor, damage: damage.applied, damage_type: damageType, distance_ft: distanceBetween(actor, target),
        });
        const outcomes = raw.filter((outcome) => {
          const cost = outcome.spend && !Array.isArray(outcome.spend) ? outcome.spend : null;
          return cost === null || !holderOnce.has(cost.resource);
        });
        for (const outcome of outcomes) {
          log.push(...applyOutcome(db, encounter, hurt, hurtSheet, outcome));
          if (outcome.spend && !Array.isArray(outcome.spend)) holderOnce.add(outcome.spend.resource);
        }
      }
    }

    if (spell && sheet && !carved && (save?.success === true || (spellAttack !== null && !spellAttack.hit))) {
      const result = save
        ? { natural: save.natural, total: save.total, dc: save.dc, success: save.success }
        : { natural: spellAttack!.roll.natural, total: spellAttack!.roll.total, dc: spellAttack!.ac, success: spellAttack!.hit };
      for (const outcome of saveSucceededOutcomes(sheet, {
        actor,
        spell: spellInfoOf(spell),
        target,
        missed: spellAttack !== null && !spellAttack.hit,
        roll: result,
      })) {
        log.push(...applyOutcome(db, encounter, actor, sheet, outcome));
      }
    }

    if (healExpr) {
      const healed = rollHealing(healExpr, sheet);
      // Disciple of Life and Blessed Healer: what the caster's features add to a spell's healing.
      const extra = (
        spell && sheet ? healRiders(sheet, { actor, spell: spellInfoOf(spell), target, amount: healed.total }) : []
      ).filter((rider) => !(rider.once_per_cast && spentOnce.has(rider.feature)));
      for (const rider of extra) if (rider.once_per_cast) spentOnce.add(rider.feature);
      const bonus = extra.reduce((sum, rider) => sum + (rider.bonus ?? 0), 0);
      for (const rider of extra) {
        if (rider.spend && sheet) log.push(spendFeatureCost(db, encounter, actor, sheet, rider.spend, rider.feature));
      }
      healCombatant(db, encounter, target, healed.total + bonus);
      const after = getCombatant(db, encounter.id, target.id);
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: target.id,
          kind: 'heal',
          payload: {
            action: input.action_name,
            amount: healed.total + bonus,
            hp_current: after.hp_current,
            ...(extra.length ? { features: extra.map((rider) => rider.feature) } : {}),
          },
          text: `${target.name} regains ${healed.total + bonus} HP${partyHp(target, ` (${after.hp_current}/${after.hp_max})`)}${
            extra.length ? ` - ${extra.map((rider) => rider.note).join(' ')}` : ''
          }.`,
        }),
      );
      const back = extra.reduce((sum, rider) => sum + (rider.self_heal ?? 0), 0);
      if (back > 0 && !healedCaster) {
        healedCaster = true;
        const caster = getCombatant(db, encounter.id, actor.id);
        healCombatant(db, encounter, caster, back);
        const casterAfter = getCombatant(db, encounter.id, actor.id);
        log.push(
          logCombat(db, encounter, {
            actor_id: actor.id,
            kind: 'heal',
            payload: { action: input.action_name, amount: back, hp_current: casterAfter.hp_current },
            text: `${actor.name} regains ${back} HP${partyHp(caster, ` (${casterAfter.hp_current}/${casterAfter.hp_max})`)} - ${extra
              .filter((rider) => rider.self_heal)
              .map((rider) => rider.note)
              .join(' ')}`,
          }),
        );
      }
    }

    let effectId: number | null = null;
    const immune = ongoing?.kind === 'condition' ? immuneTo(db, encounter, target, ongoing.name) : null;
    if (immune) {
      log.push(
        logCombat(db, encounter, {
          actor_id: actor.id,
          target_id: target.id,
          kind: 'note',
          payload: { condition: ongoing?.name, immune: true },
          text: `${immune} The ${input.action_name} leaves no ${ongoing?.name} on it.`,
        }),
      );
    }
    if (ongoing && !immune && !save?.success && !(spellAttack && !spellAttack.hit)) {
      const created = attachEffect(db, encounter, {
        ...ongoing,
        target_id: target.id,
        source_id: ongoing.source_id ?? actor.id,
        concentration_of: concentration ? actor.id : (ongoing.concentration_of ?? null),
      });
      effectId = created.effect.id;
      log.push(created.entry, ...created.landed);
    }
    results.push({ target_id: target.id, name: target.name, save, attack: spellAttack, damage, effect_id: effectId });
  }

  // Overchannel's price, paid by the Evoker the moment the spell is done.
  if (backlash > 0) {
    const rolled = rollDamage(`${backlash}d12`, false);
    const hurt = damageCombatant(db, encounter, getCombatant(db, encounter.id, actor.id), {
      amount: rolled.total,
      type: 'necrotic',
      source: 'Overchannel',
      ignore_immunity: true,
      ignore_resistance: true,
    });
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        kind: 'feature_damage',
        payload: { feature: 'Overchannel', ...hurt, type: 'necrotic', expr: rolled.expr },
        text: `Overchannel burns ${actor.name}: ${hurt.applied} Necrotic damage (${rolled.output}), which no Resistance or Immunity softens${partyHp(actor, ` - ${hurt.hp_current}/${hurt.hp_max} HP`)}.`,
      }),
    );
    log.push(...(await afterDamage(db, encounter, getCombatant(db, encounter.id, actor.id), hurt.applied, 'use_action')));
    refreshVitals(db, encounter, actor);
  }
  // Smite of Protection: the aura shelters the Paladin and their allies until the start of the Paladin's
  // next turn, so the flag lapses at that turn's start and the counter reads one round from now.
  if (smiting && sheet && hasFeature(sheet, 'devotion-smite-of-protection')) {
    actor.flags = { ...actor.flags, smite_protection: { rounds_left: 1 } };
    log.push(
      logCombat(db, encounter, {
        actor_id: actor.id,
        kind: 'feature_note',
        payload: { feature: 'Smite of Protection' },
        text: `${actor.name}'s smite radiates outward: everyone in their aura has Half Cover until the start of their next turn (Smite of Protection).`,
      }),
    );
  }
  // Arcane Apotheosis paid for one Metamagic option, and it is the only free one this turn.
  if (plan?.free_metamagic) actor.flags = { ...actor.flags, apotheosis_used: true };
  if (concentration) {
    actor.concentration = { name: input.action_name, ...(plan?.concentration_advantage ? { advantage: true } : {}) };
  } else {
    // attachEffect may have started a concentration for the actor; keep it rather than saving the stale null.
    actor.concentration = getCombatant(db, encounter.id, actor.id).concentration;
  }
  // The smite is spent on the hit it followed, and a spell cast on an enemy keeps a Rage alive.
  if (smiting) actor.flags = { ...actor.flags, smite_ready: undefined };
  // Quickened Spell and the level 1+ casting it may not share a turn with: both leave their mark here.
  if (levelled) actor.flags = { ...actor.flags, cast_levelled_spell: true };
  if (quickened) actor.flags = { ...actor.flags, quickened_this_turn: true };
  // The one-slot rule counts only a cast the engine actually charged a slot for: a free casting leaves
  // it clear, and so does a caster with no sheet to spend from, who would otherwise be told a untruth.
  if (spell && spell.slot_level !== null && sheet && actor.character_id !== null) {
    actor.flags = { ...actor.flags, spent_slot_this_turn: true };
  }
  if (economy !== 'free') spendResource(actor, spends, input.out_of_turn);
  // The spell may have healed or hurt the caster: keep what the row says over what this object holds.
  refreshVitals(db, encounter, actor);
  saveCombatant(db, actor);
  // What is still on offer once this call has paid for everything it took.
  const castLeftToSpend = sheet ? boostsFor(sheet, sheet.features, castBoostCtx, CAST_HOOKS) : [];

  return finish(db, encounter, 'use_action', `${actor.name} uses ${input.action_name}.`, log, {
    actor_id: actor.id,
    action: input._feature_effect?.action.id ?? input.action_name,
    targets: results,
    ...(spell ? { spell: { ...spell, damage_expr: damageExpr ?? null } } : {}),
    ...(plan && plan.modifiers.length ? { spell_modifiers: plan.modifiers.map((m) => ({ feature: m.feature, note: m.note })) } : {}),
    ...(spellFeatures.length ? { features: spellFeatures } : {}),
    ...(remindersOf(spellFeatures).length ? { reminders: remindersOf(spellFeatures) } : {}),
    ...(castLeftToSpend.length ? { boosts_available: castLeftToSpend } : {}),
    ...(sheet ? { class_features: classFeatures(sheet, getCombatant(db, encounter.id, actor.id)) } : {}),
    ...(reaction ? { out_of_turn: true, reason: reaction } : {}),
  });
}

// --- turns ------------------------------------------------------------------

/** A new turn clears what the last one left: Dash, Dodge, Disengage and an unreleased readied action. */
const turnFlags = (flags: CombatFlags): CombatFlags => ({
  ...(flags.hidden ? { hidden: true } : {}),
  ...(flags.stable ? { stable: true } : {}),
  ...(flags.helped_by ? { helped_by: flags.helped_by } : {}),
  ...(flags.grappled_by === undefined ? {} : { grappled_by: flags.grappled_by }),
  ...(flags.grappling?.length ? { grappling: flags.grappling } : {}),
  // The mastery windows run off the attacker's turns, not this one, so they outlive it.
  ...(flags.sapped_by ? { sapped_by: flags.sapped_by } : {}),
  ...(flags.slowed_by ? { slowed_by: flags.slowed_by } : {}),
  ...(flags.vex_against ? { vex_against: flags.vex_against } : {}),
  // A Rage, a Sacred Weapon, an Innate Sorcery and a Wild Shape run for minutes or hours; everything
  // else a class feature leaves behind is for one turn.
  ...(flags.raging ? { raging: flags.raging } : {}),
  ...(flags.sacred_weapon ? { sacred_weapon: flags.sacred_weapon } : {}),
  ...(flags.innate_sorcery ? { innate_sorcery: flags.innate_sorcery } : {}),
  ...(flags.wild_shape ? { wild_shape: flags.wild_shape } : {}),
  ...(flags.pact_weapon ? { pact_weapon: flags.pact_weapon } : {}),
  // Declared and not yet spent: they wait for the roll they were bought for, as a stance does.
  ...(flags.cutting_words_ready ? { cutting_words_ready: flags.cutting_words_ready } : {}),
  ...(flags.dark_ones_luck_ready ? { dark_ones_luck_ready: true } : {}),
  ...(flags.d20_stance ? { d20_stance: flags.d20_stance } : {}),
  ...(flags.hunters_defense_ready ? { hunters_defense_ready: true } : {}),
  // Superior Defense and Holy Nimbus run for minutes; Quivering Palm's vibrations run for days.
  ...(flags.superior_defense ? { superior_defense: flags.superior_defense } : {}),
  ...(flags.holy_nimbus ? { holy_nimbus: flags.holy_nimbus } : {}),
  ...(flags.smite_protection ? { smite_protection: flags.smite_protection } : {}),
  ...(flags.quivering_palm ? { quivering_palm: flags.quivering_palm } : {}),
  // Waiting for the roll or the swing they were left for: a stagger, a sundered guard, a studied miss.
  ...(flags.staggered ? { staggered: true } : {}),
  ...(flags.sundering_blow ? { sundering_blow: flags.sundering_blow } : {}),
  ...(flags.studied_target ? { studied_target: flags.studied_target } : {}),
  // Persistent Rage was offered at Initiative and stays on offer until this turn of theirs ends.
  ...(flags.persistent_rage_offered ? { persistent_rage_offered: true } : {}),
});

/**
 * The once-a-turn features belong to a turn, not to a round: a Rogue who sneak-attacks on its own turn
 * may not sneak again on an opportunity attack during the goblin's. Every turn boundary clears them for
 * everyone, and the Deflect Attacks redirect window closes with them.
 */
function clearOncePerTurn(db: Db, encounter: EncounterRow): void {
  for (const combatant of listCombatants(db, encounter.id)) {
    const flags = combatant.flags;
    const oncePerTurn = [
      flags.sneak_attack_used,
      flags.stunning_strike_used,
      flags.colossus_slayer_used,
      flags.frenzy_used,
      flags.divine_strike_used,
      flags.primal_strike_used,
      flags.eldritch_smite_used,
      flags.lifedrinker_used,
      flags.deflect_redirect,
      flags.resisting,
      flags.quivering_palm_used,
      flags.hurl_through_hell_used,
      flags.apotheosis_used,
      flags.superior_prey_used,
      flags.cleaved,
      flags.homebrew_used,
      flags.spent_slot_this_turn,
    ];
    if (oncePerTurn.every((flag) => flag === undefined)) continue;
    combatant.flags = {
      ...flags,
      sneak_attack_used: undefined,
      stunning_strike_used: undefined,
      colossus_slayer_used: undefined,
      frenzy_used: undefined,
      divine_strike_used: undefined,
      primal_strike_used: undefined,
      eldritch_smite_used: undefined,
      lifedrinker_used: undefined,
      deflect_redirect: undefined,
      // Superior Hunter's Defense resists that damage type "until the end of the current turn".
      resisting: undefined,
      quivering_palm_used: undefined,
      hurl_through_hell_used: undefined,
      apotheosis_used: undefined,
      superior_prey_used: undefined,
      // One slot a turn means the turn in play, not the caster's own: clearing it here is what lets
      // Shield or Counterspell answer an attack on someone else's turn after a cast on your own.
      spent_slot_this_turn: undefined,
      // Cleave is one extra attack a turn; the swing spends it, the next turn gives it back.
      cleaved: undefined,
      // The once-a-turn homebrew clauses are keyed the same way, and clear on the same edge.
      homebrew_used: undefined,
    };
    saveCombatant(db, combatant);
  }
}

/**
 * The class-feature states that run on a clock rather than to the end of a turn: a Sacred Weapon's ten
 * minutes, an Innate Sorcery's minute, a Wild Shape's half-level hours. Each loses a round at the end of
 * its holder's turn and ends when the clock runs out; a Wild Shape also ends the moment it is incapacitated.
 */
function expireTimedFlags(db: Db, encounter: EncounterRow, actor: Combatant): CombatLogEntry[] {
  const fresh = getCombatant(db, encounter.id, actor.id);
  const entries: CombatLogEntry[] = [];
  const end = (feature: string, text: string): void => {
    entries.push(
      logCombat(db, encounter, {
        actor_id: fresh.id,
        kind: 'feature_note',
        payload: { feature, ended: true },
        text,
      }),
    );
  };
  let flags = fresh.flags;
  const blessed = flags.sacred_weapon;
  if (blessed) {
    const left = blessed.rounds_left - 1;
    flags = left <= 0 ? { ...flags, sacred_weapon: undefined } : { ...flags, sacred_weapon: { ...blessed, rounds_left: left } };
    if (left <= 0) end('Sacred Weapon', `The blessing on ${fresh.name}'s weapon fades: ten minutes of Sacred Weapon are up.`);
  }
  const sorcery = flags.innate_sorcery;
  if (sorcery) {
    const left = sorcery.rounds_left - 1;
    flags = left <= 0 ? { ...flags, innate_sorcery: undefined } : { ...flags, innate_sorcery: { rounds_left: left } };
    if (left <= 0) end('Innate Sorcery', `${fresh.name}'s Innate Sorcery ends: its minute is up.`);
  }
  const bolstered = flags.superior_defense;
  if (bolstered) {
    const left = bolstered.rounds_left - 1;
    const over = left <= 0 || isIncapacitated(fresh.conditions);
    flags = over ? { ...flags, superior_defense: undefined } : { ...flags, superior_defense: { rounds_left: left } };
    if (over) {
      end(
        'Superior Defense',
        `${fresh.name}'s Superior Defense ends: ${isIncapacitated(fresh.conditions) ? 'they are incapacitated' : 'its minute is up'}.`,
      );
    }
  }
  const nimbus = flags.holy_nimbus;
  if (nimbus) {
    const left = nimbus.rounds_left - 1;
    flags = left <= 0 ? { ...flags, holy_nimbus: undefined } : { ...flags, holy_nimbus: { rounds_left: left } };
    if (left <= 0) end('Holy Nimbus', `The light around ${fresh.name} fades: ten minutes of Holy Nimbus are up.`);
  }
  // Studied Attacks holds until the end of your next turn; the Resistance one blow bought holds to the turn's end.
  const studied = flags.studied_target;
  if (studied) {
    const left = studied.rounds_left - 1;
    flags = left <= 0 ? { ...flags, studied_target: undefined } : { ...flags, studied_target: { ...studied, rounds_left: left } };
  }
  const sundered = flags.sundering_blow;
  if (sundered) {
    const left = sundered.rounds_left - 1;
    flags = left <= 0 ? { ...flags, sundering_blow: undefined } : { ...flags, sundering_blow: { ...sundered, rounds_left: left } };
  }
  const shape = flags.wild_shape;
  if (shape) {
    const left = shape.rounds_left - 1;
    const why = isIncapacitated(fresh.conditions) ? `${fresh.name} is incapacitated` : left <= 0 ? 'the hours are up' : null;
    if (why) {
      entries.push(...revertWildShape(db, encounter, fresh, why));
      flags = getCombatant(db, encounter.id, fresh.id).flags;
    } else {
      flags = { ...flags, wild_shape: { ...shape, rounds_left: left } };
    }
  }
  if (flags !== fresh.flags) {
    fresh.flags = flags;
    saveCombatant(db, fresh);
    actor.flags = flags;
  }
  return entries;
}

/**
 * The upkeep a class feature asks for at the edge of its holder's turn: the Rage that has to be extended
 * or ends, and the features whose own text fires there (Heroic Warrior, Self-Restoration).
 */
function featureTurnEdge(db: Db, encounter: EncounterRow, actor: Combatant, when: 'start' | 'end'): CombatLogEntry[] {
  const sheet = sheetOf(db, actor);
  if (!sheet) return [];
  const entries: CombatLogEntry[] = [];
  const fresh = getCombatant(db, encounter.id, actor.id);

  if (when === 'end' && fresh.flags.raging) {
    const raging = fresh.flags.raging;
    const left = raging.rounds_left - 1;
    // The Rage ends when the turn it was not extended in runs out, when ten minutes pass, or when its
    // holder is incapacitated; entering heavy armour ends it too, and that shows on the sheet.
    // Persistent Rage, at level 15: nothing but falling Unconscious or the ten minutes ends it.
    const persistent = hasFeature(sheet, 'barbarian-persistent-rage');
    const why = persistent
      ? fresh.conditions.includes('unconscious')
        ? `${fresh.name} is unconscious`
        : left <= 0
          ? 'ten minutes of Rage are up'
          : null
      : isIncapacitated(fresh.conditions)
        ? `${fresh.name} is incapacitated`
        : raging.extended_round < encounter.round
          ? `${fresh.name} neither attacked nor forced a save this round`
          : left <= 0
            ? 'ten minutes of Rage are up'
            : null;
    if (why) {
      fresh.flags = { ...fresh.flags, raging: undefined };
      saveCombatant(db, fresh);
      actor.flags = fresh.flags;
      entries.push(
        logCombat(db, encounter, {
          actor_id: fresh.id,
          kind: 'feature_note',
          payload: { feature: 'Rage', ended: true, reason: why },
          text: `${fresh.name}'s Rage ends: ${why}.`,
        }),
      );
    } else {
      fresh.flags = { ...fresh.flags, raging: { ...raging, rounds_left: left } };
      saveCombatant(db, fresh);
      actor.flags = fresh.flags;
    }
  }

  if (when === 'end') entries.push(...expireTimedFlags(db, encounter, actor));

  // Smite of Protection runs to the start of the Paladin's own next turn, not the end of the turn it
  // was cast on, so its count comes off here rather than in expireTimedFlags.
  if (when === 'start' && fresh.flags.smite_protection) {
    const left = fresh.flags.smite_protection.rounds_left - 1;
    fresh.flags =
      left <= 0
        ? { ...fresh.flags, smite_protection: undefined }
        : { ...fresh.flags, smite_protection: { rounds_left: left } };
    saveCombatant(db, fresh);
    actor.flags = fresh.flags;
    if (left <= 0) {
      entries.push(
        logCombat(db, encounter, {
          actor_id: fresh.id,
          kind: 'feature_note',
          payload: { feature: 'Smite of Protection', ended: true },
          text: `The cover ${fresh.name}'s aura lent runs out: Smite of Protection lasts until the start of their next turn.`,
        }),
      );
    }
  }

  // Survivor's Heroic Rally, Self-Restoration and every clause written at a turn edge.
  for (const outcome of turnOutcomes(sheet, getCombatant(db, encounter.id, actor.id), when)) {
    entries.push(...applyOutcome(db, encounter, actor, sheet, outcome));
  }
  return entries;
}

/** Holy Nimbus: the Radiant damage an enemy takes for starting its turn inside a Paladin's aura. */
async function auraTurnDamage(db: Db, encounter: EncounterRow, actor: Combatant): Promise<CombatLogEntry[]> {
  if (!actor.alive || actor.hp_current === 0) return [];
  const burning = holyNimbusDamage(actor, auraSources(db, encounter));
  if (!burning) return [];
  const result = damageCombatant(db, encounter, actor, {
    amount: burning.amount,
    type: 'radiant',
    source: `${burning.from.name}'s Holy Nimbus`,
  });
  const entries = [
    logCombat(db, encounter, {
      actor_id: burning.from.id,
      target_id: actor.id,
      kind: 'feature_damage',
      payload: { feature: 'Holy Nimbus', ...result, type: 'radiant' },
      text: `${actor.name} starts its turn in ${burning.from.name}'s Holy Nimbus and takes ${result.applied} Radiant damage${partyHp(actor, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
    }),
  ];
  entries.push(...(await afterDamage(db, encounter, actor, result.applied, 'advance_turn')));
  if (result.dead) entries.push(...afterKill(db, encounter, actor, burning.from, `${burning.from.name}'s Holy Nimbus`));
  else if (isDowned(db, encounter, actor.id)) entries.push(...droppedToZero(db, encounter, actor, burning.from));
  return entries;
}

/** A grapple ends when the grappler is incapacitated or down, or the two are no longer within reach. */
function checkGrapples(db: Db, encounter: EncounterRow): CombatLogEntry[] {
  const entries: CombatLogEntry[] = [];
  for (const held of listCombatants(db, encounter.id)) {
    const grapplerId = held.flags.grappled_by;
    if (grapplerId === undefined) continue;
    const grappler = listCombatants(db, encounter.id).find((c) => c.id === grapplerId);
    if (!grappler) continue;
    const why = !grappler.alive || grappler.hp_current === 0
      ? `${grappler.name} is down`
      : isIncapacitated(grappler.conditions)
        ? `${grappler.name} is incapacitated`
        : distanceBetween(grappler, held) > reachOf(db, grappler)
          ? `${held.name} is out of ${grappler.name}'s reach`
          : null;
    if (!why) continue;
    releaseGrapple(db, encounter, grappler, held);
    entries.push(
      logCombat(db, encounter, {
        actor_id: grappler.id,
        target_id: held.id,
        kind: 'grapple_end',
        payload: { reason: why },
        text: `The grapple on ${held.name} ends: ${why}.`,
      }),
    );
  }
  return entries;
}

/** Survivor: the Champion whose death saves carry Advantage and count an 18 or better as a 20. */
function defiesDeath(db: Db, combatant: Combatant): boolean {
  const sheet = sheetOf(db, combatant);
  return sheet !== null && hasFeature(sheet, 'champion-survivor');
}

/** Defy Death's second half: an 18 or better on the die is the 20 that puts them back on their feet. */
const countsAsTwenty = (pre: PreRoll & { output: string }): PreRoll & { output: string } =>
  (pre.natural ?? pre.total) >= 18 ? { total: 20, natural: 20, output: `${pre.output} - an 18+ counts as a 20 (Survivor)` } : pre;

/**
 * Survivor's Defy Death, when the server rolls: the death save is made with Advantage, and an 18 or
 * better counts as the 20 that puts them back on their feet. The roll is handed on as a pre-roll.
 */
function defyDeath(db: Db, encounter: EncounterRow, combatant: Combatant): (PreRoll & { output: string }) | undefined {
  if (!defiesDeath(db, combatant)) return undefined;
  // Every roll handed to deathSave carries its own exhaustion, because deathSave only applies the
  // penalty to a roll it made itself.
  const tired = exhaustionPenalty(sheetOf(db, combatant)?.exhaustion ?? 0);
  const rolled = rollDice(tired ? `1d20${tired}` : '1d20', {
    advantage: 'advantage',
    dc: 10,
    roll_type: 'save',
    luck_bias: pcLuck(db, encounter, combatant),
  });
  const natural = rolled.natural_d20 ?? rolled.total;
  return countsAsTwenty({ total: rolled.total, natural, output: `${rolled.output} with Advantage (Survivor)` });
}

/** A downed PC or companion rolls a death save at the start of its turn, by the same SRD rules. */
async function rollDeathSave(db: Db, encounter: EncounterRow, combatant: Combatant): Promise<CombatLogEntry> {
  // Survivor holds whoever makes the roll: the player's card carries the Advantage and the 18+ rule too.
  const survivor = defiesDeath(db, combatant);
  // The character's death save takes exhaustion off the total, so the card has to show it or the
  // window judges the bare face and calls a failed save a success.
  const tired = exhaustionPenalty(sheetOf(db, combatant)?.exhaustion ?? 0);
  const clicked = await askPlayer(db, encounter, combatant, 'death_save', {
    tool: 'advance_turn',
    expr: tired ? `1d20${tired}` : '1d20',
    purpose: survivor ? 'Death saving throw (Survivor: Advantage, an 18+ counts as a 20)' : 'Death saving throw',
    roll_type: 'save',
    dc: 10,
    ...(survivor ? { advantage: 'advantage' as const } : {}),
  });
  const pre = clicked
    ? survivor
      ? countsAsTwenty(clicked)
      : clicked
    : defyDeath(db, encounter, combatant);
  const characterId = characterOf(combatant);
  if (characterId) {
    const result = pcDeathSave(db, {
      campaign_id: encounter.campaign_id,
      character_id: characterId,
      mirror: false,
      roll: pre && { total: pre.total, natural_d20: pre.natural ?? null },
    });
    mirrorCharacter(db, combatant);
    saveCombatant(db, combatant);
    return logCombat(db, encounter, {
      actor_id: combatant.id,
      kind: 'death_save',
      payload: result,
      text: `${combatant.name} rolls a death save: ${result.result} (${result.successes} successes, ${result.failures} failures).`,
    });
  }
  // Only the player character's death save is ever clicked, so the companion branch always rolls here.
  // Only a monster reaches here, and a monster carries no sheet, so there is no exhaustion to apply.
  const roll = rollDice('1d20', { roll_type: 'save', dc: 10, luck_bias: pcLuck(db, encounter, combatant) });
  const natural = roll.natural_d20 ?? roll.total;
  let outcome: string;
  if (natural === 20) {
    outcome = 'critical_success';
    combatant.hp_current = 1;
    combatant.death_saves = { successes: 0, failures: 0 };
    combatant.conditions = combatant.conditions.filter((c) => c !== 'unconscious');
  } else if (natural === 1) {
    outcome = 'critical_failure';
    combatant.death_saves.failures += 2;
  } else if (roll.total >= 10) {
    outcome = 'success';
    combatant.death_saves.successes += 1;
  } else {
    outcome = 'failure';
    combatant.death_saves.failures += 1;
  }
  if (combatant.death_saves.failures >= 3) combatant.alive = false;
  if (combatant.death_saves.successes >= 3) {
    combatant.death_saves = { successes: 0, failures: 0 };
    // Three successes leave it stable at 0 HP: advance_turn rolls no more death saves until damage lands.
    combatant.flags = { ...combatant.flags, stable: true };
  }
  saveCombatant(db, combatant);
  return logCombat(db, encounter, {
    actor_id: combatant.id,
    kind: 'death_save',
    payload: { roll: roll.total, natural, outcome, death_saves: combatant.death_saves, alive: combatant.alive },
    text: `${combatant.name} rolls ${roll.total} on a death save: ${outcome} (${combatant.death_saves.successes} successes, ${combatant.death_saves.failures} failures).`,
  });
}

export async function advanceTurn(db: Db, campaignId: number, rolls?: Record<string, PreRoll>) {
  return underSnapshot(db, requireEncounter(db, campaignId), 'advance_turn', () => runAdvanceTurn(db, campaignId, rolls));
}

async function runAdvanceTurn(db: Db, campaignId: number, rolls?: Record<string, PreRoll>) {
  const encounter = requireEncounter(db, campaignId);
  const combatants = listCombatants(db, encounter.id);
  if (combatants.length === 0) throw new Error('This encounter has no combatants.');
  const current = activeCombatant(combatants, encounter.turn_index);
  const log: CombatLogEntry[] = [];

  if (current) {
    log.push(...(await tickEffects(db, encounter, current.id, 'end', rolls)));
    // Help runs out when the creature it was given to has had its turn.
    const helped = getCombatant(db, encounter.id, current.id);
    if (helped.flags.helped_by || helped.flags.cleave_ready || helped.flags.persistent_rage_offered) {
      // Cleave follows a hit from this turn, so the opening it left closes with the turn; so does the
      // Persistent Rage the Barbarian was offered when Initiative was rolled.
      helped.flags = { ...helped.flags, helped_by: undefined, cleave_ready: undefined, persistent_rage_offered: undefined };
      saveCombatant(db, helped);
    }
    log.push(...expireMastery(db, encounter, helped, 'end'));
    log.push(...expireSourceRiders(db, encounter, helped, 'end'));
    log.push(...featureTurnEdge(db, encounter, helped, 'end'));
    log.push(...checkGrapples(db, encounter));
    log.push(
      logCombat(db, encounter, {
        actor_id: current.id,
        kind: 'turn_end',
        payload: { round: encounter.round },
        text: `${current.name} ends their turn.`,
      }),
    );
  }

  let index = encounter.turn_index;
  let round = encounter.round;
  let next: Combatant | null = null;
  const passedOver: Combatant[] = [];
  for (let step = 0; step < combatants.length; step += 1) {
    index += 1;
    if (index >= combatants.length) {
      index = 0;
      round += 1;
    }
    const candidate = listCombatants(db, encounter.id)[index];
    if (candidate?.alive) {
      next = candidate;
      break;
    }
    if (candidate) passedOver.push(candidate);
  }
  db.prepare('UPDATE encounter SET turn_index = ?, round = ? WHERE id = ?').run(index, round, encounter.id);
  const moved = refresh(db, encounter.id);
  clearOncePerTurn(db, moved);
  if (round !== encounter.round) {
    log.push(
      logCombat(db, moved, {
        kind: 'round',
        payload: { round },
        text: `Round ${round} begins.`,
      }),
    );
  }
  // Sap and Slow run off the attacker's turn slot, which comes round even when the attacker is dead.
  for (const gone of passedOver) log.push(...expireMastery(db, moved, gone, 'start'));
  if (!next) {
    return finish(db, moved, 'advance_turn', 'Nobody is left standing.', log, { active: null, legal_actions: [] });
  }

  // An expiry for a slot just passed over may have lifted something off the creature whose turn this is.
  next = getCombatant(db, moved.id, next.id);

  // Slow takes its 10 ft off the movement this turn opens with, until the attacker's turn comes round.
  const slowed = next.flags.slowed_by?.ft ?? 0;
  next.movement_left = speedZeroBy(next.conditions).length > 0 ? 0 : Math.max(0, next.speed - slowed);
  next.action_used = false;
  next.bonus_used = false;
  next.reaction_used = false;
  next.flags = turnFlags(next.flags);
  saveCombatant(db, next);
  log.push(...expireMastery(db, moved, next, 'start'));
  log.push(...expireSourceRiders(db, moved, next, 'start'));

  log.push(...(await tickEffects(db, moved, next.id, 'start', rolls)));
  const refreshed = getCombatant(db, moved.id, next.id);
  // A stabilised character lies there; the character package clears that flag when damage lands again.
  // A knocked-out monster carries the same flag on its own row.
  const stable = sheetOf(db, refreshed)?.stable ?? refreshed.flags.stable === true;
  if (refreshed.alive && refreshed.hp_current === 0 && !stable) log.push(await rollDeathSave(db, moved, refreshed));

  let actor = getCombatant(db, moved.id, next.id);
  log.push(...(await auraTurnDamage(db, moved, actor)));
  actor = getCombatant(db, moved.id, next.id);
  log.push(...featureTurnEdge(db, moved, actor, 'start'));
  log.push(
    logCombat(db, moved, {
      actor_id: actor.id,
      kind: 'turn_start',
      payload: { round, turn_index: index },
      text: `Round ${round}: ${actor.name}'s turn (${actor.movement_left} ft of movement).`,
    }),
  );

  const actions = legalActions(actor, sheetOf(db, actor), false);
  return finish(db, moved, 'advance_turn', `${actor.name}'s turn (round ${round}).`, log, {
    active: { id: actor.id, name: actor.name, team: actor.team, kind: actor.kind, hp_current: actor.hp_current },
    round,
    turn_index: index,
    legal_actions: actions,
  });
}

// --- taking one call back ---------------------------------------------------

/** Reverts the last mutating combat call: combatants, effects, sheets and the turn go back as they were. */
export function undoLastCombatAction(db: Db, campaignId: number) {
  const encounter = activeEncounter(db, campaignId);
  if (!encounter) {
    throw new Error(
      `Campaign ${campaignId} has no active encounter. Ending a fight cannot be undone, and neither can starting one - open a new fight with start_encounter.`,
    );
  }
  const entry = lastSnapshot(db, encounter.id);
  if (!entry) {
    throw new Error(
      `Nothing to undo in encounter ${encounter.id}: no combat tool has run since it started, and starting a fight itself cannot be undone (end_encounter closes it instead).`,
    );
  }
  const sheets = restoreSnapshot(db, encounter.id, entry.snapshot);
  dropSnapshot(db, entry.id);
  const restored = refresh(db, encounter.id);
  // What the call left in the log, named so the window can strike it through and the DM's tail can drop it.
  const lastLogId = (
    db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM combat_log WHERE encounter_id = ?').get(encounter.id) as {
      id: number;
    }
  ).id;
  const reverted =
    entry.snapshot.log_from !== undefined && lastLogId >= entry.snapshot.log_from
      ? { from: entry.snapshot.log_from, to: lastLogId }
      : null;
  const log = [
    logCombat(db, restored, {
      kind: 'undo',
      payload: {
        tool: entry.tool,
        round: restored.round,
        turn_index: restored.turn_index,
        ...(reverted ? { reverted_log_ids: reverted } : {}),
      },
      text: `Undo: ${entry.tool} is taken back; the fight stands as it did before that call.`,
    }),
  ];
  // The character tools announce every sheet change, so the undo of one announces it going back.
  for (const sheet of sheets) {
    logEvent(db, {
      campaign_id: encounter.campaign_id,
      kind: 'undo',
      text: `${sheet.name} is back at ${sheet.hp_current}/${sheet.hp_max} HP (${entry.tool} undone).`,
      payload: { character_id: sheet.id, tool: entry.tool, hp_current: sheet.hp_current, status: sheet.status },
    });
  }
  // The player's undo button reads this answer as well, so it carries the player's battle state.
  return finish(
    db,
    restored,
    'undo_last_combat_action',
    `${entry.tool} undone.`,
    log,
    {
      undone: entry.tool,
      encounter_id: encounter.id,
      ...(reverted ? { reverted_log_ids: reverted } : {}),
    },
    true,
  );
}

// --- ending -----------------------------------------------------------------

export interface CombatantSummary {
  id: number;
  name: string;
  team: Team;
  damage_dealt: number;
  damage_taken: number;
  healed: number;
  alive: boolean;
}

export function endEncounter(
  db: Db,
  input: { campaign_id: number; outcome: 'victory' | 'retreat' | 'defeat' | 'other'; summary?: string },
) {
  const encounter = requireEncounter(db, input.campaign_id);
  const combatants = listCombatants(db, encounter.id);
  // What an undo took back never happened, so the totals leave those rows out as the window already does.
  const entries = combatLog(db, encounter.id, { omitReverted: true });

  const summaries = new Map<number, CombatantSummary>(
    combatants.map((c) => [
      c.id,
      { id: c.id, name: c.name, team: c.team, damage_dealt: 0, damage_taken: 0, healed: 0, alive: c.alive },
    ]),
  );
  for (const entry of entries) {
    const payload = entry.payload as { applied?: number; amount?: number; result?: { applied?: number } } | null;
    // An effect tick carries its damage under result, and its actor is whoever left the effect behind.
    const applied = entry.kind === 'effect_tick' ? payload?.result?.applied : payload?.applied;
    if ((entry.kind === 'damage' || entry.kind === 'effect_tick') && applied) {
      if (entry.target_id) summaries.get(entry.target_id)!.damage_taken += applied;
      if (entry.actor_id) summaries.get(entry.actor_id)!.damage_dealt += applied;
    }
    if (entry.kind === 'heal' && payload?.amount && entry.target_id) {
      summaries.get(entry.target_id)!.healed += payload.amount;
    }
  }

  // Nothing outlives the fight it was cast in.
  for (const effect of listEffects(db, encounter.id)) endEffect(db, encounter, effect);
  for (const c of listCombatants(db, encounter.id)) {
    if (!c.flags.sapped_by && !c.flags.slowed_by && !c.flags.vex_against && !c.flags.cleave_ready) continue;
    c.flags = { ...c.flags, sapped_by: undefined, slowed_by: undefined, vex_against: undefined, cleave_ready: undefined };
    saveCombatant(db, c);
  }

  // Standing up costs nothing once the fight is over, so nobody walks away prone.
  const stoodUp: string[] = [];
  for (const c of listCombatants(db, encounter.id)) {
    if (c.team !== 'party' || c.character_id === null || !c.alive) continue;
    if (!c.conditions.includes('prone') || c.conditions.includes('unconscious')) continue;
    setPcCondition(db, {
      campaign_id: input.campaign_id,
      character_id: c.character_id,
      condition: 'prone',
      active: false,
      mirror: false,
    });
    stoodUp.push(c.name);
  }

  const defeated = combatants.filter((c) => c.team === 'enemy' && !c.alive);
  const xp = defeated.reduce((sum, c) => sum + xpForCr(c.stat_block?.cr ?? 0), 0);
  const ts = nowIso();
  db.prepare('UPDATE encounter SET status = ?, ended_at = ?, outcome = ? WHERE id = ?').run(
    'ended',
    ts,
    input.outcome,
    encounter.id,
  );

  const text = `Encounter ${encounter.id} ends in ${input.outcome}${input.summary ? `: ${input.summary}` : ''}.`;
  const log = [
    logCombat(db, encounter, {
      kind: 'encounter_end',
      payload: { outcome: input.outcome, xp_suggestion: xp, defeated: defeated.map((c) => c.name) },
      text,
    }),
  ];
  const ended = refresh(db, encounter.id);
  // The companion UI reads the same numbers off the event, so the payload carries the whole summary.
  const summary = {
    rounds: encounter.round,
    defeated: defeated.map((c) => ({ name: c.name, cr: c.stat_block?.cr ?? 0, xp: xpForCr(c.stat_block?.cr ?? 0) })),
    xp_suggestion: xp,
    combatants: [...summaries.values()],
  };
  logEvent(db, {
    campaign_id: input.campaign_id,
    kind: 'combat',
    text,
    payload: {
      tool: 'end_encounter',
      encounter_id: encounter.id,
      log: logFor(db, input.campaign_id, log),
      state: battleState(db, ended),
      summary,
    },
  });

  return {
    encounter_id: encounter.id,
    outcome: input.outcome,
    ...summary,
    stood_up: stoodUp,
    summary: input.summary ?? null,
    log,
    // The DM's copy names the gear truly; the event above keeps the player's mask.
    state: battleState(db, ended, false),
    reminder: 'XP is a suggestion: call xp {op: award} yourself if the party earned it, then checkpoint {op: save}.',
  };
}
