// Combat engine: d20 rolls, advantage and disadvantage, saves and ability checks.
import { rollDice, withoutLuckPool, type Advantage, type RollType } from '../core/dice.js';
import { awaitPlayerRoll, netAdvantage, playerRollsStep, type RollStep } from '../core/rolls.js';
import { abilityMod, type Ability } from '../core/rules.js';
import type { CreatureStatBlock } from '../srd/data.js';
import type { Db } from '../db/connection.js';
import { conditionRule, exhaustionPenalty, isIncapacitated, speedZeroBy } from './conditions.js';
import {
  autoD20Stance,
  auraSaveBonus,
  checkBonuses,
  checkSources,
  deniesAdvantage,
  hasFeature,
  hasReliableTalent,
  saveSources,
  type RollSource,
} from './features.js';
import { hasLineOfSight } from './grid.js';
import { sheetAbilityMod, sheetSaveBonus, sheetSkillBonus, type CombatSheet } from './sheet.js';
import { boostsFor, type ClauseCtx, type RollBoost } from './homebrew.js';
import {
  encounterMap,
  getCombatant,
  listCombatants,
  listEffects,
  saveCombatant,
  type Combatant,
  type EncounterRow,
} from './state.js';
import {
  type PreRoll,
  type RollOutcome,
  signed,
  sheetOf,
  auraSources,
  pcLuck,
  wildShapeSheet,
} from './engine-core.js';
import { spendFeatureCost, spendChosenBoosts } from './resources.js';
import { rollDamage } from './damage-math.js';

export interface D20Context {
  advantage: Advantage;
  /** Every source behind `advantage`, so a player card can re-net the whole list when a boost is added. */
  advantage_sources: Advantage[];
  /** Exhaustion: 2 off every d20 test per level. */
  penalty: number;
  /** What the roller's own features add to the roll: a homebrew clause's flat points. */
  bonus: number;
  /** Why the roll came out the way it did, for the fight log. */
  notes: string[];
  /** Set when the roll does not happen at all: a paralyzed creature's STR save simply fails. */
  auto_fail: string | null;
}

interface D20Ask {
  kind: 'attack' | 'save' | 'check';
  ability?: Ability;
  /** The creature being attacked; its own conditions move the attacker's die. */
  target?: Combatant | null;
  distance_ft?: number;
  /** The check or save leans on STR or DEX, so unfamiliar armour weighs on it. */
  str_or_dex?: boolean;
  /** The skill a check uses, which some features key off. */
  skill?: string;
  /** The check carries a proficiency bonus already, which is what Jack of All Trades asks about. */
  proficient?: boolean;
  /** This save is the one keeping a spell's Concentration up: Eldritch Mind gives Advantage on it. */
  concentration?: boolean;
  /** This check is the initiative roll, which Feral Instinct and Remarkable Athlete move. */
  initiative?: boolean;
  advantage?: Advantage;
  /** Sources only the caller knows: long range, a DM ruling, a homebrew clause. */
  extra?: RollSource[];
}

/** Frightened only bites while the creature that caused it is in sight. */
function frightenedApplies(db: Db, encounter: EncounterRow, roller: Combatant): boolean {
  const effect = listEffects(db, encounter.id).find(
    (e) => e.kind === 'condition' && e.target_id === roller.id && e.name === 'frightened' && e.source_id !== null,
  );
  if (!effect) return true;
  const source = listCombatants(db, encounter.id).find((c) => c.id === effect.source_id);
  if (!source || !source.alive) return false;
  return hasLineOfSight(encounterMap(encounter), roller, source);
}

/** The live, visible creatures a Frightened combatant may not move closer to. */
export function frighteners(db: Db, encounter: EncounterRow, roller: Combatant): Combatant[] {
  if (!roller.conditions.includes('frightened')) return [];
  const combatants = listCombatants(db, encounter.id);
  const map = encounterMap(encounter);
  return listEffects(db, encounter.id)
    .filter((e) => e.kind === 'condition' && e.target_id === roller.id && e.name === 'frightened' && e.source_id !== null)
    .map((e) => combatants.find((c) => c.id === e.source_id))
    .filter((c): c is Combatant => c !== undefined && c.alive && hasLineOfSight(map, roller, c));
}

