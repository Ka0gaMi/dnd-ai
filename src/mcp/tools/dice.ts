import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { pcRow } from '../../core/campaign.js';
import {
  assertKnowsLanguage,
  checkModifier,
  exhaustionPenalty,
  heldInspirationDie,
  spendFeatureResource,
  spendInspirationDie,
  toolRollProficiency,
  type CheckModifier,
} from '../../core/character.js';
import type { Advantage, RollType } from '../../core/dice.js';
import { netAdvantage, recordPassiveCheck, rollForTool } from '../../core/rolls.js';
import { getSettings } from '../../core/settings.js';
import { abilityMod, SKILL_KEYS, type Ability } from '../../core/rules.js';
import { hasFeature, resourceSpec } from '../../combat/features.js';
import type { RollBoost } from '../../combat/homebrew.js';
import { combatSheet } from '../../combat/sheet.js';
import { srdSearch } from '../../srd/lookup.js';
import { reply } from './result.js';

const PLAYER_ROLL_REMINDER =
  'Reminder: this looks like a roll for the player. Pass roller: "player" so they can roll it themselves (roll mode is set to player).';

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
const ABILITY = z.enum(ABILITY_KEYS);

/** The DM left roller off a roll the player would have clicked: say so once, after the result. */
function playerRollReminder(
  db: Db,
  args: { campaign_id?: number; roller?: string; roll_type?: string },
): string | null {
  if (args.roller !== undefined || args.campaign_id === undefined || args.roll_type === 'damage') return null;
  if (getSettings(db, args.campaign_id).roll_mode !== 'player') return null;
  const pc = pcRow(db, args.campaign_id);
  return pc && pc.status === 'active' ? PLAYER_ROLL_REMINDER : null;
}

/** The skill the check is made with, named outright or read off the purpose ("Stealth check"). */
function skillOfRoll(purpose: string, skill?: string): string | null {
  const named = skill?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (named && SKILL_KEYS.includes(named)) return named;
  const haystack = purpose.toLowerCase().replace(/[\s-]+/g, '_');
  return SKILL_KEYS.find((key) => haystack.includes(key)) ?? null;
}

/** One side of a contest, or one member of a group check, named by id, by creature or by a flat bonus. */
interface OpponentSpec {
  character_id?: number;
  creature?: string;
  bonus?: number;
  name?: string;
  skill?: string;
  ability?: Ability;
}

interface ToolArgs {
  expr?: string;
  purpose: string;
  dc?: number;
  campaign_id?: number;
  character_id?: number;
  advantage?: Advantage;
  roll_type?: RollType;
  roller?: 'player' | 'dm';
  tool?: string;
  skill?: string;
  save?: Ability;
  ability?: Ability;
  passive?: boolean;
  contest?: { opponent: OpponentSpec; skill?: string; ability?: Ability; save?: Ability };
  group?: number[];
  language?: string;
  bardic_inspiration?: boolean;
  dark_ones_luck?: boolean;
  /** Homebrew clauses spent on this roll, by boost id; the reply lists what is on offer. */
  boosts?: string[];
}

/**
 * The dice a class feature adds to a d20 test the player has declared it on: the Bardic Inspiration die
 * they are holding, and Dark One's Own Luck. Both are rolled only when the test would otherwise fail, but
 * a Bardic Inspiration die is expended when it is rolled unless the roller has Peerless Skill.
 */
