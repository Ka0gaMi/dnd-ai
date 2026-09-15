// Lazy access to the bundled SRD 5.2.1 JSON (see srd/ATTRIBUTION.md). Files are read once per process.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRD_DIR = new URL('../../srd/', import.meta.url);
const cache = new Map<string, unknown>();

function load<T>(relative: string): T {
  const hit = cache.get(relative);
  if (hit !== undefined) return hit as T;
  const parsed = JSON.parse(readFileSync(fileURLToPath(new URL(relative, SRD_DIR)), 'utf8')) as T;
  cache.set(relative, parsed);
  return parsed;
}

export interface Ref {
  index: string;
  name: string;
  note?: string;
}

export type EquipOption =
  | { option_type: 'reference'; item: Ref }
  | { option_type: 'counted_reference'; count: number; of: Ref }
  | { option_type: 'money'; count: number; unit: string }
  | { option_type: 'multiple'; items: EquipOption[] }
  | { option_type: 'choice'; choice: { choose: number; from: { equipment_category?: Ref } } };

export interface OptionSet {
  desc: string;
  choose: number;
  from: { options: EquipOption[] };
}

export interface ClassData {
  index: string;
  name: string;
  hit_die: number;
  primary_ability?: { desc: string };
  proficiency_choices?: OptionSet[];
  proficiencies: Ref[];
  saving_throws: Ref[];
  starting_equipment_options?: OptionSet[];
  subclasses: Ref[];
  spellcasting?: { level: number; spellcasting_ability: Ref };
}

export interface LevelData {
  level: number;
  prof_bonus?: number;
  features: Ref[];
  class: Ref;
  subclass?: Ref;
  class_specific?: Record<string, unknown>;
  spellcasting?: Record<string, number>;
}

export interface FeatureData {
  index: string;
  name: string;
  description: string;
  class?: Ref;
  level?: Ref;
}

export interface SubclassData {
  index: string;
  name: string;
  class: Ref;
  summary?: string;
  description: string;
  features: Array<{ name: string; level: number; description: string }>;
}

export interface SpeciesData {
  index: string;
  name: string;
  size?: string;
  type?: string;
  speed: number;
  traits: Ref[];
  /** The lineages a member chooses between: Draconic Ancestors, Elven Lineages, Giant Ancestries. */
  subspecies?: Ref[];
}

export interface TraitData {
  index: string;
  name: string;
  description: string;
  species: Ref[];
  /** Set when the trait belongs to a lineage inside the species rather than to every member of it. */
  subspecies?: Ref[];
  /** The walking speed the trait replaces the species one with. */
  speed?: number;
  proficiency_choices?: OptionSet;
}

export interface BackgroundData {
  index: string;
  name: string;
  ability_scores: Ref[];
  feat: Ref;
  proficiencies: Ref[];
  equipment_options?: OptionSet[];
}

export interface FeatData {
  index: string;
  name: string;
  type: string;
  description: string;
  prerequisites?: { minimum_level?: number; feature_named?: string };
  prerequisite_options?: { desc: string; choose?: number; from?: unknown };
  repeatable?: string;
}

export interface EquipmentData {
  index: string;
  name: string;
  equipment_categories: Ref[];
  armor_class?: { base: number; dex_bonus: boolean; max_bonus?: number };
  cost?: { quantity: number; unit: string };
  damage?: { damage_dice: string; damage_type: Ref };
  /** The versatile die, for a weapon swung in both hands. */
  two_handed_damage?: { damage_dice: string; damage_type: Ref };
  /** Melee weapons carry their reach here (normal 5); ranged ones their normal and long range. */
  range?: { normal: number; long?: number };
  /** How far a thrown weapon flies, normally and at long range. */
  throw_range?: { normal: number; long: number };
  /** The 2024 weapon mastery property: Sap, Nick, Vex and the rest. */
  mastery?: Ref;
  properties?: Ref[];
  contents?: Array<{ item: Ref; quantity: number }>;
  weight?: number;
  str_minimum?: number;
  stealth_disadvantage?: boolean;
  description?: string;
}

/** A weapon property or a 2024 weapon mastery property, as the bundled files carry them. */
export interface WeaponPropertyData {
  index: string;
  name: string;
  description: string;
}