/** Whether this creature's Charmed condition came from the creature it is about to attack. */
export function charmedBy(db: Db, encounter: EncounterRow, roller: Combatant, target: Combatant): boolean {
  if (!roller.conditions.includes('charmed')) return false;
  return listEffects(db, encounter.id).some(
    (e) => e.kind === 'condition' && e.target_id === roller.id && e.name === 'charmed' && e.source_id === target.id,
  );
}

/**
 * Everything the 2024 rules do to one d20 before it is rolled: the roller's own conditions, the
 * target's, exhaustion, armour worn without proficiency, and the Help and Dodge flags.
 */
export function d20Context(db: Db, encounter: EncounterRow, roller: Combatant, ask: D20Ask): D20Context {
  const sources: Advantage[] = [ask.advantage ?? 'none'];
  const notes: string[] = [];
  let autoFail: string | null = null;
  const add = (advantage: Advantage, note: string): void => {
    sources.push(advantage);
    notes.push(note);
  };
  // What an automatic homebrew clause costs, paid here because this is where its source is read. Only
  // the roller's own features carry a spend; nothing in the registry charges a use to somebody else.
  const paid: RollSource[] = [];
  let bonus = 0;
  for (const extra of ask.extra ?? []) {
    add(extra.advantage, extra.note);
    bonus += extra.bonus ?? 0;
    if (extra.spend) paid.push(extra);
  }

  for (const condition of roller.conditions) {
    const rule = conditionRule(condition);
    if (!rule) continue;
    if (rule.while_source_seen && !frightenedApplies(db, encounter, roller)) continue;
    if (ask.kind === 'attack' && rule.attack_disadvantage) add('disadvantage', `${roller.name} is ${condition}`);
    if (ask.kind === 'attack' && rule.attack_disadvantage_except_grappler && roller.flags.grappled_by !== ask.target?.id) {
      add('disadvantage', `${roller.name} is ${condition} and this is not its grappler`);
    }
    if (ask.kind === 'attack' && rule.attack_advantage) add('advantage', `${roller.name} is ${condition}`);
    if (ask.kind === 'check' && rule.check_disadvantage) add('disadvantage', `${roller.name} is ${condition}`);
    if (ask.initiative && rule.initiative_advantage) add('advantage', `${roller.name} is ${condition}`);
    if (ask.initiative && rule.initiative_disadvantage) add('disadvantage', `${roller.name} is ${condition}`);
    if (ask.kind === 'save' && ask.ability) {
      if (rule.auto_fail_saves?.includes(ask.ability)) autoFail = `${roller.name} is ${condition}`;
      if (rule.save_disadvantage?.includes(ask.ability)) add('disadvantage', `${roller.name} is ${condition}`);
    }
  }
  const target = ask.target;
  if (ask.kind === 'attack' && target) {
    for (const condition of target.conditions) {
      const rule = conditionRule(condition);
      if (!rule) continue;
      if (rule.attacked_advantage) add('advantage', `${target.name} is ${condition}`);
      if (rule.attacked_disadvantage) add('disadvantage', `${target.name} is ${condition}`);
      if (rule.attacked_advantage_within_5ft) {
        const close = (ask.distance_ft ?? 0) <= 5;
        add(close ? 'advantage' : 'disadvantage', `${target.name} is ${condition}${close ? '' : ' and further than 5 ft'}`);
      }
    }
    // Dodge is lost the moment the dodger is incapacitated or pinned at speed 0.
    if (target.flags.dodging && !isIncapacitated(target.conditions) && speedZeroBy(target.conditions).length === 0) {
      add('disadvantage', `${target.name} is dodging`);
    }
  }
  if (
    ask.kind === 'save' &&
    ask.ability === 'dex' &&
    roller.flags.dodging &&
    !isIncapacitated(roller.conditions) &&
    speedZeroBy(roller.conditions).length === 0
  ) {
    add('advantage', `${roller.name} is dodging`);
  }

  // Staggering Blow: Disadvantage on the next saving throw the creature makes, spent where it is rolled.
  if (ask.kind === 'save' && roller.flags.staggered) add('disadvantage', `${roller.name} was staggered`);

  const help = roller.flags.helped_by;
  if (help && (ask.kind === 'check' || (ask.kind === 'attack' && (help.against_id === undefined || help.against_id === target?.id)))) {
    add('advantage', `${help.name} is helping`);
  }
  // The mastery properties that ride on the next attack roll: Sap on the one who was hit, Vex on the hitter.
  if (ask.kind === 'attack' && roller.flags.sapped_by) add('disadvantage', `${roller.name} was sapped`);
  if (ask.kind === 'attack' && target && roller.flags.vex_against?.target_id === target.id) {
    add('advantage', `${roller.name} vexed ${target.name} with its last hit`);
  }

  const sheet = sheetOf(db, roller);
  let penalty = 0;
  if (sheet && sheet.exhaustion > 0) {
    penalty = exhaustionPenalty(sheet.exhaustion);
    notes.push(`exhaustion ${sheet.exhaustion} (${penalty} to the roll)`);
  }
  if (sheet?.armor_penalty.penalty && (ask.kind === 'attack' || ask.str_or_dex)) {
    add('disadvantage', `${roller.name} is ${sheet.armor_penalty.reason}`);
  }
  // The class features of whoever is rolling: Danger Sense, Rage, Feral Instinct, Remarkable Athlete.
  if (sheet) {
    const fromFeatures =
      ask.kind === 'save' && ask.ability
        ? saveSources(sheet, {
            actor: roller,
            ability: ask.ability,
            ...(ask.concentration ? { concentration: true } : {}),
          })
        : ask.kind === 'check'
          ? checkSources(sheet, {
              actor: roller,
              ability: ask.ability ?? 'dex',
              ...(ask.skill ? { skill: ask.skill } : {}),
              ...(ask.proficient ? { proficient: true } : {}),
              ...(ask.initiative ? { initiative: true } : {}),
            })
          : [];
    for (const source of fromFeatures) {
      add(source.advantage, source.note);
      bonus += source.bonus ?? 0;
      if (source.spend) paid.push(source);
    }
  }
  for (const source of paid) {
    if (!sheet || !roller.character_id) continue;
    spendFeatureCost(db, encounter, roller, sheet, source.spend!, source.feature ?? source.note);
  }
  // Elusive: nothing gives an attack roll Advantage against this Rogue unless they are Incapacitated.
  const targetSheet = ask.kind === 'attack' && target ? sheetOf(db, target) : null;
  if (targetSheet && deniesAdvantage(targetSheet, target!) && sources.includes('advantage')) {
    notes.push(`${target!.name} is Elusive: no attack roll against them has Advantage`);
    const limited = sources.filter((source) => source !== 'advantage');
    return {
      advantage: netAdvantage(limited),
      advantage_sources: limited,
      penalty,
      bonus,
      notes,
      auto_fail: autoFail,
    };
  }
  return { advantage: netAdvantage(sources), advantage_sources: sources, penalty, bonus, notes, auto_fail: autoFail };
}

