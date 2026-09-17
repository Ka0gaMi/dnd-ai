// Name lookups and search over the bundled SRD data.
import * as srd from './data.js';
import { COIN_CP, SKILL_KEYS, type Coin } from '../core/rules.js';

const norm = (value: string): string => value.trim().toLowerCase();

/** SRD indexes such as "skill-sleight-of-hand" become the sheet's "sleight_of_hand". */
export function skillKey(index: string): string {
  return index.replace(/^skill-/, '').replace(/-/g, '_');
}

function pick<T extends { index: string; name: string }>(list: T[], query: string): T | undefined {
  const q = norm(query);
  return list.find((entry) => norm(entry.name) === q || entry.index === q.replace(/[\s']/g, '-'));
}

function requireEntry<T extends { index: string; name: string }>(list: T[], query: string, kind: string): T {
  const found = pick(list, query);
  if (found) return found;
  throw new Error(`Unknown ${kind} "${query}". Valid options: ${list.map((e) => e.name).join(', ')}.`);
}

export const findClass = (name: string): srd.ClassData => requireEntry(srd.classes(), name, 'class');
export const findSpecies = (name: string): srd.SpeciesData => requireEntry(srd.species(), name, 'species');
export const findBackground = (name: string): srd.BackgroundData =>
  requireEntry(srd.backgrounds(), name, 'background');
export const findFeat = (name: string): srd.FeatData => requireEntry(srd.feats(), name, 'feat');
/** The SRD item behind an inventory line, "+1 Chain Mail" and "10x Arrow" included. */
export const findEquipment = (name: string): srd.EquipmentData | undefined =>
  pick(srd.equipment(), name) ?? pick(srd.equipment(), cleanEquipmentName(name));

/** Strips a quantity prefix ("10x "), a +N ("+1 Longsword", "Longsword +1") and a trailing note
 * ("(...)" or " — ") so a legacy, magical or freeform item name still matches its SRD entry. */
function cleanEquipmentName(name: string): string {
  return name
    .trim()
    .replace(/^\d+\s*x\s*/i, '')
    .replace(/\s+—.*$/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/^\+\d+\s+/, '')
    .replace(/\s+\+\d+$/, '')
    .trim();
}

/** An item's weight by name, from the SRD equipment data. An equipment pack uses its own weight, or
 * failing that the sum of its contents' weights. Undefined when the name or its weight is unknown. */
export function resolveItemWeight(name: string): number | undefined {
  const data = findEquipment(cleanEquipmentName(name));
  if (!data) return undefined;
  if (data.weight !== undefined) return data.weight;
  if (!data.contents?.length) return undefined;
  let sum = 0;
  for (const content of data.contents) {
    const sub = findEquipment(content.item.name);
    if (sub?.weight === undefined) return undefined;
    sum += sub.weight * content.quantity;
  }
  return sum;
}

interface WeighableItem {
  name: string;
  weight_lb?: number;
  notes?: string;
}

/** Fills in weight_lb for any item still missing it (a row from before the inventory package tracked
 * weight), from SRD data. An item the SRD does not know keeps 0 with a "weight unknown" note, matching
 * add_item's convention. Returns whether anything changed, so the caller knows to persist it. */
export function backfillItemWeights(items: WeighableItem[]): boolean {
  let changed = false;
  for (const item of items) {
    if (item.weight_lb !== undefined && item.weight_lb !== null) continue;
    const resolved = resolveItemWeight(item.name);
    item.weight_lb = resolved ?? 0;
    if (resolved === undefined && !item.notes?.includes('weight unknown')) {
      item.notes = item.notes ? `${item.notes}; weight unknown` : 'weight unknown';
    }
    changed = true;
  }
  return changed;
}

export function classLevelRow(classIndex: string, level: number): srd.LevelData {
  const row = srd.levels().find((l) => l.class?.index === classIndex && l.subclass === undefined && l.level === level);
  if (!row) throw new Error(`No SRD level ${level} table for ${classIndex}.`);
  return row;
}

export function subclassLevelRow(subclassIndex: string, level: number): srd.LevelData | undefined {
  return srd.levels().find((l) => l.subclass?.index === subclassIndex && l.level === level);
}

export function featureText(index: string): string {
  return srd.features().find((f) => f.index === index)?.description ?? '';
}

export const findFeature = (index: string): srd.FeatureData | undefined =>
  srd.features().find((f) => f.index === index);

/** The class index behind a character's class name, or null when the SRD does not know that class. */
export const classIndexOf = (name: string | null | undefined): string | null =>
  name ? (pick(srd.classes(), name)?.index ?? null) : null;

/**
 * The SRD feature index a sheet feature came from, matched by name inside the class that granted it -
 * a subclass feature is filed under its parent class, so one class index covers both.
 */
export function featureIndexOf(name: string, classIndex: string | null): string | undefined {
  return featureIndexesOf(name, classIndex)[0];
}

/**
 * Every SRD feature index of that name in the class, in level order. A class may give the same feature
 * twice - Improved Brutal Strike at 13 and at 17 - and each grant is a row of its own on the sheet.
 */
export function featureIndexesOf(name: string, classIndex: string | null): string[] {
  if (!classIndex) return [];
  const wanted = norm(name);
  return srd
    .features()
    .filter((f) => f.class?.index === classIndex && norm(f.name) === wanted)
    .sort((a, b) => featureLevel(a) - featureLevel(b))
    .map((f) => f.index);
}

/** The class level a feature entry is filed under, off the level reference its own row carries. */
const featureLevel = (feature: srd.FeatureData): number => Number(String(feature.level?.index ?? '').split('-').pop()) || 0;

export function subclassesOf(classIndex: string): srd.SubclassData[] {
  return srd.subclasses().filter((s) => s.class.index === classIndex);
}

export function speciesTraits(speciesIndex: string): srd.TraitData[] {
  return srd.traits().filter((t) => t.species.some((s) => s.index === speciesIndex));
}

/** The lineages a species offers, by name; empty for a species that has none or a name that is not one. */
export function speciesLineages(species: string | srd.SpeciesData): string[] {
  const data = typeof species === 'string' ? pick(srd.species(), species) : species;
  return (data?.subspecies ?? []).map((s) => s.name);
}

/** The lineage a player asked for, matched by its name or its index as the other SRD lookups are. */
export const findLineage = (species: srd.SpeciesData, query: string): srd.Ref | undefined =>
  pick(species.subspecies ?? [], query);

/**
 * The lineages of this species a trait belongs to, empty when every member has it. A trait may be
 * marked for another species' lineage - Dwarves share the Drow darkvision entry - which does not count.
 */
export function traitLineages(species: srd.SpeciesData, trait: srd.TraitData): string[] {
  const own = new Set((species.subspecies ?? []).map((s) => s.index));
  return (trait.subspecies ?? []).filter((s) => own.has(s.index)).map((s) => s.name);
}

/** The traits a member of this lineage has: the species' own plus that lineage's. A null lineage keeps them all. */
export function speciesTraitsFor(species: srd.SpeciesData, lineage: string | null): srd.TraitData[] {
  const traits = speciesTraits(species.index);
  if (lineage === null) return traits;
  return traits.filter((t) => {
    const lineages = traitLineages(species, t);
    return lineages.length === 0 || lineages.includes(lineage);
  });
}

export interface SkillChoiceGroup {
  desc: string;
  choose: number;
  from: string[];
}

function skillOptions(set: srd.OptionSet): string[] {
  return set.from.options
    .map((o) => (o.option_type === 'reference' ? skillKey(o.item.index) : ''))
    .filter((key) => SKILL_KEYS.includes(key));
}

/** Skill-proficiency choices the player still has to make: the class list plus any species trait that grants one. */
export function skillChoiceGroups(cls: srd.ClassData, species?: srd.SpeciesData): SkillChoiceGroup[] {
  const groups: SkillChoiceGroup[] = [];
  for (const choice of cls.proficiency_choices ?? []) {
    const from = skillOptions(choice);
    if (from.length) groups.push({ desc: choice.desc, choose: choice.choose, from });
  }
  for (const trait of species ? speciesTraits(species.index) : []) {
    if (!trait.proficiency_choices) continue;
    const from = skillOptions(trait.proficiency_choices);
    if (from.length) {
      groups.push({ desc: `${trait.name}: ${trait.proficiency_choices.desc}`, choose: trait.proficiency_choices.choose, from });
    }
  }
  return groups;
}

const ARMOR_CATEGORY_PROFICIENCY: Record<string, string> = {
  'light-armor': 'Light Armor',
  'medium-armor': 'Medium Armor',
  'heavy-armor': 'Heavy Armor',
  shields: 'Shields',
};

/** "Longswords" on the proficiency list covers a "Longsword" in hand. */
const heldProficiency = (held: string[], wanted: string): boolean =>
  held.some((entry) => norm(entry).replace(/s$/, '') === norm(wanted).replace(/s$/, ''));

export interface ProficiencyGaps {
  /** 2024: armour you lack proficiency with means Disadvantage on Strength and Dexterity d20 tests, and no spellcasting. */
  armor_penalty: boolean;
  armor_not_proficient: string[];
  weapons_not_proficient: string[];
}

/** What the character has equipped but is not trained to use, read off the SRD equipment categories. */
export function equipmentProficiency(
  proficiencies: { armor?: string[]; weapons?: string[] } | null,
  inventory: Array<{ name: string; equipped?: boolean }>,
): ProficiencyGaps {
  const armorHeld = proficiencies?.armor ?? [];
  const weaponsHeld = proficiencies?.weapons ?? [];
  const gaps: ProficiencyGaps = { armor_penalty: false, armor_not_proficient: [], weapons_not_proficient: [] };
  for (const item of inventory) {
    if (!item.equipped) continue;
    const data = findEquipment(cleanEquipmentName(item.name));
    if (!data) continue;
    const categories = data.equipment_categories.map((c) => c.index);
    const armorCategory = categories.find((index) => ARMOR_CATEGORY_PROFICIENCY[index]);
    if (armorCategory) {
      if (!heldProficiency(armorHeld, ARMOR_CATEGORY_PROFICIENCY[armorCategory]!)) gaps.armor_not_proficient.push(data.name);
      continue;
    }
    if (!categories.includes('weapons')) continue;
    const group = categories.includes('martial-weapons') ? 'Martial Weapons' : 'Simple Weapons';
    if (heldProficiency(weaponsHeld, group) || heldProficiency(weaponsHeld, data.name)) continue;
    gaps.weapons_not_proficient.push(data.name);
  }
  gaps.armor_penalty = gaps.armor_not_proficient.length > 0;
  return gaps;
}

// --- weapon properties and 2024 weapon mastery -------------------------------

/** A weapon property by its index - finesse, versatile, thrown - or null for one the SRD has no entry for. */
export const weaponProperty = (index: string): srd.WeaponPropertyData | null =>
  srd.weaponProperties().find((p) => p.index === norm(index)) ?? null;

/** The 2024 mastery property a weapon carries - a Longsword saps, a Greataxe cleaves - or null for one with none. */
export function weaponMastery(equipmentName: string): srd.WeaponPropertyData | null {
  const index = findEquipment(equipmentName)?.mastery?.index;
  return index ? (srd.weaponMasteryProperties().find((p) => p.index === index) ?? null) : null;
}

/** Whether these weapon proficiencies cover one weapon, by its category or by its own name. */
const weaponProficientWith = (held: string[], data: srd.EquipmentData): boolean => {
  const categories = data.equipment_categories.map((c) => c.index);
  const group = categories.includes('martial-weapons') ? 'Martial Weapons' : 'Simple Weapons';
  return heldProficiency(held, group) || heldProficiency(held, data.name);
};

/** The weapons with a mastery property these proficiencies cover: what Weapon Mastery is chosen from. */
export function masteryWeaponOptions(weapons: string[]): string[] {
  return srd
    .equipment()
    .filter((item) => item.mastery && weaponProficientWith(weapons, item))
    .map((item) => item.name);
}

/** "Tool: Thieves' Tools" and "Thieves' Tools" are the same proficiency; compare on this. */
export const toolKey = (name: string): string => norm(name.replace(/^Tool:\s*/i, ''));

export const findLanguage = (name: string): srd.LanguageData | undefined =>
  srd.languages().find((l) => norm(l.name) === norm(name));

/** Tool-proficiency choices the class leaves to the player; nested option sets are flattened. */
export function toolChoiceGroups(cls: srd.ClassData): SkillChoiceGroup[] {
  const groups: SkillChoiceGroup[] = [];
  for (const choice of cls.proficiency_choices ?? []) {
    const from: string[] = [];
    const collect = (option: unknown): void => {
      const opt = option as { option_type: string; item?: srd.Ref; choice?: srd.OptionSet };
      // A skill proficiency is chosen elsewhere; only tools and instruments belong here.
      if (opt.option_type === 'reference' && opt.item && !opt.item.index.startsWith('skill-')) {
        from.push(opt.item.name.replace(/^Tool:\s*/i, ''));
      } else if (opt.option_type === 'choice') (opt.choice?.from.options ?? []).forEach(collect);
    };
    choice.from.options.forEach(collect);
    if (from.length) groups.push({ desc: choice.desc, choose: choice.choose, from });
  }
  return groups;
}

/** A "choose one from this category" line in a bundle: the player names the item they take. */
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
  /** Empty for most bundles; a Soldier's gaming set and a Monk's tool are picked by name. */
  picks: EquipmentPick[];
}

const LABELS = 'abcdefgh';

/** Every item name in an SRD equipment category, e.g. the four gaming sets. */
export function equipmentInCategory(index: string): string[] {
  return srd
    .equipment()
    .filter((item) => item.equipment_categories.some((c) => c.index === index))
    .map((item) => item.name)
    .sort();
}

interface ChoiceNode {
  desc?: string;
  choose: number;
  from: { option_set_type?: string; equipment_category?: srd.Ref; options?: unknown[] };
}

/** The names a choice offers, following nested "an artisan's tool or an instrument" option sets. */
function choiceOptions(choice: ChoiceNode): string[] {
  const category = choice.from.equipment_category;
  if (category) return equipmentInCategory(category.index);
  const names: string[] = [];
  for (const option of choice.from.options ?? []) {
    const opt = option as { option_type: string; item?: srd.Ref; of?: srd.Ref; choice?: ChoiceNode };
    if (opt.option_type === 'choice' && opt.choice) names.push(...choiceOptions(opt.choice));
    else if (opt.item) names.push(opt.item.name);
    else if (opt.of) names.push(opt.of.name);
  }
  return [...new Set(names)].sort();
}

/** Flattens one SRD starting-equipment option set into labelled bundles of items, gold and picks. */
export function equipmentBundles(set: srd.OptionSet | undefined): EquipmentBundle[] {
  if (!set) return [];
  return set.from.options.map((option, i) => {
    const bundle: EquipmentBundle = { label: LABELS[i] ?? String(i), desc: set.desc, items: [], gold: 0, picks: [] };
    const add = (opt: srd.EquipOption): void => {
      if (opt.option_type === 'money') bundle.gold += opt.count;
      else if (opt.option_type === 'reference') bundle.items.push({ name: opt.item.name, qty: 1, notes: opt.item.note });
      else if (opt.option_type === 'counted_reference')
        bundle.items.push({ name: opt.of.name, qty: opt.count, notes: opt.of.note });
      else if (opt.option_type === 'choice') {
        const choice = opt.choice as unknown as ChoiceNode;
        bundle.picks.push({
          desc: choice.desc ?? `Choose ${choice.choose} from ${choice.from.equipment_category?.name ?? 'these'}`,
          choose: choice.choose,
          options: choiceOptions(choice),
        });
      } else opt.items.forEach(add);
    };
    add(option);
    return bundle;
  });
}

export function spellsForClass(classIndex: string, spellLevel: number): string[] {
  return srd
    .spells()
    .filter((s) => s.fields.level === spellLevel && s.fields.classes.some((c) => c.endsWith(`_${classIndex}`)))
    .map((s) => s.fields.name)
    .sort();
}

export function findSpell(name: string): srd.SpellFields | undefined {
  const q = norm(name);
  return srd.spells().find((s) => norm(s.fields.name) === q)?.fields;
}

/**
 * Twinned Spell rides on "a spell ... that can be cast with a higher-level spell slot to target an
 * additional creature": the spell's own higher-level line is what says whether it is one of those. The
 * bundled SRD text is regular enough to read straight, so there is no hand list behind this.
 */
export function upcastAddsTarget(name: string): boolean {
  const higher = findSpell(name)?.higher_level ?? '';
  return /additional\s+(creature|target|humanoid|beast|ally)/i.test(higher);
}

export function conditionNames(): string[] {
  return srd.conditionDescriptions().map((c) => c.fields.describes);
}

export function conditionText(name: string): string | undefined {
  const q = norm(name);
  return srd.conditionDescriptions().find((c) => c.fields.describes === q)?.fields.desc;
}

export type LookupKind =
  | 'spell'
  | 'class'
  | 'species'
  | 'background'
  | 'feat'
  | 'condition'
  | 'rule'
  | 'weapon'
  | 'armor'
  | 'item'
  | 'creature';

const hasCategory = (item: srd.EquipmentData, index: string): boolean =>
  item.equipment_categories.some((c) => c.index === index);

function candidates(kind: LookupKind): Array<{ name: string; text: string; entry: Record<string, unknown> }> {
  switch (kind) {
    case 'spell':
      return srd.spells().map((s) => ({
        name: s.fields.name,
        text: s.fields.desc,
        entry: {
          name: s.fields.name,
          level: s.fields.level,
          school: s.fields.school,
          casting_time: s.fields.casting_time,
          range: s.fields.range_text,
          duration: s.fields.duration,
          concentration: s.fields.concentration,
          ritual: s.fields.ritual,
          classes: s.fields.classes.map((c) => c.split('_')[1]),
          text: s.fields.desc,
          at_higher_levels: s.fields.higher_level,
        },
      }));
    case 'class':
      return srd.classes().map((c) => ({
        name: c.name,
        text: c.primary_ability?.desc ?? '',
        entry: {
          name: c.name,
          hit_die: `d${c.hit_die}`,
          primary_ability: c.primary_ability?.desc ?? null,
          saving_throws: c.saving_throws.map((s) => s.name),
          proficiencies: c.proficiencies.map((p) => p.name),
          subclass: c.subclasses.map((s) => s.name),
          spellcasting: c.spellcasting?.spellcasting_ability.index ?? null,
        },
      }));
    case 'species':
      return srd.species().map((s) => {
        const traits = speciesTraits(s.index);
        const shared = traits.filter((t) => traitLineages(s, t).length === 0);
        return {
          name: s.name,
          text: traits.map((t) => t.description).join(' '),
          entry: {
            name: s.name,
            size: s.size ?? null,
            speed: s.speed,
            traits: shared.map((t) => ({ name: t.name, text: t.description })),
            lineages: speciesLineages(s).map((lineage) => ({
              name: lineage,
              traits: traits
                .filter((t) => traitLineages(s, t).includes(lineage))
                .map((t) => ({ name: t.name, text: t.description })),
            })),
          },
        };
      });
    case 'background':
      return srd.backgrounds().map((b) => ({
        name: b.name,
        text: '',
        entry: {
          name: b.name,
          ability_scores: b.ability_scores.map((a) => a.index),
          feat: b.feat.name,
          proficiencies: b.proficiencies.map((p) => p.name),
          equipment: equipmentBundles(b.equipment_options?.[0]),
        },
      }));
    case 'feat':
      return srd.feats().map((f) => ({
        name: f.name,
        text: f.description,
        entry: { name: f.name, category: f.type, text: f.description, prerequisites: f.prerequisites ?? null },
      }));
    case 'condition':
      return srd.conditionDescriptions().map((c) => ({
        name: c.fields.describes,
        text: c.fields.desc,
        entry: { name: c.fields.describes, text: c.fields.desc },
      }));
    case 'rule':
      return srd.allRules().map((r) => ({
        name: r.name,
        text: r.desc,
        entry: { name: r.name, text: r.desc },
      }));
    default: {
      const filter = (item: srd.EquipmentData): boolean =>
        kind === 'weapon' ? hasCategory(item, 'weapons') : kind === 'armor' ? hasCategory(item, 'armor') : true;
      return srd
        .equipment()
        .filter(filter)
        .map((item) => ({
          name: item.name,
          text: item.description ?? '',
          entry: {
            name: item.name,
            categories: item.equipment_categories.map((c) => c.name),
            cost: item.cost ? `${item.cost.quantity} ${item.cost.unit}` : null,
            armor_class: item.armor_class ?? null,
            damage: item.damage ? `${item.damage.damage_dice} ${item.damage.damage_type.name}` : null,
            properties: item.properties?.map((p) => p.name) ?? [],
            contents: item.contents?.map((c) => `${c.quantity}x ${c.item.name}`) ?? [],
            weight: item.weight ?? null,
          },
        }));
    }
  }
}

const STOPWORDS = new Set(['the', 'a', 'of', 'on', 'is', 'what', 'does', 'how', 'me', 'my', 'rolling']);

/** Lowercased words with punctuation stripped and stopwords dropped, in the order they appeared. */
function rawTokens(value: string): string[] {
  return norm(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w));
}

function tokenize(value: string): string[] {
  return [...new Set(rawTokens(value))];
}

function trigrams(value: string): Set<string> {
  const s = norm(value);
  const grams = new Set<string>();
  for (let i = 0; i < s.length - 2; i++) grams.add(s.slice(i, i + 3));
  return grams;
}

/** Dice coefficient over character trigrams; used to suggest names when nothing scores. */
function trigramSimilarity(a: string, b: string): number {
  const setA = trigrams(a);
  const setB = trigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const gram of setA) if (setB.has(gram)) shared++;
  return (2 * shared) / (setA.size + setB.size);
}

