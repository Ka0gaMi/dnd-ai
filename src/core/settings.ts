import { z } from 'zod';
import type { Db } from '../db/connection.js';
import { getCampaign, logEvent } from './campaign.js';

export interface CampaignSettings {
  visibility: 'full' | 'bars' | 'hidden';
  cheat_mode: boolean;
  luck_bias: number;
  roll_mode: 'player' | 'auto';
  /** Which dice the player clicks themselves while roll_mode is 'player'. */
  player_rolls: 'all' | 'd20_only' | 'none';
  roll_timeout_s: number;
  /** 'rules' enforces carrying capacity; 'off' lets the party carry anything. */
  encumbrance: 'rules' | 'off';
  /** How hard the server holds the DM to the rules when they invent something: see core/progression.ts. */
  rules_mode: 'strict' | 'flexible' | 'freeform';
  /** 'xp' counts experience points; 'milestone' levels the character when the DM says so. */
  xp_mode: 'xp' | 'milestone';
  /** How hard the fights are built; the briefing states it, and the encounter planner (R13) will read it. */
  difficulty: 'story' | 'standard' | 'deadly';
  /** How freely treasure is handed out. */
  treasure_pacing: 'sparse' | 'standard' | 'generous';
  /** With it on, the DM explains a rule in one sentence the first time it matters in a session. */
  rules_coach: boolean;
  /** The player's spoiler toggle: with it on, their window also shows the DM's hidden notes. */
  show_secrets: boolean;
  /** Draw portraits by themselves for new characters and for the enemies of a fight. */
  auto_portraits: boolean;
  setting_preset: string | null;
  tone_dials: Record<string, unknown>;
  lines: string;
  veils: string;
  /** The boolean form means "the premise"; the object names each part the DM still owes. */
  needs_ai_fill: boolean | { name?: boolean; premise?: boolean };
}

/** The player's own dials. Their window and the API see them; no DM-facing reply or briefing may. */
export const PLAYER_ONLY_SETTINGS = [
  'cheat_mode',
  'luck_bias',
  'roll_mode',
  'player_rolls',
  'roll_timeout_s',
  'visibility',
  'show_secrets',
] as const;

export const DEFAULT_SETTINGS: CampaignSettings = {
  visibility: 'bars',
  cheat_mode: false,
  luck_bias: 0,
  roll_mode: 'player',
  player_rolls: 'all',
  roll_timeout_s: 45,
  encumbrance: 'rules',
  rules_mode: 'flexible',
  xp_mode: 'xp',
  difficulty: 'standard',
  treasure_pacing: 'standard',
  rules_coach: true,
  show_secrets: false,
  auto_portraits: true,
  setting_preset: null,
  tone_dials: {},
  lines: '',
  veils: '',
  needs_ai_fill: false,
};

const settingsPatchSchema = z
  .object({
    visibility: z.enum(['full', 'bars', 'hidden']),
    cheat_mode: z.boolean(),
    luck_bias: z.number().min(-2).max(2),
    roll_mode: z.enum(['player', 'auto']),
    player_rolls: z.enum(['all', 'd20_only', 'none']),
    roll_timeout_s: z.number().int().positive().max(600),
    encumbrance: z.enum(['rules', 'off']),
    rules_mode: z.enum(['strict', 'flexible', 'freeform']),
    xp_mode: z.enum(['xp', 'milestone']),
    difficulty: z.enum(['story', 'standard', 'deadly']),
    treasure_pacing: z.enum(['sparse', 'standard', 'generous']),
    rules_coach: z.boolean(),
    show_secrets: z.boolean(),
    auto_portraits: z.boolean(),
    setting_preset: z.string().nullable(),
    tone_dials: z.record(z.string(), z.unknown()),
    lines: z.string(),
    veils: z.string(),
    needs_ai_fill: z.union([z.boolean(), z.object({ name: z.boolean().optional(), premise: z.boolean().optional() })]),
  })
  .partial();

function parseStoredSettings(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Defaults merged with whatever is stored, so unknown/legacy keys in settings_json survive untouched. */
export function getSettings(db: Db, campaignId: number): CampaignSettings {
  const campaign = getCampaign(db, campaignId);
  return { ...DEFAULT_SETTINGS, ...parseStoredSettings(campaign.settings_json) } as CampaignSettings;
}

/** A settings object with the player's own dials taken out: what a DM-facing reply may carry. */
export function dmVisibleSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!(PLAYER_ONLY_SETTINGS as readonly string[]).includes(key)) out[key] = value;
  }
  return out;
}

/** The luck dial, which only ever pulls the player character's d20s; companions and monsters roll straight. */
export function luckBiasFor(db: Db, campaignId: number, isPlayerCharacter: boolean): number {
  return isPlayerCharacter ? getSettings(db, campaignId).luck_bias : 0;
}

/** Validates the patch, merges it over what is stored (not the defaults) and notifies the companion window. */
export function updateSettings(db: Db, campaignId: number, patch: Partial<CampaignSettings>): CampaignSettings {
  const validated = settingsPatchSchema.parse(patch);
  const campaign = getCampaign(db, campaignId);
  const merged = { ...parseStoredSettings(campaign.settings_json), ...validated };
  db.prepare('UPDATE campaign SET settings_json = ? WHERE id = ?').run(JSON.stringify(merged), campaignId);
  logEvent(db, { campaign_id: campaignId, kind: 'settings', text: 'Campaign settings updated.', payload: validated });
  return { ...DEFAULT_SETTINGS, ...merged } as CampaignSettings;
}
