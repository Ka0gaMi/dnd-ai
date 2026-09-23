// The "New story" wizard: its steps, its draft, and every rule the server would otherwise
// bounce back as a 400. Pure functions only — the components hold the state.
import type { DialValue } from './presets';

export type StepId = 'name' | 'setting' | 'tone' | 'premise' | 'region' | 'character' | 'done';

export const STEPS: Array<{ id: StepId; title: string }> = [
  { id: 'name', title: 'Name' },
  { id: 'setting', title: 'Setting' },
  { id: 'tone', title: 'Tone' },
  { id: 'premise', title: 'Premise' },
  { id: 'region', title: 'Region' },
  { id: 'character', title: 'Character' },
  { id: 'done', title: 'Done' },
];

export type StoryShape = 'structured' | 'sandbox';

export const STORY_SHAPES: Array<{ id: StoryShape; label: string; line: string }> = [
  {
    id: 'structured',
    label: 'Structured with an ending',
    line: 'A plotted story that builds towards a finish the DM is aiming at.',
  },
  {
    id: 'sandbox',
    label: 'Open sandbox',
    line: 'A world to wander: the DM follows wherever you go, with no planned ending.',
  },
];

export interface StoryDraft {
  name: string;
  story_shape: StoryShape;
  setting_preset: string | null;
  tone_dials: Record<string, DialValue>;
  lines: string;
  veils: string;
  premise: string;
}

export const emptyDraft = (): StoryDraft => ({
  name: '',
  story_shape: 'structured',
  setting_preset: null,
  tone_dials: {},
  lines: '',
  veils: '',
  premise: '',
});

export interface NewCampaignBody {
  name?: string;
  story_shape: StoryShape;
  setting_preset?: string;
  tone_dials?: Record<string, DialValue>;
  lines?: string;
  veils?: string;
  premise?: string;
}

/** POST /api/campaigns wants the fields the player actually filled in and nothing else. */
export function campaignBody(draft: StoryDraft): NewCampaignBody {
  const body: NewCampaignBody = { story_shape: draft.story_shape };
  // No name means the DM names it: the server puts a placeholder there until they do.
  if (draft.name.trim()) body.name = draft.name.trim();
  if (draft.setting_preset) body.setting_preset = draft.setting_preset;
  if (Object.keys(draft.tone_dials).length > 0) body.tone_dials = draft.tone_dials;
  if (draft.lines.trim()) body.lines = draft.lines.trim();
  if (draft.veils.trim()) body.veils = draft.veils.trim();
  if (draft.premise.trim()) body.premise = draft.premise.trim();
  return body;
}

/** A story row or snapshot, as far as "what does the DM still owe" is concerned. */
export interface DmWork {
  needs_ai_fill?: boolean | { name?: boolean; premise?: boolean };
  /** What the server actually computes per half; needs_ai_fill is its collapsed form. */
  needs_fill?: { name: boolean; premise: boolean };
  character_draft?: { name?: string; species?: string; lineage?: string | null } | null;
  pc?: { name?: string } | null;
}

/** The flag was a plain boolean before the wizard could leave the name empty too. */
export function fillFlags(value: DmWork['needs_ai_fill']): { name: boolean; premise: boolean } {
  if (value === true) return { name: false, premise: true };
  if (value && typeof value === 'object') return { name: value.name === true, premise: value.premise === true };
  return { name: false, premise: false };
}

/** The server's own per-half answer wins; the collapsed boolean is the fallback for older rows. */
export const workFlags = (row: DmWork): { name: boolean; premise: boolean } =>
  row.needs_fill ?? fillFlags(row.needs_ai_fill);

/** The SRD species a character also picks a lineage inside; every other species has none to pick. */
const LINEAGE_SPECIES = ['Dragonborn', 'Elf', 'Gnome', 'Goliath', 'Tiefling'];

/** What the DM fills in on first play, in the player's words. */
export function dmTodo(row: DmWork): string[] {
  const flags = workFlags(row);
  const todo: string[] = [];
  if (flags.name) todo.push('name the story');
  if (flags.premise) todo.push('write the premise');
  const draft = row.character_draft;
  if (draft && !row.pc) {
    todo.push(draft.name ? `finish ${draft.name}'s sheet` : 'build your character');
    if (draft.species && LINEAGE_SPECIES.includes(draft.species) && !draft.lineage) {
      todo.push(`pick your ${draft.species} lineage`);
    }
  }
  return todo;
}