function closestNames(query: string, names: string[], count = 5): string[] {
  return [...new Set(names)]
    .map((name) => ({ name, sim: trigramSimilarity(query, name) }))
    .sort((a, b) => b.sim - a.sim || a.name.localeCompare(b.name))
    .slice(0, count)
    .map((n) => n.name);
}

/** The SRD tags some glossary names ("Dodge [Action]"); an exact lookup should still find "Dodge". */
const bareName = (name: string): string => norm(name.replace(/\s*\[[^\]]+\]$/, ''));
const matchesExact = (name: string, qNorm: string): boolean => norm(name) === qNorm || bareName(name) === qNorm;

/**
 * Exact name match beats every token appearing in the name, which beats token hits spread across the
 * name and body text; a consecutive-token phrase found in either adds a small bonus on top.
 */
function scoreCandidate(name: string, text: string, tokens: string[], phraseTokens: string[], qNorm: string): number {
  const nameNorm = norm(name);
  if (nameNorm === qNorm) return 1000;
  if (tokens.length === 0) return 0;
  const nameTokens = tokenize(name);
  const textNorm = norm(text);
  let score = 0;
  // The reverse containment ("attunement".includes("t")) needs a length floor, or a one-letter name token
  // such as "Material (M)" scores as if every query token were in the name.
  const allInName = tokens.every((t) =>
    nameTokens.some((nt) => (t.length >= 3 && nt.includes(t)) || (nt.length >= 3 && t.includes(nt))),
  );
  if (allInName) score += 500;
  for (const t of tokens) {
    if (nameNorm.includes(t)) score += 20;
    if (textNorm.includes(t)) score += 3;
  }
  for (let i = 0; i < phraseTokens.length - 1; i++) {
    const phrase = `${phraseTokens[i]} ${phraseTokens[i + 1]}`;
    if (nameNorm.includes(phrase)) score += 15;
    else if (textNorm.includes(phrase)) score += 8;
  }
  return score;
}

