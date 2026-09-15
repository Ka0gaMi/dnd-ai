// The settings the player owns from the header. The server keeps the same shape and more besides.
import type { Visibility } from './types';

export type PlayerRolls = 'all' | 'd20_only' | 'none';
export type Encumbrance = 'rules' | 'off';
export type RulesMode = 'strict' | 'flexible' | 'freeform';
export type XpMode = 'xp' | 'milestone';
export type Difficulty = 'story' | 'standard' | 'deadly';
export type TreasurePacing = 'sparse' | 'standard' | 'generous';

export interface CampaignSettings {
  visibility: Visibility;
  cheat_mode: boolean;
  luck_bias: number;
  roll_mode: 'player' | 'auto';
  player_rolls: PlayerRolls;
  roll_timeout_s: number;
  /** 'rules' enforces carrying capacity; 'off' lets the party carry anything. */
  encumbrance: Encumbrance;
  /** Generates portraits for your character, companions and enemies when Cloudflare portraits are enabled. */
  auto_portraits: boolean;
  /** How far the DM may go beyond the rulebook when they invent something for you. */
  rules_mode: RulesMode;
  /** 'xp' counts experience points; 'milestone' levels you when the story says so. */
  xp_mode: XpMode;
  /** The spoiler toggle: with it on, the window also shows the DM's hidden threads, clues and notes. */
  show_secrets: boolean;
  /** How hard fights are built for a solo party. A fight you pick deliberately keeps its real strength. */
  difficulty: Difficulty;
  /** How freely treasure is handed out. */
  treasure_pacing: TreasurePacing;
  /** The DM explains a rule in one sentence the first time it matters each session. */
  rules_coach: boolean;
}

export const DEFAULT_SETTINGS: CampaignSettings = {
  visibility: 'bars',
  cheat_mode: false,
  luck_bias: 0,
  roll_mode: 'player',
  player_rolls: 'all',
  roll_timeout_s: 45,
  encumbrance: 'rules',
  auto_portraits: true,
  rules_mode: 'flexible',
  xp_mode: 'xp',
  show_secrets: false,
  difficulty: 'standard',
  treasure_pacing: 'standard',
  rules_coach: true,
};

export const VISIBILITY_OPTIONS: Array<{ id: Visibility; label: string; hint: string }> = [
  { id: 'full', label: 'Full', hint: 'enemy numbers and AC' },
  { id: 'bars', label: 'Bars', hint: 'health bars only' },
  { id: 'hidden', label: 'Hidden', hint: 'bloodied or not' },
];

export const ROLL_MODE_OPTIONS: Array<{ id: 'player' | 'auto'; label: string }> = [
  { id: 'player', label: 'I roll' },
  { id: 'auto', label: 'Automatic' },
];

export const PLAYER_ROLLS_OPTIONS: Array<{ id: PlayerRolls; label: string; hint: string }> = [
  { id: 'all', label: 'Every die', hint: 'attacks, saves, initiative and damage' },
  { id: 'd20_only', label: 'd20s only', hint: 'the server rolls your damage' },
  { id: 'none', label: 'Combat off', hint: 'the server rolls everything in a fight' },
];

export const ENCUMBRANCE_OPTIONS: Array<{ id: Encumbrance; label: string; hint: string }> = [
  { id: 'rules', label: 'Rules', hint: 'carrying too much drops your speed to 5 ft' },
  { id: 'off', label: 'Off', hint: 'carry anything, no penalty' },
];

export const RULES_MODE_OPTIONS: Array<{ id: RulesMode; label: string; hint: string }> = [
  { id: 'strict', label: 'Strict', hint: 'the rulebook only: nothing invented goes on your sheet' },
  { id: 'flexible', label: 'Flexible', hint: 'the DM may invent things; anything too strong asks you first' },
  { id: 'freeform', label: 'Freeform', hint: 'anything goes, however strong — it will outshine the rules' },
];

