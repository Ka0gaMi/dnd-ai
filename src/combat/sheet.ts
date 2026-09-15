// Reads any character row (PC, companion or NPC) into the handful of numbers combat needs.
import type { Db } from '../db/connection.js';
import {
  armorLoad,
  classSpeedBonus,
  type FeatureMechanics,
  type InventoryItem,
  type Proficiencies,
  type SpellSlots,
} from '../core/character.js';
import type { Clause } from '../core/mechanics.js';
import { parseOverrides } from '../core/overrides.js';
import { featureClauses } from '../core/progression.js';
import { abilityMod, carriedLoad, ENCUMBERED_SPEED, proficiencyBonus, type Ability } from '../core/rules.js';
import { getSettings } from '../core/settings.js';
import { classIndexOf, findEquipment } from '../srd/lookup.js';
import { exhaustionSpeedPenalty } from './conditions.js';
import { sizeCode, type SizeCode } from './grid.js';
import { clausePassives, clauseResourceKey, clauseUsesMax, homebrewIndex, withAsi, type ClauseSheet } from './homebrew.js';

export interface SheetFeature {
  name: string;
  source?: string;
  text?: string;
  mechanics?: FeatureMechanics;
  /** What it does, as clauses: read off the homebrew row when the sheet is built, never stored here. */
  clauses?: Clause[];
}

export interface CombatSheet {
  id: number;
  campaign_id: number;
  name: string;
  level: number;
  /** The SRD class index this character advances in, or null for a stat-block companion. */
  class_index: string | null;
  subclass: string | null;
  is_pc: boolean;
  status: string;
  hp_current: number;
  hp_max: number;
  temp_hp: number;
  ac: number;
  speed: number;
  size: SizeCode;
  abilities: Record<string, { score: number; mod: number }>;
  saves: Record<string, { proficient: boolean; bonus: number }>;
  conditions: string[];
  death_saves: { successes: number; failures: number };
  /** The whole item line, magic block included, so a +N weapon reaches the attack it is used in. */
  inventory: InventoryItem[];
  spells: { cantrips: string[]; known: string[]; prepared: string[]; save_dc: number | null; attack_bonus?: number | null };
  /** bonus: the slots Font of Magic and Wild Resurgence wove, which are spent before the table's own. */
  spell_slots: SpellSlots;
  features: SheetFeature[];
  skills: Record<string, { bonus: number; proficient?: boolean }>;
  proficiencies: Proficiencies;
  proficiency_bonus: number;
  initiative_bonus: number;
  exhaustion: number;
  /** Death saves are done: the character lies at 0 HP and stops rolling (the character package sets it). */
  stable: boolean;
  /** 2024 Weapon Mastery: the weapons whose mastery property this character may use. */
  mastery_weapons: string[];
  /** Damage types from features and the stat-block anchor, merged for the engine's damage maths. */
  resistances: string[];
  vulnerabilities: string[];
  immunities: string[];
  /** Conditions this creature simply cannot be given. */
  condition_immunities: string[];
  /** Armour or a shield worn without proficiency: disadvantage on STR and DEX d20 tests, and no spells. */
  armor_penalty: { penalty: boolean; reason: string | null };
  /** Loud armour: Disadvantage on Stealth checks, and on Hide. */
  stealth_disadvantage: boolean;
  /** Why the speed is what it is - armour too heavy, a pack too full - or null when nothing is. */
  speed_reason: string | null;
  /** The boosts the player or the DM chose for this one call, by clause key; the engine has spent them. */
  chosen_boosts?: string[];
  /** The `always` clauses this build could not run, handed back wherever the sheet is shown. */
  clause_reminders: Array<{ feature: string; text: string; reason: string }>;
}

function parse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** The anchor feature a stat-block companion carries: the creature's own numbers. */
export const anchorMechanics = (features: SheetFeature[]): FeatureMechanics | null =>
  features.find((f) => f.source === 'stat_block' && f.mechanics?.creature)?.mechanics ?? null;

/** How many attacks the Attack action gives: one, plus the best Extra Attack feature on the sheet. */
export const attacksPerAction = (sheet: CombatSheet): number =>
  1 +
  Math.max(
    0,
    ...sheet.features.map((f) => f.mechanics?.extra_attacks ?? 0),
    clausePassives(sheet.features).extra_attacks,
  );

