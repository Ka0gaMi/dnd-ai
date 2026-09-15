// Encounter persistence and the read model every combat tool answers with.
import type { FeatureMechanics } from '../core/character.js';
import { getSettings } from '../core/settings.js';
import type { Db } from '../db/connection.js';
import type { CreatureStatBlock } from '../srd/data.js';
import { legalActions, type LegalAction } from './actions.js';
import { classFeatures, type ClassFeatureView, type D20Stance } from './features.js';
import {
  coverBetween,
  distanceBetween,
  footprintOf,
  reachableCells,
  COVER_ORDER,
  type Cover,
  type SizeCode,
  type Token,
} from './grid.js';
import type { BattleMap } from './map.js';
import { anchorMechanics, combatSheet, type SheetFeature } from './sheet.js';

/** What the 2024 actions leave on a combatant until its next turn, plus the grapples it is part of. */
export interface CombatFlags {
  /** Dash is spent into movement_left, so only the note survives for the log and the UI. */
  dashed?: boolean;
  /** Swings taken with this turn's Attack action, against the Extra Attack or Multiattack allowance. */
  attacks_used?: number;
  dodging?: boolean;
  disengaged?: boolean;
  hidden?: boolean;
  /** Help received: advantage on the next attack against helped_against, or on the next check. */
  helped_by?: { id: number; name: string; against_id?: number };
  ready?: { trigger: string; action: string };
  grappled_by?: number;
  grappling?: number[];
  /** Knocked out rather than dying: a monster at 0 HP that rolls no death saves. */
  stable?: boolean;
  /** Cleave: the one extra attack its mastery gives per turn is spent. */
  cleaved?: boolean;
  /** Cleave: the creature this weapon just hit, whose neighbour the extra attack may carry into. */
  cleave_ready?: { target_id: number; weapon: string };
  /** Sap: Disadvantage on this creature's next attack roll, until the attacker's next turn starts. */
  sapped_by?: { attacker_id: number };
  /** Slow: that many feet off this creature's speed, until the attacker's next turn starts. */
  slowed_by?: { attacker_id: number; ft: number };
  /** Vex: Advantage on this creature's next attack against that target, until the end of its next turn. */
  vex_against?: { target_id: number; round: number; granted_in_own_turn?: boolean };
  /** Rage: the round it was last extended in, and the rounds left of its ten minutes. */
  raging?: { extended_round: number; rounds_left: number };
  /** Reckless Attack: Advantage on Strength attacks, and Advantage on attacks against you until your next turn. */
  reckless?: boolean;
  /** Frenzy, Sneak Attack, Stunning Strike and Colossus Slayer are each once on a turn. */
  frenzy_used?: boolean;
  sneak_attack_used?: boolean;
  stunning_strike_used?: boolean;
  colossus_slayer_used?: boolean;
  /** Steady Aim: Advantage on the next attack this turn, bought with the turn's movement. */
  steady_aim?: boolean;
  /** Any movement this creature made itself this turn; Steady Aim needs it clear. Forced movement is not it. */
  moved_this_turn?: boolean;
  /** Uncanny Dodge and Deflect Attacks, declared ahead of the blow they soften. */
  uncanny_dodge_ready?: boolean;
  deflect_ready?: boolean;
  /** Deflect Attacks took a hit to 0: the force may still be thrown back, until the next turn boundary. */
  deflect_redirect?: { attacker_id: number; damage_type: string | null; within_ft: number };
  /** Flurry of Blows: Unarmed Strikes still owed, each made with attack {flurry: true}. */
  flurry_strikes?: number;
  /** Action Surge: the second action of this turn is already paid for. */
  action_surged?: boolean;
  /** The surged Action is still unspent, and Action Surge may not buy the Magic action with it. */
  surge_action_pending?: boolean;
  /** Divine Smite: the creature just hit in melee, which the smite may still land on this turn. */
  smite_ready?: { target_id: number; action: string };
  /** Sacred Weapon: the melee weapon blessed for ten minutes, what it adds, and the rounds it has left. */
  sacred_weapon?: { weapon: string; bonus: number; rounds_left: number };
  /** Cutting Words: the Bardic Inspiration die waiting to come off the next attack roll within 60 ft. */
  cutting_words_ready?: { die: number };
  /** Innate Sorcery: the rounds left of its minute. */
  innate_sorcery?: { rounds_left: number };
  /** Wild Shape: the Beast form, the Armor Class and Speed it replaced, and the rounds left of it. */
  wild_shape?: { form: string; base_ac: number; base_speed: number; rounds_left: number };
  /** Pact of the Blade: the weapon bonded, swung with Charisma. */
  pact_weapon?: { weapon: string };
  /** Dark One's Own Luck: 1d10 waiting on the next ability check or saving throw. */
  dark_ones_luck_ready?: boolean;
  /** Divine Strike, Primal Strike, Eldritch Smite and Lifedrinker are each once on a turn. */
  divine_strike_used?: boolean;
  primal_strike_used?: boolean;
  eldritch_smite_used?: boolean;
  lifedrinker_used?: boolean;
  /** Wild Resurgence turns a slot into a use of Wild Shape once on each of your turns. */
  wild_resurgence_used?: boolean;
  /** Quickened Spell: the turn's level 1+ casting, which it may neither follow nor precede. */
  cast_levelled_spell?: boolean;
  quickened_this_turn?: boolean;
  /** Turn Undead: the effects its minute put on this creature, which any damage ends early. */
  turned?: { effect_ids: number[]; feature: string };
  /** A D20 Test stance declared ahead of the roll: Indomitable, Peerless Skill, Stroke of Luck. */
  d20_stance?: D20Stance;
  /** Persistent Rage: the offer made when Initiative was rolled, open until this turn of theirs ends. */
  persistent_rage_offered?: boolean;
  /** Staggering Blow: Disadvantage on the next saving throw this creature makes. */
  staggered?: boolean;
  /** Sundering Blow: +5 on the next attack roll another creature makes against this one. */
  sundering_blow?: { by_id: number; rounds_left: number };
  /** Studied Attacks: the creature this attacker missed, which its next swing has Advantage against. */
  studied_target?: { target_id: number; rounds_left: number };
  /** Superior Defense: Resistance to everything but Force, and the rounds left of its minute. */
  superior_defense?: { rounds_left: number };
  /** Holy Nimbus: the rounds left of its ten minutes of Radiant light. */
  holy_nimbus?: { rounds_left: number };
  /** Smite of Protection: Half Cover in the aura, until the start of the Paladin's next turn. */
  smite_protection?: { rounds_left: number };
  /** Quivering Palm: the Monk whose lethal vibrations this creature carries. */
  quivering_palm?: { monk_id: number };
  /** Superior Hunter's Defense: declared, and then the type it resists for the rest of the turn. */
  hunters_defense_ready?: boolean;
  resisting?: { type: string; rounds_left: number };
  /** Quivering Palm, Hurl Through Hell, Arcane Apotheosis and Superior Hunter's Prey: once a turn. */
  quivering_palm_used?: boolean;
  hurl_through_hell_used?: boolean;
  apotheosis_used?: boolean;
  superior_prey_used?: boolean;
  /** Peerless Aim: spent until the start of the attacker's next turn, not at every turn boundary. */
  peerless_aim_used?: boolean;
  /** The homebrew clauses that have fired this turn, by their resource key: the once-a-turn ones. */
  homebrew_used?: string[];
}

