// Combat engine: feature actions and the generic use-action resolver.
import { rollAndRecord } from '../core/campaign.js';
import {
  grantInspiration,
  grantInspirationDie,
  heal as healPc,
  restoreFeatureResource,
  restoreSpellSlot,
  setTempHp as setPcTempHp,
  spendFeatureResource,
  useSpellSlot,
} from '../core/character.js';
import { type Advantage } from '../core/dice.js';
import { customSpellAction, findHomebrewSpell } from '../core/progression.js';
import { SKILL_KEYS, type Ability } from '../core/rules.js';
import { findSpell } from '../srd/lookup.js';
import type { Db } from '../db/connection.js';
import { actionsFor, isAttack, STANDARD_ACTIONS } from './actions.js';
import { rulesOf } from './conditions.js';
import {
  auraHalfCover,
  classFeatures,
  allFeatureActionIds,
  featureActionIds,
  findFeatureAction,
  hasEvasion,
  hasFeature,
  healRiders,
  isRaging,
  isWildShaped,
  resourceMax,
  resourceSpec,
  saveMitigation,
  saveSucceededOutcomes,
  damageTakenOutcomes,
  spellDamageRiders,
  type CastOptions,
  type FeatureAction,
  type FeatureCost,
  type FeatureHandler,
  type FeatureOutcome,
  type HitRider,
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
import { combatSheet, sheetAbilityMod, type CombatSheet } from './sheet.js';
import { boostsFor, type ClauseCtx } from './homebrew.js';
import { underSnapshot } from './undo.js';
import {
  encounterMap,
  getCombatant,
  listCombatants,
  logCombat,
  requireEncounter,
  saveCombatant,
  type Combatant,
  type CombatLogEntry,
  type EncounterRow,
} from './state.js';
import {
  ATTACK_HOOKS,
  CAST_HOOKS,
  spentSlotThisTurn,
  type PreRoll,
  type RollOutcome,
  signed,
  partyHp,
  finish,
  sheetOf,
  auraSources,
  pcLuck,
  immuneTo,
} from './engine-core.js';
import {
  requireTurn,
  requireEconomy,
  spendResource,
  requireReaction,
  reactionText,
  spendFeatureCost,
  spendChosenBoosts,
  requireSlot,
  requireSlotLevel,
  requireResource,
  grantSurgedAction,
} from './resources.js';
import {
  rollHealing,
  maximumDamage,
  criticalExpr,
  rollDamage,
  damageLinesOf,
  damageTypeNote,
  type DamageResult,
} from './damage-math.js';
import { d20Context, rollD20, askPlayer, type SaveResult, rollSave } from './d20.js';
import {
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
  killEntry,
  attachEffect,
} from './effects.js';
import { droppedToZero, afterKill, applyOutcome, remindersOf } from './outcome.js';
import {
  type CastingEconomy,
  type SpellFill,
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
import { crowdedShot } from './movement.js';
import { spendSapVex } from './mastery.js';
import {
  refuseIfIncapacitated,
  standardId,
  revealHidden,
  releaseReady,
  type StandardActionData,
  type StandardActionInput,
  standardAction,
} from './standard-actions.js';
import {
  type RiderRoll,
  rollRiderDamage,
  foldNegativeRiders,
  foldPositiveRidersForHalving,
  applyHitRiders,
} from './riders.js';

/** A class feature with an action of its own: Rage, Second Wind, Flurry of Blows, Lay On Hands. */
async function runFeatureActionCall(
  db: Db,
  encounter: EncounterRow,
  actor: Combatant,
  sheet: CombatSheet,
  found: { handler: FeatureHandler; action: FeatureAction; option?: string },
  input: {
    target_id?: number;
    target_ids?: number[];
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
  const namedIds = [...new Set([...(input.target_id === undefined ? [] : [input.target_id]), ...(input.target_ids ?? [])])];
  const target = namedIds.length === 0 ? null : getCombatant(db, encounter.id, namedIds[0]!);
  const resolveOn = (on: Combatant | null): FeatureOutcome =>
    handler.resolve!({
      sheet,
      actor,
      feature: sheet.features.find((f) => f.name === handler.name) ?? { name: handler.name },
      target: on,
      combatants,
      round: encounter.round,
      action_id: action.id,
      ...(input.amount === undefined ? {} : { amount: input.amount }),
      ...(input.slot_level === undefined ? {} : { slot_level: input.slot_level }),
      ...(input.point === undefined ? {} : { point: input.point }),
      ...(found.option ?? input.option ? { option: found.option ?? input.option! } : {}),
    });
  // Rage is entered once and extended after that, so a second use spends nothing.
  const extending = handler.index === 'barbarian-rage' && isRaging(actor);
  const outcome: FeatureOutcome = extending
    ? {
        economy: 'bonus_action',
        text: `${actor.name} keeps the Rage going for another round.`,
        flags: { raging: { ...actor.flags.raging!, extended_round: encounter.round } },
      }
    : resolveOn(target);

  if (outcome.action_effect) {
    // The clause's `if` holds for every named target, not just the first: resolve refuses the one it rules out.
    for (const id of namedIds.slice(1)) resolveOn(getCombatant(db, encounter.id, id));
    return runGenericUseAction(db, {
      campaign_id: encounter.campaign_id,
      actor_id: actor.id,
      action_name: action.name,
      ...(input.target_id === undefined ? {} : { target_id: input.target_id }),
      ...(input.target_ids === undefined ? {} : { target_ids: input.target_ids }),
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
    if (outcome.flags.action_surged) grantSurgedAction(actor, sheet);
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
          text: `${who.name} takes ${result.applied} ${forced.damage_type ?? ''} damage (${rolled.output}${
            result.resistance ? `, ${result.resistance}` : ''
          })${partyHp(who, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
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
          text: `${forced.extra_note ?? action.name}: ${who.name} takes ${result.applied} ${forced.extra_type ?? ''} damage (${rolled.output}${
            result.resistance ? `, ${result.resistance}` : ''
          })${partyHp(who, ` - ${result.hp_current}/${result.hp_max} HP`)}.`,
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
      payload: {
        feature: handler.index,
        action: action.id,
        ...(outcome.notes ? { notes: outcome.notes } : {}),
        ...(outcome.dm_note ? { dm_note: outcome.dm_note } : {}),
      },
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
        text: `${actor.name} throws the deflected force at ${target.name}, who fails a DEX save (${save.total} vs DC ${dc}) and takes ${damage.applied} (${rolled.output}${
          damage.resistance ? `, ${damage.resistance}` : ''
        })${partyHp(target, ` - ${damage.hp_current}/${damage.hp_max} HP`)}.`,
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

/** Refuses use_action "release_ready", naming the out-of-turn call that does release a readied action. */
function refuseReleaseReady(actor: Combatant, sheet: CombatSheet | null): never {
  const ready = actor.flags.ready;
  if (!ready) {
    throw new Error(
      `${actor.name} has nothing readied. Ready it on their own turn with use_action {action_name: "ready", trigger, readied_action}, then release it with attack or use_action and out_of_turn: true, reason.`,
    );
  }
  const weapon = actionsFor(actor, sheet).find((a) => isAttack(a) && ready.action.toLowerCase().includes(a.name.toLowerCase()));
  throw new Error(
    `There is no release action: ${actor.name}'s readied ${ready.action} goes off as itself, out of turn, and spends the reaction. Call attack {attacker_id: ${actor.id}, target_id, action_name: "${weapon?.name ?? '<weapon>'}", out_of_turn: true, reason: "${ready.trigger}"}, or use_action {actor_id: ${actor.id}, action_name: "<the action or spell>", out_of_turn: true, reason} for anything but an attack.`,
  );
}

/** The self-healing features the SRD lets a character take with no fight running. */
const OUTSIDE_COMBAT = ['second_wind', 'wholeness_of_body'];

/** A self-healing feature taken with no encounter: the use comes off the sheet and the healing lands on the character. */
export function useFeatureOutsideCombat(db: Db, input: { campaign_id: number; actor_id: number; action_name: string }) {
  const wanted = input.action_name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!OUTSIDE_COMBAT.includes(wanted)) requireEncounter(db, input.campaign_id);
  const sheet = combatSheet(db, input.actor_id);
  if (sheet.campaign_id !== input.campaign_id) {
    throw new Error(`Campaign ${input.campaign_id} has no character with id ${input.actor_id}; outside a fight actor_id is the character id.`);
  }
  const found = findFeatureAction(sheet, wanted);
  if (!found) throw new Error(`${sheet.name} has no ${input.action_name} to use.`);
  if (sheet.status === 'dead' || sheet.hp_current === 0) throw new Error(`${sheet.name} is down and cannot act; heal them first with hp {op: heal}.`);
  // Second Wind and Wholeness of Body read only the taker's name and speed, so a stand-in combatant does.
  const actor = { name: sheet.name, speed: sheet.speed, flags: {}, conditions: sheet.conditions } as unknown as Combatant;
  refuseIfIncapacitated(actor);
  const outcome = found.handler.resolve!({
    sheet,
    actor,
    feature: sheet.features.find((f) => f.name === found.handler.name) ?? { name: found.handler.name },
    target: null,
    combatants: [],
    round: 0,
    action_id: found.action.id,
  });
  const cost = outcome.spend as FeatureCost;
  requireResource(sheet, actor, cost, found.action.name);
  const spec = resourceSpec(sheet, cost.resource);
  return db.transaction(() => {
    const spent = spendFeatureResource(db, {
      campaign_id: input.campaign_id,
      character_id: sheet.id,
      resource: cost.resource,
      amount: cost.amount,
      ...(spec ? { label: spec.label, max: spec.max, per: spec.per } : {}),
    });
    const rolled = rollAndRecord(db, { expr: outcome.heal_expr!, purpose: found.action.name, campaign_id: input.campaign_id });
    const healed = healPc(db, { campaign_id: input.campaign_id, character_id: sheet.id, amount: Math.max(1, rolled.total) });
    return {
      name: sheet.name,
      action: found.action.id,
      text: outcome.text,
      roll: rolled.output,
      healed: healed.healed,
      hp_current: healed.hp_current,
      hp_max: healed.hp_max,
      uses_left: spent.left,
      uses_max: spent.max,
    };
  })();
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
    /** Every creature a multi-target spell reaches, "up to three creatures"; target_id may name one of them. */
    target_ids?: number[];
    /** Guidance: the skill it helps. Resistance: the damage type it reduces. */
    choice?: string;
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
  if (!actor.alive || actor.hp_current === 0) throw new Error(`${actor.name} is down and cannot act; heal them first with hp {op: heal}, or advance_turn past them.`);
  refuseIfIncapacitated(actor);
  requireTurn(db, encounter, actor, input.out_of_turn);
  const sheet = sheetOf(db, actor);
  const wantedFeature = input.action_name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  // The Deflect Attacks redirect rides on the reaction already spent on the deflection, not on a new one.
  if (wantedFeature === 'deflect_redirect') return await runDeflectRedirect(db, encounter, actor, sheet, input);
  // A readied action goes off as the action it is, out of turn: there is no release action of its own.
  if (wantedFeature === 'release_ready') refuseReleaseReady(actor, sheet);
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

/** "Up to three creatures", plus "one additional creature for each spell slot level above N": what one casting may name. */
function spellTargetCap(spell: SpellFill): { cap: number; upcasts: boolean } {
  const entry = findSpell(spell.name);
  // Hold Person counts Humanoids and Animal Friendship Beasts, where the rest count creatures.
  const base = entry?.desc.match(/\bup to\s+(two|three|four|five|six|\d+)\s+(?:creature|humanoid|beast)s?\b/i);
  const more = entry?.higher_level?.match(/one additional (?:creature|humanoid|beast) for each spell slot level above (\d+)/i);
  const slot = spell.slot_level ?? spell.level;
  return {
    cap: (base ? (COUNT_WORDS[base[1]!.toLowerCase()] ?? Number(base[1])) : 1) + (more ? Math.max(0, slot - Number(more[1])) : 0),
    upcasts: Boolean(more),
  };
}

const RESISTANCE_TYPES = ['acid', 'bludgeoning', 'cold', 'fire', 'lightning', 'necrotic', 'piercing', 'poison', 'radiant', 'slashing', 'thunder'];

/** The effect Bless, Bane, Guidance or Resistance leaves on each target, named the way the d20 and damage rules read it. */
function bonusDieEffect(spell: string, choice: string | undefined): Omit<EffectInput, 'target_id'> | undefined {
  const held = { kind: 'buff' as const, tick: 'end' as const, ends: 'concentration' as const };
  if (/^(bless|bane)$/i.test(spell)) return { ...held, name: spell };
  const wanted = (choice ?? '').trim().toLowerCase();
  const given = choice ? `, and "${choice}" is not one` : '';
  if (/^guidance$/i.test(spell)) {
    const skill = SKILL_KEYS.find((key) => key.replace(/_/g, '') === wanted.replace(/[^a-z]/g, ''));
    if (!skill) throw new Error(`Guidance helps one skill${given}: pass choice with one of ${SKILL_KEYS.join(', ')}.`);
    return { ...held, name: `Guidance (${skill.replace(/_/g, ' ')})` };
  }
  if (/^resistance$/i.test(spell)) {
    if (!RESISTANCE_TYPES.includes(wanted)) {
      throw new Error(`Resistance guards one damage type${given}: pass choice with one of ${RESISTANCE_TYPES.join(', ')}.`);
    }
    return { ...held, name: 'Resistance', damage_type: wanted };
  }
  return undefined;
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
  const namedIds = [...new Set([...(input.target_id === undefined ? [] : [input.target_id]), ...(input.target_ids ?? [])])];
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
  } else {
    targets = namedIds.map((id) => getCombatant(db, encounter.id, id));
  }
  if (namedIds.length > 1 && !input.point) {
    const { cap, upcasts } = spell ? spellTargetCap(spell) : { cap: custom?.targets ?? 1, upcasts: false };
    if (namedIds.length > cap) {
      const over = namedIds.length - cap;
      if (!spell) {
        throw new Error(`${input.action_name} reaches ${cap} creature${cap === 1 ? "" : "s"} and ${namedIds.length} are named: re-call with ${over} fewer target_ids.`);
      }
      const upcast = upcasts ? ', or pass a higher slot_level for one more per level' : '';
      throw new Error(
        `${spell.name} reaches up to ${cap} creature${cap === 1 ? "" : "s"} with a level ${spell.slot_level ?? spell.level} slot and ${namedIds.length} are named: re-call with ${over} fewer target_ids${upcast}.`,
      );
    }
  }
  if (custom) {
    if (shape && !input.point) throw new Error(`${input.action_name} has a ${shape.kind} area: pass point for its origin.`);
    if (input.point && !shape) throw new Error(`${input.action_name} has no area shape, so point cannot place it.`);
    const needsTarget = custom.kind !== 'utility' || custom.effect !== undefined;
    if (needsTarget && targets.length === 0) throw new Error(`${input.action_name} needs target_id${shape ? ' or point' : ''}.`);
    if (custom?.targets !== undefined && targets.length > custom.targets) {
      throw new Error(`${input.action_name} affects at most ${custom.targets} target${custom.targets === 1 ? '' : 's'}; this point reaches ${targets.length}.`);
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
  const surgedNext = actor.flags.surge_action_pending || (actor.action_used && actor.flags.surge_action_banked);
  if (economy !== null && spends === 'action' && !input.out_of_turn && surgedNext) {
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
  // Bless, Bane, Guidance and Resistance leave the effect their dice are read from, unless the DM passed one.
  const bonusDie = spell && !input.effect ? bonusDieEffect(spell.name, input.choice) : undefined;
  const ongoing: Omit<EffectInput, 'target_id'> | undefined = fromSpell ?? custom?.effect ?? markEffect ?? bonusDie;

  // Range is checked before the slot is spent: a cast the engine refuses must cost nothing.
  const reachOfSpell = plan?.range_ft ?? spell?.range_ft ?? null;
  if (reachOfSpell !== null && spell) {
    const reaches = input.point
      ? [{ who: 'the target', reach: distanceToPoint(actor, input.point) }]
      : namedIds.map((id) => {
          const one = getCombatant(db, encounter.id, id);
          return { who: namedIds.length > 1 ? one.name : 'the target', reach: distanceBetween(actor, one) };
        });
    const far = reaches.find((one) => one.reach > reachOfSpell);
    if (far) {
      throw new Error(`${spell.name} reaches ${reachOfSpell} ft and ${far.who} is ${far.reach} ft away; move closer first.`);
    }
  }
  if (declaredEffect?.range_ft !== null && declaredEffect?.range_ft !== undefined && targets.length > 0) {
    const reachOfEffect = declaredEffect.range_ft;
    const reaches = input.point
      ? [{ who: 'the target', reach: distanceToPoint(actor, input.point) }]
      : targets.map((one) => ({ who: targets.length > 1 ? one.name : 'the target', reach: distanceBetween(actor, one) }));
    const far = reaches.find((one) => one.reach > reachOfEffect);
    if (far) {
      throw new Error(`${input.action_name} reaches ${reachOfEffect} ft and ${far.who} is ${far.reach} ft away; move closer first.`);
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
          expr: `1d20${signed(attackBonus)}${attackContext.dice}`,
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
        { advantage: attackContext.advantage, dc: ac, kind: 'attack', luck_bias: pcLuck(db, encounter, actor), dice: attackContext.dice },
        pre,
      );
      let landed = rolled.natural === 20 || (rolled.natural !== 1 && rolled.total >= ac);
      // Seeking Spell: a missed spell attack roll is rolled again once, and the new roll stands.
      if (!landed && plan?.reroll_attack) {
        const again = await askPlayer(db, encounter, actor, 'attack', {
          tool: 'use_action',
          expr: `1d20${signed(attackBonus)}${attackContext.dice}`,
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
            dice: attackContext.dice,
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
