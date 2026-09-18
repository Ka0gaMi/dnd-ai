/** Shapes the server sends. Every character field is optional: WP2 fills them in over time. */

export interface Ability {
  score?: number;
  mod?: number;
}

export interface Save {
  proficient?: boolean;
  bonus?: number;
}

export interface Skill {
  ability?: string;
  proficient?: boolean;
  expertise?: boolean;
  bonus?: number;
}

export interface Feature {
  name?: string;
  source?: string;
  text?: string;
  /** What a homebrew feature is: which library entry it came from, and whether it is above the budget. */
  mechanics?: { homebrew_id?: number; over_budget?: boolean } | null;
}

export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'very_rare' | 'legendary' | 'artifact';

/** Uses an item holds and when they come back; absent when it has no charges. */
export interface ItemCharges {
  current?: number;
  max?: number;
  recharge?: 'dawn' | 'dusk' | 'long_rest' | 'never' | 'unknown';
  /** What one recharge rolls, e.g. "1d6+1"; absent when every charge comes back at once. */
  dice?: string;
}

/** What makes an item magical. An unidentified item never reaches the player's window with this block. */
export interface ItemMagic {
  srd_index?: string;
  rarity?: ItemRarity;
  /** false when it needs none, true when anyone may attune, else the requirement: "by a Paladin". */
  attunement?: boolean | string;
  attuned?: boolean;
  bonus?: number;
  charges?: ItemCharges;
  identified?: boolean;
  /** What the item grants, in the shape a feature carries it; the sheet does not read it. */
  mechanics?: Record<string, unknown> | null;
}

/** A pack, a sack or a Bag of Holding: what it can hold and what is in it. */
export interface ItemContainer {
  capacity_lb?: number;
  /** A Bag of Holding: what is inside weighs its carrier nothing. */
  weightless_contents?: boolean;
  contents?: InventoryItem[];
}

export interface InventoryItem {
  name?: string;
  qty?: number;
  equipped?: boolean;
  notes?: string;
  /** May be 0 with "weight unknown" folded into notes, for an item the SRD never gave a weight. */
  weight_lb?: number;
  /** A short handle unique inside this inventory; absent on a server older than the item package. */
  id?: string;
  magic?: ItemMagic;
  container?: ItemContainer;
}

/** The purse by denomination; absent on a server older than the item package. */
export interface Coins {
  cp?: number;
  sp?: number;
  ep?: number;
  gp?: number;
  pp?: number;
}

/** The three attunement slots and what is in them. */
export interface Attunement {
  used?: number;
  max?: number;
  items?: string[];
}

/** Where the armour class comes from, magical gear included. */
export interface AcBreakdown {
  total?: number;
  /** The body armour worn, or null when there is none. */
  armor?: string | null;
  shield?: boolean;
  feature_bonus?: number;
  magic_bonus?: number;
  /** One line for every part that is not the plain armour table. */
  notes?: string[];
}

export interface Spells {
  spellcasting_ability?: string;
  cantrips?: string[];
  known?: string[];
  prepared?: string[];
  /** A Wizard's book, the pool their prepared list is drawn from; absent for every other class. */
  spellbook?: string[];
  /** Spells a feat or trait always has prepared; absent when nothing granted any. */
  granted?: string[];
  save_dc?: number;
  attack_bonus?: number;
}

/** A custom spell the DM built for this character, as the sheet names it; the fuller detail is fetched by name. */
export interface HomebrewSpellRef {
  name: string;
  level: number;
  homebrew_id: number;
}