/** The character row by id, whatever its role, with the player's hand-set numbers layered on; throws when it does not exist. */
export function combatSheet(db: Db, characterId: number): CombatSheet {
  const row = db.prepare('SELECT * FROM character WHERE id = ?').get(characterId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`No character with id ${characterId}.`);
  const scores = parse(row.abilities_json, {} as CombatSheet['abilities']);
  const level = (row.level as number) ?? 1;
  const stored = parse(row.features_json, [] as SheetFeature[]);
  const anchor = anchorMechanics(stored);
  const overrides = parseOverrides((row.overrides_json as string | null) ?? null);
  const inventory = parse(row.inventory_json, [] as CombatSheet['inventory']);
  // What the DM invented, read off the library row and off the magic items in use: clauses, never stored.
  const features = withClauses(db, stored, inventory, level);
  const passive = clausePassives(features, { inventory });
  const abilities = withClauseScores(scores, passive);
  const load = carriedLoad(inventory, abilities.str?.score ?? 10);
  const encumbered = load.over && getSettings(db, row.campaign_id as number).encumbrance === 'rules';
  const exhaustion = (row.exhaustion as number | null) ?? 0;
  const proficiencies = parse(row.proficiencies_json, {
    armor: [],
    weapons: [],
    tools: [],
    languages: [],
  } as Proficiencies);
  // 2024 exhaustion costs 5 ft of speed per level; an encumbered character is down to a crawl anyway.
  const walk = anchor?.speed?.walk ?? (row.speed as number | null) ?? 30;
  // The 2024 armour table: armour heavier than its wearer costs another 10 ft, and some of it is loud.
  const armor = armorLoad(inventory, abilities.str?.score ?? 10);
  const faster = encumbered ? { bonus: 0, reasons: [] as string[] } : classSpeedBonus(features, inventory);
  const speedReasons = [
    ...(encumbered ? ['over carrying capacity: speed 5 ft'] : []),
    ...armor.reasons,
    ...(exhaustion > 0 ? [`exhaustion ${exhaustion}: speed -${exhaustionSpeedPenalty(exhaustion)} ft`] : []),
    ...faster.reasons,
  ];
  return {
    id: row.id as number,
    campaign_id: row.campaign_id as number,
    name: row.name as string,
    level,
    class_index: classIndexOf(row.class as string | null),
    subclass: (row.subclass as string | null) ?? null,
    is_pc: row.is_pc === 1,
    status: (row.status as string) ?? 'active',
    hp_current: (row.hp_current as number | null) ?? 0,
    hp_max: (row.hp_max as number | null) ?? 0,
    temp_hp: (row.temp_hp as number | null) ?? 0,
    // acBreakdown already counted the clause armour class into this column; adding it again doubles it.
    ac: overrides.ac ?? ((row.ac as number | null) ?? 10),
    // A stat-block companion keeps its creature's own size and walking speed in the anchor feature.
    speed: encumbered ? ENCUMBERED_SPEED : Math.max(0, walk + faster.bonus - armor.speed_penalty - exhaustionSpeedPenalty(exhaustion)),
    // A PC carries its species size on the first species feature; a companion's is in the anchor.
    size: sizeCode(anchor?.size ?? features.find((f) => f.mechanics?.size)?.mechanics?.size ?? 'Medium'),
    abilities,
    saves: withClauseSaves(parse(row.saves_json, {} as CombatSheet['saves']), passive, proficiencyBonus(level)),
    conditions: parse(row.conditions_json, [] as string[]),
    death_saves: parse(row.death_saves_json, { successes: 0, failures: 0 }),
    inventory,
    spells: withClauseSpells(parse(row.spells_json, { cantrips: [], known: [], prepared: [], save_dc: null }), passive),
    spell_slots: parse(row.spell_slots_json, {} as CombatSheet['spell_slots']),
    features,
    skills: withClauseSkills(parse(row.skills_json, {} as CombatSheet['skills']), passive, proficiencyBonus(level)),
    proficiencies: withClauseProficiencies(proficiencies, passive),
    proficiency_bonus: overrides.proficiency_bonus ?? proficiencyBonus(level),
    initiative_bonus:
      overrides.initiative_bonus ??
      (abilities.dex?.mod ?? 0) +
        // Alert adds the proficiency bonus to Initiative; Jack of All Trades adds half of it, and the
        // two never stack - Initiative is a check that carries a proficiency bonus once Alert is on it.
        (features.some((f) => f.mechanics?.initiative_proficiency)
          ? proficiencyBonus(level)
          : features.some((f) => f.name === 'Jack of All Trades')
            ? Math.floor(proficiencyBonus(level) / 2)
            : 0) +
      passive.initiative,
    exhaustion,
    stable: row.stable === 1,
    mastery_weapons: features.find((f) => f.mechanics?.mastery_weapons)?.mechanics?.mastery_weapons ?? [],
    ...withClauseTraits(damageTraits(features, anchor, inventory), passive),
    armor_penalty: armorPenalty(inventory, proficiencies),
    stealth_disadvantage: armor.stealth_disadvantage,
    speed_reason: speedReasons.length ? speedReasons.join('; ') : null,
    clause_reminders: passive.reminders,
  };
}

