// What a combatant can do: attacks from the stat block or the sheet's weapons, and the standard actions.
import { findEquipment } from '../srd/lookup.js';
import type { EquipmentData, StatBlockAction } from '../srd/data.js';
import { abilityMod, type Ability } from '../core/rules.js';
import { activeItemBonus, slotsLeft } from '../core/character.js';
import { isIncapacitated, rulesOf, speedZeroBy } from './conditions.js';
import {
  checkBonuses,
  featureActions,
  hasFeature,
  hasInvocation,
  isMonkWeapon,
  monkStance,
  resourceMax,
  type FeatureActionKind,
} from './features.js';
import { attacksPerAction, sheetAbilityMod, type CombatSheet } from './sheet.js';
import type { Combatant } from './state.js';

export interface LegalAction {
  id: string;
  label: string;
  hint: string;
}

interface WeaponRange {
  range_ft: number;
  long_range_ft: number;
}

/** The 2024 normal and long ranges of the ranged weapons, by name; anything unlisted uses 80/320 ft. */
const RANGES: Record<string, WeaponRange> = {
  blowgun: { range_ft: 25, long_range_ft: 100 },
  dart: { range_ft: 20, long_range_ft: 60 },
  sling: { range_ft: 30, long_range_ft: 120 },
  shortbow: { range_ft: 80, long_range_ft: 320 },
  'light crossbow': { range_ft: 80, long_range_ft: 320 },
  'hand crossbow': { range_ft: 30, long_range_ft: 120 },
  'heavy crossbow': { range_ft: 100, long_range_ft: 400 },
  longbow: { range_ft: 150, long_range_ft: 600 },
  musket: { range_ft: 40, long_range_ft: 120 },
  pistol: { range_ft: 30, long_range_ft: 90 },
};

/** The range a thrown melee weapon flies, by name. */
const THROWN_RANGES: Record<string, WeaponRange> = {
  dagger: { range_ft: 20, long_range_ft: 60 },
  handaxe: { range_ft: 20, long_range_ft: 60 },
  javelin: { range_ft: 30, long_range_ft: 120 },
  'light hammer': { range_ft: 20, long_range_ft: 60 },
  spear: { range_ft: 20, long_range_ft: 60 },
  trident: { range_ft: 20, long_range_ft: 60 },
};

/** Weapons with the reach property strike 10 ft away instead of 5. */
const REACH_WEAPONS = ['glaive', 'halberd', 'lance', 'pike', 'whip'];

const DEFAULT_RANGE = { range_ft: 80, long_range_ft: 320 };

const MELEE_REACH_FT = 5;
const REACH_WEAPON_FT = 10;

/** Lower case, singular: how weapon and armour proficiency names are compared. */
const normalize = (value: string): string => value.trim().toLowerCase().replace(/s$/, '');

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

/** Every attack or action available to this combatant, whether it comes from a stat block or a sheet. */
export function actionsFor(combatant: Combatant, sheet: CombatSheet | null): StatBlockAction[] {
  if (combatant.stat_block) {
    const block = combatant.stat_block;
    return [...block.actions, ...block.bonus_actions, ...block.reactions, ...block.legendary_actions];
  }
  if (!sheet) return [unarmedStrike(null, 0)];
  const fromStatBlock = statBlockSheetActions(sheet);
  return fromStatBlock.length > 0 ? fromStatBlock : sheetActions(sheet);
}

/** A stat-block companion (a wolf, a mastiff) keeps its creature's actions as sheet features. */
function statBlockSheetActions(sheet: CombatSheet): StatBlockAction[] {
  const actions: StatBlockAction[] = [];
  for (const feature of sheet.features) {
    const mechanics = feature.mechanics;
    if (feature.source !== 'stat_block' || !mechanics?.kind) continue;
    actions.push({
      name: feature.name,
      kind: mechanics.kind as StatBlockAction['kind'],
      ...(mechanics.attack_bonus === undefined ? {} : { attack_bonus: mechanics.attack_bonus }),
      ...(mechanics.reach_ft === undefined ? {} : { reach_ft: mechanics.reach_ft }),
      ...(mechanics.range_ft === undefined ? {} : { range_ft: mechanics.range_ft }),
      ...(mechanics.long_range_ft === undefined ? {} : { long_range_ft: mechanics.long_range_ft }),
      ...(mechanics.damage === undefined ? {} : { damage: mechanics.damage }),
      ...(mechanics.uses === undefined ? {} : { uses: mechanics.uses }),
      text: feature.text ?? feature.name,
    });
  }
  return actions;
}

