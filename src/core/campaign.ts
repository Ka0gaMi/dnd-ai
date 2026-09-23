import type { Db } from '../db/connection.js';
import { getBattleState, type BattleState } from '../combat/state.js';
import { bus } from './bus.js';
import {
  backfillItemIds,
  dmItems,
  maskItemsForPlayer,
  sheetExtras,
  type InventoryItem,
  type SheetExtras,
} from './character.js';
import { rollDice, withoutLuckPool, type Advantage, type Outcome, type RollDetail, type RollType } from './dice.js';
import { nowState, type NowState } from './calendar.js';
import { codexBriefing, getCodex } from './codex.js';
import { regionBriefing } from './region-briefing.js';
import { homebrewSpellsOn, progressionBriefing } from './progression.js';
import { parseOverrides } from './overrides.js';
import { findPreset } from './presets.js';
import { carriedLoad, ENCUMBERED_SPEED, proficiencyBonus, XP_THRESHOLDS } from './rules.js';
import { getSettings } from './settings.js';
import { backfillItemWeights, equipmentProficiency, speciesLineages } from '../srd/lookup.js';
import {
  currentChapterId,
  getRumours,
  readJournal,
  storyArc,
  JOURNAL_BRIEFING_LIMIT,
  type JournalEntry,
  type Rumour,
  type StoryArc,
} from './story.js';

export type StoryShape = 'structured' | 'sandbox';
export type EventKind = 'narration' | 'action' | 'travel' | 'loot' | 'xp' | 'system';
export type QuestKind = 'main' | 'side' | 'personal';
export type QuestStatus = 'open' | 'done' | 'failed';

export interface CampaignRow {
  id: number;
  name: string;
  story_shape: StoryShape;
  premise: string | null;
  luck_bias: number;
  created_at: string;
  current_session_id: number | null;
  current_scene_id: number | null;
  settings_json: string | null;
  deleted_at: string | null;
  /** The in-world calendar; see core/calendar.ts. NULL until time is first advanced. */
  calendar_json: string | null;
  /** The half-filled character the wizard left for the DM; NULL once a player character exists. */
  character_draft_json: string | null;
}

export interface SessionRow {
  id: number;
  campaign_id: number;
  number: number;
  started_at: string;
  ended_at: string | null;
  recap_text: string | null;
}

export interface SceneRow {
  id: number;
  session_id: number;
  campaign_id: number;
  title: string | null;
  summary: string | null;
  location_name: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface Quest {
  id: number;
  title: string;
  kind: QuestKind;
  status: QuestStatus;
  summary: string | null;
  chapter_id: number | null;
  steps: Array<{ id: number; text: string; done: boolean }>;
}

export interface QuestInput {
  id?: number;
  title: string;
  kind?: QuestKind;
  status?: QuestStatus;
  summary?: string;
  steps?: Array<{ id?: number; text: string; done?: boolean }>;
}

export interface CharacterSummary {
  id: number;
  name: string;
  role: string;
  species: string | null;
  /** The lineage inside the species; null for a species without one and for sheets made before they were asked for. */
  lineage: string | null;
  class: string | null;
  subclass: string | null;
  background: string | null;
  level: number;
  xp: number;
  /** The XP the next level needs, or null at level 20. */
  xp_next: number | null;
  hp_current: number | null;
  hp_max: number | null;
  temp_hp: number;
  ac: number | null;
  speed: number | null;
  status: string;
  exhaustion: number;
  gold: number;
  inspiration: number;
  abilities: unknown;
  saves: unknown;
  skills: unknown;
  proficiencies: unknown;
  features: unknown;
  spells: unknown;
  /** The spells on the sheet that the DM wrote, so the window can badge them. */
  homebrew_spells: Array<{ name: string; level: number; homebrew_id: number }>;
  spell_slots: unknown;
  inventory: unknown;
  conditions: unknown;
  death_saves: unknown;
  hit_dice: unknown;
  proficiency_bonus: number;
  initiative_bonus: number;
  passive_perception: number;
  carried_lb: number;
  capacity_lb: number;
  encumbered: boolean;
  /** Wearing armour they are not trained in: Disadvantage on STR and DEX d20 tests, and no spellcasting. */
  armor_penalty: boolean;
  /** Equipped weapons outside the proficiency list. */
  weapons_not_proficient: string[];
  /** At 0 hit points but no longer dying: no death saves until something changes. */
  stable: boolean;
  /** The species size, Small or Medium; a stat-block companion uses its creature's. */
  size: string;
  /** Damage types the sheet's features are proof against, lowercased. */
  resistances: string[];
  vulnerabilities: string[];
  immunities: string[];
  portrait_path: string | null;
  /** How they look, in the DM's words; null until the sheet is finished. */
  appearance: string | null;
}

export interface Briefing {
  campaign: StorySetting & {
    id: number;
    name: string;
    story_shape: StoryShape;
    premise: string | null;
    created_at: string;
    settings: unknown;
  };
  session: { id: number; number: number; started_at: string };
  last_recap: string | null;
  current_scene: Pick<SceneRow, 'id' | 'title' | 'summary' | 'location_name' | 'started_at'> | null;
  previous_scene: Pick<SceneRow, 'id' | 'title' | 'summary' | 'location_name'> | null;
  pc: (CharacterSummary & SheetExtras) | null;
  /** Set while the player has left their character half-filled for the DM to finish. */
  character_draft: CharacterDraft | null;
  companions: PartyMember[];
  open_quests: Quest[];
  canon_facts: Array<{ id: number; subject: string; fact: string; chapter_id: number | null }>;
  recent_events: Array<{ id: number; ts: string; kind: string; text: string }>;
  glossary_terms: string[];
  encounter: BattleState | null;
  events_since_checkpoint: number;
  story: StoryArc;
  now: NowState;
  /** Unresolved rumours the player has already heard. */
  rumours: Rumour[];
  journal: JournalEntry[];
  /** Rendered blocks owned by the codex and progression modules; empty strings when they have nothing. */
  codex_briefing: string;
  /** The region map block for the DM; empty for the player and when there is no region. */
  region_briefing: string;
  progression_briefing: string;
}

const CANON_FACT_LIMIT = 40;
const RECENT_EVENT_LIMIT = 8;
/** A new fact sharing this much of its wording with an active fact on the same subject is a restatement. */
const DUPLICATE_FACT_OVERLAP = 0.6;
const FACTS_PER_SUBJECT_HINT = 6;
const FACT_STOPWORDS = new Set(
  'a an the and or of to in into on at by for with from is was are were be been has have had it its their his her he she they that this these those as but not now no yet still who which when while'.split(
    ' ',
  ),
);

const nowIso = (): string => new Date().toISOString();

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseStringArray(value: string | null): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? (parsed as string[]) : [];
}

