// Character creation and every state change to the player character. The server owns these numbers.
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/connection.js';
import { scheduleCharacterPortrait } from './auto-portraits.js';
import {
  advanceTime,
  DAYS_PER_MONTH,
  MONTHS_PER_YEAR,
  nowState,
  type NowState,
  type TimeChange,
} from './calendar.js';
import {
  getCharacterSheet,
  logEvent,
  party,
  pcRow,
  rollAndRecord,
  setCharacterDraft,
  type CharacterSummary,
  type RollRecord,
} from './campaign.js';
import {
  boostsFor,
  clauseApplies,
  clausePassives,
  clauseLabel,
  clauseResourceKey,
  clauseUsesLeft,
  clauseUsesMax,
  flatAmount,
  homebrewIndex,
  resolveDice,
  withAsi,
  type ClauseCtx,
  type ClauseHolder,
  type ClauseSheet,
  type RollBoost,
} from '../combat/homebrew.js';
import { conditionRule, exhaustionSpeedPenalty, type ConditionRule } from '../combat/conditions.js';
import { featureConditionImmunities, ragingConditionImmunities, type ResourcePeriod } from '../combat/features.js';
import { combatSheet, type CombatSheet } from '../combat/sheet.js';
import type { Combatant } from '../combat/state.js';
import { describeClause, describeDo, doCapability, type Clause } from './mechanics.js';
import { getOverrides, stripHandSet } from './overrides.js';
import {
  customSpells,
  customSubclassFeatures,
  customSubclasses,
  featureClauses,
  findHomebrewBackground,
  findHomebrewSpell,
  getHomebrew,
  listHomebrew,
  spellFitsClass,
  type BackgroundSchema,
  type SpellSchema,
  type SubclassSchema,
} from './progression.js';
import { getSettings, luckBiasFor } from './settings.js';
import {
  ABILITIES,
  ABILITY_MAX,
  COINS,
  COIN_CP,
  EPIC_ABILITY_MAX,
  SKILL_ABILITY,
  SKILL_KEYS,
  STANDARD_ARRAY,
  abilityMod,
  addCoins,
  armorClass,
  carriedLoad,
  coinsCp,
  coinsFromCp,
  coinsGp,
  coinsText,
  DAMAGE_TYPES,
  emptyCoins,
  ENCUMBERED_SPEED,
  itemsWeight,
  levelForXp,
  proficiencyBonus,
  settleCoins,
  XP_THRESHOLDS,
  validateAbilities,
  type Ability,
  type AbilityScores,
  type Coins,
} from './rules.js';
import {
  attunementRequirementMet,
  backfillItemWeights,
  classIndexOf,
  classLevelRow,
  containerSpec,
  conditionNames,
  equipmentBundles,
  equipmentKind,
  equipmentProficiency,
  featureIndexOf,
  featureText,
  findBackground,
  findClass,
  findEquipment,
  findFeat,
  findLanguage,
  findLineage,
  findMagicItem,
  findSpecies,
  findSpell,
  masteryWeaponOptions,
  resolveItemWeight,
  skillChoiceGroups,
  skillKey,
  itemCostCp,
  namesMagicBonus,
  spellsForClass,
  speciesLineages,
  speciesTraits,
  speciesTraitsFor,
  subclassLevelRow,
  subclassesOf,
  toolChoiceGroups,
  toolKey,
  traitLineages,
  unidentifiedKind,
  ITEM_RARITIES,
  type ContainerCapacity,
  type EquipmentBundle,
  type EquipmentPick,
  type ItemCharges,
  type ItemRarity,
  type MagicItemMatch,
} from '../srd/lookup.js';
import * as srd from '../srd/data.js';

export type FeatureSource = 'class' | 'subclass' | 'species' | 'background' | 'feat' | 'homebrew' | 'stat_block';
export type CharacterRole = 'pc' | 'companion' | 'npc';

export interface AbilityEntry {
  score: number;
  mod: number;
}
export interface SaveEntry {
  proficient: boolean;
  bonus: number;
}
export interface SkillEntry {
  ability: Ability;
  proficient: boolean;
  expertise: boolean;
  bonus: number;
}
export interface Proficiencies {
  armor: string[];
  weapons: string[];
  tools: string[];
  languages: string[];
}
/** The numbers behind a stat-block feature, so the combat engine does not have to parse its text. */
export interface FeatureMechanics {
  kind?: string;
  attack_bonus?: number;
  reach_ft?: number;
  range_ft?: number;
  long_range_ft?: number;
  damage?: Array<{ dice: string; type: string | null }>;
  uses?: string;
  creature?: string;
  cr?: number;
  size?: string;
  type?: string;
  speed?: Record<string, number>;
  senses?: string[];
  initiative_bonus?: number | null;
  passive_perception?: number | null;
  damage_vulnerabilities?: string;
  damage_resistances?: string;
  damage_immunities?: string;
  condition_immunities?: string;
  /** Extra Attack and its upgrades: how many attacks the Attack action adds beyond the first. */
  extra_attacks?: number;
  /** A class resource the SRD level table gives a number for: rage uses, sneak attack dice, sorcery points. */
  resource?: string;
  max?: number;
  /** The rest that gives every use back; never for a use that is spent once and stays spent. */
  per?: ResourcePeriod;
  /** What a short rest gives back when the resource only fully returns on a long one. */
  regain_on_short?: 'one' | 'all';
  /** A magic item's clause counter: it comes back when the clock passes that hour, not with a rest. */
  recharge_at?: 'dawn' | 'dusk';
  /** Uses spent so far; a rest puts it back to 0. */
  used?: number;
  /** Dwarven Toughness and the like: hit points added at every level, this one included. */
  hp_per_level?: number;
  /** Alert: the proficiency bonus is added to Initiative. */
  initiative_proficiency?: boolean;
  /** Defense and other flat armour class bonuses; only counted while armour is worn. */
  ac_bonus?: number;
  /** Archery: added to attack rolls with ranged weapons. */
  ranged_attack_bonus?: number;
  /** The Fighting Style this feature is, so the engine can read it off the sheet. */
  fighting_style?: string;
  /** What the player picked for a feature that is itself a choice: Expertise skills, invocations, Metamagic. */
  options?: string[];
  /** 2024 Weapon Mastery: the weapons whose mastery property this character may use, swapped on a long rest. */
  mastery_weapons?: string[];
  /** Magic Initiate and other feats that cast: which ability the granted spells use. */
  spellcasting_ability?: 'int' | 'wis' | 'cha';
  /** Damage types the feature is proof against, lowercased; the combat engine reads these off the sheet. */
  resistances?: string[];
  vulnerabilities?: string[];
  immunities?: string[];
  /** Homebrew: which homebrew row this feature came from. */
  homebrew_id?: number;
  /** A magic item's own clauses: what it does while it is worn, in the language a feature uses. */
  clauses?: Clause[];
  /** Homebrew the player took above the power budget on purpose; the sheet shows a marker. */
  over_budget?: boolean;
}
export interface Feature {
  name: string;
  source: FeatureSource;
  text: string;
  mechanics?: FeatureMechanics;
  /** What it does, as clauses: filled in when the sheet is read and stripped again when it is written. */
  clauses?: Clause[];
}
export interface SpellsJson {
  spellcasting_ability: 'int' | 'wis' | 'cha' | null;
  cantrips: string[];
  /** The spells the character knows; for a preparing class it is the pool the prepared list is drawn from. */
  known: string[];
  /** The spells that can actually be cast right now. */
  prepared: string[];
  /** Wizards only: the book the prepared list is drawn from, which copying a spell adds to. */
  spellbook?: string[];
  /** Spells a feat or a trait always has prepared: castable, but not counted against the class table. */
  granted?: string[];
  save_dc: number | null;
  attack_bonus: number | null;
}
export interface ItemContainer extends ContainerCapacity {
  contents: InventoryItem[];
}

/** What makes an item magical: where it came from, what it does, and whether anyone knows yet. */
export interface ItemMagic {
  /** The SRD magic item this came from, when it came from one. */
  srd_index?: string;
  rarity: ItemRarity;
  /** false when it needs none, true when anyone may attune, else the requirement: "by a Paladin". */
  attunement: boolean | string;
  attuned?: boolean;
  /** +N to attack and damage rolls for a weapon, to Armor Class for armour or a shield. */
  bonus?: number;
  /** The SRD mundane item this is a magical version of, by its canonical name, e.g. "Longsword". */
  base?: string;
  charges?: ItemCharges;
  /** False until someone works out what it is; the player's own sheet only sees its kind until then. */
  identified: boolean;
  /** Resistances and the like the item grants, in the shape a feature carries them. */
  mechanics?: FeatureMechanics;
}

export interface InventoryItem {
  name: string;
  qty: number;
  equipped?: boolean;
  notes?: string;
  weight_lb?: number;
  /** A short handle unique inside this inventory, so a tool can name one item of a pair. */
  id?: string;
  magic?: ItemMagic;
  /** A pack, a sack, a Bag of Holding: what it can hold and what is in it. */
  container?: ItemContainer;
}

/** 2024: nobody is attuned to more than three magic items at a time. */
export const ATTUNEMENT_MAX = 3;
export interface DeathSaves {
  successes: number;
  failures: number;
  /** At 0 HP and stable: the in-world minute the 1d4 hours run out and 1 HP comes back. */
  stable_until?: number;
}
export interface HitDice {
  die: string;
  max: number;
  used: number;
}

/** bonus: slots woven out of nothing (Font of Magic, Wild Resurgence); they are spent first and go on a long rest. */
export type SpellSlots = Record<string, { max: number; used: number; bonus?: number }>;

/** How many castings of that level are left: the table's unspent slots plus any created ones. */
export const slotsLeft = (slot: { max: number; used: number; bonus?: number }): number =>
  slot.max - slot.used + (slot.bonus ?? 0);

const MAX_SUPPORTED_LEVEL = 20;

/** What the player may do after their character dies; promoting a companion needs one to be in play. */
export function deathOptions(db: Db, campaignId: number): string[] {
  const companion = party(db, campaignId).companions.length > 0;
  return companion ? ['new_character', 'promote_companion', 'end_session'] : ['new_character', 'end_session'];
}

interface PcState {
  id: number;
  campaign_id: number;
  name: string;
  is_pc: boolean;
  role: CharacterRole;
  species: string;
  /** The lineage inside the species, e.g. "Draconic Ancestor: Red"; null for a species that has none. */
  lineage: string | null;
  /** Null for a character built from a creature stat block; the creature name is in species. */
  class: string | null;
  background: string | null;
  subclass: string | null;
  /** Set when the subclass is one the DM wrote: which homebrew row its features come from. */
  subclass_homebrew_id: number | null;
  level: number;
  xp: number;
  hp_current: number;
  hp_max: number;
  temp_hp: number;
  ac: number;
  speed: number;
  exhaustion: number;
  gold: number;
  /** The purse by denomination; gold is its whole value in gp, rounded down. */
  coins: Coins;
  inspiration: number;
  status: string;
  abilities: Record<Ability, AbilityEntry>;
  saves: Record<Ability, SaveEntry>;
  skills: Record<string, SkillEntry>;
  proficiencies: Proficiencies;
  features: Feature[];
  spells: SpellsJson;
  spell_slots: SpellSlots;
  inventory: InventoryItem[];
  conditions: string[];
  death_saves: DeathSaves;
  hit_dice: HitDice;
  /** At 0 HP and stabilised: no more death saves until something hurts them again. */
  stable: boolean;
  /** Written once, when the sheet is created. */
  appearance?: string | null;
  /** True when loading gave the inventory ids it was missing, so a read-only tool knows to write them back. */
  ids_backfilled?: boolean;
}

const nowIso = (): string => new Date().toISOString();

function parse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * The character a tool acts on: the campaign's active PC by default (or the most recent one if none is
 * active), or the named character - a companion, an NPC - when character_id is given.
 */
function loadPc(db: Db, campaignId: number, characterId?: number): PcState {
  const row =
    characterId === undefined
      ? pcRow(db, campaignId)
      : (db.prepare('SELECT * FROM character WHERE id = ? AND campaign_id = ?').get(characterId, campaignId) as
          | Record<string, string | number | null>
          | undefined);
  if (!row) {
    throw new Error(
      characterId === undefined
        ? `Campaign ${campaignId} has no character yet. Run character creation with create_character first.`
        : `Campaign ${campaignId} has no character with id ${characterId}. Call list_party to see who is in it.`,
    );
  }
  const pc: PcState = {
    id: row.id as number,
    campaign_id: row.campaign_id as number,
    name: row.name as string,
    is_pc: row.is_pc === 1,
    role: row.role as CharacterRole,
    species: row.species as string,
    lineage: (row.lineage as string | null) ?? null,
    class: row.class as string | null,
    background: row.background as string | null,
    subclass: row.subclass as string | null,
    subclass_homebrew_id: (row.subclass_homebrew_id as number | null) ?? null,
    level: row.level as number,
    xp: row.xp as number,
    hp_current: (row.hp_current as number | null) ?? 0,
    hp_max: (row.hp_max as number | null) ?? 0,
    temp_hp: row.temp_hp as number,
    ac: (row.ac as number | null) ?? 10,
    speed: (row.speed as number | null) ?? 30,
    exhaustion: row.exhaustion as number,
    gold: row.gold as number,
    // A row from before coins existed kept its whole purse in gold; the denominations start there.
    coins: { ...emptyCoins(), ...parse<Partial<Coins>>(row.coins_json, { gp: row.gold as number }) },
    inspiration: row.inspiration as number,
    status: row.status as string,
    abilities: parse(row.abilities_json, {} as Record<Ability, AbilityEntry>),
    saves: parse(row.saves_json, {} as Record<Ability, SaveEntry>),
    skills: parse(row.skills_json, {} as Record<string, SkillEntry>),
    proficiencies: parse(row.proficiencies_json, { armor: [], weapons: [], tools: [], languages: [] }),
    features: parse(row.features_json, [] as Feature[]),
    spells: parse(row.spells_json, {
      spellcasting_ability: null,
      cantrips: [],
      known: [],
      prepared: [],
      save_dc: null,
      attack_bonus: null,
    }),
    spell_slots: parse(row.spell_slots_json, {} as SpellSlots),
    inventory: parse(row.inventory_json, [] as InventoryItem[]),
    conditions: parse(row.conditions_json, [] as string[]),
    death_saves: parse(row.death_saves_json, { successes: 0, failures: 0 }),
    hit_dice: parse(row.hit_dice_json, { die: 'd8', max: 1, used: 0 }),
    stable: row.stable === 1,
  };
  // A sheet written before the spellbook existed: what a Wizard knows is what stands in their book.
  if (isWizard(pc) && !pc.spells.spellbook) pc.spells.spellbook = [...pc.spells.known];
  // Cheat mode writes the gold column straight: a hand-set total re-mints the purse behind it.
  if (coinsGp(pc.coins) !== pc.gold) pc.coins = { ...emptyCoins(), gp: pc.gold };
  if (backfillItemIds(pc.inventory)) pc.ids_backfilled = true;
  fillClauses(db, pc.features, pc.level);
  return pc;
}

/**
 * What a homebrew feature does, read off the library row it points at. The clauses are put on the row
 * for the rules to read and taken off again before it is written: the library owns them, the sheet
 * only points at it, so a revision reaches every character that holds the feature at once.
 */
function fillClauses(db: Db, features: Feature[], level: number): void {
  for (const feature of features) {
    const id = feature.mechanics?.homebrew_id;
    if (id === undefined) continue;
    const clauses = featureClauses(db, id, feature.name, level);
    if (clauses.length > 0) feature.clauses = clauses;
  }
}

/** The feature rows as the sheet stores them: what was read off the library row does not go back in. */
const storedFeatures = (features: Feature[]): Feature[] => features.map(({ clauses, ...feature }) => feature);

function savePc(db: Db, pc: PcState): void {
  db.prepare(
    `UPDATE character SET subclass = ?, subclass_homebrew_id = ?, level = ?, xp = ?, hp_current = ?, hp_max = ?, temp_hp = ?, ac = ?, speed = ?,
       exhaustion = ?, gold = ?, coins_json = ?, inspiration = ?, status = ?, abilities_json = ?, saves_json = ?, skills_json = ?, proficiencies_json = ?,
       features_json = ?, spells_json = ?, spell_slots_json = ?, inventory_json = ?, conditions_json = ?,
       death_saves_json = ?, hit_dice_json = ?, stable = ?, updated_at = ? WHERE id = ?`,
  ).run(
    pc.subclass,
    pc.subclass_homebrew_id,
    pc.level,
    pc.xp,
    pc.hp_current,
    pc.hp_max,
    pc.temp_hp,
    pc.ac,
    pc.speed,
    pc.exhaustion,
    coinsGp(pc.coins),
    JSON.stringify(pc.coins),
    pc.inspiration,
    pc.status,
    JSON.stringify(pc.abilities),
    JSON.stringify(pc.saves),
    JSON.stringify(pc.skills),
    JSON.stringify(pc.proficiencies),
    JSON.stringify(storedFeatures(pc.features)),
    JSON.stringify(pc.spells),
    JSON.stringify(pc.spell_slots),
    JSON.stringify(pc.inventory),
    JSON.stringify(pc.conditions),
    JSON.stringify(pc.death_saves),
    JSON.stringify(pc.hit_dice),
    pc.stable ? 1 : 0,
    nowIso(),
    pc.id,
  );
}