/** ~200 chars of text around the first matching token, so the DM can tell why an entry scored. */
function snippet(text: string, tokens: string[]): string {
  if (!text) return '';
  const textNorm = norm(text);
  let at = -1;
  for (const t of tokens) {
    const i = textNorm.indexOf(t);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) return `${text.slice(0, 200).trim()}${text.length > 200 ? '…' : ''}`;
  const start = Math.max(0, at - 80);
  const end = Math.min(text.length, at + 120);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

export interface SrdSearchResult {
  results: Array<Record<string, unknown>>;
  suggestions?: string[];
}

/**
 * Scored search by name and body text: exact matches first, then all-tokens-in-name, then token/phrase
 * hits. Creatures and spells keep their existing return shape (the full stat block or spell record);
 * other kinds get `kind`, `score` and `snippet` added. When nothing scores, `results` is empty and
 * `suggestions` names the 5 closest entries by trigram similarity.
 */
export function srdSearch(kind: LookupKind, query: string, limit = 5, exact = false): SrdSearchResult {
  const qNorm = norm(query);
  const phraseTokens = rawTokens(query);
  const tokens = tokenize(query);
  if (kind === 'creature') return creatureSearch(qNorm, tokens, phraseTokens, limit, exact);

  const pool = candidates(kind);
  const scored = pool
    .map((c) => ({ c, score: scoreCandidate(c.name, c.text, tokens, phraseTokens, qNorm) }))
    .filter((s) => (exact ? matchesExact(s.c.name, qNorm) : s.score > 0))
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));

  if (scored.length === 0) {
    return { results: [], suggestions: closestNames(qNorm, pool.map((c) => c.name), 5) };
  }
  if (kind === 'spell') return { results: scored.slice(0, limit).map((s) => s.c.entry) };
  return {
    results: scored
      .slice(0, limit)
      .map((s) => ({ ...s.c.entry, kind, score: s.score, snippet: snippet(s.c.text, tokens) })),
  };
}