/**
 * The clauses behind every homebrew row on this sheet, and behind every magic item in use - an item
 * gives what it says only while it is worn, and attuned when it asks for attunement, which is the
 * `if.self.wearing` its clauses never have to write. Nothing here is written back to the row.
 */
export function withClauses(
  db: Db,
  features: SheetFeature[],
  inventory: InventoryItem[],
  level: number,
): SheetFeature[] {
  const out = features.map((feature) => {
    const id = feature.mechanics?.homebrew_id;
    if (id === undefined) return feature;
    const clauses = featureClauses(db, id, feature.name, level);
    return clauses.length > 0 ? { ...feature, clauses } : feature;
  });
  for (const item of inventory.filter(itemActive)) {
    const clauses = item.magic?.mechanics?.clauses ?? [];
    if (clauses.length > 0) out.push(withItemFeature(item, clauses, features, level));
  }
  // A spend leaves the item's counter row in the character's own features; while the item is not in
  // use the row has nothing to count, so it does not show as a feature of the sheet.
  const inactiveKeys = new Set<string>(clauseKeysOfInactiveItems(inventory));
  return inactiveKeys.size === 0 ? out : out.filter((f) => !inactiveKeys.has(f.mechanics?.resource ?? ''));
}

/** The resource keys of non-active items' limited clauses, so their stored counter rows stay hidden. */
function clauseKeysOfInactiveItems(inventory: InventoryItem[]): string[] {
  const read: ClauseSheet = { level: 1, proficiency_bonus: 2, abilities: {}, features: [], inventory: [] };
  const keys: string[] = [];
  for (const item of inventory.filter((one) => !itemActive(one))) {
    (item.magic?.mechanics?.clauses ?? []).forEach((clause, at) => {
      if (clauseUsesMax(read, clause.uses) !== null) keys.push(clauseResourceKey(homebrewIndex({ name: item.name, source: 'item' }), at));
    });
  }
  return keys;
}

/**
 * One magic item as a sheet feature. A single limited clause is the item's own counter: the row the
 * sheet carries is the row a spend writes into the character's own features, so the first read of a
 * fresh sheet already knows the cap and any use spent before is read off the saved counter rows.
 */
function withItemFeature(
  item: InventoryItem,
  clauses: Clause[],
  features: SheetFeature[],
  level: number,
): SheetFeature {
  const holder: SheetFeature = { name: item.name, source: 'item', clauses };
  const read: ClauseSheet = { level, proficiency_bonus: proficiencyBonus(level), abilities: {}, features: [], inventory: [] };
  const counters = clauses
    .map((clause, at) => ({ clause, at, spec: clauseUsesMax(read, clause.uses) }))
    .filter((entry) => entry.spec !== null);
  if (counters.length === 1) {
    const index = homebrewIndex({ name: item.name, source: 'item' });
    const key = clauseResourceKey(index, counters[0]!.at);
    if (!features.some((f) => f.mechanics?.resource === key)) {
      const uses = counters[0]!.clause.uses;
      const at =
        typeof uses === 'object' && 'charges' in uses && (uses.charges.recharge === 'dawn' || uses.charges.recharge === 'dusk')
          ? uses.charges.recharge
          : undefined;
      holder.mechanics = {
        resource: key,
        max: counters[0]!.spec!.max,
        used: 0,
        per: counters[0]!.spec!.per,
        ...(at ? { recharge_at: at } : {}),
      };
    }
  }
  return holder;
}