export interface MagicItemData {
  index: string;
  name: string;
  /** "weapons", "armor", "potions", "wands", "wondrous-items", "rings", "staffs". */
  equipment_category: Ref;
  /** The +1/+2/+3 rows a generic entry such as "Weapon" stands over. */
  variants: Ref[];
  variant: boolean;
  attunement: boolean;
  /** One of the six rarities, or a sentence covering the variants ("Uncommon (+1), Rare (+2), ..."). */
  rarity: { name: string };
  desc: string;
  /** Who may attune to it, e.g. "Paladin" or "Sorcerer, Warlock, or Wizard"; absent when anyone may. */
  'limited-to'?: string;
}

export interface SkillData {
  index: string;
  name: string;
  description: string;
  ability_score: Ref;
}

interface Open5e<T> {
  pk: string;
  fields: T;
}

export interface SpellFields {
  name: string;
  desc: string;
  level: number;
  school: string;
  higher_level: string | null;
  range_text: string;
  casting_time: string;
  duration: string;
  concentration: boolean;
  ritual: boolean;
  verbal: boolean;
  somatic: boolean;
  material: boolean;
  saving_throw_ability: string | null;
  attack_roll: boolean;
  damage_roll: string | null;
  damage_types: string[];
  classes: string[];
}

export interface CreatureFields {
  name: string;
  size: string;
  type: string;
  armor_class: number;
  armor_detail: string | null;
  hit_points: number;
  hit_dice: string;
  challenge_rating: string;
  walk: number | null;
  burrow: number | null;
  climb: number | null;
  fly: number | null;
  swim: number | null;
  hover: boolean;
  alignment: string;
  initiative_bonus: number | null;
  passive_perception: number | null;
  languages_desc: string;
  darkvision_range: number | null;
  blindsight_range: number | null;
  tremorsense_range: number | null;
  truesight_range: number | null;
  telepathy_range: number | null;
  damage_vulnerabilities_display: string;
  damage_resistances_display: string;
  damage_immunities_display: string;
  condition_immunities_display: string;
  /** The ability_score_*, saving_throw_* and skill_bonus_* columns, read by name. */
  [key: string]: unknown;
}

export interface CreatureActionFields {
  name: string;
  desc: string;
  parent: string;
  action_type: 'ACTION' | 'BONUS_ACTION' | 'REACTION' | 'LEGENDARY_ACTION';
  uses_type: string | null;
  uses_param: number | null;
  order_in_statblock: number | null;
}

export interface CreatureAttackFields {
  parent: string;
  to_hit_mod: number | null;
  reach: number | null;
  range: number | null;
  long_range: number | null;
  damage_die_count: number | null;
  damage_die_type: string | null;
  damage_bonus: number | null;
  damage_type: string | null;
  extra_damage_die_count: number | null;
  extra_damage_die_type: string | null;
  extra_damage_bonus: number | null;
  extra_damage_type: string | null;
}

export interface CreatureTraitFields {
  name: string;
  desc: string;
  parent: string;
}

export interface StatBlockAction {
  name: string;
  kind: 'melee_weapon_attack' | 'ranged_weapon_attack' | 'action' | 'bonus_action' | 'reaction' | 'legendary_action';
  attack_bonus?: number;
  reach_ft?: number;
  range_ft?: number;
  long_range_ft?: number;
  damage?: Array<{ dice: string; type: string | null }>;
  uses?: string;
  text: string;
}

export interface CreatureStatBlock {
  name: string;
  size: string;
  type: string;
  alignment: string;
  cr: number;
  ac: number;
  ac_detail: string | null;
  hp: number;
  hit_dice: string;
  speed: Record<string, number>;
  initiative_bonus: number | null;
  abilities: Record<string, number>;
  saves: Record<string, number>;
  skills: Record<string, number>;
  senses: string[];
  passive_perception: number | null;
  languages: string;
  damage_vulnerabilities: string;
  damage_resistances: string;
  damage_immunities: string;
  condition_immunities: string;
  traits: Array<{ name: string; text: string }>;
  actions: StatBlockAction[];
  bonus_actions: StatBlockAction[];
  reactions: StatBlockAction[];
  legendary_actions: StatBlockAction[];
}