function creatureSearch(
  qNorm: string,
  tokens: string[],
  phraseTokens: string[],
  limit: number,
  exact: boolean,
): SrdSearchResult {
  const pool = srd.creatures();
  const scored = pool
    .map((c) => ({ c, score: scoreCandidate(c.fields.name, '', tokens, phraseTokens, qNorm) }))
    .filter((s) => (exact ? norm(s.c.fields.name) === qNorm : s.score > 0))
    .sort((a, b) => b.score - a.score || a.c.fields.name.localeCompare(b.c.fields.name));

  if (scored.length === 0) {
    return { results: [], suggestions: closestNames(qNorm, pool.map((c) => c.fields.name), 5) };
  }
  const exactHit = scored.find((s) => norm(s.c.fields.name) === qNorm);
  const found = exactHit ? [exactHit.c] : scored.slice(0, limit).map((s) => s.c);
  if (exact || limit === 1 || found.length === 1) {
    return { results: found.map((c) => srd.creatureStatBlock(c) as unknown as Record<string, unknown>) };
  }
  return {
    results: found.map((c) => ({
      name: c.fields.name,
      cr: Number(c.fields.challenge_rating),
      type: c.fields.type,
      size: c.fields.size,
    })),
  };
}

// --- magic items --------------------------------------------------------------

