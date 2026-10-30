import type { CallToolResult } from '@modelcontextprotocol/server';
import { combatSheet } from '../combat/sheet.js';
import type { BattleState, CombatLogEntry } from '../combat/state.js';
import { getSettings } from '../core/settings.js';
import type { Db } from '../db/connection.js';

/** One-line DM-only reminders, set beside the result a playtest showed the DM slipping on; only tool reply text carries them. */
export const CUE = {
  hiddenDc: 'Hidden DC: say success or failure, never the DC, AC or margin.',
  showSuccess: 'Show in the scene what the success revealed before summarising.',
  narrateAttack: 'Narrate this hit or miss and its effect first, before any enemy turn.',
  playerTurn: "Player's turn: one narration, one question; options only if stuck; no tool talk.",
  dying: (name: string): string => `${name} is dying: narrate this death save to the player and stop here.`,
};

/** A roll with no campaign reads the default, which hides the DC. */
const dcHidden = (db: Db, campaignId: number | undefined): boolean =>
  campaignId === undefined || getSettings(db, campaignId).dc_disclosure !== 'shown';

/** The cues a roll against a DC earns: the hidden-DC line, and the show-it line on a won check. */
export function rollCues(
  db: Db,
  campaignId: number | undefined,
  dc: number | null | undefined,
  check: boolean,
  outcome: unknown,
): string[] {
  if (dc === undefined || dc === null) return [];
  return [
    ...(dcHidden(db, campaignId) ? [CUE.hiddenDc] : []),
    ...(check && outcome === 'success' ? [CUE.showSuccess] : []),
  ];
}

/** Appends cue lines to a reply's text. */
export function withCues(result: CallToolResult, cues: string[]): CallToolResult {
  if (!cues.length) return result;
  const body = result.content[0] as { type: 'text'; text: string };
  body.text = `${body.text}\n\n${cues.join('\n')}`;
  return result;
}

/** The cues a combat reply earns: a party attack or save in its log, or the player character dying on their turn. */
export function turnCues(db: Db, campaignId: number, state: BattleState, log: CombatLogEntry[]): string[] {
  const party = (id: number | null): boolean =>
    state.combatants.some((c) => c.id === id && (c.kind === 'pc' || c.kind === 'companion'));
  const attacked = log.some((e) => e.kind === 'attack' && party(e.actor_id));
  const saved = log.some((e) => e.kind === 'save' && party(e.target_id));
  const pc = state.combatants.find((c) => c.kind === 'pc');
  const dying =
    pc !== undefined &&
    pc.alive &&
    pc.hp_current === 0 &&
    pc.character_id !== null &&
    (state.active?.id === pc.id || log.some((e) => e.kind === 'death_save' && e.actor_id === pc.id)) &&
    !combatSheet(db, pc.character_id).stable;
  return [
    ...(attacked ? [CUE.narrateAttack] : []),
    ...((attacked || saved) && dcHidden(db, campaignId) ? [CUE.hiddenDc] : []),
    ...(dying ? [CUE.dying(pc.name)] : []),
  ];
}