export type CombatantKind = 'pc' | 'companion' | 'monster';
export type Team = 'party' | 'enemy' | 'neutral';
export type Visibility = 'full' | 'bars' | 'hidden';

export interface EncounterRow {
  id: number;
  campaign_id: number;
  scene_id: number | null;
  status: 'active' | 'ended';
  round: number;
  turn_index: number;
  seed: number;
  map_json: string;
  visibility: Visibility;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
}

export interface Combatant extends Token {
  encounter_id: number;
  kind: CombatantKind;
  character_id: number | null;
  stat_block: CreatureStatBlock | null;
  name: string;
  team: Team;
  initiative: number;
  initiative_order: number;
  size: SizeCode;
  hp_current: number;
  hp_max: number;
  temp_hp: number;
  ac: number;
  speed: number;
  conditions: string[];
  flags: CombatFlags;
  /** advantage: Extended Spell bought Advantage on the saves that keep this one up. */
  concentration: { name: string; advantage?: boolean } | null;
  death_saves: { successes: number; failures: number };
  movement_left: number;
  action_used: boolean;
  bonus_used: boolean;
  reaction_used: boolean;
  visible: boolean;
  /** The portrait this combatant was dealt, shared with its type or its own; null until one exists. */
  portrait_path: string | null;
}