/** An ability score increase from a clause is applied where the sheet is read, and capped at 20. */
function withClauseScores(
  abilities: CombatSheet['abilities'],
  passive: ReturnType<typeof clausePassives>,
): CombatSheet['abilities'] {
  if (Object.keys(passive.asi).length === 0) return abilities;
  const out: CombatSheet['abilities'] = { ...abilities };
  for (const [ability, amount] of Object.entries(passive.asi)) {
    const score = withAsi(out[ability]?.score ?? 10, amount);
    out[ability] = { score, mod: abilityMod(score) };
  }
  return out;
}

/** A save a clause makes the holder proficient in, counted where the sheet is read. */
function withClauseSaves(
  saves: CombatSheet['saves'],
  passive: ReturnType<typeof clausePassives>,
  prof: number,
): CombatSheet['saves'] {
  if (passive.saves.length === 0) return saves;
  const out: CombatSheet['saves'] = { ...saves };
  for (const ability of passive.saves) {
    const entry = out[ability];
    if (entry?.proficient) continue;
    out[ability] = { proficient: true, bonus: (entry?.bonus ?? 0) + prof };
  }
  return out;
}

/** Spells a clause hands out, on the sheet the fight reads and never on the row it was built from. */
function withClauseSpells(
  spells: CombatSheet['spells'],
  passive: ReturnType<typeof clausePassives>,
): CombatSheet['spells'] {
  if (passive.cantrips.length === 0 && passive.spells.length === 0) return spells;
  return {
    ...spells,
    cantrips: mergeNames(spells.cantrips ?? [], passive.cantrips),
    known: mergeNames(spells.known ?? [], passive.spells),
    prepared: mergeNames(spells.prepared ?? [], passive.prepared),
  };
}

/** Weapons, armour, tools and languages a clause trains the holder in, counted where the sheet is read. */
function withClauseProficiencies(
  proficiencies: Proficiencies,
  passive: ReturnType<typeof clausePassives>,
): Proficiencies {
  return {
    ...proficiencies,
    weapons: mergeNames(proficiencies.weapons, passive.weapons),
    armor: mergeNames(proficiencies.armor, passive.armor),
    tools: mergeNames(proficiencies.tools, passive.tools),
    languages: mergeNames(proficiencies.languages, passive.languages),
  };
}

const mergeNames = (into: string[], added: string[]): string[] => [
  ...into,
  ...added.filter((one) => !into.some((held) => held.toLowerCase() === one.toLowerCase())),
];

/** A skill a clause makes the holder proficient in, or doubles, counted where the sheet is read. */
function withClauseSkills(
  skills: CombatSheet['skills'],
  passive: ReturnType<typeof clausePassives>,
  prof: number,
): CombatSheet['skills'] {
  if (passive.proficiencies.length === 0 && passive.expertise.length === 0) return skills;
  const out: CombatSheet['skills'] = { ...skills };
  for (const skill of passive.proficiencies) {
    const entry = out[skill];
    if (entry?.proficient) continue;
    out[skill] = { bonus: (entry?.bonus ?? 0) + prof, proficient: true };
  }
  // Expertise without the proficiency under it is the DM meaning both: granted, then doubled.
  for (const skill of passive.expertise) {
    const entry = out[skill];
    const already = entry?.proficient ? prof : 0;
    out[skill] = { bonus: (entry?.bonus ?? 0) - already + prof * 2, proficient: true };
  }
  return out;
}

/** The damage types a clause makes the holder proof against, merged into what the features already say. */
function withClauseTraits(
  traits: { resistances: string[]; vulnerabilities: string[]; immunities: string[]; condition_immunities: string[] },
  passive: ReturnType<typeof clausePassives>,
): typeof traits {
  const merge = (into: string[], values: string[]): string[] => [
    ...into,
    ...values.filter((value) => !into.includes(value)),
  ];
  return {
    ...traits,
    resistances: merge(traits.resistances, passive.resistances),
    vulnerabilities: merge(traits.vulnerabilities, passive.vulnerabilities),
    immunities: merge(traits.immunities, passive.immunities),
  };
}

/** A mechanics block may carry lists of damage types; a stat-block anchor carries the same as lines. */
interface DamageTraitMechanics {
  resistances?: string[];
  vulnerabilities?: string[];
  immunities?: string[];
  condition_immunities?: string;
}