/** A d20 roll, or the caller's pre-rolled one passed straight through. */
export function rollD20(bonus: number, options: { advantage?: Advantage; dc?: number; kind: 'attack' | 'save' | 'check'; luck_bias?: number }, pre?: PreRoll): RollOutcome {
  if (pre) {
    const natural = pre.natural ?? pre.natural_d20 ?? null;
    return { total: pre.total, natural, expr: `1d20${signed(bonus)} (player roll)`, output: `${pre.total}`, injected: true };
  }
  const detail = withoutLuckPool(
    rollDice(`1d20${signed(bonus)}`, {
      advantage: options.advantage ?? 'none',
      dc: options.dc ?? null,
      roll_type: options.kind === 'check' ? 'check' : options.kind,
      luck_bias: options.luck_bias ?? 0,
    }),
  );
  return { total: detail.total, natural: detail.natural_d20, expr: detail.expr, output: detail.output, injected: false };
}

/**
 * The die the player clicks for their own character: the card goes out, the call waits for it (or for
 * the timeout), and the answer comes back as a pre-roll for the resolver below.
 */
export async function askPlayer(
  db: Db,
  encounter: EncounterRow,
  combatant: Combatant,
  step: RollStep,
  ask: {
    tool: string;
    expr: string;
    /** What the roll is for, never its number: the AC or DC rides in dc alone, shown per dc_disclosure. */
    purpose: string;
    roll_type: RollType;
    dc?: number;
    advantage?: Advantage;
    /** Every source behind `advantage`, kept on the card so a later boost re-nets the whole list. */
    advantage_sources?: Advantage[];
    target_id?: number;
    /** The homebrew clauses this step may be boosted with; the card offers them before it is rolled. */
    boosts_available?: RollBoost[];
    /** Why the dice are what they are, shown beside the expression on the player's card. */
    dice_notes?: string[];
  },
): Promise<(PreRoll & { output: string }) | undefined> {
  if (!playerRollsStep(db, encounter.campaign_id, combatant.kind === 'pc', step)) return undefined;
  const record = await awaitPlayerRoll(db, {
    expr: ask.expr,
    purpose: ask.purpose,
    dc: ask.dc,
    advantage: ask.advantage,
    ...(ask.advantage_sources?.length ? { advantage_sources: ask.advantage_sources } : {}),
    ...(ask.dice_notes?.length ? { dice_notes: ask.dice_notes } : {}),
    roll_type: ask.roll_type,
    campaign_id: encounter.campaign_id,
    ...(combatant.character_id === null ? {} : { character_id: combatant.character_id }),
    ...(ask.boosts_available?.length ? { boosts_available: ask.boosts_available } : {}),
    context: {
      encounter_id: encounter.id,
      tool: ask.tool,
      step,
      actor_id: combatant.id,
      ...(ask.target_id === undefined ? {} : { target_id: ask.target_id }),
    },
  });
  return {
    total: record.total,
    natural: record.natural_d20,
    output: record.output,
    ...(record.boosts_chosen?.length ? { boosts_chosen: record.boosts_chosen } : {}),
  };
}