export interface Pc {
  id?: number;
  name?: string;
  species?: string | null;
  /** The lineage inside the species; null for a species that has none, or one not chosen yet. */
  lineage?: string | null;
  class?: string | null;
  subclass?: string | null;
  background?: string | null;
  level?: number;
  xp?: number;
  /** XP at which the next level is reached; null at level 20, absent on an older server. */
  xp_next?: number | null;
  hp_current?: number | null;
  hp_max?: number | null;
  temp_hp?: number;
  ac?: number | null;
  speed?: number | null;
  /** Why speed is below its base value, e.g. armour without training; absent when nothing reduces it. */
  speed_reason?: string | null;
  status?: string;
  proficiency_bonus?: number;
  initiative_bonus?: number;
  passive_perception?: number;
  abilities?: Record<string, Ability> | null;
  saves?: Record<string, Save> | null;
  skills?: Record<string, Skill> | null;
  proficiencies?: { armor?: string[]; weapons?: string[]; tools?: string[]; languages?: string[] } | null;
  features?: Feature[] | null;
  spells?: Spells | null;
  /** Custom spells the DM built for this character; absent on a server older than the homebrew-spell package. */
  homebrew_spells?: HomebrewSpellRef[] | null;
  spell_slots?: Record<string, { max?: number; used?: number }> | null;
  /** The spell currently held in mind, if any; absent on an older server. */
  concentrating_on?: { spell: string; slot_level: number | null; started_at: string; duration: string | null } | null;
  inventory?: InventoryItem[] | null;
  conditions?: string[] | null;
  death_saves?: { successes?: number; failures?: number } | null;
  exhaustion?: number;
  gold?: number;
  /** The purse by denomination; gold beside it is its whole value in gp. Absent on an older server. */
  coins?: Coins | null;
  /** The attunement slots in use; absent on a server older than the item package. */
  attunement?: Attunement | null;
  /** What the armour class is made of; absent on a server older than the item package. */
  ac_breakdown?: AcBreakdown | null;
  role?: string;
  inspiration?: 0 | 1;
  hit_dice?: unknown;
  /** In-world date/time text of the last long rest; absent on an older server. */
  last_long_rest_at?: string | null;
  portrait_path?: string | null;
  /** The fields the player hand-set in cheat mode; absent on an older server. */
  hand_set?: string[];
  /** Carrying capacity; absent on a server older than the encumbrance package. */
  carried_lb?: number;
  capacity_lb?: number;
  encumbered?: boolean;
  /** Wearing armour or a shield they are not trained in; absent on a server older than the rules package. */
  armor_penalty?: boolean;
  /** Armour that imposes disadvantage on Stealth checks; absent on an older server. */
  stealth_disadvantage?: boolean;
  weapons_not_proficient?: string[];
  /** Steadied at 0 hit points: no more death saves until they take damage again. */
  stable?: boolean;
  /** "Medium", "Small": how much of the grid they fill. */
  size?: string;
  resistances?: string[];
  vulnerabilities?: string[];
  immunities?: string[];
}

export interface Quest {
  id: number;
  title: string;
  kind: 'main' | 'side' | 'personal';
  status: 'open' | 'done' | 'failed';
  summary: string | null;
  steps: Array<{ id: number; text: string; done: boolean }>;
  /** The chapter it was taken in; absent on a server older than the story package. */
  chapter_id?: number | null;
}

export interface CanonFact {
  id: number;
  subject: string;
  fact: string;
  /** The chapter it was written in; absent on a server older than the story package. */
  chapter_id?: number | null;
}

export interface Scene {
  id: number;
  title: string | null;
  summary: string | null;
  location_name: string | null;
}

export interface Snapshot {
  campaign: {
    id: number;
    name: string;
    story_shape: string;
    premise: string | null;
    /** The wizard's setting block; absent on a server older than the setup package. */
    setting_preset?: string | null;
    setting_name?: string | null;
    tone_dials?: Record<string, number>;
    lines?: string;
    veils?: string;
    needs_ai_fill?: boolean | { name?: boolean; premise?: boolean };
    /** Which halves are still the DM's to write; the boolean above is only "something is". */
    needs_fill?: { name: boolean; premise: boolean };
  };
  session: { id: number; number: number; started_at: string };
  last_recap: string | null;
  current_scene: Scene | null;
  previous_scene: Scene | null;
  pc: Pc | null;
  /** Set while the player left their character half-filled for the DM to finish. */
  character_draft?: {
    name?: string;
    class?: string;
    species?: string;
    lineage?: string | null;
    background?: string;
    gender?: string;
    idea?: string;
    ability_method?: 'standard_array' | 'point_buy' | 'manual';
  } | null;
  open_quests: Quest[];
  canon_facts: CanonFact[];
  recent_events: Array<{ id: number; ts: string; kind: string; text: string }>;
  glossary_terms: string[];
  events_since_checkpoint: number;
  /** Both are absent on a server older than the combat and companion packages. */
  encounter?: BattleState | null;
  companions?: PartyMember[];
  /** All four are absent on a server older than the story package. */
  story?: StoryArc;
  now?: NowState;
  rumours?: Rumour[];
  journal?: JournalEntry[];
}

