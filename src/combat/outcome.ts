// Combat engine: applying feature outcomes and dropping a creature to zero.
import { pcRow } from '../core/campaign.js';
import {
  grantInspiration,
  restoreFeatureResource,
  setTempHp as setPcTempHp,
} from '../core/character.js';
import type { Db } from '../db/connection.js';
import { killOutcomes, type FeatureOutcome } from './features.js';
import { distanceBetween } from './grid.js';
import { combatSheet, type CombatSheet } from './sheet.js';
import {
  getCombatant,
  listCombatants,
  logCombat,
  saveCombatant,
  type Combatant,
  type CombatLogEntry,
  type EncounterRow,
} from './state.js';
import { grantSurgedAction, spendFeatureCost } from './resources.js';
import { rollHealing, rollDamage } from './damage-math.js';
import { mirrorCharacter, refreshVitals, healCombatant, dropCondition } from './hp.js';
import { killEntry, attachEffect } from './effects.js';

/**
 * A creature reaching 0 hit points is something features key off: Dark One's Blessing pays whoever
 * struck the blow, and whoever was standing within 10 ft of it. Asked of every character on the field.
 */
export function droppedToZero(db: Db, encounter: EncounterRow, victim: Combatant, killer: Combatant | null): CombatLogEntry[] {
  const entries: CombatLogEntry[] = [];
  for (const combatant of listCombatants(db, encounter.id)) {
    if (!combatant.character_id || !combatant.alive || combatant.hp_current === 0 || combatant.id === victim.id) continue;
    const sheet = combatSheet(db, combatant.character_id);
    const outcomes = killOutcomes(sheet, {
      actor: combatant,
      victim,
      distance_ft: distanceBetween(combatant, victim),
      by_me: killer?.id === combatant.id,
    });
    for (const outcome of outcomes) entries.push(...applyOutcome(db, encounter, combatant, sheet, outcome));
  }
  return entries;
}

/** The kill entry and everything a creature dropping to 0 hit points sets off. */
export function afterKill(
  db: Db,
  encounter: EncounterRow,
  victim: Combatant,
  killer: Combatant | null,
  source: string,
): CombatLogEntry[] {
  return [killEntry(db, encounter, victim, source), ...droppedToZero(db, encounter, victim, killer)];
}

/** The why at the end of a reminder line: "Feature: what it says - why it is yours". */
const reasonOf = (line: string): string => {
  const cut = line.lastIndexOf(' - ');
  return cut < 0 ? line : line.slice(cut + 3);
};

/**
 * What a feature's outcome does to the creature it fired on, at the hooks that have no action of their
 * own: Initiative, the two turn edges and a kill. One applier for all three, so no hook quietly runs
 * less than another, and every line the outcome could not run is handed back as a reminder.
 */