const words = (line: string | undefined): string[] =>
  (line ?? '')
    .toLowerCase()
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean);

/** A magic item only gives its mechanics while it is worn, and attuned when it asks for attunement. */
const itemActive = (item: InventoryItem): boolean =>
  item.equipped === true && (item.magic?.attunement === false || item.magic?.attuned === true);

/**
 * Resistances, vulnerabilities and immunities a character has from its features - a Dragonborn's fire
 * resistance, a stat-block companion's own lines - and from the magic items it has on, merged into the
 * lists the engine reads.
 */
function damageTraits(
  features: SheetFeature[],
  anchor: FeatureMechanics | null,
  inventory: InventoryItem[],
): { resistances: string[]; vulnerabilities: string[]; immunities: string[]; condition_immunities: string[] } {
  const out = { resistances: [] as string[], vulnerabilities: [] as string[], immunities: [] as string[], condition_immunities: [] as string[] };
  const push = (list: string[], values: string[]): void => {
    for (const value of values) if (value && !list.includes(value)) list.push(value);
  };
  const fromItems = inventory.filter(itemActive).map((item) => ({ mechanics: item.magic!.mechanics }));
  for (const feature of [...features, ...fromItems]) {
    const mechanics = feature.mechanics as DamageTraitMechanics | undefined;
    if (!mechanics) continue;
    push(out.resistances, (mechanics.resistances ?? []).map((v) => v.toLowerCase()));
    push(out.vulnerabilities, (mechanics.vulnerabilities ?? []).map((v) => v.toLowerCase()));
    push(out.immunities, (mechanics.immunities ?? []).map((v) => v.toLowerCase()));
    push(out.condition_immunities, words(mechanics.condition_immunities));
  }
  const lines = anchor as (FeatureMechanics & { damage_resistances?: string; damage_vulnerabilities?: string; damage_immunities?: string; condition_immunities?: string }) | null;
  push(out.resistances, words(lines?.damage_resistances));
  push(out.vulnerabilities, words(lines?.damage_vulnerabilities));
  push(out.immunities, words(lines?.damage_immunities));
  push(out.condition_immunities, words(lines?.condition_immunities));
  return out;
}

/** The SRD armour categories, as the category index on an item and as the proficiency is named. */
const ARMOR_CATEGORIES: Record<string, string> = {
  'light-armor': 'Light Armor',
  'medium-armor': 'Medium Armor',
  'heavy-armor': 'Heavy Armor',
  shields: 'Shields',
};

/**
 * 2024: armour or a shield worn without proficiency in its category gives disadvantage on every d20
 * test using STR or DEX and blocks spellcasting. Homebrew gear the SRD does not know never penalises.
 */
export function armorPenalty(
  inventory: CombatSheet['inventory'],
  proficiencies: Proficiencies,
): { penalty: boolean; reason: string | null } {
  const known = proficiencies.armor.map((a) => a.trim().toLowerCase());
  const missing: string[] = [];
  for (const item of inventory) {
    if (!item.equipped) continue;
    const data = findEquipment(item.name);
    if (!data?.armor_class) continue;
    const category = data.equipment_categories.map((c) => ARMOR_CATEGORIES[c.index]).find(Boolean);
    if (!category || known.includes(category.toLowerCase())) continue;
    missing.push(`${data.name} (${category})`);
  }
  return missing.length === 0
    ? { penalty: false, reason: null }
    : {
        penalty: true,
        reason: `not proficient with ${missing.join(' or ')}: disadvantage on STR and DEX d20 tests and no spellcasting`,
      };
}

export const sheetAbilityMod = (sheet: CombatSheet, ability: Ability): number =>
  sheet.abilities[ability]?.mod ?? abilityMod(sheet.abilities[ability]?.score ?? 10);

/** Save bonus from the sheet, falling back to the plain ability modifier. */
export const sheetSaveBonus = (sheet: CombatSheet, ability: Ability): number =>
  sheet.saves[ability]?.bonus ?? sheetAbilityMod(sheet, ability);

/** A skill check bonus from the sheet, falling back to the plain ability modifier. */
export const sheetSkillBonus = (sheet: CombatSheet, skill: string, ability: Ability): number =>
  sheet.skills[skill]?.bonus ?? sheetAbilityMod(sheet, ability);