export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'very_rare' | 'legendary' | 'artifact';
export const ITEM_RARITIES: ItemRarity[] = ['common', 'uncommon', 'rare', 'very_rare', 'legendary', 'artifact'];

/** "unknown" is the bundled text carrying charges without a readable recharge line: the DM rules on it. */
export type ChargeRecharge = 'dawn' | 'dusk' | 'long_rest' | 'never' | 'unknown';

export interface ItemCharges {
  current: number;
  max: number;
  recharge: ChargeRecharge;
  /** What one recharge rolls, e.g. "1d6+1"; absent when every charge comes back at once. */
  dice?: string;
}

/** What a pack, a sack or a Bag of Holding can hold. */
export interface ContainerCapacity {
  capacity_lb?: number;
  /** A Bag of Holding: what is inside weighs its carrier nothing. */
  weightless_contents?: boolean;
}

export interface MagicItemMatch {
  data: srd.MagicItemData;
  /** How this exact item is spelled: the entry's name, a tier of it, or "+2 Longsword". */
  name: string;
  rarity: ItemRarity;
  /** The +N the name asks for, on the SRD's generic Weapon, Armor and Shield entries. */
  bonus?: number;
  /** The mundane item the bonus sits on, e.g. "Longsword" for "+1 Longsword". */
  base?: string;
  /** false when it needs no attunement, true when anyone may, else who may: "by a Paladin". */
  attunement: boolean | string;
  charges?: ItemCharges;
  container?: ContainerCapacity;
}