async function addOnDie(
  db: Db,
  args: ToolArgs,
  result: { total: number },
): Promise<{ total: number; note: string; spent: boolean } | null> {
  const campaignId = args.campaign_id;
  if (campaignId === undefined || (!args.bardic_inspiration && !args.dark_ones_luck)) return null;
  // Dark One's Own Luck adds to an ability check or a saving throw, never to an attack or damage roll.
  if (args.dark_ones_luck && args.roll_type !== 'check' && args.roll_type !== 'save') {
    throw new Error("Dark One's Own Luck adds to an ability check or a saving throw, not to this roll.");
  }
  const die = args.bardic_inspiration ? heldInspirationDie(db, campaignId, args.character_id) : 10;
  if (args.bardic_inspiration && die === null) {
    throw new Error(
      'Nobody has handed this character a Bardic Inspiration die. A Bard gives one out with use_action {action_name: "bardic_inspiration", target_id}.',
    );
  }
  const feature = args.bardic_inspiration ? 'Bardic Inspiration' : "Dark One's Own Luck";
  // Dark One's Own Luck is spent off the sheet, so what is left is checked before the die is rolled.
  const luck = args.dark_ones_luck ? luckLeft(db, campaignId, args.character_id) : null;
  if (luck && luck.left <= 0) {
    throw new Error(`${luck.name} has no uses of Dark One's Own Luck left; they come back on a long rest.`);
  }
  // With no DC there is no failure to turn, so the die is added and spent outright.
  if (args.dc !== undefined && result.total >= args.dc) {
    return { total: result.total, note: `${feature} was not needed: the roll already beats DC ${args.dc}.`, spent: false };
  }
  const rolled = await rollForTool(db, {
    expr: `1d${die}`,
    purpose: `${feature} (added to ${args.purpose})`,
    campaign_id: campaignId,
    roll_type: 'other',
    roller: 'dm',
  });
  const total = result.total + rolled.total;
  if (args.dc !== undefined && total < args.dc) {
    // Peerless Skill is the one feature that gets the die back on a failure; otherwise it was rolled.
    const peerless =
      args.bardic_inspiration &&
      hasFeature(combatSheet(db, requirePc(db, campaignId, args.character_id)), 'lore-peerless-skill');
    if (args.bardic_inspiration && !peerless) {
      spendInspirationDie(db, campaignId, args.character_id);
      return {
        total,
        note: `${feature}: ${rolled.total} more is still ${total} against DC ${args.dc}; the die is spent, expended when it is rolled.`,
        spent: true,
      };
    }
    return {
      total,
      note: `${feature}: ${rolled.total} more is still ${total} against DC ${args.dc}, so the die is not spent.`,
      spent: false,
    };
  }
  if (args.bardic_inspiration) spendInspirationDie(db, campaignId, args.character_id);
  else {
    spendFeatureResource(db, {
      campaign_id: campaignId,
      character_id: luck!.character_id,
      resource: 'dark_ones_own_luck',
      label: luck!.label,
      max: luck!.max,
      per: 'long',
    });
  }
  return { total, note: `${feature}: +${rolled.total}, for ${total}${args.dc === undefined ? '' : ` against DC ${args.dc}`}.`, spent: true };
}

/**
 * The player's own card is where they choose their own boosts: the DM spends a companion's, never theirs.
 */
function refusePlayersOwnBoosts(db: Db, args: ToolArgs): void {
  if (!args.boosts?.length || args.campaign_id === undefined || args.roller !== 'player') return;
  if (getSettings(db, args.campaign_id).roll_mode !== 'player') return;
  const pc = pcRow(db, args.campaign_id);
  if (!pc || (args.character_id !== undefined && args.character_id !== pc.id)) return;
  throw new Error(
    `${pc.name} rolls this one themselves and chooses their own boosts in their window. Pass boosts for a companion's roll or one you make as the DM.`,
  );
}

/** The character whose sheet a feature is spent from: the one named, or the player character. */
function requirePc(db: Db, campaignId: number, characterId?: number): number {
  if (characterId !== undefined) return characterId;
  const pc = pcRow(db, campaignId);
  if (!pc) throw new Error('This campaign has no player character to spend a class feature from.');
  return pc.id as number;
}

/** What is left of Dark One's Own Luck, with the maximum the registry works out from the sheet. */
function luckLeft(
  db: Db,
  campaignId: number,
  characterId?: number,
): { character_id: number; name: string; label: string; max: number; left: number } {
  const id = requirePc(db, campaignId, characterId);
  const sheet = combatSheet(db, id);
  const spec = resourceSpec(sheet, 'dark_ones_own_luck');
  if (!spec) {
    throw new Error(`${sheet.name} has no Dark One's Own Luck; it is a Fiend patron feature taken at Warlock level 6.`);
  }
  const used = sheet.features.find((f) => f.mechanics?.resource === 'dark_ones_own_luck')?.mechanics?.used ?? 0;
  return { character_id: id, name: sheet.name, label: spec.label, max: spec.max, left: spec.max - used };
}

/** What the DM named as the thing being rolled, if they named one at all. */
interface SheetTarget {
  skill?: string;
  ability?: Ability;
  save?: Ability;
}

const targetOf = (args: { skill?: string; ability?: Ability; save?: Ability }): SheetTarget => ({
  ...(args.skill ? { skill: args.skill } : {}),
  ...(args.ability ? { ability: args.ability } : {}),
  ...(args.save ? { save: args.save } : {}),
});

const namesATest = (target: SheetTarget): boolean => Boolean(target.skill || target.ability || target.save);

const signed = (value: number): string => (value < 0 ? String(value) : `+${value}`);

const d20With = (modifier: number): string => (modifier === 0 ? '1d20' : `1d20${signed(modifier)}`);

function requireCampaign(args: ToolArgs, what: string): number {
  if (args.campaign_id === undefined) {
    throw new Error(`${what} is read off a character sheet, so it needs campaign_id.`);
  }
  return args.campaign_id;
}