/** Writes a freshly built sheet (a PC, a companion or an NPC) and returns its id. */
function insertCharacter(db: Db, pc: PcState): number {
  const ts = nowIso();
  return Number(
    db
      .prepare(
        `INSERT INTO character (campaign_id, name, is_pc, role, species, lineage, class, background, level, xp, hp_current, hp_max,
           temp_hp, ac, speed, abilities_json, saves_json, skills_json, proficiencies_json, features_json, spells_json,
           spell_slots_json, inventory_json, conditions_json, death_saves_json, hit_dice_json, gold, status, stable, appearance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pc.campaign_id,
        pc.name,
        pc.is_pc ? 1 : 0,
        pc.role,
        pc.species,
        pc.lineage,
        pc.class,
        pc.background,
        pc.level,
        pc.xp,
        pc.hp_current,
        pc.hp_max,
        pc.ac,
        pc.speed,
        JSON.stringify(pc.abilities),
        JSON.stringify(pc.saves),
        JSON.stringify(pc.skills),
        JSON.stringify(pc.proficiencies),
        JSON.stringify(storedFeatures(pc.features)),
        JSON.stringify(pc.spells),
        JSON.stringify(pc.spell_slots),
        JSON.stringify(pc.inventory),
        JSON.stringify(pc.conditions),
        JSON.stringify(pc.death_saves),
        JSON.stringify(pc.hit_dice),
        pc.gold,
        pc.status,
        pc.stable ? 1 : 0,
        pc.appearance ?? null,
        ts,
        ts,
      ).lastInsertRowid,
  );
}

const SHIELD_INDEX = 'shield';

function equippedArmor(pc: PcState): {
  armor: srd.EquipmentData | null;
  shield: boolean;
  /** The rows behind `armor` and `shield`; only these carry their magic into AC. */
  armorItem: InventoryItem | null;
  shieldItem: InventoryItem | null;
} {
  let armor: srd.EquipmentData | null = null;
  let armorItem: InventoryItem | null = null;
  let shieldItem: InventoryItem | null = null;
  for (const item of pc.inventory) {
    if (!item.equipped) continue;
    const data = itemEquipment(item);
    if (!data?.armor_class) continue;
    if (data.index === SHIELD_INDEX) {
      // One shield benefits its bearer, so the first one worn is the one that counts.
      if (shieldItem === null) shieldItem = item;
    } else if (!armor || data.armor_class.base > armor.armor_class!.base) {
      armor = data;
      armorItem = item;
    }
  }
  return { armor, shield: shieldItem !== null, armorItem, shieldItem };
}

/** 2024 armour table: armour heavier than its wearer costs 10 ft of speed. */
export const ARMOR_SPEED_PENALTY = 10;

/** What the equipped armour costs its wearer beyond its armour class. */
export interface ArmorLoad {
  /** The body armour worn, or null when there is none. */
  armor: string | null;
  /** 10 when the wearer's Strength is under the armour's minimum, else 0. */
  speed_penalty: number;
  /** Armour the table marks as loud: Disadvantage on Stealth checks. */
  stealth_disadvantage: boolean;
  /** The rules that applied, in words the sheet and the reply can show. */
  reasons: string[];
}

/** The two weight rules of the 2024 armour table, read off what is equipped and the wearer's Strength. */
export function armorLoad(
  inventory: Array<{ name: string; equipped?: boolean; magic?: { base?: string } }>,
  strScore: number,
): ArmorLoad {
  const out: ArmorLoad = { armor: null, speed_penalty: 0, stealth_disadvantage: false, reasons: [] };
  for (const item of inventory) {
    if (!item.equipped) continue;
    const data = itemEquipment(item);
    if (!data?.armor_class) continue;
    if (data.index !== SHIELD_INDEX) out.armor = data.name;
    if (data.str_minimum !== undefined && strScore < data.str_minimum) {
      out.speed_penalty = ARMOR_SPEED_PENALTY;
      out.reasons.push(`${data.name} needs Strength ${data.str_minimum} and theirs is ${strScore}: speed -${ARMOR_SPEED_PENALTY} ft`);
    }
    if (data.stealth_disadvantage) {
      out.stealth_disadvantage = true;
      out.reasons.push(`${data.name} gives Disadvantage on Stealth checks`);
    }
  }
  return out;
}

/** Whether these feature rows carry the SRD feature with this index, matched by the SRD's own name. */
function holdsFeature(features: Array<{ name: string }>, index: string): boolean {
  const entry = srd.features().find((f) => f.index === index);
  return entry !== undefined && features.some((f) => f.name.trim().toLowerCase() === entry.name.toLowerCase());
}

/**
 * The feet the 2024 martial speed features add: Fast Movement and Roving out of heavy armour, Unarmored
 * Movement with no armour and no Shield. The combat registry describes them; the number lives here,
 * beside every other thing that moves a character's speed. Each one turns on holding the feature.
 */
export function classSpeedBonus(
  features: Array<{ name: string; mechanics?: FeatureMechanics; clauses?: Clause[] }>,
  inventory: Array<{ name: string; equipped?: boolean; magic?: { base?: string } }>,
): { bonus: number; reasons: string[] } {
  const worn = inventory.filter((item) => item.equipped).map((item) => itemEquipment(item));
  const armored = worn.some((data) => data?.armor_class !== undefined && data.index !== SHIELD_INDEX);
  const heavy = worn.some((data) => data?.equipment_categories.some((c) => c.index === 'heavy-armor') ?? false);
  const shield = worn.some((data) => data?.index === SHIELD_INDEX);
  const out = { bonus: 0, reasons: [] as string[] };
  if (!heavy && holdsFeature(features, 'barbarian-fast-movement')) {
    out.bonus += 10;
    out.reasons.push('Fast Movement: +10 ft out of heavy armour');
  }
  if (!heavy && holdsFeature(features, 'ranger-roving')) {
    out.bonus += 10;
    out.reasons.push('Roving: +10 ft out of heavy armour');
  }
  const unarmoredMovement = features.find((f) => f.mechanics?.resource === 'unarmored_movement')?.mechanics?.max ?? 0;
  if (unarmoredMovement > 0 && !armored && !shield) {
    out.bonus += unarmoredMovement;
    out.reasons.push(`Unarmored Movement: +${unarmoredMovement} ft with no armour and no Shield`);
  }
  // What the DM invented, read at the same seam: a clause that gives feet is a passive like any other.
  const clauses = clausePassives(features);
  if (clauses.speed_ft !== 0) {
    out.bonus += clauses.speed_ft;
    out.reasons.push(...clauses.notes.filter((note) => /ft Speed|to speed/i.test(note)));
  }
  return out;
}

/**
 * Unarmored Defense replaces armour with an ability score, for the character that holds the feature -
 * which is not the same as being of the class, since a stripped or homebrewed sheet may not carry it.
 */
function unarmoredBonus(
  pc: PcState,
  armor: srd.EquipmentData | null,
  shield: boolean,
): { bonus: number; ability: 'CON' | 'WIS' | 'CHA' } | null {
  if (armor) return null;
  const classIndex = classIndexOf(pc.class);
  const held = pc.features.map((f) => featureIndexOf(f.name, classIndex));
  if (held.includes('barbarian-unarmored-defense')) return { bonus: pc.abilities.con?.mod ?? 0, ability: 'CON' };
  if (held.includes('monk-unarmored-defense') && !shield) return { bonus: pc.abilities.wis?.mod ?? 0, ability: 'WIS' };
  // Draconic Resilience: "your base Armor Class equals 10 plus your Dexterity and Charisma modifiers".
  if (held.includes('draconic-sorcery-draconic-resilience')) return { bonus: pc.abilities.cha?.mod ?? 0, ability: 'CHA' };
  return null;
}

/** Why the armour class is what it is, so the DM and the sheet can read it out. */
export interface AcBreakdown {
  total: number;
  /** The body armour worn, or null when there is none. */
  armor: string | null;
  shield: boolean;
  /** Defense and its like, worth nothing without armour on. */
  feature_bonus: number;
  /** The +N of magical armour or a magical shield in use, and any worn item's own ac_bonus. */
  magic_bonus: number;
  /** One line for every part that is not the plain armour table. */
  notes: string[];
}

/** A worn item gives its mechanics only while it is on, and attuned when it asks for attunement. */
const itemInUse = (item: InventoryItem): boolean =>
  item.equipped === true && (item.magic?.attunement === false || item.magic?.attuned === true);

function acBreakdown(pc: PcState): AcBreakdown {
  const { armor, shield, armorItem, shieldItem } = equippedArmor(pc);
  // The Defense Fighting Style and its like are worth nothing without armour on.
  const featureBonus = armor ? pc.features.reduce((sum, f) => sum + (f.mechanics?.ac_bonus ?? 0), 0) : 0;
  const notes: string[] = [];
  // Only the armour in use and the one shield add their +N: a spare shield in the pack does not stack.
  let magicBonus = 0;
  for (const item of [armorItem, shieldItem]) {
    if (!item) continue;
    const bonus = activeItemBonus(item);
    if (!bonus) continue;
    magicBonus += bonus;
    notes.push(`${displayItemName(item)}: +${bonus} AC`);
  }
  // An item's own mechanics.ac_bonus - a Ring of Protection - is not a Fighting Style, so it applies
  // worn and armour or not, like the homebrew clause below rather than like the features above.
  for (const item of pc.inventory) {
    if (!itemInUse(item)) continue;
    const bonus = item.magic?.mechanics?.ac_bonus ?? 0;
    if (!bonus) continue;
    magicBonus += bonus;
    notes.push(`${displayItemName(item)}: +${bonus} AC`);
  }
  // A homebrew clause that gives Armor Class gives it armoured or not: it is not a Fighting Style.
  // This is the only place it is counted; the combat sheet reads the column this number is written to.
  const fromClauses = clausePassives(pc.features, { inventory: pc.inventory });
  if (fromClauses.ac) notes.push(`homebrew: +${fromClauses.ac} AC`);
  if (featureBonus) notes.push(`features: +${featureBonus} AC`);
  const unarmored = unarmoredBonus(pc, armor, shield);
  if (unarmored && unarmored.bonus !== 0) {
    notes.push(`Unarmored Defense: 10 + DEX + ${unarmored.ability} (+${unarmored.bonus} from it)`);
  }
  // A half-built row has no ability scores yet; the sheet still has to render.
  const base = armorClass(pc.abilities.dex?.mod ?? 0, armor?.armor_class ?? null, shield, unarmored?.bonus ?? 0);
  return {
    total: base + featureBonus + magicBonus + fromClauses.ac,
    armor: armor?.name ?? null,
    shield,
    feature_bonus: featureBonus + fromClauses.ac,
    magic_bonus: magicBonus,
    notes,
  };
}

/** Recomputes everything derived from ability scores, level and gear. Call after any of those change. */
function recompute(pc: PcState): void {
  const prof = proficiencyBonus(pc.level);
  for (const ability of ABILITIES) {
    const entry = pc.abilities[ability];
    entry.mod = abilityMod(entry.score);
  }
  for (const ability of ABILITIES) {
    const save = pc.saves[ability];
    save.bonus = pc.abilities[ability].mod + (save.proficient ? prof : 0);
  }
  for (const key of SKILL_KEYS) {
    const skill = pc.skills[key]!;
    const base = pc.abilities[skill.ability].mod;
    skill.bonus = base + (skill.expertise ? prof * 2 : skill.proficient ? prof : 0);
  }
  pc.ac = acBreakdown(pc).total;
  if (pc.spells.spellcasting_ability) {
    const mod = pc.abilities[pc.spells.spellcasting_ability].mod;
    pc.spells.save_dc = 8 + prof + mod;
    pc.spells.attack_bonus = prof + mod;
  }
}

// --- creation ---------------------------------------------------------------

const ARMOR_INDEXES = new Set(['light-armor', 'medium-armor', 'heavy-armor', 'shields', 'all-armor']);

function classProficiencies(cls: srd.ClassData): Proficiencies {
  const out: Proficiencies = { armor: [], weapons: [], tools: [], languages: ['Common'] };
  for (const prof of cls.proficiencies) {
    if (prof.index.startsWith('saving-throw-')) continue;
    if (prof.index === 'all-armor') out.armor.push('Light Armor', 'Medium Armor', 'Heavy Armor');
    else if (ARMOR_INDEXES.has(prof.index)) out.armor.push(prof.name);
    else if (prof.index.startsWith('tool-') || prof.name.startsWith('Tool: ')) out.tools.push(prof.name.replace('Tool: ', ''));
    else if (/weapon/i.test(prof.name) || /s$/.test(prof.index)) out.weapons.push(prof.name);
    else out.tools.push(prof.name);
  }
  return out;
}

const classOf = (pc: { class: string | null }): string => (pc.class ?? '').trim().toLowerCase();
const isWizard = (pc: { class: string | null }): boolean => classOf(pc) === 'wizard';

/** Classes whose whole prepared list changes on a Long Rest: prepare_spells is theirs alone. */
const PREPARING_CLASSES = ['cleric', 'druid', 'paladin', 'wizard'];
/** Classes whose spellcasting text lets them replace one spell when they gain a level. */
const SWAP_CLASSES = ['bard', 'ranger', 'sorcerer', 'warlock'];

// --- languages ---------------------------------------------------------------

const STARTING_LANGUAGE_CHOICES = 2;
/** Campaign languages live in the glossary, marked by the first word of their definition. */
const LANGUAGE_MARK = 'Language.';

export interface LanguageOption {
  name: string;
  rarity: 'standard' | 'rare' | 'campaign';
  speakers: string;
  script: string | null;
}

function campaignLanguageRows(db: Db, campaignId: number): LanguageOption[] {
  const rows = db
    .prepare(
      `SELECT term, definition FROM glossary_entry WHERE campaign_id = ? AND definition LIKE '${LANGUAGE_MARK}%' ORDER BY term`,
    )
    .all(campaignId) as Array<{ term: string; definition: string }>;
  return rows.map((row) => ({
    name: row.term,
    rarity: 'campaign' as const,
    speakers: /Spoken by ([^.]+)\./.exec(row.definition)?.[1] ?? 'unknown',
    script: /Script: ([^.]+)\./.exec(row.definition)?.[1] ?? null,
  }));
}

const srdLanguageOptions = (): LanguageOption[] =>
  srd.languages().map((l) => ({ name: l.name, rarity: l.rarity, speakers: l.speakers, script: l.script ?? null }));

/** Every language a character of this campaign may learn: the SRD table plus what the DM wrote. */
export function languageOptions(db: Db, campaignId: number): LanguageOption[] {
  return [...srdLanguageOptions(), ...campaignLanguageRows(db, campaignId)];
}

/** The option's own spelling, or an error naming what this campaign has. */
function resolveLanguage(db: Db, campaignId: number, name: string): string {
  const wanted = name.trim().toLowerCase();
  const options = languageOptions(db, campaignId);
  const found = options.find((l) => l.name.toLowerCase() === wanted);
  if (!found) {
    throw new Error(`"${name}" is not a language in this campaign. Options: ${options.map((l) => l.name).join(', ')}.`);
  }
  return found.name;
}

/** The language a species is most likely to have grown up with, for the picks nobody made. */
const SPECIES_LANGUAGE: Record<string, string> = {
  dragonborn: 'Draconic',
  dwarf: 'Dwarvish',
  elf: 'Elvish',
  gnome: 'Gnomish',
  goliath: 'Giant',
  halfling: 'Halfling',
  human: 'Common Sign Language',
  orc: 'Orc',
  tiefling: 'Infernal',
};

function defaultLanguages(speciesIndex: string): string[] {
  const first = SPECIES_LANGUAGE[speciesIndex] ?? 'Common Sign Language';
  const second = first === 'Common Sign Language' ? 'Elvish' : 'Common Sign Language';
  return [first, second];
}

/**
 * Common plus the two languages the player chose. An empty pick is filled from the species rather than
 * refused, so a companion or a character built without the question still has a legal sheet; the caller
 * is told which languages were chosen for them.
 */
function resolveLanguageChoices(
  db: Db,
  campaignId: number,
  speciesIndex: string,
  picks: string[] | undefined,
): { languages: string[]; chosen_for_you: string[] | null } {
  if (picks === undefined) {
    const filled = defaultLanguages(speciesIndex);
    return { languages: ['Common', ...filled], chosen_for_you: filled };
  }
  if (picks.length !== STARTING_LANGUAGE_CHOICES) {
    const options = languageOptions(db, campaignId)
      .filter((l) => l.name !== 'Common')
      .map((l) => l.name);
    throw new Error(
      `A character starts knowing Common and ${STARTING_LANGUAGE_CHOICES} more languages; got ${picks.length}. Options: ${options.join(', ')}.`,
    );
  }
  const resolved = picks.map((name) => resolveLanguage(db, campaignId, name));
  if (new Set(resolved).size !== resolved.length) throw new Error('Each language can only be chosen once.');
  if (resolved.includes('Common')) throw new Error('Common is already known; choose two other languages.');
  return { languages: ['Common', ...resolved], chosen_for_you: null };
}

// --- tool proficiencies -------------------------------------------------------

const hasTool = (pc: { proficiencies: Proficiencies }, name: string): boolean =>
  pc.proficiencies.tools.some((t) => toolKey(t) === toolKey(name));

/** Matches the player's tool picks to the class's tool-choice groups; an empty pick takes the first. */
function resolveToolChoices(
  cls: srd.ClassData,
  picks: string[] | undefined,
): { tools: string[]; chosen_for_you: string[] | null } {
  const groups = toolChoiceGroups(cls);
  const total = groups.reduce((sum, g) => sum + g.choose, 0);
  if (total === 0) {
    if (picks?.length) throw new Error(`${cls.name} chooses no tool proficiencies; leave tools empty.`);
    return { tools: [], chosen_for_you: null };
  }
  if (picks === undefined) {
    const filled = groups.flatMap((g) => g.from.slice(0, g.choose));
    return { tools: filled, chosen_for_you: filled };
  }
  const detail = groups.map((g) => `${g.choose} of [${g.from.join(', ')}]`).join('; ');
  if (picks.length !== total) {
    throw new Error(`A ${cls.name} chooses ${total} tool proficiencies: ${detail}. Got ${picks.length}.`);
  }
  if (new Set(picks.map(toolKey)).size !== picks.length) throw new Error('Each tool can only be chosen once.');
  const remaining = [...picks];
  const tools: string[] = [];
  for (const group of groups) {
    let taken = 0;
    for (const pick of [...remaining]) {
      if (taken === group.choose) break;
      const match = group.from.find((option) => toolKey(option) === toolKey(pick));
      if (!match) continue;
      tools.push(match);
      remaining.splice(remaining.indexOf(pick), 1);
      taken += 1;
    }
    if (taken !== group.choose) throw new Error(`Choose ${group.choose} from [${group.from.join(', ')}] (${group.desc}).`);
  }
  return { tools, chosen_for_you: null };
}

// --- features that are themselves a choice ------------------------------------

export interface FeatureChoiceSpec {
  feature: string;
  choose: number;
  from: string[];
  desc: string;
}

const EXPERTISE = 'Expertise';
const FIGHTING_STYLE = 'Fighting Style';
const METAMAGIC = 'Metamagic';
const INVOCATIONS = 'Eldritch Invocations';
const WEAPON_MASTERY = 'Weapon Mastery';
const HUNTERS_PREY = "Hunter's Prey";
const HUNTERS_PREY_OPTIONS = ['Colossus Slayer', 'Horde Breaker'];
const MASTERY_DESC = 'Weapons whose mastery property you can use; a long rest swaps them.';
const SCHOLAR = 'Scholar';
const BONUS_PROFICIENCIES = 'Bonus Proficiencies';
const DIVINE_ORDER = 'Divine Order';
const PRIMAL_ORDER = 'Primal Order';
const ELEMENTAL_AFFINITY = 'Elemental Affinity';
const MAGICAL_DISCOVERIES = 'Magical Discoveries';
const MYSTIC_ARCANUM = 'Mystic Arcanum';
const SPELL_MASTERY = 'Spell Mastery';
const SIGNATURE_SPELLS = 'Signature Spells';
const SCHOLAR_SKILLS = ['arcana', 'history', 'investigation', 'medicine', 'nature', 'religion'];
/** The lists Magical Discoveries and Magical Secrets draw on, beside the Bard's own. */
const OTHER_LISTS = ['cleric', 'druid', 'wizard'];

/**
 * The class and subclass features that are themselves a choice, by SRD feature index: what the pick is
 * called on the sheet, how many the feature takes, and the pool it comes from. The registry in
 * src/combat/features.ts reads the answers back off the feature row.
 */
const OPTION_FEATURES: Record<
  string,
  {
    feature: string;
    /** A number, or how many the feature has handed out by this level: Mystic Arcanum grows with the table. */
    choose: number | ((pc: PcState, level: number) => number);
    from: (pc: PcState, level: number) => string[];
    desc: string;
  }
> = {
  'cleric-divine-order': {
    feature: DIVINE_ORDER,
    choose: 1,
    from: () => ['Thaumaturge', 'Protector'],
    desc: 'Thaumaturge: one extra Cleric cantrip and your Wisdom modifier on Arcana and Religion checks. Protector: Martial weapons and Heavy armour training.',
  },
  'druid-primal-order': {
    feature: PRIMAL_ORDER,
    choose: 1,
    from: () => ['Magician', 'Warden'],
    desc: 'Magician: one extra Druid cantrip and your Wisdom modifier on Arcana and Nature checks. Warden: Martial weapons and Medium armour training.',
  },
  'cleric-blessed-strikes': {
    feature: 'Blessed Strikes',
    choose: 1,
    from: () => ['Divine Strike', 'Potent Spellcasting'],
    desc: 'Divine Strike: 1d8 extra Radiant or Necrotic damage on one weapon hit each turn. Potent Spellcasting: your Wisdom modifier on every Cleric cantrip.',
  },
  'druid-elemental-fury': {
    feature: 'Elemental Fury',
    choose: 1,
    from: () => ['Potent Spellcasting', 'Primal Strike'],
    desc: 'Potent Spellcasting: your Wisdom modifier on every Druid cantrip. Primal Strike: 1d8 extra elemental damage on one hit each turn.',
  },
  'wizard-scholar': {
    feature: SCHOLAR,
    choose: 1,
    from: (pc) => SCHOLAR_SKILLS.filter((key) => pc.skills[key]?.proficient && !pc.skills[key]?.expertise),
    desc: 'Expertise in one field of study you are already proficient in.',
  },
  'lore-bonus-proficiencies': {
    feature: BONUS_PROFICIENCIES,
    choose: 3,
    from: (pc) => SKILL_KEYS.filter((key) => !pc.skills[key]?.proficient),
    desc: 'Proficiency with three skills of your choice.',
  },
  'draconic-sorcery-elemental-affinity': {
    feature: ELEMENTAL_AFFINITY,
    choose: 1,
    from: () => ['Acid', 'Cold', 'Fire', 'Lightning', 'Poison'],
    desc: 'The dragon damage type you resist, and add your Charisma modifier to one damage roll of.',
  },
  'lore-magical-discoveries': {
    feature: MAGICAL_DISCOVERIES,
    choose: 2,
    from: (pc, level) => otherListSpells(maxSpellLevelAt('bard', level)).filter((name) => !hasKnownSpell(pc.spells.known, name)),
    desc: 'Two spells from the Cleric, Druid or Wizard list, always prepared.',
  },
  'warlock-mystic-arcanum': {
    feature: MYSTIC_ARCANUM,
    // One at level 11, and another at each of 13, 15 and 17, a spell level higher each time.
    choose: (_pc, level) => arcanumSpellLevels(level).length,
    from: (pc, level) =>
      spellsForClass('warlock', arcanumSpellLevels(level).at(-1) ?? 6).filter(
        (name) => !heldOptions(pc, MYSTIC_ARCANUM).includes(name),
      ),
    desc: 'One Warlock spell of that level, cast once a long rest without a spell slot.',
  },
  'wizard-spell-mastery': {
    feature: SPELL_MASTERY,
    choose: 2,
    from: (pc) => bookSpellsOfLevels(pc, [1, 2]),
    desc: 'A level 1 and a level 2 spell from your spellbook, cast at that level at will with no slot.',
  },
  'wizard-signature-spells': {
    feature: SIGNATURE_SPELLS,
    choose: 2,
    from: (pc) => bookSpellsOfLevels(pc, [3]),
    desc: 'Two level 3 spells from your spellbook, each cast once at level 3 with no slot before a rest.',
  },
};

/** Mystic Arcanum: the spell levels a Warlock of this level has an arcanum of. */
const arcanumSpellLevels = (level: number): number[] => [6, 7, 8, 9].filter((spellLevel) => level >= 11 + (spellLevel - 6) * 2);

/** Spell Mastery and Signature Spells choose out of the spellbook, at the levels each names. */
function bookSpellsOfLevels(pc: PcState, levels: number[]): string[] {
  const book = pc.spells.spellbook ?? pc.spells.known;
  const pool = levels.flatMap((level) => spellsForClass('wizard', level));
  const written = book.filter((name) => pool.some((spell) => spell.toLowerCase() === name.toLowerCase()));
  // A book with nothing of that level would leave the feature unchoosable, so the whole list stands in.
  return written.length > 0 ? written : pool;
}

/** The highest spell level a class can cast at this level, off its own table. */
function maxSpellLevelAt(classIndex: string, level: number): number {
  const slots = classLevelRow(classIndex, level).spellcasting ?? {};
  const levels = Object.keys(slots)
    .map((key) => Number(/^spell_slots_level_(\d+)$/.exec(key)?.[1] ?? 0))
    .filter((at) => at > 0 && (slots[`spell_slots_level_${at}`] ?? 0) > 0);
  return levels.length ? Math.max(...levels) : 0;
}

/** Magical Secrets: from Bard level 10 the new prepared spells may come off three other lists. */
const borrowsSpells = (pc: { class: string | null; features: Feature[] }): boolean =>
  pc.features.some((f) => featureIndexOf(f.name, classIndexOf(pc.class)) === 'bard-magical-secrets');

/** Every Cleric, Druid and Wizard spell up to that level, cantrips included: the Bard's borrowed pool. */
function otherListSpells(maxSpellLevel: number): string[] {
  const out = new Set<string>();
  for (const list of OTHER_LISTS) {
    for (let level = 0; level <= maxSpellLevel; level += 1) {
      for (const name of spellsForClass(list, level)) out.add(name);
    }
  }
  return [...out].sort();
}

/** The choice specs the features of one level row ask for, off the table above. */
function optionFeatureSpecs(pc: PcState, features: srd.Ref[], level: number): FeatureChoiceSpec[] {
  const specs: FeatureChoiceSpec[] = [];
  for (const feature of features) {
    const spec = OPTION_FEATURES[feature.index];
    if (!spec) continue;
    const wanted = typeof spec.choose === 'function' ? spec.choose(pc, level) : spec.choose;
    const held = heldOptions(pc, spec.feature);
    if (held.length >= wanted) continue;
    specs.push({
      feature: spec.feature,
      choose: wanted - held.length,
      from: spec.from(pc, level).filter((option) => !held.includes(option)),
      desc: spec.desc,
    });
  }
  return specs;
}

/** The weapons this character's Weapon Mastery already covers. */
const heldMastery = (pc: { features: Feature[] }): string[] =>
  pc.features.find((f) => f.mechanics?.mastery_weapons)?.mechanics?.mastery_weapons ?? [];

/**
 * How many weapons the class's Weapon Mastery covers at this level: the SRD table carries the column for
 * Barbarians and Fighters, and the other three classes that have the feature choose the two their text names.
 */
function masteryCount(classIndex: string, level: number): number {
  const column = classLevelRow(classIndex, level).class_specific?.weapon_mastery;
  if (typeof column === 'number') return column;
  return classLevelRow(classIndex, 1).features.some((f) => f.name === WEAPON_MASTERY) ? 2 : 0;
}

/** Everything already picked for a feature of this name, across the levels that granted it. */
function heldOptions(pc: { features: Feature[] }, feature: string): string[] {
  return pc.features.filter((f) => f.name === feature).flatMap((f) => f.mechanics?.options ?? []);
}

const fightingStyleNames = (): string[] => srd.feats().filter((f) => f.type === 'fighting-style').map((f) => f.name);

/** The Metamagic options a Sorcerer gains at this level: two at 2, and two more at 10 and at 17. */
const metamagicAtLevel = (level: number): number => ([2, 10, 17].includes(level) ? 2 : 0);

/**
 * The choices the level's own features ask for: Expertise skills, a Fighting Style, Metamagic options and
 * the Eldritch Invocations the Warlock table hands out, each with the pool it must be picked from.
 */
function featureChoiceSpecs(pc: PcState, cls: srd.ClassData, level: number): FeatureChoiceSpec[] {
  const row = classLevelRow(cls.index, level);
  const specs: FeatureChoiceSpec[] = [];
  for (const feature of row.features) {
    if (feature.name === EXPERTISE) {
      const from = SKILL_KEYS.filter((key) => pc.skills[key]?.proficient && !pc.skills[key]?.expertise);
      specs.push({ feature: EXPERTISE, choose: 2, from, desc: 'Two skills you are proficient in double their bonus.' });
    }
    if (feature.name === FIGHTING_STYLE) {
      const held = heldOptions(pc, FIGHTING_STYLE);
      specs.push({
        feature: FIGHTING_STYLE,
        choose: 1,
        from: fightingStyleNames().filter((name) => !held.includes(name)),
        desc: 'One Fighting Style feat.',
      });
    }
    if (feature.name === METAMAGIC) {
      const held = heldOptions(pc, METAMAGIC);
      specs.push({
        feature: METAMAGIC,
        choose: metamagicAtLevel(level),
        from: srd.metamagicOptions().map((o) => o.name).filter((name) => !held.includes(name)),
        desc: 'Ways to bend a spell, paid for with sorcery points.',
      });
    }
  }
  // A subclass feature that is itself a choice: the Hunter's two Hunter's Prey options.
  const subclassRow = subclassLevelRow(chosenSubclass(cls.index, pc.subclass)?.index ?? '', level);
  for (const feature of subclassRow?.features ?? []) {
    if (feature.name !== HUNTERS_PREY) continue;
    specs.push({
      feature: HUNTERS_PREY,
      choose: 1,
      from: HUNTERS_PREY_OPTIONS,
      desc: 'Colossus Slayer adds 1d8 once a turn against a wounded target; Horde Breaker gives one extra attack against a second creature beside the first.',
    });
  }
  // The class and subclass features that are a choice of their own: Divine Order, Blessed Strikes, Scholar.
  specs.push(...optionFeatureSpecs(pc, [...row.features, ...(subclassRow?.features ?? [])], level));
  // 2024: the classes with Weapon Mastery pick the weapons it covers, and the count rises with the table.
  const held = heldMastery(pc);
  const newMastery = masteryCount(cls.index, level) - held.length;
  if (newMastery > 0) {
    specs.push({
      feature: WEAPON_MASTERY,
      choose: newMastery,
      from: masteryWeaponOptions(pc.proficiencies.weapons).filter((name) => !held.includes(name)),
      desc: MASTERY_DESC,
    });
  }
  // The invocation count rises at levels the feature itself is not listed at, so it comes off the table.
  const invocations = (classLevelRow(cls.index, level).class_specific?.eldritch_invocations as number | undefined) ?? 0;
  const heldInvocations = heldOptions(pc, INVOCATIONS);
  const newInvocations = invocations - heldInvocations.length;
  if (newInvocations > 0) {
    specs.push({
      feature: INVOCATIONS,
      choose: newInvocations,
      // The bundled text gates each one by Warlock level, and a few by a Pact taken first.
      from: srd
        .invocations()
        .filter((o) => o.level <= level && !heldInvocations.includes(o.name))
        .filter((o) => !o.requires || heldInvocations.includes(o.requires))
        .map((o) => o.name),
      desc: 'Forbidden knowledge; some invocations need a higher Warlock level, or a Pact taken first.',
    });
  }
  return specs.filter((spec) => spec.choose > 0);
}

/** The same choices as featureChoiceSpecs, for the interview that happens before a sheet exists. */
function levelOneFeatureChoices(cls: srd.ClassData): FeatureChoiceSpec[] {
  const row = classLevelRow(cls.index, 1);
  const specs: FeatureChoiceSpec[] = [];
  for (const feature of row.features) {
    const option = OPTION_FEATURES[feature.index];
    if (option) {
      const blank = { skills: {} } as PcState;
      specs.push({
        feature: option.feature,
        choose: typeof option.choose === 'function' ? option.choose(blank, 1) : option.choose,
        from: option.from(blank, 1),
        desc: option.desc,
      });
    }
    if (feature.name === EXPERTISE) {
      specs.push({ feature: EXPERTISE, choose: 2, from: SKILL_KEYS, desc: 'Two skills you are proficient in double their bonus.' });
    }
    if (feature.name === FIGHTING_STYLE) {
      specs.push({ feature: FIGHTING_STYLE, choose: 1, from: fightingStyleNames(), desc: 'One Fighting Style feat.' });
    }
  }
  const mastery = masteryCount(cls.index, 1);
  if (mastery > 0) {
    specs.push({
      feature: WEAPON_MASTERY,
      choose: mastery,
      from: masteryWeaponOptions(classProficiencies(cls).weapons),
      desc: MASTERY_DESC,
    });
  }
  const invocations = (row.class_specific?.eldritch_invocations as number | undefined) ?? 0;
  if (invocations > 0) {
    specs.push({
      feature: INVOCATIONS,
      choose: invocations,
      from: srd.invocations().filter((o) => o.level <= 1).map((o) => o.name),
      desc: 'Forbidden knowledge; the rest need a higher Warlock level.',
    });
  }
  return specs;
}

/** What the invocations held add to the sheet itself: Thirsting Blade's Extra Attack, and nothing else. */
function invocationMechanics(held: string[]): FeatureMechanics {
  const extra = Math.max(0, ...held.map((name) => srd.findInvocation(name)?.mechanics?.extra_attacks ?? 0));
  return extra > 0 ? { extra_attacks: extra } : {};
}

/** The Fighting Style feat behind a pick, as mechanics the sheet and the engine can read. */
function fightingStyleMechanics(name: string): FeatureMechanics {
  const feat = findFeat(name);
  const mechanics: FeatureMechanics = { fighting_style: feat.name, options: [feat.name] };
  if (feat.index === 'defense') mechanics.ac_bonus = 1;
  if (feat.index === 'archery') mechanics.ranged_attack_bonus = 2;
  return mechanics;
}

/**
 * Applies the picks for the level's choice features, or fills them in from the top of each pool when the
 * player was not asked. Returns one line per feature saying what it now holds.
 */
function applyFeatureChoices(
  pc: PcState,
  specs: FeatureChoiceSpec[],
  picked: Record<string, string[]> | undefined,
): { applied: string[]; chosen_for_you: string[] } {
  const applied: string[] = [];
  const chosenForYou: string[] = [];
  for (const spec of specs) {
    const given = picked?.[spec.feature];
    let picks: string[];
    if (given === undefined) {
      picks = spec.from.slice(0, spec.choose);
      chosenForYou.push(`${spec.feature}: ${picks.join(', ')}`);
    } else {
      picks = given.map((pick) => {
        const match = spec.from.find((option) => option.toLowerCase() === pick.trim().toLowerCase());
        if (!match) throw new Error(`"${pick}" is not an option for ${spec.feature}. Options: ${spec.from.join(', ')}.`);
        return match;
      });
      if (picks.length !== spec.choose || new Set(picks).size !== picks.length) {
        throw new Error(
          `${spec.feature} takes ${spec.choose} different pick(s); got ${picks.length}. Options: ${spec.from.join(', ')}.`,
        );
      }
    }
    if (picks.length === 0) continue;
    if (spec.feature === EXPERTISE) for (const key of picks) pc.skills[key]!.expertise = true;
    // Scholar doubles the proficiency it is spent on; the Lore bard's three picks become proficiencies.
    if (spec.feature === SCHOLAR) for (const key of picks) pc.skills[key]!.expertise = true;
    if (spec.feature === BONUS_PROFICIENCIES) for (const key of picks) pc.skills[key]!.proficient = true;
    // The martial half of Divine Order and Primal Order is training, and training is proficiencies.
    if ((spec.feature === DIVINE_ORDER && picks[0] === 'Protector') || (spec.feature === PRIMAL_ORDER && picks[0] === 'Warden')) {
      const armor = spec.feature === DIVINE_ORDER ? 'Heavy Armor' : 'Medium Armor';
      if (!pc.proficiencies.weapons.includes('Martial Weapons')) pc.proficiencies.weapons.push('Martial Weapons');
      if (!pc.proficiencies.armor.includes(armor)) pc.proficiencies.armor.push(armor);
    }
    // Magical Discoveries and the Bard's borrowed spells are prepared, not counted against the table.
    if (spec.feature === MAGICAL_DISCOVERIES) {
      pc.spells.granted = [...(pc.spells.granted ?? []), ...picks];
      pc.spells.prepared.push(...picks);
    }
    const entry = pc.features.find((f) => f.name === spec.feature && !f.mechanics?.options);
    const mechanics: FeatureMechanics =
      spec.feature === FIGHTING_STYLE
        ? fightingStyleMechanics(picks[0]!)
        : spec.feature === WEAPON_MASTERY
          ? { mastery_weapons: [...heldMastery(pc), ...picks] }
          : spec.feature === INVOCATIONS
            ? { options: picks, ...invocationMechanics([...heldOptions(pc, INVOCATIONS), ...picks]) }
            : { options: picks };
    if (entry) entry.mechanics = { ...entry.mechanics, ...mechanics };
    else pc.features.push({ name: spec.feature, source: 'class', text: `${spec.desc} Chosen: ${picks.join(', ')}.`, mechanics });
    applied.push(`${spec.feature}: ${picks.join(', ')}`);
  }
  return { applied, chosen_for_you: chosenForYou };
}

// --- feats, and what they actually do -----------------------------------------

export interface FeatChoices {
  /** The single ability a feat raises by 1 (Grappler, an Epic Boon). */
  ability?: Ability;
  /** The Ability Score Improvement feat's own +2 or +1/+1. */
  ability_increases?: Partial<Record<Ability, number>>;
  skills?: string[];
  tools?: string[];
  languages?: string[];
  /** Magic Initiate: which list the spells come from, and what they are. */
  spell_list?: string;
  spellcasting_ability?: 'int' | 'wis' | 'cha';
  cantrips?: string[];
  spell?: string;
}

const MAGIC_INITIATE_LISTS = ['cleric', 'druid', 'wizard'];
const SKILLED_PICKS = 3;

/** What a feat still needs from the player before it can be granted. */
export function featChoiceSpec(feat: srd.FeatData): Record<string, unknown> | null {
  if (feat.index === 'ability-score-improvement') {
    return { ability_increases: `+2 to one ability or +1 to two, to a maximum of ${ABILITY_MAX}.` };
  }
  if (feat.index === 'grappler') return { ability: ['str', 'dex'] };
  if (feat.type === 'epic-boon') return { ability: [...ABILITIES], note: `An Epic Boon may raise a score to ${EPIC_ABILITY_MAX}.` };
  if (feat.index === 'skilled') return { skills_or_tools: `Any ${SKILLED_PICKS} skills or tools, as skills and tools.` };
  if (feat.index === 'magic-initiate') {
    return {
      spell_list: MAGIC_INITIATE_LISTS,
      spellcasting_ability: ['int', 'wis', 'cha'],
      cantrips: 2,
      spell: 'One level 1 spell from the same list, castable once per Long Rest without a slot.',
    };
  }
  return null;
}

/** Raises a score, refusing the increase the rules do not allow rather than silently capping it. */
function raiseAbility(pc: PcState, ability: Ability, amount: number, max: number): void {
  const after = pc.abilities[ability].score + amount;
  if (after > max) {
    throw new Error(
      max === ABILITY_MAX
        ? `${ability.toUpperCase()} is ${pc.abilities[ability].score} and this would make it ${after}: "This feat can't increase an ability score above ${ABILITY_MAX}." Raise another score instead.`
        : `${ability.toUpperCase()} cannot go above ${max}.`,
    );
  }
  pc.abilities[ability].score = after;
}

function requireAbilityPick(feat: srd.FeatData, choices: FeatChoices, allowed: Ability[]): Ability {
  const ability = choices.ability;
  if (!ability || !allowed.includes(ability)) {
    throw new Error(`${feat.name} raises an ability score by 1: pass feat_choices.ability as one of ${allowed.join(', ')}.`);
  }
  return ability;
}

/** The damage types a trait or feature says it resists, lowercased as the engine compares them. */
function resistancesFromText(text: string): string[] | undefined {
  const match = /You have Resistance to ([^.]+?) damage/i.exec(text);
  if (!match) return undefined;
  const types = match[1]!
    .split(/,| and /i)
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  return types.length ? types : undefined;
}

/** The numbers a species trait carries: Dwarven Toughness's hit points, a resistance, a walking speed. */
function speciesTraitMechanics(trait: srd.TraitData): FeatureMechanics | undefined {
  const mechanics: FeatureMechanics = {};
  const hp = hpPerLevelFromText(trait.description);
  if (hp) mechanics.hp_per_level = hp;
  if (trait.speed) mechanics.speed = { walk: trait.speed };
  const resistances = resistancesFromText(trait.description);
  if (resistances) mechanics.resistances = resistances;
  return Object.keys(mechanics).length ? mechanics : undefined;
}

/** Numbers hidden in a feat's or trait's prose: the hit points a "+1 per level" line promises. */
function hpPerLevelFromText(text: string): number | undefined {
  const match = /Hit Point maximum increases by (\d+)/i.exec(text);
  return match && /whenever you gain a level|when you gain a level|each level/i.test(text) ? Number(match[1]) : undefined;
}

/**
 * Puts a feat on the sheet with its mechanics applied: ability increases against the right cap, the
 * proficiencies it grants, the spells it teaches and the numbers the engine reads later.
 */
function applyFeat(
  db: Db,
  pc: PcState,
  feat: srd.FeatData,
  choices: FeatChoices | undefined,
  campaignId: number,
): string[] {
  const picked = choices ?? {};
  const notes: string[] = [];
  const mechanics: FeatureMechanics = {};

  if (feat.index === 'ability-score-improvement') {
    const increases = picked.ability_increases ?? {};
    const total = ABILITIES.reduce((sum, a) => sum + (increases[a] ?? 0), 0);
    if (total !== 2 || ABILITIES.some((a) => (increases[a] ?? 0) < 0 || (increases[a] ?? 0) > 2)) {
      throw new Error('An Ability Score Improvement raises one score by 2 or two scores by 1.');
    }
    for (const ability of ABILITIES) {
      if (!increases[ability]) continue;
      raiseAbility(pc, ability, increases[ability]!, ABILITY_MAX);
      notes.push(`${ability.toUpperCase()} +${increases[ability]}`);
    }
  } else if (feat.index === 'grappler') {
    const ability = requireAbilityPick(feat, picked, ['str', 'dex']);
    raiseAbility(pc, ability, 1, ABILITY_MAX);
    notes.push(`${ability.toUpperCase()} +1`);
  } else if (feat.type === 'epic-boon') {
    const ability = requireAbilityPick(feat, picked, [...ABILITIES]);
    raiseAbility(pc, ability, 1, EPIC_ABILITY_MAX);
    // Boon of Irresistible Offense deals extra damage equal to the score it raised, so the pick is kept.
    mechanics.options = [ability];
    notes.push(`${ability.toUpperCase()} +1 (Epic Boon, maximum ${EPIC_ABILITY_MAX})`);
  } else if (feat.index === 'skilled') {
    const skills = (picked.skills ?? []).map(normalizeSkill);
    const tools = picked.tools ?? [];
    if (skills.length + tools.length !== SKILLED_PICKS) {
      throw new Error(
        `${feat.name} grants ${SKILLED_PICKS} proficiencies: pass feat_choices.skills and feat_choices.tools adding up to ${SKILLED_PICKS}.`,
      );
    }
    for (const key of skills) {
      pc.skills[key]!.proficient = true;
      notes.push(key);
    }
    for (const tool of tools) {
      if (!hasTool(pc, tool)) pc.proficiencies.tools.push(tool);
      notes.push(tool);
    }
  } else if (feat.index === 'magic-initiate') {
    notes.push(...applyMagicInitiate(db, pc, picked, campaignId));
  } else if (feat.index === 'alert') {
    mechanics.initiative_proficiency = true;
    notes.push('proficiency bonus on Initiative');
  } else if (feat.type === 'fighting-style') {
    Object.assign(mechanics, fightingStyleMechanics(feat.name));
  }

  const hpPerLevel = hpPerLevelFromText(feat.description);
  if (hpPerLevel) {
    mechanics.hp_per_level = hpPerLevel;
    pc.hp_max += hpPerLevel * pc.level;
    pc.hp_current += hpPerLevel * pc.level;
    notes.push(`+${hpPerLevel} HP per level`);
  }
  for (const name of picked.languages ?? []) {
    const language = resolveLanguage(db, campaignId, name);
    if (!pc.proficiencies.languages.includes(language)) pc.proficiencies.languages.push(language);
    notes.push(language);
  }

  pc.features.push({
    name: feat.name,
    source: 'feat',
    text: feat.description,
    ...(Object.keys(mechanics).length ? { mechanics } : {}),
  });
  return notes;
}

interface ScorePrerequisite {
  option_type: string;
  ability_score?: { index: string };
  minimum_score?: number;
}

/** Refuses a feat whose listed prerequisite the character does not meet, quoting what it asks for. */
function assertFeatPrerequisites(pc: PcState, feat: srd.FeatData): void {
  const held = feat.prerequisites?.feature_named;
  if (held && !pc.features.some((f) => f.name.toLowerCase() === held.toLowerCase())) {
    throw new Error(`"${feat.name}" needs the ${held} feature, which ${pc.name} does not have.`);
  }
  const options = (feat.prerequisite_options as { desc?: string; from?: { options?: ScorePrerequisite[] } } | undefined)
    ?.from?.options;
  if (!options?.length) return;
  const met = options.some((option) => {
    const ability = option.ability_score?.index as Ability | undefined;
    return ability ? pc.abilities[ability].score >= (option.minimum_score ?? 0) : false;
  });
  if (!met) {
    throw new Error(`"${feat.name}" requires ${feat.prerequisite_options?.desc ?? 'a prerequisite'}, which ${pc.name} does not meet.`);
  }
}

/**
 * The picks a feat granted at creation needs, when the interview did not ask: the list the background
 * names for Magic Initiate, the first legal spells on it, the ability the class already casts with.
 */
function fillFeatChoices(pc: PcState, feat: srd.FeatData, note: string | undefined, given: FeatChoices | undefined): FeatChoices {
  const choices: FeatChoices = { ...(given ?? {}) };
  if (feat.index === 'magic-initiate') {
    const fromNote = (note ?? '').trim().toLowerCase();
    choices.spell_list =
      choices.spell_list ??
      (MAGIC_INITIATE_LISTS.includes(fromNote)
        ? fromNote
        : MAGIC_INITIATE_LISTS.includes(classOf(pc))
          ? classOf(pc)
          : 'wizard');
    const byList: Record<string, 'int' | 'wis' | 'cha'> = { cleric: 'wis', druid: 'wis', wizard: 'int' };
    choices.spellcasting_ability = choices.spellcasting_ability ?? pc.spells.spellcasting_ability ?? byList[choices.spell_list]!;
    choices.cantrips =
      choices.cantrips ??
      spellsForClass(choices.spell_list, 0)
        .filter((name) => !hasKnownSpell(pc.spells.cantrips, name))
        .slice(0, 2);
    choices.spell =
      choices.spell ??
      spellsForClass(choices.spell_list, 1).find((name) => !hasKnownSpell(pc.spells.prepared, name));
  }
  if (feat.index === 'skilled' && !choices.skills && !choices.tools) {
    choices.skills = SKILL_KEYS.filter((key) => !pc.skills[key]?.proficient).slice(0, SKILLED_PICKS);
  }
  if ((feat.index === 'grappler' || feat.type === 'epic-boon') && !choices.ability) {
    choices.ability = feat.index === 'grappler' ? 'str' : 'con';
  }
  return choices;
}

/** Magic Initiate: two cantrips and a level 1 spell from one list, the spell free once per Long Rest. */
function applyMagicInitiate(db: Db, pc: PcState, choices: FeatChoices, campaignId: number): string[] {
  const list = (choices.spell_list ?? '').trim().toLowerCase();
  if (!MAGIC_INITIATE_LISTS.includes(list)) {
    throw new Error(`Magic Initiate draws on one list: pass feat_choices.spell_list as ${MAGIC_INITIATE_LISTS.join(', ')}.`);
  }
  const ability = choices.spellcasting_ability;
  if (!ability || !['int', 'wis', 'cha'].includes(ability)) {
    throw new Error('Magic Initiate needs feat_choices.spellcasting_ability: int, wis or cha.');
  }
  const cantrips = choices.cantrips ?? [];
  const spell = choices.spell;
  const listName = `${list[0]!.toUpperCase()}${list.slice(1)}`;
  validateSpellPicks(list, listName, cantrips, 0, 2, 'cantrips');
  if (!spell) {
    throw new Error(`Magic Initiate also takes one level 1 ${listName} spell: pass feat_choices.spell. Options: ${spellsForClass(list, 1).join(', ')}.`);
  }
  validateSpellPicks(list, listName, [spell], 1, 1, 'level 1 spells');
  const granted = pc.spells.granted ?? [];
  for (const cantrip of cantrips) {
    if (!hasKnownSpell(pc.spells.cantrips, cantrip)) pc.spells.cantrips.push(cantrip);
    granted.push(cantrip);
  }
  if (!hasKnownSpell(pc.spells.prepared, spell)) pc.spells.prepared.push(spell);
  granted.push(spell);
  pc.spells.granted = granted;
  if (!pc.spells.spellcasting_ability) pc.spells.spellcasting_ability = ability;
  pc.features.push({
    name: `Magic Initiate: ${spell}`,
    source: 'feat',
    text: `${spell} is always prepared and can be cast once without a slot; the free cast returns after a Long Rest.`,
    mechanics: { resource: `magic_initiate_${list}`, max: 1, per: 'long', used: 0, spellcasting_ability: ability },
  });
  logEvent(db, {
    campaign_id: campaignId,
    kind: 'feature',
    text: `${pc.name} learns ${[...cantrips, spell].join(', ')} from Magic Initiate (${list}).`,
    payload: { feat: 'Magic Initiate', list, cantrips, spell },
  });
  return [...cantrips, spell];
}

function normalizeSkill(value: string): string {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!SKILL_KEYS.includes(key)) {
    throw new Error(`"${value}" is not a skill. Valid skills: ${SKILL_KEYS.join(', ')}.`);
  }
  return key;
}

/** Matches the player's picks to the class/species skill-choice groups, smallest list first. */
function assignSkillChoices(groups: ReturnType<typeof skillChoiceGroups>, picks: string[]): string[] {
  const total = groups.reduce((sum, g) => sum + g.choose, 0);
  const chosen = picks.map(normalizeSkill);
  if (new Set(chosen).size !== chosen.length) throw new Error('Each skill can only be chosen once.');
  if (chosen.length !== total) {
    const detail = groups.map((g) => `${g.choose} of [${g.from.join(', ')}]`).join('; ');
    throw new Error(`This character chooses ${total} skill proficiencies: ${detail}. Got ${chosen.length}.`);
  }
  const remaining = [...chosen];
  for (const group of [...groups].sort((a, b) => a.from.length - b.from.length)) {
    const taken: string[] = [];
    for (const skill of [...remaining]) {
      if (taken.length === group.choose) break;
      if (group.from.includes(skill)) {
        taken.push(skill);
        remaining.splice(remaining.indexOf(skill), 1);
      }
    }
    if (taken.length !== group.choose) {
      throw new Error(`Choose ${group.choose} from [${group.from.join(', ')}] (${group.desc}).`);
    }
  }
  return chosen;
}

/**
 * The "choose one from this category" lines of the chosen bundles, answered in order. Nothing passed
 * takes the first option of each, and the answer says which.
 */
function resolveEquipmentPicks(
  picks: EquipmentPick[],
  chosen: string[] | undefined,
): { items: Array<{ name: string; qty: number }>; chosen_for_you: string[] } {
  const total = picks.reduce((sum, pick) => sum + pick.choose, 0);
  if (total === 0) {
    if (chosen?.length) throw new Error('This equipment has nothing to choose from; leave equipment_picks out.');
    return { items: [], chosen_for_you: [] };
  }
  if (chosen !== undefined && chosen.length !== total) {
    const detail = picks.map((p) => `${p.choose} of [${p.options.join(', ')}]`).join('; ');
    throw new Error(`This equipment needs ${total} pick(s): ${detail}. Got ${chosen.length}.`);
  }
  const items: Array<{ name: string; qty: number }> = [];
  const filled: string[] = [];
  let at = 0;
  for (const pick of picks) {
    for (let i = 0; i < pick.choose; i += 1) {
      const wanted = chosen?.[at];
      at += 1;
      if (wanted === undefined) {
        const fallback = pick.options[0];
        if (!fallback) continue;
        items.push({ name: fallback, qty: 1 });
        filled.push(fallback);
        continue;
      }
      const match = pick.options.find((option: string) => option.toLowerCase() === wanted.trim().toLowerCase());
      if (!match) throw new Error(`"${wanted}" is not one of [${pick.options.join(', ')}] (${pick.desc}).`);
      items.push({ name: match, qty: 1 });
    }
  }
  return { items, chosen_for_you: filled };
}

function bundleFor(bundles: EquipmentBundle[], choice: string | number | undefined, what: string): EquipmentBundle {
  if (bundles.length === 0) throw new Error(`No SRD starting equipment for ${what}.`);
  if (choice === undefined) return bundles[0]!;
  const key = String(choice).trim().toLowerCase();
  const byLabel = bundles.find((b) => b.label === key);
  const byNumber = /^\d+$/.test(key) ? bundles[Number(key) - 1] : undefined;
  const found = byLabel ?? byNumber;
  if (!found) {
    throw new Error(
      `Unknown equipment choice "${choice}" for ${what}. Options: ${bundles
        .map((b) => `${b.label}) ${b.items.map((i) => `${i.qty}x ${i.name}`).join(', ')}${b.gold ? ` + ${b.gold} gp` : ''}`)
        .join(' | ')}`,
    );
  }
  return found;
}

function validateSpellPicks(
  classIndex: string,
  className: string,
  picks: string[],
  spellLevel: number,
  expected: number,
  what: string,
  /** Names the SRD does not have but the campaign does: the custom spells of that level. */
  extra: string[] = [],
): void {
  const valid = [...spellsForClass(classIndex, spellLevel), ...extra];
  if (picks.length !== expected) {
    throw new Error(
      `A level-appropriate ${className} picks ${expected} ${what}; got ${picks.length}. Valid options: ${valid.join(', ')}.`,
    );
  }
  for (const name of picks) {
    if (extra.some((option) => option.toLowerCase() === name.trim().toLowerCase())) continue;
    const spell = findSpell(name);
    if (!spell || spell.level !== spellLevel || !spell.classes.some((c) => c.endsWith(`_${classIndex}`))) {
      throw new Error(`"${name}" is not a ${className} ${what.replace(/s$/, '')}. Valid options: ${valid.join(', ')}.`);
    }
  }
}

/** The 2024 Spellbook feature: six level 1 spells, four of which the Wizard has prepared. */
const WIZARD_STARTING_SPELLBOOK = 6;

/**
 * A Wizard's opening spellbook. The player's six picks must hold their prepared spells; without picks
 * the extra pages are filled from the class list and the answer says which were chosen for them.
 */
function wizardSpellbook(
  prepared: string[],
  picks: string[] | undefined,
): { spellbook: string[]; chosen_for_you: string[] | null } {
  if (!picks?.length) {
    const extras = spellsForClass('wizard', 1)
      .filter((name) => !hasKnownSpell(prepared, name))
      .slice(0, WIZARD_STARTING_SPELLBOOK - prepared.length);
    return { spellbook: [...prepared, ...extras], chosen_for_you: extras };
  }
  validateSpellPicks('wizard', 'Wizard', picks, 1, WIZARD_STARTING_SPELLBOOK, 'spellbook spells');
  assertSpellsNotAlreadyKnown(picks, []);
  for (const name of prepared) {
    if (!hasKnownSpell(picks, name)) {
      throw new Error(`The spellbook must hold every prepared spell; "${name}" is not written in it.`);
    }
  }
  return { spellbook: [...picks], chosen_for_you: null };
}

/** How many of a list the class table has to pay for: a feat's spells are free of it. */
function classSpellCount(list: string[], granted: string[] | undefined): number {
  if (!granted?.length) return list.length;
  return list.filter((name) => !granted.some((g) => g.toLowerCase() === name.trim().toLowerCase())).length;
}

/** Whether a spell name (case-insensitive) is already on this list. */
function hasKnownSpell(known: string[], name: string): boolean {
  return known.some((k) => k.toLowerCase() === name.trim().toLowerCase());
}

/** A spell list with case-insensitive duplicates dropped; the first occurrence's spelling is kept. */
function uniqueSpells(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Refuses a spell repeated within the picks themselves or already on the sheet. */
function assertSpellsNotAlreadyKnown(picks: string[], known: string[]): void {
  const chosen = new Set<string>();
  for (const name of picks) {
    const key = name.trim().toLowerCase();
    if (chosen.has(key) || known.some((k) => k.toLowerCase() === key)) {
      throw new Error(`"${name}" is already known; pick a different spell.`);
    }
    chosen.add(key);
  }
}

/** Every spell the class can prepare at this point, grouped by spell level. */
function spellOptionsByLevel(classIndex: string, maxSpellLevel: number): Record<string, string[]> {
  return Object.fromEntries(
    Array.from({ length: maxSpellLevel }, (_, i) => [String(i + 1), spellsForClass(classIndex, i + 1)]),
  );
}

/** The SRD spells of one level with the campaign's and the library's custom ones beside them. */
function withCustomSpells(db: Db, campaignId: number, className: string, level: number, names: string[]): string[] {
  const custom = customSpells(db, campaignId, className, level).map((entry) => entry.name);
  return custom.length > 0 ? [...names, ...custom] : names;
}

/** spellOptionsByLevel with the custom spells of each level added to it. */
function customSpellOptions(
  db: Db,
  campaignId: number,
  cls: srd.ClassData,
  maxSpellLevel: number,
): Record<string, string[]> {
  const byLevel = spellOptionsByLevel(cls.index, maxSpellLevel);
  for (const level of Object.keys(byLevel)) {
    byLevel[level] = withCustomSpells(db, campaignId, cls.name, Number(level), byLevel[level]!);
  }
  return byLevel;
}

/** A spell the DM wrote that this class may take at this level, or nothing when there is none. */
function eligibleCustomSpell(
  db: Db,
  campaignId: number,
  className: string,
  name: string,
  levels: { min: number; max: number },
): SpellSchema | undefined {
  const entry = findHomebrewSpell(db, campaignId, name);
  if (!entry) return undefined;
  const schema = entry.schema as Partial<SpellSchema>;
  const level = schema.level ?? -1;
  if (level < levels.min || level > levels.max || !spellFitsClass(schema, className)) return undefined;
  return schema as SpellSchema;
}

function slotsFromRow(spellcasting: Record<string, number> | undefined, previous: SpellSlots = {}): SpellSlots {
  const slots: SpellSlots = {};
  for (let level = 1; level <= 9; level += 1) {
    const max = spellcasting?.[`spell_slots_level_${level}`] ?? 0;
    const bonus = previous[String(level)]?.bonus ?? 0;
    if (max > 0) {
      slots[String(level)] = { max, used: Math.min(previous[String(level)]?.used ?? 0, max), ...(bonus > 0 ? { bonus } : {}) };
    }
  }
  return slots;
}

export interface CreateCharacterInput {
  campaign_id: number;
  name: string;
  species: string;
  /** Which lineage of the species: required for the five that have one, ignored by the rest. */
  lineage?: string;
  class: string;
  background: string;
  ability_method: 'standard_array' | 'point_buy' | 'manual';
  abilities: AbilityScores;
  ability_bonuses: Partial<AbilityScores>;
  skill_choices?: string[];
  /** The two languages beyond Common; left out they are filled in from the species and reported back. */
  languages?: string[];
  /** The class's tool proficiency choices, e.g. a Bard's three instruments. */
  tools?: string[];
  /** Picks for the level 1 features that are themselves a choice: Expertise, Fighting Style, invocations. */
  feature_options?: Record<string, string[]>;
  /** What the background's origin feat asks for, e.g. Magic Initiate's spells. */
  feat_choices?: FeatChoices;
  equipment_choice?: string | number;
  /** Which background bundle: the kit or the gold. */
  background_equipment_choice?: string | number;
  /** One name per "choose from this category" line in the chosen bundles, class first. */
  equipment_picks?: string[];
  cantrips?: string[];
  spells?: string[];
  /** A Wizard's opening spellbook: six level 1 spells, the prepared picks among them. */
  spellbook?: string[];
  alignment?: string;
  backstory?: string;
  /** How they look, in two or three sentences; the DM writes it when finishing a wizard draft. */
  appearance?: string;
  is_pc?: boolean;
  role?: CharacterRole;
}

/** A background as character creation needs it, whether it comes from the SRD or the DM wrote it. */
interface BackgroundPick {
  name: string;
  abilities: string[];
  skills: string[];
  tools: string[];
  feat: { name: string; text: string; index?: string; note?: string; homebrew_id?: number; over_budget?: boolean };
  items: Array<{ name: string; qty: number; notes?: string }>;
  gold: number;
  picks: EquipmentPick[];
}

/** Custom backgrounds win over the SRD list, so a campaign may replace one by name. */
function resolveBackground(db: Db, campaignId: number, name: string, choice?: string | number): BackgroundPick {
  const custom = findHomebrewBackground(db, campaignId, name);
  if (custom) {
    const schema = custom.schema as unknown as BackgroundSchema;
    const srdFeat = typeof schema.origin_feat === 'string' ? findFeat(schema.origin_feat) : null;
    return {
      name: custom.name,
      abilities: schema.abilities,
      skills: schema.skills,
      tools: [schema.tool],
      feat: srdFeat
        ? { name: srdFeat.name, text: srdFeat.description }
        : {
            name: (schema.origin_feat as { name: string }).name,
            text: (schema.origin_feat as { text: string }).text,
            homebrew_id: custom.id,
            ...(custom.power_label === 'over_budget' ? { over_budget: true } : {}),
          },
      items: schema.equipment.items,
      gold: schema.equipment.gold,
      picks: [],
    };
  }
  const data = (() => {
    try {
      return findBackground(name);
    } catch {
      // A companion or PC may come from a background the DM wrote; the refusal should say so.
      const customNames = listHomebrew(db, campaignId, 'background').map((entry) => entry.name);
      throw new Error(
        `Unknown background "${name}". Valid options: ${[
          ...srd.backgrounds().map((b) => b.name),
          ...customNames,
        ].join(', ')}.`,
      );
    }
  })();
  const bundle = bundleFor(equipmentBundles(data.equipment_options?.[0]), choice, `the ${data.name} background`);
  const feat = findFeat(data.feat.name);
  return {
    name: data.name,
    abilities: data.ability_scores.map((a) => a.index),
    skills: data.proficiencies.filter((p) => p.index.startsWith('skill-')).map((p) => skillKey(p.index)),
    tools: data.proficiencies.filter((p) => p.index.startsWith('tool-')).map((p) => p.name.replace('Tool: ', '')),
    feat: {
      name: data.feat.note ? `${feat.name} (${data.feat.note})` : feat.name,
      text: feat.description,
      index: feat.index,
      note: data.feat.note,
    },
    items: bundle?.items ?? [],
    gold: bundle?.gold ?? 0,
    picks: bundle?.picks ?? [],
  };
}

/** The lineage the player chose, checked against the ones the species offers; null when it offers none. */
function resolveLineage(species: srd.SpeciesData, wanted: string | undefined): string | null {
  const lineages = speciesLineages(species);
  if (lineages.length === 0) return null;
  const asked = (wanted ?? '').trim();
  if (!asked) throw new Error(`lineage required for ${species.name}: ${lineages.join(', ')}`);
  const found = findLineage(species, asked);
  if (!found) throw new Error(`unknown lineage "${asked}" for ${species.name}: ${lineages.join(', ')}`);
  return found.name;
}

export function createCharacter(db: Db, input: CreateCharacterInput) {
  const cls = findClass(input.class);
  const species = findSpecies(input.species);
  const lineage = resolveLineage(species, input.lineage);
  const background = resolveBackground(db, input.campaign_id, input.background, input.background_equipment_choice);
  const isPc = input.is_pc !== false;
  const role: CharacterRole = input.role ?? (isPc ? 'pc' : 'npc');

  validateAbilities(input.ability_method, input.abilities);
  const scores: AbilityScores = { ...input.abilities };
  const bonuses = input.ability_bonuses;
  const bonusTotal = ABILITIES.reduce((sum, a) => sum + (bonuses[a] ?? 0), 0);
  const allowed = background.abilities;
  const pattern = ABILITIES.map((a) => bonuses[a] ?? 0).filter((v) => v > 0).sort((a, b) => b - a).join(',');
  for (const ability of ABILITIES) {
    if ((bonuses[ability] ?? 0) > 0 && !allowed.includes(ability)) {
      throw new Error(`The ${background.name} background raises only ${allowed.join(', ')}.`);
    }
  }
  if (bonusTotal !== 3 || (pattern !== '2,1' && pattern !== '1,1,1')) {
    throw new Error(
      `The ${background.name} background must raise its abilities (${allowed.join(', ')}) by +2 and +1, or by +1 each.`,
    );
  }
  for (const ability of ABILITIES) scores[ability] += bonuses[ability] ?? 0;

  const abilities = Object.fromEntries(
    ABILITIES.map((a) => [a, { score: scores[a], mod: abilityMod(scores[a]) }]),
  ) as Record<Ability, AbilityEntry>;

  const saves = Object.fromEntries(
    ABILITIES.map((a) => [a, { proficient: cls.saving_throws.some((s) => s.index === a), bonus: 0 }]),
  ) as Record<Ability, SaveEntry>;

  const skills = Object.fromEntries(
    SKILL_KEYS.map((key) => [key, { ability: SKILL_ABILITY[key]!, proficient: false, expertise: false, bonus: 0 }]),
  ) as Record<string, SkillEntry>;

  const proficiencies = classProficiencies(cls);
  for (const key of background.skills) skills[key]!.proficient = true;
  proficiencies.tools.push(...background.tools);
  for (const key of assignSkillChoices(skillChoiceGroups(cls, species), input.skill_choices ?? [])) {
    skills[key]!.proficient = true;
  }
  const languages = resolveLanguageChoices(db, input.campaign_id, species.index, input.languages);
  proficiencies.languages = languages.languages;
  const tools = resolveToolChoices(cls, input.tools);
  for (const tool of tools.tools) if (!proficiencies.tools.some((t) => toolKey(t) === toolKey(tool))) proficiencies.tools.push(tool);

  const features: Feature[] = [];
  for (const feature of classLevelRow(cls.index, 1).features) {
    features.push({ name: feature.name, source: 'class', text: featureText(feature.index) });
  }
  let speed = species.speed;
  let hpPerLevel = 0;
  // The first species trait carries the size, so a sheet reader finds it without the species table.
  let sizeMechanics: FeatureMechanics | null = { size: species.size ?? 'Medium' };
  for (const trait of speciesTraitsFor(species, lineage)) {
    // An older sheet has no lineage: every lineage's traits are listed, and none of their numbers count.
    const numeric = lineage === null && trait.subspecies?.length ? undefined : speciesTraitMechanics(trait);
    if (numeric?.hp_per_level) hpPerLevel += numeric.hp_per_level;
    if (numeric?.speed?.walk) speed = numeric.speed.walk;
    const mechanics = { ...(sizeMechanics ?? {}), ...(numeric ?? {}) };
    sizeMechanics = null;
    features.push({
      name: trait.name,
      source: 'species',
      text: trait.description,
      ...(Object.keys(mechanics).length ? { mechanics } : {}),
    });
  }


  const levelRow = classLevelRow(cls.index, 1);
  const spells: SpellsJson = {
    spellcasting_ability: null,
    cantrips: [],
    known: [],
    prepared: [],
    save_dc: null,
    attack_bonus: null,
  };
  let slots: SpellSlots = {};
  let spellbookChosen: string[] | null = null;
  if (cls.index !== 'wizard' && input.spellbook?.length) {
    throw new Error(`Only a Wizard keeps a spellbook; a ${cls.name} does not.`);
  }
  if (cls.spellcasting) {
    const ability = cls.spellcasting.spellcasting_ability.index as 'int' | 'wis' | 'cha';
    const cantripCount = levelRow.spellcasting?.cantrips_known ?? 0;
    const preparedCount = levelRow.spellcasting?.prepared_spells ?? 0;
    validateSpellPicks(cls.index, cls.name, input.cantrips ?? [], 0, cantripCount, 'cantrips');
    validateSpellPicks(cls.index, cls.name, input.spells ?? [], 1, preparedCount, 'level 1 spells');
    spells.spellcasting_ability = ability;
    spells.cantrips = uniqueSpells(input.cantrips ?? []);
    spells.known = uniqueSpells(input.spells ?? []);
    spells.prepared = uniqueSpells(input.spells ?? []);
    // A Wizard's book opens with six level 1 spells; the prepared list is the four drawn from it.
    if (cls.index === 'wizard') {
      const book = wizardSpellbook(spells.prepared, input.spellbook);
      spells.spellbook = book.spellbook;
      spellbookChosen = book.chosen_for_you;
    }
    slots = slotsFromRow(levelRow.spellcasting);
  } else if ((input.cantrips?.length ?? 0) + (input.spells?.length ?? 0) > 0) {
    throw new Error(`${cls.name} has no spellcasting at level 1; leave cantrips and spells empty.`);
  }

  const classBundle = bundleFor(equipmentBundles(cls.starting_equipment_options?.[0]), input.equipment_choice, cls.name);
  const picked = resolveEquipmentPicks([...classBundle.picks, ...background.picks], input.equipment_picks);
  const inventory: InventoryItem[] = [];
  for (const item of [...classBundle.items, ...picked.items, ...background.items]) {
    const existing = inventory.find((i) => i.name === item.name);
    if (existing) existing.qty += item.qty;
    else inventory.push({ ...item });
  }
  for (const item of inventory) {
    const data = findEquipment(item.name);
    if (data?.weight !== undefined) item.weight_lb = data.weight;
    if (data?.armor_class) item.equipped = true;
    if (data?.contents?.length) item.notes = data.contents.map((c) => `${c.quantity}x ${c.item.name}`).join(', ');
  }
  const gold = classBundle.gold + background.gold;

  const conMod = abilities.con.mod;
  const hpMax = cls.hit_die + conMod + hpPerLevel;

  const pc: PcState = {
    id: 0,
    campaign_id: input.campaign_id,
    name: input.name,
    is_pc: isPc,
    role,
    species: species.name,
    lineage,
    class: cls.name,
    background: background.name,
    subclass: null,
    subclass_homebrew_id: null,
    level: 1,
    xp: 0,
    hp_current: hpMax,
    hp_max: hpMax,
    temp_hp: 0,
    ac: 10,
    speed,
    exhaustion: 0,
    gold,
    coins: { ...emptyCoins(), gp: gold },
    inspiration: 0,
    // A companion in play is 'active' like the PC; a plain NPC stays out of the party as 'npc'.
    status: role === 'npc' ? 'npc' : 'active',
    abilities,
    saves,
    skills,
    proficiencies,
    features,
    spells,
    spell_slots: slots,
    inventory,
    conditions: [],
    death_saves: { successes: 0, failures: 0 },
    stable: false,
    hit_dice: { die: `d${cls.hit_die}`, max: 1, used: 0 },
    appearance: input.appearance ?? null,
  };
  for (const resource of resourceFeatures(pc, levelRow, undefined)) placeResourceFeature(pc, resource);
  const featureChoices = applyFeatureChoices(pc, featureChoiceSpecs(pc, cls, 1), input.feature_options);
  // The origin feat the background hands out is applied like any other, its choices filled in if unasked.
  const originFeat = background.feat.index ? findFeat(background.feat.index) : null;
  const featNotes = originFeat
    ? applyFeat(db, pc, originFeat, fillFeatChoices(pc, originFeat, background.feat.note, input.feat_choices), input.campaign_id)
    : (pc.features.push(
        background.feat.homebrew_id !== undefined
          ? {
              name: background.feat.name,
              source: 'feat',
              text: background.feat.text,
              mechanics: {
                homebrew_id: background.feat.homebrew_id,
                ...(background.feat.over_budget ? { over_budget: true } : {}),
              },
            }
          : { name: background.feat.name, source: 'feat', text: background.feat.text },
      ),
      []);
  recompute(pc);

  const created = db.transaction(() => {
    let retired: string | null = null;
    if (isPc) {
      const previous = db
        .prepare("SELECT id, name FROM character WHERE campaign_id = ? AND is_pc = 1 AND status = 'active'")
        .all(input.campaign_id) as Array<{ id: number; name: string }>;
      for (const row of previous) {
        db.prepare("UPDATE character SET status = 'retired', updated_at = ? WHERE id = ?").run(nowIso(), row.id);
        retired = row.name;
      }
    }
    const ts = nowIso();
    const id = insertCharacter(db, pc);
    // The wizard's half-filled character has been finished: the briefing stops asking for it.
    if (isPc) setCharacterDraft(db, input.campaign_id, null);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'character',
      text: `${pc.name} the ${pc.species} ${pc.class} (${background.name}) joins the story: ${pc.hp_max} HP, AC ${pc.ac}.`,
      payload: { character_id: id, retired_previous: retired },
    });
    if (input.alignment || input.backstory) {
      db.prepare(
        'INSERT INTO canon_fact (campaign_id, subject, fact, created_at) VALUES (?, ?, ?, ?)',
      ).run(
        input.campaign_id,
        pc.name,
        [input.alignment ? `Alignment: ${input.alignment}.` : '', input.backstory ?? ''].filter(Boolean).join(' '),
        ts,
      );
    }
    return {
      character: getCharacterSheet(db, input.campaign_id, id),
      retired_previous: retired,
      // What the interview did not ask about was filled in from the species and the class; say so.
      ...(languages.chosen_for_you ? { languages_chosen_for_you: languages.chosen_for_you } : {}),
      ...(tools.chosen_for_you?.length ? { tools_chosen_for_you: tools.chosen_for_you } : {}),
      ...(picked.chosen_for_you.length ? { equipment_chosen_for_you: picked.chosen_for_you } : {}),
      ...(spellbookChosen?.length ? { spellbook_chosen_for_you: spellbookChosen } : {}),
      ...(featureChoices.chosen_for_you.length ? { features_chosen_for_you: featureChoices.chosen_for_you } : {}),
      ...(originFeat && featNotes.length && !input.feat_choices
        ? { feat_chosen_for_you: `${originFeat.name}: ${featNotes.join(', ')}` }
        : {}),
    };
  })();
  if (created.character) {
    scheduleCharacterPortrait(
      db,
      input.campaign_id,
      created.character.id,
      [`${background.name} background`, input.alignment ?? '', input.backstory ?? ''].filter(Boolean).join(', '),
    );
  }
  return created;
}

// --- options for the interview ---------------------------------------------

export function listCharacterOptions(
  input: { class?: string; species?: string; background?: string; campaign_id?: number },
  db?: Db,
) {
  // Custom backgrounds only exist inside a campaign, so they need both the database and its id.
  const custom = db && input.campaign_id !== undefined ? listHomebrew(db, input.campaign_id, 'background') : [];
  const customPick = input.background
    ? custom.find((entry) => entry.name.trim().toLowerCase() === input.background!.trim().toLowerCase())
    : undefined;
  const result: Record<string, unknown> = {
    classes: srd.classes().map((c) => ({
      name: c.name,
      hit_die: `d${c.hit_die}`,
      primary_ability: c.primary_ability?.desc ?? null,
      saving_throws: c.saving_throws.map((s) => s.index),
      spellcaster: Boolean(c.spellcasting),
    })),
    species: srd.species().map((s) => ({
      name: s.name,
      size: s.size ?? null,
      speed: s.speed,
      // The five species with lineages need one chosen; the rest answer with an empty list.
      lineages: speciesLineages(s),
    })),
    backgrounds: [
      ...srd.backgrounds().map((b) => ({
        name: b.name,
        ability_scores: b.ability_scores.map((a) => a.index),
        feat: b.feat.name,
        skills: b.proficiencies.filter((p) => p.index.startsWith('skill-')).map((p) => skillKey(p.index)),
        custom: false,
      })),
      ...custom.map((entry) => {
        const schema = entry.schema as unknown as BackgroundSchema;
        return {
          name: entry.name,
          ability_scores: schema.abilities,
          feat: typeof schema.origin_feat === 'string' ? schema.origin_feat : schema.origin_feat.name,
          skills: schema.skills,
          custom: true,
        };
      }),
    ],
    ability_bonus_rule:
      "create_character also requires ability_bonuses: raise the background's three abilities by +2 and +1, or by +1 each.",
    ability_methods: {
      standard_array: 'Assign 15, 14, 13, 12, 10, 8 to the six abilities.',
      point_buy: 'Every score starts at 8 and costs points up to 15; you have 27 points.',
      manual: 'Any scores from 3 to 18 (use only if the player wants to break the rules on purpose).',
    },
    languages: {
      rule: `Everyone knows Common and ${STARTING_LANGUAGE_CHOICES} more languages: pass them as languages: [a, b]. Left out, they are picked from the species and the answer says which.`,
      known: ['Common'],
      options: (db && input.campaign_id !== undefined ? languageOptions(db, input.campaign_id) : srdLanguageOptions())
        .filter((l) => l.name !== 'Common')
        .map((l) => ({ name: l.name, rarity: l.rarity, speakers: l.speakers, script: l.script })),
    },
  };

  const cls = input.class ? findClass(input.class) : undefined;
  const species = input.species ? findSpecies(input.species) : undefined;
  const background = input.background && !customPick ? findBackground(input.background) : undefined;

  if (cls) {
    const levelRow = classLevelRow(cls.index, 1);
    result.class_detail = {
      name: cls.name,
      hit_die: `d${cls.hit_die}`,
      saving_throws: cls.saving_throws.map((s) => s.index),
      proficiencies: classProficiencies(cls),
      skill_choices: skillChoiceGroups(cls, species),
      tool_choices: toolChoiceGroups(cls),
      feature_choices: levelOneFeatureChoices(cls),
      other_choices: (cls.proficiency_choices ?? [])
        .filter((c) => c.from.options.every((o) => o.option_type !== 'reference' || !SKILL_KEYS.includes(skillKey(o.item.index))))
        .map((c) => ({ desc: c.desc, choose: c.choose })),
      equipment_options: equipmentBundles(cls.starting_equipment_options?.[0]),
      level_1_features: levelRow.features.map((f) => ({ name: f.name, text: featureText(f.index) })),
      subclass: { name: subclassesOf(cls.index).map((s) => s.name), chosen_at_level: 3 },
      spellcasting: cls.spellcasting
        ? {
            ability: cls.spellcasting.spellcasting_ability.index,
            cantrips_to_choose: levelRow.spellcasting?.cantrips_known ?? 0,
            spells_to_choose: levelRow.spellcasting?.prepared_spells ?? 0,
            cantrip_options: spellsForClass(cls.index, 0),
            spell_options: spellsForClass(cls.index, 1),
            spell_slots: slotsFromRow(levelRow.spellcasting),
          }
        : null,
    };
  }
  if (species) {
    const traits = speciesTraits(species.index);
    result.species_detail = {
      name: species.name,
      size: species.size ?? null,
      speed: species.speed,
      traits: traits
        .filter((t) => traitLineages(species, t).length === 0)
        .map((t) => ({
          name: t.name,
          text: t.description,
          choose: t.proficiency_choices?.choose ?? null,
        })),
      // What create_character wants as lineage, with the traits each one adds.
      lineages: speciesLineages(species).map((lineage) => ({
        name: lineage,
        traits: traits
          .filter((t) => traitLineages(species, t).includes(lineage))
          .map((t) => ({ name: t.name, text: t.description })),
      })),
    };
  }
  if (customPick) {
    result.background_detail = {
      ...customPick.schema,
      name: customPick.name,
      custom: true,
      power_report: customPick.power_report,
    };
  }
  if (background) {
    result.background_detail = {
      name: background.name,
      ability_scores: background.ability_scores.map((a) => a.index),
      ability_bonus_rule: 'Required: raise one of those scores by 2 and another by 1, or all three by 1.',
      feat: {
        name: background.feat.name,
        text: findFeat(background.feat.name).description,
        // What the origin feat still asks for, e.g. which list Magic Initiate draws on.
        choices: featChoiceSpec(findFeat(background.feat.name)),
      },
      skills: background.proficiencies.filter((p) => p.index.startsWith('skill-')).map((p) => skillKey(p.index)),
      tools: background.proficiencies.filter((p) => p.index.startsWith('tool-')).map((p) => p.name.replace('Tool: ', '')),
      equipment_options: equipmentBundles(background.equipment_options?.[0]),
    };
  }
  return result;
}

// --- hit points, conditions, death ------------------------------------------

/** The rules the sheet carries beyond the stored row: armour weight, concentration and the rest clock. */
export interface SheetExtras {
  /** Walking speed with encumbrance and the armour weight rule applied. */
  speed: number | null;
  /** The purse by denomination; the gold field beside it is its whole value in gp. */
  coins: Coins;
  /** The three attunement slots and what is in them. */
  attunement: AttunementState;
  /** Where the armour class comes from, magical gear included. */
  ac_breakdown: AcBreakdown;
  /** Why the speed is what it is, or null when nothing is holding them back. */
  speed_reason: string | null;
  /** Loud armour: Disadvantage on Stealth checks, and on Hide in a fight. */
  stealth_disadvantage: boolean;
  concentrating_on: ConcentrationRecord | null;
  /** When their last long rest ended, in world time; one long rest per 24 hours. */
  last_long_rest_at: string | null;
  /** 2024 Weapon Mastery: the weapons whose mastery property they may use, swapped on a long rest. */
  mastery_weapons: string[];
  /** What the `always` clauses add at read time and what they hand back; none of it is ever stored. */
  clause_grants: ClauseGrants;
}

/** The read-time additions of the `always` clauses, and the ones the sheet could not run. */
export interface ClauseGrants {
  proficiencies: { weapons: string[]; armor: string[]; tools: string[]; languages: string[] };
  spells: { cantrips: string[]; known: string[]; prepared: string[] };
  /** What the `always` clauses put on Initiative, which the fight reads off the same helper. */
  initiative: number;
  reminders: Array<{ feature: string; text: string; reason: string }>;
}

/** The clause grants of one character, worked out where a sheet is read and written nowhere. */
export function clauseGrants(db: Db, campaignId: number, characterId?: number): ClauseGrants {
  const pc = loadPc(db, campaignId, characterId);
  return grantsOf(clausePassives(pc.features, { inventory: pc.inventory }));
}

const grantsOf = (passive: ReturnType<typeof clausePassives>): ClauseGrants => ({
  proficiencies: {
    weapons: passive.weapons,
    armor: passive.armor,
    tools: passive.tools,
    languages: passive.languages,
  },
  spells: { cantrips: passive.cantrips, known: passive.spells, prepared: passive.prepared },
  initiative: passive.initiative,
  reminders: passive.reminders,
});

/** The rules that are not in the character row, computed for whoever shows the sheet. */
export function sheetExtras(db: Db, campaignId: number, characterId?: number): SheetExtras {
  const pc = loadPc(db, campaignId, characterId);
  const str = pc.abilities.str?.score ?? 10;
  const load = carriedLoad(pc.inventory, str);
  const encumbered = load.over && getSettings(db, campaignId).encumbrance === 'rules';
  const armor = armorLoad(pc.inventory, str);
  const reasons = [
    ...(encumbered ? [`over carrying capacity (${load.carried_lb}/${load.capacity_lb} lb): speed 5 ft`] : []),
    ...armor.reasons,
    ...(pc.exhaustion > 0 ? [`exhaustion ${pc.exhaustion}: speed -${exhaustionSpeedPenalty(pc.exhaustion)} ft`] : []),
  ];
  const faster = encumbered ? { bonus: 0, reasons: [] as string[] } : classSpeedBonus(pc.features, pc.inventory);
  reasons.push(...faster.reasons);
  return {
    speed: encumbered
      ? ENCUMBERED_SPEED
      : Math.max(0, pc.speed + faster.bonus - armor.speed_penalty - exhaustionSpeedPenalty(pc.exhaustion)),
    coins: pc.coins,
    attunement: attunementState(pc),
    ac_breakdown: acBreakdown(pc),
    speed_reason: reasons.length ? reasons.join('; ') : null,
    stealth_disadvantage: armor.stealth_disadvantage,
    concentrating_on: readConcentration(db, pc.id),
    last_long_rest_at: lastLongRest(db, pc.id)?.text ?? null,
    mastery_weapons: heldMastery(pc),
    clause_grants: grantsOf(clausePassives(pc.features, { inventory: pc.inventory })),
  };
}

/** The sheet as a tool sees it: effective numbers, without the player's hand-set markers. */
function sheet(db: Db, campaignId: number, characterId?: number): (CharacterSummary & SheetExtras) | null {
  return stripHandSet(getCharacterSheet(db, campaignId, characterId));
}

function addCondition(pc: PcState, condition: string): void {
  if (!pc.conditions.includes(condition)) pc.conditions.push(condition);
}

function removeCondition(pc: PcState, condition: string): void {
  pc.conditions = pc.conditions.filter((c) => c !== condition);
}

/** One corpse rule: dead, at 0 HP, attunements ended, and rid of anything a fall would have added. */
function die(pc: PcState): void {
  pc.status = 'dead';
  endAttunements(pc);
  pc.hp_current = 0;
  removeCondition(pc, 'unconscious');
  removeCondition(pc, 'prone');
}

interface CombatantRef {
  id: number;
  encounter_id: number;
  round: number;
  flags: Record<string, unknown>;
}

/** The combatant row this character holds in the campaign's active encounter, if there is a fight on. */
function activeCombatantRef(db: Db, campaignId: number, characterId: number): CombatantRef | null {
  const row = db
    .prepare(
      `SELECT combatant.id AS id, combatant.encounter_id AS encounter_id, encounter.round AS round,
              combatant.flags_json AS flags_json
         FROM combatant JOIN encounter ON encounter.id = combatant.encounter_id
        WHERE encounter.campaign_id = ? AND encounter.status = 'active' AND combatant.character_id = ?`,
    )
    .get(campaignId, characterId) as
    | { id: number; encounter_id: number; round: number; flags_json: string | null }
    | undefined;
  return row ? { id: row.id, encounter_id: row.encounter_id, round: row.round, flags: parse(row.flags_json, {}) } : null;
}

function logCombatRow(
  db: Db,
  at: CombatantRef,
  entry: { actor_id: number | null; target_id: number; kind: string; payload: unknown; text: string },
): void {
  db.prepare(
    'INSERT INTO combat_log (encounter_id, round, actor_id, target_id, kind, payload_json, text, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(at.encounter_id, at.round, entry.actor_id, entry.target_id, entry.kind, JSON.stringify(entry.payload), entry.text, nowIso());
}

/** At 0 HP or dead a holder keeps nothing: what their concentration held ends, wherever the damage came from. */
function endHeldConcentration(db: Db, at: CombatantRef, reason: string): void {
  const held = db
    .prepare(
      `SELECT effect.id AS id, effect.name AS name, effect.target_id AS target_id, combatant.name AS target_name
         FROM effect JOIN combatant ON combatant.id = effect.target_id
        WHERE effect.encounter_id = ? AND effect.active = 1
          AND (effect.concentration_of = ? OR (effect.ends = 'concentration' AND effect.source_id = ?))`,
    )
    .all(at.encounter_id, at.id, at.id) as Array<{ id: number; name: string; target_id: number; target_name: string }>;
  for (const effect of held) {
    db.prepare('UPDATE effect SET active = 0 WHERE id = ?').run(effect.id);
    logCombatRow(db, at, {
      actor_id: at.id,
      target_id: effect.target_id,
      kind: 'effect_end',
      payload: { effect_id: effect.id, name: effect.name, reason },
      text: `${effect.name} ends on ${effect.target_name} (${reason}).`,
    });
  }
  db.prepare('UPDATE combatant SET concentration_json = NULL WHERE id = ?').run(at.id);
  // What they were holding at the table goes with it: the sheet must not say they still concentrate.
  db.prepare(
    'UPDATE character SET concentration_json = NULL WHERE id = (SELECT character_id FROM combatant WHERE id = ?)',
  ).run(at.id);
}

/**
 * Mirrors the sheet into the combatant row of the active encounter, so a character tool used mid-fight
 * does not leave the battle state stale. Plain SQL on purpose: core must not import the combat engine.
 */
function mirrorIntoCombat(db: Db, campaignId: number, pc: PcState): void {
  const at = activeCombatantRef(db, campaignId, pc.id);
  if (!at) return;
  const alive = pc.status === 'dead' ? 0 : 1;
  // The fight is fought against the effective armour class, hand-set value and all.
  const ac = getOverrides(db, pc.id).ac ?? pc.ac;
  db.prepare(
    `UPDATE combatant SET hp_current = ?, hp_max = ?, temp_hp = ?, conditions_json = ?, death_saves_json = ?, alive = ?, ac = ?,
       speed = ? WHERE id = ?`,
  ).run(
    pc.hp_current,
    pc.hp_max,
    pc.temp_hp,
    JSON.stringify(pc.conditions),
    JSON.stringify(pc.death_saves),
    alive,
    ac,
    effectiveSpeed(db, campaignId, pc),
    at.id,
  );
  logCombatRow(db, at, {
    actor_id: null,
    target_id: at.id,
    kind: 'sync',
    payload: { source: 'character_tool', hp_current: pc.hp_current, conditions: pc.conditions },
    text: `${pc.name} is now ${pc.hp_current}/${pc.hp_max} HP${
      pc.conditions.length ? `, ${pc.conditions.join(', ')}` : ''
    }${alive ? '' : ', dead'} (outside the engine).`,
  });
  if (alive === 0 || pc.hp_current === 0) endHeldConcentration(db, at, alive ? 'down at 0 HP' : 'dead');
}

/** The incoming damage after the sheet's Immunity, Resistance and Vulnerability, in that SRD order. */
function damageByDefences(sheet: CombatSheet, amount: number, type?: string): number {
  const wanted = type?.trim().toLowerCase();
  if (!wanted) return amount;
  const onLine = (lines: string[]): boolean =>
    lines.some((part) => {
      const value = part.trim().toLowerCase();
      return value === wanted || value.split(/\s+/).includes(wanted);
    });
  if (onLine(sheet.immunities)) return 0;
  let damage = amount;
  if (onLine(sheet.resistances)) damage = Math.floor(damage / 2);
  if (onLine(sheet.vulnerabilities)) damage *= 2;
  return damage;
}

/** Why this condition cannot land on the character, or null: the sheet's lines and a running Rage's. */
function conditionImmunity(db: Db, campaignId: number, pc: PcState, condition: string): string | null {
  const sheet = combatSheet(db, pc.id);
  const at = activeCombatantRef(db, campaignId, pc.id);
  const immunity = [
    ...sheet.condition_immunities,
    ...featureConditionImmunities(sheet),
    ...(at ? ragingConditionImmunities(sheet, { flags: at.flags } as unknown as Combatant) : []),
  ].map((one) => one.trim().toLowerCase());
  return immunity.includes(condition)
    ? `${pc.name} is immune to the ${condition} condition; nothing lands.`
    : null;
}

export function applyDamage(
  db: Db,
  input: {
    campaign_id: number;
    character_id?: number;
    amount: number;
    type?: string;
    source?: string;
    critical?: boolean;
    mirror?: boolean;
  },
) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  if (pc.status === 'dead') throw new Error(`${pc.name} is already dead.`);
  if (input.amount < 0) throw new Error('Damage cannot be negative; use heal instead.');

  // Inside a fight the engine has already put the damage through Resistance; apply it only out here.
  const amount = inActiveEncounter(db, input.campaign_id, pc.id)
    ? input.amount
    : damageByDefences(combatSheet(db, pc.id), input.amount, input.type);
  const absorbed = Math.min(pc.temp_hp, amount);
  pc.temp_hp -= absorbed;
  const remaining = amount - absorbed;
  let died = false;
  let deathSaveFailures = 0;

  if (pc.hp_current === 0 && remaining > 0) {
    // Damage at 0 HP undoes a stabilisation: the death saves start again.
    pc.stable = false;
    delete pc.death_saves.stable_until;
    deathSaveFailures = input.critical ? 2 : 1;
    pc.death_saves.failures += deathSaveFailures;
    // The same massive-damage rule that kills from above 0 HP kills outright down here too.
    if (pc.death_saves.failures >= 3 || remaining >= pc.hp_max) died = true;
  } else if (remaining > 0) {
    const after = pc.hp_current - remaining;
    if (after <= 0) {
      pc.hp_current = 0;
      if (-after >= pc.hp_max) died = true;
      else {
        addCondition(pc, 'unconscious');
        pc.death_saves = { successes: 0, failures: 0 };
      }
    } else {
      pc.hp_current = after;
    }
  }

  if (died) {
    die(pc);
  }

  return db.transaction(() => {
    savePc(db, pc);
    if (input.mirror !== false) mirrorIntoCombat(db, input.campaign_id, pc);
    // A holder at 0 hit points keeps nothing, in a fight or out of one.
    const droppedConcentration =
      pc.hp_current === 0 || died ? endConcentration(db, input.campaign_id, pc.id, died ? 'they died' : 'down at 0 HP') : null;
    const parts = [`${pc.name} takes ${amount}${input.type ? ` ${input.type}` : ''} damage`];
    if (input.source) parts.push(`from ${input.source}`);
    parts.push(`(${pc.hp_current}/${pc.hp_max} HP${pc.temp_hp ? `, ${pc.temp_hp} temp` : ''})`);
    if (died) parts.push('- and dies');
    else if (deathSaveFailures) parts.push(`- ${deathSaveFailures} death save failure(s)`);
    else if (pc.hp_current === 0) parts.push('- and falls unconscious');
    logEvent(db, { campaign_id: input.campaign_id, kind: 'damage', text: `${parts.join(' ')}.`, payload: { amount, type: input.type ?? null } });
    if (died) recordDeath(db, input.campaign_id, pc.name);
    return {
      name: pc.name,
      damage_taken: amount,
      absorbed_by_temp_hp: absorbed,
      hp_current: pc.hp_current,
      hp_max: pc.hp_max,
      temp_hp: pc.temp_hp,
      conditions: pc.conditions,
      death_saves: pc.death_saves,
      stable: pc.stable,
      status: pc.status,
      ...(droppedConcentration ? { concentration_ended: `${droppedConcentration.spell} ends: they are down.` } : {}),
      ...(died && pc.is_pc ? { death_options: deathOptions(db, input.campaign_id) } : {}),
    };
  })();
}

function recordDeath(db: Db, campaignId: number, name: string): void {
  db.prepare('INSERT INTO canon_fact (campaign_id, subject, fact, created_at) VALUES (?, ?, ?, ?)').run(
    campaignId,
    name,
    `${name} died.`,
    nowIso(),
  );
}

export function heal(db: Db, input: { campaign_id: number; character_id?: number; amount: number; mirror?: boolean }) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  if (pc.status === 'dead') throw new Error(`${pc.name} is dead and cannot be healed by hit points.`);
  if (input.amount < 0) throw new Error('Healing cannot be negative; use apply_damage instead.');
  pc.hp_current = Math.min(pc.hp_max, pc.hp_current + input.amount);
  if (pc.hp_current > 0) {
    removeCondition(pc, 'unconscious');
    pc.death_saves = { successes: 0, failures: 0 };
    pc.stable = false;
  }
  return db.transaction(() => {
    savePc(db, pc);
    if (input.mirror !== false) mirrorIntoCombat(db, input.campaign_id, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'heal',
      text: `${pc.name} regains ${input.amount} HP (${pc.hp_current}/${pc.hp_max}).`,
    });
    return {
      name: pc.name,
      healed: input.amount,
      hp_current: pc.hp_current,
      hp_max: pc.hp_max,
      conditions: pc.conditions,
      death_saves: pc.death_saves,
    };
  })();
}

export function setTempHp(
  db: Db,
  input: { campaign_id: number; character_id?: number; amount: number; source?: string; mirror?: boolean },
) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  if (input.amount < 0) throw new Error('Temporary hit points cannot be negative; use 0 to clear them.');
  const previous = pc.temp_hp;
  // Temporary hit points never stack: the bigger pool wins, and 0 clears whatever is there.
  pc.temp_hp = input.amount === 0 ? 0 : Math.max(previous, input.amount);
  return db.transaction(() => {
    savePc(db, pc);
    if (input.mirror !== false) mirrorIntoCombat(db, input.campaign_id, pc);
    const text =
      pc.temp_hp === 0
        ? `${pc.name} loses their temporary hit points.`
        : `${pc.name} has ${pc.temp_hp} temporary hit points${input.source ? ` from ${input.source}` : ''}${
            input.amount < previous ? ` (${input.amount} does not stack with the ${previous} already there)` : ''
          }.`;
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'temp_hp',
      text,
      payload: { amount: input.amount, previous, source: input.source ?? null },
    });
    return {
      name: pc.name,
      temp_hp: pc.temp_hp,
      previous_temp_hp: previous,
      character: sheet(db, input.campaign_id, input.character_id),
    };
  })();
}

export function setCondition(
  db: Db,
  input: { campaign_id: number; character_id?: number; condition: string; active: boolean; mirror?: boolean },
) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  const condition = input.condition.trim().toLowerCase();
  const valid = conditionNames();
  if (!valid.includes(condition)) {
    throw new Error(`"${input.condition}" is not an SRD condition. Valid conditions: ${valid.join(', ')}.`);
  }
  // Exhaustion is a level from 0 to 6, not a flag: it belongs in its own column.
  if (condition === 'exhaustion') {
    const result = setExhaustion(db, {
      campaign_id: input.campaign_id,
      character_id: input.character_id,
      ...(input.active ? { delta: 1 } : { level: 0 }),
      mirror: input.mirror,
    });
    return { name: result.name, conditions: pc.conditions, exhaustion: result.exhaustion };
  }
  if (input.active) {
    const immune = conditionImmunity(db, input.campaign_id, pc, condition);
    if (immune) throw new Error(immune);
    addCondition(pc, condition);
  } else removeCondition(pc, condition);
  return db.transaction(() => {
    savePc(db, pc);
    if (input.mirror !== false) mirrorIntoCombat(db, input.campaign_id, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'condition',
      text: `${pc.name} ${input.active ? 'gains' : 'loses'} the ${condition} condition.`,
    });
    return { name: pc.name, conditions: pc.conditions };
  })();
}

export function deathSave(
  db: Db,
  input: {
    campaign_id: number;
    character_id?: number;
    mirror?: boolean;
    /** The d20 the player clicked, already recorded; without it the save is rolled here. */
    roll?: { total: number; natural_d20?: number | null };
  },
) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  if (pc.status === 'dead') throw new Error(`${pc.name} is already dead.`);
  if (pc.hp_current > 0) throw new Error(`${pc.name} is at ${pc.hp_current} HP and does not roll death saves.`);
  if (pc.stable) throw new Error(`${pc.name} is stable and no longer rolls death saves; damage starts them again.`);

  const roll =
    input.roll ??
    rollAndRecord(db, {
      expr: '1d20',
      purpose: 'Death saving throw',
      campaign_id: input.campaign_id,
      luck_bias: luckBiasFor(db, input.campaign_id, pc.is_pc),
    });
  const natural = roll.natural_d20 ?? roll.total;
  // Exhaustion reduces every d20 test, the death save included; the natural face is read first. A roll
  // handed in was rolled from an expression that already carries the penalty, so it is not taken twice.
  const total = input.roll ? roll.total : roll.total - pc.exhaustion * EXHAUSTION_PER_LEVEL;
  let result: 'success' | 'failure' | 'critical_success' | 'critical_failure';
  let revived = false;

  if (natural === 20) {
    result = 'critical_success';
    revived = true;
    pc.hp_current = 1;
    pc.death_saves = { successes: 0, failures: 0 };
    removeCondition(pc, 'unconscious');
  } else if (natural === 1) {
    result = 'critical_failure';
    pc.death_saves.failures += 2;
  } else if (total >= 10) {
    result = 'success';
    pc.death_saves.successes += 1;
  } else {
    result = 'failure';
    pc.death_saves.failures += 1;
  }

  const died = pc.death_saves.failures >= 3;
  const stable = !died && !revived && pc.death_saves.successes >= 3;
  if (died) {
    die(pc);
  }
  if (stable) {
    pc.death_saves = { successes: 0, failures: 0 };
    pc.stable = true;
    markStableUntil(db, input.campaign_id, pc);
  }
  if (revived) pc.stable = false;

  return db.transaction(() => {
    savePc(db, pc);
    if (input.mirror !== false) mirrorIntoCombat(db, input.campaign_id, pc);
    const text = died
      ? `${pc.name} fails a third death save and dies.`
      : revived
        ? `${pc.name} rolls a natural 20 on the death save and wakes with 1 HP.`
        : stable
          ? `${pc.name} succeeds on a third death save and becomes stable (still unconscious at 0 HP).`
          : `${pc.name} rolls ${total} on a death save: ${result} (${pc.death_saves.successes} successes, ${pc.death_saves.failures} failures).`;
    logEvent(db, { campaign_id: input.campaign_id, kind: 'death_save', text });
    if (died) recordDeath(db, input.campaign_id, pc.name);
    return {
      name: pc.name,
      roll: total,
      natural: natural,
      result,
      successes: pc.death_saves.successes,
      failures: pc.death_saves.failures,
      hp_current: pc.hp_current,
      status: pc.status,
      stable,
      conditions: pc.conditions,
      ...(died && pc.is_pc ? { death_options: deathOptions(db, input.campaign_id) } : {}),
    };
  })();
}

/**
 * Stabilises a creature at 0 hit points: a successful DC 10 Medicine check, a Spare the Dying, a
 * healer's kit. They stop rolling death saves and stay unconscious until they are healed or hurt again.
 */
export function stabilize(db: Db, input: { campaign_id: number; character_id?: number; source?: string; mirror?: boolean }) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  if (pc.status === 'dead') throw new Error(`${pc.name} is dead; stabilising is for a creature still dying.`);
  if (pc.hp_current > 0) throw new Error(`${pc.name} is at ${pc.hp_current} HP and is not dying.`);
  pc.stable = true;
  pc.death_saves = { successes: 0, failures: 0 };
  markStableUntil(db, input.campaign_id, pc);
  return db.transaction(() => {
    savePc(db, pc);
    if (input.mirror !== false) mirrorIntoCombat(db, input.campaign_id, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'death_save',
      text: `${pc.name} is stabilised${input.source ? ` by ${input.source}` : ''}: still unconscious at 0 HP, but no longer dying.`,
      payload: { character_id: pc.id, source: input.source ?? null },
    });
    return {
      name: pc.name,
      stable: true,
      hp_current: pc.hp_current,
      conditions: pc.conditions,
      note: 'A stable creature regains 1 HP after 1d4 hours, or wakes at once when it is healed. Any damage undoes it.',
    };
  })();
}

const MAX_EXHAUSTION = 6;

/** Exhaustion as the 2024 rules count it: one column, 0 to 6, and 6 is death. */
export function setExhaustion(
  db: Db,
  input: { campaign_id: number; character_id?: number; delta?: number; level?: number; mirror?: boolean },
) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  if (input.delta === undefined && input.level === undefined) {
    throw new Error('Pass delta to move exhaustion up or down, or level to set it outright.');
  }
  const wanted = input.level ?? pc.exhaustion + (input.delta ?? 0);
  if (!Number.isInteger(wanted) || wanted < 0 || wanted > MAX_EXHAUSTION) {
    throw new Error(`Exhaustion runs from 0 to ${MAX_EXHAUSTION}; ${wanted} is not a level.`);
  }
  const before = pc.exhaustion;
  pc.exhaustion = wanted;
  const died = wanted === MAX_EXHAUSTION;
  if (died) {
    die(pc);
  }
  return db.transaction(() => {
    savePc(db, pc);
    if (input.mirror !== false) mirrorIntoCombat(db, input.campaign_id, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'condition',
      text: died
        ? `${pc.name} reaches exhaustion 6 and dies.`
        : `${pc.name} is at exhaustion ${wanted} (was ${before}): -${wanted * 2} on every d20 test.`,
      payload: { exhaustion: wanted, previous: before },
    });
    if (died) recordDeath(db, input.campaign_id, pc.name);
    return {
      name: pc.name,
      exhaustion: pc.exhaustion,
      previous: before,
      d20_penalty: pc.exhaustion * EXHAUSTION_PER_LEVEL,
      status: pc.status,
      ...(died && pc.is_pc ? { death_options: deathOptions(db, input.campaign_id) } : {}),
    };
  })();
}

/** 2024 exhaustion: every level takes 2 off every d20 test. */
export const EXHAUSTION_PER_LEVEL = 2;

/** The penalty the roll tool subtracts for a player's own d20 test. */
export function exhaustionPenalty(db: Db, campaignId: number, characterId?: number): number {
  const row =
    characterId === undefined
      ? pcRow(db, campaignId)
      : (db.prepare('SELECT exhaustion FROM character WHERE id = ? AND campaign_id = ?').get(characterId, campaignId) as
          | { exhaustion: number }
          | undefined);
  return ((row?.exhaustion as number | undefined) ?? 0) * EXHAUSTION_PER_LEVEL;
}

// --- rests, slots, xp, level-up ---------------------------------------------

/** Puts back what a rest of this kind gives back, and names each resource it refilled. */
function restoreResources(pc: PcState, kind: 'short' | 'long'): string[] {
  const restored: string[] = [];
  for (const feature of pc.features) {
    const mechanics = feature.mechanics;
    if (!mechanics?.per || !mechanics.used) continue;
    // once_ever: no rest gives it back, which is the whole of what the words mean. A dawn or dusk
    // counter comes back with the clock, and rechargeDailyItems owns it.
    if (mechanics.per === 'never' || mechanics.recharge_at) continue;
    if (kind === 'long' || mechanics.per === 'short') {
      mechanics.used = 0;
      restored.push(feature.name);
      continue;
    }
    // A long-rest resource the rules hand one use back for on a short rest: Rage, Second Wind, Channel Divinity.
    if (mechanics.regain_on_short === 'one') {
      mechanics.used -= 1;
      restored.push(`${feature.name} (one use)`);
    }
  }
  return restored;
}

/** The feature row a clause's uses are counted on, beside the feature it stands for. */
function clauseCounterRow(
  pc: PcState,
  key: string,
  label: string,
  spec: { max: number; per: ResourcePeriod | null; recharge_at?: 'dawn' | 'dusk' },
): Feature {
  const row =
    pc.features.find((f) => f.mechanics?.resource === key) ??
    pc.features.find((f) => f.name.toLowerCase() === label.toLowerCase());
  const feature = row ?? (() => {
    const created: Feature = { name: label, source: 'class', text: `${label}: ${spec.max}.` };
    pc.features.push(created);
    return created;
  })();
  const mechanics = feature.mechanics ?? (feature.mechanics = {});
  mechanics.resource = key;
  if (mechanics.max === undefined) mechanics.max = spec.max;
  if (spec.per) mechanics.per ??= spec.per;
  if (spec.recharge_at) mechanics.recharge_at ??= spec.recharge_at;
  return feature;
}

/** Spends one use of a clause counter straight on the PC's rows: its home is features_json. */
function spendClauseUse(pc: PcState, input: { key: string; label: string; max: number; per: ResourcePeriod | null; recharge_at?: 'dawn' | 'dusk' }): number {
  const row = clauseCounterRow(pc, input.key, input.label, input);
  const mechanics = row.mechanics!;
  mechanics.used = (mechanics.used ?? 0) + 1;
  return Math.max(0, (mechanics.max ?? 0) - mechanics.used);
}

/** The clause `charges` a magic item's counter recharges at, per the clause that names the key. */
function clauseRechargeAt(pc: PcState, resource: string): 'dawn' | 'dusk' | undefined {
  const parts = /^homebrew:([^:]+):(\d+)$/.exec(resource);
  if (!parts) return undefined;
  const item = pc.inventory.find(
    (i) => i.magic?.mechanics?.clauses && homebrewIndex({ name: i.name, source: 'item' }) === `homebrew:${parts[1]}`,
  );
  const uses = item?.magic?.mechanics?.clauses?.[Number(parts[2])]?.uses;
  if (uses && typeof uses === 'object' && 'charges' in uses) {
    const at = uses.charges.recharge;
    if (at === 'dawn' || at === 'dusk') return at;
  }
  return undefined;
}

interface RestClauseResult {
  /** What landed, in the lines the reply and the journal carry. */
  applied: string[];
  /** The reasons the clauses handed themselves back; reminders never spend. */
  notes: string[];
}

/** Names in the journal what a rest's clauses applied, so the table sees the effects and the spend. */
function logRestClauses(db: Db, campaignId: number, name: string, applied: string[]): void {
  if (applied.length === 0) return;
  logEvent(db, {
    campaign_id: campaignId,
    kind: 'rest',
    text: `${name}'s rest: ${applied.join(' ')}`,
    payload: { applied },
  });
}