export const XP_MODE_OPTIONS: Array<{ id: XpMode; label: string; hint: string }> = [
  { id: 'xp', label: 'XP', hint: 'experience points add up to the next level' },
  { id: 'milestone', label: 'Milestone', hint: 'you level when the story reaches the beat for it' },
];

export const DIFFICULTY_OPTIONS: Array<{ id: Difficulty; label: string }> = [
  { id: 'story', label: 'Story' },
  { id: 'standard', label: 'Standard' },
  { id: 'deadly', label: 'Deadly' },
];

export const TREASURE_PACING_OPTIONS: Array<{ id: TreasurePacing; label: string }> = [
  { id: 'sparse', label: 'Sparse' },
  { id: 'standard', label: 'Standard' },
  { id: 'generous', label: 'Generous' },
];

const RULES_MODES: RulesMode[] = ['strict', 'flexible', 'freeform'];
const XP_MODES: XpMode[] = ['xp', 'milestone'];
const PLAYER_ROLLS: PlayerRolls[] = ['all', 'd20_only', 'none'];
const ENCUMBRANCES: Encumbrance[] = ['rules', 'off'];
const DIFFICULTIES: Difficulty[] = ['story', 'standard', 'deadly'];
const TREASURE_PACINGS: TreasurePacing[] = ['sparse', 'standard', 'generous'];

const LUCK_WORDS = ['Cursed', 'Unlucky', 'Fair', 'Lucky', 'Blessed'];

export const luckWord = (bias: number): string =>
  LUCK_WORDS[Math.max(0, Math.min(LUCK_WORDS.length - 1, Math.round(bias) + 2))]!;

const VISIBILITIES: Visibility[] = ['full', 'bars', 'hidden'];

/** Applies a PATCH reply or a `settings` event over what is on screen; unknown keys are ignored. */
export function mergeSettings(current: CampaignSettings, patch: unknown): CampaignSettings {
  if (!patch || typeof patch !== 'object') return current;
  const fields = patch as Record<string, unknown>;
  const next = { ...current };
  if (typeof fields.visibility === 'string' && VISIBILITIES.includes(fields.visibility as Visibility)) {
    next.visibility = fields.visibility as Visibility;
  }
  if (typeof fields.cheat_mode === 'boolean') next.cheat_mode = fields.cheat_mode;
  if (typeof fields.luck_bias === 'number') next.luck_bias = Math.max(-2, Math.min(2, Math.round(fields.luck_bias)));
  if (fields.roll_mode === 'player' || fields.roll_mode === 'auto') next.roll_mode = fields.roll_mode;
  if (PLAYER_ROLLS.includes(fields.player_rolls as PlayerRolls)) next.player_rolls = fields.player_rolls as PlayerRolls;
  if (typeof fields.roll_timeout_s === 'number' && fields.roll_timeout_s > 0) {
    next.roll_timeout_s = Math.round(fields.roll_timeout_s);
  }
  if (ENCUMBRANCES.includes(fields.encumbrance as Encumbrance)) next.encumbrance = fields.encumbrance as Encumbrance;
  if (typeof fields.auto_portraits === 'boolean') next.auto_portraits = fields.auto_portraits;
  if (RULES_MODES.includes(fields.rules_mode as RulesMode)) next.rules_mode = fields.rules_mode as RulesMode;
  if (XP_MODES.includes(fields.xp_mode as XpMode)) next.xp_mode = fields.xp_mode as XpMode;
  if (typeof fields.show_secrets === 'boolean') next.show_secrets = fields.show_secrets;
  if (DIFFICULTIES.includes(fields.difficulty as Difficulty)) next.difficulty = fields.difficulty as Difficulty;
  if (TREASURE_PACINGS.includes(fields.treasure_pacing as TreasurePacing)) {
    next.treasure_pacing = fields.treasure_pacing as TreasurePacing;
  }
  if (typeof fields.rules_coach === 'boolean') next.rules_coach = fields.rules_coach;
  return next;
}