/** "DM will: name the story, write the premise" - null when nothing is left over. */
export function dmTodoLine(row: DmWork): string | null {
  const todo = dmTodo(row);
  return todo.length ? `DM will: ${todo.join(', ')}` : null;
}

/** The half-made character the server kept for the DM. */
export interface CharacterDraftRow {
  name?: string;
  class?: string;
  species?: string;
  lineage?: string | null;
  background?: string;
  gender?: string;
  idea?: string;
  ability_method?: string;
}

/** What POST /api/campaigns/:id/character answers: a sheet, or the draft it kept instead. */
export interface CreatedCharacter {
  character: { name?: string } | null;
  character_draft?: CharacterDraftRow;
  draft_summary?: string;
  /** Plus languages_chosen_for_you, tools_chosen_for_you and the rest of the engine's notes. */
  [note: string]: unknown;
}

/** A stored character draft in one line, the way the server words it. */
export function draftLine(draft: CharacterDraftRow): string {
  const who = [draft.gender, draft.species, draft.class].filter(Boolean).join(' ');
  const parts = [draft.name, who].filter(Boolean) as string[];
  if (draft.background) parts.push(`${draft.background} background`);
  if (draft.idea) parts.push(`"${draft.idea}"`);
  return parts.length ? parts.join(', ') : 'nothing chosen yet';
}

// --- the character step ------------------------------------------------------

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type AbilityId = (typeof ABILITIES)[number];
export type Scores = Record<AbilityId, number>;

export const ABILITY_NAMES: Record<AbilityId, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
export const POINT_BUY_BUDGET = 27;
const POINT_BUY_COST: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };

export const abilityMod = (score: number): number => Math.floor((score - 10) / 2);
export const signed = (value: number): string => (value >= 0 ? `+${value}` : String(value));

export const standardScores = (): Scores =>
  Object.fromEntries(ABILITIES.map((ability, i) => [ability, STANDARD_ARRAY[i]])) as Scores;

export const pointBuyScores = (): Scores =>
  Object.fromEntries(ABILITIES.map((ability) => [ability, 8])) as Scores;

/** Each array number is used once: giving one ability a value hands its old one to the holder. */
export function assignStandard(scores: Scores, ability: AbilityId, value: number): Scores {
  const next = { ...scores };
  const holder = ABILITIES.find((a) => a !== ability && next[a] === value);
  if (holder) next[holder] = next[ability];
  next[ability] = value;
  return next;
}

export function pointBuyCost(scores: Scores): number {
  return ABILITIES.reduce((total, ability) => total + (POINT_BUY_COST[scores[ability]] ?? 0), 0);
}

export function abilitiesProblem(method: 'standard_array' | 'point_buy', scores: Scores): string | null {
  const values = ABILITIES.map((ability) => scores[ability]);
  if (method === 'standard_array') {
    const sorted = [...values].sort((a, b) => b - a);
    return sorted.join(',') === STANDARD_ARRAY.join(',')
      ? null
      : 'Use each of 15, 14, 13, 12, 10 and 8 exactly once.';
  }
  if (values.some((score) => POINT_BUY_COST[score] === undefined)) {
    return 'Point buy needs every score between 8 and 15.';
  }
  const cost = pointBuyCost(scores);
  return cost > POINT_BUY_BUDGET ? `Point buy allows ${POINT_BUY_BUDGET} points; this costs ${cost}.` : null;
}

export interface BonusOption {
  id: string;
  label: string;
  bonuses: Partial<Record<AbilityId, number>>;
}

/** The background raises its three abilities by +2 and +1, or by +1 each: every legal way, listed. */
export function bonusOptions(allowed: string[]): BonusOption[] {
  const abilities = allowed.filter((a): a is AbilityId => (ABILITIES as readonly string[]).includes(a));
  const options: BonusOption[] = [];
  for (const two of abilities) {
    for (const one of abilities) {
      if (one === two) continue;
      options.push({
        id: `${two}2-${one}1`,
        label: `+2 ${ABILITY_NAMES[two]}, +1 ${ABILITY_NAMES[one]}`,
        bonuses: { [two]: 2, [one]: 1 },
      });
    }
  }
  if (abilities.length > 1) {
    options.push({
      id: 'spread',
      label: `+1 ${abilities.map((a) => ABILITY_NAMES[a]).join(', +1 ')}`,
      bonuses: Object.fromEntries(abilities.map((a) => [a, 1])),
    });
  }
  return options;
}

