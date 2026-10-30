// The combat engine: initiative, movement, attacks, saves, damage, effects, turns and the fight log.
import { logEvent } from '../core/campaign.js';
import { setCondition as setPcCondition } from '../core/character.js';
import type { Db } from '../db/connection.js';
import { logFor } from './log-view.js';
import { anchorMechanics } from './sheet.js';

import { dropSnapshot, lastSnapshot, restoreSnapshot } from './undo.js';
import {
  activeEncounter,
  battleState,
  combatLog,
  listCombatants,
  listEffects,
  logCombat,
  requireEncounter,
  saveCombatant,
  type Team,
} from './state.js';
import { nowIso, xpForCr, refresh, finish } from './engine-core.js';
import { endEffect } from './effects.js';
export { useAction } from './use-action.js';
export { advanceTurn } from './turns.js';
export { attack } from './attack.js';
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
