// Progression: the shapes the server's level-up, decision, library and play-profile routes send,
// and the pure parts of the panels - the power report in words, the level-up body the player's
// picks make, and the little sums the library and profile cards show.

import type { Help } from './rulesHelp';

export interface PowerItem {
  part: string;
  cost: number;
  rule: string;
}

export type PowerVerdict = 'within' | 'over_budget';

export interface PowerReport {
  budget_used: number;
  budget_allowed: number;
  items: PowerItem[];
  verdict: PowerVerdict;
  text: string;
}

export interface Mechanics {
  asi?: Array<{ ability: string; amount: number }>;
  to_hit?: number;
  ac?: number;
  extra_damage?: { dice: string; per: 'turn' | 'hit' };
  once_per?: 'short' | 'long';
  effect?: string;
  effect_cost?: number;
  skill_proficiencies?: string[];
  speed?: number;
  resistances?: string[];
  spells?: string[];
  features_text?: string;
  over_budget?: boolean;
}

export interface Homebrew {
  id: number;
  campaign_id: number | null;
  scope: 'campaign' | 'library';
  kind: 'background' | 'feat' | 'feature' | 'subclass' | 'spell';
  name: string;
  schema: { text?: string; justification?: string | null } & Record<string, unknown>;
  power_report: PowerReport | null;
  power_label: PowerVerdict;
  created_by: 'dm' | 'player';
  created_at: string;
}

export interface LibraryAnswer {
  campaign: Homebrew[];
  library: Homebrew[];
}

export interface PlayProfile {
  tags: Record<string, number>;
  exemplars: Array<{ text: string; tags: string[]; created_at: string }>;
  engine: {
    skills: Record<string, number>;
    rolls: Record<string, number>;
    actions: Record<string, number>;
    effects: Record<string, number>;
  };
}

/** One of the DM's own level-up offers, priced by the server when it was prepared. */
export interface Suggestion {
  name: string;
  text: string;
  mechanics: Mechanics;
  justification?: string;
  report: PowerReport;
  /** The library row the server saved this suggestion to when it prepared the window. */
  homebrew_id: number;
}

/** What the rulebook says about one named option, for the hover beside it. Sent by newer servers only. */
export interface OptionDetail {
  name: string;
  level?: number;
  school?: string;
  casting_time?: string;
  range?: string;
  duration?: string;
  concentration?: boolean;
  ritual?: boolean;
  prerequisite?: string;
  short_text: string;
  /** Set when this option is a piece of homebrew rather than the rulebook's own. */
  homebrew?: true;
  homebrew_id?: number;
  power_label?: PowerVerdict;
}

export interface SpellOptionObject {
  name: string;
  homebrew?: true;
  homebrew_id?: number;
  power_label?: PowerVerdict;
}

/** A cantrip or spell option: a bare rulebook name today, or an object naming a piece of homebrew. */
export type SpellOption = string | SpellOptionObject;

export interface NormalisedOption {
  name: string;
  homebrew: boolean;
  homebrewId: number | null;
  powerLabel: PowerVerdict | null;
}

/** Reads a spell option the same way whether the server sent a bare name or a homebrew object. */
export function normaliseOption(option: SpellOption): NormalisedOption {
  if (typeof option === 'string') return { name: option, homebrew: false, homebrewId: null, powerLabel: null };
  return {
    name: option.name,
    homebrew: option.homebrew === true,
    homebrewId: option.homebrew_id ?? null,
    powerLabel: option.power_label ?? null,
  };
}

/** A feature that is itself a choice: Expertise, a Fighting Style, Metamagic, an invocation. */
export interface FeatureChoiceSpec {
  feature: string;
  choose: number;
  from: string[];
  desc: string;
}

/** A feat on offer, with what the feat itself still asks for when it asks for anything. */
export interface FeatOption {
  name: string;
  text: string;
  choices?: Record<string, unknown> | null;
}

/** The 2024 "swap one on levelling": what is held now, and what may be learned in its place. */
export interface CantripSwap {
  rule: string;
  held: string[];
  options: SpellOption[];
}