/** The flat modifier the DM wrote into expr; a sheet-resolved roll composes its own instead. */
function exprModifier(expr: string | undefined): number | null {
  const match = /([+-]\s*\d+)\s*$/.exec(expr ?? '');
  return match ? Number(match[1]!.replace(/\s+/g, '')) : null;
}

/** The breakdown the reply carries, so the DM can see where every point came from. */
const breakdown = (modifier: CheckModifier): Record<string, unknown> => ({
  character: modifier.name,
  character_id: modifier.character_id,
  ability: modifier.ability,
  skill: modifier.skill,
  ability_mod: modifier.ability_mod,
  proficiency: modifier.proficiency,
  expertise: modifier.expertise,
  exhaustion: modifier.exhaustion,
  ...(modifier.feature_bonus ? { feature_bonus: modifier.feature_bonus, feature: modifier.feature_note } : {}),
  total_modifier: modifier.total_modifier,
});

/**
 * The boosts the DM named for this roll, checked against what the sheet offers and applied to the dice.
 * They are spent after the roll stands, which is the order the player's own card keeps.
 */
function applyBoosts(
  args: ToolArgs,
  modifier: CheckModifier,
): { advantage: Advantage | undefined; bonus: number; chosen: RollBoost[]; note: string | null } {
  const offered = modifier.boosts_available ?? [];
  const chosen: RollBoost[] = [];
  for (const id of args.boosts ?? []) {
    const boost = offered.find((one) => one.id === id);
    if (!boost) {
      throw new Error(
        `${modifier.name} has no boost "${id}" for this roll. Available: ${offered.map((one) => one.id).join(', ') || 'none'}.`,
      );
    }
    chosen.push(boost);
  }
  if (chosen.length === 0) return { advantage: undefined, bonus: 0, chosen, note: null };
  // One source among several: the caller collects it and nets it against every other one on the roll.
  const advantage = chosen.some((one) => one.advantage) ? ('advantage' as Advantage) : undefined;
  const bonus = chosen.reduce((sum, one) => sum + one.bonus, 0);
  return { advantage, bonus, chosen, note: chosen.map((one) => `${one.name}: ${one.describe}`).join('; ') };
}

/** The uses a composed roll took: charged once the roll stands, never at the declaration. */
function spendComposed(db: Db, campaignId: number, characterId: number, spent: RollBoost[]): void {
  for (const boost of spent) {
    spendFeatureResource(db, {
      campaign_id: campaignId,
      character_id: characterId,
      resource: boost.id,
      label: boost.label,
      max: boost.max,
      per: boost.per,
    });
  }
}

interface SheetRoll {
  args: ToolArgs & { boosts_available?: RollBoost[] };
  modifier: CheckModifier;
  /** Every source the sheet found, so the caller can net in the tool's own before the die is rolled. */
  advantageSources: Advantage[];
  /** The boosts the DM named and the automatic clauses that fired; spent once the roll stands. */
  spent: RollBoost[];
  /** Set when a condition makes this save fail outright: no die is rolled and nothing is spent. */
  autoFail: string | null;
  fields: Record<string, unknown>;
  notes: string[];
}

/**
 * The 2024 rules on a check or a save: the ability modifier, the proficiency bonus when they are
 * proficient (doubled by Expertise) and the exhaustion penalty, all read off the sheet. Whatever
 * modifier the DM wrote into expr is ignored and named in the reply.
 */
