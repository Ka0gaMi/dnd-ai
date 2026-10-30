// Combat engine core: shared hooks, roll/finish plumbing and small sheet helpers.
import { logEvent } from '../core/campaign.js';
import { luckBiasFor } from '../core/settings.js';
import type { Db } from '../db/connection.js';
import { conditionImmunitiesFrom } from './conditions.js';
import {
  auraConditionImmunities,
  featureConditionImmunities,
  hasFeature,
  isWildShaped,
  ragingConditionImmunities,
  type AuraSource,
} from './features.js';
import { logFor } from './log-view.js';
import { combatSheet, type CombatSheet } from './sheet.js';
import { ROLL_HOOK } from './homebrew.js';
import { RIDER_HOOKS, type ClauseWhen } from '../core/mechanics.js';
import {
  battleState,
  listCombatants,
  type BattleState,
  type Combatant,
  type CombatLogEntry,
  type EncounterRow,
} from './state.js';

/** What one swing may be asked to pay for: the roll itself, and the riders it may carry. */
export const ATTACK_HOOKS: ClauseWhen[] = [...ROLL_HOOK, ...RIDER_HOOKS];

/** What a casting may be asked to pay for: the same list, since a spell's damage carries riders too. */
export const CAST_HOOKS: ClauseWhen[] = [...ATTACK_HOOKS, 'cast'];

export const spentSlotThisTurn = (actor: Combatant): boolean => actor.flags.spent_slot_this_turn === true;

/** A roll the caller already made (a RollDetail fits): WP8 injects player-clicked d20s here. */
export interface PreRoll {
  total: number;
  natural?: number | null;
  natural_d20?: number | null;
  /** The homebrew boosts the player toggled on their own card, by clause key. */
  boosts_chosen?: string[];
}

export interface RollOutcome {
  total: number;
  natural: number | null;
  expr: string;
  output: string;
  injected: boolean;
}

interface Finished {
  log: CombatLogEntry[];
  state: BattleState;
  /** Every clause this call handed back rather than running, whichever hook raised it. */
  reminders?: Array<{ feature: string; text: string; reason: string }>;
}

export const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);
export const nowIso = (): string => new Date().toISOString();

/** A hit-point readout for fight-log text: a party member's, which the player always sees, and nobody else's. */
export const partyHp = (c: Combatant, text: string): string => (c.team === 'party' ? text : '');

/** SRD XP by challenge rating, used only to suggest an award at the end of a fight. */
const XP_BY_CR: Record<string, number> = {
  '0': 10, '0.125': 25, '0.25': 50, '0.5': 100, '1': 200, '2': 450, '3': 700, '4': 1100, '5': 1800,
  '6': 2300, '7': 2900, '8': 3900, '9': 5000, '10': 5900, '11': 7200, '12': 8400, '13': 10000, '14': 11500,
  '15': 13000, '16': 15000, '17': 18000, '18': 20000, '19': 22000, '20': 25000, '21': 33000, '22': 41000,
  '23': 50000, '24': 62000, '25': 75000, '26': 90000, '27': 105000, '28': 120000, '29': 135000, '30': 155000,
};

export const xpForCr = (cr: number): number => XP_BY_CR[String(cr)] ?? 0;

export function refresh(db: Db, encounterId: number): EncounterRow {
  return db.prepare('SELECT * FROM encounter WHERE id = ?').get(encounterId) as EncounterRow;
}

/**
 * Every engine call ends here: it writes one campaign event carrying the player's battle state, and
 * answers with the DM's, true item names and all, unless a player's button made the call.
 */
export function finish<T extends object>(
  db: Db,
  encounter: EncounterRow,
  tool: string,
  text: string,
  log: CombatLogEntry[],
  data: T,
  forPlayer = false,
): T & Finished {
  const row = refresh(db, encounter.id);
  const shown = battleState(db, row);
  logEvent(db, {
    campaign_id: encounter.campaign_id,
    kind: 'combat',
    text,
    payload: { tool, encounter_id: encounter.id, log: logFor(db, encounter.campaign_id, log), state: shown },
  });
  const state = forPlayer ? shown : battleState(db, row, false);
  // A reminder is a fight-log line; every one this call wrote comes back with the reply as well, so a
  // hook deep inside it - a kill, a turn edge, Initiative - is read by whoever made the call.
  const own = (data as { reminders?: Finished['reminders'] }).reminders ?? [];
  const handed = log
    .filter((entry) => entry.kind === 'reminder')
    .map((entry) => ({
      feature: String((entry.payload as { feature?: unknown } | undefined)?.feature ?? ''),
      text: entry.text,
      reason: String((entry.payload as { reason?: unknown } | undefined)?.reason ?? ''),
    }))
    .filter((one) => !own.some((mine) => mine.text === one.text));
  const reminders = [...own, ...handed];
  return { ...data, ...(reminders.length ? { reminders } : {}), log: forPlayer ? logFor(db, encounter.campaign_id, log) : log, state };
}