export function findAction(combatant: Combatant, sheet: CombatSheet | null, name: string): StatBlockAction {
  const wanted = name.trim().toLowerCase();
  const all = actionsFor(combatant, sheet);
  const found = all.find((a) => a.name.toLowerCase() === wanted) ?? all.find((a) => a.name.toLowerCase().includes(wanted));
  if (!found) {
    throw new Error(`${combatant.name} has no action called "${name}". Available: ${all.map((a) => a.name).join(', ')}.`);
  }
  return found;
}

export const isAttack = (action: StatBlockAction): boolean =>
  action.kind === 'melee_weapon_attack' || action.kind === 'ranged_weapon_attack';

/**
 * 2024: the proficiency bonus rides on a weapon attack only when the sheet covers that weapon, by its
 * category ("Martial Weapons") or by its own name, in either case and either number.
 */
export function weaponProficient(sheet: CombatSheet, equipment: EquipmentData): boolean {
  const known = sheet.proficiencies.weapons.map(normalize);
  const wanted = [normalize(equipment.name)];
  for (const category of equipment.equipment_categories) {
    if (category.index === 'simple-weapons') wanted.push(normalize('Simple Weapons'));
    if (category.index === 'martial-weapons') wanted.push(normalize('Martial Weapons'));
  }
  return known.some((p) => wanted.includes(p));
}

/** The weapon an attack was built from, so its range and proficiency can be read back off the name. */
export const weaponOfAction = (name: string): EquipmentData | undefined =>
  findEquipment(name.replace(/ \(thrown\)$/i, ''));

export const hasProperty = (equipment: EquipmentData | undefined, index: string): boolean =>
  equipment?.properties?.some((p) => p.index === index) ?? false;

/** A shield in hand rules out the two-handed grip a versatile weapon wants. */
export const shieldEquipped = (sheet: CombatSheet): boolean =>
  sheet.inventory.some((item) => item.equipped && findEquipment(item.name)?.index === 'shield');

const twoHandedDie = (equipment: EquipmentData): string | undefined => equipment.two_handed_damage?.damage_dice;

/**
 * The damage a versatile weapon does in the grip the attacker asked for; undefined when the weapon is
 * not versatile or the grip is the one the action was already built with.
 */
export function gripDamage(
  action: StatBlockAction,
  equipment: EquipmentData | undefined,
  grip: 'one_hand' | 'two_hands' | undefined,
): StatBlockAction['damage'] | undefined {
  const first = action.damage?.[0];
  if (!grip || !equipment || !first || !hasProperty(equipment, 'versatile')) return undefined;
  const wanted = grip === 'one_hand' ? equipment.damage?.damage_dice : twoHandedDie(equipment);
  if (!wanted) return undefined;
  return [{ ...first, dice: first.dice.replace(/^\d*d\d+/, wanted) }, ...action.damage!.slice(1)];
}

/**
 * The ability a weapon attack uses: DEX at range, the better of STR and DEX for Finesse and for a Monk's
 * own weapons, else STR. Rage and Reckless Attack key off which one it turns out to be.
 */
export function weaponAbility(sheet: CombatSheet, equipment: EquipmentData | undefined): Ability {
  const str = sheetAbilityMod(sheet, 'str');
  const dex = sheetAbilityMod(sheet, 'dex');
  const better = (): Ability => (dex > str ? 'dex' : 'str');
  // Pact of the Blade: a bonded Melee weapon may be swung with Charisma instead of Strength or Dexterity.
  if (equipment && isPactWeapon(sheet, equipment) && sheetAbilityMod(sheet, 'cha') > Math.max(str, dex)) return 'cha';
  if (equipment?.equipment_categories.some((c) => c.index === 'ranged-weapons')) return 'dex';
  // Martial Arts: Dexterous Attacks covers Unarmed Strikes and Monk weapons, out of armour and shieldless.
  if (martialArts(sheet) && isMonkWeapon(equipment)) return better();
  return equipment && hasProperty(equipment, 'finesse') ? better() : 'str';
}