const RARITY_BY_WORD: Record<string, ItemRarity> = {
  common: 'common',
  uncommon: 'uncommon',
  rare: 'rare',
  'very rare': 'very_rare',
  legendary: 'legendary',
  artifact: 'artifact',
};
const RARITY_WORD = /(common|uncommon|very rare|rare|legendary|artifact)/i;

/** The SRD prints one entry for the healing potions and puts their tiers in its table. */
const HEALING_TIERS: Record<string, { name: string; rarity: ItemRarity }> = {
  'potion of healing': { name: 'Potion of Healing', rarity: 'common' },
  'potion of greater healing': { name: 'Potion of Greater Healing', rarity: 'uncommon' },
  'potion of superior healing': { name: 'Potion of Superior Healing', rarity: 'rare' },
};

/** A rarity line is either one word or a sentence listing one per +N, e.g. "Uncommon (+1), Rare (+2)". */
function rarityFromText(text: string, bonus: number | undefined): ItemRarity | undefined {
  if (bonus !== undefined) {
    const bracket = new RegExp(`${RARITY_WORD.source} \\(\\+${bonus}\\)`, 'i').exec(text);
    if (bracket) return RARITY_BY_WORD[bracket[1]!.toLowerCase()];
  }
  const word = RARITY_WORD.exec(text);
  return word ? RARITY_BY_WORD[word[1]!.toLowerCase()] : undefined;
}

/** A charged item the bundled text destroys as its last charge goes: the Talismans and the Scarab. */
const DESTROYED_WITH_LAST_CHARGE =
  /\blast charge\b[^.]{0,120}(?:is destroyed|crumbles into powder)|(?:is destroyed|crumbles into powder)[^.]{0,120}\blast charge\b/i;