/* The story arc: the outline, where the party is in it, and what is still in the air. */

export type ActStatus = 'planned' | 'active' | 'done';
export type ChapterStatus = 'open' | 'closed';
export type ThreadStatus = 'open' | 'resolved' | 'dropped';
export type ClueStatus = 'planted' | 'found';
export type RumourScope = 'world' | 'region' | 'location';

export interface Act {
  id: number;
  number: number;
  title: string;
  goal: string | null;
  status: ActStatus;
}

export interface Chapter {
  id: number;
  act_id: number | null;
  number: number;
  title: string;
  goal: string | null;
  summary: string | null;
  status: ChapterStatus;
  started_at: string;
  closed_at: string | null;
}

export interface PlotThread {
  id: number;
  title: string;
  status: ThreadStatus;
  /** The DM's own thread: only ever sent with the spoiler setting on. */
  hidden: boolean;
  summary: string | null;
  chapter_id: number | null;
}

export interface Clue {
  id: number;
  thread_id: number | null;
  text: string;
  hidden: boolean;
  status: ClueStatus;
  found_at_scene_id: number | null;
  planted_at: string;
}

export interface Rumour {
  id: number;
  scope: RumourScope;
  text: string;
  truth: 'true' | 'false' | 'twisted';
  source_kind: string | null;
  thread_id: number | null;
  heard_at: string | null;
  resolved: boolean;
  chapter_id: number | null;
}

/** The player's own notes: the one thing this window writes. */
export interface JournalEntry {
  id: number;
  chapter_id: number | null;
  text: string;
  created_at: string;
}

export interface StoryArc {
  outline: { premise: string | null; ending: string | null; secret_notes: string | null };
  act: Act | null;
  chapter: Chapter | null;
  /** Closed chapters with their recaps, oldest first. */
  recaps: Array<Pick<Chapter, 'id' | 'number' | 'title' | 'summary'> & { chapter_id: number }>;
  threads: PlotThread[];
  clues: Clue[];
}

/** In-world time: the calendar date, the hour of the day, the season and today's weather. */
export interface NowState {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  month_name: string;
  date_text: string;
  time_of_day: string;
  season: string;
  weather: string;
}

/* The codex: who and what the story has named, and how they are tied together. */

export type EntityKind = 'npc' | 'faction' | 'place' | 'item' | 'deity' | 'event';
export type EntityStatus = 'alive' | 'dead' | 'unknown';

export interface VoiceCard {
  speech_pattern?: string;
  catchphrase?: string;
  goal?: string;
  fear?: string;
  attitude?: string;
}

export interface CodexListItem {
  id: number;
  kind: EntityKind;
  name: string;
  summary: string;
  status: EntityStatus;
  portrait_path: string | null;
  has_voice: boolean;
}

/** One tie as it reads from the entity that was asked for: `as` is this entity's side of it. */
export interface EntityRelation {
  id: number;
  type: string;
  as: string;
  direction: 'out' | 'in';
  entity: { id: number; name: string; kind: EntityKind };
  notes: string;
}

export interface EntityView {
  id: number;
  kind: EntityKind;
  name: string;
  summary: string;
  notes: string;
  /** Only sent with the spoiler setting on. */
  hidden_notes?: string;
  voice: VoiceCard | null;
  portrait_path: string | null;
  status: EntityStatus;
  first_seen_chapter_id: number | null;
  character_id: number | null;
  relations: EntityRelation[];
}

/** A node of the family and faction tree; `relation` is how the node above reads toward this one. */
export interface TreeNode {
  id: number;
  name: string;
  kind: EntityKind;
  relation: string | null;
  links: TreeNode[];
}

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
  status: string;
  conditions: string[] | null;
  inspiration: number;
  portrait_path?: string | null;
  /** Carrying capacity; absent on a server older than the encumbrance package. */
  carried_lb?: number;
  capacity_lb?: number;
  encumbered?: boolean;
}

export interface GameEvent {
  campaign_id: number;
  event_id: number | null;
  kind: string;
  text: string;
  ts: string;
  payload?: unknown;
}