export interface DescribedFields {
  describes: string;
  desc: string;
}

export interface RuleFields {
  name: string;
  desc: string;
  ruleset: string;
}

/** A rule entry that is only a name and its text: the Rules Glossary and the Spells-chapter rules. */
export interface NamedRule {
  name: string;
  desc: string;
}

/** One class or subclass feature as Open5e writes it; the option lists the class tables only point at. */
export interface ClassFeatureFields {
  name: string;
  desc: string;
  /** The class or subclass it belongs to, e.g. "srd-2024_sorcerer". */
  parent: string;
}

export const classes = (): ClassData[] => load<ClassData[]>('5e-bits/Classes.json');
export const levels = (): LevelData[] => load<LevelData[]>('5e-bits/Levels.json');
export const features = (): FeatureData[] => load<FeatureData[]>('5e-bits/Features.json');
export const subclasses = (): SubclassData[] => load<SubclassData[]>('5e-bits/Subclasses.json');
export const species = (): SpeciesData[] => load<SpeciesData[]>('5e-bits/Species.json');
export const traits = (): TraitData[] => load<TraitData[]>('5e-bits/Traits.json');
export const backgrounds = (): BackgroundData[] => load<BackgroundData[]>('5e-bits/Backgrounds.json');
export const feats = (): FeatData[] => load<FeatData[]>('5e-bits/Feats.json');
export const equipment = (): EquipmentData[] => load<EquipmentData[]>('5e-bits/Equipment.json');
export const skills = (): SkillData[] => load<SkillData[]>('5e-bits/Skills.json');
export const magicItems = (): MagicItemData[] => load<MagicItemData[]>('5e-bits/Magic-Items.json');
export const weaponProperties = (): WeaponPropertyData[] => load<WeaponPropertyData[]>('5e-bits/Weapon-Properties.json');
export const weaponMasteryProperties = (): WeaponPropertyData[] =>
  load<WeaponPropertyData[]>('5e-bits/Weapon-Mastery-Properties.json');

export const spells = (): Array<Open5e<SpellFields>> => load<Array<Open5e<SpellFields>>>('open5e/Spell.json');
export const creatures = (): Array<Open5e<CreatureFields>> => load<Array<Open5e<CreatureFields>>>('open5e/Creature.json');
export const rules = (): Array<Open5e<RuleFields>> => load<Array<Open5e<RuleFields>>>('open5e/Rule.json');
export const ruleGlossary = (): NamedRule[] => load<NamedRule[]>('srd-5.2.1/RulesGlossary.json');
export const spellRules = (): NamedRule[] => load<NamedRule[]>('srd-5.2.1/SpellRules.json');

/** Every rule the server knows, by name and text: Open5e's Playing-the-Game entries plus the two chapters
 * extracted from the official SRD PDF. Entries sharing a name (case-insensitively) are merged rather than
 * dropped, so a collision loses no text: the spells chapter's "Attack Rolls" is appended to the combat one,
 * the glossary's "Armor Class" definition survives, and Open5e's "Knocking out a Creature" folds into the
 * glossary's "Knocking Out a Creature". */
export const allRules = (): NamedRule[] => {
  const names = new Map<string, string>();
  const parts = new Map<string, string[]>();
  for (const rule of [
    ...rules().map((r) => ({ name: r.fields.name, desc: r.fields.desc })),
    ...ruleGlossary(),
    ...spellRules(),
  ]) {
    const key = rule.name.toLowerCase();
    const existing = parts.get(key);
    if (existing === undefined) {
      names.set(key, rule.name);
      parts.set(key, [rule.desc]);
      continue;
    }
    if (!existing.includes(rule.desc)) existing.push(rule.desc);
  }
  return [...parts].map(([key, list]) => ({ name: names.get(key)!, desc: list.join('\n\n') }));
};
export const conditionDescriptions = (): Array<Open5e<DescribedFields>> =>
  load<Array<Open5e<DescribedFields>>>('open5e/ConditionDescription.json');