export interface Effect {
  id: number;
  encounter_id: number;
  target_id: number;
  source_id: number | null;
  name: string;
  kind: 'damage' | 'condition' | 'buff';
  damage_expr: string | null;
  damage_type: string | null;
  save_ability: string | null;
  save_dc: number | null;
  tick: 'start' | 'end';
  ends: 'rounds' | 'save' | 'rest' | 'concentration' | 'manual';
  remaining_rounds: number | null;
  concentration_of: number | null;
  created_round: number;
  active: boolean;
}

export interface CombatLogEntry {
  id: number;
  round: number;
  actor_id: number | null;
  target_id: number | null;
  kind: string;
  payload: unknown;
  text: string;
  ts: string;
}

/** The allow-listed part of a stat block the player screen may show; the UI decides what visibility reveals. */
export interface KnownStats {
  cr: number | null;
  type: string | null;
  size: string | null;
  speed: Record<string, number>;
  senses: string[];
  damage_resistances: string;
  damage_immunities: string;
  damage_vulnerabilities: string;
  condition_immunities: string;
}

export interface CombatantView extends Omit<Combatant, 'stat_block'> {
  footprint: number;
  /** Wearing armour or a shield it is not proficient with: STR and DEX d20 tests suffer, no spells. */
  armor_penalty: boolean;
  hp_fraction: number;
  distance_ft: number | null;
  marker: string;
  known: KnownStats | null;
  inspiration: number | null;
  exhaustion: number | null;
  /** The class features this character has, with the uses left and whether one is running. */
  class_features: ClassFeatureView[];
}

export interface BattleState {
  encounter: Omit<EncounterRow, 'map_json'>;
  map: BattleMap;
  round: number;
  turn_index: number;
  combatants: CombatantView[];
  active: { id: number; name: string; team: Team; kind: CombatantKind } | null;
  legal_actions: LegalAction[];
  effects: Effect[];
  log_tail: CombatLogEntry[];
}

const LOG_TAIL = 20;
const nowIso = (): string => new Date().toISOString();

function parse<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function activeEncounter(db: Db, campaignId: number): EncounterRow | null {
  return (
    (db
      .prepare("SELECT * FROM encounter WHERE campaign_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1")
      .get(campaignId) as EncounterRow | undefined) ?? null
  );
}

export function requireEncounter(db: Db, campaignId: number): EncounterRow {
  const encounter = activeEncounter(db, campaignId);
  if (!encounter) {
    throw new Error(`Campaign ${campaignId} has no active encounter. Call start_encounter to begin a fight.`);
  }
  return encounter;
}

export const encounterMap = (encounter: EncounterRow): BattleMap => JSON.parse(encounter.map_json) as BattleMap;

function toCombatant(row: Record<string, unknown>): Combatant {
  return {
    id: row.id as number,
    encounter_id: row.encounter_id as number,
    kind: row.kind as CombatantKind,
    character_id: (row.character_id as number | null) ?? null,
    stat_block: parse(row.stat_block_json as string | null, null as CreatureStatBlock | null),
    name: row.name as string,
    team: row.team as Team,
    initiative: row.initiative as number,
    initiative_order: row.initiative_order as number,
    x: row.x as number,
    y: row.y as number,
    size: row.size as SizeCode,
    hp_current: row.hp_current as number,
    hp_max: row.hp_max as number,
    temp_hp: row.temp_hp as number,
    ac: row.ac as number,
    speed: row.speed as number,
    conditions: parse(row.conditions_json as string | null, [] as string[]),
    flags: parse(row.flags_json as string | null, {} as CombatFlags),
    concentration: parse(row.concentration_json as string | null, null as { name: string } | null),
    death_saves: parse(row.death_saves_json as string | null, { successes: 0, failures: 0 }),
    movement_left: row.movement_left as number,
    action_used: row.action_used === 1,
    bonus_used: row.bonus_used === 1,
    reaction_used: row.reaction_used === 1,
    visible: row.visible === 1,
    alive: row.alive === 1,
    portrait_path: (row.portrait_path as string | null) ?? null,
  };
}