/** The abilities Wild Shape leaves the Druid's own; the Beast lends the other three. */
const MENTAL_ABILITIES: Ability[] = ['int', 'wis', 'cha'];

/**
 * Wild Shape keeps the Druid's Intelligence, Wisdom and Charisma and every skill and saving throw
 * proficiency they have, with their own proficiency bonus; the Beast's own modifier wins where it is
 * higher. This is that comparison, for one d20 modifier.
 */
function wildShapeBonus(
  block: CreatureStatBlock,
  druid: CombatSheet,
  ability: Ability,
  own: number,
  proficient: boolean,
  beast: number,
): number {
  const kept = MENTAL_ABILITIES.includes(ability)
    ? own
    : abilityMod(block.abilities[ability] ?? 10) + (proficient ? druid.proficiency_bonus : 0);
  return Math.max(beast, kept);
}

export function saveBonus(db: Db, combatant: Combatant, ability: Ability): number {
  if (combatant.stat_block) {
    const block = combatant.stat_block;
    const beast = block.saves[ability] ?? abilityMod(block.abilities[ability] ?? 10);
    const druid = wildShapeSheet(db, combatant);
    if (!druid) return beast;
    return wildShapeBonus(block, druid, ability, sheetSaveBonus(druid, ability), druid.saves[ability]?.proficient === true, beast);
  }
  const sheet = sheetOf(db, combatant);
  return sheet ? sheetSaveBonus(sheet, ability) : 0;
}

export interface SaveResult {
  ability: Ability;
  dc: number;
  total: number;
  natural: number | null;
  bonus: number;
  success: boolean;
  advantage: Advantage;
  /** A save a condition fails outright: no die is rolled. */
  auto_fail: string | null;
  notes: string[];
}

/**
 * Dark One's Own Luck, declared ahead of the roll it rides on: the 1d10 the warlock bought with a use of
 * the feature is added to the next ability check or saving throw they make, and the declaration is spent.
 */