/** An item gives its clauses only while worn, and attuned when it asks for it (sheet.ts itemActive). */
const itemClauseActive = (item: InventoryItem): boolean =>
  item.equipped === true && item.magic !== undefined && (item.magic.attunement === false || item.magic.attuned === true);

/**
 * Executes the clauses whose hook this rest is, against the PC's own rows: the same clause reads as a
 * combat one. Plan, validate, spend, apply - a use is spent only where a verb landed, and every spend
 * rides the clause's own counter row (`homebrew:<index>:<n>`), recharged by restoreResources and the
 * item recharge path.
 */
function applyRestClauses(db: Db, pc: PcState, kind: 'short' | 'long', roll: RestRollSource): RestClauseResult {
  const out: RestClauseResult = { applied: [], notes: [] };
  const handBack = (name: string, clause: Clause, reason: string): void => {
    out.notes.push(`${name}: ${describeClause(clause)} - ${reason}`);
  };
  // The sheet as a clause sees it, built the same way the fight's sheet is: the homebrew rows read off
  // the library, and the magic items that are worn.
  const holders: ClauseHolder[] = pc.features.map((feature): ClauseHolder => {
    const id = feature.mechanics?.homebrew_id;
    if (id === undefined) return { name: feature.name, source: feature.source, mechanics: feature.mechanics };
    return { name: feature.name, source: feature.source, mechanics: feature.mechanics, clauses: featureClauses(db, id, feature.name, pc.level) };
  });
  for (const item of pc.inventory) {
    if (!itemClauseActive(item)) continue;
    const clauses = item.magic?.mechanics?.clauses;
    if (clauses?.length) holders.push({ name: item.name, source: 'item', clauses });
  }
  const sheet: ClauseSheet = {
    level: pc.level,
    proficiency_bonus: proficiencyBonus(pc.level),
    abilities: pc.abilities,
    features: holders,
    inventory: pc.inventory,
  };
  // Only what a PC row can be judged on: a Combatant for the answers a clause asks of the self.
  const actor = { name: pc.name, hp_current: pc.hp_current, hp_max: pc.hp_max, conditions: [...pc.conditions], flags: {} };
  const hook = kind === 'long' ? ('rest_long' as const) : ('rest_short' as const);
  for (const holder of holders) {
    (holder.clauses ?? []).forEach((clause, at) => {
      if (clause.when !== hook) return;
      const name = holder.name;
      const verdict = clauseApplies(clause, { sheet, actor, kind: hook } as unknown as ClauseCtx);
      if (verdict.blocked) return handBack(name, clause, verdict.blocked.reason);
      if (!verdict.ok) return;
      if (clause.decide === 'dm') return handBack(name, clause, 'this one is yours to apply');
      if (clause.decide !== 'auto') return handBack(name, clause, 'the player chooses this one: apply it if they take it');
      const key = clauseResourceKey(homebrewIndex(holder), at);
      const spec = clauseUsesMax(sheet, clause.uses);
      if (spec && clauseUsesLeft(sheet, clause.uses, key) <= 0) return;
      let applied = false;
      let per: ResourcePeriod | null = null;
      let rechargeAt: 'dawn' | 'dusk' | undefined;
      if (spec) {
        const usesSpec = clause.uses;
        if (
          typeof usesSpec === 'object' &&
          'charges' in usesSpec &&
          (usesSpec.charges.recharge === 'dawn' || usesSpec.charges.recharge === 'dusk')
        ) {
          // A dawn or dusk counter comes back with the clock, never with a rest.
          rechargeAt = usesSpec.charges.recharge;
          per = null;
        } else {
          per = spec.per;
        }
      }
      for (const what of clause.do) {
        // A note is a line in the DM's own words, whatever hook it rides on, and pays nothing.
        if (what.kind === 'note') {
          out.notes.push(`${name}: ${describeClause(clause)} - ${what.text}`);
          continue;
        }
        const capability = doCapability(clause, what);
        if (capability.status !== 'runs') {
          out.notes.push(`${name}: ${describeClause(clause)} - ${capability.reason ?? `${describeDo(what)} is yours to apply here`}`);
          continue;
        }
        switch (what.kind) {
          case 'extra_heal': {
            // A full-heal long rest has nothing for healing to do; paying a use for it would be a spend.
            if (pc.hp_current >= pc.hp_max) {
              out.notes.push(`${name}: ${describeClause(clause)} - ${pc.name} is already at full hit points`);
              break;
            }
            const result = roll({ expr: resolveDice(sheet, what.dice), purpose: `${name} on a ${kind} rest` });
            const before = pc.hp_current;
            pc.hp_current = Math.min(pc.hp_max, pc.hp_current + result.total);
            applied = true;
            out.applied.push(`${name}: heals ${pc.hp_current - before} (${result.output}).`);
            break;
          }
          case 'temp_hp': {
            if (what.amount === undefined) {
              out.notes.push(`${name}: ${describeClause(clause)} - temporary hit points in dice are rolled by you here`);
              break;
            }
            if (what.amount > pc.temp_hp) {
              pc.temp_hp = what.amount;
              applied = true;
              out.applied.push(`${name}: ${what.amount} Temporary Hit Points.`);
            }
            break;
          }
          case 'remove_condition': {
            const had = pc.conditions.includes(what.name);
            if (had) {
              pc.conditions = pc.conditions.filter((c) => c !== what.name);
              applied = true;
              out.applied.push(`${name}: ends the ${what.name} condition.`);
            }
            break;
          }
          case 'recover_resource': {
            const amount = flatAmount(sheet, what.amount);
            if (amount === null) {
              out.notes.push(`${name}: ${describeClause(clause)} - a resource comes back in whole numbers here`);
              break;
            }
            const row = pc.features.find((f) => f.mechanics?.resource === what.key);
            if (!row?.mechanics) {
              out.notes.push(`${name}: ${describeClause(clause)} - ${pc.name} holds no ${what.key.replace(/_/g, ' ')} to restore.`);
              break;
            }
            const used = row.mechanics.used ?? 0;
            const back = Math.min(amount, used);
            if (back > 0) {
              row.mechanics.used = used - back;
              applied = true;
              out.applied.push(`${name}: restores ${back} of ${what.key.replace(/_/g, ' ')}.`);
            }
            break;
          }
          case 'grant_inspiration': {
            if (!pc.is_pc) {
              out.notes.push(`${name}: ${describeClause(clause)} - only a player character holds Heroic Inspiration here.`);
              break;
            }
            if (pc.inspiration === 0) {
              pc.inspiration = 1;
              applied = true;
              out.applied.push(`${name}: Heroic Inspiration.`);
            }
            break;
          }
          default:
            out.notes.push(`${name}: ${describeClause(clause)} - ${describeDo(what)} is yours to apply here`);
        }
      }
      if (!applied) return;
      if (spec) {
        const left = spendClauseUse(pc, { key, label: clauseLabel(holder, at), max: spec.max, per, recharge_at: rechargeAt });
        out.applied.push(`${name}: spends a use (${left} of ${spec.max} left).`);
      }
    });
  }
  return out;
}