/** A weapon Pact of the Blade may have bonded: a Simple or Martial Melee weapon, in a warlock's hand. */
function isPactWeapon(sheet: CombatSheet, equipment: EquipmentData): boolean {
  if (!hasInvocation(sheet, 'Pact of the Blade')) return false;
  const categories = equipment.equipment_categories.map((c) => c.index);
  if (categories.includes('ranged-weapons')) return false;
  return categories.includes('simple-weapons') || categories.includes('martial-weapons');
}

export const weaponAbilityMod = (sheet: CombatSheet, equipment: EquipmentData): number =>
  sheetAbilityMod(sheet, weaponAbility(sheet, equipment));

/** Whether Martial Arts is doing anything right now: the Monk has it and is in the stance it needs. */
export const martialArts = (sheet: CombatSheet): boolean =>
  hasFeature(sheet, 'monk-martial-arts') && monkStance(sheet);

/** The Martial Arts die, as a dice expression, or null when the character has no Martial Arts running. */
export const martialArtsDie = (sheet: CombatSheet): string | null => {
  if (!martialArts(sheet)) return null;
  const faces = resourceMax(sheet, 'martial_arts_die');
  return faces > 0 ? `1d${faces}` : null;
};

/** Weapon attacks built from the sheet's inventory: STR, or DEX for ranged and finesse, plus proficiency. */
export function sheetActions(sheet: CombatSheet): StatBlockAction[] {
  const str = sheetAbilityMod(sheet, 'str');
  const actions: StatBlockAction[] = [];
  for (const item of sheet.inventory) {
    const equipment = findEquipment(item.name);
    if (!equipment?.damage || !equipment.equipment_categories.some((c) => c.index === 'weapons')) continue;
    const ranged = equipment.equipment_categories.some((c) => c.index === 'ranged-weapons');
    const reach =
      (equipment.properties?.some((p) => p.index === 'reach') ?? false) || REACH_WEAPONS.includes(normalize(equipment.name));
    const mod = weaponAbilityMod(sheet, equipment);
    // A magic weapon adds its +N to the attack and the damage, once it is in hand and attuned.
    const magic = activeItemBonus(item);
    // Archery: the Fighting Style feat's +2 rides on every ranged weapon attack roll.
    const style = ranged ? archeryBonus(sheet) : 0;
    const bonus = mod + (weaponProficient(sheet, equipment) ? sheet.proficiency_bonus : 0) + magic + style;
    const type = equipment.damage.damage_type.name.toLowerCase();
    // Versatile: with no shield in the other hand the weapon is swung two-handed, for the bigger die.
    const twoHanded = equipment.two_handed_damage;
    const weaponDie =
      twoHanded && hasProperty(equipment, 'versatile') && !shieldEquipped(sheet)
        ? twoHanded.damage_dice
        : equipment.damage.damage_dice;
    // Martial Arts: a Monk may roll their own die in place of a Monk weapon's, when it is the better one.
    const die = betterDie(weaponDie, isMonkWeapon(equipment) ? martialArtsDie(sheet) : null);
    const damageMod = mod + magic;
    const dice = `${die}${damageMod === 0 ? '' : signed(damageMod)}`;
    const label = magic > 0 ? item.name : equipment.name;
    const source = magic > 0 ? ` (+${magic} of it from ${item.name})` : '';
    actions.push({
      name: label,
      kind: ranged ? 'ranged_weapon_attack' : 'melee_weapon_attack',
      attack_bonus: bonus,
      ...(ranged
        ? (RANGES[normalize(equipment.name)] ?? DEFAULT_RANGE)
        : { reach_ft: reach ? REACH_WEAPON_FT : MELEE_REACH_FT }),
      damage: [{ dice, type }],
      text: `${label}: ${signed(bonus)} to hit, ${dice} ${type} damage${source}.`,
    });
    // A thrown melee weapon is a ranged attack too, at the range the 2024 table gives it.
    const flight = THROWN_RANGES[normalize(equipment.name)];
    if (!ranged && flight && (equipment.properties?.some((p) => p.index === 'thrown') ?? false)) {
      actions.push({
        name: `${label} (thrown)`,
        kind: 'ranged_weapon_attack',
        attack_bonus: bonus,
        ...flight,
        damage: [{ dice, type }],
        text: `${label} thrown: ${signed(bonus)} to hit, ${dice} ${type} damage, range ${flight.range_ft}/${flight.long_range_ft} ft${source}.`,
      });
    }
  }
  actions.push(unarmedStrike(sheet, str));
  // Martial Arts: one Unarmed Strike a turn is a Bonus Action, so it is listed as one of its own.
  if (martialArts(sheet)) {
    const bonusStrike = unarmedStrike(sheet, str);
    actions.push({
      ...bonusStrike,
      name: 'Unarmed Strike (Bonus Action)',
      kind: 'bonus_action',
      text: `${bonusStrike.text} Martial Arts makes this one a Bonus Action.`,
    });
  }
  return actions;
}