function darkOnesLuck(
  db: Db,
  encounter: EncounterRow,
  roller: Combatant,
  kind: 'check' | 'save',
): { bonus: number; note: string } | null {
  if (!roller.flags.dark_ones_luck_ready) return null;
  const rolled = rollDice('1d10', { roll_type: 'other' });
  const fresh = getCombatant(db, encounter.id, roller.id);
  fresh.flags = { ...fresh.flags, dark_ones_luck_ready: undefined };
  saveCombatant(db, fresh);
  roller.flags = fresh.flags;
  return { bonus: rolled.total, note: `Dark One's Own Luck: +${rolled.total} on this ${kind} (${rolled.output})` };
}

/**
 * A D20 Test stance declared ahead of the roll - Indomitable, Disciplined Survivor, Peerless Skill,
 * Stroke of Luck, Boon of Fate - applied to the roll that has just failed. The reroll, the die or the 20
 * lands here, inside the same call, and the use is spent here rather than at the declaration.
 */
export async function applyD20Stance(
  db: Db,
  encounter: EncounterRow,
  roller: Combatant,
  kind: 'attack' | 'check' | 'save',
  rolled: RollOutcome,
  ask: {
    total: number;
    bonus: number;
    dc: number;
    advantage: Advantage;
    advantage_sources?: Advantage[];
    tool: string;
    purpose: string;
  },
): Promise<{ total: number; natural: number | null; notes: string[] } | null> {
  const sheet = sheetOf(db, roller);
  if (!sheet) return null;
  const declared = roller.flags.d20_stance;
  // A homebrew clause whose prose gives the reroll outright is armed on every roll it fits.
  const stance = declared?.on.includes(kind) ? declared : autoD20Stance(sheet, kind);
  if (!stance) return null;
  const notes: string[] = [];
  let total = ask.total;
  let natural = rolled.natural;
  if (stance.mode === 'set_20') {
    natural = 20;
    total = 20 + ask.bonus;
    notes.push(`${stance.feature}: the die is turned into a 20, for ${total}`);
  } else if (stance.mode === 'add') {
    const die = rollDamage(stance.dice ?? '1d4', false);
    total += die.total;
    notes.push(`${stance.feature}: +${die.total} on the roll (${die.output}), for ${total}`);
  } else {
    const bonus = ask.bonus + (stance.bonus ?? 0);
    const pre = await askPlayer(db, encounter, roller, kind === 'attack' ? 'attack' : kind === 'save' ? 'save' : 'check', {
      tool: ask.tool,
      expr: `1d20${signed(bonus)}`,
      purpose: `${stance.feature}: ${ask.purpose} rerolled`,
      roll_type: kind === 'check' ? 'check' : kind,
      dc: ask.dc,
      advantage: ask.advantage,
      ...(ask.advantage_sources?.length ? { advantage_sources: ask.advantage_sources } : {}),
    });
    const again = rollD20(
      bonus,
      { advantage: ask.advantage, dc: ask.dc, kind, luck_bias: pcLuck(db, encounter, roller) },
      pre,
    );
    total = again.total;
    natural = again.natural;
    notes.push(
      `${stance.feature}: the roll is made again${stance.bonus ? ` with +${stance.bonus}` : ''} and stands at ${total}`,
    );
  }
  // Peerless Skill: the Bardic Inspiration is not expended when the roll fails even with the die on it.
  const kept = stance.keep_on_failure === true && total < ask.dc;
  const fresh = getCombatant(db, encounter.id, roller.id);
  fresh.flags = { ...fresh.flags, d20_stance: kept ? stance : undefined };
  saveCombatant(db, fresh);
  roller.flags = fresh.flags;
  if (kept) notes.push(`${stance.feature}: the roll still fails, so the use is not spent.`);
  else if (stance.spend) spendFeatureCost(db, encounter, roller, sheet, stance.spend, stance.feature);
  return { total, natural, notes };
}

/** Indomitable Might: a Strength total below the Barbarian's own Strength score counts as that score. */
function indomitableMight(db: Db, roller: Combatant, ability: Ability, total: number): { total: number; note: string } | null {
  const sheet = sheetOf(db, roller);
  if (!sheet || ability !== 'str' || !hasFeature(sheet, 'barbarian-indomitable-might')) return null;
  const score = sheet.abilities.str?.score ?? 10;
  if (total >= score) return null;
  return { total: score, note: `Indomitable Might: ${total} counts as ${score}, your Strength score` };
}