export interface ResourceSpend {
  name: string;
  resource: string;
  used: number;
  max: number;
  left: number;
}

/** The feature row carrying a class resource, by the key the level table or the registry gave it. */
const resourceFeatureRow = (pc: PcState, resource: string): Feature | undefined =>
  pc.features.find((f) => f.mechanics?.resource === resource);

/**
 * Spends a class resource off a character's feature row: Rage uses, Focus Points, the Lay On Hands pool.
 * A feature whose number the level table has no column for carries its counter from the first spend, with
 * the maximum and the rest the caller names. Throws before it writes when there is not enough left.
 */
export function spendFeatureResource(
  db: Db,
  input: {
    campaign_id: number;
    character_id: number;
    resource: string;
    amount?: number;
    /** The name the row gets when it has to be created; the feature's own name. */
    label?: string;
    /** The maximum, when the registry derives it rather than the level table carrying it. */
    max?: number;
    per?: ResourcePeriod;
  },
): ResourceSpend {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  const amount = input.amount ?? 1;
  const row = resourceFeatureRow(pc, input.resource);
  const feature =
    row ??
    pc.features.find((f) => f.name.toLowerCase() === (input.label ?? '').toLowerCase()) ??
    (() => {
      const created: Feature = {
        name: input.label ?? input.resource,
        source: 'class',
        text: `${input.label ?? input.resource}: ${input.max ?? 0}.`,
      };
      pc.features.push(created);
      return created;
    })();
  const mechanics = feature.mechanics ?? (feature.mechanics = {});
  mechanics.resource = input.resource;
  if (input.max !== undefined) mechanics.max = input.max;
  if (input.per !== undefined) mechanics.per = input.per;
  // A clause counter keyed off a magic item rides the item's own recharge schedule, not the rests.
  const rechargeAt = clauseRechargeAt(pc, input.resource);
  if (rechargeAt) mechanics.recharge_at ??= rechargeAt;
  const max = mechanics.max ?? 0;
  const used = mechanics.used ?? 0;
  const left = Math.max(0, max - used);
  if (amount > left) {
    throw new Error(
      `${pc.name} has ${left} of ${max} ${feature.name} left and this costs ${amount}. It comes back on a ${
        mechanics.per === 'short' ? 'short' : 'long'
      } rest; call rest to take one.`,
    );
  }
  mechanics.used = used + amount;
  savePc(db, pc);
  return { name: feature.name, resource: input.resource, used: mechanics.used, max, left: max - mechanics.used };
}

/**
 * Puts uses of one class resource back: every one of them (Uncanny Metabolism), or the amount a feature
 * hands back (Font of Inspiration, Wild Resurgence, Font of Magic turning a slot into Sorcery Points).
 */
/**
 * Bumps the tally of a feature whose uses are counted rather than budgeted: Relentless Rage, whose save
 * DC climbs 5 with every use. The row is rest-scoped, so restoreResources wipes the count on a rest.
 */
export function countFeatureUse(
  db: Db,
  input: { campaign_id: number; character_id: number; resource: string; label: string; per: ResourcePeriod },
): number {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  const feature =
    resourceFeatureRow(pc, input.resource) ??
    pc.features.find((f) => f.name.toLowerCase() === input.label.toLowerCase());
  if (!feature) return 0;
  const mechanics = feature.mechanics ?? (feature.mechanics = {});
  mechanics.resource = input.resource;
  mechanics.per = input.per;
  mechanics.used = (mechanics.used ?? 0) + 1;
  savePc(db, pc);
  return mechanics.used;
}

export function restoreFeatureResource(
  db: Db,
  input: { campaign_id: number; character_id: number; resource: string; amount?: number },
): ResourceSpend | null {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  const feature = resourceFeatureRow(pc, input.resource);
  if (!feature?.mechanics) return null;
  const max = feature.mechanics.max ?? 0;
  const used = input.amount === undefined ? 0 : Math.max(0, (feature.mechanics.used ?? 0) - input.amount);
  feature.mechanics.used = used;
  savePc(db, pc);
  return { name: feature.name, resource: input.resource, used, max, left: max - used };
}

/**
 * Creates one spell slot: Font of Magic weaving Sorcery Points into one, Wild Resurgence trading a Wild
 * Shape for one. The SRD asks for no expended slot to bring back, so it is a bonus slot beside the class
 * table's own - spent before them, and gone on the long rest that refills them.
 */
export function restoreSpellSlot(db: Db, input: { campaign_id: number; character_id?: number; level: number }) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  const slot = pc.spell_slots[String(input.level)];
  if (!slot) {
    const have = Object.keys(pc.spell_slots).join(', ') || 'none';
    throw new Error(`${pc.name} has no level ${input.level} spell slots at all. Slot levels available: ${have}.`);
  }
  slot.bonus = (slot.bonus ?? 0) + 1;
  savePc(db, pc);
  logEvent(db, {
    campaign_id: input.campaign_id,
    kind: 'spell_slot',
    text: `${pc.name} gains a level ${input.level} spell slot (${slotsLeft(slot)} open).`,
  });
  return { name: pc.name, level: input.level, remaining: slotsLeft(slot), spell_slots: pc.spell_slots };
}

/** The sheet row a Bardic Inspiration die is held on: one die at a time, spent when it is rolled. */
const INSPIRATION_DIE = 'Bardic Inspiration Die (held)';

/** What a bard hands a creature: one die, on that creature's own sheet, until it is rolled. */
export function grantInspirationDie(
  db: Db,
  input: { campaign_id: number; character_id: number; die: number; from: string },
): { die: number; from: string } {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  const held = pc.features.find((f) => f.name === INSPIRATION_DIE);
  const text = `A d${input.die} from ${input.from}, added to one failed D20 Test within the hour. A creature holds one at a time.`;
  if (held) {
    held.text = text;
    held.mechanics = { ...held.mechanics, max: input.die };
  } else {
    pc.features.push({ name: INSPIRATION_DIE, source: 'class', text, mechanics: { max: input.die } });
  }
  savePc(db, pc);
  return { die: input.die, from: input.from };
}

/** The Bardic Inspiration die this character is holding, or null when they hold none. */
export function heldInspirationDie(db: Db, campaignId: number, characterId?: number): number | null {
  const pc = loadPc(db, campaignId, characterId);
  return pc.features.find((f) => f.name === INSPIRATION_DIE)?.mechanics?.max ?? null;
}

/** Spends the held die: it is gone once it has been rolled. */
export function spendInspirationDie(db: Db, campaignId: number, characterId?: number): number | null {
  const pc = loadPc(db, campaignId, characterId);
  const held = pc.features.find((f) => f.name === INSPIRATION_DIE);
  if (!held) return null;
  pc.features = pc.features.filter((f) => f.name !== INSPIRATION_DIE);
  savePc(db, pc);
  return held.mechanics?.max ?? null;
}

/** 2024: a long rest is spent on weapon drills, swapping the weapons Weapon Mastery covers for others. */
function swapMasteryWeapons(pc: PcState, wanted: string[]): string[] {
  const feature = pc.features.find((f) => f.mechanics?.mastery_weapons);
  if (!feature) {
    throw new Error(
      `${pc.name} has no Weapon Mastery to swap; it is a Barbarian, Fighter, Paladin, Ranger and Rogue feature.`,
    );
  }
  const held = feature.mechanics!.mastery_weapons!;
  const options = masteryWeaponOptions(pc.proficiencies.weapons);
  const picks = wanted.map((pick) => {
    const match = options.find((option) => option.toLowerCase() === pick.trim().toLowerCase());
    if (!match) {
      throw new Error(
        `"${pick}" is not a weapon ${pc.name} is proficient with that has a mastery property. Options: ${options.join(', ')}.`,
      );
    }
    return match;
  });
  if (picks.length !== held.length || new Set(picks).size !== picks.length) {
    throw new Error(
      `${pc.name}'s Weapon Mastery covers ${held.length} different weapons; got ${picks.length}. Options: ${options.join(', ')}.`,
    );
  }
  feature.mechanics!.mastery_weapons = picks;
  return picks;
}

/**
 * Arcane Recovery and Natural Recovery both buy back slot levels adding up to half the class level,
 * rounded up, with none of them above level 5.
 */
function arcaneRecovery(pc: PcState): { regained: string[]; budget: number } {
  let budget = Math.ceil(pc.level / 2);
  const regained: string[] = [];
  for (const level of Object.keys(pc.spell_slots).map(Number).sort((a, b) => b - a)) {
    if (level > 5) continue;
    const slot = pc.spell_slots[String(level)]!;
    while (slot.used > 0 && budget >= level) {
      slot.used -= 1;
      budget -= level;
      regained.push(`level ${level}`);
    }
  }
  return { regained, budget: Math.ceil(pc.level / 2) };
}

const arcaneRecoveryFeature = (pc: PcState): Feature | undefined =>
  pc.features.find((f) => f.mechanics?.resource === 'arcane_recovery');

/** A feature row by the SRD index it came from, for the short-rest features that spend their own use. */
function heldFeatureRow(pc: PcState, index: string): Feature | undefined {
  const classIndex = classIndexOf(pc.class);
  return pc.features.find((f) => featureIndexOf(f.name, classIndex) === index);
}

/**
 * The once-a-long-rest features a short rest may spend, refused with the reason when they cannot. The
 * counter is put on the feature row at the first use, the way spending one in a fight does.
 */
function requireRestFeature(pc: PcState, index: string, resource: string, what: string): Feature {
  const row = heldFeatureRow(pc, index);
  if (!row) throw new Error(`${pc.name} has no ${what}.`);
  const mechanics = row.mechanics ?? (row.mechanics = {});
  mechanics.resource = resource;
  mechanics.max = mechanics.max ?? 1;
  mechanics.per = mechanics.per ?? 'long';
  if ((mechanics.used ?? 0) >= mechanics.max) {
    throw new Error(`${pc.name} has already used ${what}; it comes back after a long rest.`);
  }
  return row;
}

/** Sorcerous Restoration: sorcery points back, up to half the Sorcerer's level, once per long rest. */
function sorcerousRestoration(pc: PcState): number {
  const row = requireRestFeature(pc, 'sorcerer-sorcerous-restoration', 'sorcerous_restoration', 'Sorcerous Restoration');
  const points = pc.features.find((f) => f.mechanics?.resource === 'sorcery_points');
  if (!points?.mechanics) throw new Error(`${pc.name} has no Sorcery Points to restore.`);
  const back = Math.min(points.mechanics.used ?? 0, Math.floor(pc.level / 2));
  if (back <= 0) throw new Error(`${pc.name} has spent no Sorcery Points, so there is nothing to restore.`);
  points.mechanics.used = (points.mechanics.used ?? 0) - back;
  row.mechanics!.used = 1;
  return back;
}

/** Memorize Spell: one prepared level 1+ Wizard spell swapped for another out of the spellbook. */
function memorizeSpell(pc: PcState, swap: { replace: string; with: string }): string {
  if (!heldFeatureRow(pc, 'wizard-memorize-spell')) {
    throw new Error(`${pc.name} has no Memorize Spell; it is a Wizard feature taken at level 5.`);
  }
  const at = spellIndexOf(pc.spells.prepared, swap.replace);
  if (at < 0) {
    throw new Error(`${pc.name} does not have "${swap.replace}" prepared. Prepared: ${pc.spells.prepared.join(', ')}.`);
  }
  const book = pc.spells.spellbook ?? [];
  const wanted = book.find((name) => name.toLowerCase() === swap.with.trim().toLowerCase());
  if (!wanted) throw new Error(`"${swap.with}" is not in ${pc.name}'s spellbook: ${book.join(', ')}.`);
  const spell = findSpell(wanted);
  if (!spell || spell.level < 1) throw new Error('Memorize Spell swaps a level 1+ spell, not a cantrip.');
  if (hasKnownSpell(pc.spells.prepared, wanted)) throw new Error(`${pc.name} already has ${wanted} prepared.`);
  pc.spells.prepared[at] = wanted;
  return `${pc.spells.prepared[at]} replaces ${swap.replace}`;
}

/** Fiendish Resilience: the damage type this warlock resists until the next rest changes it. */
function fiendishResilience(pc: PcState, type: string): string {
  const row = heldFeatureRow(pc, 'fiend-patron-fiendish-resilience');
  if (!row) throw new Error(`${pc.name} has no Fiendish Resilience; it is a Fiend patron feature taken at level 10.`);
  const wanted = type.trim().toLowerCase();
  if (wanted === 'force') throw new Error('Fiendish Resilience takes any damage type other than Force.');
  if (!DAMAGE_TYPES.includes(wanted)) {
    throw new Error(`"${type}" is not a damage type. The SRD types are ${DAMAGE_TYPES.join(', ')}.`);
  }
  row.mechanics = { ...row.mechanics, options: [wanted] };
  return wanted;
}