export function bonusProblem(bonuses: Partial<Record<AbilityId, number>>, allowed: string[]): string | null {
  const raised = ABILITIES.filter((ability) => (bonuses[ability] ?? 0) > 0);
  if (raised.some((ability) => !allowed.includes(ability))) {
    return `This background raises only ${allowed.join(', ')}.`;
  }
  const total = ABILITIES.reduce((sum, ability) => sum + (bonuses[ability] ?? 0), 0);
  const pattern = raised
    .map((ability) => bonuses[ability] ?? 0)
    .sort((a, b) => b - a)
    .join(',');
  if (total !== 3 || (pattern !== '2,1' && pattern !== '1,1,1')) {
    return 'Raise the background abilities by +2 and +1, or by +1 each.';
  }
  return null;
}

export type Complexity = 'simple' | 'medium' | 'complex';

export interface ClassInfo {
  desc: string;
  roles: string[];
  complexity: Complexity;
}

/** Plain words for the twelve SRD classes: what you do, where you stand, how much to track. */
export const CLASS_INFO: Record<string, ClassInfo> = {
  Barbarian: {
    desc: 'Rage into the front line and shrug off hits nobody else could take.',
    roles: ['frontline'],
    complexity: 'simple',
  },
  Bard: {
    desc: 'Talk your way in, lift the party, and cast a little of everything.',
    roles: ['caster', 'support'],
    complexity: 'medium',
  },
  Cleric: {
    desc: 'Divine magic: keep everyone standing and smite what deserves it.',
    roles: ['healer', 'caster'],
    complexity: 'medium',
  },
  Druid: {
    desc: 'Nature magic, and turning into whatever animal the moment needs.',
    roles: ['caster', 'healer'],
    complexity: 'complex',
  },
  Fighter: {
    desc: 'Weapons and armour done better than anyone, with little to track.',
    roles: ['frontline'],
    complexity: 'simple',
  },
  Monk: {
    desc: 'Fast unarmed fighter who runs up walls and never stands still.',
    roles: ['skirmisher'],
    complexity: 'medium',
  },
  Paladin: {
    desc: 'Armoured oath-keeper who heals a little and hits very hard.',
    roles: ['frontline', 'healer'],
    complexity: 'medium',
  },
  Ranger: {
    desc: 'Tracker and archer at home in the wild, with a few spells.',
    roles: ['skirmisher', 'caster'],
    complexity: 'medium',
  },
  Rogue: {
    desc: 'Scout and sneak, then pick the moment for one enormous hit.',
    roles: ['skirmisher'],
    complexity: 'simple',
  },
  Sorcerer: {
    desc: 'Innate magic you bend on the spot, from a short list of spells.',
    roles: ['caster'],
    complexity: 'medium',
  },
  Warlock: {
    desc: 'Power borrowed from a patron, spent in few but heavy blasts.',
    roles: ['caster'],
    complexity: 'medium',
  },
  Wizard: {
    desc: 'A spellbook with an answer to everything you prepared for.',
    roles: ['caster'],
    complexity: 'complex',
  },
};

// --- what GET /api/srd/options sends ----------------------------------------

export interface ClassOption {
  name: string;
  hit_die: string;
  primary_ability: string | null;
  saving_throws: string[];
  spellcaster: boolean;
}

export interface SpeciesOption {
  name: string;
  size: string | null;
  speed: number;
  /** The subspecies to choose inside this one, empty for most; absent on an older server. */
  lineages?: string[];
}

export interface BackgroundOption {
  name: string;
  ability_scores: string[];
  feat: string;
  skills: string[];
}

export interface SkillChoiceGroup {
  desc: string;
  choose: number;
  from: string[];
}

export interface EquipmentPick {
  desc: string;
  choose: number;
  options: string[];
}

export interface EquipmentBundle {
  label: string;
  desc: string;
  items: Array<{ name: string; qty: number; notes?: string }>;
  gold: number;
  /** Empty for most bundles; a gaming set or an instrument is picked by name. */
  picks?: EquipmentPick[];
}

export interface ToolChoiceGroup {
  desc: string;
  choose: number;
  from: string[];
}

