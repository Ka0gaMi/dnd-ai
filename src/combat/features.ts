// The 2024 class features as engine mechanics: one handler per SRD feature index.
// The engine asks this registry at its hook points; a feature the character does not have is never consulted.
import type { Advantage } from '../core/dice.js';
import type { Ability } from '../core/rules.js';
import type { SpellEffect } from '../core/mechanics.js';
import { findInvocation, metamagicOptions, type EquipmentData, type StatBlockAction } from '../srd/data.js';
import { featureIndexesOf, findEquipment, upcastAddsTarget } from '../srd/lookup.js';
import { distanceBetween, distanceToPoint, type Point } from './grid.js';
import { compileHomebrew } from './homebrew.js';
import { sheetAbilityMod, type CombatSheet, type SheetFeature } from './sheet.js';
import type { Combatant, CombatFlags, Effect } from './state.js';

export type FeatureActionKind = 'action' | 'bonus_action' | 'reaction' | 'free';

/** How a feature resource comes back: on a short rest, on a long one, or never at all. */
export type ResourcePeriod = 'short' | 'long' | 'never';

/** Brutal Strike: the two effects at level 9, and the two Improved Brutal Strike adds at 13. */
export type BrutalStrikeOption = 'forceful' | 'hamstring' | 'staggering' | 'sundering';

/** Cunning Strike: the three effects at level 5, and the three Devious Strikes adds at 14. */
export type CunningStrikeOption = 'poison' | 'trip' | 'withdraw' | 'daze' | 'knock_out' | 'obscure';

/** What each Cunning Strike effect costs in Sneak Attack dice. */
export const CUNNING_STRIKE_COST: Record<CunningStrikeOption, number> = {
  poison: 1,
  trip: 1,
  withdraw: 1,
  daze: 2,
  obscure: 3,
  knock_out: 6,
};

/** The Cunning Strike effects Devious Strikes adds at Rogue level 14. */
export const DEVIOUS_STRIKES: CunningStrikeOption[] = ['daze', 'knock_out', 'obscure'];

/** The Cunning Strike effects the SRD has no condition for: the engine states them, the DM enforces them. */
export const CUNNING_STRIKE_DM_APPLIED: Partial<Record<CunningStrikeOption, string>> = {
  daze: 'on its next turn it can move or take an action or a Bonus Action, not both. There is no Dazed condition in the SRD, so nothing lands on the creature and the limit is yours to hold it to.',
};

/**
 * A D20 Test stance, declared before the roll the way Uncanny Dodge is declared before the blow: the
 * engine applies it to the next roll of that kind that fails, and the use is spent there, not here.
 */
export interface D20Stance {
  feature: string;
  /** reroll: roll again and keep it. add: add these dice to the total. set_20: the d20 becomes a 20. */
  mode: 'reroll' | 'add' | 'set_20';
  on: Array<'attack' | 'check' | 'save'>;
  /** What the new roll carries on top: Indomitable's Fighter level. */
  bonus?: number;
  /** The dice 'add' rolls: a Bardic Inspiration die, Boon of Fate's 2d4. */
  dice?: string;
  /** What firing costs; it is spent when the stance fires, and refused at the declaration. */
  spend?: FeatureCost;
  /** Peerless Skill: the use comes back when the roll fails even with the die on it. */
  keep_on_failure?: boolean;
}

/** A class resource and how much of it one use costs. */
export interface FeatureCost {
  resource: string;
  amount: number;
}

/** An action the registry puts in front of the DM, taken with use_action {action_name: id}. */
export interface FeatureAction {
  id: string;
  kind: FeatureActionKind;
  name: string;
  hint: string;
  cost?: FeatureCost;
  targets?: 'self' | 'creature' | 'ally';
  /**
   * What the use costs once the resource in cost is gone: Intimidating Presence's use of Rage, Holy
   * Nimbus's level 5 spell slot. The action stays on offer at 0 uses for as long as this is affordable.
   */
  fallback?: { label: string; affordable: boolean };
}

/** The flags the player sets on one attack; everything unconditional applies itself. */
export interface AttackOptions {
  /** Barbarian: Advantage on Strength attacks until your next turn, and Advantage on attacks against you. */
  reckless?: boolean;
  /** Rogue: false keeps the once-per-turn Sneak Attack back for a better swing. */
  sneak_attack?: boolean;
  /** Monk: spend a Focus Point on a hit to try to stun. */
  stunning_strike?: boolean;
  /** Barbarian 9: give up the Advantage on this swing for 1d10 and an effect, or two of them at 17. */
  brutal_strike?: BrutalStrikeOption | BrutalStrikeOption[];
  /** Rogue 5: Sneak Attack dice traded for these effects, at the die cost each one lists. */
  cunning_strike?: CunningStrikeOption[];
  /** Monk 17: spend 4 Focus Points on an Unarmed Strike to set the lethal vibrations going. */
  quivering_palm?: boolean;
  /** Warlock 14: try to hurl the creature you just hit through the Lower Planes. */
  hurl_through_hell?: boolean;
  /** Monk 6: an Unarmed Strike deals Force damage instead of its own type. */
  empowered_strike?: boolean;
  /** Monk 2: this swing is one of the Unarmed Strikes a Flurry of Blows bought. */
  flurry?: boolean;
  /** Paladin 3: this attack of the Attack action spends a Channel Divinity to bless the weapon first. */
  sacred_weapon?: boolean;
  /** Warlock: spend a Pact Magic slot on this pact-weapon hit (Eldritch Smite). */
  eldritch_smite?: boolean;
  /** The attacker holds a Bardic Inspiration die and adds it if the roll would otherwise miss. */
  inspiration?: boolean;
  /** Boon of Combat Prowess: turn this attack into a hit if it misses, once until your next turn starts. */
  peerless_aim?: boolean;
}

/** What the registry is told about the holder of a feature. */
export interface FeatureCtx {
  sheet: CombatSheet;
  actor: Combatant;
  /** The row on the sheet, so a handler can read the number the level table gave it. */
  feature: SheetFeature;
}

export interface AttackAsk extends FeatureCtx {
  target: Combatant;
  action: StatBlockAction;
  weapon: EquipmentData | undefined;
  /** The ability the swing uses, which is what Rage and Reckless Attack key off. */
  ability: Ability;
  melee: boolean;
  distance_ft: number;
  combatants: Combatant[];
  effects: Effect[];
  options: AttackOptions;
}

export interface HitAsk extends AttackAsk {
  advantage: Advantage;
  critical: boolean;
  damage_type: string | null;
  /** The target's hit points before this swing landed: Colossus Slayer asks whether it was already hurt. */
  target_hp_before: number;
  roll: { natural: number | null; total: number; dc: number; success: boolean };
}

export interface SaveAsk extends FeatureCtx {
  ability: Ability;
  /** The save is the one that keeps a spell's Concentration up, which Eldritch Mind cares about. */
  concentration?: boolean;
}

export interface CheckAsk extends FeatureCtx {
  ability: Ability;
  skill?: string;
  /** Initiative is a DEX check the registry treats specially. */
  initiative?: boolean;
  /** The check already carries a proficiency bonus, which is what Jack of All Trades asks about. */
  proficient?: boolean;
}

export interface DamageTakenAsk extends FeatureCtx {
  attacker: Combatant;
  damage: number;
  damage_type: string | null;
  distance_ft: number;
}

/** One reason a d20 moved, in the words the fight log prints. */
export interface RollSource {
  advantage: Advantage;
  note: string;
  /** The feature behind it, for the resource its use is spent from. */
  feature?: string;
  /** A flat bonus on the roll: what a homebrew clause adds to an attack, the way Archery would. */
  bonus?: number;
  /** What applying it costs; the engine spends it where the roll is made. */
  spend?: FeatureCost;
}

interface RiderBase {
  feature: string;
  note: string;
  /** Set when the engine could not run it: why it is the DM's to apply, for the reminders in the reply. */
  reminder?: string;
  /** The resource this rider costs; the engine spends it and says so in the log. */
  spend?: FeatureCost;
  /** A spell slot of this level the rider burns: Eldritch Smite, and nothing else. */
  spend_slot?: number;
  /** "One damage roll of that spell": the rider lands on the first target only, however many there are. */
  once_per_cast?: boolean;
}

/**
 * How long a condition a hit leaves runs, in the SRD's own words. Three of them close on a turn edge,
 * and whose edge it is decides everything: "its next turn" is the target's, "your next turn" the
 * source's. The engine keys each window to the creature the text names.
 */
export type RiderWindow =
  | 'start_of_your_next_turn'
  | 'end_of_your_next_turn'
  | 'end_of_its_next_turn'
  | 'minute'
  | 'manual';

/** What a feature adds to a hit, as data the engine resolves. */
export type HitRider =
  | (RiderBase & { kind: 'damage'; dice: string; damage_type: string | null })
  | (RiderBase & {
      kind: 'save';
      ability: Ability;
      dc: number;
      condition: string;
      ends: RiderWindow;
      /** What the target suffers on a successful save, narrated rather than applied. */
      on_success?: string;
      /** Damage a failed save takes on top of the condition: Hurl Through Hell's 8d10. */
      damage?: { expr: string; type: string; unless_type?: string };
    })
  | (RiderBase & { kind: 'condition'; condition: string; ends: RiderWindow; rounds?: number })
  | (RiderBase & { kind: 'stance'; flags: Partial<CombatFlags>; on: 'self' | 'target' })
  | (RiderBase & { kind: 'temp_hp'; amount: number; on: 'self' })
  | (RiderBase & { kind: 'push'; ft: number })
  | (RiderBase & { kind: 'move'; ft: number })
  | (RiderBase & { kind: 'note' });

/** What the registry is told about a spell being cast, off the entry the engine filled in. */
export interface SpellInfo {
  name: string;
  level: number;
  /** The slot the casting spends; null for a cantrip or a casting a feature pays for. */
  slot_level: number | null;
  school: string;
  damage_type: string | null;
  attack_roll: boolean;
  save_ability?: Ability;
  concentration: boolean;
  range_ft: number | null;
  /** The class lists the spell is on, as the SRD entry carries them ("srd-2024_wizard"). */
  classes: string[];
}

/** What the player asked for on this casting, beyond the spell itself. */
export interface CastOptions {
  /** Metamagic options named for this casting; the engine has already checked they are known and paid for. */
  metamagic: string[];
  /** Sculpt Spells: the creatures carved out of the evocation. */
  sculpt?: number[];
  /** Careful Spell: the creatures the caster protects. */
  careful_targets?: number[];
  /** Twinned Spell: the second creature. */
  twin_target?: number;
  /** Heightened Spell: the creature that saves with Disadvantage. */
  heighten_target?: number;
  /** Transmuted Spell: the damage type the spell deals instead. */
  transmute_to?: string;
}

export interface CastAsk extends FeatureCtx {
  spell: SpellInfo;
  targets: Combatant[];
  options: CastOptions;
}

/** What a feature does to a casting before it happens, as data the engine applies. */
export type CastModifier = RiderBase &
  (
    | { kind: 'economy'; economy: FeatureActionKind }
    | { kind: 'range'; multiplier?: number; least_ft?: number }
    | { kind: 'save_dc'; bonus: number }
    | { kind: 'attack_bonus'; bonus: number }
    | { kind: 'attack_advantage' }
    | { kind: 'reroll_attack' }
    | { kind: 'extra_target'; target_id: number; within_ft?: number }
    | { kind: 'slot_level'; increase: number }
    | { kind: 'duration'; multiplier: number; concentration_advantage?: boolean }
    | { kind: 'save_disadvantage'; target_id: number }
    | { kind: 'auto_success'; target_ids: number[] }
    | { kind: 'damage_type'; to: string }
    | { kind: 'reroll_damage'; dice: number }
    | { kind: 'note' }
  );

export interface SpellDamageAsk extends FeatureCtx {
  spell: SpellInfo;
  target: Combatant;
  damage_type: string | null;
}

export interface HealAsk extends FeatureCtx {
  spell: SpellInfo;
  target: Combatant;
  amount: number;
}

/** Hit points a feature adds to a spell's healing, and the ones it pours back into the caster. */
export interface HealRider {
  feature: string;
  note: string;
  bonus?: number;
  self_heal?: number;
  /** What the extra healing costs; the engine spends it where the healing lands. */
  spend?: FeatureCost;
  /** A rationed rider lands on the first creature the casting heals, however many it heals. */
  once_per_cast?: boolean;
}

export interface SaveSucceededAsk extends FeatureCtx {
  spell: SpellInfo;
  target: Combatant;
  /** The spell attack missed rather than the save succeeding; Potent Cantrip covers both. */
  missed: boolean;
  roll?: { natural: number | null; total: number; dc: number; success: boolean };
}

/** What a creature that got out of the way takes anyway: Potent Cantrip's half damage. */
export interface DamageMitigation {
  feature: string;
  note: string;
  take: 'half';
}

export interface KillAsk extends FeatureCtx {
  victim: Combatant;
  distance_ft: number;
  /** The holder of the feature struck the blow; false when somebody else did. */
  by_me: boolean;
}

/** A reaction the result offers; the DM takes it with use_action {action_name, out_of_turn: true}. */
export interface ReactionOffer {
  action: string;
  name: string;
  hint: string;
}

/** A save a feature's own action forces on the creatures it names, resolved by the engine. */
export interface FeatureSave {
  ability: Ability;
  dc: number;
  target_ids: number[];
  damage_expr?: string;
  damage_type?: string;
  half_on_save?: boolean;
  /** What a failed save leaves on the creature. */
  conditions?: string[];
  ends?: 'start_of_next_turn' | 'minute' | 'manual';
  /** The conditions end the moment the creature takes damage, however long it had left: Turn Undead. */
  ends_on_damage?: boolean;
  /** The creature repeats the save at the end of each of its turns: Intimidating Presence. */
  repeat_save?: boolean;
  /** Damage every creature that failed takes on top of the save's own: Sear Undead. */
  extra_expr?: string;
  extra_type?: string;
  extra_note?: string;
}

/** Everything a feature's own action does, as data; the engine applies it inside its snapshot. */
export interface FeatureOutcome {
  economy: FeatureActionKind;
  text: string;
  /** Which feature it came from, for the hooks that have no action of their own to name. */
  feature?: string;
  /** What the use costs; an array when it costs two resources at once, as Wild Resurgence does. */
  spend?: FeatureCost | FeatureCost[];
  /** A saving throw the action forces: Divine Spark, Turn Undead, Land's Aid. */
  save?: FeatureSave;
  /** Hit points poured into named creatures: Preserve Life, Land's Aid, Divine Spark. */
  heals?: Array<{ target_id: number; amount?: number; expr?: string }>;
  /** Flags left on the action's target rather than on its taker. */
  target_flags?: Partial<CombatFlags>;
  /** A Bardic Inspiration die handed to a creature, which its own sheet then carries. */
  inspire?: { target_id: number; die: number };
  /** Uses handed back to another class resource: Font of Inspiration, Wild Resurgence. */
  restore_resource?: { key: string; amount: number };
  /** A spell slot of this level the feature burns, and one it hands back. */
  spend_slot?: number;
  gain_slot?: number;
  /** Temporary hit points with no dice behind them: Wild Shape's, which is the Druid's level. */
  temp_hp_amount?: number;
  /** Wild Shape: the Beast form to take, or the way back out of one. */
  shape?: { form: string; max_cr: number; fly: boolean } | { revert: true };
  /** Hit points restored to the action's target, which is the actor when it touches itself. */
  heal_expr?: string;
  heal_amount?: number;
  temp_hp_expr?: string;
  flags?: Partial<CombatFlags>;
  /** Standard actions the feature takes for free: Cunning Action, Patient Defense, Step of the Wind. */
  standard?: string[];
  /** Feet of movement the feature hands out on top of what is left. */
  movement_ft?: number;
  /** Conditions lifted off the actor, by name. */
  remove_conditions?: string[];
  /** A condition the feature puts on its own taker: Nature's Veil's Invisible. */
  self_condition?: { name: string; rounds: number };
  /** A stance on the next failed D20 Test: Indomitable, Peerless Skill, Stroke of Luck. */
  d20_stance?: D20Stance;
  /** Every expended Focus Point back: Uncanny Metabolism, and nothing else. */
  restore_focus?: boolean;
  /** Heroic Inspiration for the player character: Heroic Warrior, and nothing else. */
  grant_inspiration?: boolean;
  /** The target's damage traits, read out: Hunter's Lore. */
  read_traits?: boolean;
  notes?: string[];
  /** A homebrew action's spell-shaped payload, resolved by the combat action runner rather than here. */
  action_effect?: {
    effect: SpellEffect;
    concentration: boolean;
    duration_rounds: number | null;
    range_ft: number | null;
  };
}

export interface ResolveAsk extends FeatureCtx {
  target: Combatant | null;
  combatants: Combatant[];
  round: number;
  /** The cell an area feature is centred on: Land's Aid, and nothing else. */
  point?: Point;
  /** The spell slot the feature burns or creates: Font of Magic, Font of Inspiration, Wild Resurgence. */
  slot_level?: number;
  /** Which of the handler's actions was taken, for a feature that offers more than one. */
  action_id: string;
  /** How many hit points a Lay On Hands touch pours out. */
  amount?: number;
  /** Which of a feature's options the DM chose: "dash", "poison", the weapon a Sacred Weapon blesses. */
  option?: string;
}

/** What a feature puts on the sheet rather than on a roll; the AC and the speed live in character.ts. */
export interface FeaturePassive {
  /** Damage types the holder resists while the feature is running. */
  resistances?: string[];
  /** Conditions the feature keeps off its holder. */
  condition_immunities?: string[];
  note?: string;
}

export interface FeatureHandler {
  /** The SRD feature index this handler is filed under. */
  index: string;
  name: string;
  /** The SRD class index the feature belongs to; a subclass feature is filed under its parent class. */
  class: string;
  level: number;
  /** What the engine leaves to the DM; a feature that is applied in part names only the part it leaves. */
  dm_applied?: string;
  /** The resource the feature spends, for the features the level table has no column for. */
  resource?: {
    key: string;
    label: string;
    /** never: a use that no rest gives back, which is what `once_ever` means. */
    per: ResourcePeriod;
    regain_on_short?: 'one';
    max: (sheet: CombatSheet) => number;
  };
  /** The resources of a feature that counts several at once: one Mystic Arcanum a spell level. */
  resources?: (sheet: CombatSheet) => Array<{ key: string; label: string; per: ResourcePeriod; max: number }>;
  action?: (sheet: CombatSheet) => FeatureAction | FeatureAction[] | null;
  resolve?: (ask: ResolveAsk) => FeatureOutcome;
  beforeAttack?: (ask: AttackAsk) => RollSource[];
  /** What this feature does to an attack roll made against its holder. */
  againstMe?: (ask: FeatureCtx) => RollSource[];
  onHit?: (ask: HitAsk) => HitRider[];
  onMiss?: (ask: HitAsk) => HitRider[];
  onDamageTaken?: (ask: DamageTakenAsk) => ReactionOffer | null;
  /** What applies to the holder after damage, alongside (never instead of) reaction offers. */
  onDamageTakenOutcome?: (ask: DamageTakenAsk) => FeatureOutcome | null;
  /** The lowest natural d20 that is a critical hit for this holder. */
  critRange?: (sheet: CombatSheet) => number;
  beforeSave?: (ask: SaveAsk) => RollSource[];
  beforeCheck?: (ask: CheckAsk) => RollSource[];
  /** The flat bonus this feature puts on an ability check: Jack of All Trades, Thaumaturge, Magician. */
  checkBonus?: (ask: CheckAsk) => { bonus: number; note: string } | null;
  /** What the feature does to a casting before it happens: Metamagic, Sculpt Spells, Innate Sorcery. */
  beforeCast?: (ask: CastAsk) => CastModifier[];
  /** What it adds to a spell's damage: Empowered Evocation, Elemental Affinity, Agonizing Blast. */
  onSpellDamage?: (ask: SpellDamageAsk) => HitRider[];
  /** What it adds to a spell's healing: Disciple of Life, Blessed Healer. */
  onHeal?: (ask: HealAsk) => HealRider[];
  /** What a creature that saved (or was missed) takes anyway: Potent Cantrip. */
  onSaveSucceeded?: (ask: SaveSucceededAsk) => DamageMitigation | null;
  /** What applies to the spell's holder after a target succeeds on its save or avoids its attack. */
  onSaveSucceededOutcome?: (ask: SaveSucceededAsk) => FeatureOutcome | null;
  /** What dropping a creature to 0 hit points gives its holder: Dark One's Blessing. */
  onKill?: (ask: KillAsk) => FeatureOutcome | null;
  passive?: (sheet: CombatSheet) => FeaturePassive | null;
  /** What rolling Initiative hands back: Perfect Focus, Superior Inspiration, Persistent Rage, Archdruid. */
  onInitiative?: (ask: FeatureCtx) => FeatureOutcome | null;
  /** A stance that arms itself rather than being declared: a homebrew reroll the prose gives outright. */
  autoStance?: (sheet: CombatSheet, kind: 'attack' | 'check' | 'save') => D20Stance | null;
  turnStart?: (ask: FeatureCtx) => FeatureOutcome | null;
  turnEnd?: (ask: FeatureCtx) => FeatureOutcome | null;
}

/** The actions one handler puts in front of this character; Monk's Focus offers three. */
export function actionsOf(handler: FeatureHandler, sheet: CombatSheet): FeatureAction[] {
  const declared = handler.action?.(sheet);
  if (!declared) return [];
  return Array.isArray(declared) ? declared : [declared];
}

// --- reading the numbers off a sheet -----------------------------------------

/** The feature row carrying a class resource, by the key the level table gave it. */
export const resourceRow = (sheet: CombatSheet, key: string): SheetFeature | undefined =>
  sheet.features.find((f) => f.mechanics?.resource === key);

/** The number a class resource stands at: rage uses, sneak attack dice, the martial arts die size. */
export const resourceMax = (sheet: CombatSheet, key: string): number => resourceRow(sheet, key)?.mechanics?.max ?? 0;

export interface ResourceState {
  resource: string;
  max: number;
  used: number;
  left: number;
}

/** What is left of a spendable resource, with the handler's own maximum when the table has no column. */
export function resourceState(sheet: CombatSheet, handler: FeatureHandler): ResourceState | null {
  const key = handler.resource?.key ?? actionsOf(handler, sheet)[0]?.cost?.resource;
  if (!key) return null;
  const row = resourceRow(sheet, key);
  const max = handler.resource ? handler.resource.max(sheet) : (row?.mechanics?.max ?? 0);
  const used = row?.mechanics?.used ?? 0;
  return { resource: key, max, used, left: Math.max(0, max - used) };
}

const mod = (sheet: CombatSheet, ability: Ability): number => sheetAbilityMod(sheet, ability);

/** 8 + an ability modifier + the proficiency bonus: the DC a feature's save is rolled against. */
const featureDc = (sheet: CombatSheet, ability: Ability): number => 8 + mod(sheet, ability) + sheet.proficiency_bonus;

const wearingArmor = (sheet: CombatSheet): boolean =>
  sheet.inventory.some((item) => {
    if (!item.equipped) return false;
    const data = findEquipment(item.name);
    return data?.armor_class !== undefined && data.index !== 'shield';
  });

const heavyArmor = (sheet: CombatSheet): boolean =>
  sheet.inventory.some((item) => {
    if (!item.equipped) return false;
    return findEquipment(item.name)?.equipment_categories.some((c) => c.index === 'heavy-armor') ?? false;
  });

const holdingShield = (sheet: CombatSheet): boolean =>
  sheet.inventory.some((item) => item.equipped && findEquipment(item.name)?.index === 'shield');

/** Martial Arts only works unarmoured, shieldless and with Monk weapons in hand. */
export const monkStance = (sheet: CombatSheet): boolean => !wearingArmor(sheet) && !holdingShield(sheet);

/** Monk weapons: Simple Melee weapons, and Martial Melee weapons with the Light property. */
export function isMonkWeapon(equipment: EquipmentData | undefined): boolean {
  // An Unarmed Strike has no equipment entry and always counts.
  if (!equipment) return true;
  const categories = equipment.equipment_categories.map((c) => c.index);
  if (categories.includes('ranged-weapons')) return false;
  if (categories.includes('simple-weapons')) return true;
  const light = equipment.properties?.some((p) => p.index === 'light') ?? false;
  return categories.includes('martial-weapons') && light;
}

export const isUnarmedStrike = (action: StatBlockAction): boolean => /unarmed strike/i.test(action.name);

/** Whether a swing may carry Sneak Attack: a Finesse weapon or a ranged one. */
export function sneakAttackWeapon(equipment: EquipmentData | undefined): boolean {
  if (!equipment) return false;
  const ranged = equipment.equipment_categories.some((c) => c.index === 'ranged-weapons');
  return ranged || (equipment.properties?.some((p) => p.index === 'finesse') ?? false);
}

const FIVE_FT = 5;
const AURA_FT = 10;
const INCAPACITATING = ['incapacitated', 'paralyzed', 'petrified', 'stunned', 'unconscious'];

/** An ally of the attacker, not incapacitated, standing within 5 ft of the target. */
function allyBeside(ask: AttackAsk): Combatant | undefined {
  return ask.combatants.find(
    (c) =>
      c.id !== ask.actor.id &&
      c.id !== ask.target.id &&
      c.alive &&
      c.hp_current > 0 &&
      c.team === ask.actor.team &&
      distanceBetween(c, ask.target) <= FIVE_FT &&
      !INCAPACITATING.some((condition) => c.conditions.includes(condition)),
  );
}

/** 10 minutes, the ceiling the 2024 text puts on one Rage. */
const RAGE_ROUNDS = 100;

/** 10 minutes, in rounds: a Sacred Weapon's blessing and everything else the text gives that long. */
export const TEN_MINUTES_ROUNDS = 100;

/** 1 minute, in rounds: Innate Sorcery, and the conditions a save ends. */
const MINUTE_ROUNDS = 10;

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