/** 2024: a long rest is 8 hours, a short rest 1, and nobody benefits from more than one long rest a day. */
export const LONG_REST_HOURS = 8;
export const SHORT_REST_HOURS = 1;
export const LONG_REST_PER_HOURS = 24;

/** When a long rest finished, on the in-world clock: the minutes it stands at, and how it reads. */
interface RestStamp {
  minutes: number;
  text: string;
}

/** The campaign clock as one number, so two moments in the story can be subtracted. */
function clockMinutes(now: NowState): number {
  const days = (now.year - 1) * MONTHS_PER_YEAR * DAYS_PER_MONTH + (now.month - 1) * DAYS_PER_MONTH + (now.day - 1);
  return days * 24 * 60 + now.hour * 60 + now.minute;
}

/** Rolls the 1d4 hours the SRD gives a stabilised creature, as the in-world minute its HP comes back. */
function markStableUntil(db: Db, campaignId: number, pc: PcState): void {
  const hours = rollAndRecord(db, {
    expr: '1d4',
    purpose: 'Hours until a stable creature regains 1 HP',
    campaign_id: campaignId,
  }).total;
  pc.death_saves.stable_until = clockMinutes(nowState(db, campaignId)) + hours * 60;
}

function lastLongRest(db: Db, characterId: number): RestStamp | null {
  const row = db.prepare('SELECT last_long_rest_at FROM character WHERE id = ?').get(characterId) as
    | { last_long_rest_at: string | null }
    | undefined;
  return parse<RestStamp | null>(row?.last_long_rest_at ?? null, null);
}

function stampLongRest(db: Db, campaignId: number, characterId: number): RestStamp {
  const now = nowState(db, campaignId);
  const stamp: RestStamp = { minutes: clockMinutes(now), text: now.date_text };
  db.prepare('UPDATE character SET last_long_rest_at = ? WHERE id = ?').run(JSON.stringify(stamp), characterId);
  return stamp;
}

/**
 * What a rest answers with. Which fields are filled depends on the rest: a long one, a short one or
 * one that was broken off.
 */
export interface RestResult {
  name: string;
  kind: 'short' | 'long';
  /** The rest was broken off: it gave nothing back, and only the hours are gone. */
  interrupted?: boolean;
  hours?: number;
  message?: string;
  now?: TimeChange;
  hp_current?: number;
  hp_max?: number;
  temp_hp?: number;
  exhaustion?: number;
  spell_slots?: SpellSlots;
  hit_dice?: HitDice;
  hit_dice_spent?: number;
  /** The hit dice as they were rolled, or null when none were spent. */
  roll?: string | null;
  healed?: number;
  pact_magic_restored?: boolean;
  features_restored?: string[];
  /** What clauses whose hook this rest is applied, and the uses they spent. */
  rest_effects?: string[];
  conditions?: string[];
  concentration_ended?: string;
  last_long_rest_at?: string;
  arcane_recovery?: string[];
  arcane_recovery_available?: string;
  /** Sorcerous Restoration, Memorize Spell and Fiendish Resilience, when the rest was spent on them. */
  sorcery_points_restored?: number;
  memorized_spell?: string;
  fiendish_resilience?: string;
  /** Magic items this rest attuned to, let go of or worked out; and the three attunement slots after. */
  attuned?: string[];
  unattuned?: string[];
  identified?: string[];
  attunement?: AttunementState;
  /** Items whose charges a long rest gave back. */
  items_recharged?: string[];
  /** Anything the engine could not rule on and is handing to the DM. */
  notes?: string[];
  /** Attunements the engine refused and attune_ruling allowed anyway. */
  rulings?: string[];
  /** The rule this rest bent in freeform mode, with the DM's blessing. */
  rules_note?: string;
  /** Long rest: the weapons Weapon Mastery covers from here on. */
  mastery_weapons?: string[];
}

/** One die a rest asks for: the expression to roll, and what the journal calls it. */
export interface RestRollRequest {
  expr: string;
  purpose: string;
}

/** Rolls one rest die and hands back its record. A caller that waits on the player supplies its own. */
export type RestRollSource = (request: RestRollRequest) => RollRecord;

/** Everything a rest is asked for. */
export interface RestInput {
  campaign_id: number;
  character_id?: number;
  kind: 'short' | 'long';
  hit_dice_to_spend?: number;
  /** Kept for callers of the old gate; a completed long rest lifts exhaustion whether or not they ate. */
  food_and_drink?: boolean;
  /** Short rest, Wizard only: spend Arcane Recovery to get spell slots back. */
  arcane_recovery?: boolean;
  /** Short rest, Circle of the Land Druid: spend Natural Recovery to get spell slots back. */
  natural_recovery?: boolean;
  /** Short rest, Sorcerer 5: spend Sorcerous Restoration for sorcery points back. */
  sorcerous_restoration?: boolean;
  /** Short rest, Wizard 5: swap one prepared level 1+ spell for another from the spellbook. */
  memorize_spell?: { replace: string; with: string };
  /** Either rest, Fiend Warlock 10: the damage type Fiendish Resilience makes them resist. */
  fiendish_resilience?: string;
  /** Short rest: magic items, by name or id, to spend the rest attuning to. */
  attune?: string[];
  /** Short rest: attunements to end. */
  unattune?: string[];
  /** Short rest: magic items to spend the rest studying, which reveals what they are. */
  identify?: string[];
  /** The DM's reason for allowing an attunement whose requirement the character does not meet. */
  attune_ruling?: string;
  /** Long rest: the weapons Weapon Mastery covers from here on, as many as it covers now. */
  mastery_weapons?: string[];
  /** The rest was broken off: it gives nothing, and a long one leaves no stamp. */
  interrupted?: boolean;
  /** Freeform rules_mode only: a long rest inside 24 hours of the last one, as the DM's ruling. */
  force?: boolean;
  /** How long they actually rested; under 8 hours (1 for a short rest) counts as interrupted. */
  hours?: number;
  /** False leaves the campaign clock where it is; by default the rest costs its hours. */
  advance_time?: boolean;
  mirror?: boolean;
}

/**
 * Runs a rest. The dice are the server's unless the caller passes a source: the awaited variant in
 * core/rolls.ts passes one that waits on the player, and re-runs this function once each card resolves.
 */
export function rest(db: Db, input: RestInput, rollSource?: RestRollSource): RestResult {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  const roll: RestRollSource =
    rollSource ?? ((request) => rollAndRecord(db, { ...request, campaign_id: input.campaign_id }));
  if (pc.status === 'dead') throw new Error(`${pc.name} is dead and cannot rest.`);
  if (inActiveEncounter(db, input.campaign_id, pc.id)) {
    throw new Error(`${pc.name} is in an active encounter; rolling Initiative interrupts a rest.`);
  }
  const focusing = [input.attune, input.unattune, input.identify].some((list) => (list ?? []).length > 0);
  if (focusing && input.kind !== 'short') {
    throw new Error(
      'Attuning to an item, ending an attunement and studying one out all take a short rest spent focused on it. Call rest with kind "short".',
    );
  }
  if (input.mastery_weapons && input.kind !== 'long') {
    throw new Error('Weapon Mastery is swapped by practising through a long rest. Call rest with kind "long" and mastery_weapons.');
  }
  const shortOnly = [
    input.natural_recovery ? 'Natural Recovery' : null,
    input.sorcerous_restoration ? 'Sorcerous Restoration' : null,
    input.memorize_spell ? 'Memorize Spell' : null,
  ].filter((what): what is string => what !== null);
  if (shortOnly.length > 0 && input.kind !== 'short') {
    throw new Error(`${shortOnly.join(' and ')} ${shortOnly.length === 1 ? 'is' : 'are'} spent on a short rest; a long rest gives it all back anyway.`);
  }
  const needed = input.kind === 'long' ? LONG_REST_HOURS : SHORT_REST_HOURS;
  const hours = input.hours ?? needed;
  const interrupted = input.interrupted === true || hours < needed;
  const moveClock = (spent: number): TimeChange | null =>
    input.advance_time === false || spent <= 0 ? null : advanceTime(db, input.campaign_id, { hours: spent });

  const freeform = getSettings(db, input.campaign_id).rules_mode === 'freeform';
  if (input.force === true && !freeform) {
    throw new Error('force bypasses the long-rest rule only in freeform rules_mode; core rules apply here.');
  }
  const forced = input.force === true && freeform;
  // An interrupted rest gives nothing back, so the one-a-day rule has nothing to refuse.
  let blocked = false;
  if (input.kind === 'long' && !interrupted) {
    const last = lastLongRest(db, pc.id);
    const now = clockMinutes(nowState(db, input.campaign_id));
    blocked = last !== null && now - last.minutes < LONG_REST_PER_HOURS * 60;
    if (blocked && !forced) {
      throw new Error(
        `${pc.name} gets one long rest per 24 hours; the last ended at ${last!.text}. A short rest is still theirs to take.${
          freeform ? ' In freeform mode pass force: true to allow it as your ruling.' : ''
        }`,
      );
    }
  }

  // A rest that was broken off gives nothing back: only the hours spent on it are gone.
  if (interrupted) {
    const now = moveClock(hours);
    return {
      name: pc.name,
      kind: input.kind,
      interrupted: true,
      hours,
      ...(now ? { now } : {}),
      message: `${pc.name}'s ${input.kind} rest was interrupted after ${hours} hour${hours === 1 ? '' : 's'} and gives nothing back: a ${input.kind} rest needs ${needed} uninterrupted hour${needed === 1 ? '' : 's'}. Narrate what broke it off.`,
    };
  }

  if (input.kind === 'long') {
    pc.hp_current = pc.hp_max;
    pc.temp_hp = 0;
    pc.stable = false;
    pc.exhaustion = Math.max(0, pc.exhaustion - 1);
    pc.death_saves = { successes: 0, failures: 0 };
    removeCondition(pc, 'unconscious');
    for (const slot of Object.values(pc.spell_slots)) {
      slot.used = 0;
      delete slot.bonus;
    }
    pc.hit_dice.used = Math.max(0, pc.hit_dice.used - Math.max(1, Math.floor(pc.hit_dice.max / 2)));
    const restored = restoreResources(pc, 'long');
    const recharged = rechargeOnLongRest(pc);
    const clauseEffects = applyRestClauses(db, pc, 'long', roll);
    const mastery = input.mastery_weapons ? swapMasteryWeapons(pc, input.mastery_weapons) : null;
    const resisting = input.fiendish_resilience ? fiendishResilience(pc, input.fiendish_resilience) : null;
    return db.transaction((): RestResult => {
      savePc(db, pc);
      if (input.mirror !== false) mirrorIntoCombat(db, input.campaign_id, pc);
      logEvent(db, {
        campaign_id: input.campaign_id,
        kind: 'rest',
        text: `${pc.name} finishes a long rest: ${pc.hp_current}/${pc.hp_max} HP, all spell slots back, exhaustion ${pc.exhaustion}${
          mastery ? `, weapon drills on ${mastery.join(' and ')}` : ''
        }.`,
      });
      logRestClauses(db, input.campaign_id, pc.name, clauseEffects.applied);
      // A rest is time spent: the clock, the season and the weather move with it.
      const now = moveClock(LONG_REST_HOURS);
      const dropped = endConcentration(db, input.campaign_id, pc.id, 'a long rest');
      const stamp = stampLongRest(db, input.campaign_id, pc.id);
      return {
        name: pc.name,
        kind: 'long',
        ...(now ? { now } : {}),
        last_long_rest_at: stamp.text,
        ...(blocked && forced ? { rules_note: 'freeform: a second long rest inside 24 hours, allowed by the DM' } : {}),
        ...(dropped ? { concentration_ended: `${dropped.spell} ends: they slept.` } : {}),
        hp_current: pc.hp_current,
        hp_max: pc.hp_max,
        temp_hp: pc.temp_hp,
        exhaustion: pc.exhaustion,
        spell_slots: pc.spell_slots,
        hit_dice: pc.hit_dice,
        features_restored: restored,
        ...(clauseEffects.applied.length ? { rest_effects: clauseEffects.applied } : {}),
        ...(clauseEffects.notes.length ? { notes: clauseEffects.notes } : {}),
        ...(resisting ? { fiendish_resilience: resisting } : {}),
        ...(mastery ? { mastery_weapons: mastery } : {}),
        ...(recharged.length ? { items_recharged: recharged } : {}),
        attunement: attunementState(pc),
        conditions: pc.conditions,
      };
    })();
  }

  const spend = input.hit_dice_to_spend ?? 0;
  const available = pc.hit_dice.max - pc.hit_dice.used;
  if (spend < 0 || spend > available) {
    throw new Error(`${pc.name} has ${available} unspent ${pc.hit_dice.die} hit dice; cannot spend ${spend}.`);
  }
  let healed = 0;
  let rolled: string | null = null;
  if (spend > 0) {
    const result = roll({ expr: `${spend}${pc.hit_dice.die}`, purpose: 'Short rest hit dice' });
    rolled = result.output;
    healed = Math.max(0, result.total + spend * pc.abilities.con.mod);
    pc.hit_dice.used += spend;
    pc.hp_current = Math.min(pc.hp_max, pc.hp_current + healed);
    if (pc.hp_current > 0) {
      removeCondition(pc, 'unconscious');
      pc.death_saves = { successes: 0, failures: 0 };
      pc.stable = false;
    }
  }
  // Warlock Pact Magic comes back whole on a short rest; a Wizard may spend Arcane Recovery instead.
  const pactMagic = classOf(pc) === 'warlock';
  if (pactMagic) for (const slot of Object.values(pc.spell_slots)) slot.used = 0;
  const recoveryFeature = arcaneRecoveryFeature(pc);
  const recoveryAvailable = Boolean(recoveryFeature) && !recoveryFeature!.mechanics!.used;
  let recovered: string[] = [];
  if (input.arcane_recovery) {
    if (!recoveryFeature) throw new Error(`${pc.name} has no Arcane Recovery; that is a Wizard feature.`);
    if (!recoveryAvailable) throw new Error(`${pc.name} has already used Arcane Recovery; it comes back after a long rest.`);
    recovered = arcaneRecovery(pc).regained;
    recoveryFeature.mechanics!.used = 1;
  }
  // Natural Recovery buys back the same slot levels Arcane Recovery does, out of its own once-a-rest use.
  if (input.natural_recovery) {
    const row = requireRestFeature(pc, 'land-natural-recovery', 'natural_recovery', 'Natural Recovery');
    recovered = arcaneRecovery(pc).regained;
    row.mechanics!.used = 1;
  }
  const points = input.sorcerous_restoration ? sorcerousRestoration(pc) : null;
  const memorized = input.memorize_spell ? memorizeSpell(pc, input.memorize_spell) : null;
  const resisting = input.fiendish_resilience ? fiendishResilience(pc, input.fiendish_resilience) : null;
  const restored = restoreResources(pc, 'short');
  const clauseEffects = applyRestClauses(db, pc, 'short', roll);
  const focus = restFocus(pc, input);
  // Attuning turns a magic item on: the AC it adds only counts from here.
  if (focusing) recompute(pc);

  return db.transaction((): RestResult => {
    savePc(db, pc);
    if (input.mirror !== false) mirrorIntoCombat(db, input.campaign_id, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'rest',
      text: `${pc.name} finishes a short rest${spend ? `, spending ${spend} hit dice for ${healed} HP` : ''} (${pc.hp_current}/${pc.hp_max})${
        focusing
          ? `: ${[
              ...focus.attuned.map((name) => `attuned to ${name}`),
              ...focus.unattuned.map((name) => `no longer attuned to ${name}`),
              ...focus.identified.map((name) => `worked out what ${name} is`),
              ...focus.rulings.map((ruling) => `by DM ruling, ${ruling}`),
            ].join(', ')}`
          : ''
      }.`,
    });
    logRestClauses(db, input.campaign_id, pc.name, clauseEffects.applied);
    const now = moveClock(SHORT_REST_HOURS);
    const dropped = endConcentration(db, input.campaign_id, pc.id, 'a short rest');
    return {
      name: pc.name,
      kind: 'short',
      ...(now ? { now } : {}),
      ...(dropped ? { concentration_ended: `${dropped.spell} ends: they rested.` } : {}),
      hit_dice_spent: spend,
      roll: rolled,
      healed,
      hp_current: pc.hp_current,
      hp_max: pc.hp_max,
      hit_dice: pc.hit_dice,
      spell_slots: pc.spell_slots,
      pact_magic_restored: pactMagic,
      features_restored: restored,
      ...(clauseEffects.applied.length ? { rest_effects: clauseEffects.applied } : {}),
      ...(focus.attuned.length ? { attuned: focus.attuned } : {}),
      ...(focus.unattuned.length ? { unattuned: focus.unattuned } : {}),
      ...(focus.identified.length ? { identified: focus.identified } : {}),
      ...(focusing ? { attunement: attunementState(pc) } : {}),
      ...(focus.notes.length || clauseEffects.notes.length
        ? { notes: [...focus.notes, ...clauseEffects.notes] }
        : {}),
      ...(focus.rulings.length ? { rulings: focus.rulings } : {}),
      ...(recovered.length ? { arcane_recovery: recovered } : {}),
      ...(recoveryAvailable && !input.arcane_recovery
        ? { arcane_recovery_available: 'Pass arcane_recovery true to spend it for spell slots (once per long rest).' }
        : {}),
      ...(points === null ? {} : { sorcery_points_restored: points }),
      ...(memorized === null ? {} : { memorized_spell: memorized }),
      ...(resisting === null ? {} : { fiendish_resilience: resisting }),
    };
  })();
}

/**
 * Spends a slot, and - when the spell needs Concentration - records what the character is holding.
 * Starting a second one ends the first, as the rules have it.
 */
export function useSpellSlot(
  db: Db,
  input: { campaign_id: number; character_id?: number; level: number; spell?: string; target_item?: string },
) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  if (input.target_item !== undefined && (input.spell ?? '').trim().toLowerCase() !== 'identify') {
    throw new Error('target_item belongs to the Identify spell; pass spell "Identify" with it.');
  }
  const key = String(input.level);
  const slot = pc.spell_slots[key];
  if (!slot) {
    const have = Object.keys(pc.spell_slots).join(', ') || 'none';
    throw new Error(`${pc.name} has no level ${input.level} spell slots. Slot levels available: ${have}.`);
  }
  if (slotsLeft(slot) <= 0) throw new Error(`${pc.name} has no level ${input.level} slots left (${slot.max} per long rest).`);
  // A created slot is spent before the table's own, so it is the one lost when a long rest clears them.
  if (slot.bonus) slot.bonus -= 1;
  else slot.used += 1;
  const identified = input.target_item === undefined ? null : identifyItem(pc, input.target_item);
  const spell = input.spell ? concentrationSpell(db, input.campaign_id, input.spell) : null;
  return db.transaction(() => {
    savePc(db, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'spell_slot',
      text: `${pc.name} expends a level ${input.level} spell slot (${slotsLeft(slot)} left).`,
    });
    if (identified) {
      logEvent(db, {
        campaign_id: input.campaign_id,
        kind: 'inventory',
        text: `Identify reveals what ${identified} is to ${pc.name}.`,
        payload: { name: identified },
      });
    }
    // Concentration inside a fight is the engine's; this is the record for casting at the table.
    const holds = spell?.concentration === true && !inActiveEncounter(db, input.campaign_id, pc.id);
    const dropped = holds
      ? endConcentration(db, input.campaign_id, pc.id, `they start concentrating on ${input.spell}`)
      : null;
    let holding: ConcentrationRecord | null = null;
    if (holds) {
      holding = {
        spell: input.spell!,
        slot_level: input.level,
        started_at: nowState(db, input.campaign_id).date_text,
        duration: spell!.duration,
      };
      db.prepare('UPDATE character SET concentration_json = ? WHERE id = ?').run(JSON.stringify(holding), pc.id);
      logEvent(db, {
        campaign_id: input.campaign_id,
        kind: 'concentration',
        text: `${pc.name} concentrates on ${holding.spell}${holding.duration ? ` (${holding.duration})` : ''}.`,
        payload: holding,
      });
    }
    return {
      name: pc.name,
      level: input.level,
      remaining: slot.max - slot.used,
      spell_slots: pc.spell_slots,
      ...(identified ? { identified, item: findItem(pc, identified) } : {}),
      ...(holding ? { concentrating_on: holding } : {}),
      ...(dropped
        ? { concentration_ended: `${dropped.spell} ends: nobody concentrates on two spells at once.` }
        : {}),
    };
  })();
}

const atMaxLevel = (name: string): string =>
  `${name} is at level ${MAX_SUPPORTED_LEVEL}, the highest the SRD advancement table goes.`;

const statBlockLevelling = (name: string): string =>
  `${name} comes from a creature stat block, not a class, so there is no level table to advance: swap in a stronger creature instead.`;

/** What award_xp and grant_level answer with, in either xp_mode. */
export interface XpResult extends Record<string, unknown> {
  name: string;
  xp: number;
  level: number;
  /** The XP the next level needs, or null at level 20. */
  next_level_at?: number | null;
  xp_mode: 'xp' | 'milestone';
  level_up_available: boolean;
  level_up_options?: ReturnType<typeof levelUpOptions>;
  hint?: string;
  message?: string;
}

export function awardXp(
  db: Db,
  input: { campaign_id: number; character_id?: number; amount: number },
): XpResult {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  const xpMode = getSettings(db, input.campaign_id).xp_mode;
  if (!pc.class) {
    return {
      name: pc.name,
      xp: pc.xp,
      level: pc.level,
      xp_mode: xpMode,
      level_up_available: false,
      message: statBlockLevelling(pc.name),
    };
  }
  if (xpMode === 'milestone') {
    return {
      name: pc.name,
      xp: pc.xp,
      level: pc.level,
      xp_mode: 'milestone',
      level_up_available: false,
      message: `This campaign levels by milestone, so experience points are not counted. Call grant_level when ${pc.name} has earned the next level.`,
    };
  }
  pc.xp += input.amount;
  const reachable = levelForXp(pc.xp);
  return db.transaction((): XpResult => {
    savePc(db, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'xp',
      text: `${pc.name} gains ${input.amount} XP (${pc.xp} total, level ${pc.level}).`,
    });
    const levelUpAvailable = reachable > pc.level;
    return {
      name: pc.name,
      xp: pc.xp,
      level: pc.level,
      next_level_at: XP_THRESHOLDS[pc.level] ?? null,
      xp_mode: 'xp',
      level_up_available: levelUpAvailable,
      ...(levelUpAvailable
        ? {
            level_up_options: levelUpOptions(db, input.campaign_id, input.character_id),
            hint: PROPOSE_HINT,
          }
        : {}),
    };
  })();
}

const PROPOSE_HINT =
  "Call propose_level_up_options to put these options, and your own suggestions, in the player's level-up window.";

/**
 * Milestone advancement: the DM says the next level has been earned, so the character's experience
 * is moved up to its threshold and the usual level_up flow applies the player's choices.
 */
export function grantLevel(db: Db, input: { campaign_id: number; character_id?: number }): XpResult {
  if (getSettings(db, input.campaign_id).xp_mode !== 'milestone') {
    throw new Error("This campaign counts experience points: use award_xp, or set xp_mode to 'milestone' in settings.");
  }
  const pc = loadPc(db, input.campaign_id, input.character_id);
  if (!pc.class) throw new Error(statBlockLevelling(pc.name));
  const target = pc.level + 1;
  if (target > MAX_SUPPORTED_LEVEL) throw new Error(atMaxLevel(pc.name));
  pc.xp = Math.max(pc.xp, XP_THRESHOLDS[target - 1] ?? pc.xp);
  return db.transaction((): XpResult => {
    savePc(db, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'xp',
      text: `${pc.name} has earned level ${target} (milestone).`,
      payload: { level: target, milestone: true },
    });
    return {
      name: pc.name,
      level: pc.level,
      xp: pc.xp,
      xp_mode: 'milestone',
      level_up_available: true,
      level_up_options: levelUpOptions(db, input.campaign_id, input.character_id),
      hint: PROPOSE_HINT,
    };
  })();
}

const ASI = 'Ability Score Improvement';
const EPIC_BOON = 'Epic Boon';
/** What a Wizard copies into their spellbook at every level beyond the first. */
const WIZARD_SPELLS_PER_LEVEL = 2;

/** Extra Attack and its Fighter upgrades, by SRD feature name: attacks added to the Attack action. */
const EXTRA_ATTACKS: Record<string, number> = {
  'extra attack': 1,
  'two extra attacks': 2,
  'three extra attacks': 3,
};

const extraAttacksFor = (featureName: string): number | undefined => EXTRA_ATTACKS[featureName.toLowerCase()];

const generalFeats = (level: number): srd.FeatData[] =>
  srd.feats().filter((f) => f.type === 'general' && (f.prerequisites?.minimum_level ?? 1) <= level);

/** Whether the character already has a feat of this name (case-insensitive). */
const hasHeldFeat = (pc: { features: Feature[] }, name: string): boolean =>
  pc.features.some((f) => f.source === 'feat' && f.name.toLowerCase() === name.toLowerCase());

/** The Epic Boons of the SRD, or the general feats when the data carries none. */
const epicBoonFeats = (level: number): { feats: srd.FeatData[]; epic: boolean } => {
  const boons = srd.feats().filter((f) => f.type === 'epic-boon');
  return boons.length > 0 ? { feats: boons, epic: true } : { feats: generalFeats(level), epic: false };
};

interface ResourceSpec {
  resource: string;
  label: string;
  /** The rest that gives every use back, as the 2024 class tables have it. */
  per?: 'long' | 'short';
  /** What a short rest gives back to a resource that only fully returns on a long one. */
  regain_on_short?: 'one';
  die?: boolean;
}

/** The class_specific columns of the SRD level table, as resources a sheet can show. */
const CLASS_RESOURCES: Record<string, ResourceSpec> = {
  rage_count: { resource: 'rage', label: 'Rage', per: 'long', regain_on_short: 'one' },
  rage_damage_bonus: { resource: 'rage_damage', label: 'Rage Damage' },
  bardic_inspiration_die: { resource: 'bardic_inspiration_die', label: 'Bardic Inspiration Die', die: true },
  channel_divinity_charges: { resource: 'channel_divinity', label: 'Channel Divinity', per: 'long', regain_on_short: 'one' },
  wild_shape_uses: { resource: 'wild_shape', label: 'Wild Shape', per: 'long', regain_on_short: 'one' },
  second_wind_uses: { resource: 'second_wind', label: 'Second Wind', per: 'long', regain_on_short: 'one' },
  weapon_mastery: { resource: 'weapon_mastery', label: 'Weapon Mastery' },
  martial_arts_die: { resource: 'martial_arts_die', label: 'Martial Arts Die', die: true },
  focus_points: { resource: 'focus_points', label: 'Focus Points', per: 'short' },
  unarmored_movement_bonus: { resource: 'unarmored_movement', label: 'Unarmored Movement' },
  favored_enemies: { resource: 'favored_enemies', label: 'Favored Enemies' },
  sneak_attack: { resource: 'sneak_attack_dice', label: 'Sneak Attack' },
  sorcery_points: { resource: 'sorcery_points', label: 'Sorcery Points', per: 'long' },
  eldritch_invocations: { resource: 'invocations_known', label: 'Eldritch Invocations' },
};

/** Resources the level table has no column for, so their numbers come from the feature text instead. */
function derivedResources(pc: PcState, level: number): Array<ResourceSpec & { max: number }> {
  const out: Array<ResourceSpec & { max: number }> = [];
  const cls = classOf(pc);
  if (cls === 'bard') {
    out.push({
      resource: 'bardic_inspiration',
      label: 'Bardic Inspiration',
      max: Math.max(1, pc.abilities.cha.mod),
      // Font of Inspiration, at level 5, is what turns it into a short-rest resource.
      per: level >= 5 ? 'short' : 'long',
    });
  }
  if (cls === 'fighter' && level >= 2) {
    out.push({ resource: 'action_surge', label: 'Action Surge', max: level >= 17 ? 2 : 1, per: 'short' });
  }
  if (cls === 'wizard') {
    out.push({ resource: 'arcane_recovery', label: 'Arcane Recovery', max: 1, per: 'long' });
  }
  return out;
}

/** A class_specific cell as a number, plus the die size when the cell is a dice pool like Sneak Attack. */
function resourceValue(raw: unknown): { max: number; dice_value?: number } | null {
  if (typeof raw === 'number') return { max: raw };
  if (raw && typeof raw === 'object' && 'dice_count' in raw) {
    const dice = raw as { dice_count: number; dice_value: number };
    return { max: dice.dice_count, dice_value: dice.dice_value };
  }
  return null;
}

/** How a resource comes back, in the words the sheet shows. */
function recoveryText(spec: ResourceSpec): string {
  if (!spec.per) return '';
  if (spec.regain_on_short) return ` per long rest (one back on a short rest)`;
  return ` per ${spec.per} rest`;
}

function resourceFeature(spec: ResourceSpec, max: number, diceValue?: number): Feature {
  const amount = spec.die ? `d${max}` : diceValue ? `${max}d${diceValue}` : `${max}${recoveryText(spec)}`;
  return {
    name: spec.label,
    source: 'class',
    text: `${spec.label}: ${amount}.`,
    mechanics: {
      resource: spec.resource,
      max,
      ...(spec.per ? { per: spec.per, used: 0 } : {}),
      ...(spec.regain_on_short ? { regain_on_short: spec.regain_on_short } : {}),
    },
  };
}

/** The class resources whose number changes at this level, as features carrying the number. */
function resourceFeatures(pc: PcState, row: srd.LevelData, previous: srd.LevelData | undefined): Feature[] {
  const out: Feature[] = [];
  for (const [key, spec] of Object.entries(CLASS_RESOURCES)) {
    const value = resourceValue(row.class_specific?.[key]);
    if (!value || value.max <= 0) continue;
    const before = resourceValue(previous?.class_specific?.[key]);
    if (before && before.max === value.max) continue;
    out.push(resourceFeature(spec, value.max, value.dice_value));
  }
  for (const derived of derivedResources(pc, row.level)) {
    const held = pc.features.find((f) => f.mechanics?.resource === derived.resource);
    if (held && held.mechanics?.max === derived.max && held.mechanics.per === derived.per) continue;
    out.push(resourceFeature(derived, derived.max));
  }
  return out;
}

/** Puts a class resource on the sheet: onto the text feature of the same name when there is one, so a name appears once. */
function placeResourceFeature(pc: PcState, resource: Feature): void {
  const at = pc.features.findIndex((f) => f.mechanics?.resource === resource.mechanics!.resource);
  if (at >= 0) {
    // What was already spent stays spent: a level-up is not a rest, and the Weapon Mastery picks stay
    // too - as do the options chosen on a row that carries both a number and a choice, which the
    // Warlock's Eldritch Invocations does.
    const held = pc.features[at]!;
    const kept = held.mechanics ?? {};
    // A counter that rode onto SRD prose keeps the prose; a bare counter's own line takes the new number.
    const prose = !held.text.startsWith(`${resource.name}:`);
    pc.features[at] = {
      ...resource,
      ...(prose ? { name: held.name, source: held.source, text: held.text } : {}),
      mechanics: {
        ...resource.mechanics,
        ...(kept.used ? { used: kept.used } : {}),
        ...(kept.mastery_weapons ? { mastery_weapons: kept.mastery_weapons } : {}),
        ...(kept.options ? { options: kept.options } : {}),
        ...(kept.extra_attacks ? { extra_attacks: kept.extra_attacks } : {}),
      },
    };
    return;
  }
  const named = pc.features.find(
    (f) =>
      f.source === 'class' &&
      f.mechanics?.resource === undefined &&
      f.name.trim().toLowerCase() === resource.name.trim().toLowerCase(),
  );
  if (named) {
    // The SRD prose is the fuller description, so the counter rides on it rather than beside it.
    named.mechanics = { ...(named.mechanics ?? {}), ...resource.mechanics };
    return;
  }
  pc.features.push(resource);
}

/** Primal Champion and Body and Mind: the two scores each raises by 4, and the ceiling they raise to. */
const CAPSTONE_SCORES: Record<string, Ability[]> = {
  'Primal Champion': ['str', 'con'],
  'Body and Mind': ['dex', 'wis'],
};
const CAPSTONE_MAX = 25;

/** Words of Creation and its like: the spells a class feature keeps prepared beside the table's own. */
const ALWAYS_PREPARED_FEATURES: Record<string, string[]> = {
  'Words of Creation': ['Power Word Heal', 'Power Word Kill'],
};

/** Slippery Mind and Disciplined Survivor: the saving throws each makes its holder proficient in. */
const SAVE_PROFICIENCY_FEATURES: Record<string, Ability[]> = {
  'Slippery Mind': ['wis', 'cha'],
  'Disciplined Survivor': [...ABILITIES],
};

/**
 * What a class feature of levels 11 to 20 does to the sheet the moment it arrives: the four points
 * Primal Champion and Body and Mind each add to two scores, and the saving throws two features make
 * their holder proficient in. Everything else those levels bring is applied by the combat registry.
 */
function applyLevelFeature(pc: PcState, name: string): string[] {
  const notes: string[] = [];
  for (const ability of CAPSTONE_SCORES[name] ?? []) {
    const before = pc.abilities[ability].score;
    pc.abilities[ability].score = Math.min(CAPSTONE_MAX, before + 4);
    notes.push(`${ability.toUpperCase()} ${before} to ${pc.abilities[ability].score}`);
  }
  for (const ability of SAVE_PROFICIENCY_FEATURES[name] ?? []) {
    if (pc.saves[ability].proficient) continue;
    pc.saves[ability].proficient = true;
    notes.push(`${ability.toUpperCase()} saving throws`);
  }
  // Granted, so the spell sits beside what the table lets the character prepare rather than inside it.
  for (const spell of ALWAYS_PREPARED_FEATURES[name] ?? []) {
    if (hasKnownSpell(pc.spells.prepared, spell)) continue;
    pc.spells.prepared.push(spell);
    pc.spells.granted = [...(pc.spells.granted ?? []), spell];
    notes.push(`${spell} always prepared`);
  }
  return notes;
}

/**
 * The mechanics a class feature's own text carries, filled in the first time the feature is held.
 * Draconic Resilience raises the hit point maximum by 3 and by 1 at every Sorcerer level after it; the
 * per-level line below counts the level it arrives at, so the feature itself adds the other two.
 */
function applyFeatureNumbers(pc: PcState, classIndex: string): void {
  for (const feature of pc.features) {
    if (feature.mechanics?.hp_per_level !== undefined) continue;
    if (featureIndexOf(feature.name, classIndex) !== 'draconic-sorcery-draconic-resilience') continue;
    feature.mechanics = { ...feature.mechanics, hp_per_level: 1 };
    pc.hp_max += 2;
    pc.hp_current += 2;
  }
}

/** The subclass the character took, as its SRD entry. */
const chosenSubclass = (classIndex: string, subclass: string | null): srd.SubclassData | undefined =>
  subclass ? subclassesOf(classIndex).find((s) => s.name === subclass) : undefined;