/** The bigger of two damage dice expressions, so a Monk never rolls down to a weapon's smaller die. */
function betterDie(weapon: string, monk: string | null): string {
  if (!monk) return weapon;
  const faces = (expr: string): number => Number(/d(\d+)/.exec(expr)?.[1] ?? 0);
  return faces(monk) > faces(weapon) ? monk : weapon;
}

/** The Archery Fighting Style's bonus to ranged weapon attack rolls, or 0 without it. */
const archeryBonus = (sheet: CombatSheet): number =>
  sheet.features.reduce((sum, f) => sum + (f.mechanics?.ranged_attack_bonus ?? 0), 0);

/**
 * 1 plus the Strength modifier, never less than 1, and always proficient. A Monk with Martial Arts rolls
 * their own die instead and may swing it with Dexterity.
 */
function unarmedStrike(sheet: CombatSheet | null, strMod: number): StatBlockAction {
  const proficiency = sheet?.proficiency_bonus ?? 0;
  const die = sheet ? martialArtsDie(sheet) : null;
  const mod = sheet && die ? sheetAbilityMod(sheet, weaponAbility(sheet, undefined)) : strMod;
  const dice = die ? `${die}${mod === 0 ? '' : signed(mod)}` : `${Math.max(1, 1 + mod)}`;
  return {
    name: 'Unarmed Strike',
    kind: 'melee_weapon_attack',
    attack_bonus: mod + proficiency,
    reach_ft: 5,
    damage: [{ dice, type: 'bludgeoning' }],
    text: `Unarmed strike: ${signed(mod + proficiency)} to hit, ${dice} bludgeoning damage.`,
  };
}

/** The standard actions, by the id use_action takes; grapple and shove need a target_id. */
export const STANDARD_ACTIONS: Record<string, { label: string; hint: string }> = {
  dash: { label: 'Dash', hint: 'Adds your speed to the movement left this turn.' },
  disengage: { label: 'Disengage', hint: 'Leaving reach draws no opportunity attack for the rest of your turn.' },
  dodge: { label: 'Dodge', hint: 'Attacks against you have disadvantage and your DEX saves advantage until your next turn.' },
  help: { label: 'Help', hint: 'Pass target_id (the ally) and ally_target_id for the enemy they attack: advantage on their next attack, or on their next check without it.' },
  hide: { label: 'Hide', hint: 'DC 15 Stealth check from cover or out of sight; success leaves you Invisible until you attack, cast or make noise.' },
  ready: { label: 'Ready', hint: 'Pass trigger and readied_action; release it out of turn with out_of_turn true, which spends your reaction.' },
  utilize: { label: 'Utilize', hint: 'Use an object: door, lever, potion, rope.' },
  grapple: { label: 'Grapple', hint: 'Unarmed Strike option: target_id within reach saves (STR or DEX, its choice) or is Grappled.' },
  shove: { label: 'Shove', hint: 'Unarmed Strike option: target_id saves or is pushed 5 ft or knocked Prone; pass shove_prone true to knock down.' },
  stand: { label: 'Stand up', hint: 'Ends Prone for half your speed in movement.' },
  escape_grapple: { label: 'Escape the grapple', hint: 'STR (Athletics) or DEX (Acrobatics) check against the grappler DC.' },
};