export async function rollSave(
  db: Db,
  encounter: EncounterRow,
  combatant: Combatant,
  ability: Ability,
  dc: number,
  options: { advantage?: Advantage; coverBonus?: number; roll?: PreRoll; tool?: string; concentration?: boolean } = {},
): Promise<SaveResult> {
  const ctx = d20Context(db, encounter, combatant, {
    kind: 'save',
    ability,
    advantage: options.advantage,
    str_or_dex: ability === 'str' || ability === 'dex',
    ...(options.concentration ? { concentration: true } : {}),
  });
  // Aura of Protection: a paladin within 10 ft lends its Charisma modifier to this save.
  const aura = auraSaveBonus(combatant, auraSources(db, encounter));
  const notes = aura ? [...ctx.notes, aura.note] : ctx.notes;
  const bonus =
    saveBonus(db, combatant, ability) +
    (ability === 'dex' ? (options.coverBonus ?? 0) : 0) +
    ctx.penalty +
    ctx.bonus +
    (aura?.bonus ?? 0);
  if (ctx.auto_fail) {
    return {
      ability,
      dc,
      total: 0,
      natural: null,
      bonus,
      success: false,
      advantage: ctx.advantage,
      auto_fail: ctx.auto_fail,
      notes,
    };
  }
  const saveSheet = sheetOf(db, combatant);
  const saveBoostCtx: Omit<ClauseCtx, 'sheet'> = { kind: 'save', save: ability, ability };
  const saveBoosts = saveSheet ? boostsFor(saveSheet, saveSheet.features, saveBoostCtx) : [];
  const pre =
    options.roll ??
    (await askPlayer(db, encounter, combatant, 'save', {
      tool: options.tool ?? 'use_action',
      expr: `1d20${signed(bonus)}`,
      purpose: `Saving throw: ${ability.toUpperCase()}`,
      roll_type: 'save',
      dc,
      advantage: ctx.advantage,
      advantage_sources: ctx.advantage_sources,
      ...(saveBoosts.length ? { boosts_available: saveBoosts } : {}),
    }));
  // Taken on the card, spent here: the fight log carries the line, and the snapshot can undo it.
  for (const entry of pre?.boosts_chosen?.length
    ? spendChosenBoosts(db, encounter, combatant, saveSheet, pre.boosts_chosen, saveBoostCtx)
    : []) {
    notes.push(entry.text);
  }
  const rolled = rollD20(
    bonus,
    { advantage: ctx.advantage, dc, kind: 'save', luck_bias: pcLuck(db, encounter, combatant) },
    pre,
  );
  // A 1d10 the warlock declared before the roll: it is added here and the declaration is spent.
  const luck = darkOnesLuck(db, encounter, combatant, 'save');
  let total = rolled.total + (luck?.bonus ?? 0);
  let natural = rolled.natural;
  const after = luck ? [...notes, luck.note] : [...notes];
  // Staggering Blow: the Disadvantage was spent on this save, whichever way it went.
  if (combatant.flags.staggered) {
    const fresh = getCombatant(db, encounter.id, combatant.id);
    fresh.flags = { ...fresh.flags, staggered: undefined };
    saveCombatant(db, fresh);
    combatant.flags = fresh.flags;
  }
  const might = indomitableMight(db, combatant, ability, total);
  if (might) {
    total = might.total;
    after.push(might.note);
  }
  if (total < dc) {
    const stance = await applyD20Stance(db, encounter, combatant, 'save', rolled, {
      total,
      bonus,
      dc,
      advantage: ctx.advantage,
      advantage_sources: ctx.advantage_sources,
      tool: options.tool ?? 'use_action',
      purpose: `${ability.toUpperCase()} save`,
    });
    if (stance) {
      total = stance.total;
      natural = stance.natural;
      after.push(...stance.notes);
    }
  }
  return {
    ability,
    dc,
    total,
    natural,
    bonus: bonus + (luck?.bonus ?? 0),
    success: total >= dc,
    advantage: ctx.advantage,
    auto_fail: null,
    notes: after,
  };
}