export interface SpellSwap {
  rule: string;
  held: string[];
  options: Record<string, SpellOption[]>;
}

/** A Wizard's new pages: required picks, none of them already in the book. */
export interface SpellbookSpec {
  rule: string;
  to_add: number;
  held: string[];
  options: Record<string, SpellOption[]>;
}

export interface LevelUpSrd {
  supported?: boolean;
  message?: string;
  from_level?: number;
  to_level?: number;
  proficiency_bonus?: number;
  /** The species bonuses are already folded in: show the number and the dice as they are sent. */
  hp?: { average: number; roll: string; choose: string[] };
  features?: Array<{ name: string; text: string }>;
  subclass_choice?: Array<{
    name: string;
    summary: string | null;
    text: string;
    /** Set when the DM built this option rather than the rulebook offering it. */
    homebrew?: true;
    homebrew_id?: number;
    power_label?: PowerVerdict;
    flavour_text?: string;
  }>;
  /** Features the level gives that the player still has to fill in; absent on an older server. */
  feature_choices?: FeatureChoiceSpec[];
  feature_choices_rule?: string;
  ability_score_improvement?: { rule: string; feat_options: FeatOption[] };
  /** Level 19's boon, offered as feats the same way the improvement offers them. */
  epic_boon?: { epic: boolean; rule: string; feat_options: FeatOption[] };
  spellcasting?: {
    cantrips_to_add: number;
    spells_to_add: number;
    cantrip_options: SpellOption[];
    spell_options: Record<string, SpellOption[]>;
    max_spell_level: number;
    spell_slots: Record<string, { max: number; used: number }>;
    replace_cantrip?: CantripSwap;
    replace_spell?: SpellSwap;
    spellbook?: SpellbookSpec;
  };
  /** Keyed by the option's own name: spells, cantrips, feats and subclasses alike. */
  details?: Record<string, OptionDetail>;
}

export interface Recommendation {
  name: string;
  why: string;
}

/** What the DM would pick, and why. Badges only: nothing here is ticked for the player. */
export interface LevelUpRecommendations {
  spells?: Recommendation[];
  cantrips?: Recommendation[];
  subclass?: Recommendation;
  feat?: Recommendation;
  asi?: { abilities: string[]; why: string };
  hp?: 'average' | 'roll';
}

export interface LevelUpWindow {
  to_level: number | null;
  prepared_at: string | null;
  srd: LevelUpSrd;
  suggestions: Suggestion[];
  recommendations?: LevelUpRecommendations;
}

export interface LevelUpAnswer {
  character_id: number;
  /** Whether the server would grant the next level right now; independent of whether a window is prepared. */
  available: boolean;
  /** Null until the DM prepares the window, even when a level is available. */
  level_up: LevelUpWindow | null;
}

export const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

export type AbilityKey = (typeof ABILITY_KEYS)[number];

/** What the feat itself asks for, in the engine's own key names. */
export interface FeatChoices {
  ability?: string;
  ability_increases?: Record<string, number>;
  skills?: string[];
  spell_list?: string;
  spellcasting_ability?: string;
  cantrips?: string[];
  spell?: string;
}

/** One swap: the spell given up, and the one learned in its place. */
export interface SwapPick {
  old: string;
  new: string;
}

export interface LevelUpChoices {
  hp?: 'average' | 'roll';
  subclass?: string;
  ability_increases?: Record<string, number>;
  feat?: string;
  feat_choices?: FeatChoices;
  feature_options?: Record<string, string[]>;
  cantrips?: string[];
  spells?: string[];
  replace_cantrip?: SwapPick;
  replace_spell?: SwapPick;
  spellbook?: string[];
}

export interface LevelUpBody {
  choices: LevelUpChoices;
  homebrew_ids?: number[];
}