/** The "what can I do this turn" list for the active combatant, data-driven from its sheet or stat block. */
export function legalActions(combatant: Combatant, sheet: CombatSheet | null): LegalAction[] {
  if (!combatant.alive) return [];
  if (combatant.hp_current === 0) {
    return combatant.kind === 'monster'
      ? []
      : [
          {
            id: 'death_save',
            label: 'Death saving throw',
            hint: `Rolled automatically at the start of ${combatant.name}'s turn (${combatant.death_saves.successes} successes, ${combatant.death_saves.failures} failures).`,
          },
        ];
  }

  // Incapacitated and its supersets end the turn before it starts: no action, bonus action or reaction.
  if (isIncapacitated(combatant.conditions)) {
    const why = combatant.conditions.filter((c) => rulesOf([c]).some((r) => r.incapacitated));
    return [
      {
        id: 'incapacitated',
        label: `No actions while ${why.join(' and ')}`,
        hint: `${combatant.name} takes no action, bonus action or reaction. ${rulesOf(why).map((r) => r.summary).join(' ')}`,
      },
    ];
  }

  const list: LegalAction[] = [];
  const stuck = speedZeroBy(combatant.conditions);
  if (stuck.length === 0) {
    list.push({
      id: 'move',
      label: `Move (${combatant.movement_left} ft left)`,
      hint: 'move_token with to {x,y} or toward a combatant id; difficult terrain costs double.',
    });
    if (combatant.conditions.includes('prone')) {
      list.push({
        id: 'stand',
        label: 'Stand up',
        hint: `Ends Prone for ${Math.ceil(combatant.speed / 2)} ft of movement; use_action with action_name "stand".`,
      });
    }
  } else {
    list.push({
      id: 'no_move',
      label: `Cannot move (${stuck.join(', ')})`,
      hint: `${combatant.name} has speed 0 while ${stuck.join(' and ')}.`,
    });
  }
  if (combatant.flags.grappled_by !== undefined) {
    list.push({
      id: 'escape_grapple',
      label: STANDARD_ACTIONS.escape_grapple!.label,
      hint: `${STANDARD_ACTIONS.escape_grapple!.hint} Costs the action; use_action with action_name "escape_grapple".`,
    });
  }

  const actions = actionsFor(combatant, sheet);
  const attacks = actions.filter(isAttack);
  // Extra Attack: the Attack action swings more than once, so the label says how many.
  const swings = sheet ? attacksPerAction(sheet) : 1;
  if (!combatant.action_used) {
    for (const action of attacks) {
      const weapon = sheet ? weaponOfAction(action.name) : undefined;
      const unskilled = weapon && sheet && !weaponProficient(sheet, weapon) ? ' Not proficient: no proficiency bonus.' : '';
      const versatile =
        weapon && sheet && hasProperty(weapon, 'versatile') && !shieldEquipped(sheet)
          ? ` Versatile: swung two-handed here, attack {grip: "one_hand"} for ${weapon.damage?.damage_dice ?? 'the smaller die'}.`
          : '';
      list.push({
        id: `attack:${action.name}`,
        label: `Attack: ${action.name}${swings > 1 ? ` ×${swings}` : ''}`,
        hint: `${signed(action.attack_bonus ?? 0)} to hit, ${(action.damage ?? [])
          .map((d) => `${d.dice} ${d.type ?? ''}`.trim())
          .join(' plus ')}, ${action.reach_ft ? `reach ${action.reach_ft} ft` : `range ${action.range_ft ?? 0}/${action.long_range_ft ?? 0} ft`}.${
          swings > 1 ? ` Extra Attack: ${swings} attacks with one Attack action.` : ''
        }${unskilled}${versatile}`,
      });
    }
    for (const action of actions.filter((a) => a.kind === 'action' && !isAttack(a))) {
      list.push({ id: `action:${action.name}`, label: action.name, hint: action.text.slice(0, 160) });
    }
    if (sheet?.armor_penalty.penalty) {
      list.push({
        id: 'no_spells',
        label: 'No spellcasting',
        hint: `${combatant.name} is ${sheet.armor_penalty.reason}.`,
      });
    } else {
      for (const spell of castableSpells(sheet)) list.push(spell);
    }
    for (const [id, standard] of Object.entries(STANDARD_ACTIONS)) {
      if (id === 'stand' || id === 'escape_grapple') continue;
      const hint = id === 'dash' ? `Adds ${combatant.speed} ft to the movement left this turn.` : standard.hint;
      list.push({ id, label: standard.label, hint: `${hint} use_action with action_name "${id}".` });
    }
    list.push(...classFeatureActions(sheet, ['action', 'free']));
  }

  if (!combatant.bonus_used) {
    for (const action of actions.filter((a) => a.kind === 'bonus_action')) {
      list.push({ id: `bonus:${action.name}`, label: `Bonus action: ${action.name}`, hint: action.text.slice(0, 160) });
    }
    list.push(...classFeatureActions(sheet, ['bonus_action']));
  }
  if (!combatant.reaction_used) {
    for (const action of actions.filter((a) => a.kind === 'reaction')) {
      list.push({ id: `reaction:${action.name}`, label: `Reaction: ${action.name}`, hint: action.text.slice(0, 160) });
    }
    list.push(...classFeatureActions(sheet, ['reaction']));
    if (combatant.flags.ready) {
      list.push({
        id: 'release_ready',
        label: `Readied: ${combatant.flags.ready.action}`,
        hint: `Triggers on "${combatant.flags.ready.trigger}"; resolve it out of turn, which spends the reaction.`,
      });
    }
  }
  return list;
}