export function listCombatants(db: Db, encounterId: number): Combatant[] {
  return (
    db
      .prepare('SELECT * FROM combatant WHERE encounter_id = ? ORDER BY initiative_order, id')
      .all(encounterId) as Array<Record<string, unknown>>
  ).map(toCombatant);
}

export function getCombatant(db: Db, encounterId: number, id: number): Combatant {
  const row = db.prepare('SELECT * FROM combatant WHERE id = ? AND encounter_id = ?').get(id, encounterId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`No combatant ${id} in this encounter. Call get_battle_state for the ids.`);
  return toCombatant(row);
}

export interface NewCombatant {
  encounter_id: number;
  kind: CombatantKind;
  character_id?: number | null;
  stat_block?: CreatureStatBlock | null;
  name: string;
  team: Team;
  initiative?: number;
  initiative_order?: number;
  x: number;
  y: number;
  size: SizeCode;
  hp_current: number;
  hp_max: number;
  temp_hp?: number;
  ac: number;
  speed: number;
  conditions?: string[];
  death_saves?: { successes: number; failures: number };
  visible?: boolean;
  alive?: boolean;
}

export function insertCombatant(db: Db, input: NewCombatant): number {
  return Number(
    db
      .prepare(
        `INSERT INTO combatant (encounter_id, kind, character_id, stat_block_json, name, team, initiative,
           initiative_order, x, y, size, hp_current, hp_max, temp_hp, ac, speed, conditions_json,
           death_saves_json, movement_left, visible, alive)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.encounter_id,
        input.kind,
        input.character_id ?? null,
        input.stat_block ? JSON.stringify(input.stat_block) : null,
        input.name,
        input.team,
        input.initiative ?? 0,
        input.initiative_order ?? 0,
        input.x,
        input.y,
        input.size,
        input.hp_current,
        input.hp_max,
        input.temp_hp ?? 0,
        input.ac,
        input.speed,
        JSON.stringify(input.conditions ?? []),
        JSON.stringify(input.death_saves ?? { successes: 0, failures: 0 }),
        input.speed,
        input.visible === false ? 0 : 1,
        (input.alive ?? (input.hp_current > 0 || input.kind !== 'monster')) ? 1 : 0,
      ).lastInsertRowid,
  );
}

/** Portraits are dealt outside the combatant object, so they have their own one-column write. */
export function setCombatantPortrait(db: Db, id: number, path: string): void {
  db.prepare('UPDATE combatant SET portrait_path = ? WHERE id = ?').run(path, id);
}

/**
 * The stat block a combatant is running on, which saveCombatant does not touch: Wild Shape swaps a
 * Druid's own statistics for a Beast's by putting the Beast's block on the row, and null takes it off.
 */
export function setCombatantStatBlock(db: Db, id: number, block: CreatureStatBlock | null): void {
  db.prepare('UPDATE combatant SET stat_block_json = ? WHERE id = ?').run(block ? JSON.stringify(block) : null, id);
}

export function saveCombatant(db: Db, c: Combatant): void {
  db.prepare(
    `UPDATE combatant SET initiative = ?, initiative_order = ?, x = ?, y = ?, hp_current = ?, hp_max = ?,
       temp_hp = ?, ac = ?, speed = ?, conditions_json = ?, flags_json = ?, concentration_json = ?, death_saves_json = ?,
       movement_left = ?, action_used = ?, bonus_used = ?, reaction_used = ?, visible = ?, alive = ?
     WHERE id = ?`,
  ).run(
    c.initiative,
    c.initiative_order,
    c.x,
    c.y,
    c.hp_current,
    c.hp_max,
    c.temp_hp,
    c.ac,
    c.speed,
    JSON.stringify(c.conditions),
    JSON.stringify(c.flags),
    c.concentration ? JSON.stringify(c.concentration) : null,
    JSON.stringify(c.death_saves),
    c.movement_left,
    c.action_used ? 1 : 0,
    c.bonus_used ? 1 : 0,
    c.reaction_used ? 1 : 0,
    c.visible ? 1 : 0,
    c.alive ? 1 : 0,
    c.id,
  );
}

function toEffect(row: Record<string, unknown>): Effect {
  return {
    id: row.id as number,
    encounter_id: row.encounter_id as number,
    target_id: row.target_id as number,
    source_id: (row.source_id as number | null) ?? null,
    name: row.name as string,
    kind: row.kind as Effect['kind'],
    damage_expr: (row.damage_expr as string | null) ?? null,
    damage_type: (row.damage_type as string | null) ?? null,
    save_ability: (row.save_ability as string | null) ?? null,
    save_dc: (row.save_dc as number | null) ?? null,
    tick: row.tick as Effect['tick'],
    ends: row.ends as Effect['ends'],
    remaining_rounds: (row.remaining_rounds as number | null) ?? null,
    concentration_of: (row.concentration_of as number | null) ?? null,
    created_round: row.created_round as number,
    active: row.active === 1,
  };
}

export function listEffects(db: Db, encounterId: number, activeOnly = true): Effect[] {
  return (
    db
      .prepare(`SELECT * FROM effect WHERE encounter_id = ?${activeOnly ? ' AND active = 1' : ''} ORDER BY id`)
      .all(encounterId) as Array<Record<string, unknown>>
  ).map(toEffect);
}

export function effectsFor(db: Db, encounterId: number, targetId: number, tick: 'start' | 'end'): Effect[] {
  return (
    db
      .prepare('SELECT * FROM effect WHERE encounter_id = ? AND target_id = ? AND tick = ? AND active = 1 ORDER BY id')
      .all(encounterId, targetId, tick) as Array<Record<string, unknown>>
  ).map(toEffect);
}

export function logCombat(
  db: Db,
  encounter: EncounterRow,
  entry: { actor_id?: number | null; target_id?: number | null; kind: string; payload?: unknown; text: string },
): CombatLogEntry {
  const ts = nowIso();
  const round = (db.prepare('SELECT round FROM encounter WHERE id = ?').get(encounter.id) as { round: number }).round;
  const id = Number(
    db
      .prepare(
        'INSERT INTO combat_log (encounter_id, round, actor_id, target_id, kind, payload_json, text, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        encounter.id,
        round,
        entry.actor_id ?? null,
        entry.target_id ?? null,
        entry.kind,
        entry.payload === undefined ? null : JSON.stringify(entry.payload),
        entry.text,
        ts,
      ).lastInsertRowid,
  );
  return {
    id,
    round,
    actor_id: entry.actor_id ?? null,
    target_id: entry.target_id ?? null,
    kind: entry.kind,
    payload: entry.payload ?? null,
    text: entry.text,
    ts,
  };
}

export function combatLog(db: Db, encounterId: number, limit?: number): CombatLogEntry[] {
  const rows = (
    limit === undefined
      ? (db.prepare('SELECT * FROM combat_log WHERE encounter_id = ? ORDER BY id').all(encounterId) as Array<
          Record<string, unknown>
        >)
      : (
          db.prepare('SELECT * FROM combat_log WHERE encounter_id = ? ORDER BY id DESC LIMIT ?').all(
            encounterId,
            limit,
          ) as Array<Record<string, unknown>>
        ).reverse()
  ).map((row) => ({
    id: row.id as number,
    round: row.round as number,
    actor_id: (row.actor_id as number | null) ?? null,
    target_id: (row.target_id as number | null) ?? null,
    kind: row.kind as string,
    payload: parse(row.payload_json as string | null, null),
    text: row.text as string,
    ts: row.ts as string,
  }));
  return rows;
}

/** The combatant whose turn it is; turn_index indexes the whole initiative order, dead included. */
export function activeCombatant(combatants: Combatant[], turnIndex: number): Combatant | null {
  if (combatants.length === 0) return null;
  return combatants[turnIndex % combatants.length] ?? null;
}

/** Party tokens take an upper-case initial, enemies a lower-case one; duplicates step to the next letter. */
function markers(combatants: Combatant[]): Map<number, string> {
  const used = new Set<string>();
  const map = new Map<number, string>();
  for (const c of combatants) {
    const base = (c.name.match(/[a-z]/i)?.[0] ?? 'x').toLowerCase();
    const alphabet = 'abcdefghijklmnopqrstuvwxyz';
    let marker = c.team === 'party' ? base.toUpperCase() : base;
    for (let i = 0; used.has(marker); i += 1) {
      const next = alphabet[(alphabet.indexOf(base) + i + 1) % 26]!;
      marker = c.team === 'party' ? next.toUpperCase() : next;
    }
    used.add(marker);
    map.set(c.id, marker);
  }
  return map;
}

export function getBattleState(db: Db, campaignId: number): BattleState | null {
  const encounter = activeEncounter(db, campaignId);
  if (!encounter) return null;
  return battleState(db, encounter);
}

/** Inspiration, exhaustion and the stat-block anchor of a PC or companion, straight off the character row. */
function characterExtras(
  db: Db,
  characterId: number,
): { inspiration: number; exhaustion: number; anchor: FeatureMechanics | null } | null {
  const row = db.prepare('SELECT inspiration, exhaustion, features_json FROM character WHERE id = ?').get(characterId) as
    | { inspiration: number; exhaustion: number; features_json: string | null }
    | undefined;
  if (!row) return null;
  return {
    inspiration: row.inspiration,
    exhaustion: row.exhaustion,
    anchor: anchorMechanics(parse(row.features_json, [] as SheetFeature[])),
  };
}

/** Monsters answer from their stat block, stat-block companions from their anchor feature. */
function knownStats(combatant: Combatant, anchor: FeatureMechanics | null): KnownStats | null {
  const block = combatant.stat_block;
  if (block) {
    return {
      cr: block.cr,
      type: block.type,
      size: block.size,
      speed: block.speed,
      senses: block.senses,
      damage_resistances: block.damage_resistances,
      damage_immunities: block.damage_immunities,
      damage_vulnerabilities: block.damage_vulnerabilities,
      condition_immunities: block.condition_immunities,
    };
  }
  if (!anchor) return null;
  return {
    cr: anchor.cr ?? null,
    type: anchor.type ?? null,
    size: anchor.size ?? null,
    speed: anchor.speed ?? {},
    senses: anchor.senses ?? [],
    damage_resistances: anchor.damage_resistances ?? '',
    damage_immunities: anchor.damage_immunities ?? '',
    damage_vulnerabilities: anchor.damage_vulnerabilities ?? '',
    condition_immunities: anchor.condition_immunities ?? '',
  };
}

export function battleState(db: Db, encounter: EncounterRow): BattleState {
  const combatants = listCombatants(db, encounter.id);
  const active = activeCombatant(combatants, encounter.turn_index);
  const marker = markers(combatants);
  const views: CombatantView[] = combatants.map((c) => {
    const { stat_block, ...rest } = c;
    void stat_block;
    const extras = c.kind !== 'monster' && c.character_id ? characterExtras(db, c.character_id) : null;
    const sheet = c.kind !== 'monster' && c.character_id ? combatSheet(db, c.character_id) : null;
    return {
      ...rest,
      footprint: footprintOf(c.size),
      armor_penalty: sheet?.armor_penalty.penalty ?? false,
      hp_fraction: c.hp_max > 0 ? Math.round((c.hp_current / c.hp_max) * 100) / 100 : 0,
      distance_ft: active && active.id !== c.id ? distanceBetween(active, c) : null,
      marker: marker.get(c.id) ?? '?',
      known: knownStats(c, extras?.anchor ?? null),
      inspiration: extras?.inspiration ?? null,
      exhaustion: extras?.exhaustion ?? null,
      class_features: sheet ? classFeatures(sheet, c) : [],
    };
  });
  return {
    encounter: {
      id: encounter.id,
      campaign_id: encounter.campaign_id,
      scene_id: encounter.scene_id,
      status: encounter.status,
      round: encounter.round,
      turn_index: encounter.turn_index,
      seed: encounter.seed,
      // The player owns the fog of war, so the live setting wins over whatever the fight opened with.
      visibility: getSettings(db, encounter.campaign_id).visibility,
      started_at: encounter.started_at,
      ended_at: encounter.ended_at,
      outcome: encounter.outcome,
    },
    map: encounterMap(encounter),
    round: encounter.round,
    turn_index: encounter.turn_index,
    combatants: views,
    active: active ? { id: active.id, name: active.name, team: active.team, kind: active.kind } : null,
    legal_actions: active ? legalActions(active, active.character_id ? combatSheet(db, active.character_id) : null) : [],
    effects: listEffects(db, encounter.id),
    log_tail: combatLog(db, encounter.id, LOG_TAIL),
  };
}

const FEATURE_MARKS = '①②③④⑤⑥⑦⑧⑨';
const featureMark = (index: number): string => FEATURE_MARKS[index] ?? `(${index + 1})`;
const coverWords = (cover: Cover): string => cover.replace('_', '-');

/** Plain words for a step across the grid: north is up (-y), east is right (+x). */
function compass(dx: number, dy: number): string {
  if (dx === 0 && dy === 0) return 'on top of';
  const ns = dy < 0 ? 'north' : dy > 0 ? 'south' : '';
  const ew = dx > 0 ? 'east' : dx < 0 ? 'west' : '';
  if (!ns) return ew;
  if (!ew) return ns;
  // Only name the second axis when the step is anywhere near diagonal.
  if (Math.abs(dx) >= Math.abs(dy) * 2) return ew;
  if (Math.abs(dy) >= Math.abs(dx) * 2) return ns;
  return `${ns}-${ew}`;
}

const CLOSE_FT = 30;

/** The labelled feature nearest this combatant, within 30 ft, as "the wall (1) is 5 ft north". */
function nearestFeature(state: BattleState, c: CombatantView): string | null {
  let best: { ft: number; text: string } | null = null;
  state.map.features.forEach((feature, index) => {
    const nx = Math.min(Math.max(c.x, feature.x), feature.x + feature.w - 1);
    const ny = Math.min(Math.max(c.y, feature.y), feature.y + feature.h - 1);
    const ft = Math.max(Math.abs(c.x - nx), Math.abs(c.y - ny)) * 5;
    if (ft > CLOSE_FT || (best && ft >= best.ft)) return;
    const name = feature.label.split(' (')[0]!;
    const mark = featureMark(index);
    best = {
      ft,
      text: ft === 0 ? `in the ${name} ${mark}` : `the ${name} ${mark} is ${ft} ft ${compass(nx - c.x, ny - c.y)}`,
    };
  });
  return best === null ? null : (best as { text: string }).text;
}

/** The cheapest cell in reach that would give the acting combatant cover from its nearest enemy. */
function coverHint(state: BattleState, active: CombatantView, tokens: Token[]): string | null {
  const enemies = state.combatants
    .filter((c) => c.alive && c.team !== active.team)
    .sort((a, b) => distanceBetween(active, a) - distanceBetween(active, b));
  const enemy = enemies[0];
  if (!enemy) return null;
  let best: { x: number; y: number; cost_ft: number; cover: Cover } | null = null;
  for (const cell of reachableCells(state.map, tokens, active, active.movement_left)) {
    const standing = { ...active, x: cell.x, y: cell.y };
    const others = tokens.map((t) => (t.id === active.id ? standing : t));
    const { cover } = coverBetween(state.map, others, enemy, standing);
    if (cover === 'none') continue;
    if (!best || COVER_ORDER.indexOf(cover) > COVER_ORDER.indexOf(best.cover) || cell.cost_ft < best.cost_ft) {
      best = { x: cell.x, y: cell.y, cost_ft: cell.cost_ft, cover };
    }
  }
  return best
    ? `nearest cover from ${enemy.name}: ${best.x},${best.y} (${coverWords(best.cover)}, ${best.cost_ft} ft away)`
    : `no cover from ${enemy.name} within ${active.movement_left} ft`;
}

/** One plain-words line per combatant: where they are, how far and which way, cover and nearby features. */
function tacticalLines(state: BattleState): string[] {
  const active = state.combatants.find((c) => c.id === state.active?.id) ?? null;
  const tokens: Token[] = state.combatants.filter((c) => c.alive);
  const lines: string[] = [];
  for (const c of state.combatants) {
    const where = `${c.name} (${c.marker}) at ${c.x},${c.y}`;
    if (!c.alive) {
      lines.push(`${where} - down and out of the fight.`);
      continue;
    }
    const parts: string[] = [];
    if (active && c.id !== active.id) {
      const cover = coverBetween(state.map, tokens, active, c);
      const seen = !cover.line_of_sight
        ? 'out of sight behind total cover'
        : cover.cover === 'none'
          ? 'in the open'
          : `behind ${coverWords(cover.cover)} cover`;
      parts.push(
        `${distanceBetween(active, c)} ft ${compass(c.x - active.x, c.y - active.y)} of ${active.name}, ${seen}`,
      );
    } else if (active) {
      parts.push(`acting now, ${c.movement_left} ft of movement left`);
    }
    const feature = nearestFeature(state, c);
    if (feature) parts.push(feature);
    lines.push(`${where} - ${parts.join('; ')}.`);
    if (active && c.id === active.id) {
      const hint = coverHint(state, c, tokens);
      if (hint) lines.push(`  ${hint}`);
    }
  }
  return lines;
}

/** The grid as text with a legend, so the DM can read the battlefield without the web UI. */
export function renderBattle(state: BattleState): string {
  const grid = state.map.rows.map((row) => row.split(''));
  for (const c of state.combatants) {
    if (!c.alive || !c.visible) continue;
    if (c.y < grid.length && c.x < (grid[c.y]?.length ?? 0)) grid[c.y]![c.x] = c.marker;
  }
  const header = `    ${Array.from({ length: state.map.w }, (_, x) => String(x % 10)).join('')}`;
  const lines = grid.map((row, y) => `${String(y).padStart(3, ' ')} ${row.join('')}`);

  const legend = state.combatants.map((c) => {
    const hp = c.alive ? `${c.hp_current}/${c.hp_max} HP` : 'down';
    const extras = [
      c.conditions.length ? c.conditions.join(', ') : null,
      c.flags.dodging ? 'dodging' : null,
      c.flags.disengaged ? 'disengaged' : null,
      c.flags.hidden ? 'hidden' : null,
      c.flags.ready ? `readied ${c.flags.ready.action}` : null,
      c.armor_penalty ? 'armour it is not proficient with' : null,
      c.concentration ? `concentrating on ${c.concentration.name}` : null,
      c.distance_ft === null ? null : `${c.distance_ft} ft away`,
    ].filter(Boolean);
    return `${c.marker} = ${c.name} (${c.team}, ${hp}, AC ${c.ac}, at ${c.x},${c.y})${
      extras.length ? ` - ${extras.join('; ')}` : ''
    }`;
  });

  return [
    `Round ${state.round}, turn ${state.turn_index}${state.active ? ` - ${state.active.name} is up` : ''}.`,
    header,
    ...lines,
    '',
    'Terrain: . open, ~ difficult (double cost), # blocked (full cover). Each cell is 5 ft.',
    'Tokens: upper case = party, lower case = enemy or neutral.',
    ...legend,
    '',
    'Compass: north is up (-y), south is down (+y), east is right (+x), west is left (-x).',
    ...tacticalLines(state),
    ...(state.map.features.length
      ? ['', `Features: ${state.map.features.map((f, i) => `${featureMark(i)} ${f.label}`).join('; ')}`]
      : []),
  ].join('\n');
}