/** A level 1 feature that is itself a choice: Expertise, a Fighting Style, Metamagic, invocations. */
export interface FeatureChoice {
  feature: string;
  choose: number;
  from: string[];
  desc: string;
}

export interface LanguageOption {
  name: string;
  rarity: string;
  speakers: string;
  script: string | null;
}

export interface ClassDetail {
  name: string;
  hit_die: string;
  skill_choices: SkillChoiceGroup[];
  /** All three are absent on a server older than the partial-fill package. */
  tool_choices?: ToolChoiceGroup[];
  feature_choices?: FeatureChoice[];
  equipment_options: EquipmentBundle[];
  level_1_features: Array<{ name: string; text: string }>;
  spellcasting: {
    ability: string;
    cantrips_to_choose: number;
    spells_to_choose: number;
    cantrip_options: string[];
    spell_options: string[];
  } | null;
}

export interface BackgroundDetail {
  name: string;
  ability_scores: string[];
  /** choices is what the origin feat still asks for, e.g. which list Magic Initiate draws on. */
  feat: { name: string; text: string; choices?: Record<string, unknown> | null };
  skills: string[];
  tools: string[];
  equipment_options?: EquipmentBundle[];
}

/** The one kind of feat choice the wizard can offer: pick one of a named list. */
export interface FeatChoiceField {
  key: string;
  label: string;
  options: string[];
}

const FEAT_CHOICE_LABELS: Record<string, string> = {
  ability: 'Which ability it raises',
  spell_list: 'Which spell list the spells come from',
  spellcasting_ability: 'Which ability casts them',
};