/** What the player picked for a feature that is itself a choice, off the sheet row of that name. */
export function chosenOptions(sheet: CombatSheet, feature: string): string[] {
  return sheet.features.filter((f) => f.name.toLowerCase() === feature.toLowerCase()).flatMap((f) => f.mechanics?.options ?? []);
}

/** Whether a choice feature was answered with this option. */
const chose = (sheet: CombatSheet, feature: string, option: string): boolean =>
  chosenOptions(sheet, feature).some((picked) => picked.toLowerCase() === option.toLowerCase());

/** The Eldritch Invocations this warlock holds, by name. */
export const heldInvocations = (sheet: CombatSheet): string[] => chosenOptions(sheet, 'Eldritch Invocations');

export const hasInvocation = (sheet: CombatSheet, name: string): boolean =>
  heldInvocations(sheet).some((held) => held.toLowerCase() === name.toLowerCase());

/** The Metamagic options this sorcerer knows, by name. */
export const heldMetamagic = (sheet: CombatSheet): string[] => chosenOptions(sheet, 'Metamagic');

/** The spell save DC off the sheet, falling back to the class ability when the row carries none. */
const spellDc = (sheet: CombatSheet, ability: Ability): number => sheet.spells.save_dc ?? featureDc(sheet, ability);

/** Half the proficiency bonus, rounded down: what Jack of All Trades adds. */
const halfProficiency = (sheet: CombatSheet): number => Math.floor(sheet.proficiency_bonus / 2);

/** The Bardic Inspiration die the table gives this level, as its number of faces. */
export const bardicDie = (sheet: CombatSheet): number => resourceMax(sheet, 'bardic_inspiration_die') || 6;

/** Beast forms: what Wild Shape may turn into at this Druid level. */
export const beastFormLimits = (level: number): { max_cr: number; fly: boolean; known: number } =>
  level >= 8 ? { max_cr: 1, fly: true, known: 8 } : level >= 4 ? { max_cr: 0.5, fly: false, known: 6 } : { max_cr: 0.25, fly: false, known: 4 };

/** Wild Shape lasts half the Druid's level in hours; the flag counts that out in rounds. */
export const wildShapeRounds = (level: number): number => Math.max(1, Math.floor(level / 2)) * 600;

export const isWildShaped = (actor: Combatant): boolean => actor.flags.wild_shape !== undefined;

/** Innate Sorcery: running, and so lending its DC and its Advantage to Sorcerer spells. */
const innateSorcery = (actor: Combatant): boolean => actor.flags.innate_sorcery !== undefined;

/** Whether a spell is on a class's own list, as the SRD entry spells it. */
export const onClassList = (spell: SpellInfo, classIndex: string): boolean =>
  spell.classes.some((entry) => entry.endsWith(`_${classIndex}`));

const isCantrip = (spell: SpellInfo): boolean => spell.level === 0;

export const isRaging = (actor: Combatant): boolean => actor.flags.raging !== undefined;

/** A feat on the sheet, by name: the Epic Boons the engine applies are read off here. */
export const hasFeat = (sheet: CombatSheet, name: string): boolean =>
  sheet.features.some((f) => f.source === 'feat' && f.name.toLowerCase() === name.toLowerCase());

/** Aura of Protection reaches 10 ft, and 30 once Aura Expansion has widened it. */
export const auraFt = (sheet: CombatSheet): number => (hasFeature(sheet, 'paladin-aura-expansion') ? 30 : AURA_FT);

/** Brutal Strike's effects as a list, however the swing named them. */
export const brutalStrikeOptions = (chosen: BrutalStrikeOption | BrutalStrikeOption[] | undefined): BrutalStrikeOption[] =>
  chosen === undefined ? [] : Array.isArray(chosen) ? chosen : [chosen];

/** The creatures of the other side within this many feet of a point, alive and standing. */
const enemiesWithin = (ask: ResolveAsk, ft: number): Combatant[] =>
  ask.combatants.filter(
    (c) => c.id !== ask.actor.id && c.alive && c.hp_current > 0 && c.team !== ask.actor.team && distanceBetween(ask.actor, c) <= ft,
  );

/** What is left of a resource on this sheet, by its key - the handler's own maximum included. */
const leftOf = (sheet: CombatSheet, key: string): number => {
  const row = resourceRow(sheet, key);
  const max = resourceSpec(sheet, key)?.max ?? row?.mechanics?.max ?? 0;
  return Math.max(0, max - (row?.mechanics?.used ?? 0));
};

/** How many uses of a resource have been spent since the rest that gives them back. */
const spentOf = (sheet: CombatSheet, key: string): number => resourceRow(sheet, key)?.mechanics?.used ?? 0;

/** Spell slots of that level still open, the ones a feature wove out of nothing included. */
const openSlotsAt = (sheet: CombatSheet, level: number): number => {
  const slot = sheet.spell_slots?.[String(level)];
  return slot ? Math.max(0, slot.max + (slot.bonus ?? 0) - slot.used) : 0;
};

// --- the Epic Boon feats, which every class takes at level 19 ------------------

/** What each Epic Boon of the bundled data does here, and what is left to the DM until its package. */
const EPIC_BOONS: Record<string, { applied: string } | { dm_applied: string }> = {
  'Boon of Combat Prowess': {
    applied:
      'Peerless Aim: a miss becomes a hit instead - ask for it on the swing with attack {peerless_aim: true}, once until the start of your next turn.',
  },
  'Boon of Dimensional Travel': {
    dm_applied: 'Blink Steps teleports you 30 ft after an Attack or Magic action, and teleportation arrives with the movement modes of R9.',
  },
  'Boon of Fate': {
    applied:
      'Improve Fate: 2d4 on one of your own D20 Tests - declare it with use_action {action_name: "boon_of_fate"} and the engine adds it to the next roll that would fail. Two halves are left to you: lending it to another creature within 60 ft, which needs a reaction offered to a third party, and subtracting the 2d4 from a successful D20 Test an enemy made, which the engine has no seam to reach into.',
  },
  'Boon of Irresistible Offense': {
    applied:
      'Overcome Defenses: your bludgeoning, piercing and slashing damage ignores Resistance. Overwhelming Strike: a natural 20 deals extra damage equal to the score this boon raised.',
  },
  'Boon of Spell Recall': { applied: 'Free Casting: a level 1-4 slot is rolled for and sometimes not expended at all.' },
  'Boon of the Night Spirit': {
    dm_applied: 'Merging with the shadows and resisting damage in them both turn on light levels, which R7 brings.',
  },
  'Boon of Truesight': { dm_applied: 'Truesight is a sense, and the vision rules arrive with R7.' },
};

/** The Epic Boon this character took, if the SRD knows it. */
export const heldBoon = (sheet: CombatSheet): string | null =>
  Object.keys(EPIC_BOONS).find((name) => hasFeat(sheet, name)) ?? null;

export const hasBoon = (sheet: CombatSheet, name: string): boolean => hasFeat(sheet, name);

/** Boon of Irresistible Offense: the score it raised, which a natural 20 adds to the damage. */
export function irresistibleOffense(sheet: CombatSheet): { ability: Ability; score: number } | null {
  if (!hasFeat(sheet, 'Boon of Irresistible Offense')) return null;
  const picked = (chosenOptions(sheet, 'Boon of Irresistible Offense')[0] ?? 'str').toLowerCase() as Ability;
  return { ability: picked, score: sheet.abilities[picked]?.score ?? 10 };
}

/** What the Epic Boon row says on the sheet: what it took, and what the engine does with it. */
function epicBoonPassive(sheet: CombatSheet): FeaturePassive {
  const boon = heldBoon(sheet);
  if (!boon) {
    return { note: 'Epic Boon: the feat taken at level 19 is on the sheet; a boon outside the bundled SRD data is yours to apply.' };
  }
  const entry = EPIC_BOONS[boon]!;
  return { note: `${boon}: ${'applied' in entry ? entry.applied : `left to you - ${entry.dm_applied}`}` };
}

/** The actions an Epic Boon puts in front of the DM: Boon of Fate's 2d4, and nothing else. */
function boonActions(sheet: CombatSheet): FeatureAction[] {
  if (!hasFeat(sheet, 'Boon of Fate')) return [];
  return [
    {
      id: 'boon_of_fate',
      kind: 'free',
      name: 'Boon of Fate',
      hint: 'Declare it and the next D20 Test of yours that would fail carries 2d4. It comes back when you roll Initiative or finish a rest.',
      cost: { resource: 'boon_of_fate', amount: 1 },
      targets: 'self',
    },
  ];
}

/** One Epic Boon resolve, shared by all twelve classes: only Boon of Fate has an action of its own. */
function boonResolve(ask: ResolveAsk): FeatureOutcome {
  return {
    economy: 'free',
    d20_stance: {
      feature: 'Boon of Fate',
      mode: 'add',
      on: ['attack', 'check', 'save'],
      dice: '2d4',
      spend: { resource: 'boon_of_fate', amount: 1 },
    },
    text: `${ask.actor.name} leans on fate: 2d4 rides on their next D20 Test that would otherwise fail (Boon of Fate).`,
  };
}

/** Boon of Fate comes back when its holder rolls Initiative, as well as on a rest. */
function boonInitiative(ask: FeatureCtx): FeatureOutcome | null {
  if (!hasFeat(ask.sheet, 'Boon of Fate')) return null;
  const spent = spentOf(ask.sheet, 'boon_of_fate');
  if (spent <= 0) return null;
  return {
    economy: 'free',
    restore_resource: { key: 'boon_of_fate', amount: spent },
    text: `${ask.actor.name} rolls Initiative and Boon of Fate is theirs again.`,
  };
}

/** The Epic Boon handler every class files at level 19; the boon itself is the feat on the sheet. */
const epicBoon = (classIndex: string): FeatureHandler => ({
  index: `${classIndex}-epic-boon`,
  name: 'Epic Boon',
  class: classIndex,
  level: 19,
  resource: { key: 'boon_of_fate', label: 'Boon of Fate', per: 'short', max: (sheet) => (hasFeat(sheet, 'Boon of Fate') ? 1 : 0) },
  action: (sheet) => boonActions(sheet),
  resolve: (ask) => boonResolve(ask),
  onInitiative: (ask) => boonInitiative(ask),
  passive: (sheet) => epicBoonPassive(sheet),
});

// --- Barbarian ----------------------------------------------------------------

const BARBARIAN: FeatureHandler[] = [
  {
    index: 'barbarian-rage',
    name: 'Rage',
    class: 'barbarian',
    level: 1,
    action: (sheet) =>
      heavyArmor(sheet)
        ? null
        : {
            id: 'rage',
            kind: 'bonus_action',
            name: 'Rage',
            hint: `Resistance to bludgeoning, piercing and slashing, +${resourceMax(sheet, 'rage_damage')} damage on Strength attacks, Advantage on Strength checks and saves, and no spells or Concentration. It lasts until the end of your next turn and extends itself whenever you attack, force a save or spend a bonus action on it.`,
            cost: { resource: 'rage', amount: 1 },
            targets: 'self',
          },
    resolve: (ask) => ({
      economy: 'bonus_action',
      spend: { resource: 'rage', amount: 1 },
      flags: { raging: { extended_round: ask.round, rounds_left: RAGE_ROUNDS } },
      text: `${ask.actor.name} rages: Resistance to bludgeoning, piercing and slashing damage, +${resourceMax(ask.sheet, 'rage_damage')} damage on Strength attacks, Advantage on Strength checks and saves, and no spellcasting or Concentration.`,
      // Instinctive Pounce, at level 7, rides on the very bonus action that starts the Rage.
      ...(hasFeature(ask.sheet, 'barbarian-instinctive-pounce')
        ? {
            movement_ft: Math.floor(ask.actor.speed / 2),
            notes: ['Instinctive Pounce: half your Speed comes with the Rage.'],
          }
        : {}),
    }),
    passive: (sheet) => ({
      note: `Rage: Resistance to bludgeoning, piercing and slashing while it is running, and +${resourceMax(sheet, 'rage_damage')} damage on Strength attacks.`,
    }),
    beforeCheck: (ask) =>
      isRaging(ask.actor) && ask.ability === 'str' ? [{ advantage: 'advantage', note: `${ask.actor.name} is raging` }] : [],
    beforeSave: (ask) =>
      isRaging(ask.actor) && ask.ability === 'str' ? [{ advantage: 'advantage', note: `${ask.actor.name} is raging` }] : [],
    onHit: (ask) => {
      if (!isRaging(ask.actor) || ask.ability !== 'str') return [];
      const bonus = resourceMax(ask.sheet, 'rage_damage');
      if (bonus <= 0) return [];
      return [
        {
          kind: 'damage',
          feature: 'Rage',
          dice: String(bonus),
          damage_type: ask.damage_type,
          note: `Rage Damage: +${bonus}${ask.damage_type ? ` ${ask.damage_type}` : ''} damage.`,
        },
      ];
    },
  },
  {
    index: 'barbarian-unarmored-defense',
    name: 'Unarmored Defense',
    class: 'barbarian',
    level: 1,
    passive: (sheet) =>
      wearingArmor(sheet)
        ? null
        : { note: `Unarmored Defense: 10 + DEX + CON (+${mod(sheet, 'con')} from CON) while you wear no armour.` },
  },
  {
    index: 'barbarian-danger-sense',
    name: 'Danger Sense',
    class: 'barbarian',
    level: 2,
    beforeSave: (ask) =>
      ask.ability === 'dex' && !INCAPACITATING.some((c) => ask.actor.conditions.includes(c))
        ? [{ advantage: 'advantage', note: 'Danger Sense' }]
        : [],
  },
  {
    index: 'barbarian-reckless-attack',
    name: 'Reckless Attack',
    class: 'barbarian',
    level: 2,
    beforeAttack: (ask) => {
      const reckless = ask.actor.flags.reckless === true || ask.options.reckless === true;
      if (!reckless || ask.ability !== 'str') return [];
      // Brutal Strike is bought by giving this Advantage up on the swing it is used on.
      if (ask.options.brutal_strike) return [];
      return [{ advantage: 'advantage', note: 'Reckless Attack' }];
    },
    againstMe: (ask) =>
      ask.actor.flags.reckless ? [{ advantage: 'advantage', note: `${ask.actor.name} attacked recklessly` }] : [],
  },
  {
    index: 'barbarian-primal-knowledge',
    name: 'Primal Knowledge',
    class: 'barbarian',
    level: 3,
    dm_applied:
      'Rolling Stealth or Perception as a Strength check is an out-of-combat ability check, and the engine does not own that roll flow.',
  },
  {
    index: 'berserker-frenzy',
    name: 'Frenzy',
    class: 'barbarian',
    level: 3,
    onHit: (ask) => {
      if (!isRaging(ask.actor) || !ask.actor.flags.reckless || ask.ability !== 'str') return [];
      if (ask.actor.flags.frenzy_used) return [];
      const dice = resourceMax(ask.sheet, 'rage_damage');
      if (dice <= 0) return [];
      return [
        {
          kind: 'damage',
          feature: 'Frenzy',
          dice: `${dice}d6`,
          damage_type: ask.damage_type,
          note: `Frenzy: ${dice}d6 extra${ask.damage_type ? ` ${ask.damage_type}` : ''} damage on the first target hit this turn.`,
        },
        { kind: 'stance', feature: 'Frenzy', on: 'self', flags: { frenzy_used: true }, note: 'Frenzy is spent for this turn.' },
      ];
    },
  },
  {
    index: 'barbarian-fast-movement',
    name: 'Fast Movement',
    class: 'barbarian',
    level: 5,
    passive: (sheet) => (heavyArmor(sheet) ? null : { note: 'Fast Movement: +10 ft out of heavy armour.' }),
  },
  {
    index: 'berserker-mindless-rage',
    name: 'Mindless Rage',
    class: 'barbarian',
    level: 6,
    passive: () => ({
      condition_immunities: ['charmed', 'frightened'],
      note: 'Mindless Rage: immune to Charmed and Frightened while the Rage is running.',
    }),
  },
  {
    index: 'barbarian-feral-instinct',
    name: 'Feral Instinct',
    class: 'barbarian',
    level: 7,
    beforeCheck: (ask) => (ask.initiative ? [{ advantage: 'advantage', note: 'Feral Instinct' }] : []),
  },
  {
    index: 'barbarian-instinctive-pounce',
    name: 'Instinctive Pounce',
    class: 'barbarian',
    level: 7,
    // Applied by Rage: the movement comes with the bonus action that starts it.
  },
  {
    index: 'barbarian-brutal-strike',
    name: 'Brutal Strike',
    class: 'barbarian',
    level: 9,
    onHit: (ask) => {
      const chosen = brutalStrikeOptions(ask.options.brutal_strike);
      if (chosen.length === 0 || ask.ability !== 'str') return [];
      // Improved Brutal Strike at 17 doubles the dice and lets two different effects ride on one swing.
      const dice = hasFeature(ask.sheet, 'barbarian-improved-brutal-strike-2') ? '2d10' : '1d10';
      const riders: HitRider[] = [
        {
          kind: 'damage',
          feature: 'Brutal Strike',
          dice,
          damage_type: ask.damage_type,
          note: `Brutal Strike: ${dice} extra${ask.damage_type ? ` ${ask.damage_type}` : ''} damage.`,
        },
      ];
      for (const option of chosen) {
        if (option === 'forceful') {
          riders.push({ kind: 'push', feature: 'Brutal Strike', ft: 15, note: 'Forceful Blow: driven 15 ft straight back.' });
          riders.push({
            kind: 'move',
            feature: 'Brutal Strike',
            ft: Math.floor(ask.actor.speed / 2),
            note: 'Forceful Blow: you may follow it up to half your Speed without provoking Opportunity Attacks.',
          });
        }
        if (option === 'hamstring') {
          riders.push({
            kind: 'stance',
            feature: 'Brutal Strike',
            on: 'target',
            flags: { slowed_by: { attacker_id: ask.actor.id, ft: 15 } },
            note: 'Hamstring Blow: 15 ft off its Speed until the start of your next turn.',
          });
        }
        if (option === 'staggering') {
          riders.push({
            kind: 'stance',
            feature: 'Improved Brutal Strike',
            on: 'target',
            flags: { staggered: true },
            note: 'Staggering Blow: Disadvantage on its next saving throw. It makes no Opportunity Attacks until the start of your next turn either, which is yours to hold it to.',
          });
        }
        if (option === 'sundering') {
          riders.push({
            kind: 'stance',
            feature: 'Improved Brutal Strike',
            on: 'target',
            flags: { sundering_blow: { by_id: ask.actor.id, rounds_left: 1 } },
            note: 'Sundering Blow: the next attack roll another creature makes against it gains +5.',
          });
        }
      }
      return riders;
    },
  },
  {
    index: 'barbarian-relentless-rage',
    name: 'Relentless Rage',
    class: 'barbarian',
    level: 11,
    // Applied where the damage lands: dropping to 0 in a Rage buys a DC 10 CON save to stay up.
    passive: (sheet) => ({
      note: `Relentless Rage: dropping to 0 hit points while raging buys a Constitution save - DC 10, and 5 more for each attempt since the last short or long rest, a failed save among them - to stand back up on ${sheet.level * 2} hit points instead.`,
    }),
  },
  {
    index: 'barbarian-improved-brutal-strike-1',
    name: 'Improved Brutal Strike',
    class: 'barbarian',
    level: 13,
    // Applied by Brutal Strike: Staggering and Sundering join the effects attack {brutal_strike} takes.
    passive: () => ({
      note: 'Improved Brutal Strike: attack {brutal_strike: "staggering"} leaves the target with Disadvantage on its next save, and "sundering" puts +5 on the next attack roll another creature makes against it.',
    }),
  },
  {
    index: 'berserker-intimidating-presence',
    name: 'Intimidating Presence',
    class: 'barbarian',
    level: 14,
    resource: { key: 'intimidating_presence', label: 'Intimidating Presence', per: 'long', max: () => 1 },
    action: (sheet) => ({
      id: 'intimidating_presence',
      kind: 'bonus_action',
      name: 'Intimidating Presence',
      hint: `Every creature of your choice within 30 ft makes a WIS save against DC ${featureDc(
        sheet,
        'str',
      )} or is Frightened for 1 minute, repeating the save at the end of each of its turns. Once per long rest, or a use of Rage to buy it back.`,
      cost: { resource: 'intimidating_presence', amount: 1 },
      targets: 'self',
      fallback: { label: 'a use of Rage', affordable: leftOf(sheet, 'rage') > 0 },
    }),
    resolve: (ask) => {
      const frightened = enemiesWithin(ask, 30);
      if (frightened.length === 0) {
        throw new Error(`There is nobody within 30 ft of ${ask.actor.name} to terrify.`);
      }
      // "unless you expend a use of your Rage to restore your use of it": the Rage pays once the use is gone.
      const spent = leftOf(ask.sheet, 'intimidating_presence') <= 0;
      return {
        economy: 'bonus_action',
        spend: spent ? { resource: 'rage', amount: 1 } : { resource: 'intimidating_presence', amount: 1 },
        save: {
          ability: 'wis',
          dc: featureDc(ask.sheet, 'str'),
          target_ids: frightened.map((c) => c.id),
          conditions: ['frightened'],
          ends: 'minute',
          repeat_save: true,
        },
        text: `${ask.actor.name} turns their primal fury on ${frightened.map((c) => c.name).join(', ')}${
          spent ? ', paid for with a use of Rage' : ''
        }.`,
      };
    },
  },
  {
    index: 'barbarian-persistent-rage',
    name: 'Persistent Rage',
    class: 'barbarian',
    level: 15,
    resource: { key: 'persistent_rage', label: 'Persistent Rage', per: 'long', max: () => 1 },
    // The Rage that no longer needs extending is applied at the turn edge, where a Rage ends.
    // "you can regain all expended uses": never taken for the player, only offered when Initiative is rolled.
    action: (sheet) =>
      spentOf(sheet, 'rage') > 0
        ? {
            id: 'persistent_rage_regain',
            kind: 'free',
            name: 'Persistent Rage (regain your Rages)',
            hint: `Take back all ${spentOf(
              sheet,
              'rage',
            )} expended uses of Rage. It is offered when you roll Initiative and is gone once your first turn of the fight ends.`,
            cost: { resource: 'persistent_rage', amount: 1 },
            targets: 'self',
          }
        : null,
    resolve: (ask) => {
      if (!ask.actor.flags.persistent_rage_offered) {
        throw new Error(
          `Persistent Rage is offered when ${ask.actor.name} rolls Initiative and is gone once their first turn of the fight ends. Roll Initiative on a fresh encounter to take it.`,
        );
      }
      const spent = spentOf(ask.sheet, 'rage');
      if (spent <= 0) throw new Error(`${ask.actor.name} has spent no Rage to take back.`);
      return {
        economy: 'free',
        spend: { resource: 'persistent_rage', amount: 1 },
        restore_resource: { key: 'rage', amount: spent },
        text: `${ask.actor.name} takes Persistent Rage: every expended use of Rage comes back.`,
      };
    },
    passive: () => ({
      note: 'Persistent Rage: your Rage runs its full ten minutes without being extended and ends only if you fall Unconscious, and once per long rest you may take back every expended Rage - offered when you roll Initiative, with use_action {action_name: "persistent_rage_regain"}, until your first turn of the fight ends.',
    }),
  },
  {
    index: 'barbarian-improved-brutal-strike-2',
    name: 'Improved Brutal Strike',
    class: 'barbarian',
    level: 17,
    // Applied by Brutal Strike: 2d10, and two effects on one swing.
    passive: () => ({ note: 'Improved Brutal Strike: Brutal Strike deals 2d10 and carries two different effects at once.' }),
  },
  {
    index: 'barbarian-indomitable-might',
    name: 'Indomitable Might',
    class: 'barbarian',
    level: 18,
    // Applied where the d20 is read: a Strength total below the Strength score is raised to it.
    passive: (sheet) => ({
      note: `Indomitable Might: a Strength check or Strength save that totals less than ${
        sheet.abilities.str?.score ?? 10
      } counts as ${sheet.abilities.str?.score ?? 10} instead.`,
    }),
  },
  epicBoon('barbarian'),
  {
    index: 'barbarian-primal-champion',
    name: 'Primal Champion',
    class: 'barbarian',
    level: 20,
    passive: (sheet) => ({
      note: `Primal Champion: Strength ${sheet.abilities.str?.score ?? 10} and Constitution ${
        sheet.abilities.con?.score ?? 10
      }, each raised 4 by the feature itself when level 20 arrived.`,
    }),
  },
  {
    index: 'berserker-retaliation',
    name: 'Retaliation',
    class: 'barbarian',
    level: 10,
    onDamageTaken: (ask) =>
      ask.distance_ft <= FIVE_FT
        ? {
            action: 'retaliation',
            name: 'Retaliation',
            hint: `${ask.actor.name} may spend its reaction on one melee attack against ${ask.attacker.name}: attack {out_of_turn: true, reason: "Retaliation"}.`,
          }
        : null,
  },
];

// --- Fighter ------------------------------------------------------------------