/** What the SRD gives the character at the next level, and what the player still has to choose. */
export function levelUpOptions(db: Db, campaignId: number, characterId?: number) {
  const pc = loadPc(db, campaignId, characterId);
  const target = pc.level + 1;
  if (!pc.class) {
    return { supported: false, message: statBlockLevelling(pc.name) };
  }
  if (target > MAX_SUPPORTED_LEVEL) {
    return { supported: false, message: atMaxLevel(pc.name) };
  }
  const cls = findClass(pc.class);
  const row = classLevelRow(cls.index, target);
  const conMod = pc.abilities.con.mod;
  // Dwarven Toughness and its like ride on top of whichever hit point method is chosen.
  const perLevelHp = pc.features.reduce((sum, f) => sum + (f.mechanics?.hp_per_level ?? 0), 0);
  const options: Record<string, unknown> = {
    supported: true,
    from_level: pc.level,
    to_level: target,
    proficiency_bonus: row.prof_bonus ?? proficiencyBonus(target),
    hp: {
      average: Math.max(1, Math.floor(cls.hit_die / 2) + 1 + conMod) + perLevelHp,
      roll: `1d${cls.hit_die} + ${conMod} (CON)${perLevelHp ? ` + ${perLevelHp}` : ''}`,
      choose: ['average', 'roll'],
    },
    features: row.features
      .filter((f) => f.name !== ASI && f.name !== EPIC_BOON && !f.name.endsWith('Subclass'))
      .map((f) => {
        const extra = extraAttacksFor(f.name);
        return {
          name: f.name,
          text: featureText(f.index),
          ...(extra ? { mechanics: { extra_attacks: extra } } : {}),
        };
      }),
  };
  // The level table marks every level the subclass gives a feature at; only the first is a choice.
  if (row.features.some((f) => f.name.endsWith('Subclass')) && !pc.subclass) {
    options.subclass_choice = [
      ...subclassesOf(cls.index).map((s) => ({
        name: s.name,
        summary: s.summary ?? null,
        text: s.description,
      })),
      // The subclasses the DM wrote for this class stand beside the SRD one, with their id to send back.
      ...customSubclasses(db, campaignId, cls.name).map((entry) => ({
        name: entry.name,
        summary: null,
        text: String((entry.schema as Partial<SubclassSchema>).flavour_text ?? ''),
        homebrew: true,
        homebrew_id: entry.id,
        power_label: entry.power_label,
      })),
    ];
  }
  const customFeatures = customSubclassFeatures(db, pc.subclass_homebrew_id, target);
  const subclassFeatures = subclassLevelRow(chosenSubclass(cls.index, pc.subclass)?.index ?? '', target)?.features ?? [];
  if (customFeatures.length > 0) {
    options.subclass_features = customFeatures.map((f) => ({ name: f.name, text: f.text, homebrew: true }));
  } else if (subclassFeatures.length > 0) {
    options.subclass_features = subclassFeatures.map((f) => ({ name: f.name, text: featureText(f.index) }));
  }
  const resources = resourceFeatures(pc, row, classLevelRow(cls.index, pc.level));
  if (resources.length > 0) {
    options.resources = resources.map((f) => ({ name: f.name, text: f.text, mechanics: f.mechanics }));
  }
  const featureChoices = featureChoiceSpecs(pc, cls, target);
  if (featureChoices.length > 0) {
    options.feature_choices = featureChoices;
    options.feature_choices_rule =
      'Pass choices.feature_options as { "<feature name>": ["<pick>", ...] }; each pick must come from that feature\'s list.';
  }
  if (row.features.some((f) => f.name === ASI)) {
    options.ability_score_improvement = {
      rule: `Raise one ability score by 2 or two scores by 1 (maximum ${ABILITY_MAX}), or take a feat instead.`,
      feat_options: generalFeats(target)
        .filter((f) => f.repeatable || !hasHeldFeat(pc, f.name))
        .map((f) => ({ name: f.name, text: f.description, choices: featChoiceSpec(f) })),
    };
  }
  if (row.features.some((f) => f.name === EPIC_BOON)) {
    const { feats, epic } = epicBoonFeats(target);
    options.epic_boon = {
      epic,
      rule: epic
        ? `Level 19 gives an Epic Boon: choose one and pass it as the feat. It raises one ability by 1, to a maximum of ${EPIC_ABILITY_MAX}.`
        : 'Level 19 gives an Epic Boon; this SRD data has none, so choose a general feat instead.',
      feat_options: feats.map((f) => ({ name: f.name, text: f.description, choices: featChoiceSpec(f) })),
    };
  }
  if (cls.spellcasting && row.spellcasting) {
    const newCantrips = (row.spellcasting.cantrips_known ?? 0) - classSpellCount(pc.spells.cantrips, pc.spells.granted);
    const newSpells = (row.spellcasting.prepared_spells ?? 0) - classSpellCount(pc.spells.prepared, pc.spells.granted);
    const slots = slotsFromRow(row.spellcasting, pc.spell_slots);
    const maxSpellLevel = Math.max(...Object.keys(slots).map(Number));
    const cantripOptions =
      newCantrips > 0
        ? withCustomSpells(db, campaignId, cls.name, 0, spellsForClass(cls.index, 0)).filter(
            (name) => !hasKnownSpell(pc.spells.cantrips, name),
          )
        : [];
    const spellOptionsByLevel = newSpells > 0 ? customSpellOptions(db, campaignId, cls, maxSpellLevel) : {};
    const spellOptions = Object.fromEntries(
      Object.entries(spellOptionsByLevel).map(([level, names]) => [
        level,
        [
          ...names,
          // Magical Secrets: a Bard's new prepared spells may come off the Cleric, Druid and Wizard lists.
          ...(borrowsSpells(pc) ? OTHER_LISTS.flatMap((list) => spellsForClass(list, Number(level))) : []),
        ]
          .filter((name, at, all) => all.indexOf(name) === at)
          .filter((name) => !hasKnownSpell(pc.spells.known, name))
          .sort(),
      ]),
    );
    const allSpells = customSpellOptions(db, campaignId, cls, maxSpellLevel);
    options.spellcasting = {
      cantrips_to_add: Math.max(0, newCantrips),
      spells_to_add: Math.max(0, newSpells),
      cantrip_options: cantripOptions,
      spell_options: spellOptions,
      max_spell_level: maxSpellLevel,
      spell_slots: slots,
      // 2024 lets every caster swap one cantrip a level, and some classes one spell as well.
      replace_cantrip: {
        rule: 'Optional: choices.replace_cantrip {old, new} swaps one cantrip for another of this class.',
        held: pc.spells.cantrips,
        options: withCustomSpells(db, campaignId, cls.name, 0, spellsForClass(cls.index, 0)).filter(
          (name) => !hasKnownSpell(pc.spells.cantrips, name),
        ),
      },
      ...(SWAP_CLASSES.includes(cls.index)
        ? {
            replace_spell: {
              rule: `Optional: choices.replace_spell {old, new} swaps one ${cls.name} spell of level 1-${maxSpellLevel}.`,
              held: pc.spells.prepared,
              options: Object.fromEntries(
                Object.entries(allSpells).map(([level, names]) => [
                  level,
                  names.filter((name) => !hasKnownSpell(pc.spells.known, name)),
                ]),
              ),
            },
          }
        : {}),
      ...(cls.index === 'wizard'
        ? {
            spellbook: {
              rule: `A Wizard copies ${WIZARD_SPELLS_PER_LEVEL} new spells into their spellbook each level: pass choices.spellbook as ${WIZARD_SPELLS_PER_LEVEL} spell names of level 1-${maxSpellLevel}.`,
              to_add: WIZARD_SPELLS_PER_LEVEL,
              held: pc.spells.spellbook ?? [],
              options: Object.fromEntries(
                Object.entries(allSpells).map(([level, names]) => [
                  level,
                  names.filter((name) => !hasKnownSpell(pc.spells.spellbook ?? [], name)),
                ]),
              ),
            },
          }
        : {}),
    };
  }
  return options;
}

export interface LevelUpChoices {
  hp?: 'average' | 'roll';
  subclass?: string;
  /** A subclass the DM wrote, chosen by its homebrew id instead of an SRD name. */
  subclass_homebrew_id?: number;
  ability_increases?: Partial<Record<Ability, number>>;
  feat?: string;
  /** What the feat itself asks for: which ability, which skills, which spells. */
  feat_choices?: FeatChoices;
  /** Picks for the features that are themselves a choice, keyed by the feature's name. */
  feature_options?: Record<string, string[]>;
  cantrips?: string[];
  spells?: string[];
  /** The 2024 cantrip swap every caster gets on levelling. */
  replace_cantrip?: { old: string; new: string };
  /** The spell swap the classes that "replace one spell" get on levelling. */
  replace_spell?: { old: string; new: string };
  /** A Wizard's two new spellbook pages. */
  spellbook?: string[];
  /** Homebrew or library entries the player picked in the level-up window. */
  homebrew_ids?: number[];
}

/**
 * The suggestions the DM prepared: the ones the player took are marked chosen, the rest are dropped,
 * so the window's offers do not pile up in the campaign's homebrew after the level-up.
 */
function settleSuggestions(db: Db, characterId: number, chosen: number[]): void {
  const row = db.prepare('SELECT pending_level_up_json FROM character WHERE id = ?').get(characterId) as
    | { pending_level_up_json: string | null }
    | undefined;
  if (!row?.pending_level_up_json) return;
  let suggestions: Array<{ homebrew_id?: number }>;
  try {
    suggestions = (JSON.parse(row.pending_level_up_json) as { suggestions?: Array<{ homebrew_id?: number }> }).suggestions ?? [];
  } catch {
    return;
  }
  for (const suggestion of suggestions) {
    const id = suggestion.homebrew_id;
    if (id === undefined) continue;
    if (!chosen.includes(id)) {
      db.prepare("DELETE FROM homebrew WHERE id = ? AND scope = 'campaign'").run(id);
      continue;
    }
    const entry = getHomebrew(db, id);
    if (entry) {
      db.prepare('UPDATE homebrew SET schema_json = ? WHERE id = ?').run(
        JSON.stringify({ ...entry.schema, chosen: true }),
        id,
      );
    }
  }
}

export function levelUp(db: Db, input: { campaign_id: number; character_id?: number; choices?: LevelUpChoices }) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  const choices = input.choices ?? {};
  const target = pc.level + 1;
  if (!pc.class) {
    throw new Error(statBlockLevelling(pc.name));
  }
  if (target > MAX_SUPPORTED_LEVEL) {
    throw new Error(atMaxLevel(pc.name));
  }
  if (levelForXp(pc.xp) < target) {
    throw new Error(`${pc.name} needs more XP for level ${target}; they have ${pc.xp}.`);
  }
  const cls = findClass(pc.class);
  const row = classLevelRow(cls.index, target);
  const gained: string[] = [];

  // Subclass first: its level features are added with the class features below.
  if (row.features.some((f) => f.name.endsWith('Subclass')) && !pc.subclass) {
    const available = subclassesOf(cls.index);
    const custom = customSubclasses(db, input.campaign_id, cls.name);
    const names = [...available.map((s) => s.name), ...custom.map((entry) => entry.name)].join(', ');
    // The window sends a custom subclass as an id; a name still picks the SRD one.
    const homebrewId =
      choices.subclass_homebrew_id ??
      (choices.homebrew_ids ?? []).find((id) => getHomebrew(db, id)?.kind === 'subclass') ??
      (choices.subclass ? custom.find((entry) => entry.name.toLowerCase() === choices.subclass!.trim().toLowerCase())?.id : undefined);
    if (homebrewId !== undefined) {
      const entry = getHomebrew(db, homebrewId);
      if (!entry || entry.kind !== 'subclass') throw new Error(`No custom subclass with id ${homebrewId}.`);
      const schema = entry.schema as Partial<SubclassSchema>;
      if (String(schema.class ?? '').toLowerCase() !== cls.name.toLowerCase()) {
        throw new Error(`"${entry.name}" is a ${schema.class} subclass, not a ${cls.name} one.`);
      }
      pc.subclass = entry.name;
      pc.subclass_homebrew_id = entry.id;
      for (const level of Object.keys(schema.features ?? {}).map(Number).sort((a, b) => a - b)) {
        if (level > target) continue;
        for (const feature of customSubclassFeatures(db, entry.id, level)) {
          pc.features.push({
            name: feature.name,
            source: 'subclass',
            text: feature.text,
            mechanics: { homebrew_id: entry.id, ...(entry.power_label === 'over_budget' ? { over_budget: true } : {}) },
          });
          gained.push(feature.name);
        }
      }
    } else {
      if (!choices.subclass) {
        throw new Error(`Level ${target} ${cls.name} must choose a subclass: ${names}.`);
      }
      const picked = available.find((s) => s.name.toLowerCase() === choices.subclass!.trim().toLowerCase());
      if (!picked) {
        throw new Error(`Unknown subclass "${choices.subclass}". Options: ${names}.`);
      }
      pc.subclass = picked.name;
      for (const feature of picked.features.filter((f) => f.level <= target)) {
        pc.features.push({ name: feature.name, source: 'subclass', text: feature.description });
        gained.push(feature.name);
      }
    }
  }

  if (row.features.some((f) => f.name === ASI)) {
    const increases = choices.ability_increases;
    if (increases && Object.keys(increases).length > 0) {
      const total = ABILITIES.reduce((sum, a) => sum + (increases[a] ?? 0), 0);
      if (total !== 2 || ABILITIES.some((a) => (increases[a] ?? 0) < 0 || (increases[a] ?? 0) > 2)) {
        throw new Error('An Ability Score Improvement raises one score by 2 or two scores by 1.');
      }
      for (const ability of ABILITIES) {
        const bump = increases[ability] ?? 0;
        if (!bump) continue;
        raiseAbility(pc, ability, bump, ABILITY_MAX);
      }
      pc.features.push({
        name: ASI,
        source: 'feat',
        text: `Raised ${ABILITIES.filter((a) => increases[a]).map((a) => `${a.toUpperCase()} +${increases[a]}`).join(', ')} at level ${target}.`,
      });
      gained.push(ASI);
    } else if (choices.feat) {
      const feat = findFeat(choices.feat);
      if (feat.type !== 'general' || (feat.prerequisites?.minimum_level ?? 1) > target) {
        throw new Error(`"${feat.name}" is not a general feat available at level ${target}.`);
      }
      assertFeatPrerequisites(pc, feat);
      const notes = applyFeat(db, pc, feat, choices.feat_choices, input.campaign_id);
      gained.push(notes.length ? `${feat.name} (${notes.join(', ')})` : feat.name);
    } else {
      throw new Error(
        `Level ${target} gives an Ability Score Improvement: pass ability_increases (+2 to one score or +1 to two) or a feat.`,
      );
    }
  }

  if (row.features.some((f) => f.name === EPIC_BOON)) {
    const { feats, epic } = epicBoonFeats(target);
    const names = feats.map((f) => f.name).join(', ');
    if (!choices.feat) {
      throw new Error(
        `Level ${target} gives an Epic Boon: pass feat with one of ${names}.`,
      );
    }
    const feat = findFeat(choices.feat);
    if (!feats.some((f) => f.index === feat.index)) {
      throw new Error(`"${feat.name}" is not ${epic ? 'an Epic Boon' : 'a feat available'} at level ${target}. Options: ${names}.`);
    }
    assertFeatPrerequisites(pc, feat);
    const notes = applyFeat(db, pc, feat, choices.feat_choices, input.campaign_id);
    gained.push(notes.length ? `${feat.name} (${notes.join(', ')})` : feat.name);
  }

  for (const feature of row.features) {
    if (feature.name === ASI || feature.name === EPIC_BOON || feature.name.endsWith('Subclass')) continue;
    const extra = extraAttacksFor(feature.name);
    pc.features.push({
      name: feature.name,
      source: 'class',
      text: featureText(feature.index),
      ...(extra ? { mechanics: { extra_attacks: extra } } : {}),
    });
    // Primal Champion, Body and Mind, Slippery Mind and Disciplined Survivor change the sheet itself.
    const applied = applyLevelFeature(pc, feature.name);
    gained.push(applied.length ? `${feature.name} (${applied.join(', ')})` : feature.name);
  }
  // A custom subclass carries its own bundles; an SRD one reads them off the level table.
  for (const feature of customSubclassFeatures(db, pc.subclass_homebrew_id, target)) {
    if (pc.features.some((f) => f.name === feature.name)) continue;
    pc.features.push({
      name: feature.name,
      source: 'subclass',
      text: feature.text,
      mechanics: { homebrew_id: pc.subclass_homebrew_id! },
    });
    gained.push(feature.name);
  }
  const subclassRow = subclassLevelRow(chosenSubclass(cls.index, pc.subclass)?.index ?? '', target);
  for (const feature of subclassRow?.features ?? []) {
    if (pc.features.some((f) => f.name === feature.name)) continue;
    pc.features.push({ name: feature.name, source: 'subclass', text: featureText(feature.index) });
    const applied = applyLevelFeature(pc, feature.name);
    gained.push(applied.length ? `${feature.name} (${applied.join(', ')})` : feature.name);
  }
  // The numbers a feature's own text carries that the level table has no column for: Draconic Resilience's
  // hit points. The feature arrives with 3, and the per-level rule below already counts one of them.
  applyFeatureNumbers(pc, cls.index);
  // A resource the table gives a new number for replaces the entry the earlier level left behind.
  for (const resource of resourceFeatures(pc, row, classLevelRow(cls.index, pc.level))) {
    placeResourceFeature(pc, resource);
    gained.push(resource.text);
  }
  const featureChoices = applyFeatureChoices(pc, featureChoiceSpecs(pc, cls, target), choices.feature_options);
  gained.push(...featureChoices.applied);

  if (cls.spellcasting && row.spellcasting) {
    const slots = slotsFromRow(row.spellcasting, pc.spell_slots);
    const maxSpellLevel = Math.max(...Object.keys(slots).map(Number));
    const newCantrips = Math.max(0, (row.spellcasting.cantrips_known ?? 0) - classSpellCount(pc.spells.cantrips, pc.spells.granted));
    const newSpells = Math.max(0, (row.spellcasting.prepared_spells ?? 0) - classSpellCount(pc.spells.prepared, pc.spells.granted));
    validateSpellPicks(
      cls.index,
      cls.name,
      choices.cantrips ?? [],
      0,
      newCantrips,
      'new cantrips',
      customSpells(db, input.campaign_id, cls.name, 0).map((entry) => entry.name),
    );
    assertSpellsNotAlreadyKnown(choices.cantrips ?? [], pc.spells.cantrips);
    if ((choices.spells ?? []).length !== newSpells) {
      throw new Error(
        `Level ${target} ${cls.name} adds ${newSpells} prepared spell(s) of level 1-${maxSpellLevel}; got ${(choices.spells ?? []).length}.`,
      );
    }
    assertSpellsNotAlreadyKnown(choices.spells ?? [], pc.spells.known);
    // The book grows first: a Wizard's new prepared spells are copied out of it.
    gained.push(...applySpellbookGrowth(db, pc, cls, choices, maxSpellLevel, input.campaign_id));
    for (const name of choices.spells ?? []) {
      if (isWizard(pc)) {
        if (hasKnownSpell(pc.spells.spellbook ?? [], name)) continue;
        throw new Error(
          `"${name}" is not in ${pc.name}'s spellbook. A Wizard prepares from the book: ${(pc.spells.spellbook ?? []).join(', ')}.`,
        );
      }
      const spell = findSpell(name);
      const lists = borrowsSpells(pc) ? [cls.index, ...OTHER_LISTS] : [cls.index];
      const srdOk =
        spell && spell.level >= 1 && spell.level <= maxSpellLevel && lists.some((list) => spell.classes.some((c) => c.endsWith(`_${list}`)));
      if (srdOk) continue;
      if (eligibleCustomSpell(db, input.campaign_id, cls.name, name, { min: 1, max: maxSpellLevel })) continue;
      throw new Error(`"${name}" is not a ${cls.name} spell of level 1-${maxSpellLevel}.`);
    }
    pc.spells.cantrips.push(...(choices.cantrips ?? []));
    pc.spells.known.push(...(choices.spells ?? []));
    pc.spells.prepared.push(...(choices.spells ?? []));
    pc.spells.cantrips = uniqueSpells(pc.spells.cantrips);
    pc.spells.known = uniqueSpells(pc.spells.known);
    pc.spells.prepared = uniqueSpells(pc.spells.prepared);
    pc.spell_slots = slots;
    gained.push(...applySpellSwaps(db, pc, cls, choices, maxSpellLevel, input.campaign_id));
  }

  for (const id of choices.homebrew_ids ?? []) {
    const entry = getHomebrew(db, id);
    if (!entry) throw new Error(`No homebrew with id ${id}. Call list_library to see what is there.`);
    // A subclass was already applied above; a spell goes on the spell list, not the feature list.
    if (entry.kind === 'subclass') continue;
    if (entry.kind === 'spell') {
      throw new Error(`"${entry.name}" is a spell: pass it by name in choices.spells, not in homebrew_ids.`);
    }
    const schema = entry.schema as { text?: string };
    pc.features.push({
      name: entry.name,
      source: 'homebrew',
      text: schema.text ?? '',
      mechanics: { homebrew_id: entry.id, ...(entry.power_label === 'over_budget' ? { over_budget: true } : {}) },
    });
    gained.push(entry.name);
  }

  const conModBefore = pc.abilities.con.mod;
  const hpRoll = choices.hp === 'roll';
  let hpGain: number;
  if (hpRoll) {
    const roll = rollAndRecord(db, {
      expr: `1d${cls.hit_die}`,
      purpose: `Level ${target} hit points`,
      campaign_id: input.campaign_id,
    });
    hpGain = Math.max(1, roll.total + abilityMod(pc.abilities.con.score));
  } else {
    hpGain = Math.max(1, Math.floor(cls.hit_die / 2) + 1 + abilityMod(pc.abilities.con.score));
  }
  // A CON bump also raises every earlier level's hit points.
  const conModAfter = abilityMod(pc.abilities.con.score);
  const retroHp = (conModAfter - conModBefore) * pc.level;
  // Dwarven Toughness and its like add their hit point again at every level.
  const perLevelHp = pc.features.reduce((sum, f) => sum + (f.mechanics?.hp_per_level ?? 0), 0);
  pc.hp_max += hpGain + retroHp + perLevelHp;
  pc.hp_current += hpGain + retroHp + perLevelHp;
  pc.level = target;
  pc.hit_dice.max = target;
  recompute(pc);

  return db.transaction(() => {
    savePc(db, pc);
    settleSuggestions(db, pc.id, choices.homebrew_ids ?? []);
    db.prepare('UPDATE character SET pending_level_up_json = NULL WHERE id = ?').run(pc.id);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'level_up',
      text: `${pc.name} reaches level ${target}: +${hpGain + retroHp + perLevelHp} HP (${pc.hp_max} max)${gained.length ? `, gains ${gained.join(', ')}` : ''}.`,
      payload: { level: target, features: gained },
    });
    return {
      name: pc.name,
      level: target,
      hp_gained: hpGain + retroHp + perLevelHp,
      hp_roll: hpRoll,
      features_gained: gained,
      ...(featureChoices.chosen_for_you.length ? { features_chosen_for_you: featureChoices.chosen_for_you } : {}),
      subclass: pc.subclass,
      character: sheet(db, input.campaign_id, input.character_id),
    };
  })();
}

// --- the prepared list, the spellbook and the level-up swaps ------------------

/** The spell as this class's list spells it, or an error naming what may be taken instead. */
function assertClassSpell(
  db: Db,
  campaignId: number,
  cls: srd.ClassData,
  name: string,
  maxSpellLevel: number,
): void {
  const spell = findSpell(name);
  if (spell && spell.level >= 1 && spell.level <= maxSpellLevel && spell.classes.some((c) => c.endsWith(`_${cls.index}`))) return;
  if (eligibleCustomSpell(db, campaignId, cls.name, name, { min: 1, max: maxSpellLevel })) return;
  throw new Error(`"${name}" is not a ${cls.name} spell of level 1-${maxSpellLevel}.`);
}

const spellIndexOf = (list: string[], name: string): number =>
  list.findIndex((held) => held.toLowerCase() === name.trim().toLowerCase());

/** The 2024 swaps a level brings: one cantrip for every caster, one spell for the classes that say so. */
function applySpellSwaps(
  db: Db,
  pc: PcState,
  cls: srd.ClassData,
  choices: LevelUpChoices,
  maxSpellLevel: number,
  campaignId: number,
): string[] {
  const notes: string[] = [];
  const cantripSwap = choices.replace_cantrip;
  if (cantripSwap) {
    const at = spellIndexOf(pc.spells.cantrips, cantripSwap.old);
    if (at < 0) {
      throw new Error(`${pc.name} does not know the cantrip "${cantripSwap.old}". They know: ${pc.spells.cantrips.join(', ') || 'none'}.`);
    }
    if (hasKnownSpell(pc.spells.cantrips, cantripSwap.new)) throw new Error(`"${cantripSwap.new}" is already known.`);
    validateSpellPicks(
      cls.index,
      cls.name,
      [cantripSwap.new],
      0,
      1,
      'cantrips',
      customSpells(db, campaignId, cls.name, 0).map((entry) => entry.name),
    );
    pc.spells.cantrips[at] = cantripSwap.new;
    notes.push(`swapped the cantrip ${cantripSwap.old} for ${cantripSwap.new}`);
  }
  const spellSwap = choices.replace_spell;
  if (!spellSwap) return notes;
  if (!SWAP_CLASSES.includes(cls.index)) {
    throw new Error(
      isWizard(pc)
        ? `A Wizard changes their prepared spells after a Long Rest with prepare_spells, not on levelling.`
        : `A ${cls.name} changes their prepared list after a Long Rest with prepare_spells, not on levelling.`,
    );
  }
  const at = spellIndexOf(pc.spells.prepared, spellSwap.old);
  if (at < 0) {
    throw new Error(`${pc.name} does not have "${spellSwap.old}" prepared. They have: ${pc.spells.prepared.join(', ') || 'none'}.`);
  }
  if (hasKnownSpell(pc.spells.known, spellSwap.new)) throw new Error(`"${spellSwap.new}" is already known.`);
  assertClassSpell(db, campaignId, cls, spellSwap.new, maxSpellLevel);
  pc.spells.prepared[at] = spellSwap.new;
  const knownAt = spellIndexOf(pc.spells.known, spellSwap.old);
  if (knownAt >= 0) pc.spells.known[knownAt] = spellSwap.new;
  notes.push(`swapped ${spellSwap.old} for ${spellSwap.new}`);
  return notes;
}

/** Every Wizard level copies two more spells into the book the prepared list is drawn from. */
function applySpellbookGrowth(
  db: Db,
  pc: PcState,
  cls: srd.ClassData,
  choices: LevelUpChoices,
  maxSpellLevel: number,
  campaignId: number,
): string[] {
  if (cls.index !== 'wizard') {
    if (choices.spellbook?.length) throw new Error(`Only a Wizard keeps a spellbook; a ${cls.name} does not.`);
    return [];
  }
  const book = pc.spells.spellbook ?? [...pc.spells.known];
  const picks = choices.spellbook ?? [];
  if (picks.length !== WIZARD_SPELLS_PER_LEVEL) {
    throw new Error(
      `A Wizard copies ${WIZARD_SPELLS_PER_LEVEL} new spells of level 1-${maxSpellLevel} into their spellbook at every level: pass choices.spellbook with ${WIZARD_SPELLS_PER_LEVEL} names; got ${picks.length}.`,
    );
  }
  assertSpellsNotAlreadyKnown(picks, book);
  for (const name of picks) assertClassSpell(db, campaignId, cls, name, maxSpellLevel);
  book.push(...picks);
  pc.spells.spellbook = book;
  return [`spellbook: ${picks.join(', ')}`];
}

/** What a class may prepare from: a Wizard's book, everyone else's whole class list. */
function preparablePool(db: Db, campaignId: number, pc: PcState, cls: srd.ClassData, maxSpellLevel: number): string[] {
  if (isWizard(pc)) return [...(pc.spells.spellbook ?? pc.spells.known)];
  const byLevel = customSpellOptions(db, campaignId, cls, maxSpellLevel);
  return Object.values(byLevel).flat();
}

/**
 * The Long Rest re-preparation of the classes whose whole list changes: Cleric, Druid, Paladin and
 * Wizard. The list must be exactly as long as the class table allows and every spell must be castable.
 */
export function prepareSpells(db: Db, input: { campaign_id: number; character_id?: number; spells: string[] }) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  if (!pc.class || !pc.spells.spellcasting_ability) throw new Error(`${pc.name} casts no spells.`);
  const cls = findClass(pc.class);
  if (!PREPARING_CLASSES.includes(cls.index)) {
    throw new Error(
      `A ${cls.name} does not re-prepare their spells: their list changes only when they gain a level (choices.replace_spell). Preparing classes: ${PREPARING_CLASSES.join(', ')}.`,
    );
  }
  const row = classLevelRow(cls.index, pc.level);
  const count = row.spellcasting?.prepared_spells ?? 0;
  const maxSpellLevel = Math.max(...Object.keys(slotsFromRow(row.spellcasting)).map(Number));
  const pool = preparablePool(db, input.campaign_id, pc, cls, maxSpellLevel);
  if (input.spells.length !== count) {
    throw new Error(
      `A level ${pc.level} ${cls.name} prepares ${count} spells of level 1-${maxSpellLevel}; got ${input.spells.length}. Legal pool: ${pool.join(', ')}.`,
    );
  }
  const chosen: string[] = [];
  for (const name of input.spells) {
    const match = pool.find((option) => option.toLowerCase() === name.trim().toLowerCase());
    if (!match) {
      throw new Error(
        isWizard(pc)
          ? `"${name}" is not in ${pc.name}'s spellbook. Legal pool: ${pool.join(', ')}.`
          : `"${name}" is not a ${cls.name} spell of level 1-${maxSpellLevel}. Legal pool: ${pool.join(', ')}.`,
      );
    }
    if (chosen.some((held) => held.toLowerCase() === match.toLowerCase())) {
      throw new Error(`"${match}" is already on the list; prepare each spell once.`);
    }
    chosen.push(match);
  }
  const granted = (pc.spells.granted ?? []).filter((name) => findSpell(name)?.level !== 0);
  pc.spells.prepared = [...chosen, ...granted.filter((name) => !hasKnownSpell(chosen, name))];
  if (!isWizard(pc)) pc.spells.known = [...pc.spells.prepared];
  return db.transaction(() => {
    savePc(db, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'feature',
      text: `${pc.name} prepares ${chosen.join(', ')}.`,
      payload: { prepared: chosen },
    });
    return { name: pc.name, prepared: chosen, prepared_count: count, max_spell_level: maxSpellLevel };
  })();
}

/**
 * A spell found in play copied into a Wizard's spellbook. What it costs in gold and hours is the DM's
 * to narrate; the sheet only records that the page is now there.
 */
export function learnSpell(db: Db, input: { campaign_id: number; character_id?: number; spell: string }) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  if (!isWizard(pc)) throw new Error(`${pc.name} keeps no spellbook; only a Wizard copies spells into one.`);
  const maxSpellLevel = Math.max(...Object.keys(pc.spell_slots).map(Number), 1);
  const cls = findClass(pc.class!);
  assertClassSpell(db, input.campaign_id, cls, input.spell, maxSpellLevel);
  const book = pc.spells.spellbook ?? [...pc.spells.known];
  if (hasKnownSpell(book, input.spell)) {
    return { name: pc.name, added: false, spellbook: book, reason: `"${input.spell}" is already in the spellbook.` };
  }
  book.push(input.spell);
  pc.spells.spellbook = book;
  return db.transaction(() => {
    savePc(db, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'feature',
      text: `${pc.name} copies ${input.spell} into their spellbook.`,
      payload: { spell: input.spell },
    });
    return { name: pc.name, added: true, spellbook: book };
  })();
}

/**
 * Puts a spell on the sheet: a cantrip among the cantrips, anything else among the known and
 * prepared spells. A character with no spellcasting keeps none of it.
 */
export function grantSpell(
  db: Db,
  input: { campaign_id: number; character_id?: number; name: string; level: number },
): { added: boolean; where: 'cantrips' | 'prepared' | null; reason?: string } {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  if (!pc.spells.spellcasting_ability) {
    return { added: false, where: null, reason: `${pc.name} casts no spells, so "${input.name}" is not on their sheet.` };
  }
  const where = input.level === 0 ? 'cantrips' : 'prepared';
  const known = [...pc.spells.cantrips, ...pc.spells.known, ...pc.spells.prepared];
  if (known.some((name) => name.toLowerCase() === input.name.trim().toLowerCase())) {
    return { added: false, where, reason: `${pc.name} already knows "${input.name}".` };
  }
  if (input.level === 0) {
    pc.spells.cantrips.push(input.name);
    pc.spells.cantrips = uniqueSpells(pc.spells.cantrips);
  } else {
    pc.spells.known.push(input.name);
    pc.spells.prepared.push(input.name);
    pc.spells.known = uniqueSpells(pc.spells.known);
    pc.spells.prepared = uniqueSpells(pc.spells.prepared);
    // A Wizard prepares out of the book, so a spell given to one is written into it.
    if (isWizard(pc)) pc.spells.spellbook = [...(pc.spells.spellbook ?? []), input.name];
  }
  return db.transaction(() => {
    savePc(db, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'feature',
      text: `${pc.name} learns ${input.name}.`,
      payload: { name: input.name, source: 'homebrew', spell_level: input.level },
    });
    return { added: true, where } as { added: boolean; where: 'cantrips' | 'prepared' | null };
  })();
}

/**
 * A spell handed to a non-Wizard outside a level-up: a pick that was lost, a boon, a quest reward.
 * It must be on their class list and no higher than they can cast, and the ruling goes in the log.
 */
export function grantSpellRuling(
  db: Db,
  input: { campaign_id: number; character_id?: number; spell: string; reason: string },
) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  if (isWizard(pc)) {
    throw new Error(`${pc.name} keeps a spellbook: write "${input.spell}" into it with learn_spell.`);
  }
  if (!pc.class || !pc.spells.spellcasting_ability) throw new Error(`${pc.name} casts no spells.`);
  const cls = findClass(pc.class);
  const maxSpellLevel = Math.max(...Object.keys(pc.spell_slots).map(Number), 1);
  const level =
    eligibleCustomSpell(db, input.campaign_id, cls.name, input.spell, { min: 0, max: maxSpellLevel })?.level ??
    findSpell(input.spell)?.level ??
    -1;
  if (level === 0) {
    const custom = customSpells(db, input.campaign_id, cls.name, 0).map((entry) => entry.name);
    validateSpellPicks(cls.index, cls.name, [input.spell], 0, 1, 'cantrips', custom);
  } else {
    assertClassSpell(db, input.campaign_id, cls, input.spell, maxSpellLevel);
  }
  const granted = grantSpell(db, {
    campaign_id: input.campaign_id,
    character_id: input.character_id,
    name: input.spell,
    level,
  });
  if (granted.added) {
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'feature',
      text: `${pc.name} learns ${input.spell} (DM ruling: ${input.reason}).`,
      payload: { name: input.spell, spell_level: level, reason: input.reason, ruling: true },
    });
  }
  const after = loadPc(db, input.campaign_id, input.character_id);
  return {
    name: pc.name,
    added: granted.added,
    where: granted.where,
    spells: after.spells,
    ...(granted.reason ? { reason: granted.reason } : {}),
  };
}

export function grantFeature(
  db: Db,
  input: {
    campaign_id: number;
    character_id?: number;
    name: string;
    text: string;
    source: 'homebrew' | 'feat';
    mechanics?: FeatureMechanics;
    /** A story boon propose_feature handed out: what the one-per-chapter cadence counts. */
    boon?: boolean;
  },
) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  pc.features.push({
    name: input.name,
    source: input.source,
    text: input.text,
    ...(input.mechanics ? { mechanics: input.mechanics } : {}),
  });
  // The new row's clauses have to be on it before the armour class column is worked out again.
  fillClauses(db, pc.features, pc.level);
  recompute(pc);
  return db.transaction(() => {
    savePc(db, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'feature',
      text: `${pc.name} gains ${input.name} (${input.source}).`,
      payload: { name: input.name, source: input.source, ...(input.boon ? { boon: true } : {}) },
    });
    return { name: pc.name, features: pc.features };
  })();
}

/**
 * Works the derived numbers out again for everyone in this campaign holding a piece of homebrew that
 * was just restated: a clause that gives Armor Class lands in the column, which the fight reads.
 */
export function refreshHomebrewHolders(db: Db, campaignId: number, homebrewId: number): number {
  const rows = db
    .prepare('SELECT id, features_json FROM character WHERE campaign_id = ?')
    .all(campaignId) as Array<{ id: number; features_json: string | null }>;
  let touched = 0;
  for (const row of rows) {
    if (!row.features_json?.includes(`"homebrew_id":${homebrewId}`)) continue;
    const pc = loadPc(db, campaignId, row.id);
    recompute(pc);
    savePc(db, pc);
    touched += 1;
  }
  return touched;
}

// --- languages in play --------------------------------------------------------

/**
 * A language the DM invented for this campaign. It is stored as a glossary entry, so it shows up in the
 * briefing's glossary as well as among the languages a character may choose or learn.
 */
export function addLanguage(
  db: Db,
  input: { campaign_id: number; name: string; speakers: string; script?: string },
) {
  const name = input.name.trim();
  if (!name) throw new Error('A language needs a name.');
  if (findLanguage(name)) throw new Error(`"${name}" is already an SRD language; add_language is for new ones.`);
  const definition = `${LANGUAGE_MARK} Spoken by ${input.speakers.trim()}.${input.script ? ` Script: ${input.script.trim()}.` : ''}`;
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO glossary_entry (campaign_id, term, definition, source, created_at) VALUES (?, ?, ?, 'campaign', ?)
       ON CONFLICT (campaign_id, term) DO UPDATE SET definition = excluded.definition`,
    ).run(input.campaign_id, name, definition, nowIso());
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'system',
      text: `${name} joins the campaign's languages: spoken by ${input.speakers.trim()}.`,
      payload: { language: name },
    });
    return { name, definition, languages: languageOptions(db, input.campaign_id).map((l) => l.name) };
  })();
}