export const skillDescriptions = (): Array<Open5e<DescribedFields>> =>
  load<Array<Open5e<DescribedFields>>>('open5e/SkillDescription.json');
export const abilityDescriptions = (): Array<Open5e<DescribedFields>> =>
  load<Array<Open5e<DescribedFields>>>('open5e/AbilityDescription.json');
export const creatureActions = (): Array<Open5e<CreatureActionFields>> =>
  load<Array<Open5e<CreatureActionFields>>>('open5e/CreatureAction.json');
export const creatureAttacks = (): Array<Open5e<CreatureAttackFields>> =>
  load<Array<Open5e<CreatureAttackFields>>>('open5e/CreatureActionAttack.json');
export const creatureTraits = (): Array<Open5e<CreatureTraitFields>> =>
  load<Array<Open5e<CreatureTraitFields>>>('open5e/CreatureTrait.json');
export const classFeatures = (): Array<Open5e<ClassFeatureFields>> =>
  load<Array<Open5e<ClassFeatureFields>>>('open5e/ClassFeature.json');

const ABILITIES = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const SKILL_BONUS_PREFIX = 'skill_bonus_';

function groupByParent<T extends { parent: string }>(rows: Array<Open5e<T>>): Map<string, Array<Open5e<T>>> {
  const map = new Map<string, Array<Open5e<T>>>();
  for (const row of rows) {
    const list = map.get(row.fields.parent);
    if (list) list.push(row);
    else map.set(row.fields.parent, [row]);
  }
  return map;
}

function indexed<T>(key: string, build: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;
  const built = build();
  cache.set(key, built);
  return built;
}

function damageDice(attack: CreatureAttackFields): Array<{ dice: string; type: string | null }> {
  const face = (count: number | null, die: string | null, bonus: number | null): string => {
    const plus = bonus ? `${bonus > 0 ? '+' : '-'}${Math.abs(bonus)}` : '';
    return count && die ? `${count}${die.toLowerCase()}${plus}` : String(bonus ?? 0);
  };
  // With no extra damage the fixtures often carry the only damage type in extra_damage_type.
  const hasExtra = Boolean(attack.extra_damage_die_count);
  const damage = [
    {
      dice: face(attack.damage_die_count, attack.damage_die_type, attack.damage_bonus),
      type: attack.damage_type ?? (hasExtra ? null : attack.extra_damage_type),
    },
  ];
  if (hasExtra) {
    damage.push({
      dice: face(attack.extra_damage_die_count, attack.extra_damage_die_type, attack.extra_damage_bonus),
      type: attack.extra_damage_type,
    });
  }
  return damage;
}

function usesText(action: CreatureActionFields): string | undefined {
  if (!action.uses_type) return undefined;
  return action.uses_type === 'PER_DAY' ? `${action.uses_param}/day` : `recharge ${action.uses_param}-6`;
}

const ACTION_KIND = {
  ACTION: 'action',
  BONUS_ACTION: 'bonus_action',
  REACTION: 'reaction',
  LEGENDARY_ACTION: 'legendary_action',
} as const;

function statBlockAction(
  action: Open5e<CreatureActionFields>,
  attack: CreatureAttackFields | undefined,
): StatBlockAction {
  const f = action.fields;
  const built: StatBlockAction = {
    name: f.name,
    kind: attack ? (attack.reach ? 'melee_weapon_attack' : 'ranged_weapon_attack') : ACTION_KIND[f.action_type],
    text: f.desc,
  };
  if (attack) {
    if (attack.to_hit_mod !== null) built.attack_bonus = attack.to_hit_mod;
    if (attack.reach !== null) built.reach_ft = attack.reach;
    if (attack.range !== null) built.range_ft = attack.range;
    if (attack.long_range !== null) built.long_range_ft = attack.long_range;
    built.damage = damageDice(attack);
  }
  const uses = usesText(f);
  if (uses) built.uses = uses;
  return built;
}