function composeFromSheet(db: Db, args: ToolArgs, target: SheetTarget, characterId?: number): SheetRoll {
  const campaignId = requireCampaign(args, 'A check or a save composed from the sheet');
  const modifier = checkModifier(db, campaignId, characterId ?? args.character_id, target);
  const notes: string[] = [];
  // Every source is collected here; the caller nets them once, so two Advantages and one Disadvantage cancel.
  const advantageSources: Advantage[] = [args.advantage ?? 'none'];
  if (modifier.stealth_disadvantage) {
    advantageSources.push('disadvantage');
    notes.push(`${modifier.name} wears armour the armour table marks as loud: Disadvantage on Stealth.`);
  }
  // The character's own conditions: the same table the combat engine reads, applied to the sheet's d20.
  for (const line of modifier.condition_disadvantage ?? []) {
    advantageSources.push('disadvantage');
    notes.push(line);
  }
  // A homebrew clause that gives this roll Advantage by itself, and the ones the DM chose to spend.
  for (const line of modifier.feature_advantage ?? []) {
    advantageSources.push('advantage');
    notes.push(line);
  }
  const boosts = applyBoosts(args, modifier);
  if (boosts.advantage) advantageSources.push(boosts.advantage);
  if (boosts.note) notes.push(boosts.note);
  const advantage = netAdvantage(advantageSources);
  // Never silently dropped: a clause this roll cannot answer is handed back with the result.
  for (const one of modifier.reminders ?? []) notes.push(`${one.feature}: ${one.text} - ${one.reason}`);
  const ignored = exprModifier(args.expr);
  if (ignored !== null) {
    notes.push(
      `The modifier in expr was ignored: ${modifier.name}'s ${modifier.skill ?? modifier.ability.toUpperCase()} ${
        target.save ? 'save' : 'check'
      } is ${signed(modifier.total_modifier)} off the sheet.`,
    );
  }
  return {
    args: {
      ...args,
      expr: d20With(modifier.total_modifier + boosts.bonus),
      advantage,
      roll_type: args.roll_type ?? (target.save ? 'save' : 'check'),
      ...(modifier.boosts_available?.length ? { boosts_available: modifier.boosts_available } : {}),
    },
    modifier,
    advantageSources,
    spent: [...boosts.chosen, ...(modifier.feature_spends ?? [])],
    autoFail: modifier.auto_fail_save ?? null,
    fields: {
      modifier_from_sheet: signed(modifier.total_modifier),
      modifier: breakdown(modifier),
      ...(modifier.boosts_available?.length ? { boosts_available: modifier.boosts_available } : {}),
      ...(modifier.reminders?.length ? { reminders: modifier.reminders } : {}),
      ...(boosts.chosen.length ? { boosts_spent: boosts.chosen.map((one) => one.id) } : {}),
      ...(ignored === null ? {} : { expr_modifier_ignored: signed(ignored) }),
    },
    notes,
  };
}

/**
 * The 2024 tool rules on a check: a proficient tool adds the proficiency bonus, and a proficient skill
 * beside it turns that into Advantage instead. The expression the DM sent is left alone otherwise.
 */
function applyToolProficiency(
  db: Db,
  args: ToolArgs,
): { args: ToolArgs; advantage?: Advantage; note: string | null } {
  if (!args.tool || args.campaign_id === undefined) return { args, note: null };
  if (args.roller !== 'player' || args.roll_type !== 'check') {
    return { args, note: 'A tool proficiency applies to a player check; nothing was added to this roll.' };
  }
  const skill = skillOfRoll(args.purpose, args.skill);
  const result = toolRollProficiency(db, args.campaign_id, args.character_id, { tool: args.tool, skill });
  if (result.advantage) {
    // One source among several: the caller nets it against every other one on the roll.
    return { args, advantage: 'advantage', note: result.note };
  }
  if (result.bonus > 0) return { args: { ...args, expr: `${args.expr}+${result.bonus}` }, note: result.note };
  return { args, note: result.note };
}

/** 2024 exhaustion: every level takes 2 off every d20 test the tired character makes, whoever rolls it. */
function applyExhaustion(db: Db, args: ToolArgs): { args: ToolArgs; note: string | null } {
  if (args.campaign_id === undefined || args.roll_type === 'damage') return { args, note: null };
  // No character named and the DM is rolling: a monster or a random determination, not the tired PC.
  if (args.character_id === undefined && args.roller !== 'player') return { args, note: null };
  if (!/d20/i.test(args.expr ?? '')) return { args, note: null };
  const penalty = exhaustionPenalty(db, args.campaign_id, args.character_id);
  if (penalty === 0) return { args, note: null };
  return {
    args: { ...args, expr: `${args.expr}-${penalty}` },
    note: `Exhaustion takes ${penalty} off this d20 test.`,
  };
}