/** A language learned in play: a tutor, a year in a city, a spell. */
export function grantLanguage(db: Db, input: { campaign_id: number; character_id?: number; name: string }) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  const language = resolveLanguage(db, input.campaign_id, input.name);
  if (pc.proficiencies.languages.some((held) => held.toLowerCase() === language.toLowerCase())) {
    return { name: pc.name, added: false, languages: pc.proficiencies.languages, reason: `${pc.name} already speaks ${language}.` };
  }
  pc.proficiencies.languages.push(language);
  return db.transaction(() => {
    savePc(db, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'feature',
      text: `${pc.name} now speaks ${language}.`,
      payload: { language },
    });
    return { name: pc.name, added: true, languages: pc.proficiencies.languages };
  })();
}

/** The languages a character speaks, for the roll tool's refusal and for the sheet. */
export function knownLanguages(db: Db, campaignId: number, characterId?: number): string[] {
  return loadPc(db, campaignId, characterId).proficiencies.languages;
}

export interface RollProficiency {
  /** The proficiency bonus a proficient tool adds, when no skill has already added one. */
  bonus: number;
  /** 2024: a proficient skill and a proficient tool on the same check give Advantage instead of more bonus. */
  advantage: boolean;
  note: string | null;
}

/**
 * What a tool proficiency is worth on this check. A proficient tool adds the proficiency bonus; when a
 * proficient skill applies to the same check the 2024 rule gives Advantage instead of a second bonus.
 */
export function toolRollProficiency(
  db: Db,
  campaignId: number,
  characterId: number | undefined,
  input: { tool: string; skill?: string | null },
): RollProficiency {
  const pc = loadPc(db, campaignId, characterId);
  const prof = proficiencyBonus(pc.level);
  if (!hasTool(pc, input.tool)) {
    return {
      bonus: 0,
      advantage: false,
      note: `${pc.name} is not proficient with ${input.tool} (they have: ${pc.proficiencies.tools.join(', ') || 'no tools'}), so nothing is added.`,
    };
  }
  const skill = input.skill ? pc.skills[input.skill] : undefined;
  if (skill?.proficient) {
    return {
      bonus: 0,
      advantage: true,
      note: `${pc.name} is proficient with both the skill and ${input.tool}: that is Advantage, not a second bonus.`,
    };
  }
  return { bonus: prof, advantage: false, note: `Proficient with ${input.tool}: +${prof} added.` };
}

/** Refuses a check to understand a language the character does not know, listing the ones they do. */
export function assertKnowsLanguage(db: Db, campaignId: number, characterId: number | undefined, language: string): void {
  const pc = loadPc(db, campaignId, characterId);
  const wanted = language.trim().toLowerCase();
  if (pc.proficiencies.languages.some((held) => held.toLowerCase() === wanted)) return;
  throw new Error(
    `${pc.name} does not know ${language}, so there is nothing to roll: describe what they fail to understand. They speak ${pc.proficiencies.languages.join(', ') || 'nothing'}.`,
  );
}

/** The d20 modifier the server composes for a check or a save, part by part, so the DM can read it. */
export interface CheckModifier {
  character_id: number;
  name: string;
  /** 'check' for a skill or a raw ability check, 'save' for a saving throw. */
  kind: 'check' | 'save';
  ability: Ability;
  /** The skill the check uses, or null for a raw ability check and for a save. */
  skill: string | null;
  ability_mod: number;
  /** The proficiency bonus added, already doubled when the skill has Expertise. */
  proficiency: number;
  expertise: boolean;
  /** What exhaustion takes off: 2 per level, as a positive number. */
  exhaustion: number;
  /** What a class feature adds: Jack of All Trades, a Thaumaturge's or a Magician's own field. */
  feature_bonus: number;
  feature_note: string | null;
  total_modifier: number;
  /** Loud armour, which gives Disadvantage on a Stealth check. */
  stealth_disadvantage: boolean;
  /** Conditions on the roller that give this roll Disadvantage, in the words the reply shows. */
  condition_disadvantage?: string[];
  /** Set when a condition makes this save fail without a roll: Paralyzed, Petrified, Stunned or Unconscious. */
  auto_fail_save?: string;
  /** Homebrew clauses that give this roll Advantage by themselves, in the words the reply shows. */
  feature_advantage?: string[];
  /** The boosts the player or the DM may spend on this roll: the `ask_before` clauses that fit it. */
  boosts_available?: RollBoost[];
  /** The clauses this roll could not answer, handed back rather than applied. */
  reminders?: Array<{ feature: string; text: string; reason: string }>;
  /** The rationed clauses that applied themselves here; whoever rolls pays for them once it stands. */
  feature_spends?: RollBoost[];
}

/**
 * What the homebrew clauses on this sheet do to a check or a save outside a fight: the proficiency and
 * the Expertise they hand out, the flat bonus they add, the Advantage they give by themselves, and the
 * boosts that are the player's to spend. The combat registry answers the same question at its hooks.
 */
function clauseCheck(
  pc: PcState,
  what: { skill?: string; ability?: Ability; save?: Ability; proficient: boolean },
  prof: number,
): {
  proficiency: number;
  expertise: boolean;
  bonus: number;
  note: string | null;
  advantage: string[];
  reminders: Array<{ feature: string; text: string; reason: string }>;
  spends: RollBoost[];
} {
  const reader = clauseReader(pc, prof);
  const passive = clausePassives(pc.features, { inventory: pc.inventory });
  const skill = what.skill ?? null;
  const expertise = skill !== null && passive.expertise.includes(skill);
  const proficient = what.proficient || (skill !== null && passive.proficiencies.includes(skill));
  const kind = what.save ? 'save' : 'check';
  const notes: string[] = [];
  const advantage: string[] = [];
  const reminders = [...passive.reminders];
  const spends: RollBoost[] = [];
  const handBack = (feature: Feature, clause: Clause, reason: string): void => {
    reminders.push({ feature: feature.name, text: describeClause(clause), reason });
  };
  let bonus = 0;
  for (const feature of pc.features) {
    const index = homebrewIndex(feature);
    (feature.clauses ?? []).forEach((clause, at) => {
      if (clause.when !== 'roll' || clause.decide === 'ask_after') return;
      // A clause written for another kind of roll is not this roll's business at all.
      if (clause.if?.kind !== undefined && clause.if.kind !== kind) return;
      // A narrowing only a fight can answer: the weapon in hand, the spell cast, who is standing where.
      const blind = outOfCombatBlind(clause);
      if (blind) {
        return handBack(feature, clause, `${blind} is only known in a fight, so this one is yours to judge here`);
      }
      const verdict = clauseApplies(clause, {
        sheet: reader,
        kind,
        skill,
        ability: what.ability ?? null,
        save: what.save ?? null,
      });
      if (verdict.blocked) return handBack(feature, clause, verdict.blocked.reason);
      if (!verdict.ok) return;
      if (clause.decide === 'dm') return handBack(feature, clause, 'this one is yours to apply');
      // What the player chooses is offered as a boost, not applied; these are the free automatic ones.
      if (clause.decide === 'ask_before') return;
      const key = clauseResourceKey(index, at);
      if (clauseUsesLeft(reader, clause.uses, key) <= 0) return;
      let applied = false;
      for (const entry of clause.do) {
        if (entry.kind === 'bonus' && (entry.to === 'check' || entry.to === 'save')) {
          bonus += flatAmount(reader, entry.amount) ?? 0;
          notes.push(`${feature.name}: ${describeDo(entry)}`);
          applied = true;
        } else if (entry.kind === 'advantage') {
          advantage.push(`${feature.name}: ${describeClause(clause)}`);
          applied = true;
        } else if (entry.kind !== 'disadvantage') {
          handBack(feature, clause, `${describeDo(entry)} does not land on a check made outside a fight`);
        }
      }
      // Decision 1: an automatic clause pays for itself, once the roll it helped stands.
      const spec = applied ? clauseUsesMax(reader, clause.uses) : null;
      if (spec) {
        spends.push({
          id: key,
          name: feature.name,
          describe: describeClause(clause),
          uses_left: clauseUsesLeft(reader, clause.uses, key),
          advantage: clause.do.some((entry) => entry.kind === 'advantage'),
          bonus: 0,
          label: clauseLabel(feature, at),
          max: spec.max,
          per: spec.per,
          when: clause.when,
        });
      }
    });
  }
  const proficiency = expertise ? prof * 2 : proficient ? prof : 0;
  if (skill !== null && passive.proficiencies.includes(skill) && !what.proficient) {
    notes.push(`${skill} is proficient from a homebrew feature`);
  }
  return {
    proficiency,
    expertise,
    bonus,
    note: notes.length ? notes.join('; ') : null,
    advantage,
    reminders,
    spends,
  };
}

/** The character row as the clause matcher reads it, which is the shape a combat sheet already is. */
const clauseReader = (pc: PcState, prof: number): ClauseSheet => ({
  level: pc.level,
  proficiency_bonus: prof,
  abilities: pc.abilities as unknown as Record<string, { score: number; mod: number } | undefined>,
  features: pc.features,
  inventory: pc.inventory,
});

/** The `if` fields a roll outside a fight has no answer for, in the words the reminder uses. */
function outOfCombatBlind(clause: Clause): string | null {
  const where = clause.if;
  if (!where) return null;
  if (where.target) return 'the target';
  if (where.range) return 'the range';
  if (where.weapon) return 'the weapon';
  if (where.spell) return 'the spell';
  if (where.source && where.source !== 'any') return 'what the roll is made with';
  return null;
}

/**
 * The flat bonuses a class feature puts on an ability check outside a fight. The combat registry in
 * src/combat/features.ts answers the same question for the checks the engine rolls; this is the sheet's
 * own arithmetic, which cannot reach the registry without the engine reaching back into this file.
 */
function featureCheckBonus(pc: PcState, what: { skill?: string; proficient: boolean }): { bonus: number; note: string } | null {
  const classIndex = classIndexOf(pc.class);
  const held = pc.features.map((f) => featureIndexOf(f.name, classIndex));
  const wis = Math.max(1, pc.abilities.wis?.mod ?? 0);
  const picked = (feature: string, option: string): boolean =>
    heldOptions(pc, feature).some((held) => held.toLowerCase() === option.toLowerCase());
  if (held.includes('cleric-divine-order') && picked(DIVINE_ORDER, 'Thaumaturge') && ['arcana', 'religion'].includes(what.skill ?? '')) {
    return { bonus: wis, note: `Divine Order (Thaumaturge): +${wis}` };
  }
  if (held.includes('druid-primal-order') && picked(PRIMAL_ORDER, 'Magician') && ['arcana', 'nature'].includes(what.skill ?? '')) {
    return { bonus: wis, note: `Primal Order (Magician): +${wis}` };
  }
  // Jack of All Trades: half the proficiency bonus on any check that carries none.
  if (held.includes('bard-jack-of-all-trades') && !what.proficient) {
    const half = Math.floor(proficiencyBonus(pc.level) / 2);
    if (half > 0) return { bonus: half, note: `Jack of All Trades: +${half}` };
  }
  return null;
}

/** The condition names on a sheet, paired with the rule the combat engine reads for each. */
function heldConditions(conditions: string[]): Array<{ condition: string; rule: ConditionRule }> {
  const out: Array<{ condition: string; rule: ConditionRule }> = [];
  for (const condition of conditions) {
    const rule = conditionRule(condition);
    if (rule) out.push({ condition, rule });
  }
  return out;
}

/**
 * The modifier for a check or a save off the sheet: ability modifier, proficiency (doubled for
 * Expertise) and the exhaustion penalty. The DM names the skill, the ability or the save; the
 * server owns the arithmetic.
 */
export function checkModifier(
  db: Db,
  campaignId: number,
  characterId: number | undefined,
  what: { skill?: string; ability?: Ability; save?: Ability },
): CheckModifier {
  const pc = loadPc(db, campaignId, characterId);
  const prof = proficiencyBonus(pc.level);
  const exhaustion = pc.exhaustion * EXHAUSTION_PER_LEVEL;
  const passive = clausePassives(pc.features);
  const conditions = heldConditions(pc.conditions);
  const checkDisadvantage = conditions
    .filter(({ rule }) => rule.check_disadvantage)
    .map(({ condition }) => `${pc.name} is ${condition}`);
  // An ability score increase from a clause is read here, the way the combat sheet reads it.
  const scoreMod = (ability: Ability): number =>
    abilityMod(withAsi(pc.abilities[ability]?.score ?? 10, passive.asi[ability]));
  const reader = { ...pc, proficiency_bonus: prof };
  const base = {
    character_id: pc.id,
    name: pc.name,
    exhaustion,
    feature_bonus: 0,
    feature_note: null,
    stealth_disadvantage: false,
  };
  const offered = (ctx: { kind: NonNullable<CheckModifier['kind']>; skill?: string; ability?: Ability; save?: Ability }) =>
    boostsFor(reader, pc.features, {
      kind: ctx.kind === 'save' ? 'save' : 'check',
      ...(ctx.skill ? { skill: ctx.skill } : {}),
      ...(ctx.ability ? { ability: ctx.ability } : {}),
      ...(ctx.save ? { save: ctx.save } : {}),
    });
  const extras = (
    clause: ReturnType<typeof clauseCheck>,
    boosts: RollBoost[],
  ): Pick<CheckModifier, 'feature_advantage' | 'boosts_available' | 'reminders' | 'feature_spends'> => ({
    ...(clause.advantage.length ? { feature_advantage: clause.advantage } : {}),
    ...(boosts.length ? { boosts_available: boosts } : {}),
    ...(clause.reminders.length ? { reminders: clause.reminders } : {}),
    ...(clause.spends.length ? { feature_spends: clause.spends } : {}),
  });

  if (what.save) {
    const ability = what.save;
    const save = pc.saves[ability];
    const mod = scoreMod(ability);
    const clause = clauseCheck(pc, { save: ability, ability, proficient: save?.proficient === true }, prof);
    const proficiency = save?.proficient || passive.saves.includes(ability) ? prof : 0;
    const autoFail = conditions.find(({ rule }) => rule.auto_fail_saves?.includes(ability));
    const saveDisadvantage = conditions
      .filter(({ rule }) => rule.save_disadvantage?.includes(ability))
      .map(({ condition }) => `${pc.name} is ${condition}`);
    return {
      ...base,
      kind: 'save',
      ability,
      skill: null,
      ability_mod: mod,
      proficiency,
      expertise: false,
      feature_bonus: clause.bonus,
      feature_note: clause.note,
      total_modifier: mod + proficiency + clause.bonus - exhaustion,
      ...(autoFail ? { auto_fail_save: `${pc.name} is ${autoFail.condition}` } : {}),
      ...(saveDisadvantage.length ? { condition_disadvantage: saveDisadvantage } : {}),
      ...extras(clause, offered({ kind: 'save', save: ability, ability })),
    };
  }

  if (what.skill) {
    const key = normalizeSkill(what.skill);
    const entry = pc.skills[key];
    const ability = entry?.ability ?? SKILL_ABILITY[key]!;
    const mod = scoreMod(ability);
    const clause = clauseCheck(pc, { skill: key, ability, proficient: entry?.proficient === true }, prof);
    const proficiency = entry?.expertise ? prof * 2 : Math.max(entry?.proficient ? prof : 0, clause.proficiency);
    const feature = featureCheckBonus(pc, { skill: key, proficient: proficiency > 0 });
    const bonus = (feature?.bonus ?? 0) + clause.bonus;
    return {
      ...base,
      kind: 'check',
      ability,
      skill: key,
      ability_mod: mod,
      proficiency,
      expertise: entry?.expertise === true || clause.expertise,
      feature_bonus: bonus,
      feature_note: [feature?.note, clause.note].filter(Boolean).join('; ') || null,
      total_modifier: mod + proficiency + bonus - exhaustion,
      stealth_disadvantage:
        key === 'stealth' && armorLoad(pc.inventory, pc.abilities.str?.score ?? 10).stealth_disadvantage,
      ...(checkDisadvantage.length ? { condition_disadvantage: checkDisadvantage } : {}),
      ...extras(clause, offered({ kind: 'check', skill: key, ability })),
    };
  }

  if (!what.ability) {
    throw new Error(`Name what is being rolled: a skill (${SKILL_KEYS.join(', ')}), an ability, or a save.`);
  }
  const mod = scoreMod(what.ability);
  const feature = featureCheckBonus(pc, { proficient: false });
  const clause = clauseCheck(pc, { ability: what.ability, proficient: false }, prof);
  const bonus = (feature?.bonus ?? 0) + clause.bonus;
  return {
    ...base,
    kind: 'check',
    ability: what.ability,
    skill: null,
    ability_mod: mod,
    proficiency: 0,
    expertise: false,
    feature_bonus: bonus,
    feature_note: [feature?.note, clause.note].filter(Boolean).join('; ') || null,
    total_modifier: mod + bonus - exhaustion,
    ...(checkDisadvantage.length ? { condition_disadvantage: checkDisadvantage } : {}),
    ...extras(clause, offered({ kind: 'check', ability: what.ability })),
  };
}

// --- concentration outside a fight ------------------------------------------

/** What a character is concentrating on while no encounter is running. */
export interface ConcentrationRecord {
  spell: string;
  /** The slot it was cast with, or null for a spell cast without one. */
  slot_level: number | null;
  /** The in-world time it started, as the calendar reads it. */
  started_at: string;
  /** How long it lasts, when the spell says; null when it does not. */
  duration: string | null;
}

/** Whether this character holds a combatant row in a fight that is still running. */
export function inActiveEncounter(db: Db, campaignId: number, characterId: number): boolean {
  return activeCombatantRef(db, campaignId, characterId) !== null;
}

function readConcentration(db: Db, characterId: number): ConcentrationRecord | null {
  const row = db.prepare('SELECT concentration_json FROM character WHERE id = ?').get(characterId) as
    | { concentration_json: string | null }
    | undefined;
  return parse<ConcentrationRecord | null>(row?.concentration_json ?? null, null);
}

/** What the character is concentrating on outside a fight, or null. */
export function concentrationOf(db: Db, campaignId: number, characterId?: number): ConcentrationRecord | null {
  return readConcentration(db, loadPc(db, campaignId, characterId).id);
}

/** Ends concentration and logs why; returns what was dropped, or null when there was nothing. */
export function endConcentration(
  db: Db,
  campaignId: number,
  characterId: number | undefined,
  reason: string,
): ConcentrationRecord | null {
  const pc = loadPc(db, campaignId, characterId);
  const held = readConcentration(db, pc.id);
  if (!held) return null;
  db.prepare('UPDATE character SET concentration_json = NULL WHERE id = ?').run(pc.id);
  logEvent(db, {
    campaign_id: campaignId,
    kind: 'concentration',
    text: `${pc.name} stops concentrating on ${held.spell} (${reason}).`,
    payload: { spell: held.spell, reason },
  });
  return held;
}

/** The concentration a spell needs, from the SRD entry or from a spell the DM wrote. */
function concentrationSpell(
  db: Db,
  campaignId: number,
  name: string,
): { concentration: boolean; duration: string | null } {
  const srdSpell = findSpell(name);
  if (srdSpell) return { concentration: srdSpell.concentration, duration: srdSpell.duration ?? null };
  const custom = findHomebrewSpell(db, campaignId, name);
  if (custom) {
    const schema = custom.schema as Partial<SpellSchema>;
    return { concentration: schema.concentration === true, duration: schema.duration ?? null };
  }
  return { concentration: false, duration: null };
}

/** DC for the save that keeps concentration: half the damage taken, never below 10 and never above 30. */
export const concentrationSaveDc = (damage: number): number => Math.min(30, Math.max(10, Math.floor(damage / 2)));

// --- companions -------------------------------------------------------------

const ABILITY_BY_NAME: Record<string, Ability> = {
  strength: 'str',
  dexterity: 'dex',
  constitution: 'con',
  intelligence: 'int',
  wisdom: 'wis',
  charisma: 'cha',
};

/** What the class cares about, best first: its primary ability, then CON, then its saving throws. */
function classAbilityOrder(cls: srd.ClassData): Ability[] {
  const order: Ability[] = [];
  const add = (ability: Ability): void => {
    if (!order.includes(ability)) order.push(ability);
  };
  for (const word of (cls.primary_ability?.desc ?? '').toLowerCase().split(/[^a-z]+/)) {
    const ability = ABILITY_BY_NAME[word];
    if (ability) add(ability);
  }
  add('con');
  for (const save of cls.saving_throws) add(save.index as Ability);
  for (const ability of ABILITIES) add(ability);
  return order;
}

function defaultAbilities(order: Ability[]): AbilityScores {
  const scores = {} as AbilityScores;
  order.forEach((ability, i) => {
    scores[ability] = STANDARD_ARRAY[i]!;
  });
  return scores;
}

/** The background's +2 and +1, spent on the two abilities the class cares about most. */
function defaultAbilityBonuses(abilities: readonly string[], order: Ability[]): Partial<AbilityScores> {
  const [first, second] = abilities
    .map((a) => a as Ability)
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { [first!]: 2, [second!]: 1 };
}

function defaultSkillChoices(cls: srd.ClassData, species: srd.SpeciesData): string[] {
  const picks: string[] = [];
  for (const group of [...skillChoiceGroups(cls, species)].sort((a, b) => a.from.length - b.from.length)) {
    let taken = 0;
    for (const skill of group.from) {
      if (taken === group.choose) break;
      if (picks.includes(skill)) continue;
      picks.push(skill);
      taken += 1;
    }
  }
  return picks;
}

export interface CompanionClassSource {
  class: string;
  species: string;
  /** Which lineage of the species, for the species that have one. */
  lineage?: string;
  background: string;
  level?: number;
  abilities?: AbilityScores;
  ability_bonuses?: Partial<AbilityScores>;
  skill_choices?: string[];
  equipment_choice?: string | number;
  cantrips?: string[];
  spells?: string[];
}

export interface CompanionCreatureSource {
  creature: string;
}

export interface CreateCompanionInput {
  campaign_id: number;
  name: string;
  source: CompanionClassSource | CompanionCreatureSource;
  personality?: string;
  backstory?: string;
}

/** The story text a companion is remembered by: their personality and their backstory in one fact. */
function companionFact(input: CreateCompanionInput): string | undefined {
  const text = [input.personality, input.backstory].filter(Boolean).join(' ');
  return text || undefined;
}

export function createCompanion(db: Db, input: CreateCompanionInput) {
  const source = input.source;
  if ('creature' in source) return createStatBlockCompanion(db, input, source.creature);

  const cls = findClass(source.class);
  const species = findSpecies(source.species);
  const background = resolveBackground(db, input.campaign_id, source.background);
  if ((source.level ?? 1) !== 1) {
    throw new Error('Companions start at level 1; levelling companions is not supported yet.');
  }
  const spellcasting = cls.spellcasting ? classLevelRow(cls.index, 1).spellcasting : undefined;
  const order = classAbilityOrder(cls);
  const created = createCharacter(db, {
    campaign_id: input.campaign_id,
    name: input.name,
    species: species.name,
    lineage: source.lineage,
    class: cls.name,
    background: background.name,
    ability_method: source.abilities ? 'manual' : 'standard_array',
    abilities: source.abilities ?? defaultAbilities(order),
    ability_bonuses: source.ability_bonuses ?? defaultAbilityBonuses(background.abilities, order),
    skill_choices: source.skill_choices ?? defaultSkillChoices(cls, species),
    equipment_choice: source.equipment_choice,
    cantrips: source.cantrips ?? spellsForClass(cls.index, 0).slice(0, spellcasting?.cantrips_known ?? 0),
    spells: source.spells ?? spellsForClass(cls.index, 1).slice(0, spellcasting?.prepared_spells ?? 0),
    backstory: companionFact(input),
    is_pc: false,
    role: 'companion',
  });
  return { companion: created.character, party: party(db, input.campaign_id) };
}

function findStatBlock(name: string): srd.CreatureStatBlock {
  const wanted = name.trim().toLowerCase();
  const creature = srd.creatures().find((c) => c.fields.name.toLowerCase() === wanted);
  if (!creature) {
    throw new Error(`No SRD creature called "${name}". Find the exact name with srd_lookup kind "creature".`);
  }
  return srd.creatureStatBlock(creature);
}

/** The stat block as sheet features: one anchor entry with the creature's own numbers, then traits and actions. */
function statBlockFeatures(block: srd.CreatureStatBlock): Feature[] {
  const features: Feature[] = [
    {
      name: `${block.name} stat block`,
      source: 'stat_block',
      text: `${block.size} ${block.type}, CR ${block.cr}. AC ${block.ac}, ${block.hp} HP.${
        block.senses.length ? ` Senses: ${block.senses.join(', ')}.` : ''
      }`,
      mechanics: {
        creature: block.name,
        cr: block.cr,
        size: block.size,
        type: block.type,
        speed: block.speed,
        senses: block.senses,
        initiative_bonus: block.initiative_bonus,
        passive_perception: block.passive_perception,
        damage_vulnerabilities: block.damage_vulnerabilities,
        damage_resistances: block.damage_resistances,
        damage_immunities: block.damage_immunities,
        condition_immunities: block.condition_immunities,
      },
    },
  ];
  for (const trait of block.traits) features.push({ name: trait.name, source: 'stat_block', text: trait.text });
  for (const action of [...block.actions, ...block.bonus_actions, ...block.reactions]) {
    const mechanics: FeatureMechanics = { kind: action.kind };
    if (action.attack_bonus !== undefined) mechanics.attack_bonus = action.attack_bonus;
    if (action.reach_ft !== undefined) mechanics.reach_ft = action.reach_ft;
    if (action.range_ft !== undefined) mechanics.range_ft = action.range_ft;
    if (action.long_range_ft !== undefined) mechanics.long_range_ft = action.long_range_ft;
    if (action.damage) mechanics.damage = action.damage;
    if (action.uses) mechanics.uses = action.uses;
    features.push({ name: action.name, source: 'stat_block', text: action.text, mechanics });
  }
  return features;
}

/** "2d8 + 2" gives the hit dice a stat-block companion spends on a short rest. */
function statBlockHitDice(hitDice: string): HitDice {
  const match = /(\d+)\s*(d\d+)/i.exec(hitDice);
  return { die: match ? match[2]!.toLowerCase() : 'd8', max: match ? Number(match[1]) : 1, used: 0 };
}

function createStatBlockCompanion(db: Db, input: CreateCompanionInput, creature: string) {
  const block = findStatBlock(creature);
  const abilities = Object.fromEntries(
    ABILITIES.map((a) => [a, { score: block.abilities[a] ?? 10, mod: abilityMod(block.abilities[a] ?? 10) }]),
  ) as Record<Ability, AbilityEntry>;
  const saves = Object.fromEntries(
    ABILITIES.map((a) => {
      const bonus = block.saves[a] ?? abilities[a].mod;
      return [a, { proficient: bonus > abilities[a].mod, bonus }];
    }),
  ) as Record<Ability, SaveEntry>;
  const skills = Object.fromEntries(
    SKILL_KEYS.map((key) => {
      const ability = SKILL_ABILITY[key]!;
      const bonus = block.skills[key];
      return [
        key,
        { ability, proficient: bonus !== undefined, expertise: false, bonus: bonus ?? abilities[ability].mod },
      ];
    }),
  ) as Record<string, SkillEntry>;

  // A stat-block companion has no class; the creature name lives in the species column.
  const pc: PcState = {
    id: 0,
    campaign_id: input.campaign_id,
    name: input.name,
    is_pc: false,
    role: 'companion',
    species: block.name,
    lineage: null,
    class: null,
    background: null,
    subclass: null,
    subclass_homebrew_id: null,
    level: 1,
    xp: 0,
    hp_current: block.hp,
    hp_max: block.hp,
    temp_hp: 0,
    ac: block.ac,
    speed: block.speed.walk ?? 30,
    exhaustion: 0,
    gold: 0,
    coins: emptyCoins(),
    inspiration: 0,
    status: 'active',
    abilities,
    saves,
    skills,
    proficiencies: { armor: [], weapons: [], tools: [], languages: block.languages ? [block.languages] : [] },
    features: statBlockFeatures(block),
    spells: { spellcasting_ability: null, cantrips: [], known: [], prepared: [], save_dc: null, attack_bonus: null },
    spell_slots: {},
    inventory: [],
    conditions: [],
    death_saves: { successes: 0, failures: 0 },
    stable: false,
    hit_dice: statBlockHitDice(block.hit_dice),
  };

  const created = db.transaction(() => {
    const id = insertCharacter(db, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'character',
      text: `${pc.name} the ${block.name} joins the party: ${pc.hp_max} HP, AC ${pc.ac}.`,
      payload: { character_id: id, role: 'companion', creature: block.name },
    });
    const fact = companionFact(input);
    if (fact) {
      db.prepare('INSERT INTO canon_fact (campaign_id, subject, fact, created_at) VALUES (?, ?, ?, ?)').run(
        input.campaign_id,
        pc.name,
        fact,
        nowIso(),
      );
    }
    return { companion: getCharacterSheet(db, input.campaign_id, id), party: party(db, input.campaign_id) };
  })();
  if (created.companion) {
    scheduleCharacterPortrait(
      db,
      input.campaign_id,
      created.companion.id,
      [`${block.size} ${block.type}`.toLowerCase(), companionFact(input) ?? ''].filter(Boolean).join(', '),
    );
  }
  return created;
}

export function listParty(db: Db, input: { campaign_id: number }) {
  return party(db, input.campaign_id);
}

export function retireCompanion(db: Db, input: { campaign_id: number; character_id: number }) {
  const companion = loadPc(db, input.campaign_id, input.character_id);
  if (companion.role !== 'companion') throw new Error(`${companion.name} is not a companion.`);
  return db.transaction(() => {
    db.prepare("UPDATE character SET status = 'retired', updated_at = ? WHERE id = ?").run(nowIso(), companion.id);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'character',
      text: `${companion.name} leaves the party.`,
      payload: { character_id: companion.id },
    });
    return { name: companion.name, party: party(db, input.campaign_id) };
  })();
}

/** The death flow's third option: a companion takes over as the player character. */
export function promoteCompanion(db: Db, input: { campaign_id: number; character_id: number }) {
  const companion = loadPc(db, input.campaign_id, input.character_id);
  if (companion.role !== 'companion' || companion.status !== 'active') {
    throw new Error(`${companion.name} is not a companion in the party. Call list_party to see who is.`);
  }
  const previous = pcRow(db, input.campaign_id);
  if (previous && previous.status === 'active') {
    throw new Error(
      `${previous.name} is still the player character. Promote a companion only once the player character is gone.`,
    );
  }
  return db.transaction(() => {
    db.prepare("UPDATE character SET is_pc = 1, role = 'pc', status = 'active', updated_at = ? WHERE id = ?").run(
      nowIso(),
      companion.id,
    );
    const previousName = previous?.name as string | undefined;
    const ending = previous?.status === 'dead' ? 'death' : 'departure';
    const fact = previousName
      ? `${companion.name} took up the mantle after ${previousName}'s ${ending}.`
      : `${companion.name} became the player character.`;
    db.prepare('INSERT INTO canon_fact (campaign_id, subject, fact, created_at) VALUES (?, ?, ?, ?)').run(
      input.campaign_id,
      companion.name,
      fact,
      nowIso(),
    );
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'character',
      text: fact,
      payload: { character_id: companion.id, previous_pc: previousName ?? null },
    });
    return { character: getCharacterSheet(db, input.campaign_id, companion.id), previous_pc: previousName ?? null };
  })();
}

// --- items ------------------------------------------------------------------

/** Every item on the sheet, what is inside containers included. */
function allItems(items: InventoryItem[]): InventoryItem[] {
  return items.flatMap((item) => [item, ...allItems(item.container?.contents ?? [])]);
}

interface ItemSite {
  item: InventoryItem;
  /** The list it sits in: the pack itself, or some container's contents. */
  holder: InventoryItem[];
}

/** An item by its id or either of its names, inside containers as well as loose in the pack. */
function locateItem(items: InventoryItem[], query: string): ItemSite | undefined {
  const wanted = query.trim().toLowerCase();
  for (const item of items) {
    const names = [item.name, displayItemName(item)].map((name) => name.toLowerCase());
    if (item.id === wanted || names.includes(wanted)) return { item, holder: items };
    const inside = item.container ? locateItem(item.container.contents, query) : undefined;
    if (inside) return inside;
  }
  return undefined;
}

const findItem = (pc: PcState, name: string): InventoryItem | undefined => locateItem(pc.inventory, name)?.item;

/** The container an item sits in, given the list it was found in; undefined when that list is the pack. */
function holderOf(items: InventoryItem[], list: InventoryItem[]): InventoryItem | undefined {
  for (const item of allItems(items)) {
    if (item.container?.contents === list) return item;
  }
  return undefined;
}

/** The item a tool names, or an error listing what is actually carried. */
function requireItem(pc: PcState, query: string): ItemSite {
  const site = locateItem(pc.inventory, query);
  if (site) return site;
  const carried = allItems(pc.inventory).map((i) => i.name).join(', ') || 'nothing';
  throw new Error(`${pc.name} is not carrying "${query}". They have: ${carried}.`);
}

const ITEM_ID_LENGTH = 6;

/**
 * A short opaque handle for an item, unique inside one inventory. It says nothing about the item: a
 * slug of the name would hand the player the true name of anything unidentified. An id is an
 * identifier rather than a roll, so it comes from node:crypto and not from dice.ts.
 */
function nextItemId(taken: Set<string>): string {
  let id = '';
  do {
    id = Array.from(randomBytes(ITEM_ID_LENGTH), (byte) => (byte % 36).toString(36)).join('');
  } while (taken.has(id));
  taken.add(id);
  return id;
}

const takenItemIds = (items: InventoryItem[]): Set<string> =>
  new Set(allItems(items).map((i) => i.id).filter((id): id is string => id !== undefined));

/** Gives an id to any item written before ids existed. Returns whether anything changed. */
export function backfillItemIds(items: InventoryItem[]): boolean {
  const taken = takenItemIds(items);
  let changed = false;
  for (const item of allItems(items)) {
    if (item.id !== undefined) continue;
    item.id = nextItemId(taken);
    changed = true;
  }
  return changed;
}

/** An unidentified item is only ever its kind until someone works out what it is. */
export function displayItemName(item: InventoryItem): string {
  return item.magic?.identified === false
    ? `Unidentified ${unidentifiedKind(item.magic?.base ?? item.name)}`
    : item.name;
}

/** The SRD equipment an item is, read from the base a custom magic item names before its own name. */
export function itemEquipment(item: { name: string; magic?: { base?: string } }): srd.EquipmentData | undefined {
  return findEquipment(item.magic?.base ?? item.name);
}

/** What the player's own window sees: an unidentified item keeps its kind and nothing else. */
export function maskItemsForPlayer(items: InventoryItem[]): InventoryItem[] {
  return items.map((item) => {
    const hidden = item.magic?.identified === false;
    const out: InventoryItem = hidden
      ? {
          name: displayItemName(item),
          qty: item.qty,
          ...(item.id === undefined ? {} : { id: item.id }),
          ...(item.equipped === undefined ? {} : { equipped: item.equipped }),
          ...(item.weight_lb === undefined ? {} : { weight_lb: item.weight_lb }),
        }
      : { ...item };
    // Capacity and weightlessness identify a Bag of Holding as surely as its name does.
    if (item.container) {
      const contents = maskItemsForPlayer(item.container.contents);
      out.container = hidden ? { contents } : { ...item.container, contents };
    }
    return out;
  });
}

export type DmItem = InventoryItem & { true_name?: string };

/** How a DM-facing list shows an item: what the player would call it, with the truth beside it. */
export function dmItems(items: InventoryItem[]): DmItem[] {
  return items.map((item) => {
    const out: DmItem = item.magic?.identified === false
      ? { ...item, name: displayItemName(item), true_name: item.name }
      : { ...item };
    if (item.container) out.container = { ...item.container, contents: dmItems(item.container.contents) };
    return out;
  });
}

const attunedItems = (pc: PcState): InventoryItem[] => allItems(pc.inventory).filter((i) => i.magic?.attuned === true);

/** The three attunement slots and what is in them. */
export interface AttunementState {
  used: number;
  max: number;
  items: string[];
}

/** Three attunement slots, and four for a Thief with Use Magic Device. */
const attunementMax = (pc: PcState): number =>
  pc.features.some((f) => f.name === 'Use Magic Device') ? ATTUNEMENT_MAX + 1 : ATTUNEMENT_MAX;

const attunementState = (pc: PcState): AttunementState => {
  const items = attunedItems(pc).map(displayItemName);
  return { used: items.length, max: attunementMax(pc), items };
};

/** Death ends every attunement, as the 2024 rules have it; the AC it was propping up goes with it. */
function endAttunements(pc: PcState): void {
  for (const item of attunedItems(pc)) item.magic!.attuned = false;
  recompute(pc);
}