/** An ability check the engine rolls itself: the escape from a grapple, a Stealth check for Hide. */
export async function rollCheck(
  db: Db,
  encounter: EncounterRow,
  combatant: Combatant,
  input: { ability: Ability; skill?: string; dc: number; purpose: string; tool: string; roll?: PreRoll },
): Promise<{ total: number; natural: number | null; bonus: number; success: boolean; advantage: Advantage; notes: string[] }> {
  const sheet = sheetOf(db, combatant);
  const statSkill = combatant.stat_block?.skills[input.skill ?? ''];
  const bonusFromSheet = sheet
    ? input.skill
      ? sheetSkillBonus(sheet, input.skill, input.ability)
      : sheetAbilityMod(sheet, input.ability)
    : abilityMod(combatant.stat_block?.abilities[input.ability] ?? 10);
  const proficient = input.skill !== undefined && sheet?.skills[input.skill]?.proficient === true;
  // Jack of All Trades and its like: a flat bonus a feature puts on the check itself. Read before the
  // d20 context, which is where a rationed homebrew clause pays for the number this just took.
  const fromFeatures = sheet
    ? checkBonuses(sheet, {
        actor: combatant,
        ability: input.ability,
        proficient,
        ...(input.skill ? { skill: input.skill } : {}),
      })
    : [];
  const featureBonus = fromFeatures.reduce((sum, entry) => sum + entry.bonus, 0);
  const ctx = d20Context(db, encounter, combatant, {
    kind: 'check',
    ability: input.ability,
    ...(input.skill ? { skill: input.skill } : {}),
    proficient,
    str_or_dex: input.ability === 'str' || input.ability === 'dex',
  });
  // A Druid in a Beast form keeps their mental scores and their proficiencies, the Beast's own when higher.
  const shifted = wildShapeSheet(db, combatant);
  const beastBonus = statSkill ?? abilityMod(combatant.stat_block?.abilities[input.ability] ?? 10);
  const base =
    shifted && combatant.stat_block
      ? wildShapeBonus(combatant.stat_block, shifted, input.ability, bonusFromSheet, proficient, beastBonus)
      : (statSkill ?? bonusFromSheet);
  const bonus = base + ctx.penalty + featureBonus;
  const pre =
    input.roll ??
    (await askPlayer(db, encounter, combatant, 'check', {
      tool: input.tool,
      expr: `1d20${signed(bonus)}`,
      purpose: input.purpose,
      roll_type: 'check',
      dc: input.dc,
      advantage: ctx.advantage,
      advantage_sources: ctx.advantage_sources,
    }));
  const rolled = rollD20(
    bonus,
    { advantage: ctx.advantage, dc: input.dc, kind: 'check', luck_bias: pcLuck(db, encounter, combatant) },
    pre,
  );
  // Reliable Talent: a d20 of 9 or lower counts as a 10 on a check the Rogue is proficient in.
  const talented = sheet !== null && hasReliableTalent(sheet) && proficient && rolled.natural !== null && rolled.natural < 10;
  const luck = darkOnesLuck(db, encounter, combatant, 'check');
  let total = (talented ? rolled.total - rolled.natural! + 10 : rolled.total) + (luck?.bonus ?? 0);
  let natural = rolled.natural;
  const notes = [
    ...ctx.notes,
    ...fromFeatures.map((entry) => entry.note),
    ...(talented ? [`Reliable Talent: the ${rolled.natural} on the die counts as a 10`] : []),
    ...(luck ? [luck.note] : []),
  ];
  const might = indomitableMight(db, combatant, input.ability, total);
  if (might) {
    total = might.total;
    notes.push(might.note);
  }
  if (total < input.dc) {
    const stance = await applyD20Stance(db, encounter, combatant, 'check', rolled, {
      total,
      bonus,
      dc: input.dc,
      advantage: ctx.advantage,
      advantage_sources: ctx.advantage_sources,
      tool: input.tool,
      purpose: input.purpose,
    });
    if (stance) {
      total = stance.total;
      natural = stance.natural;
      notes.push(...stance.notes);
    }
  }
  return {
    total,
    natural,
    bonus: bonus + (luck?.bonus ?? 0),
    success: total >= input.dc,
    advantage: ctx.advantage,
    notes,
  };
}