/** Joins Creature.json with its actions, attacks and traits into the one shape srd_lookup returns. */
export function creatureStatBlock(creature: Open5e<CreatureFields>): CreatureStatBlock {
  const actionsByCreature = indexed('index:actions', () => groupByParent(creatureActions()));
  const attacksByAction = indexed('index:attacks', () => groupByParent(creatureAttacks()));
  const traitsByCreature = indexed('index:traits', () => groupByParent(creatureTraits()));
  const f = creature.fields;

  const speed: Record<string, number> = {};
  for (const mode of ['walk', 'burrow', 'climb', 'fly', 'swim']) {
    const value = f[mode] as number | null;
    if (value !== null && value !== undefined) speed[mode] = value;
  }

  const abilities: Record<string, number> = {};
  const saves: Record<string, number> = {};
  for (const ability of ABILITIES) {
    const key = ability.slice(0, 3);
    abilities[key] = f[`ability_score_${ability}`] as number;
    const save = f[`saving_throw_${ability}`] as number | null;
    if (save !== null && save !== undefined) saves[key] = save;
  }

  const skills: Record<string, number> = {};
  for (const [key, value] of Object.entries(f)) {
    if (key.startsWith(SKILL_BONUS_PREFIX) && typeof value === 'number') {
      skills[key.slice(SKILL_BONUS_PREFIX.length)] = value;
    }
  }

  const senses: string[] = [];
  for (const [label, range] of [
    ['darkvision', f.darkvision_range],
    ['blindsight', f.blindsight_range],
    ['tremorsense', f.tremorsense_range],
    ['truesight', f.truesight_range],
    ['telepathy', f.telepathy_range],
  ] as Array<[string, number | null]>) {
    if (range) senses.push(`${label} ${range} ft.`);
  }

  const actions = (actionsByCreature.get(creature.pk) ?? [])
    .slice()
    .sort((a, b) => (a.fields.order_in_statblock ?? 0) - (b.fields.order_in_statblock ?? 0))
    .map((action) => ({
      action_type: action.fields.action_type,
      built: statBlockAction(action, attacksByAction.get(action.pk)?.[0]?.fields),
    }));
  const ofType = (type: CreatureActionFields['action_type']): StatBlockAction[] =>
    actions.filter((a) => a.action_type === type).map((a) => a.built);

  return {
    name: f.name,
    size: f.size,
    type: f.type,
    alignment: f.alignment,
    cr: Number(f.challenge_rating),
    ac: f.armor_class,
    ac_detail: f.armor_detail,
    hp: f.hit_points,
    hit_dice: f.hit_dice,
    speed,
    initiative_bonus: f.initiative_bonus,
    abilities,
    saves,
    skills,
    senses,
    passive_perception: f.passive_perception,
    languages: f.languages_desc,
    damage_vulnerabilities: f.damage_vulnerabilities_display,
    damage_resistances: f.damage_resistances_display,
    damage_immunities: f.damage_immunities_display,
    condition_immunities: f.condition_immunities_display,
    traits: (traitsByCreature.get(creature.pk) ?? []).map((t) => ({ name: t.fields.name, text: t.fields.desc })),
    actions: ofType('ACTION'),
    bonus_actions: ofType('BONUS_ACTION'),
    reactions: ofType('REACTION'),
    legendary_actions: ofType('LEGENDARY_ACTION'),
  };
}

// --- SRD 5.2.1 lists the bundled JSON does not carry -------------------------

export interface LanguageData {
  name: string;
  rarity: 'standard' | 'rare';
  speakers: string;
  script?: string;
}