export type Die = { value: number; modifiers: string[] };
export type RollGroup = { value: number; dice: Die[] } | string | number;

export interface RollEntry {
  key: string;
  purpose: string;
  expr: string;
  groups: RollGroup[];
  total: number;
  dc: number | null;
  outcome: string | null;
  /** 20 or 1 on the d20 as the server saw it; null when it said nothing. */
  natural: number | null;
  /** The player edited this one in cheat mode; only their window ever shows it. */
  overridden: boolean;
  /** The rules the server applied on top of what the DM asked for; absent when it applied none. */
  rules_applied?: string[];
  ts: string;
}

export interface CampaignListItem {
  id: number;
  name: string;
  story_shape: string;
  created_at: string;
  last_recap_snippet: string | null;
  pc: { name: string; level: number; class: string | null } | null;
  /** Only sent with ?include_deleted=1; absent on older servers. */
  deleted_at?: string | null;
  /** The wizard's fields; absent on a server older than the setup package. */
  premise?: string | null;
  setting_preset?: string | null;
  setting_name?: string | null;
  needs_ai_fill?: boolean | { name?: boolean; premise?: boolean };
  /** Which halves are still the DM's to write; the boolean above is only "something is". */
  needs_fill?: { name: boolean; premise: boolean };
  /** Set while the player left their character half-filled for the DM to finish. */
  character_draft?: { name?: string; species?: string; lineage?: string | null } | null;
}

export interface GlossaryEntry {
  term: string;
  definition: string;
  source: 'srd' | 'campaign';
  /** The chapter the term was coined in; absent on a server older than the story package. */
  chapter_id?: number | null;
}

export interface RollRow {
  id: number;
  event_id: number | null;
  expr: string;
  groups: RollGroup[] | null;
  total: number;
  purpose: string | null;
  dc: number | null;
  outcome: string | null;
  natural?: number | null;
  overridden?: number;
  /** The rules the server applied to this roll: "tool proficiency +2", "exhaustion -2". */
  rules_applied?: string[];
  ts: string;
}

/** How a homebrew feature resource returns. */
export type ResourcePeriod = 'short' | 'long' | 'never';

/** The homebrew hook a boost applies at. */
export type ClauseWhen =
  | 'always'
  | 'roll'
  | 'hit'
  | 'miss'
  | 'spell_damage'
  | 'damage_dealt'
  | 'damage_taken'
  | 'save_succeeded'
  | 'kill'
  | 'cast'
  | 'turn_start'
  | 'turn_end'
  | 'initiative'
  | 'rest_short'
  | 'rest_long'
  | 'dawn'
  | 'action';

/** One homebrew clause the player may select before a pending roll. */
export interface RollBoost {
  id: string;
  name: string;
  describe: string;
  uses_left: number;
  advantage: boolean;
  bonus: number;
  label: string;
  max: number;
  per: ResourcePeriod;
  spend_on_fire?: boolean;
  when: ClauseWhen;
}

/** The homebrew boosts a pending roll offers and the ones the player has selected. */
export interface PendingRollBoosts {
  boosts_available?: RollBoost[];
  boosts_chosen?: string[];
}

/** A roll the DM asked the player to make, as the `pending_roll` event and endpoint send it. */
export interface PendingRoll extends PendingRollBoosts {
  id: number;
  campaign_id: number;
  expr: string;
  purpose: string;
  dc: number | null;
  roll_type: string;
  advantage: string;
  created_at: string;
  resolved_at: string | null;
  /** Where a sheet-composed flat modifier came from, in order; absent for a roll the DM typed out. */
  modifier_parts?: Array<{ label: string; value: number }>;
  /** Why the dice are what they are, e.g. a cantrip's scaling and a critical's doubling; absent when there is none. */
  dice_notes?: string[];
  /** The combat step this card belongs to, as JSON; absent for a free-standing roll. */
  context_json?: string | null;
}

/** What the resolve and preview endpoints answer with: one rolled result, dice and all. */
export interface RollResult {
  id: number | null;
  purpose: string;
  expr: string;
  total: number;
  output: string;
  groups: RollGroup[];
  natural_d20: number | null;
  natural: number | null;
  dc: number | null;
  outcome: string | null;
}