/** 2024 passive check: 10 plus the modifier, +5 with Advantage, -5 with Disadvantage, no dice at all. */
function passiveCheck(db: Db, args: ToolArgs): CallToolResult {
  const campaignId = requireCampaign(args, 'A passive check');
  const target = targetOf(args);
  if (!namesATest(target)) {
    throw new Error(`A passive check needs skill (${SKILL_KEYS.join(', ')}) or ability (${ABILITY_KEYS.join(', ')}).`);
  }
  const modifier = checkModifier(db, campaignId, args.character_id, target);
  // Exhaustion cuts a d20 test; a passive check rolls no die, so its penalty comes back out here.
  const passive = { ...modifier, exhaustion: 0, total_modifier: modifier.total_modifier + modifier.exhaustion };
  const advantageSources: Advantage[] = [args.advantage ?? 'none'];
  if (modifier.stealth_disadvantage) advantageSources.push('disadvantage');
  // The character's conditions, read through the same table the combat path reads.
  for (const _line of modifier.condition_disadvantage ?? []) advantageSources.push('disadvantage');
  // A homebrew clause that gives this check Advantage gives the passive one its +5, the 2024 way.
  for (const _line of modifier.feature_advantage ?? []) advantageSources.push('advantage');
  const advantage = netAdvantage(advantageSources);
  const swing = advantage === 'advantage' ? 5 : advantage === 'disadvantage' ? -5 : 0;
  const total = 10 + passive.total_modifier + swing;
  const row = recordPassiveCheck(db, {
    campaign_id: campaignId,
    purpose: args.purpose,
    character: modifier.name,
    skill: modifier.skill,
    ability: modifier.ability,
    modifier: passive.total_modifier,
    advantage,
    total,
    dc: args.dc ?? null,
  });
  const conditions = modifier.condition_disadvantage ?? [];
  return reply(db, campaignId, {
    passive: true,
    purpose: row.purpose,
    total,
    dc: row.dc,
    outcome: row.outcome,
    advantage,
    modifier_from_sheet: signed(passive.total_modifier),
    modifier: breakdown(passive),
    ...(modifier.feature_advantage?.length || conditions.length
      ? { rules_applied: [...(modifier.feature_advantage ?? []), ...conditions] }
      : {}),
    ...(modifier.reminders?.length ? { reminders: modifier.reminders } : {}),
    event_id: row.event_id,
    note: 'A passive check is not rolled: it goes in the campaign events for you, not in the dice ledger, and nothing was pushed to the player.',
  });
}

interface Side {
  name: string;
  bonus: number;
  from: string;
}

/** The bonus the other side of a contest rolls with: their sheet, their stat block, or what you passed. */
function opponentSide(db: Db, args: ToolArgs, opponent: OpponentSpec, fallback: SheetTarget): Side {
  const target = namesATest(targetOf(opponent)) ? targetOf(opponent) : fallback;
  if (opponent.character_id !== undefined) {
    const modifier = checkModifier(
      db,
      requireCampaign(args, "A contest against a character's sheet"),
      opponent.character_id,
      target,
    );
    return { name: modifier.name, bonus: modifier.total_modifier, from: 'their sheet' };
  }
  if (opponent.creature) {
    const found = srdSearch('creature', opponent.creature, 1, true).results[0] as
      | { name: string; skills?: Record<string, number>; abilities?: Record<string, number> }
      | undefined;
    if (!found) {
      throw new Error(
        `No SRD creature called "${opponent.creature}". Find the exact name with srd_lookup kind "creature", or pass opponent.bonus instead.`,
      );
    }
    const skillBonus = target.skill ? found.skills?.[target.skill] : undefined;
    if (skillBonus !== undefined) return { name: found.name, bonus: skillBonus, from: 'its stat block' };
    const ability = target.ability ?? target.save;
    const score = ability ? found.abilities?.[ability] : undefined;
    if (score !== undefined) return { name: found.name, bonus: abilityMod(score), from: 'its stat block' };
    throw new Error(
      `${found.name} has no bonus for that check in its stat block. Pass opponent.skill or opponent.ability it should use, or opponent.bonus outright.`,
    );
  }
  if (opponent.bonus !== undefined) {
    return { name: opponent.name ?? 'the opposition', bonus: opponent.bonus, from: 'the bonus you passed' };
  }
  throw new Error('A contest needs an opponent: pass opponent.character_id, opponent.creature or opponent.bonus.');
}

const TIE_STANDS =
  'A tie means the situation stays as it was: nothing moves, nobody is grabbed and whatever was hidden stays hidden.';