export function sheetOf(db: Db, combatant: Combatant): CombatSheet | null {
  return combatant.character_id ? combatSheet(db, combatant.character_id) : null;
}

/** Every paladin aura on the field, so a save or a condition can ask whether it is standing inside one. */
export function auraSources(db: Db, encounter: EncounterRow): AuraSource[] {
  const out: AuraSource[] = [];
  for (const combatant of listCombatants(db, encounter.id)) {
    if (!combatant.character_id || !combatant.alive) continue;
    const sheet = combatSheet(db, combatant.character_id);
    const aura =
      hasFeature(sheet, 'paladin-aura-of-protection') ||
      hasFeature(sheet, 'devotion-aura-of-devotion') ||
      hasFeature(sheet, 'paladin-aura-of-courage');
    if (aura) out.push({ actor: combatant, sheet });
  }
  return out;
}

// --- dice seams -------------------------------------------------------------

/** The luck dial, applied to the player character's own d20s in here the way the roll tool applies it. */
export function pcLuck(db: Db, encounter: EncounterRow, combatant: Combatant): number {
  return luckBiasFor(db, encounter.campaign_id, combatant.kind === 'pc');
}

/** The Druid's own sheet when this combatant is one wearing a Beast form, and null for anything else. */
export function wildShapeSheet(db: Db, combatant: Combatant): CombatSheet | null {
  return combatant.stat_block && isWildShaped(combatant) ? sheetOf(db, combatant) : null;
}

/**
 * The conditions a creature is immune to: the stat block's line, the sheet's merged list, what a running
 * Rage keeps off a Berserker, and what a paladin's aura keeps off everyone standing inside it.
 */
function conditionImmunities(db: Db, encounter: EncounterRow, combatant: Combatant): string[] {
  const fromAura = auraConditionImmunities(combatant, auraSources(db, encounter));
  // What the combatant's own conditions keep off it, Petrified's immunity to Poisoned included.
  const fromConditions = conditionImmunitiesFrom(combatant.conditions);
  if (combatant.stat_block) {
    const lines = combatant.stat_block.condition_immunities
      .toLowerCase()
      .split(/[,;]/)
      .map((part) => part.trim())
      .filter(Boolean);
    // A Druid keeps their class features through Wild Shape: Nature's Ward and its like hold in the Beast.
    const druid = wildShapeSheet(db, combatant);
    return [...lines, ...(druid ? featureConditionImmunities(druid) : []), ...fromAura, ...fromConditions];
  }
  const sheet = sheetOf(db, combatant);
  if (!sheet) return [...fromAura, ...fromConditions];
  return [
    ...sheet.condition_immunities,
    // What a feature keeps off its holder outright: Nature's Ward and its like, off the passive hook.
    ...featureConditionImmunities(sheet),
    ...ragingConditionImmunities(sheet, combatant),
    ...fromAura,
    ...fromConditions,
  ];
}

/** Why a condition cannot land on this creature, or null when it can. */
export function immuneTo(db: Db, encounter: EncounterRow, combatant: Combatant, condition: string): string | null {
  return conditionImmunities(db, encounter, combatant).includes(condition.trim().toLowerCase())
    ? `${combatant.name} is immune to the ${condition} condition.`
    : null;
}

/** The proficiency bonus behind a creature's own numbers: the sheet's, or the CR table's for a monster. */
export function profBonusOf(db: Db, combatant: Combatant): number {
  const sheet = sheetOf(db, combatant);
  if (sheet) return sheet.proficiency_bonus;
  const cr = combatant.stat_block?.cr ?? 0;
  return Math.max(2, 2 + Math.floor((cr - 1) / 4));
}