/** The charges an item's description gives it, and when they come back. */
function chargesFromText(desc: string): ItemCharges | undefined {
  const total = /\b(?:has|have) (\d+) charges/i.exec(desc);
  if (!total) return undefined;
  const max = Number(total[1]);
  const regain = /regains? (all|[\dd+\s]+?) expended charges daily at (dawn|dusk)/i.exec(desc);
  if (regain) {
    const dice = regain[1]!.trim().toLowerCase();
    return {
      current: max,
      max,
      recharge: regain[2]!.toLowerCase() as 'dawn' | 'dusk',
      ...(dice === 'all' ? {} : { dice: dice.replace(/\s+/g, '') }),
    };
  }
  // An item destroyed with its last charge never gives one back. A recharge stated in days, and the
  // bundled text of several wands and staffs cut off before their recharge line, have no bucket: say so
  // rather than telling the DM the charges never come back.
  if (DESTROYED_WITH_LAST_CHARGE.test(desc)) return { current: max, max, recharge: 'never' };
  return { current: max, max, recharge: 'unknown' };
}

/** The SRD's mundane containers, by index, with the pounds the data states; undefined where it states none. */
const MUNDANE_CONTAINERS = new Map<string, number | undefined>([
  ['backpack', 30],
  ['sack', 30],
  ['pouch', 6],
  ['basket', 40],
  ['barrel', undefined],
  ['bucket', undefined],
  ['chest', undefined],
  ['case-crossbow-bolt', undefined],
  ['case-map-or-scroll', undefined],
  ['flask', undefined],
  ['jug', undefined],
  ['pot-iron', undefined],
  ['quiver', undefined],
  ['vial', undefined],
  ['waterskin', undefined],
]);

/** The only magic items that carry things; an Immovable Rod "holds 8,000 pounds" and holds nothing. */
// "Efficient Quiver" is what 2024 calls the Quiver of Ehlonna.
const MAGIC_CONTAINERS = new Set(['bag-of-holding', 'handy-haversack', 'portable-hole', 'efficient-quiver']);

/** What one of those magic containers holds: the largest capacity its text states. */
function magicContainerCapacity(desc: string): ContainerCapacity {
  const stated = [...desc.matchAll(/holds? up to ([\d,]+) pounds/gi)].map((m) => Number(m[1]!.replace(/,/g, '')));
  return {
    ...(stated.length === 0 ? {} : { capacity_lb: Math.max(...stated) }),
    ...(/regardless of its contents/i.test(desc) ? { weightless_contents: true } : {}),
  };
}

/** The SRD writes its generic entries "Weapon +1"; everyone at the table says "+1 Weapon". */
const reorderBonusName = (name: string): string => name.replace(/^(.+?)\s+\+(\d)$/, '+$2 $1');

/** "+1 Longsword" and "Longsword +1" both carry a bonus; anything else carries none. */
function splitBonus(name: string): { bonus?: number; rest: string } {
  const lead = /^\+(\d)\s+(.+)$/.exec(name);
  if (lead) return { bonus: Number(lead[1]), rest: lead[2]! };
  const trail = /^(.+?)\s+\+(\d)$/.exec(name);
  if (trail) return { bonus: Number(trail[2]), rest: trail[1]! };
  return { rest: name };
}

/**
 * The +N the bundled text states for the kind its category gives it: a weapon's attack and damage rolls,
 * or armour's Armor Class. A saving throw, spell attack, ability check or conditional bonus has no home
 * in `bonus`, so it is left out rather than applied to the wrong roll.
 */
function textBonus(data: srd.MagicItemData): number | undefined {
  const category = data.equipment_category.name;
  const pattern =
    category === 'Weapons'
      ? /\+(\d) bonus to attack rolls and damage rolls/g
      : category === 'Armor'
        ? /\+(\d) bonus to Armor Class(?! against)/g
        : undefined;
  if (!pattern) return undefined;
  const values = [...new Set([...data.desc.matchAll(pattern)].map((m) => Number(m[1])))];
  return values.length === 1 ? values[0] : undefined;
}

/** Which of the SRD's three generic +N entries a mundane item would take. */
function genericEntry(base: srd.EquipmentData): string | undefined {
  if (base.index === 'shield') return 'Shield';
  if (base.armor_class) return 'Armor';
  return base.equipment_categories.some((c) => c.index === 'weapons') ? 'Weapon' : undefined;
}

function magicItemMatch(
  data: srd.MagicItemData,
  extra: { bonus?: number; base?: string; rarity?: ItemRarity; name?: string },
): MagicItemMatch {
  const charges = chargesFromText(data.desc);
  const container = MAGIC_CONTAINERS.has(data.index) ? magicContainerCapacity(data.desc) : undefined;
  const limited = data['limited-to'];
  return {
    data,
    name: extra.name ?? (extra.base === undefined ? reorderBonusName(data.name) : `+${extra.bonus} ${extra.base}`),
    rarity: extra.rarity ?? rarityFromText(data.rarity.name, extra.bonus) ?? 'uncommon',
    ...(extra.bonus === undefined ? {} : { bonus: extra.bonus }),
    ...(extra.base === undefined ? {} : { base: extra.base }),
    attunement: data.attunement ? (limited ? `by a ${limited}` : true) : false,
    ...(charges ? { charges } : {}),
    ...(container ? { container } : {}),
  };
}