const FIGHTER: FeatureHandler[] = [
  {
    index: 'fighter-fighting-style',
    name: 'Fighting Style',
    class: 'fighter',
    level: 1,
    passive: (sheet) => fightingStylePassive(sheet),
  },
  {
    index: 'fighter-second-wind',
    name: 'Second Wind',
    class: 'fighter',
    level: 1,
    action: (sheet) => ({
      id: 'second_wind',
      kind: 'bonus_action',
      name: 'Second Wind',
      hint: `Regain 1d10 + ${sheet.level} hit points.${
        hasFeature(sheet, 'fighter-tactical-shift')
          ? ' Tactical Shift comes with it: half your Speed without provoking Opportunity Attacks.'
          : ''
      }`,
      cost: { resource: 'second_wind', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'bonus_action',
      spend: { resource: 'second_wind', amount: 1 },
      heal_expr: `1d10+${ask.sheet.level}`,
      text: `${ask.actor.name} catches their second wind.`,
      ...(hasFeature(ask.sheet, 'fighter-tactical-shift')
        ? {
            movement_ft: Math.floor(ask.actor.speed / 2),
            notes: ['Tactical Shift: half your Speed without provoking Opportunity Attacks.'],
          }
        : {}),
    }),
  },
  {
    index: 'fighter-action-surge',
    name: 'Action Surge',
    class: 'fighter',
    level: 2,
    action: () => ({
      id: 'action_surge',
      kind: 'free',
      name: 'Action Surge',
      hint: 'One more action this turn, the Magic action excepted.',
      cost: { resource: 'action_surge', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => {
      // From level 17 the Fighter has two uses, but the SRD allows only one of them on a turn; the
      // flag is cleared at the turn boundary, so the second use waits for the next turn.
      if (ask.actor.flags.action_surged) {
        throw new Error(
          `${ask.actor.name} has already used Action Surge this turn, and it may be used only once on a turn. The second use has to wait for the next turn.`,
        );
      }
      return {
        economy: 'free',
        spend: { resource: 'action_surge', amount: 1 },
        flags: { action_surged: true },
        text: `${ask.actor.name} surges: one more action this turn, though not the Magic action.`,
      };
    },
  },
  {
    index: 'fighter-tactical-mind',
    name: 'Tactical Mind',
    class: 'fighter',
    level: 2,
    dm_applied:
      'It adds 1d10 to an ability check that has already failed; the engine has no reroll seam on a resolved check, and those checks mostly happen outside combat.',
  },
  {
    index: 'champion-improved-critical',
    name: 'Improved Critical',
    class: 'fighter',
    level: 3,
    critRange: () => 19,
  },
  {
    index: 'champion-remarkable-athlete',
    name: 'Remarkable Athlete',
    class: 'fighter',
    level: 3,
    // The dm_applied line covers only the move; liveFeatures keeps the Advantage below running beside it.
    dm_applied:
      'The half-Speed move after a Critical Hit is yours to apply: the engine resolves the hit and the damage but never moves a creature itself, so apply the move by hand, and it provokes no Opportunity Attacks.',
    beforeCheck: (ask) =>
      ask.initiative === true || ask.skill === 'athletics' ? [{ advantage: 'advantage', note: 'Remarkable Athlete' }] : [],
  },
  {
    index: 'fighter-tactical-shift',
    name: 'Tactical Shift',
    class: 'fighter',
    level: 5,
    // Applied by Second Wind: the movement comes with the bonus action that spends it.
  },
  {
    index: 'champion-additional-fighting-style',
    name: 'Additional Fighting Style',
    class: 'fighter',
    level: 7,
    passive: (sheet) => fightingStylePassive(sheet),
  },
  {
    index: 'fighter-indomitable',
    name: 'Indomitable',
    class: 'fighter',
    level: 9,
    resource: {
      key: 'indomitable',
      label: 'Indomitable',
      per: 'long',
      max: (sheet) => (sheet.level >= 17 ? 3 : sheet.level >= 13 ? 2 : 1),
    },
    action: (sheet) => ({
      id: 'indomitable',
      kind: 'free',
      name: 'Indomitable',
      hint: `Declare it and the next saving throw you fail is rolled again with +${sheet.level}; you must use the new roll. The use is spent only when it fires.`,
      cost: { resource: 'indomitable', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'free',
      d20_stance: {
        feature: 'Indomitable',
        mode: 'reroll',
        on: ['save'],
        bonus: ask.sheet.level,
        spend: { resource: 'indomitable', amount: 1 },
      },
      text: `${ask.actor.name} sets their jaw: the next saving throw they fail is rerolled with +${ask.sheet.level} (Indomitable).`,
    }),
  },
  {
    index: 'fighter-tactical-master',
    name: 'Tactical Master',
    class: 'fighter',
    level: 9,
    // Applied in the attack: mastery_property swaps the weapon's own property for Push, Sap or Slow.
  },
  {
    index: 'champion-heroic-warrior',
    name: 'Heroic Warrior',
    class: 'fighter',
    level: 10,
    turnStart: (ask) => ({
      economy: 'free',
      grant_inspiration: true,
      text: `${ask.actor.name} is carried by the thrill of battle: Heroic Warrior gives them Heroic Inspiration.`,
    }),
  },
  {
    index: 'fighter-two-extra-attacks',
    name: 'Two Extra Attacks',
    class: 'fighter',
    level: 11,
    // Applied on the sheet: the level table's extra_attacks is what the Attack action counts.
    passive: () => ({ note: 'Two Extra Attacks: the Attack action swings three times.' }),
  },
  {
    index: 'fighter-studied-attacks',
    name: 'Studied Attacks',
    class: 'fighter',
    level: 13,
    onMiss: (ask) => [
      {
        kind: 'stance',
        feature: 'Studied Attacks',
        on: 'self',
        flags: { studied_target: { target_id: ask.target.id, rounds_left: 2 } },
        note: `Studied Attacks: ${ask.actor.name} learns from the miss and has Advantage on their next attack roll against ${ask.target.name}.`,
      },
    ],
    // The Advantage is spent on the attack roll it moved; the engine clears the flag there.
    beforeAttack: (ask) =>
      ask.actor.flags.studied_target?.target_id === ask.target.id
        ? [{ advantage: 'advantage', note: 'Studied Attacks: you missed this creature last' }]
        : [],
  },
  {
    index: 'champion-superior-critical',
    name: 'Superior Critical',
    class: 'fighter',
    level: 15,
    critRange: () => 18,
  },
  {
    index: 'champion-survivor',
    name: 'Survivor',
    class: 'fighter',
    level: 18,
    turnStart: (ask) => {
      const bloodied = ask.actor.hp_current > 0 && ask.actor.hp_current * 2 <= ask.actor.hp_max;
      if (!bloodied) return null;
      const back = Math.max(1, 5 + mod(ask.sheet, 'con'));
      return {
        economy: 'free',
        heal_amount: back,
        text: `${ask.actor.name} rallies: ${back} hit points back while Bloodied (Survivor).`,
      };
    },
    passive: (sheet) => ({
      note: `Survivor: Advantage on Death Saving Throws, an 18 or better on one counting as a 20, and 5 + ${mod(
        sheet,
        'con',
      )} hit points at the start of each of your turns while you are Bloodied and still standing.`,
    }),
  },
  epicBoon('fighter'),
  {
    index: 'fighter-three-extra-attacks',
    name: 'Three Extra Attacks',
    class: 'fighter',
    level: 20,
    // Applied on the sheet: the level table's extra_attacks is what the Attack action counts.
    passive: () => ({ note: 'Three Extra Attacks: the Attack action swings four times.' }),
  },
];

// --- Rogue --------------------------------------------------------------------

const ROGUE: FeatureHandler[] = [
  {
    index: 'rogue-expertise',
    name: 'Expertise',
    class: 'rogue',
    level: 1,
    passive: () => ({ note: 'Expertise: the chosen skills already carry double the proficiency bonus on the sheet.' }),
  },
  {
    index: 'rogue-sneak-attack',
    name: 'Sneak Attack',
    class: 'rogue',
    level: 1,
    onHit: (ask) => sneakAttackRiders(ask),
  },
  {
    index: 'rogue-thieves-cant',
    name: "Thieves' Cant",
    class: 'rogue',
    level: 1,
    dm_applied: 'A secret language: narrated, never rolled.',
  },
  {
    index: 'rogue-cunning-action',
    name: 'Cunning Action',
    class: 'rogue',
    level: 2,
    action: () => ({
      id: 'cunning_action',
      kind: 'bonus_action',
      name: 'Cunning Action',
      hint: 'Dash, Disengage or Hide as a Bonus Action: use_action {action_name: "cunning_action_dash" | "cunning_action_disengage" | "cunning_action_hide"}.',
      targets: 'self',
    }),
    resolve: (ask) => {
      const option = (ask.option ?? 'dash').toLowerCase();
      return {
        economy: 'bonus_action',
        standard: [option],
        text: `${ask.actor.name} takes the ${option[0]!.toUpperCase()}${option.slice(1)} action as a Bonus Action (Cunning Action).`,
      };
    },
  },
  {
    index: 'rogue-steady-aim',
    name: 'Steady Aim',
    class: 'rogue',
    level: 3,
    action: () => ({
      id: 'steady_aim',
      kind: 'bonus_action',
      name: 'Steady Aim',
      hint: 'Advantage on your next attack roll this turn; your Speed drops to 0 for the rest of it, and you must not have moved yet.',
      targets: 'self',
    }),
    resolve: (ask) => {
      if (ask.actor.flags.moved_this_turn) {
        throw new Error(
          `${ask.actor.name} has already moved this turn, and Steady Aim needs a Rogue who has not. Take it before moving.`,
        );
      }
      return {
        economy: 'bonus_action',
        flags: { steady_aim: true },
        text: `${ask.actor.name} steadies their aim: Advantage on their next attack roll this turn, and Speed 0 until the turn ends.`,
      };
    },
    beforeAttack: (ask) => (ask.actor.flags.steady_aim ? [{ advantage: 'advantage', note: 'Steady Aim' }] : []),
  },
  {
    index: 'thief-fast-hands',
    name: 'Fast Hands',
    class: 'rogue',
    level: 3,
    action: () => ({
      id: 'fast_hands',
      kind: 'bonus_action',
      name: 'Fast Hands',
      hint: 'Take the Utilize action as a Bonus Action; its Sleight of Hand half is an out-of-combat check.',
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'bonus_action',
      standard: ['utilize'],
      text: `${ask.actor.name} works an object as a Bonus Action (Fast Hands).`,
    }),
  },
  {
    index: 'thief-second-story-work',
    name: 'Second-Story Work',
    class: 'rogue',
    level: 3,
    dm_applied: 'A Climb Speed and jumping off Dexterity need the movement modes R9 brings.',
  },
  {
    index: 'rogue-cunning-strike',
    name: 'Cunning Strike',
    class: 'rogue',
    level: 5,
    // Applied by Sneak Attack: the dice are taken off its damage before they are rolled.
  },
  {
    index: 'rogue-uncanny-dodge',
    name: 'Uncanny Dodge',
    class: 'rogue',
    level: 5,
    action: () => ({
      id: 'uncanny_dodge',
      kind: 'reaction',
      name: 'Uncanny Dodge',
      hint: 'Halve the damage of an attack you can see coming. Declare it with use_action {action_name: "uncanny_dodge"} and the next hit this round costs half; the reaction is spent there.',
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'reaction',
      flags: { uncanny_dodge_ready: true },
      text: `${ask.actor.name} braces: the next attack they see coming deals half damage (Uncanny Dodge).`,
    }),
    onDamageTaken: (ask) =>
      ask.actor.flags.uncanny_dodge_ready || ask.actor.reaction_used
        ? null
        : {
            action: 'uncanny_dodge',
            name: 'Uncanny Dodge',
            hint: `${ask.actor.name} may halve the damage of the next attack it sees: use_action {action_name: "uncanny_dodge"} before that attack, which spends its reaction.`,
          },
  },
  {
    index: 'rogue-evasion',
    name: 'Evasion',
    class: 'rogue',
    level: 7,
    // Applied where half-on-a-save damage is worked out.
  },
  {
    index: 'rogue-reliable-talent',
    name: 'Reliable Talent',
    class: 'rogue',
    level: 7,
    // Applied to the checks the engine rolls itself; a check rolled elsewhere is the DM's to floor.
  },
  {
    index: 'thief-supreme-sneak',
    name: 'Supreme Sneak',
    class: 'rogue',
    level: 9,
    dm_applied: 'Staying unseen behind cover after a strike needs the vision and cover rules R7 brings.',
  },
  {
    index: 'rogue-improved-cunning-strike',
    name: 'Improved Cunning Strike',
    class: 'rogue',
    level: 11,
    // Applied by Sneak Attack: two Cunning Strike effects may ride on the same hit.
    passive: () => ({ note: 'Improved Cunning Strike: two Cunning Strike effects on one Sneak Attack, each at its own die cost.' }),
  },
  {
    index: 'thief-use-magic-device',
    name: 'Use Magic Device',
    class: 'rogue',
    level: 13,
    passive: () => ({
      note: 'Use Magic Device: four attunement slots, which the sheet already counts. The 1d6 that saves an item\'s charges and the Spell Scrolls you can read off any level are yours: the engine has no charge roll or scroll casting of its own.',
    }),
  },
  {
    index: 'rogue-devious-strikes',
    name: 'Devious Strikes',
    class: 'rogue',
    level: 14,
    // Applied by Sneak Attack: Daze, Knock Out and Obscure join the Cunning Strike options.
    passive: (sheet) => ({
      note: `Devious Strikes: attack {cunning_strike: ["daze"]} costs 2d6 and is left to you - ${
        CUNNING_STRIKE_DM_APPLIED.daze
      } ["obscure"] costs 3d6 for a DEX save or Blinded until the end of its next turn, ["knock_out"] 6d6 for a CON save or Unconscious for a minute. DC ${featureDc(
        sheet,
        'dex',
      )}.`,
    }),
  },
  {
    index: 'rogue-slippery-mind',
    name: 'Slippery Mind',
    class: 'rogue',
    level: 15,
    // Applied on the sheet: the Wisdom and Charisma saving throw proficiencies are already on it.
    passive: () => ({ note: 'Slippery Mind: proficiency in Wisdom and Charisma saving throws, already on the sheet.' }),
  },
  {
    index: 'thief-thiefs-reflexes',
    name: "Thief's Reflexes",
    class: 'rogue',
    level: 17,
    dm_applied:
      'Two turns in the first round means one creature standing twice in the initiative order, and the turn order holds one slot per combatant. Take the second turn with out_of_turn calls at initiative minus 10.',
  },
  {
    index: 'rogue-elusive',
    name: 'Elusive',
    class: 'rogue',
    level: 18,
    // Applied where the attack roll is put together: no Advantage against you unless you are Incapacitated.
    passive: () => ({ note: 'Elusive: no attack roll against you has Advantage while you are not Incapacitated.' }),
  },
  epicBoon('rogue'),
  {
    index: 'rogue-stroke-of-luck',
    name: 'Stroke of Luck',
    class: 'rogue',
    level: 20,
    resource: { key: 'stroke_of_luck', label: 'Stroke of Luck', per: 'short', max: () => 1 },
    action: () => ({
      id: 'stroke_of_luck',
      kind: 'free',
      name: 'Stroke of Luck',
      hint: 'Declare it and the next D20 Test of yours that fails - an attack roll, an ability check or a saving throw - turns into a 20. Once per short rest, and the use is spent only when it fires.',
      cost: { resource: 'stroke_of_luck', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'free',
      d20_stance: {
        feature: 'Stroke of Luck',
        mode: 'set_20',
        on: ['attack', 'check', 'save'],
        spend: { resource: 'stroke_of_luck', amount: 1 },
      },
      text: `${ask.actor.name} waits on their luck: the next D20 Test they fail becomes a 20 (Stroke of Luck).`,
    }),
  },
];

// --- Monk ---------------------------------------------------------------------

const MONK: FeatureHandler[] = [
  {
    index: 'monk-martial-arts',
    name: 'Martial Arts',
    class: 'monk',
    level: 1,
    passive: (sheet) =>
      monkStance(sheet)
        ? {
            note: `Martial Arts: Unarmed Strikes and Monk weapons roll 1d${resourceMax(sheet, 'martial_arts_die')} and may use Dexterity, and one Unarmed Strike is a Bonus Action.`,
          }
        : { note: 'Martial Arts is off: it needs no armour, no Shield and only Monk weapons in hand.' },
  },
  {
    index: 'monk-unarmored-defense',
    name: 'Unarmored Defense',
    class: 'monk',
    level: 1,
    passive: (sheet) =>
      wearingArmor(sheet) || holdingShield(sheet)
        ? null
        : { note: `Unarmored Defense: 10 + DEX + WIS (+${mod(sheet, 'wis')} from WIS) with no armour and no Shield.` },
  },
  {
    index: 'monk-monks-focus',
    name: "Monk's Focus",
    class: 'monk',
    level: 2,
    action: (sheet) => [
      {
        id: 'flurry_of_blows',
        kind: 'bonus_action',
        name: 'Flurry of Blows',
        hint: `1 Focus Point for ${
          hasFeature(sheet, 'monk-heightened-focus') ? 'three' : 'two'
        } Unarmed Strikes as a Bonus Action; make each with attack {flurry: true}.`,
        cost: { resource: 'focus_points', amount: 1 },
        targets: 'self',
      },
      {
        id: 'patient_defense',
        kind: 'bonus_action',
        name: 'Patient Defense',
        hint: 'Disengage as a Bonus Action for nothing, or option "focus" (1 Focus Point) for Disengage and Dodge both.',
        targets: 'self',
      },
      {
        id: 'step_of_the_wind',
        kind: 'bonus_action',
        name: 'Step of the Wind',
        hint: 'Dash as a Bonus Action for nothing, or option "focus" (1 Focus Point) for Disengage and Dash both, with your jump distance doubled for the turn.',
        targets: 'self',
      },
    ],
    resolve: (ask) => {
      const paid = (ask.option ?? '').toLowerCase() === 'focus';
      const focus = paid ? { spend: { resource: 'focus_points', amount: 1 } } : {};
      if (ask.action_id === 'patient_defense') {
        return {
          economy: 'bonus_action',
          ...focus,
          standard: paid ? ['disengage', 'dodge'] : ['disengage'],
          // Heightened Focus pays only when a Focus Point is spent, never on the free half.
          ...(paid && hasFeature(ask.sheet, 'monk-heightened-focus')
            ? { temp_hp_expr: `2d${resourceMax(ask.sheet, 'martial_arts_die')}` }
            : {}),
          text: paid
            ? `${ask.actor.name} settles into Patient Defense: the Disengage and Dodge actions both, for 1 Focus Point.`
            : `${ask.actor.name} takes Patient Defense: the Disengage action as a Bonus Action.`,
        };
      }
      if (ask.action_id === 'step_of_the_wind') {
        return {
          economy: 'bonus_action',
          ...focus,
          standard: paid ? ['disengage', 'dash'] : ['dash'],
          text: paid
            ? `${ask.actor.name} steps with the wind: the Disengage and Dash actions both, for 1 Focus Point.`
            : `${ask.actor.name} steps with the wind: the Dash action as a Bonus Action.`,
          ...(paid ? { notes: ['Step of the Wind: your jump distance is doubled for the turn.'] } : {}),
        };
      }
      const strikes = hasFeature(ask.sheet, 'monk-heightened-focus') ? 3 : 2;
      return {
        economy: 'bonus_action',
        spend: { resource: 'focus_points', amount: 1 },
        flags: { flurry_strikes: strikes },
        text: `${ask.actor.name} unleashes a Flurry of Blows: ${strikes} Unarmed Strikes, each made with attack {flurry: true} and free of the Attack action.`,
      };
    },
  },
  {
    index: 'monk-unarmored-movement',
    name: 'Unarmored Movement',
    class: 'monk',
    level: 2,
    passive: (sheet) => {
      const bonus = resourceMax(sheet, 'unarmored_movement');
      if (bonus <= 0 || wearingArmor(sheet) || holdingShield(sheet)) return null;
      return { note: `Unarmored Movement: +${bonus} ft with no armour and no Shield.` };
    },
  },
  {
    index: 'monk-uncanny-metabolism',
    name: 'Uncanny Metabolism',
    class: 'monk',
    level: 2,
    resource: { key: 'uncanny_metabolism', label: 'Uncanny Metabolism', per: 'long', max: () => 1 },
    action: (sheet) => ({
      id: 'uncanny_metabolism',
      kind: 'free',
      name: 'Uncanny Metabolism',
      hint: `On the round initiative was rolled: every Focus Point back, and 1d${resourceMax(sheet, 'martial_arts_die')} + ${sheet.level} hit points. Once per long rest.`,
      cost: { resource: 'uncanny_metabolism', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => {
      if (ask.round !== 1) {
        throw new Error(
          `Uncanny Metabolism fires when you roll Initiative, so it is taken in round 1; this is round ${ask.round}.`,
        );
      }
      return {
      economy: 'free',
      spend: { resource: 'uncanny_metabolism', amount: 1 },
      restore_focus: true,
      heal_expr: `1d${resourceMax(ask.sheet, 'martial_arts_die')}+${ask.sheet.level}`,
      text: `${ask.actor.name} draws on their uncanny metabolism: every Focus Point back, and wounds close.`,
      };
    },
  },
  {
    index: 'monk-deflect-attacks',
    name: 'Deflect Attacks',
    class: 'monk',
    level: 3,
    action: (sheet) => ({
      id: 'deflect_attacks',
      kind: 'reaction',
      name: 'Deflect Attacks',
      hint: `Take 1d10 + ${mod(sheet, 'dex')} + ${sheet.level} off a bludgeoning, piercing or slashing hit. Declare it with use_action {action_name: "deflect_attacks"} and the next such hit is softened; the reaction is spent there. A hit taken to 0 offers deflect_redirect: 1 Focus Point to throw the force back.`,
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'reaction',
      flags: { deflect_ready: true },
      text: `${ask.actor.name} sets themselves to deflect: the next bludgeoning, piercing or slashing hit is cut by 1d10 + ${mod(ask.sheet, 'dex')} + ${ask.sheet.level} (Deflect Attacks).`,
    }),
    onDamageTaken: (ask) => {
      if (ask.actor.flags.deflect_ready || ask.actor.reaction_used) return null;
      const physical = ['bludgeoning', 'piercing', 'slashing'];
      // Deflect Energy, at level 13, takes the damage type out of it altogether.
      if (ask.damage_type && !physical.includes(ask.damage_type.toLowerCase()) && !hasFeature(ask.sheet, 'monk-deflect-energy')) {
        return null;
      }
      return {
        action: 'deflect_attacks',
        name: 'Deflect Attacks',
        hint: `${ask.actor.name} may spend its reaction to take 1d10 + ${mod(ask.sheet, 'dex')} + ${ask.sheet.level} off the next such hit: use_action {action_name: "deflect_attacks"} before that attack.`,
      };
    },
  },
  {
    index: 'open-hand-technique',
    name: 'Open Hand Technique',
    class: 'monk',
    level: 3,
    onHit: (ask) => {
      if (!ask.options.flurry) return [];
      const dc = featureDc(ask.sheet, 'wis');
      return [
        {
          kind: 'note',
          feature: 'Open Hand Technique',
          note: `Open Hand Technique: this Flurry hit may Addle (no Opportunity Attacks until the start of its next turn), Push (STR save DC ${dc} or 15 ft back) or Topple (DEX save DC ${dc} or Prone). Apply the one the player picks with use_action.`,
        },
      ];
    },
  },
  {
    index: 'monk-slow-fall',
    name: 'Slow Fall',
    class: 'monk',
    level: 4,
    dm_applied: 'Falling damage arrives with R9; there is nothing yet for the reaction to reduce.',
  },
  {
    index: 'monk-stunning-strike',
    name: 'Stunning Strike',
    class: 'monk',
    level: 5,
    onHit: (ask) => {
      if (!ask.options.stunning_strike) return [];
      if (ask.actor.flags.stunning_strike_used) return [];
      if (!isUnarmedStrike(ask.action) && !isMonkWeapon(ask.weapon)) return [];
      return [
        {
          kind: 'save',
          feature: 'Stunning Strike',
          spend: { resource: 'focus_points', amount: 1 },
          ability: 'con',
          dc: featureDc(ask.sheet, 'wis'),
          condition: 'stunned',
          ends: 'start_of_your_next_turn',
          on_success:
            'its Speed is halved until the start of your next turn, and the next attack roll against it before then has Advantage',
          note: 'Stunning Strike: 1 Focus Point for a CON save against the Stunned condition.',
        },
        {
          kind: 'stance',
          feature: 'Stunning Strike',
          on: 'self',
          flags: { stunning_strike_used: true },
          note: 'Stunning Strike is spent for this turn.',
        },
      ];
    },
  },
  {
    index: 'monk-empowered-strikes',
    name: 'Empowered Strikes',
    class: 'monk',
    level: 6,
    // Applied in the attack: empowered_strike turns an Unarmed Strike's damage to Force.
  },
  {
    index: 'open-hand-wholeness-of-body',
    name: 'Wholeness of Body',
    class: 'monk',
    level: 6,
    resource: {
      key: 'wholeness_of_body',
      label: 'Wholeness of Body',
      per: 'long',
      max: (sheet) => Math.max(1, mod(sheet, 'wis')),
    },
    action: (sheet) => ({
      id: 'wholeness_of_body',
      kind: 'bonus_action',
      name: 'Wholeness of Body',
      hint: `Regain 1d${resourceMax(sheet, 'martial_arts_die')} + ${mod(sheet, 'wis')} hit points, at least 1.`,
      cost: { resource: 'wholeness_of_body', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'bonus_action',
      spend: { resource: 'wholeness_of_body', amount: 1 },
      heal_expr: `1d${resourceMax(ask.sheet, 'martial_arts_die')}${mod(ask.sheet, 'wis') >= 0 ? '+' : ''}${mod(ask.sheet, 'wis')}`,
      text: `${ask.actor.name} knits themselves back together (Wholeness of Body).`,
    }),
  },
  {
    index: 'monk-evasion',
    name: 'Evasion',
    class: 'monk',
    level: 7,
    // Applied where half-on-a-save damage is worked out.
  },
  {
    index: 'monk-acrobatic-movement',
    name: 'Acrobatic Movement',
    class: 'monk',
    level: 9,
    dm_applied: 'Running up walls and across water needs the movement modes R9 brings.',
  },
  {
    index: 'monk-heightened-focus',
    name: 'Heightened Focus',
    class: 'monk',
    level: 10,
    // Applied by Monk's Focus: Flurry of Blows throws a third strike.
  },
  {
    index: 'monk-self-restoration',
    name: 'Self-Restoration',
    class: 'monk',
    level: 10,
    turnEnd: (ask) => {
      const shed = ['charmed', 'frightened', 'poisoned'].find((c) => ask.actor.conditions.includes(c));
      if (!shed) return null;
      return {
        economy: 'free',
        remove_conditions: [shed],
        text: `${ask.actor.name} shrugs off ${shed} through sheer force of will (Self-Restoration).`,
      };
    },
  },
  {
    index: 'open-hand-fleet-step',
    name: 'Fleet Step',
    class: 'monk',
    level: 11,
    action: () => ({
      id: 'fleet_step',
      kind: 'free',
      name: 'Fleet Step',
      hint: 'Right after any Bonus Action other than Step of the Wind, take Step of the Wind as well: the Dash action, free of your Bonus Action, or option "focus" (1 Focus Point) for Disengage and Dash both, with your jump distance doubled for the turn.',
      targets: 'self',
    }),
    resolve: (ask) => {
      if (!ask.actor.bonus_used) {
        throw new Error(
          `Fleet Step follows a Bonus Action, and ${ask.actor.name} has not taken one this turn. Spend the Bonus Action first.`,
        );
      }
      // Fleet Step takes Step of the Wind, and Step of the Wind has both halves.
      const paid = (ask.option ?? '').toLowerCase() === 'focus';
      return {
        economy: 'free',
        ...(paid ? { spend: { resource: 'focus_points', amount: 1 } } : {}),
        standard: paid ? ['disengage', 'dash'] : ['dash'],
        text: paid
          ? `${ask.actor.name} steps with the wind on the heels of their Bonus Action: the Disengage and Dash actions both, for 1 Focus Point (Fleet Step).`
          : `${ask.actor.name} steps with the wind on the heels of their Bonus Action: the Dash action for nothing (Fleet Step).`,
        ...(paid ? { notes: ['Step of the Wind: your jump distance is doubled for the turn.'] } : {}),
      };
    },
  },
  {
    index: 'monk-deflect-energy',
    name: 'Deflect Energy',
    class: 'monk',
    level: 13,
    // Applied by Deflect Attacks: the damage type no longer has to be bludgeoning, piercing or slashing.
    passive: () => ({ note: 'Deflect Energy: Deflect Attacks works against damage of any type.' }),
  },
  {
    index: 'monk-disciplined-survivor',
    name: 'Disciplined Survivor',
    class: 'monk',
    level: 14,
    action: () => ({
      id: 'disciplined_survivor',
      kind: 'free',
      name: 'Disciplined Survivor',
      hint: 'Declare it and the next saving throw you fail is rolled again for 1 Focus Point; you must use the new roll. The point is spent only when it fires.',
      cost: { resource: 'focus_points', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'free',
      d20_stance: {
        feature: 'Disciplined Survivor',
        mode: 'reroll',
        on: ['save'],
        spend: { resource: 'focus_points', amount: 1 },
      },
      text: `${ask.actor.name} steadies themselves: the next saving throw they fail is rerolled for 1 Focus Point (Disciplined Survivor).`,
    }),
    passive: () => ({ note: 'Disciplined Survivor: proficiency in every saving throw, already on the sheet.' }),
  },
  {
    index: 'monk-perfect-focus',
    name: 'Perfect Focus',
    class: 'monk',
    level: 15,
    onInitiative: (ask) => {
      const left = leftOf(ask.sheet, 'focus_points');
      if (left > 3) return null;
      const back = Math.min(spentOf(ask.sheet, 'focus_points'), 4 - left);
      if (back <= 0) return null;
      return {
        economy: 'free',
        restore_resource: { key: 'focus_points', amount: back },
        text: `${ask.actor.name} rolls Initiative with ${left} Focus Points and comes back up to 4 (Perfect Focus).`,
      };
    },
  },
  {
    index: 'open-hand-quivering-palm',
    name: 'Quivering Palm',
    class: 'monk',
    level: 17,
    onHit: (ask) => {
      if (!ask.options.quivering_palm) return [];
      return [
        {
          kind: 'stance',
          feature: 'Quivering Palm',
          on: 'target',
          spend: { resource: 'focus_points', amount: 4 },
          flags: { quivering_palm: { monk_id: ask.actor.id } },
          note: `Quivering Palm: lethal vibrations settle into ${ask.target.name} for ${ask.sheet.level} days. End them with use_action {action_name: "quivering_palm_end"}.`,
        },
        {
          kind: 'stance',
          feature: 'Quivering Palm',
          on: 'self',
          flags: { quivering_palm_used: true },
          note: 'Quivering Palm is set for this turn.',
        },
      ];
    },
    action: (sheet) => ({
      id: 'quivering_palm',
      kind: 'action',
      name: 'Quivering Palm (end the vibrations)',
      hint: `The creature carrying your vibrations makes a CON save against DC ${featureDc(
        sheet,
        'wis',
      )} and takes 10d12 Force damage, half as much on a success. Set them with attack {quivering_palm: true} on an Unarmed Strike, for 4 Focus Points.`,
      targets: 'creature',
    }),
    resolve: (ask) => {
      const carrying = ask.combatants.find((c) => c.flags.quivering_palm?.monk_id === ask.actor.id && c.alive);
      if (!carrying) {
        throw new Error(
          `Nobody in this fight carries ${ask.actor.name}'s Quivering Palm. Land an Unarmed Strike with attack {quivering_palm: true} first.`,
        );
      }
      if (ask.target && ask.target.id !== carrying.id) {
        throw new Error(`${carrying.name} is the one carrying your vibrations, not ${ask.target.name}.`);
      }
      if (!ask.target) {
        throw new Error(`Quivering Palm ends on the creature carrying it: pass target_id ${carrying.id} (${carrying.name}).`);
      }
      return {
        economy: 'action',
        save: {
          ability: 'con',
          dc: featureDc(ask.sheet, 'wis'),
          target_ids: [carrying.id],
          damage_expr: '10d12',
          damage_type: 'force',
          half_on_save: true,
        },
        target_flags: { quivering_palm: undefined },
        text: `${ask.actor.name} ends the vibrations in ${carrying.name} (Quivering Palm).`,
      };
    },
  },
  {
    index: 'monk-superior-defense',
    name: 'Superior Defense',
    class: 'monk',
    level: 18,
    action: () => ({
      id: 'superior_defense',
      kind: 'free',
      name: 'Superior Defense',
      hint: '3 Focus Points at the start of your turn: Resistance to every damage type but Force for 1 minute, or until you are Incapacitated.',
      cost: { resource: 'focus_points', amount: 3 },
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'free',
      spend: { resource: 'focus_points', amount: 3 },
      flags: { superior_defense: { rounds_left: MINUTE_ROUNDS } },
      text: `${ask.actor.name} bolsters themselves: Resistance to all damage except Force for 1 minute (Superior Defense).`,
    }),
  },
  epicBoon('monk'),
  {
    index: 'monk-body-and-mind',
    name: 'Body and Mind',
    class: 'monk',
    level: 20,
    passive: (sheet) => ({
      note: `Body and Mind: Dexterity ${sheet.abilities.dex?.score ?? 10} and Wisdom ${
        sheet.abilities.wis?.score ?? 10
      }, each raised 4 by the feature itself when level 20 arrived.`,
    }),
  },
];

// --- Paladin ------------------------------------------------------------------

/** Restoring Touch: the conditions 5 points of Lay On Hands lift, on top of the Poisoned it always could. */
export const RESTORING_TOUCH = ['blinded', 'charmed', 'deafened', 'frightened', 'paralyzed', 'stunned'];

const PALADIN: FeatureHandler[] = [
  {
    index: 'paladin-lay-on-hands',
    name: 'Lay On Hands',
    class: 'paladin',
    level: 1,
    resource: { key: 'lay_on_hands', label: 'Lay On Hands', per: 'long', max: (sheet) => sheet.level * 5 },
    action: (sheet) => ({
      id: 'lay_on_hands',
      kind: 'bonus_action',
      name: 'Lay On Hands',
      hint: `A pool of ${sheet.level * 5} hit points a long rest: pass amount to pour that many into a creature you touch, or option "poison" to spend 5 and end the Poisoned condition.`,
      targets: 'creature',
    }),
    resolve: (ask) => {
      const who = (ask.target ?? ask.actor).name;
      const option = (ask.option ?? '').toLowerCase();
      if (option === 'poison') {
        return {
          economy: 'bonus_action',
          spend: { resource: 'lay_on_hands', amount: 5 },
          remove_conditions: ['poisoned'],
          text: `${ask.actor.name} draws the poison out of ${who} (5 points of Lay On Hands).`,
        };
      }
      // Restoring Touch, at level 14: 5 points of the pool lift one of the conditions it names.
      if (RESTORING_TOUCH.includes(option)) {
        if (!hasFeature(ask.sheet, 'paladin-restoring-touch')) {
          throw new Error(
            `Lay On Hands lifts ${option} only with Restoring Touch, a Paladin feature taken at level 14. It may still end the Poisoned condition with option "poison".`,
          );
        }
        return {
          economy: 'bonus_action',
          spend: { resource: 'lay_on_hands', amount: 5 },
          remove_conditions: [option],
          text: `${ask.actor.name} lays hands on ${who} and the ${option} condition lifts (Restoring Touch, 5 points of the pool).`,
        };
      }
      const amount = Math.max(1, ask.amount ?? 1);
      return {
        economy: 'bonus_action',
        spend: { resource: 'lay_on_hands', amount },
        heal_amount: amount,
        text: `${ask.actor.name} lays on hands: ${amount} hit points to ${who}.`,
      };
    },
  },
  {
    index: 'paladin-fighting-style',
    name: 'Fighting Style',
    class: 'paladin',
    level: 2,
    passive: (sheet) => fightingStylePassive(sheet),
  },
  {
    index: 'paladin-paladins-smite',
    name: "Paladin's Smite",
    class: 'paladin',
    level: 2,
    resource: { key: 'paladins_smite', label: "Paladin's Smite", per: 'long', max: () => 1 },
    onHit: (ask) => {
      if (!ask.melee) return [];
      return [
        {
          kind: 'stance',
          feature: "Paladin's Smite",
          on: 'self',
          flags: { smite_ready: { target_id: ask.target.id, action: ask.action.name } },
          note: `Divine Smite is ready on ${ask.target.name}: use_action {spell: "Divine Smite", target_id: ${ask.target.id}, slot_level} this turn burns a slot for the radiant damage, or leave slot_level out for the one free casting a long rest.`,
        },
      ];
    },
  },
  {
    index: 'paladin-channel-divinity',
    name: 'Channel Divinity',
    class: 'paladin',
    level: 3,
    action: () => ({
      id: 'divine_sense',
      kind: 'bonus_action',
      name: 'Divine Sense',
      hint: 'Spend a Channel Divinity to know every Celestial, Fiend and Undead within 60 ft; the result lists the ones in the fight.',
      cost: { resource: 'channel_divinity', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => {
      const seen = ask.combatants.filter(
        (c) =>
          c.id !== ask.actor.id &&
          c.alive &&
          distanceBetween(c, ask.actor) <= 60 &&
          /celestial|fiend|undead/i.test(c.stat_block?.type ?? ''),
      );
      return {
        economy: 'bonus_action',
        spend: { resource: 'channel_divinity', amount: 1 },
        text: seen.length
          ? `${ask.actor.name} opens their awareness: ${seen.map((c) => `${c.name} (${c.stat_block?.type ?? 'unknown type'})`).join(', ')} within 60 ft.`
          : `${ask.actor.name} opens their awareness and senses no Celestial, Fiend or Undead within 60 ft.`,
        notes: ['Consecrated or desecrated ground inside the same radius is yours to narrate.'],
      };
    },
  },
  {
    index: 'devotion-oath-of-devotion-spells',
    name: 'Oath of Devotion Spells',
    class: 'paladin',
    level: 3,
    passive: () => ({ note: 'Oath of Devotion Spells: the oath spells are always prepared, and sit on the spell list already.' }),
  },
  {
    index: 'devotion-sacred-weapon',
    name: 'Sacred Weapon',
    class: 'paladin',
    level: 3,
    // Taken on an attack of the Attack action with attack {sacred_weapon: true}, which is where the SRD puts it.
    dm_applied:
      "Sacred Weapon's +CHA to attack rolls is applied, but two halves of it are yours: the choice to deal Radiant damage instead of the weapon's own type on a hit, and the bright light in a 20 ft radius. The blessing also ends if the Paladin stops carrying the weapon, which the engine does not notice.",
    passive: (sheet) => ({
      note: `Sacred Weapon: attack {sacred_weapon: true} on an attack of your Attack action spends a Channel Divinity and adds +${Math.max(
        1,
        mod(sheet, 'cha'),
      )} to attack rolls with that melee weapon for 10 minutes, with Radiant damage at will and bright light in a 20 ft radius.`,
    }),
    beforeAttack: (ask) => {
      const blessed = ask.actor.flags.sacred_weapon;
      if (!blessed || !ask.melee) return [];
      if (blessed.weapon !== 'the weapon in hand' && !ask.action.name.toLowerCase().includes(blessed.weapon.toLowerCase())) {
        return [];
      }
      return [{ advantage: 'none', note: `Sacred Weapon: +${blessed.bonus} to this attack roll` }];
    },
  },
  {
    index: 'paladin-faithful-steed',
    name: 'Faithful Steed',
    class: 'paladin',
    level: 5,
    dm_applied: 'Find Steed summons a creature, and summoning a combatant out of a spell waits for its own package.',
  },
  {
    index: 'paladin-aura-of-protection',
    name: 'Aura of Protection',
    class: 'paladin',
    level: 6,
    passive: (sheet) => ({
      note: `Aura of Protection: you and every ally within ${auraFt(sheet)} ft add +${Math.max(1, mod(sheet, 'cha'))} to their saving throws.`,
    }),
  },
  {
    index: 'devotion-aura-of-devotion',
    name: 'Aura of Devotion',
    class: 'paladin',
    level: 7,
    // "The aura is inactive while you have the Incapacitated condition", so the immunity it carries is too.
    passive: (sheet) =>
      INCAPACITATING.some((c) => sheet.conditions.includes(c))
        ? null
        : {
            condition_immunities: ['charmed'],
            note: 'Aura of Devotion: immune to Charmed inside your Aura of Protection.',
          },
  },
  {
    index: 'paladin-abjure-foes',
    name: 'Abjure Foes',
    class: 'paladin',
    level: 9,
    action: (sheet) => ({
      id: 'abjure_foes',
      kind: 'action',
      name: 'Abjure Foes',
      hint: `Spend a Channel Divinity: up to ${Math.max(1, mod(sheet, 'cha'))} creatures within 60 ft make a WIS save against DC ${
        sheet.spells.save_dc ?? featureDc(sheet, 'cha')
      } or are Frightened for 1 minute.`,
      cost: { resource: 'channel_divinity', amount: 1 },
      targets: 'creature',
    }),
    resolve: (ask) => ({
      economy: 'action',
      spend: { resource: 'channel_divinity', amount: 1 },
      text: `${ask.actor.name} presents their holy symbol and overwhelms their foes with awe (Abjure Foes).`,
      notes: [
        `Roll the WIS save against DC ${ask.sheet.spells.save_dc ?? featureDc(ask.sheet, 'cha')} for each of up to ${Math.max(
          1,
          mod(ask.sheet, 'cha'),
        )} creatures within 60 ft with use_action {save_ability: "wis", save_dc, effect: {name: "frightened", kind: "condition"}}.`,
      ],
    }),
  },
  {
    index: 'paladin-aura-of-courage',
    name: 'Aura of Courage',
    class: 'paladin',
    level: 10,
    // "The aura is inactive while you have the Incapacitated condition", so the immunity it carries is too.
    passive: (sheet) =>
      INCAPACITATING.some((c) => sheet.conditions.includes(c))
        ? null
        : {
            condition_immunities: ['frightened'],
            note: 'Aura of Courage: immune to Frightened inside your Aura of Protection.',
          },
  },
  {
    index: 'paladin-radiant-strikes',
    name: 'Radiant Strikes',
    class: 'paladin',
    level: 11,
    onHit: (ask) => {
      if (!ask.melee) return [];
      return [
        {
          kind: 'damage',
          feature: 'Radiant Strikes',
          dice: '1d8',
          damage_type: 'radiant',
          note: 'Radiant Strikes: 1d8 extra Radiant damage.',
        },
      ];
    },
  },
  {
    index: 'paladin-restoring-touch',
    name: 'Restoring Touch',
    class: 'paladin',
    level: 14,
    // Applied by Lay On Hands: option "blinded", "charmed", "deafened", "frightened", "paralyzed" or "stunned".
    passive: () => ({
      note: `Restoring Touch: 5 points of the Lay On Hands pool lift one of ${RESTORING_TOUCH.join(', ')} - use_action {action_name: "lay_on_hands_frightened", target_id} and its like.`,
    }),
  },
  {
    index: 'devotion-smite-of-protection',
    name: 'Smite of Protection',
    class: 'paladin',
    level: 15,
    // Applied where Divine Smite is cast: the aura gives Half Cover until the start of your next turn.
    passive: (sheet) => ({
      note: `Smite of Protection: casting Divine Smite gives you and your allies Half Cover inside your ${auraFt(
        sheet,
      )} ft aura until the start of your next turn.`,
    }),
  },
  {
    index: 'paladin-aura-expansion',
    name: 'Aura Expansion',
    class: 'paladin',
    level: 18,
    // Applied by the aura helpers: every aura of this Paladin's reaches 30 ft instead of 10.
    passive: () => ({ note: 'Aura Expansion: your Aura of Protection, and everything riding on it, is a 30 ft Emanation.' }),
  },
  epicBoon('paladin'),
  {
    index: 'devotion-holy-nimbus',
    name: 'Holy Nimbus',
    class: 'paladin',
    level: 20,
    resource: { key: 'holy_nimbus', label: 'Holy Nimbus', per: 'long', max: () => 1 },
    action: (sheet) => ({
      id: 'holy_nimbus',
      kind: 'bonus_action',
      name: 'Holy Nimbus',
      hint: `Ten minutes of holy power in your aura: every enemy that starts its turn inside takes ${
        Math.max(0, mod(sheet, 'cha')) + sheet.proficiency_bonus
      } Radiant damage, the aura fills with sunlight, and you have Advantage on saves a Fiend or an Undead forces on you. Once per long rest, or a level 5 spell slot to buy it back.`,
      cost: { resource: 'holy_nimbus', amount: 1 },
      targets: 'self',
      fallback: { label: 'a level 5 spell slot', affordable: openSlotsAt(sheet, 5) > 0 },
    }),
    resolve: (ask) => {
      // "You can also restore your use of it by expending a level 5 spell slot": the slot pays once the use is gone.
      const spent = leftOf(ask.sheet, 'holy_nimbus') <= 0;
      return {
        economy: 'bonus_action',
        ...(spent ? { spend_slot: 5 } : { spend: { resource: 'holy_nimbus', amount: 1 } }),
        flags: { holy_nimbus: { rounds_left: TEN_MINUTES_ROUNDS } },
        text: `${ask.actor.name}'s aura blazes with holy light for ten minutes${spent ? ', paid for with a level 5 spell slot' : ''} (Holy Nimbus).`,
        notes: [
          `Every enemy that starts its turn in the aura takes ${Math.max(0, mod(ask.sheet, 'cha')) + ask.sheet.proficiency_bonus} Radiant damage.`,
          'The saves a Fiend or an Undead forces on you have Advantage; the engine does not know which creature forced a save, so pass advantage yourself.',
        ],
      };
    },
  },
];

// --- Ranger -------------------------------------------------------------------

const RANGER: FeatureHandler[] = [
  {
    index: 'ranger-favored-enemy',
    name: 'Favored Enemy',
    class: 'ranger',
    level: 1,
    resource: {
      key: 'favored_enemies',
      label: 'Favored Enemy',
      per: 'long',
      max: (sheet) => resourceMax(sheet, 'favored_enemies'),
    },
    passive: (sheet) => ({
      note: `Favored Enemy: Hunter's Mark is always prepared, and ${resourceMax(
        sheet,
        'favored_enemies',
      )} castings a long rest cost no slot - cast it with use_action {spell: "Hunter's Mark", target_id}.`,
    }),
  },
  {
    index: 'ranger-fighting-style',
    name: 'Fighting Style',
    class: 'ranger',
    level: 2,
    passive: (sheet) => fightingStylePassive(sheet),
  },
  {
    index: 'ranger-deft-explorer',
    name: 'Deft Explorer',
    class: 'ranger',
    level: 2,
    passive: () => ({ note: 'Deft Explorer: the chosen skill already carries Expertise on the sheet.' }),
  },
  {
    index: 'hunter-hunters-lore',
    name: "Hunter's Lore",
    class: 'ranger',
    level: 3,
    action: () => ({
      id: 'hunters_lore',
      kind: 'free',
      name: "Hunter's Lore",
      hint: "Name the creature your Hunter's Mark is on and learn its Immunities, Resistances and Vulnerabilities; it costs nothing.",
      targets: 'creature',
    }),
    resolve: (ask) => ({
      economy: 'free',
      read_traits: true,
      text: `${ask.actor.name} reads the strengths and weaknesses of ${(ask.target ?? ask.actor).name}.`,
    }),
  },
  {
    index: 'hunter-hunters-prey',
    name: "Hunter's Prey",
    class: 'ranger',
    level: 3,
    onHit: (ask) => {
      // Horde Breaker is the other option; a second attack against a second creature is the DM's to call.
      const option = (ask.feature.mechanics?.options ?? [])[0] ?? 'Colossus Slayer';
      if (!/colossus/i.test(option)) {
        return [
          {
            kind: 'note',
            feature: "Hunter's Prey",
            note: `Horde Breaker: once this turn ${ask.actor.name} may attack a different creature within 5 ft of ${ask.target.name} with the same weapon. Resolve it with another attack call.`,
          },
        ];
      }
      if (ask.actor.flags.colossus_slayer_used) return [];
      if (!ask.weapon || ask.target_hp_before >= ask.target.hp_max) return [];
      return [
        {
          kind: 'damage',
          feature: 'Colossus Slayer',
          dice: '1d8',
          damage_type: ask.damage_type,
          note: `Colossus Slayer: 1d8 extra${ask.damage_type ? ` ${ask.damage_type}` : ''} damage to a wounded target, once a turn.`,
        },
        {
          kind: 'stance',
          feature: 'Colossus Slayer',
          on: 'self',
          flags: { colossus_slayer_used: true },
          note: 'Colossus Slayer is spent for this turn.',
        },
      ];
    },
  },
  {
    index: 'ranger-roving',
    name: 'Roving',
    class: 'ranger',
    level: 6,
    passive: (sheet) =>
      heavyArmor(sheet)
        ? null
        : {
            note: 'Roving: +10 ft out of heavy armour, and a Climb Speed and a Swim Speed equal to your Speed; those movement modes arrive with R9.',
          },
  },
  {
    index: 'hunter-defensive-tactics',
    name: 'Defensive Tactics',
    class: 'ranger',
    level: 7,
    dm_applied:
      'Escape the Horde needs an attack the engine knows is an opportunity attack (out-of-turn attacks are DM-declared), and Multiattack Defense needs a per-attacker disadvantage window the engine does not track.',
  },
  {
    index: 'ranger-expertise',
    name: 'Expertise',
    class: 'ranger',
    level: 9,
    passive: () => ({ note: 'Expertise: the chosen skills already carry double the proficiency bonus on the sheet.' }),
  },
  {
    index: 'ranger-tireless',
    name: 'Tireless',
    class: 'ranger',
    level: 10,
    resource: { key: 'tireless', label: 'Tireless', per: 'long', max: (sheet) => Math.max(1, mod(sheet, 'wis')) },
    action: (sheet) => ({
      id: 'tireless',
      kind: 'action',
      name: 'Tireless',
      hint: `A Magic action for 1d8 ${signed(mod(sheet, 'wis'))} temporary hit points (minimum 1). A short rest also takes a level of Exhaustion off you.`,
      cost: { resource: 'tireless', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'action',
      spend: { resource: 'tireless', amount: 1 },
      // The SRD's "(minimum of 1)" floors the total, not the Wisdom modifier feeding it.
      temp_hp_expr: `max(1d8${signed(mod(ask.sheet, 'wis'))}, 1)`,
      text: `${ask.actor.name} draws on primal forces (Tireless).`,
      notes: ['Tireless also takes one level of Exhaustion off on every short rest; apply that at the rest.'],
    }),
  },
  {
    index: 'hunter-superior-hunters-prey',
    name: "Superior Hunter's Prey",
    class: 'ranger',
    level: 11,
    // Applied where Hunter's Mark rides on the hit: attack {prey_target_id} names the second creature.
    passive: () => ({
      note: "Superior Hunter's Prey: once on each of your turns, the extra damage of your Hunter's Mark also lands on a second creature within 30 ft of the marked one - name it with attack {prey_target_id}.",
    }),
  },
  {
    index: 'ranger-relentless-hunter',
    name: 'Relentless Hunter',
    class: 'ranger',
    level: 13,
    // Applied at the concentration check: damage never breaks your hold on Hunter's Mark.
    passive: () => ({ note: "Relentless Hunter: taking damage cannot break your Concentration on Hunter's Mark." }),
  },
  {
    index: 'ranger-natures-veil',
    name: "Nature's Veil",
    class: 'ranger',
    level: 14,
    resource: { key: 'natures_veil', label: "Nature's Veil", per: 'long', max: (sheet) => Math.max(1, mod(sheet, 'wis')) },
    action: () => ({
      id: 'natures_veil',
      kind: 'bonus_action',
      name: "Nature's Veil",
      hint: 'Spirits of nature hide you: the Invisible condition until the end of your next turn.',
      cost: { resource: 'natures_veil', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'bonus_action',
      spend: { resource: 'natures_veil', amount: 1 },
      self_condition: { name: 'invisible', rounds: 2 },
      text: `${ask.actor.name} pulls the spirits of nature around themselves and vanishes until the end of their next turn (Nature's Veil).`,
    }),
  },
  {
    index: 'hunter-superior-hunters-defense',
    name: "Superior Hunter's Defense",
    class: 'ranger',
    level: 15,
    action: () => ({
      id: 'superior_hunters_defense',
      kind: 'reaction',
      name: "Superior Hunter's Defense",
      hint: 'Declare it and the next damage you take is halved, with Resistance to that damage type for the rest of the turn. The reaction is spent here.',
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'reaction',
      flags: { hunters_defense_ready: true },
      text: `${ask.actor.name} braces against the next blow: Resistance to its damage type for the rest of the turn (Superior Hunter's Defense).`,
    }),
    onDamageTaken: (ask) =>
      ask.actor.flags.hunters_defense_ready || ask.actor.reaction_used
        ? null
        : {
            action: 'superior_hunters_defense',
            name: "Superior Hunter's Defense",
            hint: `${ask.actor.name} may spend its reaction for Resistance to the next damage it takes and to that type for the rest of the turn: use_action {action_name: "superior_hunters_defense"} before that blow.`,
          },
  },
  {
    index: 'ranger-precise-hunter',
    name: 'Precise Hunter',
    class: 'ranger',
    level: 17,
    beforeAttack: (ask) =>
      ask.effects.some(
        (e) => e.active && e.target_id === ask.target.id && e.source_id === ask.actor.id && /hunter.s mark/i.test(e.name),
      )
        ? [{ advantage: 'advantage', note: "Precise Hunter: your Hunter's Mark is on it" }]
        : [],
  },
  {
    index: 'ranger-feral-senses',
    name: 'Feral Senses',
    class: 'ranger',
    level: 18,
    dm_applied: 'Blindsight is a sense, and what a creature can see or not see arrives with the vision rules of R7.',
  },
  epicBoon('ranger'),
  {
    index: 'ranger-foe-slayer',
    name: 'Foe Slayer',
    class: 'ranger',
    level: 20,
    // Applied where Hunter's Mark rides on the hit: its die is a d10.
    passive: () => ({ note: "Foe Slayer: the extra damage of your Hunter's Mark is a d10." }),
  },
];

// --- Bard ---------------------------------------------------------------------

const INSPIRATION_FT = 60;

/** The two spells Words of Creation keeps prepared, and may send at a second creature. */
export const WORDS_OF_CREATION = ['Power Word Heal', 'Power Word Kill'];

/** How far the second creature Words of Creation catches may stand from the first. */
export const WORDS_OF_CREATION_FT = 10;

const BARD: FeatureHandler[] = [
  {
    index: 'bard-bardic-inspiration',
    name: 'Bardic Inspiration',
    class: 'bard',
    level: 1,
    action: (sheet) => ({
      id: 'bardic_inspiration',
      kind: 'bonus_action',
      name: 'Bardic Inspiration',
      hint: `A creature within ${INSPIRATION_FT} ft that can see or hear you holds one d${bardicDie(
        sheet,
      )} for an hour and adds it to a failed D20 Test. They spend it with attack {inspiration: true} or roll {bardic_inspiration: true}.`,
      cost: { resource: 'bardic_inspiration', amount: 1 },
      targets: 'ally',
    }),
    resolve: (ask) => {
      const target = ask.target;
      if (!target || target.id === ask.actor.id) {
        throw new Error('Bardic Inspiration goes to another creature: name it with target_id.');
      }
      if (target.character_id === null) {
        throw new Error(
          `A Bardic Inspiration die is held on a character sheet, and ${target.name} has none. Inspire a party member.`,
        );
      }
      const away = distanceBetween(ask.actor, target);
      if (away > INSPIRATION_FT) {
        throw new Error(`${target.name} is ${away} ft away, and Bardic Inspiration reaches ${INSPIRATION_FT} ft.`);
      }
      const die = bardicDie(ask.sheet);
      return {
        economy: 'bonus_action',
        spend: { resource: 'bardic_inspiration', amount: 1 },
        inspire: { target_id: target.id, die },
        text: `${ask.actor.name} inspires ${target.name}: a d${die} to add to one failed D20 Test within the hour.`,
      };
    },
  },
  {
    index: 'bard-expertise',
    name: 'Expertise',
    class: 'bard',
    level: 2,
    passive: () => ({ note: 'Expertise: the chosen skills already carry double the proficiency bonus on the sheet.' }),
  },
  {
    index: 'bard-jack-of-all-trades',
    name: 'Jack of All Trades',
    class: 'bard',
    level: 2,
    checkBonus: (ask) =>
      ask.proficient
        ? null
        : { bonus: halfProficiency(ask.sheet), note: `Jack of All Trades: +${halfProficiency(ask.sheet)}` },
    passive: (sheet) => ({
      note: `Jack of All Trades: +${halfProficiency(
        sheet,
      )} on every ability check that carries no proficiency bonus, Initiative included.`,
    }),
  },
  {
    index: 'bard-font-of-inspiration',
    name: 'Font of Inspiration',
    class: 'bard',
    level: 5,
    action: () => ({
      id: 'font_of_inspiration',
      kind: 'free',
      name: 'Font of Inspiration',
      hint: 'Burn a spell slot to get one use of Bardic Inspiration back; pass slot_level. Every use also comes back on a short rest from here on.',
      targets: 'self',
    }),
    resolve: (ask) => {
      const row = resourceRow(ask.sheet, 'bardic_inspiration');
      if ((row?.mechanics?.used ?? 0) <= 0) {
        throw new Error(`${ask.actor.name} has spent no Bardic Inspiration, so there is nothing to buy back.`);
      }
      const slot = ask.slot_level ?? 0;
      if (!Number.isInteger(slot) || slot < 1) {
        throw new Error('Font of Inspiration burns a spell slot: pass slot_level with the level to spend.');
      }
      return {
        economy: 'free',
        spend_slot: slot,
        restore_resource: { key: 'bardic_inspiration', amount: 1 },
        text: `${ask.actor.name} burns a level ${slot} slot for one use of Bardic Inspiration.`,
      };
    },
  },
  {
    index: 'bard-countercharm',
    name: 'Countercharm',
    class: 'bard',
    level: 7,
    dm_applied:
      'It rerolls a saving throw the engine has already resolved, and there is no reroll seam on a finished save - the same reason Indomitable is left to the DM.',
  },
  {
    index: 'bard-magical-secrets',
    name: 'Magical Secrets',
    class: 'bard',
    level: 10,
    passive: () => ({
      note: 'Magical Secrets: new prepared spells may be taken from the Cleric, Druid and Wizard lists as well, which level_up offers.',
    }),
  },
  {
    index: 'lore-bonus-proficiencies',
    name: 'Bonus Proficiencies',
    class: 'bard',
    level: 3,
    passive: (sheet) => ({
      note: `Bonus Proficiencies: ${
        chosenOptions(sheet, 'Bonus Proficiencies').join(', ') || 'three skills'
      } are already proficient on the sheet.`,
    }),
  },
  {
    index: 'lore-cutting-words',
    name: 'Cutting Words',
    class: 'bard',
    level: 3,
    action: (sheet) => ({
      id: 'cutting_words',
      kind: 'reaction',
      name: 'Cutting Words',
      hint: `Spend a use of Bardic Inspiration: the next attack roll by a creature you can see within ${INSPIRATION_FT} ft is cut by a d${bardicDie(
        sheet,
      )}. Declare it with use_action {action_name: "cutting_words", out_of_turn: true, reason: "Cutting Words"}; a damage roll or an ability check within that range is yours to subtract from instead.`,
      cost: { resource: 'bardic_inspiration', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'reaction',
      spend: { resource: 'bardic_inspiration', amount: 1 },
      flags: { cutting_words_ready: { die: bardicDie(ask.sheet) } },
      text: `${ask.actor.name} cuts in: the next attack roll within ${INSPIRATION_FT} ft is reduced by a d${bardicDie(
        ask.sheet,
      )} (Cutting Words).`,
    }),
  },
  {
    index: 'lore-peerless-skill',
    name: 'Peerless Skill',
    class: 'bard',
    level: 14,
    action: (sheet) => ({
      id: 'peerless_skill',
      kind: 'free',
      name: 'Peerless Skill',
      hint: `Declare it and the next ability check or attack roll of yours that fails carries a d${bardicDie(
        sheet,
      )}. The use is spent only if the die turns the failure into a success.`,
      cost: { resource: 'bardic_inspiration', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'free',
      d20_stance: {
        feature: 'Peerless Skill',
        mode: 'add',
        on: ['attack', 'check'],
        dice: `1d${bardicDie(ask.sheet)}`,
        spend: { resource: 'bardic_inspiration', amount: 1 },
        keep_on_failure: true,
      },
      text: `${ask.actor.name} readies a flourish: a d${bardicDie(
        ask.sheet,
      )} goes on their next failed ability check or attack roll, and is spent only if it turns one (Peerless Skill).`,
    }),
  },
  {
    index: 'bard-superior-inspiration',
    name: 'Superior Inspiration',
    class: 'bard',
    level: 18,
    onInitiative: (ask) => {
      const left = leftOf(ask.sheet, 'bardic_inspiration');
      if (left >= 2) return null;
      const back = Math.min(spentOf(ask.sheet, 'bardic_inspiration'), 2 - left);
      if (back <= 0) return null;
      return {
        economy: 'free',
        restore_resource: { key: 'bardic_inspiration', amount: back },
        text: `${ask.actor.name} rolls Initiative and comes back up to two uses of Bardic Inspiration (Superior Inspiration).`,
      };
    },
  },
  epicBoon('bard'),
  {
    index: 'bard-words-of-creation',
    name: 'Words of Creation',
    class: 'bard',
    level: 20,
    beforeCast: (ask) => {
      if (!WORDS_OF_CREATION.some((name) => name.toLowerCase() === ask.spell.name.toLowerCase())) return [];
      const second = ask.options.twin_target;
      if (second === undefined) {
        return [
          {
            kind: 'note',
            feature: 'Words of Creation',
            note: `Words of Creation: a second creature within 10 ft of the first may be caught by ${ask.spell.name} - name it with twin_target.`,
          },
        ];
      }
      return [
        {
          kind: 'extra_target',
          target_id: second,
          within_ft: WORDS_OF_CREATION_FT,
          feature: 'Words of Creation',
          note: `Words of Creation: ${ask.spell.name} reaches a second creature within 10 ft of the first.`,
        },
      ];
    },
    passive: () => ({
      note: `Words of Creation: ${WORDS_OF_CREATION.join(' and ')} are always prepared, and either may take a second creature within 10 ft of the first (twin_target).`,
    }),
  },
  {
    index: 'lore-magical-discoveries',
    name: 'Magical Discoveries',
    class: 'bard',
    level: 6,
    passive: (sheet) => ({
      note: `Magical Discoveries: ${
        chosenOptions(sheet, 'Magical Discoveries').join(' and ') || 'two spells from the Cleric, Druid or Wizard list'
      } are always prepared.`,
    }),
  },
];

// --- Cleric -------------------------------------------------------------------

const CHANNEL_FT = 30;

/** Divine Spark's dice: 1d8, and one more at levels 7, 13 and 18. */
const divineSparkDice = (level: number): number => (level >= 18 ? 4 : level >= 13 ? 3 : level >= 7 ? 2 : 1);

const undeadWithin = (ask: ResolveAsk, ft: number): Combatant[] =>
  ask.combatants.filter(
    (c) =>
      c.id !== ask.actor.id &&
      c.alive &&
      c.hp_current > 0 &&
      distanceBetween(ask.actor, c) <= ft &&
      /undead/i.test(c.stat_block?.type ?? ''),
  );

const CLERIC: FeatureHandler[] = [
  {
    index: 'cleric-divine-order',
    name: 'Divine Order',
    class: 'cleric',
    level: 1,
    checkBonus: (ask) => {
      if (!chose(ask.sheet, 'Divine Order', 'Thaumaturge')) return null;
      if (ask.skill !== 'arcana' && ask.skill !== 'religion') return null;
      const bonus = Math.max(1, mod(ask.sheet, 'wis'));
      return { bonus, note: `Divine Order (Thaumaturge): +${bonus}` };
    },
    passive: (sheet) =>
      chose(sheet, 'Divine Order', 'Protector')
        ? { note: 'Divine Order (Protector): Martial weapons and Heavy armour training, both already on the sheet.' }
        : {
            note: `Divine Order (Thaumaturge): +${Math.max(
              1,
              mod(sheet, 'wis'),
            )} on Intelligence (Arcana) and Intelligence (Religion) checks. The extra Cleric cantrip has no column in the level table, so it is yours to hand over.`,
          },
  },
  {
    index: 'cleric-channel-divinity',
    name: 'Channel Divinity',
    class: 'cleric',
    level: 2,
    action: (sheet) => [
      {
        id: 'divine_spark',
        kind: 'action',
        name: 'Divine Spark',
        hint: `A creature within ${CHANNEL_FT} ft: roll ${divineSparkDice(sheet.level)}d8 + ${mod(
          sheet,
          'wis',
        )} and either heal it (option "heal") or force a CON save for Radiant (option "radiant") or Necrotic (option "necrotic") damage, half on a success.`,
        cost: { resource: 'channel_divinity', amount: 1 },
        targets: 'creature',
      },
      {
        id: 'turn_undead',
        kind: 'action',
        name: 'Turn Undead',
        hint: `Every Undead within ${CHANNEL_FT} ft makes a WIS save against DC ${spellDc(
          sheet,
          'wis',
        )} or is Frightened and Incapacitated for 1 minute, until it takes damage.${
          hasFeature(sheet, 'cleric-sear-undead')
            ? ` Sear Undead burns each one that fails for ${Math.max(1, mod(sheet, 'wis'))}d8 Radiant damage.`
            : ''
        }`,
        cost: { resource: 'channel_divinity', amount: 1 },
        targets: 'self',
      },
    ],
    resolve: (ask) => {
      const cost: FeatureCost = { resource: 'channel_divinity', amount: 1 };
      if (ask.action_id === 'turn_undead') {
        const undead = undeadWithin(ask, CHANNEL_FT);
        if (undead.length === 0) {
          throw new Error(
            `There is no Undead within ${CHANNEL_FT} ft of ${ask.actor.name}, so Turn Undead has nothing to censure.`,
          );
        }
        const searing = hasFeature(ask.sheet, 'cleric-sear-undead');
        return {
          economy: 'action',
          spend: cost,
          save: {
            ability: 'wis',
            dc: spellDc(ask.sheet, 'wis'),
            target_ids: undead.map((c) => c.id),
            conditions: ['frightened', 'incapacitated'],
            ends: 'minute',
            ends_on_damage: true,
            ...(searing
              ? {
                  extra_expr: `${Math.max(1, mod(ask.sheet, 'wis'))}d8`,
                  extra_type: 'radiant',
                  extra_note: 'Sear Undead',
                }
              : {}),
          },
          text: `${ask.actor.name} presents their Holy Symbol and censures the Undead: ${undead
            .map((c) => c.name)
            .join(', ')} within ${CHANNEL_FT} ft.`,
          notes: [
            'A turned creature flees as far from you as it can for the whole minute; no repeat save ends it, but any damage does.',
          ],
        };
      }
      const target = ask.target;
      if (!target || target.id === ask.actor.id) {
        throw new Error('Divine Spark points at another creature you can see: name it with target_id.');
      }
      const away = distanceBetween(ask.actor, target);
      if (away > CHANNEL_FT) throw new Error(`${target.name} is ${away} ft away, and Divine Spark reaches ${CHANNEL_FT} ft.`);
      const expr = `${divineSparkDice(ask.sheet.level)}d8${signed(mod(ask.sheet, 'wis'))}`;
      const option = (ask.option ?? 'heal').toLowerCase();
      if (option === 'heal') {
        return {
          economy: 'action',
          spend: cost,
          heals: [{ target_id: target.id, expr }],
          text: `${ask.actor.name} focuses divine energy into ${target.name} (Divine Spark).`,
        };
      }
      const type = option === 'necrotic' ? 'necrotic' : 'radiant';
      return {
        economy: 'action',
        spend: cost,
        save: {
          ability: 'con',
          dc: spellDc(ask.sheet, 'wis'),
          target_ids: [target.id],
          damage_expr: expr,
          damage_type: type,
          half_on_save: true,
        },
        text: `${ask.actor.name} sears ${target.name} with divine energy (Divine Spark, ${type}).`,
      };
    },
  },
  {
    index: 'cleric-sear-undead',
    name: 'Sear Undead',
    class: 'cleric',
    level: 5,
    // Applied by Turn Undead: the Radiant damage rides on the save the Channel Divinity forces.
  },
  {
    index: 'cleric-blessed-strikes',
    name: 'Blessed Strikes',
    class: 'cleric',
    level: 7,
    onHit: (ask) => {
      if (!chose(ask.sheet, 'Blessed Strikes', 'Divine Strike')) return [];
      if (!ask.weapon || ask.actor.flags.divine_strike_used) return [];
      const type = ask.feature.mechanics?.options?.includes('Necrotic') ? 'necrotic' : 'radiant';
      const dice = hasFeature(ask.sheet, 'cleric-improved-blessed-strikes') ? '2d8' : '1d8';
      return [
        {
          kind: 'damage',
          feature: 'Divine Strike',
          dice,
          damage_type: type,
          note: `Divine Strike: ${dice} extra ${type} damage, once on each of your turns.`,
        },
        {
          kind: 'stance',
          feature: 'Divine Strike',
          on: 'self',
          flags: { divine_strike_used: true },
          note: 'Divine Strike is spent for this turn.',
        },
      ];
    },
    onSpellDamage: (ask) => {
      if (!chose(ask.sheet, 'Blessed Strikes', 'Potent Spellcasting')) return [];
      if (!isCantrip(ask.spell) || !onClassList(ask.spell, 'cleric')) return [];
      const bonus = mod(ask.sheet, 'wis');
      if (bonus <= 0) return [];
      return [
        {
          kind: 'damage',
          feature: 'Potent Spellcasting',
          dice: String(bonus),
          damage_type: ask.damage_type,
          note: `Potent Spellcasting: +${bonus} damage from your Wisdom.`,
        },
      ];
    },
    passive: (sheet) => ({
      note: chose(sheet, 'Blessed Strikes', 'Potent Spellcasting')
        ? `Blessed Strikes (Potent Spellcasting): +${mod(sheet, 'wis')} damage on every Cleric cantrip.`
        : 'Blessed Strikes (Divine Strike): 1d8 extra Radiant damage on one weapon hit each turn.',
    }),
  },
  {
    index: 'cleric-divine-intervention',
    name: 'Divine Intervention',
    class: 'cleric',
    level: 10,
    resource: { key: 'divine_intervention', label: 'Divine Intervention', per: 'long', max: () => 1 },
    passive: () => ({
      note: 'Divine Intervention: once per long rest, cast any Cleric spell of level 5 or lower with no slot and no Material components - use_action {spell, free_cast: "divine_intervention"}.',
    }),
  },
  {
    index: 'cleric-improved-blessed-strikes',
    name: 'Improved Blessed Strikes',
    class: 'cleric',
    level: 14,
    // Divine Strike's own dice are read off this feature by Blessed Strikes; the vitality is here.
    onSpellDamage: (ask) => {
      if (!chose(ask.sheet, 'Blessed Strikes', 'Potent Spellcasting')) return [];
      if (!isCantrip(ask.spell) || !onClassList(ask.spell, 'cleric')) return [];
      const temp = Math.max(0, mod(ask.sheet, 'wis') * 2);
      if (temp <= 0) return [];
      return [
        {
          kind: 'temp_hp',
          feature: 'Improved Blessed Strikes',
          amount: temp,
          on: 'self',
          once_per_cast: true,
          note: `Improved Blessed Strikes: ${temp} temporary hit points. The SRD lets them go to any creature within 60 ft; these land on the caster unless you move them.`,
        },
      ];
    },
    passive: (sheet) =>
      chose(sheet, 'Blessed Strikes', 'Potent Spellcasting')
        ? { note: `Improved Blessed Strikes: a Cleric cantrip that deals damage also grants ${Math.max(0, mod(sheet, 'wis') * 2)} temporary hit points.` }
        : { note: 'Improved Blessed Strikes: Divine Strike deals 2d8.' },
  },
  epicBoon('cleric'),
  {
    index: 'cleric-greater-divine-intervention',
    name: 'Greater Divine Intervention',
    class: 'cleric',
    level: 20,
    passive: () => ({
      note: 'Greater Divine Intervention: Divine Intervention may call for Wish - use_action {spell: "Wish", free_cast: "divine_intervention"}. It then takes 2d4 long rests to come back, which is yours to count.',
    }),
  },
  {
    index: 'life-domain-spells',
    name: 'Life Domain Spells',
    class: 'cleric',
    level: 3,
    passive: () => ({ note: 'Life Domain Spells: the domain spells are always prepared, and sit on the spell list already.' }),
  },
  {
    index: 'life-disciple-of-life',
    name: 'Disciple of Life',
    class: 'cleric',
    level: 3,
    onHeal: (ask) => {
      if (ask.spell.slot_level === null) return [];
      const bonus = 2 + ask.spell.slot_level;
      return [{ feature: 'Disciple of Life', bonus, note: `Disciple of Life: +${bonus} hit points.` }];
    },
  },
  {
    index: 'life-preserve-life',
    name: 'Preserve Life',
    class: 'cleric',
    level: 3,
    action: (sheet) => ({
      id: 'preserve_life',
      kind: 'action',
      name: 'Preserve Life',
      hint: `Spend a Channel Divinity for ${sheet.level * 5} hit points, divided among the Bloodied creatures within ${CHANNEL_FT} ft (yourself and any other creature included) and never above half their hit point maximum. Name one with target_id to pour it all into them.`,
      cost: { resource: 'channel_divinity', amount: 1 },
      targets: 'creature',
    }),
    resolve: (ask) => {
      const pool = ask.sheet.level * 5;
      const room = (c: Combatant): number => Math.max(0, Math.floor(c.hp_max / 2) - c.hp_current);
      // "Choose Bloodied creatures within 30 feet of yourself (which can include you)": any of them, not just allies.
      const bloodied = (ask.target ? [ask.target] : ask.combatants).filter(
        (c) =>
          c.alive &&
          distanceBetween(ask.actor, c) <= CHANNEL_FT &&
          c.hp_current * 2 <= c.hp_max &&
          room(c) > 0,
      );
      if (bloodied.length === 0) {
        throw new Error(
          `Preserve Life heals Bloodied creatures within ${CHANNEL_FT} ft up to half their hit points, and there is none to heal.`,
        );
      }
      let left = pool;
      const heals: Array<{ target_id: number; amount: number }> = [];
      for (const c of [...bloodied].sort((a, b) => room(b) - room(a))) {
        const amount = Math.min(left, room(c));
        if (amount <= 0) continue;
        heals.push({ target_id: c.id, amount });
        left -= amount;
      }
      return {
        economy: 'action',
        spend: { resource: 'channel_divinity', amount: 1 },
        heals,
        text: `${ask.actor.name} pours out healing energy (Preserve Life): ${pool - left} of ${pool} hit points spent.`,
      };
    },
  },
  {
    index: 'life-supreme-healing',
    name: 'Supreme Healing',
    class: 'cleric',
    level: 17,
    // Applied where the healing dice are rolled: each die comes up at its highest face instead.
    passive: () => ({
      note: 'Supreme Healing: the dice of your healing spells and of your Channel Divinity are not rolled - each counts as its highest number.',
    }),
  },
  {
    index: 'life-blessed-healer',
    name: 'Blessed Healer',
    class: 'cleric',
    level: 6,
    onHeal: (ask) => {
      if (ask.spell.slot_level === null || ask.target.id === ask.actor.id) return [];
      const back = 2 + ask.spell.slot_level;
      return [{ feature: 'Blessed Healer', self_heal: back, note: `Blessed Healer: ${back} hit points back to the caster.` }];
    },
  },
];

// --- Druid --------------------------------------------------------------------

const LANDS_AID_FT = 60;
const LANDS_AID_RADIUS = 10;

/** Nature's Ward: the damage type each land lends its Druid. */
const LAND_RESISTANCE: Record<string, string> = { arid: 'fire', polar: 'cold', temperate: 'lightning', tropical: 'poison' };

const DRUID: FeatureHandler[] = [
  {
    index: 'druid-druidic',
    name: 'Druidic',
    class: 'druid',
    level: 1,
    dm_applied:
      'A secret language and its hidden messages are narrated; Speak with Animals is on the spell list already, and casting it is the spell path.',
  },
  {
    index: 'druid-primal-order',
    name: 'Primal Order',
    class: 'druid',
    level: 1,
    checkBonus: (ask) => {
      if (!chose(ask.sheet, 'Primal Order', 'Magician')) return null;
      if (ask.skill !== 'arcana' && ask.skill !== 'nature') return null;
      const bonus = Math.max(1, mod(ask.sheet, 'wis'));
      return { bonus, note: `Primal Order (Magician): +${bonus}` };
    },
    passive: (sheet) =>
      chose(sheet, 'Primal Order', 'Warden')
        ? { note: 'Primal Order (Warden): Martial weapons and Medium armour training, both already on the sheet.' }
        : {
            note: `Primal Order (Magician): +${Math.max(
              1,
              mod(sheet, 'wis'),
            )} on Intelligence (Arcana) and Intelligence (Nature) checks. The extra Druid cantrip has no column in the level table, so it is yours to hand over.`,
          },
  },
  {
    index: 'druid-wild-shape',
    name: 'Wild Shape',
    class: 'druid',
    level: 2,
    action: (sheet) => {
      const limits = beastFormLimits(sheet.level);
      return [
        {
          id: 'wild_shape',
          kind: 'bonus_action',
          name: 'Wild Shape',
          hint: `Take a Beast's game statistics for ${Math.max(1, Math.floor(sheet.level / 2))} hours: pass option with the creature, e.g. option "Wolf". Beasts of CR ${
            limits.max_cr
          } or lower${limits.fly ? '' : ' with no Fly Speed'}; you gain ${sheet.level} temporary hit points and cast no spells while shifted.`,
          cost: { resource: 'wild_shape', amount: 1 },
          targets: 'self',
        },
        {
          id: 'wild_shape_revert',
          kind: 'bonus_action',
          name: 'Revert from Wild Shape',
          hint: 'Drop back into your own form; it costs no use.',
          targets: 'self',
        },
      ];
    },
    resolve: (ask) => {
      if (ask.action_id === 'wild_shape_revert') {
        if (!isWildShaped(ask.actor)) throw new Error(`${ask.actor.name} is not in a Wild Shape form.`);
        return {
          economy: 'bonus_action',
          shape: { revert: true },
          text: `${ask.actor.name} drops back into their own shape.`,
        };
      }
      const form = (ask.option ?? '').trim();
      if (!form) {
        throw new Error('Wild Shape needs the Beast to take: pass option with its SRD name, e.g. option "Wolf".');
      }
      const limits = beastFormLimits(ask.sheet.level);
      return {
        economy: 'bonus_action',
        spend: { resource: 'wild_shape', amount: 1 },
        shape: { form, max_cr: limits.max_cr, fly: limits.fly },
        temp_hp_amount: ask.sheet.level,
        text: `${ask.actor.name} shifts into the shape of a ${form}.`,
        notes: [
          `${ask.sheet.level} temporary hit points, the Beast's own Armor Class, Speed and attacks, and no spellcasting until you drop the form.`,
        ],
      };
    },
    passive: (sheet) => {
      const limits = beastFormLimits(sheet.level);
      return {
        note: `Wild Shape: ${limits.known} known Beast forms of CR ${limits.max_cr} or lower${
          limits.fly ? ', a Fly Speed allowed' : ', none with a Fly Speed'
        }; the form lasts ${Math.max(1, Math.floor(sheet.level / 2))} hours or until you drop it.`,
      };
    },
  },
  {
    index: 'druid-wild-companion',
    name: 'Wild Companion',
    class: 'druid',
    level: 2,
    passive: () => ({
      note: 'Wild Companion: as a Magic action, cast Find Familiar without Material components for a use of Wild Shape - use_action {spell: "Find Familiar", free_cast: "wild_companion", option: "Owl"}.',
    }),
  },
  {
    index: 'druid-wild-resurgence',
    name: 'Wild Resurgence',
    class: 'druid',
    level: 5,
    resource: { key: 'wild_resurgence_slot', label: 'Wild Resurgence (spell slot)', per: 'long', max: () => 1 },
    action: () => [
      {
        id: 'wild_resurgence_shape',
        kind: 'free',
        name: 'Wild Resurgence (a use back)',
        hint: 'With no Wild Shape left, burn a spell slot for one use of it: pass slot_level. Once on each of your turns.',
        targets: 'self',
      },
      {
        id: 'wild_resurgence_slot',
        kind: 'free',
        name: 'Wild Resurgence (a slot back)',
        hint: 'Spend a use of Wild Shape for a level 1 spell slot, once per long rest.',
        cost: { resource: 'wild_resurgence_slot', amount: 1 },
        targets: 'self',
      },
    ],
    resolve: (ask) => {
      if (ask.action_id === 'wild_resurgence_slot') {
        return {
          economy: 'free',
          spend: [
            { resource: 'wild_shape', amount: 1 },
            { resource: 'wild_resurgence_slot', amount: 1 },
          ],
          gain_slot: 1,
          text: `${ask.actor.name} spends a use of Wild Shape for a level 1 spell slot (Wild Resurgence).`,
        };
      }
      if (ask.actor.flags.wild_resurgence_used) {
        throw new Error(`${ask.actor.name} has already turned a slot into Wild Shape this turn; it is once on each of your turns.`);
      }
      const row = resourceRow(ask.sheet, 'wild_shape');
      const left = (row?.mechanics?.max ?? 0) - (row?.mechanics?.used ?? 0);
      if (left > 0) {
        throw new Error(
          `Wild Resurgence buys a use of Wild Shape back only when none is left, and ${ask.actor.name} has ${left}.`,
        );
      }
      const slot = ask.slot_level ?? 0;
      if (!Number.isInteger(slot) || slot < 1) {
        throw new Error('Wild Resurgence burns a spell slot: pass slot_level with the level to spend.');
      }
      return {
        economy: 'free',
        spend_slot: slot,
        restore_resource: { key: 'wild_shape', amount: 1 },
        flags: { wild_resurgence_used: true },
        text: `${ask.actor.name} burns a level ${slot} slot for one use of Wild Shape (Wild Resurgence).`,
      };
    },
  },
  {
    index: 'druid-elemental-fury',
    name: 'Elemental Fury',
    class: 'druid',
    level: 7,
    onHit: (ask) => {
      if (!chose(ask.sheet, 'Elemental Fury', 'Primal Strike')) return [];
      if (ask.actor.flags.primal_strike_used) return [];
      if (!ask.weapon && !isWildShaped(ask.actor)) return [];
      const dice = hasFeature(ask.sheet, 'druid-improved-elemental-fury') ? '2d8' : '1d8';
      return [
        {
          kind: 'damage',
          feature: 'Primal Strike',
          dice,
          damage_type: 'thunder',
          note: `Primal Strike: ${dice} extra Cold, Fire, Lightning or Thunder damage, once on each of your turns - Thunder here unless you rule otherwise.`,
        },
        {
          kind: 'stance',
          feature: 'Primal Strike',
          on: 'self',
          flags: { primal_strike_used: true },
          note: 'Primal Strike is spent for this turn.',
        },
      ];
    },
    onSpellDamage: (ask) => {
      if (!chose(ask.sheet, 'Elemental Fury', 'Potent Spellcasting')) return [];
      if (!isCantrip(ask.spell) || !onClassList(ask.spell, 'druid')) return [];
      const bonus = mod(ask.sheet, 'wis');
      if (bonus <= 0) return [];
      return [
        {
          kind: 'damage',
          feature: 'Potent Spellcasting',
          dice: String(bonus),
          damage_type: ask.damage_type,
          note: `Potent Spellcasting: +${bonus} damage from your Wisdom.`,
        },
      ];
    },
  },
  {
    index: 'land-circle-of-the-land-spells',
    name: 'Circle of the Land Spells',
    class: 'druid',
    level: 3,
    passive: (sheet) => ({
      note: `Circle of the Land Spells: the spells of the land chosen at the last long rest${
        chosenOptions(sheet, 'Circle of the Land Spells').length
          ? ` (${chosenOptions(sheet, 'Circle of the Land Spells').join(', ')})`
          : ''
      } are always prepared.`,
    }),
  },
  {
    index: 'land-lands-aid',
    name: "Land's Aid",
    class: 'druid',
    level: 3,
    action: (sheet) => ({
      id: 'lands_aid',
      kind: 'action',
      name: "Land's Aid",
      hint: `Spend a use of Wild Shape: a ${LANDS_AID_RADIUS} ft radius Sphere at a point within ${LANDS_AID_FT} ft (pass point). Creatures of your choice in it make a CON save against DC ${spellDc(
        sheet,
        'wis',
      )} for ${landsAidDice(sheet.level)}d6 Necrotic damage, half on a success, and one creature of your choice there regains ${landsAidDice(
        sheet.level,
      )}d6 hit points.`,
      cost: { resource: 'wild_shape', amount: 1 },
      targets: 'creature',
    }),
    resolve: (ask) => {
      const point = ask.point ?? (ask.target ? { x: ask.target.x, y: ask.target.y } : null);
      if (!point) throw new Error("Land's Aid is centred on a point: pass point {x, y}, or target_id to centre it on a creature.");
      const away = distanceToPoint(ask.actor, point);
      if (away > LANDS_AID_FT) {
        throw new Error(`That point is ${away} ft away, and Land's Aid reaches ${LANDS_AID_FT} ft.`);
      }
      const inside = ask.combatants.filter(
        (c) => c.alive && c.hp_current > 0 && distanceToPoint(c, point) <= LANDS_AID_RADIUS,
      );
      const hurt = inside.filter((c) => c.team !== ask.actor.team);
      const healed = ask.target ?? inside.find((c) => c.team === ask.actor.team && c.hp_current < c.hp_max);
      const dice = `${landsAidDice(ask.sheet.level)}d6`;
      return {
        economy: 'action',
        spend: { resource: 'wild_shape', amount: 1 },
        ...(hurt.length
          ? {
              save: {
                ability: 'con' as const,
                dc: spellDc(ask.sheet, 'wis'),
                target_ids: hurt.map((c) => c.id),
                damage_expr: dice,
                damage_type: 'necrotic',
                half_on_save: true,
              },
            }
          : {}),
        ...(healed ? { heals: [{ target_id: healed.id, expr: dice }] } : {}),
        text: `Flowers and thorns bloom in a ${LANDS_AID_RADIUS} ft sphere at (${point.x},${point.y}) (Land's Aid).`,
      };
    },
  },
  {
    index: 'land-natural-recovery',
    name: 'Natural Recovery',
    class: 'druid',
    level: 6,
    resource: { key: 'natural_recovery', label: 'Natural Recovery', per: 'long', max: () => 1 },
    passive: (sheet) => ({
      note: `Natural Recovery: once per long rest, cast one prepared Circle spell of level 1+ with no slot - use_action {spell, free_cast: "natural_recovery"} - and a short rest recovers slots adding up to ${Math.ceil(
        sheet.level / 2,
      )} levels, none of them level 6+, with rest {natural_recovery: true}.`,
    }),
  },
  {
    index: 'druid-improved-elemental-fury',
    name: 'Improved Elemental Fury',
    class: 'druid',
    level: 15,
    beforeCast: (ask) => {
      if (!chose(ask.sheet, 'Elemental Fury', 'Potent Spellcasting')) return [];
      if (!isCantrip(ask.spell) || !onClassList(ask.spell, 'druid')) return [];
      if (ask.spell.range_ft === null || ask.spell.range_ft < 10) return [];
      return [
        {
          kind: 'range',
          least_ft: ask.spell.range_ft + 300,
          feature: 'Improved Elemental Fury',
          note: `Improved Elemental Fury: the cantrip reaches ${ask.spell.range_ft + 300} ft.`,
        },
      ];
    },
    passive: (sheet) =>
      chose(sheet, 'Elemental Fury', 'Potent Spellcasting')
        ? { note: 'Improved Elemental Fury: your Druid cantrips of 10 ft range or more reach 300 ft further.' }
        : { note: 'Improved Elemental Fury: Primal Strike deals 2d8.' },
  },
  {
    index: 'druid-beast-spells',
    name: 'Beast Spells',
    class: 'druid',
    level: 18,
    // Applied where a Beast form refuses a casting: it no longer does.
    passive: () => ({
      note: 'Beast Spells: you cast spells in a Wild Shape form, except any whose Material component has a cost or is consumed.',
    }),
  },
  epicBoon('druid'),
  {
    index: 'druid-archdruid',
    name: 'Archdruid',
    class: 'druid',
    level: 20,
    resource: { key: 'natures_magician', label: 'Archdruid (Nature Magician)', per: 'long', max: () => 1 },
    onInitiative: (ask) => {
      // Evergreen Wild Shape: a Druid who rolls Initiative with nothing left gets one use back.
      if (leftOf(ask.sheet, 'wild_shape') > 0 || spentOf(ask.sheet, 'wild_shape') <= 0) return null;
      return {
        economy: 'free',
        restore_resource: { key: 'wild_shape', amount: 1 },
        text: `${ask.actor.name} rolls Initiative with no Wild Shape left and one use blooms back (Archdruid).`,
      };
    },
    action: () => ({
      id: 'natures_magician',
      kind: 'free',
      name: 'Archdruid: Nature Magician',
      hint: 'Turn unexpended uses of Wild Shape into one spell slot, each use worth 2 spell levels: pass amount with the number of uses. Once per long rest.',
      cost: { resource: 'natures_magician', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => {
      const uses = Math.max(1, ask.amount ?? 1);
      const left = leftOf(ask.sheet, 'wild_shape');
      if (uses > left) {
        throw new Error(`${ask.actor.name} has ${left} uses of Wild Shape left, and Nature Magician was asked for ${uses}.`);
      }
      const slot = uses * 2;
      if (slot > 9) {
        throw new Error(`${uses} uses of Wild Shape would make a level ${slot} slot, and spells stop at level 9.`);
      }
      return {
        economy: 'free',
        spend: [
          { resource: 'wild_shape', amount: uses },
          { resource: 'natures_magician', amount: 1 },
        ],
        gain_slot: slot,
        text: `${ask.actor.name} turns ${uses} use(s) of Wild Shape into a level ${slot} spell slot (Archdruid).`,
        notes: ['Longevity - one year of ageing for every ten that pass - is narrative, and yours.'],
      };
    },
  },
  {
    index: 'land-natures-ward',
    name: "Nature's Ward",
    class: 'druid',
    level: 10,
    passive: (sheet) => {
      const land = chosenOptions(sheet, 'Circle of the Land Spells')[0]?.toLowerCase();
      const resistance = land ? LAND_RESISTANCE[land] : undefined;
      return {
        condition_immunities: ['poisoned'],
        ...(resistance ? { resistances: [resistance] } : {}),
        note: `Nature's Ward: immune to the Poisoned condition${
          resistance
            ? `, and Resistance to ${resistance} from your ${land} land`
            : '; the Resistance follows the land chosen at the last long rest, which is yours to apply until one is recorded'
        }.`,
      };
    },
  },
  {
    index: 'land-natures-sanctuary',
    name: "Nature's Sanctuary",
    class: 'druid',
    level: 14,
    action: (sheet) => ({
      id: 'natures_sanctuary',
      kind: 'action',
      name: "Nature's Sanctuary",
      hint: `Spend a use of Wild Shape: spectral trees fill a 15 ft Cube on the ground within 120 ft for 1 minute (pass point). You and your allies have Half Cover in it, and your allies share your Nature's Ward Resistance${
        chosenOptions(sheet, 'Circle of the Land Spells')[0] ? '' : ' once a land is chosen'
      }.`,
      cost: { resource: 'wild_shape', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => {
      const point = ask.point ?? (ask.target ? { x: ask.target.x, y: ask.target.y } : null);
      if (!point) {
        throw new Error("Nature's Sanctuary is centred on a point: pass point {x, y}, or target_id to centre it on a creature.");
      }
      const away = distanceToPoint(ask.actor, point);
      if (away > 120) throw new Error(`That point is ${away} ft away, and Nature's Sanctuary reaches 120 ft.`);
      return {
        economy: 'action',
        spend: { resource: 'wild_shape', amount: 1 },
        text: `Spectral trees and vines fill a 15 ft cube at (${point.x},${point.y}) for 1 minute (Nature's Sanctuary).`,
        notes: [
          'The engine has no standing zone on the map: the Half Cover it gives you and your allies, and the Resistance your allies borrow, are yours to apply while they stand in it.',
          'Moving the cube up to 60 ft is a Bonus Action of yours.',
        ],
      };
    },
  },
];

/** Land's Aid: 2d6, and one die more at Druid levels 10 and 14. */
function landsAidDice(level: number): number {
  return level >= 14 ? 4 : level >= 10 ? 3 : 2;
}

// --- Sorcerer -----------------------------------------------------------------

/** Creating Spell Slots: what a slot of each level costs in sorcery points, and the level it needs. */
export const SLOT_COSTS: Record<number, { points: number; min_level: number }> = {
  1: { points: 2, min_level: 2 },
  2: { points: 3, min_level: 3 },
  3: { points: 5, min_level: 5 },
  4: { points: 6, min_level: 7 },
  5: { points: 7, min_level: 9 },
};

/** The Metamagic options that may ride on a casting another option is already on. */
export const STACKING_METAMAGIC = ['Empowered Spell', 'Seeking Spell'];

/** What one Metamagic option costs in sorcery points, off the SRD option list. */
export const metamagicCost = (name: string): number =>
  metamagicOptions().find((o) => o.name.toLowerCase() === name.trim().toLowerCase())?.cost ?? 0;

/** The damage types Transmuted Spell may swap between. */
export const TRANSMUTABLE = ['acid', 'cold', 'fire', 'lightning', 'poison', 'thunder'];

const SORCERER: FeatureHandler[] = [
  {
    index: 'sorcerer-innate-sorcery',
    name: 'Innate Sorcery',
    class: 'sorcerer',
    level: 1,
    resource: { key: 'innate_sorcery', label: 'Innate Sorcery', per: 'long', max: () => 2 },
    action: (sheet) => ({
      id: 'innate_sorcery',
      kind: 'bonus_action',
      name: 'Innate Sorcery',
      hint: `1 minute of simmering magic: +1 to the save DC of your Sorcerer spells and Advantage on their attack rolls.${
        hasFeature(sheet, 'sorcerer-sorcery-incarnate')
          ? ' Sorcery Incarnate: with no uses left it costs 2 Sorcery Points instead, and two Metamagic options may ride on each spell while it runs.'
          : ''
      }`,
      cost: { resource: 'innate_sorcery', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => {
      const row = resourceRow(ask.sheet, 'innate_sorcery');
      const left = (row?.mechanics?.max ?? 0) - (row?.mechanics?.used ?? 0);
      // Sorcery Incarnate pays for it with Sorcery Points once the two uses a long rest are gone.
      const incarnate = left <= 0 && hasFeature(ask.sheet, 'sorcerer-sorcery-incarnate');
      return {
        economy: 'bonus_action',
        spend: incarnate ? { resource: 'sorcery_points', amount: 2 } : { resource: 'innate_sorcery', amount: 1 },
        flags: { innate_sorcery: { rounds_left: MINUTE_ROUNDS } },
        text: `${ask.actor.name} unleashes their innate sorcery for 1 minute: +1 to their Sorcerer spell save DC and Advantage on Sorcerer spell attack rolls${
          incarnate ? ', paid for with 2 Sorcery Points (Sorcery Incarnate)' : ''
        }.`,
      };
    },
    beforeCast: (ask) => {
      if (!innateSorcery(ask.actor) || !onClassList(ask.spell, 'sorcerer')) return [];
      const out: CastModifier[] = [
        { kind: 'save_dc', bonus: 1, feature: 'Innate Sorcery', note: 'Innate Sorcery: +1 to the spell save DC.' },
      ];
      if (ask.spell.attack_roll) {
        out.push({ kind: 'attack_advantage', feature: 'Innate Sorcery', note: 'Innate Sorcery: Advantage on the spell attack roll.' });
      }
      return out;
    },
  },
  {
    index: 'sorcerer-font-of-magic',
    name: 'Font of Magic',
    class: 'sorcerer',
    level: 2,
    action: (sheet) => [
      {
        id: 'font_of_magic_to_points',
        kind: 'free',
        name: 'Font of Magic: a slot into points',
        hint: 'Burn a spell slot for Sorcery Points equal to its level: pass slot_level.',
        targets: 'self',
      },
      {
        id: 'font_of_magic_to_slot',
        kind: 'bonus_action',
        name: 'Font of Magic: points into a slot',
        hint: `Turn Sorcery Points into a spell slot, expended slots or none: pass slot_level. ${Object.entries(SLOT_COSTS)
          .filter(([, cost]) => cost.min_level <= sheet.level)
          .map(([level, cost]) => `level ${level} costs ${cost.points}`)
          .join(', ')}. A created slot is spent before the ones the table gives you, and vanishes on a long rest.`,
        targets: 'self',
      },
    ],
    resolve: (ask) => {
      const slot = ask.slot_level ?? 0;
      if (!Number.isInteger(slot) || slot < 1) {
        throw new Error('Font of Magic needs the slot level to convert: pass slot_level.');
      }
      if (ask.action_id === 'font_of_magic_to_points') {
        const max = resourceMax(ask.sheet, 'sorcery_points');
        return {
          economy: 'free',
          spend_slot: slot,
          restore_resource: { key: 'sorcery_points', amount: slot },
          text: `${ask.actor.name} burns a level ${slot} slot for ${slot} Sorcery Points (never more than the ${max} the table allows).`,
        };
      }
      const cost = SLOT_COSTS[slot];
      if (!cost) {
        throw new Error(`Font of Magic creates slots of level 1 to 5; level ${slot} is not one of them.`);
      }
      if (ask.sheet.level < cost.min_level) {
        throw new Error(
          `A level ${slot} slot needs a level ${cost.min_level} Sorcerer, and ${ask.actor.name} is level ${ask.sheet.level}.`,
        );
      }
      return {
        economy: 'bonus_action',
        spend: { resource: 'sorcery_points', amount: cost.points },
        gain_slot: slot,
        text: `${ask.actor.name} weaves ${cost.points} Sorcery Points into a level ${slot} spell slot; it vanishes on a long rest.`,
      };
    },
  },
  {
    index: 'sorcerer-metamagic',
    name: 'Metamagic',
    class: 'sorcerer',
    level: 2,
    passive: (sheet) => ({
      note: `Metamagic: ${heldMetamagic(sheet)
        .map((name) => `${name} (${metamagicCost(name)})`)
        .join(', ')} - named on the cast with use_action {spell, metamagic: [...]}, one option a spell unless it says otherwise.`,
    }),
    beforeCast: (ask) => {
      const out: CastModifier[] = [];
      for (const name of ask.options.metamagic) {
        const spend = { resource: 'sorcery_points', amount: metamagicCost(name) };
        if (/careful/i.test(name)) {
          const most = Math.max(1, mod(ask.sheet, 'cha'));
          const ids = (ask.options.careful_targets ?? []).slice(0, most);
          if (ids.length === 0) {
            throw new Error(
              `Careful Spell needs the creatures it protects: pass careful_targets with up to ${most} combatant id(s).`,
            );
          }
          out.push({
            kind: 'auto_success',
            target_ids: ids,
            feature: 'Careful Spell',
            spend,
            note: `Careful Spell: ${ids.length} creature(s) succeed on the save and take no damage.`,
          });
        }
        if (/distant/i.test(name)) {
          out.push({
            kind: 'range',
            multiplier: 2,
            least_ft: 30,
            feature: 'Distant Spell',
            spend,
            note: "Distant Spell: double the spell's range, or 30 ft for a touch spell.",
          });
        }
        if (/empowered/i.test(name)) {
          out.push({
            kind: 'reroll_damage',
            dice: Math.max(1, mod(ask.sheet, 'cha')),
            feature: 'Empowered Spell',
            spend,
            note: `Empowered Spell: reroll up to ${Math.max(1, mod(ask.sheet, 'cha'))} damage dice and keep the new rolls.`,
          });
        }
        if (/extended/i.test(name)) {
          out.push({
            kind: 'duration',
            multiplier: 2,
            concentration_advantage: true,
            feature: 'Extended Spell',
            spend,
            note: 'Extended Spell: twice the duration, up to 24 hours, and Advantage on the saves that keep its Concentration.',
          });
        }
        if (/heightened/i.test(name)) {
          const id = ask.options.heighten_target ?? ask.targets[0]?.id;
          if (id !== undefined) {
            out.push({
              kind: 'save_disadvantage',
              target_id: id,
              feature: 'Heightened Spell',
              spend,
              note: 'Heightened Spell: that target saves with Disadvantage.',
            });
          }
        }
        if (/quickened/i.test(name)) {
          out.push({
            kind: 'economy',
            economy: 'bonus_action',
            feature: 'Quickened Spell',
            spend,
            note: 'Quickened Spell: the casting time becomes a Bonus Action.',
          });
        }
        if (/seeking/i.test(name)) {
          out.push({
            kind: 'reroll_attack',
            feature: 'Seeking Spell',
            spend,
            note: 'Seeking Spell: a missed spell attack roll is rerolled once, and the new roll stands.',
          });
        }
        if (/subtle/i.test(name)) {
          out.push({
            kind: 'note',
            feature: 'Subtle Spell',
            spend,
            note: 'Subtle Spell: cast with no Verbal, Somatic or costless Material components - nobody sees it happen.',
          });
        }
        if (/transmuted/i.test(name)) {
          const to = (ask.options.transmute_to ?? '').toLowerCase();
          if (!TRANSMUTABLE.includes(to)) {
            throw new Error(`Transmuted Spell swaps between ${TRANSMUTABLE.join(', ')}: pass transmute_to with one of them.`);
          }
          if (ask.spell.damage_type && !TRANSMUTABLE.includes(ask.spell.damage_type.toLowerCase())) {
            throw new Error(
              `${ask.spell.name} deals ${ask.spell.damage_type} damage, and Transmuted Spell only swaps ${TRANSMUTABLE.join(', ')}.`,
            );
          }
          out.push({
            kind: 'damage_type',
            to,
            feature: 'Transmuted Spell',
            spend,
            note: `Transmuted Spell: the damage is ${to} instead.`,
          });
        }
        if (/twinned/i.test(name)) {
          const id = ask.options.twin_target;
          if (id === undefined) throw new Error('Twinned Spell needs the second creature: pass twin_target with its combatant id.');
          // "a spell ... that can be cast with a higher-level spell slot to target an additional creature".
          if (!upcastAddsTarget(ask.spell.name)) {
            throw new Error(
              `Twinned Spell rides on a spell a higher-level slot lets you target an additional creature with, such as Charm Person; ${ask.spell.name} is not one of those.`,
            );
          }
          out.push({
            kind: 'extra_target',
            target_id: id,
            feature: 'Twinned Spell',
            spend,
            note: "Twinned Spell: the spell's effective level goes up by 1 and it reaches a second creature.",
          });
          out.push({ kind: 'slot_level', increase: 1, feature: 'Twinned Spell', note: 'Twinned Spell: cast a level higher.' });
        }
      }
      return out;
    },
  },
  {
    index: 'sorcerer-sorcerous-restoration',
    name: 'Sorcerous Restoration',
    class: 'sorcerer',
    level: 5,
    resource: { key: 'sorcerous_restoration', label: 'Sorcerous Restoration', per: 'long', max: () => 1 },
    passive: (sheet) => ({
      note: `Sorcerous Restoration: a short rest gives back up to ${Math.floor(
        sheet.level / 2,
      )} Sorcery Points, once per long rest - rest {kind: "short", sorcerous_restoration: true}.`,
    }),
  },
  {
    index: 'sorcerer-sorcery-incarnate',
    name: 'Sorcery Incarnate',
    class: 'sorcerer',
    level: 7,
    // Applied by Innate Sorcery (2 Sorcery Points once the uses are gone) and by the Metamagic count.
    passive: () => ({
      note: 'Sorcery Incarnate: Innate Sorcery may be bought for 2 Sorcery Points, and two Metamagic options ride on each spell while it runs.',
    }),
  },
  {
    index: 'draconic-sorcery-draconic-resilience',
    name: 'Draconic Resilience',
    class: 'sorcerer',
    level: 3,
    passive: (sheet) => ({
      note: `Draconic Resilience: +1 hit point per Sorcerer level, and out of armour your base Armor Class is 10 + DEX + CHA (+${mod(
        sheet,
        'cha',
      )} from CHA).`,
    }),
  },
  {
    index: 'draconic-sorcery-draconic-spells',
    name: 'Draconic Spells',
    class: 'sorcerer',
    level: 3,
    passive: () => ({ note: 'Draconic Spells: the listed spells are always prepared, and sit on the spell list already.' }),
  },
  {
    index: 'draconic-sorcery-elemental-affinity',
    name: 'Elemental Affinity',
    class: 'sorcerer',
    level: 6,
    passive: (sheet) => {
      const type = chosenOptions(sheet, 'Elemental Affinity')[0]?.toLowerCase();
      return {
        ...(type ? { resistances: [type] } : {}),
        note: type
          ? `Elemental Affinity: Resistance to ${type}, and +${mod(sheet, 'cha')} on one damage roll of a spell that deals it.`
          : 'Elemental Affinity: choose Acid, Cold, Fire, Lightning or Poison; the Resistance and the damage follow that choice.',
      };
    },
    onSpellDamage: (ask) => {
      const type = chosenOptions(ask.sheet, 'Elemental Affinity')[0]?.toLowerCase();
      if (!type || ask.damage_type?.toLowerCase() !== type) return [];
      const bonus = mod(ask.sheet, 'cha');
      if (bonus <= 0) return [];
      return [
        {
          kind: 'damage',
          feature: 'Elemental Affinity',
          dice: String(bonus),
          damage_type: ask.damage_type,
          once_per_cast: true,
          note: `Elemental Affinity: +${bonus} ${type} damage on one damage roll of the spell.`,
        },
      ];
    },
  },
  {
    index: 'draconic-sorcery-dragon-wings',
    name: 'Dragon Wings',
    class: 'sorcerer',
    level: 14,
    dm_applied: 'A Fly Speed of 60 ft for an hour needs the movement modes R9 brings; nothing in the engine flies yet.',
  },
  {
    index: 'draconic-sorcery-dragon-companion',
    name: 'Dragon Companion',
    class: 'sorcerer',
    level: 18,
    dm_applied:
      'Summon Dragon puts a summoned creature on the field, and the engine has no summoning model beyond the familiar Find Familiar conjures.',
  },
  epicBoon('sorcerer'),
  {
    index: 'sorcerer-arcane-apotheosis',
    name: 'Arcane Apotheosis',
    class: 'sorcerer',
    level: 20,
    // Applied where a casting is planned: the first Metamagic option of the turn costs no Sorcery Points.
    passive: () => ({
      note: 'Arcane Apotheosis: while Innate Sorcery runs, one Metamagic option on each of your turns costs no Sorcery Points.',
    }),
  },
];

/** Arcane Apotheosis: whether this casting is the free Metamagic of the turn. */
export const arcaneApotheosisFree = (sheet: CombatSheet, actor: Combatant): boolean =>
  hasFeature(sheet, 'sorcerer-arcane-apotheosis') && innateSorcery(actor) && actor.flags.apotheosis_used !== true;

// --- Warlock ------------------------------------------------------------------

const DARK_ONES_BLESSING_FT = 10;
const REPELLING_BLAST_FT = 10;

/** The Pact Magic slot level a Warlock casts at: every slot they have is of the same level. */
export function pactSlotLevel(sheet: CombatSheet): number {
  const levels = Object.entries(sheet.spell_slots)
    .filter(([, slot]) => slot.max > 0)
    .map(([level]) => Number(level));
  return levels.length ? Math.max(...levels) : 0;
}

/** A pact weapon swing: Pact of the Blade bonds a Simple or Martial Melee weapon, and this is one. */
const pactWeaponSwing = (ask: AttackAsk): boolean =>
  hasInvocation(ask.sheet, 'Pact of the Blade') && ask.melee && ask.weapon !== undefined;

/** A damaging Warlock cantrip: what Agonizing Blast, Repelling Blast and Eldritch Spear are chosen from. */
const warlockCantrip = (spell: SpellInfo): boolean => spell.level === 0 && onClassList(spell, 'warlock');

const WARLOCK: FeatureHandler[] = [
  {
    index: 'warlock-pact-magic',
    name: 'Pact Magic',
    class: 'warlock',
    level: 1,
    passive: (sheet) => ({
      note: `Pact Magic: every slot is level ${pactSlotLevel(sheet)}, and a short rest gives them all back.`,
    }),
  },
  {
    index: 'warlock-eldritch-invocations',
    name: 'Eldritch Invocations',
    class: 'warlock',
    level: 1,
    // The one invocation whose free casting the text counts: Gift of the Depths, once per long rest.
    resource: {
      key: 'gift_of_the_depths',
      label: 'Gift of the Depths (Water Breathing)',
      per: 'long',
      max: (sheet) => (hasInvocation(sheet, 'Gift of the Depths') ? 1 : 0),
    },
    action: (sheet) =>
      hasInvocation(sheet, 'Pact of the Blade')
        ? {
            id: 'pact_weapon',
            kind: 'bonus_action',
            name: 'Pact of the Blade',
            hint: 'Conjure or bond a Simple or Martial Melee weapon: you are proficient with it, swing it with Charisma, and may have it deal Necrotic, Psychic or Radiant damage. Pass option with the weapon.',
            targets: 'self',
          }
        : null,
    resolve: (ask) => {
      const weapon = (ask.option ?? '').trim() || 'the weapon in hand';
      return {
        economy: 'bonus_action',
        flags: { pact_weapon: { weapon } },
        text: `${ask.actor.name} conjures a pact weapon (${weapon}): proficient with it, swung with Charisma, and its damage may be Necrotic, Psychic or Radiant.`,
      };
    },
    beforeSave: (ask) =>
      ask.concentration && hasInvocation(ask.sheet, 'Eldritch Mind')
        ? [{ advantage: 'advantage', note: 'Eldritch Mind' }]
        : [],
    beforeCast: (ask) => {
      if (!hasInvocation(ask.sheet, 'Eldritch Spear') || !warlockCantrip(ask.spell)) return [];
      if (ask.spell.range_ft === null || ask.spell.range_ft < 10) return [];
      return [
        {
          kind: 'range',
          least_ft: ask.spell.range_ft + 30 * ask.sheet.level,
          feature: 'Eldritch Spear',
          note: `Eldritch Spear: the cantrip reaches ${ask.spell.range_ft + 30 * ask.sheet.level} ft.`,
        },
      ];
    },
    onSpellDamage: (ask) => {
      const out: HitRider[] = [];
      const bonus = mod(ask.sheet, 'cha');
      if (hasInvocation(ask.sheet, 'Agonizing Blast') && warlockCantrip(ask.spell) && bonus > 0) {
        out.push({
          kind: 'damage',
          feature: 'Agonizing Blast',
          dice: String(bonus),
          damage_type: ask.damage_type,
          note: `Agonizing Blast: +${bonus} damage from your Charisma. The SRD ties it to one chosen cantrip; this is the one you cast.`,
        });
      }
      if (hasInvocation(ask.sheet, 'Repelling Blast') && warlockCantrip(ask.spell) && ask.spell.attack_roll && ask.target.size !== 'H' && ask.target.size !== 'G') {
        out.push({
          kind: 'push',
          feature: 'Repelling Blast',
          ft: REPELLING_BLAST_FT,
          note: `Repelling Blast: ${ask.target.name} is driven ${REPELLING_BLAST_FT} ft straight back.`,
        });
      }
      return out;
    },
    onHit: (ask) => {
      const out: HitRider[] = [];
      if (!pactWeaponSwing(ask)) return out;
      if (ask.options.eldritch_smite && !ask.actor.flags.eldritch_smite_used) {
        const slot = pactSlotLevel(ask.sheet);
        out.push({
          kind: 'damage',
          feature: 'Eldritch Smite',
          dice: `${1 + slot}d8`,
          damage_type: 'force',
          spend_slot: slot,
          note: `Eldritch Smite: a level ${slot} Pact Magic slot for ${1 + slot}d8 Force damage.`,
        });
        if (ask.target.size !== 'G') {
          out.push({
            kind: 'condition',
            feature: 'Eldritch Smite',
            condition: 'prone',
            ends: 'manual',
            note: `Eldritch Smite: ${ask.target.name} is knocked Prone.`,
          });
        }
        out.push({
          kind: 'stance',
          feature: 'Eldritch Smite',
          on: 'self',
          flags: { eldritch_smite_used: true },
          note: 'Eldritch Smite is spent for this turn.',
        });
      }
      if (hasInvocation(ask.sheet, 'Lifedrinker') && !ask.actor.flags.lifedrinker_used) {
        out.push({
          kind: 'damage',
          feature: 'Lifedrinker',
          dice: '1d6',
          damage_type: 'necrotic',
          note: 'Lifedrinker: 1d6 extra Necrotic, Psychic or Radiant damage - Necrotic here unless you rule otherwise. A Hit Point Die spent on it heals you; take that at the next rest.',
        });
        out.push({
          kind: 'stance',
          feature: 'Lifedrinker',
          on: 'self',
          flags: { lifedrinker_used: true },
          note: 'Lifedrinker is spent for this turn.',
        });
      }
      return out;
    },
    passive: (sheet) => {
      const held = heldInvocations(sheet);
      if (held.length === 0) return null;
      const handed = held
        .map((name) => ({ name, why: findInvocation(name)?.mechanics?.dm_applied }))
        .filter((entry): entry is { name: string; why: string } => entry.why !== undefined);
      return {
        note: `Eldritch Invocations: ${held.join(', ')}.${
          handed.length ? ` Left to you: ${handed.map((entry) => `${entry.name} - ${entry.why}`).join(' ')}` : ''
        }`,
      };
    },
  },
  {
    index: 'warlock-magical-cunning',
    name: 'Magical Cunning',
    class: 'warlock',
    level: 2,
    dm_applied:
      'A 1-minute rite, which cannot happen in a fight and has no seam outside one: give back half the Pact Magic slots, rounded up, once per long rest.',
  },
  {
    index: 'warlock-contact-patron',
    name: 'Contact Patron',
    class: 'warlock',
    level: 9,
    dm_applied:
      'Contact Other Plane takes 1 minute to cast, which R8 covers; the free casting and the automatic save are yours to narrate until then.',
  },
  {
    index: 'fiend-patron-fiend-spells',
    name: 'Fiend Spells',
    class: 'warlock',
    level: 3,
    passive: () => ({ note: 'Fiend Spells: the patron spells are always prepared, and sit on the spell list already.' }),
  },
  {
    index: 'fiend-patron-dark-ones-blessing',
    name: "Dark One's Blessing",
    class: 'warlock',
    level: 3,
    onKill: (ask) => {
      if (!ask.by_me && ask.distance_ft > DARK_ONES_BLESSING_FT) return null;
      if (ask.victim.team === ask.actor.team) return null;
      const amount = Math.max(1, mod(ask.sheet, 'cha') + ask.sheet.level);
      return {
        economy: 'free',
        temp_hp_amount: amount,
        text: `${ask.victim.name} drops and ${ask.actor.name} draws on it: ${amount} temporary hit points (Dark One's Blessing).`,
      };
    },
  },
  {
    index: 'fiend-patron-dark-ones-own-luck',
    name: "Dark One's Own Luck",
    class: 'warlock',
    level: 6,
    resource: {
      key: 'dark_ones_own_luck',
      label: "Dark One's Own Luck",
      per: 'long',
      max: (sheet) => Math.max(1, mod(sheet, 'cha')),
    },
    action: () => ({
      id: 'dark_ones_own_luck',
      kind: 'free',
      name: "Dark One's Own Luck",
      hint: 'Add 1d10 to your next ability check or saving throw; out of a fight it is roll {dark_ones_luck: true}.',
      cost: { resource: 'dark_ones_own_luck', amount: 1 },
      targets: 'self',
    }),
    resolve: (ask) => ({
      economy: 'free',
      spend: { resource: 'dark_ones_own_luck', amount: 1 },
      flags: { dark_ones_luck_ready: true },
      text: `${ask.actor.name} calls on their patron: 1d10 rides on their next ability check or saving throw.`,
    }),
  },
  {
    index: 'fiend-patron-hurl-through-hell',
    name: 'Hurl Through Hell',
    class: 'warlock',
    level: 14,
    resource: { key: 'hurl_through_hell', label: 'Hurl Through Hell', per: 'long', max: () => 1 },
    onHit: (ask) => {
      if (!ask.options.hurl_through_hell || ask.actor.flags.hurl_through_hell_used) return [];
      // The Pact Magic slot pays for it once the use a long rest is gone.
      const spent = leftOf(ask.sheet, 'hurl_through_hell') <= 0;
      const slot = pactSlotLevel(ask.sheet);
      return [
        {
          kind: 'save',
          feature: 'Hurl Through Hell',
          ability: 'cha',
          dc: spellDc(ask.sheet, 'cha'),
          condition: 'incapacitated',
          ends: 'end_of_your_next_turn',
          ...(spent ? { spend_slot: slot } : { spend: { resource: 'hurl_through_hell', amount: 1 } }),
          damage: { expr: '8d10', type: 'psychic', unless_type: 'fiend' },
          note: `Hurl Through Hell: ${ask.target.name} is torn through the Lower Planes${
            spent ? ', paid for with a Pact Magic slot' : ''
          } - 8d10 Psychic damage unless it is a Fiend, and Incapacitated until the end of your next turn, when it reappears.`,
          on_success: 'it stays exactly where it is',
        },
        {
          kind: 'stance',
          feature: 'Hurl Through Hell',
          on: 'self',
          flags: { hurl_through_hell_used: true },
          note: 'Hurl Through Hell is spent for this turn.',
        },
      ];
    },
    passive: () => ({
      note: 'Hurl Through Hell: attack {hurl_through_hell: true} on a hit, once per turn and once per long rest - or a Pact Magic slot to buy the use back.',
    }),
  },
  {
    index: 'fiend-patron-fiendish-resilience',
    name: 'Fiendish Resilience',
    class: 'warlock',
    level: 10,
    passive: (sheet) => {
      const type = chosenOptions(sheet, 'Fiendish Resilience')[0]?.toLowerCase();
      return {
        ...(type ? { resistances: [type] } : {}),
        note: type
          ? `Fiendish Resilience: Resistance to ${type} until you choose another on a rest.`
          : 'Fiendish Resilience: choose a damage type other than Force on a short or long rest - rest {fiendish_resilience: "fire"} - and you resist it until you choose another.',
      };
    },
  },
  {
    index: 'warlock-mystic-arcanum',
    name: 'Mystic Arcanum',
    class: 'warlock',
    level: 11,
    resources: (sheet) =>
      mysticArcanumLevels(sheet.level).map((level) => ({
        key: `mystic_arcanum_${level}`,
        label: `Mystic Arcanum (level ${level})`,
        per: 'long' as const,
        max: 1,
      })),
    passive: (sheet) => ({
      note: `Mystic Arcanum: one Warlock spell of each of levels ${mysticArcanumLevels(sheet.level).join(
        ', ',
      )} cast once a long rest with no slot - use_action {spell, free_cast: "mystic_arcanum"}.`,
    }),
  },
  epicBoon('warlock'),
  {
    index: 'warlock-eldritch-master',
    name: 'Eldritch Master',
    class: 'warlock',
    level: 20,
    dm_applied:
      'It rides on Magical Cunning, which is a one-minute rite outside a fight; the engine has no seam for a feature taken between encounters, so give back every Pact Magic slot at the rest yourself.',
  },
];

/** Mystic Arcanum: the spell levels a Warlock of this level holds an arcanum of. */
export const mysticArcanumLevels = (level: number): number[] =>
  [6, 7, 8, 9].filter((spellLevel) => level >= 11 + (spellLevel - 6) * 2);

// --- Wizard -------------------------------------------------------------------

/** Overchannel counts its uses since the long rest that resets them; nobody survives ten of them. */
const OVERCHANNEL_USES = 10;

/** Signature Spells: the resource key one chosen spell's free casting is counted under. */
export const signatureKey = (spell: string): string => `signature_${spell.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

const WIZARD: FeatureHandler[] = [
  {
    index: 'wizard-ritual-adept',
    name: 'Ritual Adept',
    class: 'wizard',
    level: 1,
    dm_applied: 'Casting a spell as a Ritual is its own casting mode, which R8 brings with the long casting times.',
  },
  {
    index: 'wizard-arcane-recovery',
    name: 'Arcane Recovery',
    class: 'wizard',
    level: 1,
    passive: (sheet) => ({
      note: `Arcane Recovery: a short rest recovers slots adding up to ${Math.ceil(
        sheet.level / 2,
      )} levels, none of them level 6+, once per long rest - rest {kind: "short", arcane_recovery: true}.`,
    }),
  },
  {
    index: 'wizard-scholar',
    name: 'Scholar',
    class: 'wizard',
    level: 2,
    passive: (sheet) => ({
      note: `Scholar: Expertise in ${chosenOptions(sheet, 'Scholar').join(', ') || 'one field of study'}, already doubled on the sheet.`,
    }),
  },
  {
    index: 'wizard-memorize-spell',
    name: 'Memorize Spell',
    class: 'wizard',
    level: 5,
    passive: () => ({
      note: 'Memorize Spell: a short rest swaps one prepared level 1+ spell for another from the spellbook - rest {kind: "short", memorize_spell: {replace, with}}.',
    }),
  },
  {
    index: 'evoker-evocation-savant',
    name: 'Evocation Savant',
    class: 'wizard',
    level: 3,
    passive: () => ({
      note: 'Evocation Savant: the free Evocation spells go into the spellbook at level-up; copy them with learn_spell.',
    }),
  },
  {
    index: 'evoker-potent-cantrip',
    name: 'Potent Cantrip',
    class: 'wizard',
    level: 3,
    onSaveSucceeded: (ask) =>
      isCantrip(ask.spell)
        ? {
            feature: 'Potent Cantrip',
            take: 'half',
            note: `Potent Cantrip: ${ask.target.name} ${
              ask.missed ? 'was missed' : 'saved'
            } and still takes half the cantrip's damage.`,
          }
        : null,
  },
  {
    index: 'evoker-sculpt-spells',
    name: 'Sculpt Spells',
    class: 'wizard',
    level: 6,
    beforeCast: (ask) => {
      const chosen = ask.options.sculpt ?? [];
      if (chosen.length === 0) return [];
      if (!/evocation/i.test(ask.spell.school)) {
        throw new Error(`Sculpt Spells carves creatures out of an Evocation spell, and ${ask.spell.name} is ${ask.spell.school}.`);
      }
      const allowed = 1 + (ask.spell.slot_level ?? ask.spell.level);
      if (chosen.length > allowed) {
        throw new Error(
          `Sculpt Spells protects 1 + the spell's level creatures: ${allowed} at this level, and ${chosen.length} were named.`,
        );
      }
      return [
        {
          kind: 'auto_success',
          target_ids: chosen,
          feature: 'Sculpt Spells',
          note: `Sculpt Spells: ${chosen.length} creature(s) succeed on the save and take no damage.`,
        },
      ];
    },
  },
  {
    index: 'wizard-spell-mastery',
    name: 'Spell Mastery',
    class: 'wizard',
    level: 18,
    passive: (sheet) => ({
      note: `Spell Mastery: ${
        chosenOptions(sheet, 'Spell Mastery').join(' and ') || 'the level 1 and level 2 spell you chose'
      } are always prepared and cast at their lowest level for no slot - use_action {spell, free_cast: "spell_mastery"}.`,
    }),
  },
  epicBoon('wizard'),
  {
    index: 'wizard-signature-spells',
    name: 'Signature Spells',
    class: 'wizard',
    level: 20,
    resources: (sheet) =>
      chosenOptions(sheet, 'Signature Spells').map((name) => ({
        key: signatureKey(name),
        label: `Signature Spell (${name})`,
        per: 'short' as const,
        max: 1,
      })),
    passive: (sheet) => ({
      note: `Signature Spells: ${
        chosenOptions(sheet, 'Signature Spells').join(' and ') || 'the two level 3 spells you chose'
      } are always prepared, and each is cast once at level 3 with no slot before a rest - use_action {spell, free_cast: "signature_spell"}.`,
    }),
  },
  {
    index: 'evoker-overchannel',
    name: 'Overchannel',
    class: 'wizard',
    level: 14,
    resource: { key: 'overchannel', label: 'Overchannel (uses since a long rest)', per: 'long', max: () => OVERCHANNEL_USES },
    passive: () => ({
      note: `Overchannel: use_action {spell, slot_level, overchannel: true} on a damaging Wizard spell of slot level 1 to 5 deals maximum damage. The first use each long rest is free; every one after it costs you 2d12 Necrotic damage per slot level, and a d12 more per level each time, which no Resistance or Immunity softens.`,
    }),
  },
  {
    index: 'evoker-empowered-evocation',
    name: 'Empowered Evocation',
    class: 'wizard',
    level: 10,
    onSpellDamage: (ask) => {
      if (!/evocation/i.test(ask.spell.school) || !onClassList(ask.spell, 'wizard')) return [];
      const bonus = mod(ask.sheet, 'int');
      if (bonus <= 0) return [];
      return [
        {
          kind: 'damage',
          feature: 'Empowered Evocation',
          dice: String(bonus),
          damage_type: ask.damage_type,
          once_per_cast: true,
          note: `Empowered Evocation: +${bonus} damage from your Intelligence on one damage roll of the spell.`,
        },
      ];
    },
  },
];

/** Every class feature the engine knows, keyed by its SRD index. */
export const FEATURES: Record<string, FeatureHandler> = Object.fromEntries(
  [...BARBARIAN, ...FIGHTER, ...ROGUE, ...MONK, ...PALADIN, ...RANGER, ...BARD, ...CLERIC, ...DRUID, ...SORCERER, ...WARLOCK, ...WIZARD].map(
    (handler) => [handler.index, handler],
  ),
);

// --- the pieces several handlers share ----------------------------------------

export interface HeldFeature {
  handler: FeatureHandler;
  feature: SheetFeature;
}

/** The registry entries this character actually holds, matched by name inside its own class. */
export function heldFeatures(sheet: CombatSheet): HeldFeature[] {
  const out: HeldFeature[] = [];
  // A class may give the same feature twice - Improved Brutal Strike at 13 and at 17 - and the sheet
  // carries a row for each grant, so the second row is matched to the second SRD index of that name.
  const seen = new Map<string, number>();
  for (const feature of sheet.features) {
    const indexes = featureIndexesOf(feature.name, sheet.class_index);
    if (indexes.length === 0) continue;
    const already = seen.get(feature.name.toLowerCase()) ?? 0;
    seen.set(feature.name.toLowerCase(), already + 1);
    const handler = FEATURES[indexes[Math.min(already, indexes.length - 1)]!];
    if (handler && !out.some((held) => held.handler.index === handler.index)) out.push({ handler, feature });
  }
  // Level 19 puts no feature row on the sheet, only the Epic Boon feat; the class handler is held through it.
  const boon = heldBoon(sheet);
  if (boon && sheet.class_index) {
    const handler = FEATURES[`${sheet.class_index}-epic-boon`];
    const row = sheet.features.find((f) => f.name === boon);
    if (handler && row && !out.some((held) => held.handler.index === handler.index)) out.push({ handler, feature: row });
  }
  // Everything the DM invented: its clauses compiled into a handler the registry asks like any other.
  for (const feature of sheet.features) {
    if (!feature.clauses?.length) continue;
    const handler = compileHomebrew(feature, sheet);
    if (handler && !out.some((held) => held.handler.index === handler.index)) out.push({ handler, feature });
  }
  return out;
}

/** Whether this sheet holds a feature, by its SRD index. */
export const hasFeature = (sheet: CombatSheet, index: string): boolean =>
  heldFeatures(sheet).some((held) => held.handler.index === index);

/** Whether the engine has a hook of its own here, however much of the feature its dm_applied note hands over. */
const hasEngineHook = (handler: FeatureHandler): boolean => Object.values(handler).some((value) => typeof value === 'function');

/** The held features the engine may act on: everything but the ones that are nothing but a note to the DM. */
export const liveFeatures = (sheet: CombatSheet): HeldFeature[] =>
  heldFeatures(sheet).filter((held) => !held.handler.dm_applied || hasEngineHook(held.handler));

/** The Fighting Style feat already carries its number on the sheet; this says so where it is read. */
function fightingStylePassive(sheet: CombatSheet): FeaturePassive | null {
  const style = sheet.features.find((f) => f.mechanics?.fighting_style)?.mechanics;
  if (!style) return null;
  if (style.ac_bonus && wearingArmor(sheet)) {
    return { note: `Fighting Style (${style.fighting_style}): +${style.ac_bonus} AC while armoured.` };
  }
  if (style.ranged_attack_bonus) {
    return { note: `Fighting Style (${style.fighting_style}): +${style.ranged_attack_bonus} on ranged weapon attack rolls.` };
  }
  return { note: `Fighting Style: ${style.fighting_style}.` };
}

/** Sneak Attack: once a turn, on a Finesse or ranged hit, with Advantage or an ally crowding the target. */
export function sneakAttackRiders(ask: HitAsk): HitRider[] {
  if (ask.options.sneak_attack === false) return [];
  if (ask.actor.flags.sneak_attack_used) return [];
  if (!sneakAttackWeapon(ask.weapon)) return [];
  const dice = resourceMax(ask.sheet, 'sneak_attack_dice');
  if (dice <= 0) return [];
  const crowded = allyBeside(ask);
  const qualifies = ask.advantage === 'advantage' || (ask.advantage !== 'disadvantage' && crowded !== undefined);
  if (!qualifies) return [];
  const why = ask.advantage === 'advantage' ? 'with Advantage on the roll' : `with ${crowded!.name} crowding the target`;

  // Cunning Strike trades dice away before they are rolled, at the cost each effect lists.
  const chosen = hasFeature(ask.sheet, 'rogue-cunning-strike') ? (ask.options.cunning_strike ?? []) : [];
  const spent: CunningStrikeOption[] = [];
  let paid = 0;
  for (const effect of chosen.slice(0, cunningStrikeCount(ask.sheet))) {
    // Trip's prose holds to a Large or smaller target, so Huge and Gargantuan creatures never pay for it.
    if (effect === 'trip' && (ask.target.size === 'H' || ask.target.size === 'G')) continue;
    const cost = CUNNING_STRIKE_COST[effect];
    if (paid + cost > dice - 1) continue;
    spent.push(effect);
    paid += cost;
  }
  const left = dice - paid;
  const riders: HitRider[] = [
    {
      kind: 'damage',
      feature: 'Sneak Attack',
      dice: `${left}d6`,
      damage_type: ask.damage_type,
      note: `Sneak Attack ${why}: ${left}d6 extra${ask.damage_type ? ` ${ask.damage_type}` : ''} damage${
        paid ? `, ${paid}d6 traded for ${spent.join(' and ')}` : ''
      }.`,
    },
    {
      kind: 'stance',
      feature: 'Sneak Attack',
      on: 'self',
      flags: { sneak_attack_used: true },
      note: 'Sneak Attack is spent for this turn.',
    },
  ];
  const dc = featureDc(ask.sheet, 'dex');
  for (const effect of spent) {
    if (effect === 'poison') {
      riders.push({
        kind: 'save',
        feature: 'Cunning Strike',
        ability: 'con',
        dc,
        condition: 'poisoned',
        ends: 'minute',
        note: `Cunning Strike (Poison): CON save DC ${dc} or Poisoned for 1 minute. It needs a Poisoner's Kit on you.`,
      });
    }
    if (effect === 'trip') {
      riders.push({
        kind: 'save',
        feature: 'Cunning Strike',
        ability: 'dex',
        dc,
        condition: 'prone',
        ends: 'manual',
        note: `Cunning Strike (Trip): DEX save DC ${dc} or Prone; Large and smaller only.`,
      });
    }
    if (effect === 'withdraw') {
      riders.push({
        kind: 'move',
        feature: 'Cunning Strike',
        ft: Math.floor(ask.actor.speed / 2),
        note: 'Cunning Strike (Withdraw): half your Speed without provoking Opportunity Attacks.',
      });
    }
    if (effect === 'daze') {
      riders.push({
        kind: 'note',
        feature: 'Devious Strikes',
        note: `Devious Strikes (Daze, 2d6): CON save DC ${dc} or ${CUNNING_STRIKE_DM_APPLIED.daze}`,
      });
    }
    if (effect === 'obscure') {
      riders.push({
        kind: 'save',
        feature: 'Devious Strikes',
        ability: 'dex',
        dc,
        condition: 'blinded',
        ends: 'end_of_its_next_turn',
        note: `Devious Strikes (Obscure, 3d6): DEX save DC ${dc} or Blinded until the end of its next turn.`,
      });
    }
    if (effect === 'knock_out') {
      riders.push({
        kind: 'save',
        feature: 'Devious Strikes',
        ability: 'con',
        dc,
        condition: 'unconscious',
        ends: 'minute',
        note: `Devious Strikes (Knock Out, 6d6): CON save DC ${dc} or Unconscious for a minute, repeating the save at the end of each of its turns. Any damage ends it too, which is yours to call.`,
      });
    }
  }
  return riders;
}

/** How many Cunning Strike effects may ride on one Sneak Attack: one, and two from level 11. */
export const cunningStrikeCount = (sheet: CombatSheet): number =>
  hasFeature(sheet, 'rogue-improved-cunning-strike') ? 2 : 1;

/** The Cunning Strike effects this Rogue may name, with what each costs in Sneak Attack dice. */
export function cunningStrikeOptions(sheet: CombatSheet): CunningStrikeOption[] {
  const base: CunningStrikeOption[] = ['poison', 'trip', 'withdraw'];
  return hasFeature(sheet, 'rogue-devious-strikes') ? [...base, ...DEVIOUS_STRIKES] : base;
}

// --- what the engine asks the registry ----------------------------------------

/** Every feature action this character has, with the uses it has left. */
export function featureActions(
  sheet: CombatSheet,
): Array<{ handler: FeatureHandler; action: FeatureAction; left: number | null }> {
  const out: Array<{ handler: FeatureHandler; action: FeatureAction; left: number | null }> = [];
  for (const { handler } of liveFeatures(sheet)) {
    for (const action of actionsOf(handler, sheet)) {
      const state = action.cost ? resourceState(sheet, handler) : null;
      out.push({ handler, action, left: state ? state.left : null });
    }
  }
  return out;
}

/** How a resource is labelled, capped and refilled, for the helper that spends it. */
export function resourceSpec(
  sheet: CombatSheet,
  key: string,
): { label: string; max: number; per: ResourcePeriod } | null {
  for (const { handler } of liveFeatures(sheet)) {
    if (handler.resource?.key === key) {
      return { label: handler.resource.label, max: handler.resource.max(sheet), per: handler.resource.per };
    }
    // A feature that counts several resources at once: one Mystic Arcanum of each spell level.
    const many = handler.resources?.(sheet).find((entry) => entry.key === key);
    if (many) return { label: many.label, max: many.max, per: many.per };
  }
  const row = resourceRow(sheet, key);
  if (!row?.mechanics) return null;
  return { label: row.name, max: row.mechanics.max ?? 0, per: row.mechanics.per ?? 'long' };
}

/** The options a feature action carries in its id, e.g. cunning_action_dash. */
const ACTION_OPTIONS: Record<string, string[]> = {
  cunning_action: ['dash', 'disengage', 'hide'],
  lay_on_hands: ['poison', ...RESTORING_TOUCH],
  patient_defense: ['focus'],
  step_of_the_wind: ['focus'],
  fleet_step: ['focus'],
  divine_spark: ['heal', 'radiant', 'necrotic'],
};

/** The handler behind a use_action id, for the character that holds it. */
export function findFeatureAction(
  sheet: CombatSheet,
  id: string,
): { handler: FeatureHandler; action: FeatureAction; option?: string } | null {
  const wanted = id.trim().toLowerCase().replace(/[\s-]+/g, '_');
  for (const entry of featureActions(sheet)) {
    if (entry.action.id === wanted) return { handler: entry.handler, action: entry.action };
    if (!wanted.startsWith(`${entry.action.id}_`)) continue;
    const option = wanted.slice(entry.action.id.length + 1);
    if ((ACTION_OPTIONS[entry.action.id] ?? []).includes(option)) {
      return { handler: entry.handler, action: entry.action, option };
    }
  }
  return null;
}

/** Every feature action id this character could name, for an error that teaches. */
export const featureActionIds = (sheet: CombatSheet): string[] =>
  featureActions(sheet).flatMap((entry) => {
    const options = ACTION_OPTIONS[entry.action.id];
    return options ? [entry.action.id, ...options.map((option) => `${entry.action.id}_${option}`)] : [entry.action.id];
  });

/** A sheet with nothing on it, for asking every handler what its action is called. */
const BLANK_SHEET = {
  level: 1,
  features: [],
  inventory: [],
  abilities: {},
  skills: {},
  conditions: [],
  proficiency_bonus: 2,
  spells: { cantrips: [], known: [], prepared: [], save_dc: null },
} as unknown as CombatSheet;

/** Every action id the registry knows, for refusing one the character has no feature for. */
let knownActionIds: string[] | null = null;
export function allFeatureActionIds(): string[] {
  if (knownActionIds) return knownActionIds;
  knownActionIds = [
    ...new Set(
      Object.values(FEATURES).flatMap((handler) =>
        actionsOf(handler, BLANK_SHEET).flatMap(({ id }) => {
          const options = ACTION_OPTIONS[id];
          return options ? [id, ...options.map((option) => `${id}_${option}`)] : [id];
        }),
      ),
    ),
  ];
  return knownActionIds;
}

/** The lowest natural d20 that is a critical hit here: 20, or 19 with Improved Critical. */
export function critRangeOf(sheet: CombatSheet): number {
  let lowest = 20;
  for (const { handler } of liveFeatures(sheet)) {
    const range = handler.critRange?.(sheet);
    if (range !== undefined && range < lowest) lowest = range;
  }
  return lowest;
}

/** Sacred Weapon: what one use of Channel Divinity puts on the melee weapon it blesses, for 10 minutes. */
export const sacredWeaponBlessing = (
  sheet: CombatSheet,
  weapon: string,
): { weapon: string; bonus: number; rounds_left: number } => ({
  weapon,
  bonus: Math.max(1, mod(sheet, 'cha')),
  rounds_left: TEN_MINUTES_ROUNDS,
});

/** The flat bonus a feature puts on an attack roll: Sacred Weapon, and nothing else yet. */
export function attackBonusOf(sheet: CombatSheet, actor: Combatant, action: StatBlockAction, melee: boolean): number {
  const blessed = actor.flags.sacred_weapon;
  if (!blessed || !melee || !hasFeature(sheet, 'devotion-sacred-weapon')) return 0;
  if (blessed.weapon !== 'the weapon in hand' && !action.name.toLowerCase().includes(blessed.weapon.toLowerCase())) return 0;
  return blessed.bonus;
}

type Ask<T> = Omit<T, 'feature' | 'sheet'>;

/** Advantage and disadvantage the holder's own features put on one attack roll. */
export function attackSources(sheet: CombatSheet, ask: Ask<AttackAsk>): RollSource[] {
  const out: RollSource[] = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    for (const source of handler.beforeAttack?.({ ...ask, sheet, feature }) ?? []) {
      // A source that moves no d20 still names itself in the fight log: Sacred Weapon's flat bonus does.
      if (source.advantage !== 'none' || source.note) out.push(source);
    }
  }
  return out;
}

/** What the target's own features do to an attack roll made against it. */
export function defenceSources(sheet: CombatSheet, actor: Combatant): RollSource[] {
  const out: RollSource[] = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    out.push(...(handler.againstMe?.({ sheet, actor, feature }) ?? []));
  }
  return out;
}

export function saveSources(sheet: CombatSheet, ask: Ask<SaveAsk>): RollSource[] {
  const out: RollSource[] = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    out.push(...(handler.beforeSave?.({ ...ask, sheet, feature }) ?? []));
  }
  return out;
}

export function checkSources(sheet: CombatSheet, ask: Ask<CheckAsk>): RollSource[] {
  const out: RollSource[] = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    out.push(...(handler.beforeCheck?.({ ...ask, sheet, feature }) ?? []));
  }
  return out;
}

/** A stance no one declared: the reroll a homebrew clause arms on every roll it fits. */
export function autoD20Stance(sheet: CombatSheet, kind: 'attack' | 'check' | 'save'): D20Stance | null {
  for (const { handler } of liveFeatures(sheet)) {
    const stance = handler.autoStance?.(sheet, kind);
    if (stance) return stance;
  }
  return null;
}

/** The flat bonuses a feature puts on one ability check: Jack of All Trades, Thaumaturge, Magician. */
export function checkBonuses(sheet: CombatSheet, ask: Ask<CheckAsk>): Array<{ bonus: number; note: string }> {
  const out: Array<{ bonus: number; note: string }> = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    const bonus = handler.checkBonus?.({ ...ask, sheet, feature });
    if (bonus && bonus.bonus !== 0) out.push(bonus);
  }
  return out;
}

/** Everything the caster's features do to a casting before it happens. */
export function castModifiers(sheet: CombatSheet, ask: Ask<CastAsk>): CastModifier[] {
  const out: CastModifier[] = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    out.push(...(handler.beforeCast?.({ ...ask, sheet, feature }) ?? []));
  }
  return out;
}

/** What the caster's features add to the damage of one spell, per target. */
export function spellDamageRiders(sheet: CombatSheet, ask: Ask<SpellDamageAsk>): HitRider[] {
  const out: HitRider[] = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    out.push(...(handler.onSpellDamage?.({ ...ask, sheet, feature }) ?? []));
  }
  return out;
}

/** What the caster's features add to the hit points one spell restores. */
export function healRiders(sheet: CombatSheet, ask: Ask<HealAsk>): HealRider[] {
  const out: HealRider[] = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    out.push(...(handler.onHeal?.({ ...ask, sheet, feature }) ?? []));
  }
  return out;
}

/** What a creature that saved against this caster's spell takes anyway: Potent Cantrip. */
export function saveMitigation(sheet: CombatSheet, ask: Ask<SaveSucceededAsk>): DamageMitigation | null {
  for (const { handler, feature } of liveFeatures(sheet)) {
    const taken = handler.onSaveSucceeded?.({ ...ask, sheet, feature });
    if (taken) return taken;
  }
  return null;
}

export function saveSucceededOutcomes(sheet: CombatSheet, ask: Ask<SaveSucceededAsk>): FeatureOutcome[] {
  const out: FeatureOutcome[] = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    const outcome = handler.onSaveSucceededOutcome?.({ ...ask, sheet, feature });
    if (outcome) out.push({ feature: handler.name, ...outcome });
  }
  return out;
}

/** What dropping a creature to 0 hit points hands the features of whoever is standing nearby. */
export function killOutcomes(sheet: CombatSheet, ask: Ask<KillAsk>): FeatureOutcome[] {
  const out: FeatureOutcome[] = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    const outcome = handler.onKill?.({ ...ask, sheet, feature });
    if (outcome) out.push({ feature: handler.name, ...outcome });
  }
  return out;
}

/** The damage types a running feature resists, off the passive hook: Elemental Affinity and its like. */
export function featureResistances(sheet: CombatSheet): string[] {
  const out: string[] = [];
  for (const { handler } of liveFeatures(sheet)) {
    for (const type of handler.passive?.(sheet)?.resistances ?? []) {
      if (!out.includes(type)) out.push(type);
    }
  }
  return out;
}

/** The conditions a feature keeps off its holder, off the passive hook: Nature's Ward and its like. */
export function featureConditionImmunities(sheet: CombatSheet): string[] {
  const out: string[] = [];
  for (const { handler } of liveFeatures(sheet)) {
    // A Rage's immunities only exist while it runs, and ragingConditionImmunities owns those.
    if (handler.index === 'berserker-mindless-rage') continue;
    for (const condition of handler.passive?.(sheet)?.condition_immunities ?? []) {
      if (!out.includes(condition)) out.push(condition);
    }
  }
  return out;
}

/** Everything the holder's features add to a hit, in registry order. */
export function hitRiders(sheet: CombatSheet, ask: Ask<HitAsk>): HitRider[] {
  const out: HitRider[] = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    out.push(...(handler.onHit?.({ ...ask, sheet, feature }) ?? []));
  }
  return out;
}

/** What a miss still leaves behind; nothing martial uses it yet, and R4b will. */
export function missRiders(sheet: CombatSheet, ask: Ask<HitAsk>): HitRider[] {
  const out: HitRider[] = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    out.push(...(handler.onMiss?.({ ...ask, sheet, feature }) ?? []));
  }
  return out;
}

/** The reactions a hit on this character offers, for reactions_available in the attack result. */
export function reactionOffers(sheet: CombatSheet, ask: Ask<DamageTakenAsk>): ReactionOffer[] {
  const out: ReactionOffer[] = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    const offer = handler.onDamageTaken?.({ ...ask, sheet, feature });
    if (offer) out.push(offer);
  }
  return out;
}

export function damageTakenOutcomes(sheet: CombatSheet, ask: Ask<DamageTakenAsk>): FeatureOutcome[] {
  const out: FeatureOutcome[] = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    const outcome = handler.onDamageTakenOutcome?.({ ...ask, sheet, feature });
    if (outcome) out.push({ feature: handler.name, ...outcome });
  }
  return out;
}

/** What rolling Initiative hands this character back: Perfect Focus, Superior Inspiration, Archdruid. */
export function initiativeOutcomes(sheet: CombatSheet, actor: Combatant): FeatureOutcome[] {
  const out: FeatureOutcome[] = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    const outcome = handler.onInitiative?.({ sheet, actor, feature });
    if (outcome) out.push({ feature: handler.name, ...outcome });
  }
  return out;
}

/** Elusive: no attack roll against this character has Advantage while it is not Incapacitated. */
export const deniesAdvantage = (sheet: CombatSheet, actor: Combatant): boolean =>
  hasFeature(sheet, 'rogue-elusive') && !INCAPACITATING.some((c) => actor.conditions.includes(c));

/** The SRD damage types, for the features that resist all but one of them. */
const ALL_DAMAGE_TYPES = [
  'acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic',
  'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder',
];

/** What a running feature makes this creature resist right now: Superior Defense, Hunter's Defense. */
export function flagResistances(sheet: CombatSheet, actor: Combatant): string[] {
  const out: string[] = [];
  if (actor.flags.superior_defense && hasFeature(sheet, 'monk-superior-defense')) {
    out.push(...ALL_DAMAGE_TYPES.filter((type) => type !== 'force'));
  }
  const resisting = actor.flags.resisting;
  if (resisting && hasFeature(sheet, 'hunter-superior-hunters-defense') && !out.includes(resisting.type)) {
    out.push(resisting.type);
  }
  return out;
}

/** Hunter's Mark: a d6, and a d10 once Foe Slayer has had its say. */
export const huntersMarkDie = (sheet: CombatSheet): number => (hasFeature(sheet, 'ranger-foe-slayer') ? 10 : 6);

/**
 * Persistent Rage: the expended Rages on offer when this Barbarian rolls Initiative, or 0 when there is
 * nothing to give back or the use a long rest is gone. The offer is never taken for them.
 */
export function persistentRageOffer(sheet: CombatSheet): number {
  if (!hasFeature(sheet, 'barbarian-persistent-rage') || leftOf(sheet, 'persistent_rage') <= 0) return 0;
  return spentOf(sheet, 'rage');
}

/** The resource row that tallies Relentless Rage's uses; the count resets on a short or a long rest. */
export const RELENTLESS_RAGE_USES = { resource: 'relentless_rage', label: 'Relentless Rage', per: 'short' as const };

/**
 * Relentless Rage: the DC of the save that keeps a raging Barbarian on their feet, 5 higher for each use
 * since the last rest - which is why the count lives on the sheet rather than on the fight.
 */
export const relentlessRageDc = (sheet: CombatSheet): number =>
  10 + 5 * (resourceRow(sheet, RELENTLESS_RAGE_USES.resource)?.mechanics?.used ?? 0);

/** Supreme Healing: every healing die counts as its highest face instead of being rolled. */
export const maximisesHealing = (sheet: CombatSheet): boolean => hasFeature(sheet, 'life-supreme-healing');

/** The turn-boundary upkeep of every feature this character holds. */
export function turnOutcomes(sheet: CombatSheet, actor: Combatant, when: 'start' | 'end'): FeatureOutcome[] {
  const out: FeatureOutcome[] = [];
  for (const { handler, feature } of liveFeatures(sheet)) {
    const outcome =
      when === 'start' ? handler.turnStart?.({ sheet, actor, feature }) : handler.turnEnd?.({ sheet, actor, feature });
    if (outcome) out.push({ feature: handler.name, ...outcome });
  }
  return out;
}

/** Rage's damage resistances, which only exist while the Rage is running. */
export function ragingResistances(sheet: CombatSheet, actor: Combatant): string[] {
  if (!isRaging(actor) || !hasFeature(sheet, 'barbarian-rage')) return [];
  return ['bludgeoning', 'piercing', 'slashing'];
}

/** The conditions a running Rage keeps off a Berserker. */
export function ragingConditionImmunities(sheet: CombatSheet, actor: Combatant): string[] {
  if (!isRaging(actor) || !hasFeature(sheet, 'berserker-mindless-rage')) return [];
  return ['charmed', 'frightened'];
}

/** One paladin's aura, as the engine hands it to the helpers below. */
export interface AuraSource {
  actor: Combatant;
  sheet: CombatSheet;
}

/** Aura of Protection: the best bonus a paladin within 10 ft lends to this creature's saving throws. */
export function auraSaveBonus(roller: Combatant, auras: AuraSource[]): { bonus: number; note: string } | null {
  let best: { bonus: number; note: string } | null = null;
  for (const aura of auras) {
    if (!hasFeature(aura.sheet, 'paladin-aura-of-protection')) continue;
    if (aura.actor.team !== roller.team) continue;
    if (INCAPACITATING.some((c) => aura.actor.conditions.includes(c))) continue;
    if (distanceBetween(aura.actor, roller) > auraFt(aura.sheet)) continue;
    const bonus = Math.max(1, mod(aura.sheet, 'cha'));
    if (!best || bonus > best.bonus) {
      best = { bonus, note: `Aura of Protection from ${aura.actor.name}: +${bonus}` };
    }
  }
  return best;
}

/** Aura of Devotion and Aura of Courage: the conditions an aura keeps off a creature standing inside it. */
export function auraConditionImmunities(target: Combatant, auras: AuraSource[]): string[] {
  const out: string[] = [];
  for (const aura of auras) {
    if (aura.actor.team !== target.team) continue;
    if (INCAPACITATING.some((c) => aura.actor.conditions.includes(c))) continue;
    if (distanceBetween(aura.actor, target) > auraFt(aura.sheet)) continue;
    if (hasFeature(aura.sheet, 'devotion-aura-of-devotion') && !out.includes('charmed')) out.push('charmed');
    if (hasFeature(aura.sheet, 'paladin-aura-of-courage') && !out.includes('frightened')) out.push('frightened');
  }
  return out;
}

/** Smite of Protection: the Half Cover a paladin's aura lends whoever stands in it after a Divine Smite. */
export function auraHalfCover(target: Combatant, auras: AuraSource[]): string | null {
  for (const aura of auras) {
    if (!aura.actor.flags.smite_protection || aura.actor.team !== target.team) continue;
    if (!hasFeature(aura.sheet, 'devotion-smite-of-protection')) continue;
    if (distanceBetween(aura.actor, target) > auraFt(aura.sheet)) continue;
    return `Smite of Protection: Half Cover inside ${aura.actor.name}'s aura`;
  }
  return null;
}

/** Holy Nimbus: the Radiant damage an enemy takes for starting its turn in the aura, and who deals it. */
export function holyNimbusDamage(target: Combatant, auras: AuraSource[]): { from: Combatant; amount: number } | null {
  for (const aura of auras) {
    if (!aura.actor.flags.holy_nimbus || aura.actor.team === target.team) continue;
    if (!hasFeature(aura.sheet, 'devotion-holy-nimbus')) continue;
    if (distanceBetween(aura.actor, target) > auraFt(aura.sheet)) continue;
    return { from: aura.actor, amount: Math.max(0, mod(aura.sheet, 'cha')) + aura.sheet.proficiency_bonus };
  }
  return null;
}

/** Evasion: a successful DEX save for half takes no damage at all, and a failed one takes half. */
export const hasEvasion = (sheet: CombatSheet): boolean =>
  (hasFeature(sheet, 'rogue-evasion') || hasFeature(sheet, 'monk-evasion')) &&
  !INCAPACITATING.some((c) => sheet.conditions.includes(c));

/** Reliable Talent: a d20 of 9 or lower counts as a 10 on a check the character is proficient in. */
export const hasReliableTalent = (sheet: CombatSheet): boolean => hasFeature(sheet, 'rogue-reliable-talent');

/** What the window shows beside the sheet: every class feature, its uses left and whether it is running. */
export interface ClassFeatureView {
  index: string;
  name: string;
  uses_left?: number;
  uses_max?: number;
  active?: boolean;
  /** The stance this feature has armed and not yet spent, which outlives the turn it was declared on. */
  stance_mode?: D20Stance['mode'];
  dm_applied?: string;
}

export function classFeatures(sheet: CombatSheet, actor?: Combatant): ClassFeatureView[] {
  const stance = actor?.flags.d20_stance;
  return heldFeatures(sheet).map(({ handler }) => {
    const state = resourceState(sheet, handler);
    // A declared Indomitable or Boon of Fate waits for the roll it was bought for, however many turns away.
    const armed =
      stance !== undefined &&
      (stance.feature.toLowerCase() === handler.name.toLowerCase() ||
        actionsOf(handler, sheet).some((action) => action.name.toLowerCase() === stance.feature.toLowerCase()));
    const active = armed
      ? true
      : handler.index === 'barbarian-rage' && actor
        ? isRaging(actor)
        : handler.index === 'devotion-sacred-weapon' && actor
          ? actor.flags.sacred_weapon !== undefined
          : handler.index === 'druid-wild-shape' && actor
            ? isWildShaped(actor)
            : handler.index === 'sorcerer-innate-sorcery' && actor
              ? innateSorcery(actor)
              : undefined;
    return {
      index: handler.index,
      name: handler.name,
      ...(state && state.max > 0 ? { uses_left: state.left, uses_max: state.max } : {}),
      ...(active === undefined ? {} : { active }),
      ...(armed ? { stance_mode: stance.mode } : {}),
      ...(handler.dm_applied ? { dm_applied: handler.dm_applied } : {}),
    };
  });
}