/** What the panel is holding: the rulebook picks on the left, the DM suggestion on the right. */
export interface LevelUpPicks {
  hp: 'average' | 'roll';
  subclass: string | null;
  asi_mode: 'abilities' | 'feat';
  increases: Record<string, number>;
  feat: string | null;
  /** What the chosen feat still asks for, keyed by the choice it fills; every value a list of typed names. */
  feat_choices: Record<string, string[]>;
  /** Picks for the features that are themselves a choice, keyed by the feature's name. */
  feature_options: Record<string, string[]>;
  cantrips: string[];
  spells: string[];
  swap_cantrip: SwapPick;
  swap_spell: SwapPick;
  spellbook: string[];
  /** The suggestion the player took, by its place in the list; null means the rulebook path. */
  suggestion: number | null;
}

const noSwap = (): SwapPick => ({ old: '', new: '' });

export const emptyPicks = (): LevelUpPicks => ({
  hp: 'average',
  subclass: null,
  asi_mode: 'abilities',
  increases: {},
  feat: null,
  feat_choices: {},
  feature_options: {},
  cantrips: [],
  spells: [],
  swap_cantrip: noSwap(),
  swap_spell: noSwap(),
  spellbook: [],
  suggestion: null,
});

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Nothing to answer until the DM has prepared the window; an unsupported level has no panel either. */
export function pendingLevelUp(answer: LevelUpAnswer | null | undefined): LevelUpWindow | null {
  const window = answer?.level_up;
  if (!window || window.prepared_at === null) return null;
  return window.srd.supported === false ? null : window;
}

/** The header: "Level 3 → 4", from whichever of the two the server filled in. */
export function levelUpTitle(window: LevelUpWindow): string {
  const to = window.srd.to_level ?? window.to_level;
  const from = window.srd.from_level ?? (to === null || to === undefined ? null : to - 1);
  return from === null || to === null || to === undefined ? 'Level up' : `Level ${from} → ${to}`;
}

/**
 * The line above an option's text: a spell's "Level 1 · Evocation · 1 action · 120 ft · Instantaneous",
 * or a feat's prerequisite. A subclass has neither, and gets no header line.
 */
export function detailHeader(detail: OptionDetail | undefined): string {
  if (!detail) return '';
  const parts: string[] = [];
  if (detail.level !== undefined) parts.push(detail.level === 0 ? 'Cantrip' : `Level ${detail.level}`);
  if (detail.school) parts.push(detail.school);
  if (detail.casting_time) parts.push(detail.casting_time);
  if (detail.range) parts.push(detail.range);
  if (detail.duration) parts.push(detail.duration);
  if (detail.concentration) parts.push('Concentration');
  else if (detail.ritual) parts.push('Ritual');
  if (parts.length === 0 && detail.prerequisite) return `Prerequisite: ${detail.prerequisite}`;
  return parts.join(' · ');
}

/** The hover for one option: the server's details when it sent them, else the rulebook's own words. */
export function optionHelp(
  name: string,
  detail: OptionDetail | undefined,
  fallback: Help | null,
  why: string | null,
  /** The DM's own words for a piece of homebrew, shown instead of the rulebook's short text. */
  flavourText?: string | null,
): Help | null {
  if (detail) return { title: detail.name || name, text: flavourText || detail.short_text };
  if (fallback) return fallback;
  if (flavourText) return { title: name, text: flavourText };
  // Nothing to say about the option itself, but the DM's reason still deserves somewhere to sit.
  return why ? { title: name, text: '' } : null;
}

/** The tooltip for a spell name on the sheet: the fetched rulebook detail when it has arrived, else just its level. */
export function spellTooltip(
  name: string,
  detail: OptionDetail | null,
  level?: number,
): { help: Help | null; head: string } {
  if (detail) return { help: { title: detail.name || name, text: detail.short_text }, head: detailHeader(detail) };
  if (level !== undefined) return { help: { title: name, text: `Level ${level}` }, head: '' };
  return { help: null, head: '' };
}

export interface SpellEffect {
  kind: string;
  damage?: string;
  save_ability?: string;
  half_on_save?: boolean;
  shape?: string;
  healing?: string;
  condition?: string;
  targets?: number;
}