export interface StorySetting {
  setting_preset: string | null;
  setting_name: string | null;
  tone_dials: Record<string, number>;
  lines: string;
  veils: string;
  /** True while anything below is still the DM's to write. */
  needs_ai_fill: boolean;
  needs_fill: NeedsFill;
}

/** Which parts of the story the player left to the DM. */
export interface NeedsFill {
  name: boolean;
  premise: boolean;
}

/** needs_ai_fill was a plain boolean before the wizard could leave the name empty too. */
export function needsFill(value: unknown): NeedsFill {
  if (value === true) return { name: false, premise: true };
  if (value && typeof value === 'object') {
    const flags = value as Record<string, unknown>;
    return { name: flags.name === true, premise: flags.premise === true };
  }
  return { name: false, premise: false };
}

/** The session-zero part of settings_json, with the preset's display name resolved. */
function storySetting(settingsJson: string | null): StorySetting {
  const s = (parseJson(settingsJson) ?? {}) as Record<string, unknown>;
  const preset = typeof s.setting_preset === 'string' ? s.setting_preset : null;
  const fill = needsFill(s.needs_ai_fill);
  return {
    setting_preset: preset,
    setting_name: preset ? (findPreset(preset)?.name ?? null) : null,
    tone_dials: (s.tone_dials ?? {}) as Record<string, number>,
    lines: typeof s.lines === 'string' ? s.lines : '',
    veils: typeof s.veils === 'string' ? s.veils : '',
    needs_ai_fill: fill.name || fill.premise,
    needs_fill: fill,
  };
}

/** The half-filled character the player left for the DM: any subset of the wizard's questions. */
export interface CharacterDraft {
  name?: string;
  class?: string;
  species?: string;
  /** Which lineage of the species, for the species that have one. */
  lineage?: string;
  background?: string;
  gender?: string;
  /** One line on who they are, in the player's words. */
  idea?: string;
  ability_method?: 'standard_array' | 'point_buy' | 'manual';
}

export function getCharacterDraft(db: Db, campaignId: number): CharacterDraft | null {
  const row = db.prepare('SELECT character_draft_json FROM campaign WHERE id = ?').get(campaignId) as
    | { character_draft_json: string | null }
    | undefined;
  const parsed = row ? parseJson(row.character_draft_json) : null;
  return parsed && typeof parsed === 'object' ? (parsed as CharacterDraft) : null;
}

export function setCharacterDraft(db: Db, campaignId: number, draft: CharacterDraft | null): void {
  db.prepare('UPDATE campaign SET character_draft_json = ? WHERE id = ?').run(
    draft ? JSON.stringify(draft) : null,
    campaignId,
  );
}

/** The draft in one line, for the briefing and the companion window. */
export function characterDraftSummary(draft: CharacterDraft): string {
  const filled = (value?: string): string => (value ?? '').trim();
  const kin = [filled(draft.species), filled(draft.lineage) ? `(${filled(draft.lineage)})` : ''].filter(Boolean).join(' ');
  const who = [filled(draft.gender), kin, filled(draft.class)].filter(Boolean).join(' ');
  const parts = [filled(draft.name), who].filter(Boolean);
  // The species needs a lineage and the player left it: say so, so the DM knows to pick one.
  if (!filled(draft.lineage) && speciesLineages(filled(draft.species)).length > 0) {
    parts.push(`lineage still to choose (${speciesLineages(filled(draft.species)).join(', ')})`);
  }
  if (filled(draft.background)) parts.push(`${filled(draft.background)} background`);
  if (draft.ability_method) parts.push(`${draft.ability_method.replace('_', ' ')} scores`);
  if (filled(draft.idea)) parts.push(`"${filled(draft.idea)}"`);
  return parts.length ? parts.join(', ') : 'nothing chosen yet - the player left all of it to you';
}