/** The 2024 language table: Common plus two of these is what a character starts knowing. */
const LANGUAGES: LanguageData[] = [
  { name: 'Common', rarity: 'standard', speakers: 'Most humanoids', script: 'Common' },
  { name: 'Common Sign Language', rarity: 'standard', speakers: 'Most humanoids' },
  { name: 'Draconic', rarity: 'standard', speakers: 'Dragons and dragonborn', script: 'Draconic' },
  { name: 'Dwarvish', rarity: 'standard', speakers: 'Dwarves', script: 'Dwarvish' },
  { name: 'Elvish', rarity: 'standard', speakers: 'Elves', script: 'Elvish' },
  { name: 'Giant', rarity: 'standard', speakers: 'Giants and goliaths', script: 'Dwarvish' },
  { name: 'Gnomish', rarity: 'standard', speakers: 'Gnomes', script: 'Dwarvish' },
  { name: 'Goblin', rarity: 'standard', speakers: 'Goblinoids', script: 'Dwarvish' },
  { name: 'Halfling', rarity: 'standard', speakers: 'Halflings', script: 'Common' },
  { name: 'Orc', rarity: 'standard', speakers: 'Orcs', script: 'Dwarvish' },
  { name: 'Abyssal', rarity: 'rare', speakers: 'Demons', script: 'Infernal' },
  { name: 'Celestial', rarity: 'rare', speakers: 'Celestials', script: 'Celestial' },
  { name: 'Deep Speech', rarity: 'rare', speakers: 'Aberrations' },
  { name: 'Druidic', rarity: 'rare', speakers: 'Druids only', script: 'Druidic' },
  { name: 'Infernal', rarity: 'rare', speakers: 'Devils', script: 'Infernal' },
  {
    name: 'Primordial',
    rarity: 'rare',
    speakers: 'Elementals; Aquan, Auran, Ignan and Terran are its dialects',
    script: 'Dwarvish',
  },
  { name: 'Sylvan', rarity: 'rare', speakers: 'Fey creatures', script: 'Elvish' },
  { name: "Thieves' Cant", rarity: 'rare', speakers: 'Rogues', script: 'Common' },
  { name: 'Undercommon', rarity: 'rare', speakers: 'Underdark traders', script: 'Elvish' },
];

export const languages = (): LanguageData[] => LANGUAGES;

/**
 * The creature tags of the SRD 5.2.1 stat blocks, transcribed from the type lines of the bundled
 * Monster Manual entries ("Small Fey (Goblinoid)"): the JSON carries only the type, so the tag a
 * homebrew clause names - "goblinoid", "devil" - has nowhere else to be read from. Only creatures
 * present in srd/open5e/Creature.json are listed. See srd/ATTRIBUTION.md.
 */
export const CREATURE_TAGS: Record<string, string[]> = {
  goblinoid: [
    'Goblin Minion',
    'Goblin Warrior',
    'Goblin Boss',
    'Hobgoblin Warrior',
    'Hobgoblin Captain',
    'Bugbear Warrior',
    'Bugbear Stalker',
  ],
  demon: ['Balor', 'Dretch', 'Glabrezu', 'Hezrou', 'Marilith', 'Nalfeshnee', 'Quasit', 'Vrock'],
  devil: [
    'Barbed Devil',
    'Bearded Devil',
    'Bone Devil',
    'Chain Devil',
    'Erinyes',
    'Horned Devil',
    'Ice Devil',
    'Imp',
    'Lemure',
    'Pit Fiend',
  ],
  dinosaur: ['Allosaurus', 'Ankylosaurus', 'Plesiosaurus', 'Pteranodon', 'Triceratops', 'Tyrannosaurus Rex'],
  gnoll: ['Gnoll Warrior'],
  kobold: ['Kobold Warrior'],
  merfolk: ['Merfolk Skirmisher'],
  sahuagin: ['Sahuagin Warrior'],
};


export interface OptionEntry {
  name: string;
  text: string;
  /** The class level the option may first be taken at. */
  level: number;
}

/** One Metamagic option, with the sorcery points spending it costs. */
export interface MetamagicEntry extends OptionEntry {
  cost: number;
}

/** The level Metamagic itself arrives at; no option of it has a prerequisite of its own. */
const METAMAGIC_LEVEL = 2;

/**
 * "Metamagic Options" in the Sorcerer description: one section per option, each headed by its name
 * and a cost line. The bundled 5e-bits feature text says only "later in this class's description",
 * so the sections are read out of the Open5e class feature file instead.
 */
function parseMetamagic(): MetamagicEntry[] {
  const desc = classFeatures().find((f) => f.fields.name === 'Metamagic Options')?.fields.desc ?? '';
  const section =
    /(?:^|\n)\s*#*\s*([A-Za-z' ]+Spell)\s*\n+\*Cost:\s*(\d+) Sorcery Points?\*\s*\n+([\s\S]*?)(?=\n\s*#*\s*[A-Za-z' ]+Spell\s*\n+\*Cost:|$)/g;
  const out: MetamagicEntry[] = [];
  for (const match of desc.matchAll(section)) {
    out.push({
      name: match[1]!.trim(),
      level: METAMAGIC_LEVEL,
      cost: Number(match[2]),
      text: match[3]!.trim().replace(/\s*\n\s*/g, ' '),
    });
  }
  return out;
}