/** Anything else in the spec (counts, free text) is left to the server to fill in. */
export function featChoiceFields(spec: Record<string, unknown> | null | undefined): FeatChoiceField[] {
  if (!spec) return [];
  return Object.entries(spec)
    .filter(([, value]) => Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
    .map(([key, value]) => ({
      key,
      label: FEAT_CHOICE_LABELS[key] ?? key.replace(/_/g, ' '),
      options: value as string[],
    }));
}

/** One subspecies of the chosen species, with whatever traits the SRD hangs on it. */
export interface LineageOption {
  name: string;
  traits: Array<{ name: string; text: string }>;
}

export interface CharacterOptions {
  classes: ClassOption[];
  species: SpeciesOption[];
  backgrounds: BackgroundOption[];
  /** Absent on a server older than the partial-fill package. */
  languages?: { rule: string; known: string[]; options: LanguageOption[] };
  class_detail?: ClassDetail;
  background_detail?: BackgroundDetail;
  species_detail?: {
    name: string;
    size: string | null;
    speed: number;
    traits: Array<{ name: string; text: string }>;
    /** Each lineage with the traits it grants; absent on an older server. */
    lineages?: LineageOption[];
  };
}

export const EMPTY_OPTIONS: CharacterOptions = { classes: [], species: [], backgrounds: [] };

export interface CharacterDraft {
  name: string;
  class: string;
  species: string;
  background: string;
  /** Blank when the species has no lineages, or when the player leaves it to the DM. */
  lineage: string;
  /** Only for the DM: who they are, when the player does not build the sheet here. */
  gender: string;
  idea: string;
  ability_method: 'standard_array' | 'point_buy';
  abilities: Scores;
  bonus_option: string | null;
  skills: string[];
  /** Every list below may stay empty: the server picks and says what it picked. */
  languages: string[];
  tools: string[];
  feature_options: Record<string, string[]>;
  feat_choices: Record<string, string>;
  equipment: string | null;
  background_equipment: string | null;
  /** One name per "choose from this category" slot, the class bundle's first. */
  equipment_picks: string[];
  cantrips: string[];
  spells: string[];
  /** A Wizard's extra pages: the prepared spells above are in the book already. */
  spellbook: string[];
  alignment: string;
  backstory: string;
}

export const emptyCharacter = (): CharacterDraft => ({
  name: '',
  class: '',
  species: '',
  background: '',
  lineage: '',
  gender: '',
  idea: '',
  ability_method: 'standard_array',
  abilities: standardScores(),
  bonus_option: null,
  skills: [],
  languages: [],
  tools: [],
  feature_options: {},
  feat_choices: {},
  equipment: null,
  background_equipment: null,
  equipment_picks: [],
  cantrips: [],
  spells: [],
  spellbook: [],
  alignment: '',
  backstory: '',
});

export const LANGUAGES_TO_CHOOSE = 2;
export const SPELLBOOK_SIZE = 6;

/** The chosen species' lineages, from the detail half of the payload when it has them, else by name. */
export function speciesLineages(options: CharacterOptions, species: string): LineageOption[] {
  if (!species) return [];
  const detail = options.species_detail;
  if (detail?.name === species && detail.lineages?.length) return detail.lineages;
  const named = options.species.find((option) => option.name === species)?.lineages ?? [];
  return named.map((name) => ({ name, traits: [] }));
}

/** The bundle the player picked, or the first one the server would default to. */
const chosenBundle = (bundles: EquipmentBundle[] | undefined, label: string | null): EquipmentBundle | undefined =>
  bundles?.find((bundle) => bundle.label === label) ?? bundles?.[0];

/** Every "choose one from this category" slot in play, class bundle first, as the server orders them. */
export function pickSlots(draft: CharacterDraft, options: CharacterOptions): EquipmentPick[] {
  const classPicks = chosenBundle(options.class_detail?.equipment_options, draft.equipment)?.picks ?? [];
  const backgroundPicks =
    chosenBundle(options.background_detail?.equipment_options, draft.background_equipment)?.picks ?? [];
  return [...classPicks, ...backgroundPicks].flatMap((pick) => Array.from({ length: pick.choose }, () => pick));
}

export type FieldId =
  | 'name'
  | 'class'
  | 'species'
  | 'lineage'
  | 'background'
  | 'abilities'
  | 'bonuses'
  | 'skills'
  | 'equipment'
  | 'cantrips'
  | 'spells';

export interface NewCharacterBody {
  name?: string;
  species?: string;
  lineage?: string;
  class?: string;
  background?: string;
  gender?: string;
  idea?: string;
  ability_method?: 'standard_array' | 'point_buy';
  abilities?: Scores;
  ability_bonuses?: Partial<Record<AbilityId, number>>;
  skill_choices?: string[];
  languages?: string[];
  tools?: string[];
  feature_options?: Record<string, string[]>;
  feat_choices?: Record<string, string>;
  equipment_choice?: string;
  background_equipment_choice?: string;
  equipment_picks?: string[];
  cantrips?: string[];
  spells?: string[];
  spellbook?: string[];
  alignment?: string;
  backstory?: string;
}

/** What the server needs before it can build a sheet; anything less is kept as a draft. */
export function isCompleteCharacter(draft: CharacterDraft, options: CharacterOptions): boolean {
  const lineages = speciesLineages(options, draft.species);
  return (
    draft.name.trim() !== '' &&
    draft.class !== '' &&
    draft.species !== '' &&
    draft.background !== '' &&
    (lineages.length === 0 || draft.lineage !== '')
  );
}

const bonusesOf = (draft: CharacterDraft, allowed: string[]): Partial<Record<AbilityId, number>> =>
  bonusOptions(allowed).find((option) => option.id === draft.bonus_option)?.bonuses ?? {};

/**
 * Everything the server checks once the player means to build the sheet here, checked first so they
 * never meet a raw 400. A half-filled character is not a mistake: it goes to the DM as a draft.
 */
export function characterProblems(
  draft: CharacterDraft,
  options: CharacterOptions,
): Partial<Record<FieldId, string>> {
  const problems: Partial<Record<FieldId, string>> = {};
  if (!isCompleteCharacter(draft, options)) return problems;

  const abilities = abilitiesProblem(draft.ability_method, draft.abilities);
  if (abilities) problems.abilities = abilities;

  const allowed = options.background_detail?.ability_scores ?? [];
  if (draft.background && allowed.length > 0) {
    const bonuses = bonusProblem(bonusesOf(draft, allowed), allowed);
    if (bonuses) problems.bonuses = bonuses;
  }

  const groups = options.class_detail?.skill_choices ?? [];
  const wanted = groups.reduce((sum, group) => sum + group.choose, 0);
  if (draft.class && draft.skills.length !== wanted) {
    problems.skills = `Choose ${wanted} skill${wanted === 1 ? '' : 's'}; you have ${draft.skills.length}.`;
  }

  const bundles = options.class_detail?.equipment_options ?? [];
  if (bundles.length > 0 && !bundles.some((bundle) => bundle.label === draft.equipment)) {
    problems.equipment = 'Pick a starting equipment pack.';
  }

  const casting = options.class_detail?.spellcasting ?? null;
  if (casting) {
    if (draft.cantrips.length !== casting.cantrips_to_choose) {
      problems.cantrips = `Choose ${casting.cantrips_to_choose} cantrips; you have ${draft.cantrips.length}.`;
    }
    if (draft.spells.length !== casting.spells_to_choose) {
      problems.spells = `Choose ${casting.spells_to_choose} level 1 spells; you have ${draft.spells.length}.`;
    }
  }
  return problems;
}

/**
 * POST /api/campaigns/:id/character body. A complete character carries every rule the server checks;
 * a half-filled one carries only what the player answered and is kept as a draft for the DM.
 */
export function characterBody(draft: CharacterDraft, options: CharacterOptions): NewCharacterBody {
  const body: NewCharacterBody = {};
  if (draft.name.trim()) body.name = draft.name.trim();
  if (draft.species) body.species = draft.species;
  if (draft.lineage) body.lineage = draft.lineage;
  if (draft.class) body.class = draft.class;
  if (draft.background) body.background = draft.background;
  if (draft.gender.trim()) body.gender = draft.gender.trim();
  if (draft.idea.trim()) body.idea = draft.idea.trim();
  if (draft.alignment.trim()) body.alignment = draft.alignment.trim();
  if (draft.backstory.trim()) body.backstory = draft.backstory.trim();
  if (!isCompleteCharacter(draft, options)) {
    body.ability_method = draft.ability_method;
    return body;
  }

  const allowed = options.background_detail?.ability_scores ?? [];
  body.ability_method = draft.ability_method;
  body.abilities = { ...draft.abilities };
  body.ability_bonuses = bonusesOf(draft, allowed);
  if (options.class_detail?.skill_choices.length) body.skill_choices = [...draft.skills];
  if (draft.equipment) body.equipment_choice = draft.equipment;
  if (draft.background_equipment) body.background_equipment_choice = draft.background_equipment;
  // Every list below is optional: left empty, the server picks and reports what it chose.
  if (draft.languages.length === LANGUAGES_TO_CHOOSE) body.languages = [...draft.languages];
  if (draft.tools.length) body.tools = [...draft.tools];
  const features = Object.entries(draft.feature_options).filter(([, picks]) => picks.length > 0);
  if (features.length) body.feature_options = Object.fromEntries(features);
  const feats = Object.entries(draft.feat_choices).filter(([, pick]) => pick !== '');
  if (feats.length) body.feat_choices = Object.fromEntries(feats);
  const slots = pickSlots(draft, options).length;
  if (slots > 0 && draft.equipment_picks.filter(Boolean).length === slots) {
    body.equipment_picks = draft.equipment_picks.slice(0, slots);
  }
  if (options.class_detail?.spellcasting) {
    body.cantrips = [...draft.cantrips];
    body.spells = [...draft.spells];
    // The book always holds the prepared spells; the server fills the rest of the pages itself.
    const book = [...draft.spells, ...draft.spellbook];
    if (draft.class === 'Wizard' && book.length === SPELLBOOK_SIZE) body.spellbook = book;
  }
  return body;
}

/** The engine's "you left this to me" notes, as one line for the Done card. */
export function chosenForYou(result: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(result)) {
    if (!key.endsWith('_chosen_for_you') || !value) continue;
    const what = key.replace('_chosen_for_you', '').replace(/_/g, ' ');
    lines.push(`${what}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  }
  return lines;
}

const ERROR_FIELDS: Array<{ test: RegExp; field: FieldId }> = [
  { test: /^unknown class /i, field: 'class' },
  { test: /^unknown species /i, field: 'species' },
  { test: /^unknown background /i, field: 'background' },
  { test: /standard array|point buy|manual scores/i, field: 'abilities' },
  { test: /background (must raise|raises only)/i, field: 'bonuses' },
  { test: /skill proficiencies|each skill can only|^choose \d+ from/i, field: 'skills' },
  { test: /equipment/i, field: 'equipment' },
  { test: /lineage/i, field: 'lineage' },
  { test: /cantrip|no spellcasting at level 1/i, field: 'cantrips' },
  { test: /spell/i, field: 'spells' },
];

/** Puts the server's 400 next to the field that caused it; null means "show it at the top". */
export function fieldForError(message: string): FieldId | null {
  return ERROR_FIELDS.find((entry) => entry.test.test(message))?.field ?? null;
}