/**
 * The class features of these action kinds that are still takeable, as the "what can I do" list. A
 * feature whose uses are gone stays on it when something else buys it back: Intimidating Presence for a
 * use of Rage, Holy Nimbus for a level 5 spell slot.
 */
function classFeatureActions(sheet: CombatSheet | null, kinds: FeatureActionKind[]): LegalAction[] {
  if (!sheet) return [];
  const out: LegalAction[] = [];
  for (const { action, left } of featureActions(sheet)) {
    if (!kinds.includes(action.kind)) continue;
    const spent = left !== null && left <= 0;
    const fallback = spent && action.fallback?.affordable ? action.fallback : null;
    if (spent && !fallback) continue;
    const label =
      action.kind === 'bonus_action'
        ? `Bonus action: ${action.name}`
        : action.kind === 'reaction'
          ? `Reaction: ${action.name}`
          : action.kind === 'free'
            ? `${action.name} (no action)`
            : action.name;
    out.push({
      id: `feature:${action.id}`,
      label: `${label}${left === null ? '' : ` (${left} left)`}`,
      hint: `${action.hint}${fallback ? ` No uses left: this one costs ${fallback.label}.` : ''} use_action with action_name "${action.id}".`,
    });
  }
  return out;
}

/** Cantrips are always castable; a levelled spell needs a slot of any level with a use left. */
function castableSpells(sheet: CombatSheet | null): LegalAction[] {
  if (!sheet) return [];
  // A slot Font of Magic or Wild Resurgence wove out of nothing counts too, which is what slotsLeft adds.
  const open = Object.entries(sheet.spell_slots)
    .filter(([, slot]) => slotsLeft(slot) > 0)
    .map(([level, slot]) => `level ${level} (${slotsLeft(slot)} left)`);
  const spells: LegalAction[] = [];
  const seen = new Set<string>();
  for (const name of sheet.spells.cantrips) {
    const id = `cast:${name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    spells.push({
      id,
      label: `Cast ${name}`,
      hint: `Cantrip${sheet.spells.save_dc ? `, save DC ${sheet.spells.save_dc}` : ''}, no slot. Cast with use_action {spell: "${name}"}.`,
    });
  }
  if (open.length > 0) {
    const prepared = sheet.spells.prepared.length ? sheet.spells.prepared : sheet.spells.known;
    for (const name of prepared) {
      const id = `cast:${name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      spells.push({
        id,
        label: `Cast ${name}`,
        hint: `Slots open: ${open.join(', ')}. Cast with use_action {spell: "${name}", slot_level}: the slot is spent there.`,
      });
    }
  }
  return spells;
}

/** Initiative bonus for a combatant: the stat block's, or the sheet's DEX modifier. */
export function initiativeBonus(combatant: Combatant, sheet: CombatSheet | null): number {
  if (combatant.stat_block) {
    return combatant.stat_block.initiative_bonus ?? abilityMod(combatant.stat_block.abilities.dex ?? 10);
  }
  if (!sheet) return 0;
  // A homebrew `roll` clause narrowed to Initiative adds its points here, where the roll is composed.
  // Initiative carries its proficiency bonus on the sheet already, so the ask says so: Jack of All
  // Trades and its like add nothing on top of what initiative_bonus counted.
  const clauses = checkBonuses(sheet, { actor: combatant, ability: 'dex', initiative: true, proficient: true });
  return sheet.initiative_bonus + clauses.reduce((sum, one) => sum + one.bonus, 0);
}