export function applyOutcome(
  db: Db,
  encounter: EncounterRow,
  who: Combatant,
  sheet: CombatSheet,
  outcome: FeatureOutcome,
): CombatLogEntry[] {
  let on = getCombatant(db, encounter.id, who.id);
  const inspirationAlreadyHeld =
    outcome.grant_inspiration && on.kind === 'pc' && pcRow(db, encounter.campaign_id)?.inspiration === 1;
  const hasOtherEffect =
    outcome.flags !== undefined ||
    outcome.movement_ft !== undefined ||
    outcome.heal_amount !== undefined ||
    outcome.heal_expr !== undefined ||
    outcome.temp_hp_amount !== undefined ||
    outcome.temp_hp_expr !== undefined ||
    outcome.remove_conditions !== undefined ||
    outcome.self_condition !== undefined ||
    outcome.restore_resource !== undefined ||
    outcome.standard !== undefined ||
    outcome.gain_slot !== undefined ||
    outcome.spend_slot !== undefined ||
    outcome.d20_stance !== undefined ||
    outcome.save !== undefined ||
    outcome.heals !== undefined ||
    outcome.target_flags !== undefined;
  // A held Heroic Inspiration makes its lone grant a no-op, but must not discard a mixed outcome.
  if (inspirationAlreadyHeld && !hasOtherEffect) return [];
  const what = outcome.feature ?? outcome.text;
  const log: CombatLogEntry[] = [];
  for (const cost of outcome.spend ? (Array.isArray(outcome.spend) ? outcome.spend : [outcome.spend]) : []) {
    log.push(spendFeatureCost(db, encounter, on, sheet, cost, what));
  }
  if (outcome.flags) {
    on.flags = { ...on.flags, ...outcome.flags };
    // One more action costs none of this turn's own, exactly as Action Surge is written.
    if (outcome.flags.action_surged) grantSurgedAction(on, sheet);
    saveCombatant(db, on);
    who.flags = on.flags;
  }
  if (outcome.movement_ft) {
    on.movement_left += outcome.movement_ft;
    saveCombatant(db, on);
  }
  const healed = outcome.heal_amount ?? (outcome.heal_expr ? rollHealing(outcome.heal_expr, sheet).total : 0);
  if (healed > 0) {
    healCombatant(db, encounter, on, healed);
    on = getCombatant(db, encounter.id, on.id);
  }
  const temp = outcome.temp_hp_amount ?? (outcome.temp_hp_expr ? rollDamage(outcome.temp_hp_expr, false).total : null);
  if (temp !== null && on.character_id) {
    setPcTempHp(db, {
      campaign_id: encounter.campaign_id,
      character_id: on.character_id,
      amount: temp,
      mirror: false,
    });
    mirrorCharacter(db, on);
    saveCombatant(db, on);
  }
  for (const condition of outcome.remove_conditions ?? []) {
    if (!on.conditions.includes(condition)) continue;
    dropCondition(db, encounter, on, condition);
  }
  // A condition the feature leaves on its own holder, for the rounds its text gives it.
  if (outcome.self_condition) {
    const created = attachEffect(db, encounter, {
      name: outcome.self_condition.name,
      kind: 'condition',
      source_id: on.id,
      tick: 'end',
      ends: 'rounds',
      remaining_rounds: outcome.self_condition.rounds,
      target_id: on.id,
    });
    on.conditions = getCombatant(db, encounter.id, on.id).conditions;
    log.push(created.entry, ...created.landed);
  }
  if (outcome.restore_resource && on.character_id) {
    restoreFeatureResource(db, {
      campaign_id: encounter.campaign_id,
      character_id: on.character_id,
      resource: outcome.restore_resource.key,
      amount: outcome.restore_resource.amount,
    });
  }
  if (outcome.grant_inspiration && !inspirationAlreadyHeld && on.kind === 'pc') {
    grantInspiration(db, { campaign_id: encounter.campaign_id, character_id: on.character_id ?? undefined });
  }
  log.push(
    logCombat(db, encounter, {
      actor_id: on.id,
      kind: 'feature_note',
      payload: {
        feature: outcome.text,
        ...(temp === null ? {} : { temp_hp: temp }),
        ...(outcome.restore_resource ? { resource: outcome.restore_resource } : {}),
      },
      text: outcome.text,
    }),
  );
  // What the clause said and the engine could not run: a fight-log line, never the player's feed.
  for (const line of outcome.notes ?? []) {
    log.push(
      logCombat(db, encounter, {
        actor_id: on.id,
        kind: 'reminder',
        payload: { feature: outcome.feature ?? '', reason: reasonOf(line) },
        text: line,
      }),
    );
  }
  refreshVitals(db, encounter, who);
  return log;
}

/** The clauses a hook could not run, gathered off what it applied, for the reply the DM reads. */
export function remindersOf(applied: Array<Record<string, unknown>>): Array<{ feature: string; text: string; reason: string }> {
  return applied
    .filter((one) => typeof one.reminder === 'string')
    .map((one) => ({ feature: String(one.feature), text: String(one.note ?? ''), reason: String(one.reminder) }));
}