/**
 * The SRD magic item a name stands for: its own name or index, one of the healing potion tiers, or a
 * +N on the generic Weapon, Armor and Shield entries - "+2 Weapon", "Weapon +2" and "+2 Longsword".
 */
export function findMagicItem(name: string): MagicItemMatch | undefined {
  const items = srd.magicItems();
  const query = name.trim();
  const tier = HEALING_TIERS[norm(query)];
  if (tier) {
    const potions = items.find((i) => i.index === 'potions-of-healing');
    if (potions) return magicItemMatch(potions, tier);
  }
  const direct = pick(items, query);
  // "Shield" is a mundane item as well as the name of the SRD's generic +N entry; a plain one is not magical.
  if (direct && !pick(srd.equipment(), query)) {
    return magicItemMatch(direct, { bonus: splitBonus(direct.name).bonus ?? textBonus(direct) });
  }
  const { bonus, rest } = splitBonus(query);
  if (bonus === undefined) return undefined;
  const named = pick(items, `${rest} +${bonus}`);
  if (named) return magicItemMatch(named, { bonus });
  const base = findEquipment(rest);
  const generic = base ? genericEntry(base) : undefined;
  const entry = generic ? pick(items, `${generic} +${bonus}`) : undefined;
  return entry ? magicItemMatch(entry, { bonus, base: base!.name }) : undefined;
}

/** What an item can hold, read off the SRD: a Backpack, a Sack, a Bag of Holding. */
export function containerSpec(name: string): ContainerCapacity | undefined {
  const magic = findMagicItem(name);
  if (magic) return magic.container;
  const data = findEquipment(name);
  if (!data || !MUNDANE_CONTAINERS.has(data.index)) return undefined;
  const capacity = MUNDANE_CONTAINERS.get(data.index);
  return capacity === undefined ? {} : { capacity_lb: capacity };
}

/** The kind a wondrous item is: the word before "of", else the last one. A Cloak of Elvenkind is a cloak. */
function headNoun(name: string): string {
  const before = /^(.*?)\s+of\s+/i.exec(name);
  return norm((before ? before[1]! : name).split(/\s+/).pop() ?? name);
}

/** What the player sees of an item nobody has identified: its kind, never its name. */
export function unidentifiedKind(name: string): string {
  const magic = findMagicItem(name);
  if (magic) {
    const category = magic.data.equipment_category.name;
    // Armour and weapons are named for what they do ("Holy Avenger"), so only a +N names its base.
    if (category === 'Armor') return magic.base ? norm(magic.base) : /shield/i.test(magic.name) ? 'shield' : 'armor';
    if (category === 'Weapons') return magic.base ? norm(magic.base) : 'weapon';
    if (category === 'Wondrous Items') return headNoun(magic.name);
    return norm(category).replace(/s$/, '');
  }
  const base = findEquipment(name);
  return base ? norm(base.name) : 'item';
}

/** "+2 Chain Mail" is not the Chain Mail the SRD prices: a +N name carries no list price of its own. */
export const namesMagicBonus = (name: string): boolean => splitBonus(name.trim()).bonus !== undefined;

/** The SRD list price in copper, or undefined for an item the SRD puts no price on. */
export function itemCostCp(name: string): number | undefined {
  const cost = findEquipment(name)?.cost;
  if (!cost) return undefined;
  const rate = COIN_CP[cost.unit as Coin];
  return rate === undefined ? undefined : cost.quantity * rate;
}

/** "Spellcaster" covers anyone who casts; the rest of a requirement names classes and species. */
const SPELLCASTER = 'spellcaster';

/**
 * Whether a "by a Paladin" attunement requirement is met, matching class and species names the way
 * equipmentProficiency matches proficiencies. Null as soon as one part of the text names something the
 * SRD does not know - "or a Creature Attuned to a Belt of Dwarvenkind" - which leaves the call to the DM.
 */
export function attunementRequirementMet(
  requirement: string,
  who: { class: string | null; species: string | null; spellcaster: boolean },
): boolean | null {
  const tokens = requirement
    .replace(/^by\s+(a|an)\s+/i, '')
    .split(/,|\bor\b/i)
    .map((part) => part.replace(/^\s*(a|an)\s+/i, '').trim())
    .filter(Boolean);
  const classNames = srd.classes().map((c) => c.name);
  const speciesNames = srd.species().map((s) => s.name);
  let unreadable = tokens.length === 0;
  for (const token of tokens) {
    if (norm(token) === SPELLCASTER) {
      if (who.spellcaster) return true;
    } else if (classNames.some((c) => heldProficiency([c], token))) {
      if (who.class && heldProficiency([who.class], token)) return true;
    } else if (speciesNames.some((s) => heldProficiency([s], token))) {
      if (who.species && heldProficiency([who.species], token)) return true;
    } else {
      unreadable = true;
    }
  }
  return unreadable ? null : false;
}