let metamagic: MetamagicEntry[] | null = null;

export const metamagicOptions = (): MetamagicEntry[] => (metamagic ??= parseMetamagic());

/**
 * What an Eldritch Invocation does that the engine can act on. Everything else about an invocation is
 * its text; these are the few numbers and names the registry reads off it.
 */
export interface InvocationMechanics {
  /** A spell the invocation casts without a spell slot. */
  free_spell?: string;
  /** The class resource that free casting costs a use of, for the invocations whose text counts them. */
  free_spell_resource?: string;
  /** Thirsting Blade: attacks added to the Attack action. */
  extra_attacks?: number;
  /** Nothing in the engine applies this one, and this line says why. */
  dm_applied?: string;
}

export interface InvocationEntry extends OptionEntry {
  /** Another invocation the text asks for first: one of the three Pacts, or Thirsting Blade. */
  requires?: string;
  mechanics?: InvocationMechanics;
}

/**
 * What the engine reads off each Eldritch Invocation. The prerequisites are not here: they are read from
 * the bundled "Eldritch Invocation Options" text, which is what says at what level each one may be taken.
 */
const INVOCATION_MECHANICS: Array<{ name: string; text: string; mechanics?: InvocationMechanics }> = [
  { name: 'Agonizing Blast', text: 'Add your Charisma modifier to the damage of one Warlock cantrip.' },
  { name: 'Armor of Shadows', text: 'You always have Mage Armor prepared and cast it on yourself without a slot.', mechanics: { free_spell: 'Mage Armor' } },
  { name: 'Ascendant Step', text: 'You always have Levitate prepared and cast it on yourself without a slot.', mechanics: { free_spell: 'Levitate' } },
  { name: 'Devil’s Sight', text: 'You see normally in Dim Light and Darkness within 120 feet.', mechanics: { dm_applied: 'Seeing in Dim Light and Darkness needs the light and vision rules R7 brings.' } },
  { name: 'Devouring Blade', text: 'Your Thirsting Blade attack gains one extra attack.', mechanics: { extra_attacks: 2 } },
  { name: 'Eldritch Mind', text: 'Advantage on Constitution saves to maintain Concentration.' },
  { name: 'Eldritch Smite', text: 'Spend a Pact Magic slot on a pact-weapon hit for Force damage and a knock-prone.' },
  { name: 'Eldritch Spear', text: 'One damaging Warlock cantrip gains a range of 300 feet.' },
  { name: 'Fiendish Vigor', text: 'You always have False Life prepared and cast it on yourself without a slot.', mechanics: { free_spell: 'False Life' } },
  { name: 'Gaze of Two Minds', text: 'Perceive through a willing creature’s senses as a Bonus Action.', mechanics: { dm_applied: 'Perceiving through another creature’s senses is narrated, never rolled.' } },
  { name: 'Gift of the Depths', text: 'You breathe underwater, gain a Swim Speed and cast Water Breathing without a slot once per long rest.', mechanics: { free_spell: 'Water Breathing', free_spell_resource: 'gift_of_the_depths' } },
  { name: 'Gift of the Protectors', text: 'A creature named in your Book of Shadows drops to 1 Hit Point instead of 0, once per Long Rest.', mechanics: { dm_applied: 'Leaving a creature on 1 Hit Point needs a seam on the blow that drops it, and the names in the Book of Shadows are the DM’s to keep.' } },
  { name: 'Investment of the Chain Master', text: 'Your Pact of the Chain familiar gains a speed, your spell save DC and more.', mechanics: { dm_applied: 'It upgrades a familiar, and summoning a creature out of a spell waits for its own package.' } },
  { name: 'Lessons of the First Ones', text: 'You gain one Origin feat of your choice.', mechanics: { dm_applied: 'It hands out an Origin feat, which grant_feature applies with its own numbers.' } },
  { name: 'Lifedrinker', text: 'Your pact weapon deals extra Necrotic, Psychic or Radiant damage.' },
  { name: 'Mask of Many Faces', text: 'You always have Disguise Self prepared and cast it without a slot.', mechanics: { free_spell: 'Disguise Self' } },
  { name: 'Master of Myriad Forms', text: 'You always have Alter Self prepared and cast it without a slot.', mechanics: { free_spell: 'Alter Self' } },
  { name: 'Misty Visions', text: 'You always have Silent Image prepared and cast it without a slot.', mechanics: { free_spell: 'Silent Image' } },
  { name: 'One with Shadows', text: 'Cast Invisibility on yourself without a slot while in Dim Light or Darkness.', mechanics: { free_spell: 'Invisibility' } },
  { name: 'Otherworldly Leap', text: 'You always have Jump prepared and cast it on yourself without a slot.', mechanics: { free_spell: 'Jump' } },
  { name: 'Pact of the Blade', text: 'Summon a pact weapon as a Bonus Action and use Charisma for its attacks.' },
  { name: 'Pact of the Chain', text: 'You learn Find Familiar and cast it as a Magic action without a slot - use_action {spell: "Find Familiar", free_cast: "pact_of_the_chain", option: "Owl"}.' },
  { name: 'Pact of the Tome', text: 'A Book of Shadows gives you three cantrips and two level 1 rituals from any list.', mechanics: { dm_applied: 'The three cantrips and two rituals of the Book of Shadows come from any list: add them with learn_spell.' } },
  { name: 'Repelling Blast', text: 'One damaging Warlock cantrip pushes a Large or smaller creature 10 feet away.' },
  { name: 'Thirsting Blade', text: 'You attack twice with your pact weapon as part of the Attack action.', mechanics: { extra_attacks: 1 } },
  { name: 'Visions of Distant Realms', text: 'You always have Arcane Eye prepared and cast it without a slot.', mechanics: { free_spell: 'Arcane Eye' } },
  { name: 'Whispers of the Grave', text: 'You always have Speak with Dead prepared and cast it without a slot.', mechanics: { free_spell: 'Speak with Dead' } },
  { name: 'Witch Sight', text: 'You see the true form of a shapechanger or a concealed creature within 30 feet.', mechanics: { dm_applied: 'Seeing through a disguise or a concealment needs the vision rules R7 brings.' } },
];