export function snippet(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}...`;
}

export function getCampaign(db: Db, campaignId: number): CampaignRow {
  const row = db.prepare('SELECT * FROM campaign WHERE id = ?').get(campaignId) as CampaignRow | undefined;
  if (!row) throw new Error(`No campaign with id ${campaignId}. Call load_campaign with no campaign_id to see what exists.`);
  return row;
}

/** Deleted campaigns stay in the database but are hidden from the DM; only the player can restore one. */
function requireLive(campaign: CampaignRow): CampaignRow {
  if (campaign.deleted_at) {
    throw new Error(
      `Campaign ${campaign.id} ("${campaign.name}") was deleted by the player. Ask them to restore it in the companion window, or pick another campaign.`,
    );
  }
  return campaign;
}

export function setCampaignDeleted(db: Db, campaignId: number, deleted: boolean): boolean {
  const result = db
    .prepare('UPDATE campaign SET deleted_at = ? WHERE id = ?')
    .run(deleted ? nowIso() : null, campaignId);
  return result.changes > 0;
}

const CAMPAIGN_LIST_COLUMNS = 'id, name, story_shape, premise, created_at, deleted_at, settings_json';

type CampaignListRow = Pick<
  CampaignRow,
  'id' | 'name' | 'story_shape' | 'premise' | 'created_at' | 'deleted_at' | 'settings_json'
>;

/** One campaign as the picker shows it: the row without its settings blob, plus who is playing it. */
function campaignItem(db: Db, c: CampaignListRow) {
  const r = db
    .prepare(
      'SELECT recap_text FROM session WHERE campaign_id = ? AND recap_text IS NOT NULL ORDER BY number DESC LIMIT 1',
    )
    .get(c.id) as { recap_text: string } | undefined;
  const p = db
    .prepare(
      "SELECT name, level, class FROM character WHERE campaign_id = ? AND is_pc = 1 ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id DESC LIMIT 1",
    )
    .get(c.id) as { name: string; level: number; class: string | null } | undefined;
  const { settings_json, ...row } = c;
  const setting = storySetting(settings_json);
  return {
    ...row,
    setting_preset: setting.setting_preset,
    setting_name: setting.setting_name,
    needs_ai_fill: setting.needs_ai_fill,
    needs_fill: setting.needs_fill,
    character_draft: getCharacterDraft(db, c.id),
    last_recap_snippet: r ? snippet(r.recap_text, 240) : null,
    pc: p ? { name: p.name, level: p.level, class: p.class } : null,
    companions: party(db, c.id).companions.map((m) => ({
      name: m.name,
      class: m.class ?? m.creature,
      level: m.level,
      hp: `${m.hp_current}/${m.hp_max}`,
    })),
  };
}

export function listCampaigns(db: Db, includeDeleted = false) {
  const campaigns = db
    .prepare(
      `SELECT ${CAMPAIGN_LIST_COLUMNS} FROM campaign ${
        includeDeleted ? '' : 'WHERE deleted_at IS NULL '
      }ORDER BY id`,
    )
    .all() as CampaignListRow[];
  return campaigns.map((c) => campaignItem(db, c));
}

/** The list's entry for one campaign, so a create answers in the shape the picker already reads. */
export function campaignListItem(db: Db, campaignId: number) {
  const row = db.prepare(`SELECT ${CAMPAIGN_LIST_COLUMNS} FROM campaign WHERE id = ?`).get(campaignId) as
    | CampaignListRow
    | undefined;
  if (!row) throw new Error(`No campaign with id ${campaignId}. Call load_campaign with no campaign_id to see what exists.`);
  return campaignItem(db, row);
}

export function createCampaign(
  db: Db,
  input: { name: string; story_shape: StoryShape; premise?: string; settings?: Record<string, unknown> },
) {
  const ts = nowIso();
  // A story created from a name and a setting only carries needs_ai_fill, so the DM knows to finish it.
  const settings = input.settings ? { needs_ai_fill: !input.premise, ...input.settings } : null;
  return db.transaction(() => {
    const campaignId = Number(
      db
        .prepare(
          'INSERT INTO campaign (name, story_shape, premise, created_at, settings_json) VALUES (?, ?, ?, ?, ?)',
        )
        .run(input.name, input.story_shape, input.premise ?? null, ts, settings ? JSON.stringify(settings) : null)
        .lastInsertRowid,
    );
    const sessionId = Number(
      db
        .prepare('INSERT INTO session (campaign_id, number, started_at) VALUES (?, 1, ?)')
        .run(campaignId, ts).lastInsertRowid,
    );
    db.prepare('UPDATE campaign SET current_session_id = ? WHERE id = ?').run(sessionId, campaignId);
    logEvent(db, {
      campaign_id: campaignId,
      kind: 'system',
      text: `Campaign "${input.name}" created (${input.story_shape}). Session 1 started.`,
      payload: { premise: input.premise ?? null },
    });
    return {
      campaign_id: campaignId,
      name: input.name,
      story_shape: input.story_shape,
      premise: input.premise ?? null,
      settings,
      session: { id: sessionId, number: 1 },
    };
  })();
}

/** Returns the campaign's open session, starting the next one if the last has ended. */
export function ensureOpenSession(db: Db, campaignId: number): SessionRow {
  const campaign = getCampaign(db, campaignId);
  const current = campaign.current_session_id
    ? (db.prepare('SELECT * FROM session WHERE id = ?').get(campaign.current_session_id) as SessionRow | undefined)
    : undefined;
  if (current && current.ended_at === null) return current;

  const ts = nowIso();
  const number = (current?.number ?? 0) + 1;
  const id = Number(
    db
      .prepare('INSERT INTO session (campaign_id, number, started_at) VALUES (?, ?, ?)')
      .run(campaignId, number, ts).lastInsertRowid,
  );
  db.prepare('UPDATE campaign SET current_session_id = ?, current_scene_id = NULL WHERE id = ?').run(id, campaignId);
  return db.prepare('SELECT * FROM session WHERE id = ?').get(id) as SessionRow;
}

/**
 * Event kinds the player's window never sees: they are written to the log for the DM, never pushed on
 * the bus and never listed among the recent events. A passive check is the DM's own secret roll, and
 * a planted clue is DM-side until find_clue reveals it.
 */
const DM_ONLY_KINDS = ['passive_check', 'clue_planted'];

export function logEvent(db: Db, input: { campaign_id: number; kind: string; text: string; payload?: unknown }) {
  const campaign = getCampaign(db, input.campaign_id);
  const ts = nowIso();
  const id = Number(
    db
      .prepare(
        'INSERT INTO event (campaign_id, session_id, scene_id, ts, kind, text, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.campaign_id,
        campaign.current_session_id,
        campaign.current_scene_id,
        ts,
        input.kind,
        input.text,
        input.payload === undefined ? null : JSON.stringify(input.payload),
      ).lastInsertRowid,
  );
  if (!DM_ONLY_KINDS.includes(input.kind)) {
    bus.publish({
      campaign_id: input.campaign_id,
      event_id: id,
      kind: input.kind,
      text: input.text,
      ts,
      payload: input.payload,
    });
  }
  return { id, ts, kind: input.kind, text: input.text };
}

export function eventsSinceCheckpoint(db: Db, campaignId: number): number {
  const last = db
    .prepare("SELECT MAX(id) AS id FROM event WHERE campaign_id = ? AND kind = 'checkpoint'")
    .get(campaignId) as { id: number | null };
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM event WHERE campaign_id = ? AND id > ?')
    .get(campaignId, last.id ?? 0) as { n: number };
  return row.n;
}

/** The campaign's active PC, falling back to the most recent one when none is active (dead or retired). */
export function pcRow(db: Db, campaignId: number): Record<string, string | number | null> | undefined {
  return db
    .prepare(
      "SELECT * FROM character WHERE campaign_id = ? AND is_pc = 1 ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id DESC LIMIT 1",
    )
    .get(campaignId) as Record<string, string | number | null> | undefined;
}

/** One line per party member: what the briefing and the campaign list show. */
export interface PartyMember {
  id: number;
  name: string;
  role: string;
  class: string | null;
  creature: string | null;
  level: number;
  hp_current: number | null;
  hp_max: number | null;
  temp_hp: number;
  ac: number | null;
  /** Effective speed: 5 ft while they are over capacity and the encumbrance rule is on. */
  speed: number | null;
  status: string;
  conditions: string[];
  inspiration: number;
  carried_lb: number;
  capacity_lb: number;
  encumbered: boolean;
  portrait_path: string | null;
}

/** A companion built from a stat block has no class; its species column holds the creature name. */
function partyMember(db: Db, row: Record<string, string | number | null>): PartyMember {
  const cls = row.class as string | null;
  const overrides = parseOverrides(row.overrides_json as string | null);
  const abilities = parseJson(row.abilities_json as string | null) as Record<string, { score: number }> | null;
  const load = carriedLoad(parseJson(row.inventory_json as string | null), abilities?.str?.score ?? 10);
  const encumbered = load.over && getSettings(db, row.campaign_id as number).encumbrance === 'rules';
  return {
    id: row.id as number,
    name: row.name as string,
    role: row.role as string,
    class: cls,
    creature: cls ? null : (row.species as string | null),
    level: row.level as number,
    hp_current: row.hp_current as number | null,
    hp_max: row.hp_max as number | null,
    temp_hp: row.temp_hp as number,
    ac: overrides.ac ?? (row.ac as number | null),
    speed: encumbered ? ENCUMBERED_SPEED : (row.speed as number | null),
    status: row.status as string,
    conditions: parseStringArray(row.conditions_json as string | null),
    inspiration: row.inspiration as number,
    carried_lb: load.carried_lb,
    capacity_lb: load.capacity_lb,
    encumbered,
    portrait_path: row.portrait_path as string | null,
  };
}

/** The PC and the companions who are still in play. */
export function party(db: Db, campaignId: number): { pc: PartyMember | null; companions: PartyMember[] } {
  const pc = pcRow(db, campaignId);
  const companions = db
    .prepare("SELECT * FROM character WHERE campaign_id = ? AND role = 'companion' AND status = 'active' ORDER BY id")
    .all(campaignId) as Array<Record<string, string | number | null>>;
  return { pc: pc ? partyMember(db, pc) : null, companions: companions.map((row) => partyMember(db, row)) };
}

/** Drops repeated names (case-insensitive) from a spell list, keeping the first occurrence. */
function dedupeSpellList(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  const seen = new Set<string>();
  return list.filter((name) => {
    const key = typeof name === 'string' ? name.trim().toLowerCase() : name;
    if (seen.has(key as string)) return false;
    seen.add(key as string);
    return true;
  });
}

/** A damaged spells_json (duplicate cantrips/known/prepared) rendered clean, without touching the row. */
function dedupeSpells(spells: unknown): unknown {
  if (!spells || typeof spells !== 'object') return spells;
  const s = spells as Record<string, unknown>;
  return { ...s, cantrips: dedupeSpellList(s.cantrips), known: dedupeSpellList(s.known), prepared: dedupeSpellList(s.prepared) };
}

/**
 * The PC's sheet, or a named character's (a companion, an NPC, a retired or dead PC), including the
 * rules that are not columns on the row, so every consumer of a sheet sees the same numbers. Numbers
 * the player hand-set in cheat mode replace the computed ones and are named in hand_set - a marker
 * for the companion window that must never reach a tool reply.
 */
/**
 * The character row as a sheet. By default it is the DM's view, which shows every magic item for what
 * it is; for_player is the window the player watches, where an unidentified item is only its kind.
 */
export function getCharacterSheet(
  db: Db,
  campaignId: number,
  characterId?: number,
  options: { for_player?: boolean } = {},
): (CharacterSummary & SheetExtras & { hand_set: string[] }) | null {
  const row =
    characterId === undefined
      ? pcRow(db, campaignId)
      : (db.prepare('SELECT * FROM character WHERE id = ? AND campaign_id = ?').get(characterId, campaignId) as
          | Record<string, string | number | null>
          | undefined);
  if (!row) return null;
  const abilities = parseJson(row.abilities_json as string | null) as Record<
    string,
    { mod: number; score: number }
  > | null;
  const skills = parseJson(row.skills_json as string | null) as Record<string, { bonus: number }> | null;
  const overrides = parseOverrides(row.overrides_json as string | null);
  const inventory = parseJson(row.inventory_json as string | null);
  const items = Array.isArray(inventory) ? (inventory as InventoryItem[]) : [];
  // A row from before the inventory package tracked weight or ids backfills both here, once: both run,
  // so filling a weight never leaves the ids for another read.
  const weighed = backfillItemWeights(items);
  const identified = backfillItemIds(items);
  if (weighed || identified) {
    db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(JSON.stringify(items), row.id);
  }
  const load = carriedLoad(inventory, abilities?.str?.score ?? 10);
  // Over capacity the character shuffles along at 5 ft; the stored speed stays what it is.
  const encumbered = load.over && getSettings(db, campaignId).encumbrance === 'rules';
  const features = (parseJson(row.features_json as string | null) ?? []) as Array<{
    mechanics?: {
      initiative_proficiency?: boolean;
      size?: string;
      resistances?: string[];
      vulnerabilities?: string[];
      immunities?: string[];
    };
  }>;
  /** Every damage line the features carry, lowercased and each type named once. */
  const damageLine = (key: 'resistances' | 'vulnerabilities' | 'immunities'): string[] => [
    ...new Set(features.flatMap((f) => f.mechanics?.[key] ?? []).map((type) => type.toLowerCase())),
  ];
  const proficiencies = parseJson(row.proficiencies_json as string | null) as {
    armor?: string[];
    weapons?: string[];
    tools?: string[];
    languages?: string[];
  } | null;
  // What the `always` clauses give at read time: proficiencies and spells that are never on the row.
  const extras = sheetExtras(db, campaignId, row.id as number);
  const grants = extras.clause_grants;
  const merge = (into: string[] | undefined, added: string[]): string[] => [
    ...(into ?? []),
    ...added.filter((one) => !(into ?? []).some((held) => held.toLowerCase() === one.toLowerCase())),
  ];
  const trained = {
    ...((proficiencies ?? {}) as Record<string, string[]>),
    weapons: merge(proficiencies?.weapons, grants.proficiencies.weapons),
    armor: merge(proficiencies?.armor, grants.proficiencies.armor),
  };
  const gaps = equipmentProficiency(trained, Array.isArray(inventory) ? inventory : []);
  const spellsOn = dedupeSpells(parseJson(row.spells_json as string | null)) as {
    cantrips?: string[];
    known?: string[];
    prepared?: string[];
  } | null;
  const spellsWithClauses = {
    ...(spellsOn ?? {}),
    cantrips: merge(spellsOn?.cantrips, grants.spells.cantrips),
    known: merge(spellsOn?.known, grants.spells.known),
    prepared: merge(spellsOn?.prepared, grants.spells.prepared),
  };
  return {
    id: row.id as number,
    name: row.name as string,
    role: row.role as string,
    species: row.species as string | null,
    lineage: (row.lineage as string | null) ?? null,
    class: row.class as string | null,
    subclass: row.subclass as string | null,
    background: row.background as string | null,
    level: row.level as number,
    xp: row.xp as number,
    xp_next: XP_THRESHOLDS[row.level as number] ?? null,
    hp_current: row.hp_current as number | null,
    hp_max: row.hp_max as number | null,
    temp_hp: row.temp_hp as number,
    ac: overrides.ac ?? (row.ac as number | null),
    status: row.status as string,
    exhaustion: row.exhaustion as number,
    gold: row.gold as number,
    inspiration: row.inspiration as number,
    abilities: parseJson(row.abilities_json as string | null),
    saves: parseJson(row.saves_json as string | null),
    skills: parseJson(row.skills_json as string | null),
    proficiencies: trained,
    features: parseJson(row.features_json as string | null),
    spells: spellsWithClauses,
    homebrew_spells: homebrewSpellsOn(db, campaignId, spellsWithClauses),
    spell_slots: parseJson(row.spell_slots_json as string | null),
    inventory: options.for_player ? maskItemsForPlayer(items) : dmItems(items),
    conditions: parseJson(row.conditions_json as string | null),
    death_saves: parseJson(row.death_saves_json as string | null),
    hit_dice: parseJson(row.hit_dice_json as string | null),
    proficiency_bonus: overrides.proficiency_bonus ?? proficiencyBonus(row.level as number),
    initiative_bonus:
      overrides.initiative_bonus ??
      (abilities?.dex?.mod ?? 0) +
        // Alert adds the proficiency bonus to Initiative.
        (features.some((f) => f.mechanics?.initiative_proficiency) ? proficiencyBonus(row.level as number) : 0) +
        // And what an `always` clause adds, which is the number the fight rolls with.
        grants.initiative,
    passive_perception: overrides.passive_perception ?? 10 + (skills?.perception?.bonus ?? 0),
    carried_lb: load.carried_lb,
    capacity_lb: load.capacity_lb,
    encumbered,
    armor_penalty: gaps.armor_penalty,
    weapons_not_proficient: gaps.weapons_not_proficient,
    stable: row.stable === 1,
    size: features.find((f) => f.mechanics?.size)?.mechanics?.size ?? 'Medium',
    resistances: damageLine('resistances'),
    vulnerabilities: damageLine('vulnerabilities'),
    immunities: damageLine('immunities'),
    portrait_path: row.portrait_path as string | null,
    appearance: (row.appearance as string | null) ?? null,
    hand_set: Object.keys(overrides),
    // The armour weight rule, concentration and the rest clock; speed comes with them, encumbrance
    // and the armour penalty already taken off.
    ...extras,
    // An `always` clause the sheet could not run is handed back here, once per read.
    ...(grants.reminders.length ? { reminders: grants.reminders } : {}),
  };
}

export function openQuests(db: Db, campaignId: number): Quest[] {
  const quests = db
    .prepare(
      "SELECT id, title, kind, status, summary, chapter_id FROM quest WHERE campaign_id = ? AND status = 'open' ORDER BY id",
    )
    .all(campaignId) as Array<Omit<Quest, 'steps'>>;
  const steps = db.prepare('SELECT id, text, done FROM quest_step WHERE quest_id = ? ORDER BY sort, id');
  return quests.map((q) => ({
    ...q,
    steps: (steps.all(q.id) as Array<{ id: number; text: string; done: number }>).map((s) => ({
      id: s.id,
      text: s.text,
      done: s.done === 1,
    })),
  }));
}

/** Codex names that show up in the scene the party is in or in the last events - the codex block's "present". */
function presentEntities(db: Db, campaignId: number, scene: string | null, events: Briefing['recent_events']): string[] {
  const haystack = [scene ?? '', ...events.map((e) => e.text)].join(' ').toLowerCase();
  return getCodex(db, campaignId)
    .entities.map((e) => e.name)
    .filter((name) => haystack.includes(name.toLowerCase()));
}

/** The briefing for the MCP tool: opens the next session first if the last one was ended. */
export function loadCampaign(db: Db, campaignId: number): Briefing {
  requireLive(getCampaign(db, campaignId));
  ensureOpenSession(db, campaignId);
  return campaignSnapshot(db, campaignId);
}

/**
 * The same briefing as a pure read - no session or scene is opened. Used by the companion feed,
 * which passes forPlayer so the DM's hidden threads, clues and notes stay out of it.
 */
export function campaignSnapshot(db: Db, campaignId: number, options: { forPlayer?: boolean } = {}): Briefing {
  const campaign = requireLive(getCampaign(db, campaignId));
  const session = db
    .prepare('SELECT * FROM session WHERE campaign_id = ? ORDER BY number DESC LIMIT 1')
    .get(campaignId) as SessionRow;

  const recap = db
    .prepare(
      'SELECT recap_text FROM session WHERE campaign_id = ? AND recap_text IS NOT NULL ORDER BY number DESC LIMIT 1',
    )
    .get(campaignId) as { recap_text: string } | undefined;

  const currentScene = campaign.current_scene_id
    ? (db.prepare('SELECT * FROM scene WHERE id = ?').get(campaign.current_scene_id) as SceneRow | undefined)
    : undefined;
  const previousScene = db
    .prepare(
      'SELECT id, title, summary, location_name FROM scene WHERE campaign_id = ? AND summary IS NOT NULL AND id != ? ORDER BY id DESC LIMIT 1',
    )
    .get(campaignId, currentScene?.id ?? 0) as Briefing['previous_scene'] | undefined;

  const facts = db
    .prepare(
      'SELECT id, subject, fact, chapter_id FROM canon_fact WHERE campaign_id = ? AND active = 1 ORDER BY id DESC LIMIT ?',
    )
    .all(campaignId, CANON_FACT_LIMIT) as Briefing['canon_facts'];

  const events = (
    db
      .prepare(
        `SELECT id, ts, kind, text FROM event WHERE campaign_id = ? AND reverted = 0
           AND kind NOT IN (${DM_ONLY_KINDS.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT ?`,
      )
      .all(campaignId, ...DM_ONLY_KINDS, RECENT_EVENT_LIMIT) as Briefing['recent_events']
  ).reverse();

  const terms = (
    db.prepare('SELECT term FROM glossary_entry WHERE campaign_id = ? ORDER BY term').all(campaignId) as Array<{
      term: string;
    }>
  ).map((t) => t.term);

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      story_shape: campaign.story_shape,
      premise: campaign.premise,
      created_at: campaign.created_at,
      settings: parseJson(campaign.settings_json),
      ...storySetting(campaign.settings_json),
    },
    session: { id: session.id, number: session.number, started_at: session.started_at },
    last_recap: recap?.recap_text ?? null,
    current_scene: currentScene
      ? {
          id: currentScene.id,
          title: currentScene.title,
          summary: currentScene.summary,
          location_name: currentScene.location_name,
          started_at: currentScene.started_at,
        }
      : null,
    previous_scene: previousScene ?? null,
    pc: getCharacterSheet(db, campaignId, undefined, { for_player: options.forPlayer === true }),
    character_draft: getCharacterDraft(db, campaignId),
    companions: party(db, campaignId).companions,
    open_quests: openQuests(db, campaignId),
    canon_facts: facts,
    recent_events: events,
    glossary_terms: terms,
    encounter: getBattleState(db, campaignId, options.forPlayer === true),
    events_since_checkpoint: eventsSinceCheckpoint(db, campaignId),
    story: storyArc(db, campaignId, options),
    now: nowState(db, campaignId),
    rumours: getRumours(db, campaignId, { heard_only: true, for_player: options.forPlayer === true }),
    journal: readJournal(db, campaignId, JOURNAL_BRIEFING_LIMIT),
    // Both briefing blocks are for the DM's eyes; the player's window never reads them, so it pays nothing.
    codex_briefing: options.forPlayer
      ? ''
      : codexBriefing(db, campaignId, {
          present: presentEntities(db, campaignId, currentScene?.summary ?? null, events),
        }),
    region_briefing: options.forPlayer
      ? ''
      : regionBriefing(db, campaignId, currentScene?.location_name ?? previousScene?.location_name ?? null),
    progression_briefing: options.forPlayer ? '' : progressionBriefing(db, campaignId),
  };
}

export interface CheckpointInput {
  campaign_id: number;
  scene_title?: string;
  /** Where the party is at the end of the scene; the next scene starts there. */
  scene_location?: string;
  scene_summary: string;
  canon_facts?: Array<{ subject: string; fact: string }>;
  quest_updates?: QuestInput[];
  glossary?: Array<{ term: string; definition: string }>;
}

export function saveCheckpoint(db: Db, input: CheckpointInput) {
  return db.transaction(() => {
    const session = ensureOpenSession(db, input.campaign_id);
    const campaign = getCampaign(db, input.campaign_id);
    const ts = nowIso();

    let sceneId = campaign.current_scene_id;
    const open = sceneId
      ? (db.prepare('SELECT * FROM scene WHERE id = ?').get(sceneId) as SceneRow | undefined)
      : undefined;
    if (!open || open.ended_at !== null) {
      sceneId = Number(
        db
          .prepare('INSERT INTO scene (session_id, campaign_id, started_at) VALUES (?, ?, ?)')
          .run(session.id, input.campaign_id, ts).lastInsertRowid,
      );
    }
    db.prepare(
      'UPDATE scene SET title = COALESCE(?, title), summary = ?, location_name = COALESCE(?, location_name), ended_at = ? WHERE id = ?',
    ).run(
      input.scene_title ?? null,
      input.scene_summary,
      input.scene_location?.trim() || null,
      ts,
      sceneId,
    );
    // The next scene starts where this one ended, so read the location back rather than re-deriving it.
    const closedLocation = (
      db.prepare('SELECT location_name FROM scene WHERE id = ?').get(sceneId) as { location_name: string | null }
    ).location_name;

    const chapterId = currentChapterId(db, input.campaign_id);
    for (const f of input.canon_facts ?? []) {
      db.prepare(
        'INSERT INTO canon_fact (campaign_id, subject, fact, established_scene_id, chapter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(input.campaign_id, f.subject, f.fact, sceneId, chapterId, ts);
    }
    for (const g of input.glossary ?? []) {
      upsertGlossary(db, input.campaign_id, g.term, g.definition);
    }
    if (input.quest_updates?.length) upsertQuests(db, input.campaign_id, input.quest_updates);

    const recap = regenerateRecap(db, session.id);

    // Open the next scene right away so later events attach to it, not to the one just closed.
    const nextSceneId = Number(
      db
        .prepare('INSERT INTO scene (session_id, campaign_id, location_name, started_at) VALUES (?, ?, ?, ?)')
        .run(session.id, input.campaign_id, closedLocation, ts).lastInsertRowid,
    );
    db.prepare('UPDATE campaign SET current_scene_id = ? WHERE id = ?').run(nextSceneId, input.campaign_id);

    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'checkpoint',
      text: `Checkpoint: ${input.scene_title ?? 'scene'} - ${snippet(input.scene_summary, 200)}`,
      payload: { scene_id: sceneId },
    });

    return {
      campaign_id: input.campaign_id,
      scene: { id: sceneId as number, title: input.scene_title ?? null, summary: input.scene_summary, location: closedLocation },
      session: { id: session.id, number: session.number, recap_text: recap },
      canon_facts_added: input.canon_facts?.length ?? 0,
      glossary_added: input.glossary?.length ?? 0,
      open_quests: openQuests(db, input.campaign_id),
    };
  })();
}

export function endSession(db: Db, input: { campaign_id: number; recap_override?: string }) {
  return db.transaction(() => {
    const session = ensureOpenSession(db, input.campaign_id);
    const ts = nowIso();
    db.prepare('UPDATE scene SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL').run(ts, session.id);
    const recap = input.recap_override ?? regenerateRecap(db, session.id);
    db.prepare('UPDATE session SET ended_at = ?, recap_text = ? WHERE id = ?').run(ts, recap, session.id);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'system',
      text: `Session ${session.number} ended.`,
    });
    return { campaign_id: input.campaign_id, session_number: session.number, recap_text: recap, ended_at: ts };
  })();
}

/** Deterministic recap: the session's scene summaries in order. No LLM involved. */
function regenerateRecap(db: Db, sessionId: number): string {
  const scenes = db
    .prepare('SELECT title, summary FROM scene WHERE session_id = ? AND summary IS NOT NULL ORDER BY id')
    .all(sessionId) as Array<{ title: string | null; summary: string }>;
  const recap = scenes.map((s, i) => `${i + 1}. ${s.title ? `${s.title}: ` : ''}${s.summary}`).join('\n');
  db.prepare('UPDATE session SET recap_text = ? WHERE id = ?').run(recap, sessionId);
  return recap;
}

export function upsertQuests(db: Db, campaignId: number, quests: QuestInput[]): Quest[] {
  db.transaction(() => {
    const ts = nowIso();
    const chapterId = currentChapterId(db, campaignId);
    for (const q of quests) {
      let questId: number;
      if (q.id !== undefined) {
        const existing = db.prepare('SELECT id FROM quest WHERE id = ? AND campaign_id = ?').get(q.id, campaignId);
        if (!existing) throw new Error(`No quest with id ${q.id} in campaign ${campaignId}.`);
        questId = q.id;
        db.prepare(
          'UPDATE quest SET title = ?, kind = COALESCE(?, kind), status = COALESCE(?, status), summary = COALESCE(?, summary), updated_at = ? WHERE id = ?',
        ).run(q.title, q.kind ?? null, q.status ?? null, q.summary ?? null, ts, questId);
      } else {
        questId = Number(
          db
            .prepare(
              'INSERT INTO quest (campaign_id, title, kind, status, summary, chapter_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .run(campaignId, q.title, q.kind ?? 'side', q.status ?? 'open', q.summary ?? null, chapterId, ts, ts)
            .lastInsertRowid,
        );
      }
      for (const step of q.steps ?? []) {
        const done = step.done === true ? 1 : 0;
        if (step.id !== undefined) {
          db.prepare('UPDATE quest_step SET text = ?, done = ?, done_at = ? WHERE id = ? AND quest_id = ?').run(
            step.text,
            done,
            done ? ts : null,
            step.id,
            questId,
          );
        } else {
          const next = db
            .prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS n FROM quest_step WHERE quest_id = ?')
            .get(questId) as { n: number };
          db.prepare('INSERT INTO quest_step (quest_id, text, done, done_at, sort) VALUES (?, ?, ?, ?, ?)').run(
            questId,
            step.text,
            done,
            done ? ts : null,
            next.n,
          );
        }
      }
    }
  })();
  return openQuests(db, campaignId);
}

/** Lowercased, punctuation-free, stopword-free words - the unit the duplicate check compares. */
function factTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0 && !FACT_STOPWORDS.has(word));
}

/** Either the fact that was written, or duplicate_of when the guard refused a restatement. */
export interface CanonFactResult {
  id?: number;
  subject?: string;
  fact?: string;
  supersedes_id?: number | null;
  duplicate_of?: number;
  hint?: string;
}

export function addCanonFact(
  db: Db,
  input: { campaign_id: number; subject: string; fact: string; supersedes_id?: number },
): CanonFactResult {
  return db.transaction(() => {
    const campaign = getCampaign(db, input.campaign_id);
    const ts = nowIso();

    const onSubject = db
      .prepare('SELECT id, fact FROM canon_fact WHERE campaign_id = ? AND active = 1 AND lower(subject) = lower(?)')
      .all(input.campaign_id, input.subject) as Array<{ id: number; fact: string }>;
    const tokens = factTokens(input.fact);
    const duplicate =
      input.supersedes_id !== undefined || tokens.length === 0
        ? undefined
        : onSubject.find((row) => {
            const existing = new Set(factTokens(row.fact));
            return tokens.filter((t) => existing.has(t)).length / tokens.length >= DUPLICATE_FACT_OVERLAP;
          });
    if (duplicate) {
      return {
        duplicate_of: duplicate.id,
        hint: 'Near-duplicate of an existing fact; pass supersedes_id to replace it, or log_event for scene beats.',
      };
    }

    const id = Number(
      db
        .prepare(
          'INSERT INTO canon_fact (campaign_id, subject, fact, established_scene_id, chapter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          input.campaign_id,
          input.subject,
          input.fact,
          campaign.current_scene_id,
          currentChapterId(db, input.campaign_id),
          ts,
        ).lastInsertRowid,
    );
    if (input.supersedes_id !== undefined) {
      db.prepare('UPDATE canon_fact SET active = 0, superseded_by = ? WHERE id = ? AND campaign_id = ?').run(
        id,
        input.supersedes_id,
        input.campaign_id,
      );
    }
    const added = { id, subject: input.subject, fact: input.fact, supersedes_id: input.supersedes_id ?? null };
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'story',
      text: `Canon: ${snippet(added.fact, 160)}`,
      payload: { canon_fact_id: id },
    });
    if (onSubject.length >= FACTS_PER_SUBJECT_HINT) {
      return {
        ...added,
        hint: `"${input.subject}" now has ${onSubject.length + 1} active canon facts. Consolidate them into one durable fact and pass supersedes_id, and keep scene beats in log_event.`,
      };
    }
    return added;
  })();
}

export function addGlossaryEntry(db: Db, input: { campaign_id: number; term: string; definition: string }) {
  getCampaign(db, input.campaign_id);
  upsertGlossary(db, input.campaign_id, input.term, input.definition);
  return { campaign_id: input.campaign_id, term: input.term, definition: input.definition };
}

function upsertGlossary(db: Db, campaignId: number, term: string, definition: string): void {
  db.prepare(
    `INSERT INTO glossary_entry (campaign_id, term, definition, source, chapter_id, created_at) VALUES (?, ?, ?, 'campaign', ?, ?)
     ON CONFLICT (campaign_id, term) DO UPDATE SET definition = excluded.definition`,
  ).run(campaignId, term, definition, currentChapterId(db, campaignId), nowIso());
}

export interface RollRecord extends RollDetail {
  id: number | null;
  purpose: string;
  campaign_id: number | null;
  /** Set when the player spent Heroic Inspiration on this roll: the total before and after. */
  inspired?: { from: number; to: number };
}

export function rollAndRecord(
  db: Db,
  input: {
    expr: string;
    purpose: string;
    dc?: number;
    campaign_id?: number;
    advantage?: Advantage;
    roll_type?: RollType;
    luck_bias?: number;
  },
): RollRecord {
  const detail = rollDice(input.expr, {
    advantage: input.advantage,
    dc: input.dc ?? null,
    roll_type: input.roll_type,
    luck_bias: input.luck_bias,
  });
  if (input.campaign_id === undefined) {
    return { ...detail, id: null, purpose: input.purpose, campaign_id: null };
  }
  const campaign = getCampaign(db, input.campaign_id);
  // The luck dial is the player's own: the event and the returned roll read as the roll that was asked
  // for, while the row keeps the whole pool for their ledger.
  const shown = withoutLuckPool(detail);
  const id = db.transaction(() => {
    const event = logEvent(db, {
      campaign_id: campaign.id,
      kind: 'roll',
      text: `${input.purpose}: ${shown.output}${input.dc !== undefined ? ` vs DC ${input.dc}` : ''}${
        detail.outcome ? ` -> ${detail.outcome}` : ''
      }${detail.natural ? ` (natural ${detail.natural})` : ''}`,
      payload: {
        expr: shown.expr,
        total: detail.total,
        outcome: detail.outcome,
        advantage: detail.advantage,
        roll_type: detail.roll_type,
        natural: detail.natural,
      },
    });
    return Number(
      db
        .prepare(
          'INSERT INTO roll (campaign_id, event_id, expr, results_json, total, purpose, dc, outcome, luck_bias_applied, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          campaign.id,
          event.id,
          detail.expr,
          JSON.stringify(detail.groups),
          detail.total,
          input.purpose,
          input.dc ?? null,
          detail.outcome,
          input.luck_bias ?? campaign.luck_bias,
          event.ts,
        ).lastInsertRowid,
    );
  })();
  return { ...shown, id, purpose: input.purpose, campaign_id: campaign.id };
}

export type { Outcome, RollType };