/** 2024 contest: both sides roll the check, the higher total wins and a tie changes nothing. */
async function contestRoll(db: Db, args: ToolArgs): Promise<CallToolResult> {
  const campaignId = requireCampaign(args, 'A contest');
  const contest = args.contest!;
  const target = namesATest(targetOf(contest)) ? targetOf(contest) : targetOf(args);
  if (!namesATest(target)) {
    throw new Error(`A contest needs skill (${SKILL_KEYS.join(', ')}), ability or save for the character's side.`);
  }
  const mine = composeFromSheet(db, { ...args, ...target, dc: undefined }, target);
  const other = opponentSide(db, args, contest.opponent, target);

  // A condition that makes the character's side fail outright: the opponent takes the contest.
  const ours = mine.autoFail
    ? null
    : await rollForTool(db, {
        expr: mine.args.expr!,
        purpose: `${args.purpose} (contest)`,
        campaign_id: campaignId,
        character_id: args.character_id,
        advantage: mine.args.advantage,
        roll_type: mine.args.roll_type,
        roller: args.roller,
      });
  const theirs = await rollForTool(db, {
    expr: d20With(other.bonus),
    purpose: `${other.name}: ${args.purpose} (contest)`,
    campaign_id: campaignId,
    roll_type: mine.args.roll_type,
    roller: 'dm',
  });

  // The character's side of a contest pays for what it rolled with, exactly as a plain check does.
  if (ours && mine.spent.length) {
    spendComposed(db, campaignId, requirePc(db, campaignId, args.character_id), mine.spent);
  }

  const winner = mine.autoFail
    ? 'opponent'
    : ours!.total === theirs.total
      ? 'tie'
      : ours!.total > theirs.total
        ? 'character'
        : 'opponent';
  return reply(db, campaignId, {
    contest: {
      character: { name: mine.modifier.name, total: ours?.total ?? null, roll: ours?.output ?? `auto-fail: ${mine.autoFail}` },
      opponent: { name: other.name, bonus: other.bonus, from: other.from, total: theirs.total, roll: theirs.output },
      winner,
      ...(mine.autoFail ? { auto_fail: mine.autoFail } : {}),
      ...(winner === 'tie' ? { tie: TIE_STANDS } : {}),
    },
    ...mine.fields,
    ...(mine.notes.length ? { rules_applied: mine.notes } : {}),
  });
}

/** 2024 group check: everyone rolls, and the group succeeds when at least half of them do. */
async function groupCheck(db: Db, args: ToolArgs): Promise<CallToolResult> {
  const campaignId = requireCampaign(args, 'A group check');
  const ids = args.group!;
  const target = targetOf(args);
  if (!namesATest(target)) {
    throw new Error(`A group check needs skill (${SKILL_KEYS.join(', ')}) or ability (${ABILITY_KEYS.join(', ')}).`);
  }
  if (args.dc === undefined) throw new Error('A group check needs the dc every member rolls against.');

  const members: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const composed = composeFromSheet(db, args, target, id);
    // A condition that makes the save fail outright: the member is counted down without a die.
    if (composed.autoFail) {
      members.push({
        character_id: id,
        name: composed.modifier.name,
        total: null,
        outcome: 'failure',
        auto_fail: composed.autoFail,
        modifier_from_sheet: signed(composed.modifier.total_modifier),
        modifier: breakdown(composed.modifier),
      });
      continue;
    }
    const row = db.prepare('SELECT is_pc FROM character WHERE id = ? AND campaign_id = ?').get(id, campaignId) as
      | { is_pc: number }
      | undefined;
    // Only the player character's own die is theirs to click; the server rolls the rest of the party.
    const roller = row?.is_pc === 1 ? (args.roller ?? 'player') : 'dm';
    const rolled = await rollForTool(db, {
      expr: composed.args.expr!,
      purpose: `${args.purpose} (${composed.modifier.name})`,
      campaign_id: campaignId,
      character_id: id,
      advantage: composed.args.advantage,
      roll_type: composed.args.roll_type,
      dc: args.dc,
      roller,
    });
    if (composed.spent.length) spendComposed(db, campaignId, id, composed.spent);
    members.push({
      character_id: id,
      name: composed.modifier.name,
      total: rolled.total,
      outcome: rolled.outcome,
      modifier_from_sheet: signed(composed.modifier.total_modifier),
      modifier: breakdown(composed.modifier),
    });
  }

  const successes = members.filter((m) => m.outcome === 'success').length;
  const needed = Math.ceil(members.length / 2);
  return reply(db, campaignId, {
    group_check: {
      dc: args.dc,
      members,
      successes,
      needed,
      succeeded: successes >= needed,
      rule: 'A group check succeeds when at least half the group succeeds.',
    },
  });
}