/** Apostrophes and markdown emphasis differ between the two files; the bare letters do not. */
const invocationKey = (name: string): string => name.replace(/[^a-z]/gi, '').toLowerCase();

/**
 * "Eldritch Invocation Options" in the Warlock description: one section per option, some headed by a
 * "*Prerequisite: Level N+ Warlock, <Other> Invocation*" line. That line is the only place the bundled
 * SRD says what an invocation costs in levels, so the levels and the pacts are read out of it.
 */
function parseInvocations(): InvocationEntry[] {
  const desc = classFeatures().find((f) => f.fields.name === 'Eldritch Invocation Options')?.fields.desc ?? '';
  const prerequisites = new Map<string, { level: number; requires?: string }>();
  for (const match of desc.matchAll(/###\s+([^\n]+)\n+(?:\*Prerequisite:\s*([^*]+)\*)?/g)) {
    const line = (match[2] ?? '').trim();
    const requires = /,\s*([^,]+?)\s+Invocation\b/i.exec(line)?.[1];
    prerequisites.set(invocationKey(match[1]!), {
      level: Number(/Level\s+(\d+)\+/i.exec(line)?.[1] ?? 1),
      ...(requires ? { requires } : {}),
    });
  }
  return INVOCATION_MECHANICS.map((entry) => ({
    ...entry,
    level: 1,
    ...prerequisites.get(invocationKey(entry.name)),
  }));
}

let invocationList: InvocationEntry[] | null = null;

export const invocations = (): InvocationEntry[] => (invocationList ??= parseInvocations());

/** One invocation by name, for the registry reading what a warlock picked off the sheet. */
export const findInvocation = (name: string): InvocationEntry | undefined =>
  invocations().find((entry) => entry.name.toLowerCase() === name.trim().toLowerCase());