/** The +N an item is actually giving: it must be in use, and attuned when it asks for attunement. */
export function activeItemBonus(item: InventoryItem): number {
  const magic = item.magic;
  if (!magic?.bonus || item.equipped !== true) return 0;
  if (magic.attunement !== false && magic.attuned !== true) return 0;
  return magic.bonus;
}

const RECHARGE_TEXT: Record<ItemCharges['recharge'], string> = {
  dawn: 'at dawn',
  dusk: 'at dusk',
  long_rest: 'on a long rest',
  never: 'never: once they are gone they are gone',
  unknown: 'on no schedule the bundled SRD text carries',
};

/** What a DM has to do themselves for an item whose text never said when its charges come back. */
const UNKNOWN_RECHARGE_NOTE =
  'the bundled SRD text for it carries charges but no recharge rule, so this one is yours to rule on: use_item{restore: n} hands charges back, and add_item{magic: {charges: {recharge: "dawn"}}} sets the schedule for good';

/** The magic block an item gets: what the SRD knows about it, with whatever the DM said on top. */
function buildMagic(
  name: string,
  match: MagicItemMatch | undefined,
  given: Partial<ItemMagic> | undefined,
  unidentified: boolean,
  equipment: srd.EquipmentData | undefined,
): ItemMagic | undefined {
  if (!match && given === undefined) return undefined;
  if (given?.rarity !== undefined && !ITEM_RARITIES.includes(given.rarity)) {
    throw new Error(`"${given.rarity}" is not a rarity. Allowed: ${ITEM_RARITIES.join(', ')}.`);
  }
  if (!match && given?.rarity === undefined) {
    throw new Error(
      `"${name}" is not an SRD magic item, so the magic block you invent must name its rarity. Allowed: ${ITEM_RARITIES.join(', ')}.`,
    );
  }
  const base: ItemMagic = match
    ? {
        srd_index: match.data.index,
        rarity: match.rarity,
        attunement: match.attunement,
        ...(match.bonus === undefined ? {} : { bonus: match.bonus }),
        ...(match.base === undefined ? {} : { base: match.base }),
        ...(match.charges ? { charges: { ...match.charges } } : {}),
        identified: true,
      }
    : { rarity: given!.rarity!, attunement: false, identified: true };
  // The base a bonus rides on: what the DM named, an SRD match's own base, or the equipment the name is.
  let baseName = match?.base;
  if (given?.base !== undefined) {
    const found = findEquipment(given.base);
    if (!found) {
      throw new Error(
        `"${given.base}" is not an SRD weapon, armour or shield name, so it cannot be the base of ${name}.`,
      );
    }
    baseName = found.name;
  } else if (!match && given?.bonus !== undefined) {
    if (equipment) baseName = equipment.name;
    else {
      throw new Error(
        `"${name}" is not an SRD item, so its +${given.bonus} must name its base: the SRD weapon, armour or shield it is a magical version of.`,
      );
    }
  }
  const merged = { ...base, ...given };
  if (baseName !== undefined && merged.bonus !== undefined && equipmentKind(baseName) === undefined) {
    throw new Error(`"${baseName}" is not an SRD weapon, armour or shield, so it cannot carry a +${merged.bonus}.`);
  }
  return {
    ...merged,
    ...(baseName === undefined ? {} : { base: baseName }),
    identified: !unidentified,
  };
}

/** What a short rest spent focused on items did, and anything the DM has to rule on themselves. */
interface FocusResult {
  attuned: string[];
  unattuned: string[];
  identified: string[];
  notes: string[];
  /** Attunements the engine refused and the DM allowed anyway, in their own words. */
  rulings: string[];
}

/** 2024: attuning is a short rest spent focused on the item, and nobody holds more than three. */
function attuneTo(pc: PcState, query: string, focus: Pick<FocusResult, 'notes' | 'rulings'>, ruling?: string): string {
  const item = requireItem(pc, query).item;
  const magic = item.magic;
  if (!magic) throw new Error(`${item.name} is not a magic item, so there is nothing to attune to.`);
  if (magic.attunement === false) {
    throw new Error(`${item.name} needs no attunement: it works for whoever holds it.`);
  }
  if (magic.attuned === true) return displayItemName(item);
  const held = attunedItems(pc);
  if (held.length >= attunementMax(pc)) {
    throw new Error(
      `${pc.name} is already attuned to ${attunementMax(pc) === 4 ? 'four' : 'three'}: ${held
        .map((i) => i.name)
        .join(', ')}. End one first with rest kind "short" and unattune ["<item>"].`,
    );
  }
  if (typeof magic.attunement === 'string') {
    const met = attunementRequirementMet(magic.attunement, {
      class: pc.class,
      species: pc.species,
      spellcaster: pc.spells.spellcasting_ability !== null,
    });
    if (met === false) {
      if (ruling === undefined) {
        throw new Error(
          `${item.name} can only be attuned ${magic.attunement}, and ${pc.name} is a ${pc.species}${pc.class ? ` ${pc.class}` : ''}. Pass attune_ruling with your reason to allow it anyway.`,
        );
      }
      // The ruling is spliced into the rest event the player reads, so it names the item as they know it.
      focus.rulings.push(`${displayItemName(item)} is attuned ${magic.attunement}; the DM allowed it anyway: ${ruling}`);
    }
    if (met === null) {
      focus.notes.push(
        `${item.name} asks to be attuned ${magic.attunement}, which the engine cannot parse: it allowed the attunement, so rule on it yourself.`,
      );
    }
  }
  magic.attuned = true;
  // The player's feed only ever sees what they know the item is; an unidentified one keeps its kind.
  return displayItemName(item);
}

function unattuneFrom(pc: PcState, query: string): string {
  const item = requireItem(pc, query).item;
  if (item.magic?.attuned !== true) throw new Error(`${pc.name} is not attuned to ${item.name}.`);
  item.magic.attuned = false;
  return displayItemName(item);
}

/** 2024: a magic item gives up its properties to a short rest spent studying it, or to Identify. */
function identifyItem(pc: PcState, query: string): string {
  const item = requireItem(pc, query).item;
  if (!item.magic) throw new Error(`${item.name} is not a magic item, so there is nothing to identify.`);
  item.magic.identified = true;
  return item.name;
}

/** The attuning, un-attuning and identifying a short rest was spent on. */
function restFocus(
  pc: PcState,
  input: { attune?: string[]; unattune?: string[]; identify?: string[]; attune_ruling?: string },
): FocusResult {
  const focus = { notes: [] as string[], rulings: [] as string[] };
  // Ending one frees the slot the next one needs, so they come off before anything goes on.
  const unattuned = (input.unattune ?? []).map((name) => unattuneFrom(pc, name));
  const attuned = (input.attune ?? []).map((name) => attuneTo(pc, name, focus, input.attune_ruling));
  const identified = (input.identify ?? []).map((name) => identifyItem(pc, name));
  return { attuned, unattuned, identified, ...focus };
}

/** What a long rest hands back: every charge of an item that recharges with one. */
function rechargeOnLongRest(pc: PcState): string[] {
  const back: string[] = [];
  for (const item of allItems(pc.inventory)) {
    const charges = item.magic?.charges;
    if (charges?.recharge !== 'long_rest' || charges.current >= charges.max) continue;
    charges.current = charges.max;
    back.push(`${item.name} (${charges.max} charges)`);
  }
  return back;
}

/** Dawn is 06:00 and dusk 18:00; how many of them the clock passed between two moments. */
const DAWN_HOUR = 6;
const DUSK_HOUR = 18;

/** Zeroes the spent uses of clause counters a dawn or dusk gives back, and names each refilled one. */
function resetRechargeAtCounters(
  row: { features_json: string | null },
  from: number,
  to: number,
): { json: string; names: string[] } | null {
  if (!row.features_json || !row.features_json.includes('recharge_at')) return null;
  const features = parse(row.features_json, [] as Feature[]);
  const names: string[] = [];
  for (const feature of features) {
    const mechanics = feature.mechanics;
    if (!mechanics?.recharge_at || !mechanics.used) continue;
    if (marksPassed(from, to, mechanics.recharge_at === 'dawn' ? DAWN_HOUR : DUSK_HOUR) === 0) continue;
    mechanics.used = 0;
    names.push(`${feature.name} comes back at ${mechanics.recharge_at}`);
  }
  return names.length === 0 ? null : { json: JSON.stringify(features), names };
}

const marksPassed = (from: number, to: number, hour: number): number =>
  Math.max(0, Math.floor((to - hour * 60) / (24 * 60)) - Math.floor((from - hour * 60) / (24 * 60)));

/**
 * Gives back the charges of every dawn or dusk item in the campaign when the clock passes that hour,
 * and wakes a creature whose 1d4 stable hours are up. Called wherever world time moves, so a wand is
 * full again the morning after it was spent.
 */
export function rechargeDailyItems(db: Db, campaignId: number, before: NowState, after: NowState): void {
  const from = clockMinutes(before);
  const to = clockMinutes(after);
  if (to <= from) return;
  const rows = db
    .prepare(
      `SELECT id, name, inventory_json, features_json, hp_current, stable, conditions_json, death_saves_json
         FROM character WHERE campaign_id = ?`,
    )
    .all(campaignId) as Array<{
    id: number;
    name: string;
    inventory_json: string | null;
    features_json: string | null;
    hp_current: number | null;
    stable: number;
    conditions_json: string | null;
    death_saves_json: string | null;
  }>;
  for (const row of rows) {
    // A stable creature regains 1 HP once the 1d4 hours rolled when it stabilised have passed.
    if (row.stable === 1 && (row.hp_current ?? 0) === 0) {
      const saves = parse<DeathSaves>(row.death_saves_json, { successes: 0, failures: 0 });
      if (saves.stable_until !== undefined && to >= saves.stable_until) {
        delete saves.stable_until;
        const conditions = parse<string[]>(row.conditions_json, []).filter((one) => one !== 'unconscious');
        db.prepare(
          'UPDATE character SET hp_current = 1, stable = 0, death_saves_json = ?, conditions_json = ?, updated_at = ? WHERE id = ?',
        ).run(JSON.stringify(saves), JSON.stringify(conditions), nowIso(), row.id);
        logEvent(db, {
          campaign_id: campaignId,
          kind: 'death_save',
          text: `${row.name} was stable and regains 1 HP once the 1d4 hours are up.`,
          payload: { character_id: row.id },
        });
      }
    }
    const inventory = parse(row.inventory_json, [] as InventoryItem[]);
    const regained: string[] = [];
    for (const item of allItems(inventory)) {
      const charges = item.magic?.charges;
      if (charges?.recharge !== 'dawn' && charges?.recharge !== 'dusk') continue;
      const passes = marksPassed(from, to, charges.recharge === 'dawn' ? DAWN_HOUR : DUSK_HOUR);
      let back = 0;
      for (let n = 0; n < passes && charges.current < charges.max; n += 1) {
        const rolled = charges.dice
          ? rollAndRecord(db, {
              expr: charges.dice,
              purpose: `${displayItemName(item)} recharges ${RECHARGE_TEXT[charges.recharge]}`,
              campaign_id: campaignId,
            }).total
          : charges.max;
        const gained = Math.min(charges.max - charges.current, rolled);
        charges.current += gained;
        back += gained;
      }
      if (back > 0) regained.push(`${displayItemName(item)} regains ${back} (${charges.current}/${charges.max})`);
    }
    // Clause counters keyed off a charged item come back with the same clock mark their charges do.
    const counters = resetRechargeAtCounters(row, from, to);
    if (counters) {
      db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(counters.json, row.id);
      regained.push(...counters.names);
    }
    if (regained.length === 0) continue;
    db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(JSON.stringify(inventory), row.id);
    logEvent(db, {
      campaign_id: campaignId,
      kind: 'inventory',
      text: `${row.name}'s charged items recharge: ${regained.join('; ')}.`,
      payload: { character_id: row.id, regained },
    });
  }
}

/** What a magic item is, in one line; its full rules text comes back from use_item. */
function magicNote(match: MagicItemMatch): string {
  const parts = [`${match.data.equipment_category.name}, ${match.rarity.replace('_', ' ')}`];
  if (match.attunement !== false) {
    parts.push(typeof match.attunement === 'string' ? `requires attunement ${match.attunement}` : 'requires attunement');
  }
  if (match.charges) parts.push(`${match.charges.max} charges, back ${RECHARGE_TEXT[match.charges.recharge]}`);
  if (match.container?.capacity_lb !== undefined) {
    parts.push(`holds ${match.container.capacity_lb} lb${match.container.weightless_contents ? ', weightless' : ''}`);
  }
  return parts.join('; ');
}

/** What a container holds, contents of nested containers included; empty for anything that holds nothing. */
const containerContents = (item: InventoryItem): InventoryItem[] => allItems(item.container?.contents ?? []);

/** A full container does not quietly go with the item: say what is in it and how to mean it anyway. */
const containerNotEmpty = (item: InventoryItem, contents: InventoryItem[], verb: string): string =>
  `The ${item.name} holds: ${contents.map((i) => `${i.qty}x ${i.name}`).join(', ')}. Empty it first, or pass force true to have it ${verb} with the contents inside.`;

/** The container block of an item that can hold things, taken from the SRD the first time it is used. */
function ensureContainer(item: InventoryItem): ItemContainer {
  if (item.container) return item.container;
  const spec = containerSpec(item.name);
  if (!spec) {
    throw new Error(
      `${item.name} is not a container and holds nothing. A Backpack, a Sack, a Pouch, a Basket or a Bag of Holding does.`,
    );
  }
  item.container = { ...spec, contents: [] };
  return item.container;
}

// --- gold and inventory -----------------------------------------------------

/**
 * Walking speed as the fight sees it: 5 ft while the pack is over capacity and the rule is on, and
 * 5 ft less per level of exhaustion - the same number the combat sheet hands the engine.
 */
function effectiveSpeed(db: Db, campaignId: number, pc: PcState): number {
  const load = carriedLoad(pc.inventory, pc.abilities.str?.score ?? 10);
  if (load.over && getSettings(db, campaignId).encumbrance === 'rules') return ENCUMBERED_SPEED;
  const armor = armorLoad(pc.inventory, pc.abilities.str?.score ?? 10);
  const faster = classSpeedBonus(pc.features, pc.inventory);
  return Math.max(0, pc.speed + faster.bonus - armor.speed_penalty - exhaustionSpeedPenalty(pc.exhaustion));
}

/** What the combatant row holds; a gear change only has to reach the fight when one of these moves. */
function combatNumbers(db: Db, campaignId: number, pc: PcState): { ac: number; speed: number } {
  return { ac: getOverrides(db, pc.id).ac ?? pc.ac, speed: effectiveSpeed(db, campaignId, pc) };
}

/** The load line a tool answers with, and the warning when the character is over capacity. */
function loadReport(db: Db, campaignId: number, pc: PcState) {
  const load = carriedLoad(pc.inventory, pc.abilities.str?.score ?? 10);
  const encumbered = load.over && getSettings(db, campaignId).encumbrance === 'rules';
  return {
    carried_lb: load.carried_lb,
    capacity_lb: load.capacity_lb,
    encumbered,
    ...(encumbered
      ? {
          warning: `over carrying capacity (${load.carried_lb}/${load.capacity_lb} lb): speed drops to 5 ft until they drop something`,
        }
      : {}),
  };
}

/**
 * Moves coins, making change out of what the purse does hold - breaking bigger coins and pooling
 * smaller ones - and refusing to go under only when the whole purse is short.
 */
function payCoins(pc: PcState, delta: Partial<Coins>, allowDebt: boolean): void {
  const raw = addCoins(pc.coins, delta);
  const settled = settleCoins(raw);
  if (!settled && !allowDebt) {
    const owedCp = coinsCp(pc.coins) - coinsCp(raw);
    const gpOnly = COINS.every((coin) => coin === 'gp' || !delta[coin]);
    const owed = gpOnly ? `${-(delta.gp ?? 0)} gp` : coinsText(coinsFromCp(owedCp));
    throw new Error(
      `${pc.name} has ${pc.gold} gp and cannot pay ${owed} (purse: ${coinsText(pc.coins)}). Pass allow_debt true to let them owe it.`,
    );
  }
  pc.coins = settled ?? raw;
  pc.gold = coinsGp(pc.coins);
}

/** Moves gold, refusing to go below zero unless the caller says a debt is fine. */
const payGold = (pc: PcState, delta: number, allowDebt: boolean): void => payCoins(pc, { gp: delta }, allowDebt);

function isBodyArmor(item: { name: string; magic?: { base?: string } }): boolean {
  const data = itemEquipment(item);
  return Boolean(data?.armor_class) && data?.index !== SHIELD_INDEX;
}

/** What an SRD item is, in one line, so the sheet shows more than a name. */
function srdNote(data: srd.EquipmentData): string {
  const parts: string[] = [];
  // The longest category name is the most specific one: "Martial Melee Weapons", not "Weapons".
  const category = [...data.equipment_categories].sort((a, b) => b.name.length - a.name.length)[0];
  if (category) parts.push(category.name);
  if (data.armor_class) parts.push(`AC ${data.armor_class.base}${data.armor_class.dex_bonus ? ' + DEX' : ''}`);
  if (data.damage) parts.push(`${data.damage.damage_dice} ${data.damage.damage_type.name.toLowerCase()}`);
  if (data.properties?.length) parts.push(data.properties.map((p) => p.name).join(', '));
  if (data.weight !== undefined) parts.push(`${data.weight} lb`);
  return parts.join('; ');
}

/** Body armour is worn one suit at a time; a shield is not body armour and stacks with it. */
function setEquipped(pc: PcState, item: InventoryItem, equipped: boolean): void {
  if (equipped && isBodyArmor(item)) {
    for (const other of pc.inventory) {
      if (other !== item && other.equipped && isBodyArmor(other)) other.equipped = false;
    }
  }
  item.equipped = equipped;
}

/** A magic item in hand that nobody has attuned to yet is doing nothing; say so once. */
function attunementNote(pc: PcState, item: InventoryItem): string | undefined {
  const magic = item.magic;
  if (!magic || magic.attunement === false || magic.attuned === true || item.equipped !== true) return undefined;
  const who = typeof magic.attunement === 'string' ? ` (${magic.attunement})` : '';
  return `${item.name} does nothing until ${pc.name} attunes to it${who}: rest with kind "short" and attune ["${item.name}"].`;
}

export function adjustGold(
  db: Db,
  input: {
    campaign_id: number;
    character_id?: number;
    delta?: number;
    coins?: Partial<Coins>;
    reason: string;
    allow_debt?: boolean;
  },
) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  if (input.delta === undefined && input.coins === undefined) {
    throw new Error('adjust_gold needs delta (gold pieces, negative to spend) or coins ({cp, sp, ep, gp, pp}).');
  }
  if (input.delta !== undefined && input.coins !== undefined) {
    throw new Error('adjust_gold takes delta (gold pieces) or coins ({cp, sp, ep, gp, pp}), not both: pass either delta or coins.');
  }
  const moved: Partial<Coins> = input.coins ?? { gp: input.delta! };
  const movedCp = coinsCp({ ...emptyCoins(), ...moved });
  payCoins(pc, moved, input.allow_debt === true);
  const amount = input.coins ? coinsText(coinsFromCp(Math.abs(movedCp))) : `${Math.abs(input.delta!)} gp`;
  return db.transaction(() => {
    savePc(db, pc);
    const text =
      movedCp < 0
        ? `${pc.name} pays ${amount} for ${input.reason} (${pc.gold} gp left).`
        : `${pc.name} gains ${amount} from ${input.reason} (${pc.gold} gp total).`;
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'gold',
      text,
      payload: { delta: movedCp / COIN_CP.gp, gold: pc.gold, coins: pc.coins, reason: input.reason },
    });
    return {
      name: pc.name,
      gold: pc.gold,
      coins: pc.coins,
      purse: coinsText(pc.coins),
      delta: input.delta ?? movedCp / COIN_CP.gp,
      in_debt: pc.gold < 0,
    };
  })();
}

export function addItem(
  db: Db,
  input: {
    campaign_id: number;
    character_id?: number;
    name: string;
    qty?: number;
    notes?: string;
    equipped?: boolean;
    cost_gp?: number;
    weight_lb?: number;
    allow_debt?: boolean;
    mirror?: boolean;
    /** What makes it magical; an item the SRD does not know must at least name its rarity. */
    magic?: Partial<ItemMagic>;
    /** True when nobody knows what it is yet: the player's sheet shows its kind only. */
    unidentified?: boolean;
    /** A container already carried, by name or id, to put it in rather than loose in the pack. */
    into?: string;
    /** The DM declaring this item holds things, for anything the SRD does not list as a container. */
    container?: ContainerCapacity;
  },
) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  const qty = input.qty ?? 1;
  if (qty < 1) throw new Error('qty must be at least 1.');
  const cost = input.cost_gp ?? 0;
  if (cost < 0) throw new Error('cost_gp cannot be negative; use adjust_gold to give gold back.');
  payGold(pc, -cost, input.allow_debt === true);

  const match = findMagicItem(input.name);
  const data = findEquipment(input.name);
  const magic = buildMagic(input.name, match, input.magic, input.unidentified === true, data);
  const name = match ? match.name : (data?.name ?? input.name.trim());
  const weight = input.weight_lb ?? resolveItemWeight(input.name);
  const before = combatNumbers(db, input.campaign_id, pc);

  const into = input.into === undefined ? undefined : requireItem(pc, input.into);
  const holder = into ? ensureContainer(into.item) : undefined;
  // An item inside a container is not in hand, so the two flags contradict each other rather than
  // stacking: refuse it while nothing has been written, as adjust_gold refuses delta and coins.
  if (holder && input.equipped === true) {
    throw new Error(
      `Nothing in the ${into!.item.name} is in use, so ${name} cannot be put in it and equipped at once. Add ${name} without into to wear or wield it now, or add it into the ${into!.item.name} and equip it with equip_item, which takes it out.`,
    );
  }
  const list = holder ? holder.contents : pc.inventory;
  if (holder?.capacity_lb !== undefined) {
    const added = (weight ?? 0) * qty;
    const inside = itemsWeight(holder.contents);
    if (inside + added > holder.capacity_lb) {
      throw new Error(
        `${into!.item.name} holds ${holder.capacity_lb} lb and already carries ${inside} lb; ${qty}x ${name} (${added} lb) will not fit.`,
      );
    }
  }

  const existing = list.find((i) => i.name.toLowerCase() === name.toLowerCase());
  const item: InventoryItem = existing ?? {
    name,
    qty: 0,
    weight_lb: weight ?? 0,
    id: nextItemId(takenItemIds(pc.inventory)),
  };
  item.qty += qty;
  if (existing) {
    if (input.notes) item.notes = input.notes;
    if (weight !== undefined) item.weight_lb = weight;
    if (magic) item.magic = { ...item.magic, ...magic };
    if (input.container) item.container = { ...input.container, contents: item.container?.contents ?? [] };
  } else {
    const note =
      input.notes ?? [data ? srdNote(data) : '', match ? magicNote(match) : ''].filter(Boolean).join('; ');
    if (note) item.notes = note;
    if (weight === undefined) item.notes = item.notes ? `${item.notes}; weight unknown` : 'weight unknown';
    if (magic) item.magic = magic;
    const container = input.container ?? containerSpec(name);
    if (container) item.container = { ...container, contents: [] };
    list.push(item);
  }
  if (input.equipped !== undefined) setEquipped(pc, item, input.equipped);
  recompute(pc);
  const after = combatNumbers(db, input.campaign_id, pc);
  const note = attunementNote(pc, item);

  return db.transaction(() => {
    savePc(db, pc);
    if (input.mirror !== false && (after.ac !== before.ac || after.speed !== before.speed)) {
      mirrorIntoCombat(db, input.campaign_id, pc);
    }
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'inventory',
      text: `${pc.name} gains ${qty}x ${displayItemName(item)}${into ? ` into their ${displayItemName(into.item)}` : ''}${cost ? ` for ${cost} gp (${pc.gold} gp left)` : ''}.`,
      payload: { name: displayItemName(item), qty, cost_gp: cost, gold: pc.gold },
    });
    return {
      name: pc.name,
      item,
      gold: pc.gold,
      coins: pc.coins,
      ac: pc.ac,
      inventory: pc.inventory,
      attunement: attunementState(pc),
      ...(into ? { inside: into.item.name } : {}),
      ...(note ? { attunement_note: note } : {}),
      ...loadReport(db, input.campaign_id, pc),
    };
  })();
}

export function removeItem(
  db: Db,
  input: { campaign_id: number; character_id?: number; name: string; qty?: number; force?: boolean; mirror?: boolean },
) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  const site = requireItem(pc, input.name);
  const item = site.item;
  const qty = input.qty ?? item.qty;
  if (qty < 1) throw new Error('qty must be at least 1.');
  if (qty > item.qty) throw new Error(`${pc.name} has ${item.qty}x ${item.name}, not ${qty}.`);
  const lost = qty === item.qty ? containerContents(item) : [];
  if (lost.length > 0 && input.force !== true) throw new Error(containerNotEmpty(item, lost, 'removed'));

  const before = combatNumbers(db, input.campaign_id, pc);
  item.qty -= qty;
  if (item.qty === 0) site.holder.splice(site.holder.indexOf(item), 1);
  recompute(pc);
  const after = combatNumbers(db, input.campaign_id, pc);

  return db.transaction(() => {
    savePc(db, pc);
    if (input.mirror !== false && (after.ac !== before.ac || after.speed !== before.speed)) {
      mirrorIntoCombat(db, input.campaign_id, pc);
    }
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'inventory',
      text: `${pc.name} loses ${qty}x ${displayItemName(item)}${item.qty ? ` (${item.qty} left)` : ''}${
        lost.length ? `, and what was inside it: ${lost.map(displayItemName).join(', ')}` : ''
      }.`,
      payload: {
        name: displayItemName(item),
        qty,
        remaining: item.qty,
        ...(lost.length ? { lost: lost.map(displayItemName) } : {}),
      },
    });
    return {
      name: pc.name,
      removed: qty,
      remaining: item.qty,
      ac: pc.ac,
      inventory: pc.inventory,
      ...(lost.length ? { contents_lost: lost.map((i) => `${i.qty}x ${i.name}`) } : {}),
      ...loadReport(db, input.campaign_id, pc),
    };
  })();
}

export function equipItem(
  db: Db,
  input: { campaign_id: number; character_id?: number; name: string; equipped: boolean; mirror?: boolean },
) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  const site = requireItem(pc, input.name);
  const item = site.item;
  const before = combatNumbers(db, input.campaign_id, pc);
  // Nothing inside a pack is in hand: equipping takes it out first, and AC only counts the top level.
  const from = input.equipped && site.holder !== pc.inventory ? holderOf(pc.inventory, site.holder) : undefined;
  if (from) {
    site.holder.splice(site.holder.indexOf(item), 1);
    pc.inventory.push(item);
  }
  setEquipped(pc, item, input.equipped);
  recompute(pc);
  const after = combatNumbers(db, input.campaign_id, pc);
  const note = attunementNote(pc, item);

  return db.transaction(() => {
    savePc(db, pc);
    if (input.mirror !== false && (after.ac !== before.ac || after.speed !== before.speed)) {
      mirrorIntoCombat(db, input.campaign_id, pc);
    }
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'inventory',
      text: from
        ? `${pc.name} takes the ${displayItemName(item)} from the ${displayItemName(from)} and equips it (AC ${pc.ac}).`
        : `${pc.name} ${input.equipped ? 'equips' : 'puts away'} ${displayItemName(item)} (AC ${pc.ac}).`,
      payload: { name: displayItemName(item), equipped: input.equipped, ac: pc.ac },
    });
    const gaps = equipmentProficiency(pc.proficiencies, pc.inventory);
    const untrained = [...gaps.armor_not_proficient, ...gaps.weapons_not_proficient];
    return {
      name: pc.name,
      item,
      ac: pc.ac,
      ac_breakdown: acBreakdown(pc),
      inventory: pc.inventory,
      ...(from ? { taken_from: from.name } : {}),
      ...(note ? { attunement_note: note } : {}),
      ...(untrained.length
        ? {
            warning: `${pc.name} is not proficient with ${untrained.join(', ')}.${
              gaps.armor_penalty
                ? ' Armour they are not trained in means Disadvantage on every Strength and Dexterity d20 test, and they cannot cast spells.'
                : ''
            }`,
            armor_penalty: gaps.armor_penalty,
            weapons_not_proficient: gaps.weapons_not_proficient,
          }
        : {}),
      character: sheet(db, input.campaign_id, input.character_id),
    };
  })();
}

export function listInventory(db: Db, input: { campaign_id: number; character_id?: number }) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  // loadPc hands out the ids a legacy row is missing; they only stick if this read writes them back.
  if (backfillItemWeights(allItems(pc.inventory)) || pc.ids_backfilled) {
    db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(JSON.stringify(pc.inventory), pc.id);
  }
  return {
    name: pc.name,
    gold: pc.gold,
    coins: pc.coins,
    purse: coinsText(pc.coins),
    items: dmItems(pc.inventory),
    attunement: attunementState(pc),
    ...loadReport(db, input.campaign_id, pc),
  };
}

/**
 * Spends charges off a wand, a staff or a ring. The spell it casts is the DM's to narrate and to run
 * through use_action or use_spell_slot; this only moves the charges and reads the item's text back.
 */
export function useItem(
  db: Db,
  input: { campaign_id: number; character_id?: number; item: string; charges?: number; restore?: number },
) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  const item = requireItem(pc, input.item).item;
  const charges = item.magic?.charges;
  if (!charges) {
    throw new Error(
      `${item.name} has no charges. use_item spends the charges of a wand, staff or ring; anything else is remove_item, use_spell_slot or plain narration.`,
    );
  }
  const restore = input.restore ?? 0;
  if (restore < 0) throw new Error('restore cannot be negative; charges are spent with charges.');
  if (restore > 0 && charges.current >= charges.max) {
    throw new Error(`${item.name} is already at ${charges.max} of ${charges.max} charges.`);
  }
  const restored = Math.min(restore, charges.max - charges.current);
  charges.current += restored;
  // A call that only restores charges spends none.
  const spend = input.charges ?? (restore > 0 ? 0 : 1);
  if (spend < 1 && restore === 0) throw new Error('charges must be at least 1.');
  if (spend > 0 && charges.current === 0) {
    throw new Error(
      charges.recharge === 'unknown'
        ? `${item.name} is empty and ${UNKNOWN_RECHARGE_NOTE}.`
        : `${item.name} has no charges left; it recharges ${RECHARGE_TEXT[charges.recharge]}.`,
    );
  }
  if (charges.current < spend) {
    throw new Error(
      `${item.name} has ${charges.current} of ${charges.max} charges left and cannot spend ${spend}; it recharges ${RECHARGE_TEXT[charges.recharge]}.`,
    );
  }
  charges.current -= spend;
  const text = findMagicItem(item.name)?.data.desc ?? item.notes ?? null;
  const shown = displayItemName(item);

  return db.transaction(() => {
    savePc(db, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'inventory',
      text: `${pc.name} ${[
        ...(restored > 0 ? [`gets ${restored} charge${restored === 1 ? '' : 's'} of ${shown} back on a DM ruling`] : []),
        ...(spend > 0 ? [`spends ${spend} charge${spend === 1 ? '' : 's'} of ${shown}`] : []),
      ].join(' and ')} (${charges.current}/${charges.max} left).`,
      payload: { name: shown, spent: spend, restored, remaining: charges.current, dm_ruling: restored > 0 },
    });
    return {
      name: pc.name,
      item: item.name,
      spent: spend,
      ...(restored > 0 ? { restored, ruling: 'A DM ruling handed those charges back; the SRD text did not.' } : {}),
      remaining: charges.current,
      max: charges.max,
      recharges: RECHARGE_TEXT[charges.recharge],
      ...(charges.recharge === 'unknown' ? { recharge_note: `${item.name}: ${UNKNOWN_RECHARGE_NOTE}.` } : {}),
      item_text: text,
    };
  })();
}

/** 2024 rule of thumb: a used item sells for half what the SRD lists it at. */
const SELL_FRACTION = 2;

export function sellItem(
  db: Db,
  input: {
    campaign_id: number;
    character_id?: number;
    item: string;
    qty?: number;
    price_gp?: number;
    force?: boolean;
    mirror?: boolean;
  },
) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  const site = requireItem(pc, input.item);
  const item = site.item;
  const qty = input.qty ?? 1;
  if (qty < 1) throw new Error('qty must be at least 1.');
  if (qty > item.qty) throw new Error(`${pc.name} has ${item.qty}x ${item.name}, not ${qty}.`);
  if (input.force !== true) {
    if (item.magic?.attuned === true) {
      throw new Error(
        `${pc.name} is still attuned to ${item.name}. End it on a short rest (rest kind "short", unattune ["${item.name}"]) or pass force true.`,
      );
    }
    if (item.equipped === true) {
      throw new Error(`${item.name} is still equipped. Take it off with equip_item, or pass force true.`);
    }
  }
  const lost = qty === item.qty ? containerContents(item) : [];
  if (lost.length > 0 && input.force !== true) throw new Error(containerNotEmpty(item, lost, 'sold'));
  // The SRD prices the mundane item a magic one is built on, never the magic one: that price is the DM's.
  const magical = item.magic !== undefined || namesMagicBonus(item.name);
  const listCp = magical ? undefined : itemCostCp(item.name);
  const unitCp =
    input.price_gp === undefined
      ? listCp === undefined
        ? undefined
        : Math.floor(listCp / SELL_FRACTION)
      : Math.round(input.price_gp * COIN_CP.gp);
  if (unitCp === undefined) {
    throw new Error(
      magical
        ? `The SRD puts no price on ${item.name}: a magic item has no SRD price, whatever the mundane item behind it costs. Pass price_gp with what the buyer pays for one of them.`
        : `The SRD puts no price on ${item.name}, so the engine cannot halve one. Pass price_gp with what the buyer pays for one of them.`,
    );
  }
  const rule =
    input.price_gp === undefined
      ? `half the SRD price of ${listCp! / COIN_CP.gp} gp (2024 rule of thumb for selling)`
      : 'the price you named';
  const paid = coinsFromCp(unitCp * qty);

  const before = combatNumbers(db, input.campaign_id, pc);
  item.qty -= qty;
  if (item.qty === 0) site.holder.splice(site.holder.indexOf(item), 1);
  pc.coins = addCoins(pc.coins, paid);
  pc.gold = coinsGp(pc.coins);
  recompute(pc);
  const after = combatNumbers(db, input.campaign_id, pc);

  return db.transaction(() => {
    savePc(db, pc);
    if (input.mirror !== false && (after.ac !== before.ac || after.speed !== before.speed)) {
      mirrorIntoCombat(db, input.campaign_id, pc);
    }
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'inventory',
      text: `${pc.name} sells ${qty}x ${displayItemName(item)} for ${coinsText(paid)} at ${rule}${
        lost.length ? `, and what was inside it: ${lost.map(displayItemName).join(', ')}` : ''
      } (${pc.gold} gp total).`,
      payload: { name: displayItemName(item), qty, price_cp: unitCp * qty, gold: pc.gold },
    });
    return {
      name: pc.name,
      item: item.name,
      sold: qty,
      remaining: item.qty,
      price_gp: (unitCp * qty) / COIN_CP.gp,
      paid: coinsText(paid),
      rule,
      ...(lost.length ? { contents_lost: lost.map((i) => `${i.qty}x ${i.name}`) } : {}),
      gold: pc.gold,
      coins: pc.coins,
      inventory: pc.inventory,
      ...loadReport(db, input.campaign_id, pc),
    };
  })();
}

// --- heroic inspiration -----------------------------------------------------

function setInspiration(db: Db, input: { campaign_id: number; character_id?: number; note?: string }, value: 0 | 1) {
  const pc = loadPc(db, input.campaign_id, input.character_id);
  if (value === 0 && pc.inspiration === 0) {
    throw new Error(`${pc.name} has no Heroic Inspiration to spend.`);
  }
  pc.inspiration = value;
  return db.transaction(() => {
    savePc(db, pc);
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'inspiration',
      text:
        value === 1
          ? `${pc.name} gains Heroic Inspiration.`
          : input.note
            ? `${pc.name} spends Heroic Inspiration: ${input.note}`
            : `${pc.name} spends their Heroic Inspiration.`,
      payload: { character_id: pc.id },
    });
    return { name: pc.name, inspiration: pc.inspiration };
  })();
}

export function grantInspiration(db: Db, input: { campaign_id: number; character_id?: number }) {
  return setInspiration(db, input, 1);
}

/** note carries the reroll the player bought with it, e.g. "7 -> 15". */
export function spendInspiration(db: Db, input: { campaign_id: number; character_id?: number; note?: string }) {
  return setInspiration(db, input, 0);
}