/** A homebrew spell's effect in plain words, in the order a player reads a card: what it does, the save, then its reach. */
export function spellEffectWords(effect: SpellEffect): string {
  const parts: string[] = [];
  if (effect.damage) parts.push(effect.damage);
  if (effect.healing) parts.push(`${effect.healing} healing`);
  if (effect.save_ability) parts.push(`${effect.save_ability.toUpperCase()} save DC from your sheet`);
  if (effect.half_on_save) parts.push('half on save');
  if (effect.condition) parts.push(effect.condition);
  if (effect.shape) parts.push(effect.shape);
  if (effect.targets) parts.push(`${effect.targets} target${effect.targets === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(', ') : effect.kind;
}

/** The stats line above a homebrew spell card, matching the option tooltips: level, school, casting time, range, duration, then concentration or ritual. */
export function spellHeader(schema: {
  level: number;
  school?: string;
  casting_time?: string;
  range?: string;
  duration?: string;
  concentration?: boolean;
  ritual?: boolean;
}): string {
  return detailHeader({ name: '', short_text: '', ...schema });
}

export type OptionKind = 'spell' | 'cantrip' | 'subclass' | 'feat';

const RECOMMENDED_LISTS: Record<string, 'spells' | 'cantrips'> = { spell: 'spells', cantrip: 'cantrips' };

/** Why the DM recommends this option, or null when it is not one of theirs. */
export function recommendedWhy(
  recommendations: LevelUpRecommendations | undefined,
  kind: OptionKind,
  name: string,
): string | null {
  if (!recommendations) return null;
  const wanted = name.trim().toLowerCase();
  const list = RECOMMENDED_LISTS[kind];
  if (list) {
    const found = (recommendations[list] ?? []).find((entry) => entry.name?.trim().toLowerCase() === wanted);
    return found?.why ?? null;
  }
  const single = kind === 'subclass' ? recommendations.subclass : recommendations.feat;
  return single && single.name?.trim().toLowerCase() === wanted ? single.why : null;
}

/** The ability scores the DM would raise, lower-cased to match the panel's own keys. */
export function recommendedAbilities(recommendations: LevelUpRecommendations | undefined): string[] {
  return (recommendations?.asi?.abilities ?? []).map((ability) => ability.trim().toLowerCase());
}

/** Every spell on offer by name, whether the server grouped them by level or sent one flat list. */
export function spellOptionNames(options: SpellOption[] | Record<string, SpellOption[]> | undefined): string[] {
  const flat = Array.isArray(options) ? options : Object.values(options ?? {}).flat();
  return flat.map((option) => normaliseOption(option).name);
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A skill key as the player reads it: "sleight of hand", not "sleight_of_hand". */
export const featureOptionLabel = (option: string): string => option.replace(/_/g, ' ');

/** An option in a feat's sub-picker as the player reads it: "STR", or "Wizard". */
export const featOptionLabel = (value: string): string =>
  (ABILITY_KEYS as readonly string[]).includes(value)
    ? value.toUpperCase()
    : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;

/** What is still wrong with the picks for one choice-feature, in the words the player needs. */
export function featureChoiceProblem(spec: FeatureChoiceSpec, picked: string[]): string | null {
  if (picked.length !== spec.choose) {
    return `Pick ${spec.choose} for ${spec.feature} (you have picked ${picked.length}).`;
  }
  if (new Set(picked.map((pick) => pick.trim().toLowerCase())).size !== picked.length) {
    return `Each ${spec.feature} pick must be different.`;
  }
  const stray = picked.find((pick) => !spec.from.some((option) => same(option, pick)));
  return stray ? `"${featureOptionLabel(stray)}" is no longer an option for ${spec.feature}.` : null;
}

export type FeatFieldKind = 'one' | 'many' | 'increases';

/** One thing a feat asks the player for, flattened out of the server's per-feat choices object. */
export interface FeatChoiceField {
  /** The feat_choices key it fills. */
  key: string;
  /** A noun the messages and the legend both read well with. */
  label: string;
  kind: FeatFieldKind;
  choose: number;
  /** Empty when the server offered no list and the player has to type the names. */
  options: string[];
  /** The server's own words about this choice, when it sent any. */
  desc: string;
  help: string | null;
}

interface FeatFieldSpec {
  label: string;
  help: string | null;
  /** The engine's key, when it differs from the name the offer uses. */
  key?: string;
}

const FEAT_FIELDS: Record<string, FeatFieldSpec> = {
  ability: { label: 'the ability score it raises', help: 'ability_score' },
  ability_increases: { label: 'where its two points go', help: 'ability_score' },
  skills_or_tools: { label: 'skills or tools', help: 'skills', key: 'skills' },
  spell_list: { label: 'a spell list', help: null },
  spellcasting_ability: { label: 'the ability that casts them', help: 'spellcasting_ability' },
  cantrips: { label: 'cantrips', help: 'always_prepared' },
  spell: { label: 'a level 1 spell', help: 'always_prepared' },
};

/** How many picks a description like "Any 3 skills or tools" asks for. */
const countIn = (text: string): number => Number(/(\d+)/.exec(text)?.[1] ?? 1);

/** The sub-pickers to show under a chosen feat: a list to choose from, boxes to type in, or the two points. */
export function featChoiceFields(choices: Record<string, unknown> | null | undefined): FeatChoiceField[] {
  const fields: FeatChoiceField[] = [];
  for (const [name, raw] of Object.entries(choices ?? {})) {
    const spec = FEAT_FIELDS[name];
    if (!spec) continue;
    const field = { key: spec.key ?? name, label: spec.label, help: spec.help, desc: '' };
    if (Array.isArray(raw)) fields.push({ ...field, kind: 'one', choose: 1, options: raw.map(String) });
    else if (typeof raw === 'number') fields.push({ ...field, kind: 'many', choose: raw, options: [] });
    else if (name === 'ability_increases') {
      fields.push({ ...field, kind: 'increases', choose: 2, options: [], desc: String(raw) });
    } else if (name === 'skills_or_tools') {
      fields.push({ ...field, kind: 'many', choose: countIn(String(raw)), options: [], desc: String(raw) });
    } else fields.push({ ...field, kind: 'one', choose: 1, options: [], desc: String(raw) });
  }
  return fields;
}

/** The ability bumps worth sending: the zeroes the panel keeps for its boxes are dropped. */
export function abilityIncreases(increases: Record<string, number>): Record<string, number> {
  const spent: Record<string, number> = {};
  for (const ability of ABILITY_KEYS) {
    const bump = increases[ability] ?? 0;
    if (bump > 0) spent[ability] = bump;
  }
  return spent;
}

/** What the feat asks for as the engine's feat_choices, or the first thing it is still missing. */
export function buildFeatChoices(
  featName: string,
  fields: FeatChoiceField[],
  typed: Record<string, string[]>,
  increases: Record<string, number>,
): { choices: FeatChoices } | { error: string } {
  const choices: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.kind === 'increases') {
      const spent = abilityIncreases(increases);
      const total = Object.values(spent).reduce((sum, bump) => sum + bump, 0);
      if (total !== 2) return { error: `${featName} raises one ability score by 2, or two scores by 1.` };
      choices.ability_increases = spent;
      continue;
    }
    const picks = (typed[field.key] ?? []).slice(0, field.choose).map((pick) => pick.trim()).filter((pick) => pick !== '');
    if (picks.length !== field.choose) {
      return {
        error:
          field.choose === 1
            ? `${featName} needs ${field.label}.`
            : `${featName} needs ${field.choose} ${field.label}; you have named ${picks.length}.`,
      };
    }
    if (new Set(picks.map((pick) => pick.toLowerCase())).size !== picks.length) {
      return { error: `Each of the ${field.label} ${featName} takes must be different.` };
    }
    const stray = field.options.length > 0 ? picks.find((pick) => !field.options.some((o) => same(o, pick))) : undefined;
    if (stray) return { error: `"${stray}" is not one of ${field.options.map(featOptionLabel).join(', ')}.` };
    choices[field.key] = field.kind === 'one' ? picks[0] : picks;
  }
  return { choices: choices as FeatChoices };
}

/** What the feat the player ticked still needs, or the picks it is ready to send. */
function featChoicesFor(
  options: FeatOption[],
  picks: LevelUpPicks,
): { choices: FeatChoices } | { error: string } {
  const chosen = options.find((option) => option.name === picks.feat);
  const fields = featChoiceFields(chosen?.choices);
  if (fields.length === 0) return { choices: {} };
  return buildFeatChoices(chosen!.name, fields, picks.feat_choices, picks.increases);
}

/** What is still wrong with an optional swap; nothing picked at all is not wrong, it is declining it. */
export function swapProblem(what: 'cantrip' | 'spell', spec: CantripSwap | SpellSwap, pick: SwapPick): string | null {
  const dropped = pick.old.trim();
  const learned = pick.new.trim();
  if (dropped === '' && learned === '') return null;
  if (dropped === '' || learned === '') {
    return `Swapping a ${what} needs both the one you give up and the one you learn, or neither.`;
  }
  if (!spec.held.some((name) => same(name, dropped))) return `You do not know the ${what} "${dropped}".`;
  if (!spellOptionNames(spec.options).some((name) => same(name, learned))) {
    return `"${learned}" is not a ${what} you can learn this level.`;
  }
  return null;
}

/** The swap as the route wants it, or nothing at all when the player declined it. */
export const swapChoice = (pick: SwapPick): SwapPick | null =>
  pick.old.trim() === '' || pick.new.trim() === '' ? null : { old: pick.old.trim(), new: pick.new.trim() };

/** What is still wrong with the Wizard's new pages: the server refuses a book of the wrong size outright. */
export function spellbookProblem(spec: SpellbookSpec, picked: string[]): string | null {
  if (picked.length !== spec.to_add) {
    return `Pick ${plural(spec.to_add, 'spell')} to copy into your spellbook (you have picked ${picked.length}).`;
  }
  if (new Set(picked.map((name) => name.trim().toLowerCase())).size !== picked.length) {
    return 'Each spell can only be copied into the spellbook once.';
  }
  const held = picked.find((name) => spec.held.some((page) => same(page, name)));
  if (held) return `"${held}" is already in your spellbook.`;
  const stray = picked.find((name) => !spellOptionNames(spec.options).some((option) => same(option, name)));
  return stray ? `"${stray}" is not a spell you can copy this level.` : null;
}

/**
 * The player's picks as the route's body, or the one thing still missing. The rules it checks are
 * the engine's own, so a confirmed panel is not answered with a 400 the player could have avoided.
 */
export function buildLevelUpBody(
  srd: LevelUpSrd,
  picks: LevelUpPicks,
  suggestions: Suggestion[] = [],
): { body: LevelUpBody } | { error: string } {
  if (srd.supported === false) return { error: srd.message ?? 'This level cannot be taken here yet.' };
  const choices: LevelUpChoices = {};

  if (srd.hp) choices.hp = picks.hp;

  if ((srd.subclass_choice ?? []).length > 0) {
    if (!picks.subclass) return { error: 'Pick a subclass.' };
    choices.subclass = picks.subclass;
  }

  for (const spec of srd.feature_choices ?? []) {
    const picked = picks.feature_options[spec.feature] ?? [];
    const problem = featureChoiceProblem(spec, picked);
    if (problem) return { error: problem };
    choices.feature_options = { ...choices.feature_options, [spec.feature]: picked };
  }

  if (srd.ability_score_improvement) {
    if (picks.asi_mode === 'feat') {
      if (!picks.feat) return { error: 'Pick a feat, or raise your ability scores instead.' };
      choices.feat = picks.feat;
      const built = featChoicesFor(srd.ability_score_improvement.feat_options, picks);
      if ('error' in built) return built;
      if (Object.keys(built.choices).length > 0) choices.feat_choices = built.choices;
    } else {
      const increases = abilityIncreases(picks.increases);
      const total = Object.values(increases).reduce((sum, bump) => sum + bump, 0);
      if (total !== 2) return { error: 'Raise one ability score by 2, or two scores by 1.' };
      choices.ability_increases = increases;
    }
  }

  if (srd.epic_boon) {
    const offered = srd.epic_boon.feat_options;
    if (!picks.feat || !offered.some((option) => option.name === picks.feat)) {
      return { error: `Pick ${srd.epic_boon.epic ? 'an Epic Boon' : 'a feat'}.` };
    }
    choices.feat = picks.feat;
    const built = featChoicesFor(offered, picks);
    if ('error' in built) return built;
    if (Object.keys(built.choices).length > 0) choices.feat_choices = built.choices;
  }

  const casting = srd.spellcasting;
  if (casting) {
    if (picks.cantrips.length !== casting.cantrips_to_add) {
      return { error: `Pick ${plural(casting.cantrips_to_add, 'new cantrip')}.` };
    }
    if (picks.spells.length !== casting.spells_to_add) {
      return { error: `Pick ${plural(casting.spells_to_add, 'new spell')}.` };
    }
    if (casting.cantrips_to_add > 0) choices.cantrips = picks.cantrips;
    if (casting.spells_to_add > 0) choices.spells = picks.spells;

    if (casting.spellbook) {
      const problem = spellbookProblem(casting.spellbook, picks.spellbook);
      if (problem) return { error: problem };
      choices.spellbook = picks.spellbook;
    }
    if (casting.replace_cantrip) {
      const problem = swapProblem('cantrip', casting.replace_cantrip, picks.swap_cantrip);
      if (problem) return { error: problem };
      const swap = swapChoice(picks.swap_cantrip);
      if (swap) choices.replace_cantrip = swap;
    }
    if (casting.replace_spell) {
      const problem = swapProblem('spell', casting.replace_spell, picks.swap_spell);
      if (problem) return { error: problem };
      const swap = swapChoice(picks.swap_spell);
      if (swap) choices.replace_spell = swap;
    }
  }

  if (picks.suggestion === null) return { body: { choices } };
  const picked = suggestions[picks.suggestion];
  if (!picked) return { error: 'That suggestion is no longer on offer.' };
  return { body: { choices, homebrew_ids: [picked.homebrew_id] } };
}

export interface Chip {
  label: string;
  tone: string;
}

/** The chip beside a report or a library entry; over budget is a warning, never a failure. */
export function powerChip(verdict: PowerVerdict | undefined): Chip {
  return verdict === 'over_budget'
    ? { label: 'Over budget', tone: 'warn' }
    : { label: 'Within budget', tone: 'good' };
}

/** How full the budget bar is, capped at 100% so an over-budget bar still fits its track. */
export function budgetShare(report: PowerReport): number {
  if (report.budget_allowed <= 0) return 100;
  return Math.min(100, Math.round((report.budget_used / report.budget_allowed) * 100));
}

const PER_WORDS: Record<string, string> = { turn: 'once a turn', hit: 'on every hit' };

/** What a feature actually does, in words, for the dialog above the numbers behind it. */
export function mechanicsWords(mechanics: Mechanics): string[] {
  const words: string[] = [];
  for (const bump of mechanics.asi ?? []) words.push(`${bump.ability.toUpperCase()} +${bump.amount}`);
  if (mechanics.to_hit) words.push(`+${mechanics.to_hit} to hit`);
  if (mechanics.ac) words.push(`+${mechanics.ac} AC`);
  if (mechanics.extra_damage) {
    const { dice, per } = mechanics.extra_damage;
    words.push(`Extra ${dice} damage ${PER_WORDS[per] ?? per}`);
  }
  if (mechanics.once_per) {
    words.push(`${mechanics.effect ?? 'An ability'}, once per ${mechanics.once_per} rest`);
  }
  for (const skill of mechanics.skill_proficiencies ?? []) words.push(`Proficiency in ${skill.replace(/_/g, ' ')}`);
  if (mechanics.speed) words.push(`+${mechanics.speed} ft speed`);
  for (const resistance of mechanics.resistances ?? []) words.push(`Resistance to ${resistance} damage`);
  for (const spell of mechanics.spells ?? []) words.push(`${spell} known`);
  if (mechanics.features_text) words.push(mechanics.features_text);
  return words;
}

/** A number in the mechanics the Edit form lets the player nudge, with the server's own bounds. */
export interface NumericMechanic {
  key: string;
  label: string;
  value: number;
  min: number;
  max: number;
}

export function numericMechanics(mechanics: Mechanics): NumericMechanic[] {
  const fields: NumericMechanic[] = [];
  (mechanics.asi ?? []).forEach((bump, index) => {
    fields.push({ key: `asi.${index}`, label: `${bump.ability.toUpperCase()} bonus`, value: bump.amount, min: 1, max: 2 });
  });
  if (mechanics.to_hit !== undefined) {
    fields.push({ key: 'to_hit', label: 'To hit', value: mechanics.to_hit, min: 0, max: 5 });
  }
  if (mechanics.ac !== undefined) fields.push({ key: 'ac', label: 'AC', value: mechanics.ac, min: 0, max: 5 });
  if (mechanics.speed !== undefined) {
    fields.push({ key: 'speed', label: 'Speed (ft)', value: mechanics.speed, min: 0, max: 30 });
  }
  return fields;
}

/** The typed boxes back into mechanics, or the first box that says something the server would refuse. */
export function applyMechanicEdits(
  mechanics: Mechanics,
  typed: Record<string, string>,
): { mechanics: Mechanics } | { error: string } {
  const edited: Mechanics = { ...mechanics, asi: mechanics.asi ? [...mechanics.asi] : undefined };
  for (const field of numericMechanics(mechanics)) {
    const written = (typed[field.key] ?? String(field.value)).trim();
    const value = Number(written);
    if (written === '' || !Number.isInteger(value) || value < field.min || value > field.max) {
      return { error: `${field.label}: a whole number from ${field.min} to ${field.max}.` };
    }
    const [part, index] = field.key.split('.');
    if (part === 'asi' && edited.asi) edited.asi[Number(index)] = { ...edited.asi[Number(index)]!, amount: value };
    if (part === 'to_hit') edited.to_hit = value;
    if (part === 'ac') edited.ac = value;
    if (part === 'speed') edited.speed = value;
  }
  return { mechanics: edited };
}

// --- the library and the play profile ---------------------------------------

/** Tolerant of a server older than the library route: a missing list reads as an empty one. */
export function libraryView(answer: unknown): LibraryAnswer {
  const lists = (answer ?? {}) as Partial<LibraryAnswer>;
  return {
    campaign: Array.isArray(lists.campaign) ? lists.campaign : [],
    library: Array.isArray(lists.library) ? lists.library : [],
  };
}

/** Only what belongs to this campaign can be lifted out of it into the personal library. */
export const canSaveToLibrary = (entry: Homebrew): boolean => entry.scope === 'campaign';

export interface TagBar {
  tag: string;
  label: string;
  count: number;
  /** Share of the busiest tag, so the widest bar always fills the row. */
  share: number;
}

export function tagBars(profile: PlayProfile): TagBar[] {
  const counts = Object.entries(profile.tags ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = counts[0]?.[1] ?? 0;
  return counts.map(([tag, count]) => ({
    tag,
    label: tag.replace(/_/g, ' '),
    count,
    share: top > 0 ? Math.round((count / top) * 100) : 0,
  }));
}

/** The three the card shows; the profile already sends the ones that say the most. */
export const exemplarQuotes = (profile: PlayProfile, limit = 3): PlayProfile['exemplars'] =>
  (profile.exemplars ?? []).slice(0, limit);

const TALLY_WORDS: Record<string, string> = {
  skills: 'Skills',
  rolls: 'Dice',
  actions: 'In a fight',
  effects: 'Effects',
};

export interface TallyLine {
  label: string;
  text: string;
}

/** The engine's own tallies, biggest first and only the top few: "Skills — stealth 8, arcana 3". */
export function engineSummary(profile: PlayProfile, perGroup = 3): TallyLine[] {
  const lines: TallyLine[] = [];
  for (const [group, label] of Object.entries(TALLY_WORDS)) {
    const counts = Object.entries(profile.engine?.[group as keyof PlayProfile['engine']] ?? {})
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, perGroup);
    if (counts.length === 0) continue;
    lines.push({ label, text: counts.map(([name, count]) => `${name.replace(/_/g, ' ')} ${count}`).join(', ') });
  }
  return lines;
}