export function registerDiceTools(server: McpServer, db: Db): void {
  server.registerTool(
    'roll',
    {
      title: 'Roll dice',
      description:
        'Pass roller: "player" for every check, attack and save made by the player character or a companion - that is how the player gets to roll their own dice - and keep the default "dm" for monsters, hidden rolls and random determinations. Rolls dice server-side and returns the individual dice, the total and, when a DC is given, the outcome word. This is the only legitimate source of dice results: never invent, guess or adjust a number, and never describe a result you did not get from this tool. Use it for every check, save, attack, damage roll and random determination, passing the DC you set so the server decides success or failure. For a check or a save, do not work the modifier out yourself: pass skill ("stealth"), ability ("str") or save ("dex") and the server reads the sheet - ability modifier, proficiency bonus, Expertise, exhaustion and loud armour - composes the d20 roll and returns the breakdown; expr is then not needed, and a modifier left in it is ignored and named in the reply. roll_type is inferred as "check" or "save" when you leave it out. Always pass roll_type: "attack" with the target\'s AC as dc for attack rolls, and "damage" for damage, where expr carries the dice. Only an attack roll crits: a natural 20 returns outcome "critical_hit" and a natural 1 "miss" whatever the AC, while a check or save with a natural 20 is just a 20 against its DC. Pass passive: true with skill or ability for a passive check (10 + modifier, +5 with Advantage, -5 with Disadvantage): no dice are rolled and the player sees nothing. Pass contest with an opponent for a contest - both sides roll and a tie leaves the situation exactly as it was - and group with the character ids for a group check, which succeeds when at least half of them beat the dc. Pass campaign_id whenever a campaign is loaded so the roll is logged and shown in the player window. For a player check made with a tool, pass tool and leave its bonus out of expr: the server adds the proficiency bonus, or rolls with Advantage when a skill they are proficient in applies as well. For anything that turns on understanding or speaking a language, pass language: a character who does not know it gets no roll at all.',
      inputSchema: {
        expr: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Dice notation, e.g. "1d20+5", "4d6kh3", "2d6+1d4". Required for damage and free rolls; leave it out for a check or a save named by skill, ability or save, which the server composes itself.',
          ),
        purpose: z.string().min(1).describe('What the roll is for, e.g. "Stealth check", "Longsword damage".'),
        dc: z.number().int().optional().describe('Difficulty class or target AC; omit for damage and free rolls.'),
        campaign_id: z.number().int().optional().describe('Omit only when no campaign is loaded yet.'),
        advantage: z
          .enum(['none', 'advantage', 'disadvantage'])
          .optional()
          .describe('Applies to d20 rolls only; the server rolls twice and keeps the right die.'),
        roll_type: z
          .enum(['attack', 'check', 'save', 'damage', 'other'])
          .optional()
          .describe(
            'What kind of roll this is; only "attack" turns a natural 20 into a critical hit and a natural 1 into a miss. Inferred from skill, ability or save; otherwise defaults to "other".',
          ),
        roller: z
          .enum(['player', 'dm'])
          .optional()
          .describe(
            'Who makes this roll. Pass "player" for every check, save and attack made by the player character or a companion: the player clicks the die in their window and the call waits for them, or the server rolls it after a few seconds. Use "dm" (the default) for monsters, hidden rolls and random determinations.',
          ),
        character_id: z
          .number()
          .int()
          .optional()
          .describe('Whose sheet the check, save, tools and languages are read from; the player character by default.'),
        skill: z
          .string()
          .optional()
          .describe(
            `The skill this check uses, e.g. "stealth". The server composes the whole d20 modifier from the sheet. One of: ${SKILL_KEYS.join(', ')}.`,
          ),
        save: ABILITY.optional().describe('The saving throw being made, e.g. "dex"; the server reads the save bonus off the sheet.'),
        ability: ABILITY.optional().describe('A raw ability check with no skill behind it, e.g. "str" to force a door.'),
        passive: z
          .boolean()
          .optional()
          .describe(
            'A passive check: 10 + the modifier, +5 with Advantage, -5 with Disadvantage. Needs skill or ability; rolls no dice and shows the player nothing.',
          ),
        contest: z
          .object({
            opponent: z
              .object({
                character_id: z.number().int().optional().describe('Another character in this campaign; their sheet is read.'),
                creature: z.string().optional().describe('An SRD creature by name; its stat block is read.'),
                bonus: z.number().int().optional().describe('The flat bonus the other side rolls with, when neither of the above fits.'),
                name: z.string().optional().describe('What to call the other side in the result, with bonus.'),
                skill: z.string().optional().describe('The skill the other side uses, when it differs from the character\'s.'),
                ability: ABILITY.optional().describe('The ability the other side uses, when it differs.'),
              })
              .describe('Required: exactly one of character_id, creature or bonus.'),
            skill: z.string().optional().describe("The skill the character's side uses; the top-level skill by default."),
            ability: ABILITY.optional().describe("The ability the character's side uses."),
            save: ABILITY.optional().describe("The save the character's side makes."),
          })
          .optional()
          .describe('A contest: both sides roll and the higher total wins. A tie means the situation stays as it was.'),
        group: z
          .array(z.number().int())
          .min(2)
          .optional()
          .describe(
            'A group check: the character ids that all try the same thing. Needs skill or ability and dc; the group succeeds when at least half of them do.',
          ),
        tool: z
          .string()
          .optional()
          .describe(
            'The tool used for this check, e.g. "Thieves\' Tools". Proficiency with it adds the proficiency bonus; if a skill they are proficient in also applies, the server rolls with Advantage instead. Leave the tool bonus out of expr.',
          ),
        language: z
          .string()
          .optional()
          .describe(
            'The language that has to be understood or spoken. A character who does not know it gets no roll at all: narrate what they fail to understand.',
          ),
        bardic_inspiration: z
          .boolean()
          .optional()
          .describe(
            'Spend the Bardic Inspiration die this character is holding on this d20 test. Pass dc as well: the die is only rolled when the test would otherwise fail, and once rolled it is expended - only Peerless Skill gets it back when the roll still fails.',
          ),
        dark_ones_luck: z
          .boolean()
          .optional()
          .describe(
            "Warlock 6 Dark One's Own Luck: add 1d10 to this ability check or saving throw. Pass dc as well - the die is only rolled when the test would otherwise fail, and only spent when it turns it.",
          ),
        boosts: z
          .array(z.string())
          .optional()
          .describe(
            'Homebrew clauses spent on this roll, by the boost id the reply lists in boosts_available. They are yours to spend for a companion or for a roll you make; the player chooses their own in their window.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      if (args.language && args.campaign_id !== undefined) {
        assertKnowsLanguage(db, args.campaign_id, args.character_id, args.language);
      }
      if (args.group) return groupCheck(db, args as ToolArgs);
      if (args.contest) return contestRoll(db, args as ToolArgs);
      if (args.passive) return passiveCheck(db, args as ToolArgs);

      const target = targetOf(args as ToolArgs);
      refusePlayersOwnBoosts(db, args as ToolArgs);
      // A named skill, ability or save is the server's to resolve; the exhaustion penalty is in it already.
      const composed = namesATest(target) ? composeFromSheet(db, args as ToolArgs, target) : null;
      // A condition that makes the save fail outright: no die is rolled, exactly as the combat path does.
      if (composed?.autoFail) {
        return reply(db, args.campaign_id ?? null, {
          purpose: args.purpose,
          roll_type: composed.args.roll_type,
          total: null,
          outcome: 'failure',
          auto_fail: composed.autoFail,
          // No die is rolled and nothing is spent, so the reply must not claim a boost or a rationed
          // clause was used: those notes describe a roll that never happened.
          rules_applied: [`${composed.autoFail}: the save fails automatically.`],
        });
      }
      const base = composed?.args ?? (args as ToolArgs);
      if (!base.expr) {
        throw new Error('Pass expr with the dice to roll, or name the skill, ability or save for the server to compose.');
      }
      const withTool = applyToolProficiency(db, base);
      // One net for the whole roll: the sheet's sources and the tool's own cancel each other as the rules say.
      const advantageSources = [
        ...(composed?.advantageSources ?? [base.advantage ?? 'none']),
        ...(withTool.advantage ? [withTool.advantage] : []),
      ];
      const advantage = netAdvantage(advantageSources);
      const netted = { ...withTool.args, advantage };
      const tired = composed ? { args: netted, note: null } : applyExhaustion(db, netted);
      const rules = [...(composed?.notes ?? []), withTool.note, tired.note].filter((line): line is string =>
        Boolean(line),
      );
      // The whole source list rides along, so a card boost re-nets it rather than folding into one enum.
      const result = await rollForTool(db, { ...tired.args, expr: tired.args.expr!, advantage_sources: advantageSources });
      // The use is spent once the roll stands, never at the declaration.
      if (composed?.spent.length) {
        spendComposed(db, args.campaign_id!, requirePc(db, args.campaign_id!, args.character_id), composed.spent);
      }
      // A Bardic Inspiration die or Dark One's Own Luck declared on this test, added after it is seen.
      const addOn = await addOnDie(db, tired.args, result);
      if (addOn) rules.push(addOn.note);
      const answer = reply(db, args.campaign_id ?? null, {
        ...(result as unknown as Record<string, unknown>),
        ...(addOn
          ? {
              total: addOn.total,
              ...(args.dc === undefined ? {} : { outcome: addOn.total >= args.dc ? 'success' : 'failure' }),
              feature_die: { spent: addOn.spent, note: addOn.note },
            }
          : {}),
        ...(composed?.fields ?? {}),
        ...(rules.length ? { rules_applied: rules } : {}),
      });
      // Spending inspiration is a rule, not a dial: the DM is told about it.
      const note = result.inspired
        ? `Heroic Inspiration spent (rerolled ${result.inspired.from} → ${result.inspired.to}).`
        : (rules.join(' ') || playerRollReminder(db, args));
      if (note) {
        const body = answer.content[0] as { type: 'text'; text: string };
        body.text = `${body.text}\n\n${note}`;
      }
      return answer;
    },
  );
}