/* Combat: the battle state the server sends in the snapshot and in every `combat` event. */

export type Team = 'party' | 'enemy' | 'neutral';
export type Visibility = 'full' | 'bars' | 'hidden';
export type SizeCode = 'T' | 'S' | 'M' | 'L' | 'H' | 'G';

export interface MapFeature {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: string;
  label: string;
}

/** Rows of '.', '~' and '#': open, difficult and blocked cells, 5 ft each. */
export interface BattleMap {
  w: number;
  h: number;
  rows: string[];
  features: MapFeature[];
}

/** The part of a stat block the server lets the player screen show; the UI decides when to show it. */
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

/** What the 2024 actions leave on a combatant until its next turn, plus the grapples it is part of. */
export interface CombatFlags {
  dashed?: boolean;
  /** Swings taken with this turn's Attack action. */
  attacks_used?: number;
  dodging?: boolean;
  disengaged?: boolean;
  hidden?: boolean;
  /** Help received: advantage on the next attack against `against_id`, or on the next check. */
  helped_by?: { id: number; name: string; against_id?: number };
  ready?: { trigger: string; action: string };
  grappled_by?: number;
  grappling?: number[];
}

export interface Combatant {
  id: number;
  kind: 'pc' | 'companion' | 'monster';
  character_id: number | null;
  name: string;
  team: Team;
  initiative: number;
  initiative_order: number;
  x: number;
  y: number;
  size: SizeCode;
  hp_current: number;
  hp_max: number;
  temp_hp: number;
  ac: number;
  speed: number;
  conditions: string[];
  /** Empty on a server older than the 2024 actions package. */
  flags: CombatFlags;
  concentration: { name: string } | null;
  death_saves: { successes: number; failures: number };
  movement_left: number;
  action_used: boolean;
  bonus_used: boolean;
  reaction_used: boolean;
  visible: boolean;
  alive: boolean;
  /** Cells per side: 1 for T/S/M, 2 for L, 3 for H, 4 for G. */
  footprint: number;
  /** Wearing armour or a shield it is not proficient with: STR and DEX d20 tests suffer, no spells. */
  armor_penalty: boolean;
  hp_fraction: number;
  distance_ft: number | null;
  marker: string;
  /** Null for a monster without a stat block and for a companion without an anchor feature. */
  known: KnownStats | null;
  /** Null for monsters: both are read off the character sheet. */
  inspiration: number | null;
  exhaustion: number | null;
  /** Set by the server when a portrait exists for this combatant; null falls back to the creature-name lookup. */
  portrait_path: string | null;
}

export interface LegalAction {
  id: string;
  label: string;
  hint: string;
}

export interface CombatEffect {
  id: number;
  target_id: number;
  source_id: number | null;
  name: string;
  kind: 'damage' | 'condition' | 'buff';
  damage_expr: string | null;
  damage_type: string | null;
  save_ability: string | null;
  save_dc: number | null;
  tick: 'start' | 'end';
  ends: string;
  remaining_rounds: number | null;
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

export interface BattleState {
  encounter: {
    id: number;
    status: 'active' | 'ended';
    round: number;
    turn_index: number;
    seed: number;
    visibility: Visibility;
    outcome: string | null;
  };
  map: BattleMap;
  round: number;
  turn_index: number;
  combatants: Combatant[];
  active: { id: number; name: string; team: Team; kind: string } | null;
  legal_actions: LegalAction[];
  effects: CombatEffect[];
  log_tail: CombatLogEntry[];
}

export interface DefeatedFoe {
  name: string;
  cr: number | null;
  xp: number;
}

export interface CombatantSummary {
  id: number;
  name: string;
  team: Team;
  damage_dealt: number;
  damage_taken: number;
  healed: number;
  alive: boolean;
}

/** What `end_encounter` counted; absent on a server older than the summary payload. */
export interface EncounterSummaryPayload {
  rounds: number;
  defeated: DefeatedFoe[];
  xp_suggestion: number;
  combatants: CombatantSummary[];
}

/** Payload of a `combat` event: the whole state plus the entries this tool call wrote. */
export interface CombatEventPayload {
  tool: string;
  encounter_id: number;
  log: CombatLogEntry[];
  state: BattleState;
  summary?: EncounterSummaryPayload;
}
