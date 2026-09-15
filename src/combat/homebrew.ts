// The interpreter: a homebrew feature's clauses compiled into a synthetic FeatureHandler the registry
// treats like any SRD one, plus the read-time passives the three sheet builders apply. Nothing here
// writes: a clause that fires hands the engine the same data an SRD feature does, and what the engine
// cannot run it hands back as a reminder.
import {
  describeClause,
  describeDo,
  doCapability,
  AUTO_STANCE_REASON,
  CONDITIONAL_CRIT_REASON,
  DIE_SURGERY_REASON,
  RIDER_HOOKS,
  SAVE_ENDS_REASON,
  type Clause,
  type ClauseAmount,
  type ClauseDo,
  type ClauseIf,
  type ClauseUses,
  type ClauseWhen,
} from '../core/mechanics.js';
import type { Ability } from '../core/rules.js';
import { CREATURE_TAGS } from '../srd/data.js';
import type {
  CastModifier,
  D20Stance,
  ResourcePeriod,
  FeatureAction,
  FeatureCost,
  FeatureHandler,
  FeatureOutcome,
  HealRider,
  HitRider,
  RiderWindow,
  RollSource,
} from './features.js';
import type { CombatSheet, SheetFeature } from './sheet.js';
import type { Combatant } from './state.js';
import { distanceBetween, distanceToPoint } from './grid.js';

/** A feature row as the clause reader sees it: its name, its counters and its clauses. */
export interface ClauseHolder {
  name: string;
  /** Where the row came from; a subclass bundle files each of its features under its own index. */
  source?: string;
  mechanics?: { resource?: string; max?: number; used?: number; homebrew_id?: number };
  clauses?: Clause[];
}

/**
 * As much of a sheet as a clause ever reads. A CombatSheet is one, and so is the character state the
 * out-of-combat rules work from, which is how the same clause answers both.
 */
export interface ClauseSheet {
  level: number;
  proficiency_bonus: number;
  abilities: Record<string, { score: number; mod: number } | undefined>;
  features: ClauseHolder[];
  inventory: Array<{ name: string; equipped?: boolean }>;
  /** The boosts chosen for this one call, by clause key; the engine has already spent them. */
  chosen_boosts?: string[];
}

/** What a clause could not be judged on, in the words the reminder carries. */
export interface ClauseBlock {
  reason: string;
}

/** Everything a hook knows about the moment it fires, normalised so one function can read an `if`. */
export interface ClauseCtx {
  sheet: ClauseSheet;
  actor?: Combatant;
  source?: 'spell' | 'weapon' | 'unarmed';
  damage_type?: string | null;
  weapon?: { melee: boolean; ranged: boolean; properties: string[]; mastery?: string };
  spell?: { name: string; school: string; level: number };
  skill?: string | null;
  ability?: string | null;
  save?: string | null;
  kind?: NonNullable<ClauseIf['kind']>;
  target?: Combatant;
  distance_ft?: number;
  /** A melee swing, a ranged one, or neither when the hook is not an attack. */
  melee?: boolean;
  /** The result is present only after the d20 has stood. */
  roll?: { natural: number | null; total: number; dc: number | null; success: boolean | null };
}

const lower = (value: string): string => value.trim().toLowerCase().replace(/[\s-]+/g, '_');

const listed = (values: string[] | undefined, value: string | null | undefined): boolean =>
  values === undefined || (value !== null && value !== undefined && values.some((v) => lower(v) === lower(value)));

/**
 * Whether a creature answers to one of the type words a clause names. The bundled stat blocks carry the
 * creature type and no tag line, so a tag is looked up in the transcribed SRD table instead: a Goblin
 * Warrior is a Fey (Goblinoid), which no amount of matching on the word "goblin" would tell you.
 */
function isOfType(target: Combatant | undefined, types: string[]): boolean {
  if (!target) return false;
  const type = lower(target.stat_block?.type ?? '');
  // Two of a kind on the field are "Goblin Warrior 1" and "Goblin Warrior 2"; the tag is on the name.
  const name = lower(target.name.replace(/\s+\d+$/, ''));
  return types.some((wanted) => {
    const want = lower(wanted);
    if (want !== '' && want === type) return true;
    return (CREATURE_TAGS[want] ?? []).some((entry) => lower(entry) === name);
  });
}

const conditionsOf = (who: Combatant | undefined): string[] => (who?.conditions ?? []).map(lower);

const bloodied = (who: Combatant | undefined): boolean =>
  who !== undefined && who.hp_max > 0 && who.hp_current * 2 <= who.hp_max;

/**
 * Whether the clause fires here: every `if` is AND-ed, an unknown field means it does not apply, and a
 * field the engine cannot judge at all - the light in the room, the result of a roll not yet made -
 * comes back as a block, which the hook turns into a reminder instead of an effect.
 */
export function clauseApplies(clause: Clause, ctx: ClauseCtx): { ok: boolean; blocked?: ClauseBlock } {
  const where = clause.if;
  if (!where) return { ok: true };
  if (where.light) return { ok: false, blocked: { reason: 'light is not modelled until R7' } };
  if (where.terrain_tag) return { ok: false, blocked: { reason: 'terrain is not modelled until R9' } };
  if (where.roll) {
    if (!ctx.roll) return { ok: false, blocked: { reason: 'this hook has no roll result to judge' } };
    const result = ctx.roll;
    if (where.roll.natural_min !== undefined) {
      if (result.natural === null) return { ok: false, blocked: { reason: 'this roll has no natural d20 to judge' } };
      if (result.natural < where.roll.natural_min) return { ok: false };
    }
    if (where.roll.failed !== undefined) {
      if (result.success === null) return { ok: false, blocked: { reason: 'this roll has no success result to judge' } };
      if (result.success === where.roll.failed) return { ok: false };
    }
    if (where.roll.succeeded !== undefined) {
      if (result.success === null) return { ok: false, blocked: { reason: 'this roll has no success result to judge' } };
      if (result.success !== where.roll.succeeded) return { ok: false };
    }
    if (where.roll.margin_at_least !== undefined) {
      if (result.dc === null) return { ok: false, blocked: { reason: 'this roll has no DC to judge its margin' } };
      if (result.total - result.dc < where.roll.margin_at_least) return { ok: false };
    }
  }
  if (where.target?.is_only_target) {
    return { ok: false, blocked: { reason: 'the engine does not count a spell\'s other targets here' } };
  }
  const self = where.self;
  if (self) {
    if (self.bloodied && !bloodied(ctx.actor)) return { ok: false };
    if (self.concentrating && !ctx.actor?.concentration) return { ok: false };
    if (self.raging && ctx.actor?.flags.raging === undefined) return { ok: false };
    if (self.condition?.length && !self.condition.every((c) => conditionsOf(ctx.actor).includes(lower(c)))) {
      return { ok: false };
    }
    if (self.wearing && !isWearing(ctx.sheet, self.wearing)) return { ok: false };
  }
  if (where.source && where.source !== 'any' && where.source !== ctx.source) return { ok: false };
  if (where.damage_type && !listed(where.damage_type, ctx.damage_type)) return { ok: false };
  if (where.weapon) {
    if (!ctx.weapon) return { ok: false };
    if (where.weapon.melee && !ctx.weapon.melee) return { ok: false };
    if (where.weapon.ranged && !ctx.weapon.ranged) return { ok: false };
    if (where.weapon.property?.length && !where.weapon.property.every((p) => ctx.weapon!.properties.includes(lower(p)))) {
      return { ok: false };
    }
    if (where.weapon.mastery && lower(where.weapon.mastery) !== lower(ctx.weapon.mastery ?? '')) return { ok: false };
  }
  if (where.spell) {
    if (!ctx.spell) return { ok: false };
    if (where.spell.school && lower(where.spell.school) !== lower(ctx.spell.school)) return { ok: false };
    if (where.spell.name && lower(where.spell.name) !== lower(ctx.spell.name)) return { ok: false };
    if (where.spell.level_min !== undefined && ctx.spell.level < where.spell.level_min) return { ok: false };
    if (where.spell.level_max !== undefined && ctx.spell.level > where.spell.level_max) return { ok: false };
  }
  if (where.skill?.length && !listed(where.skill, ctx.skill)) return { ok: false };
  if (where.ability?.length && !listed(where.ability, ctx.ability)) return { ok: false };
  if (where.save?.length && !listed(where.save, ctx.save)) return { ok: false };
  if (where.kind && where.kind !== ctx.kind) return { ok: false };
  const on = where.target;
  if (on) {
    if (!ctx.target) return { ok: false };
    if (on.type?.length && !isOfType(ctx.target, on.type)) return { ok: false };
    if (on.name_contains && !lower(ctx.target.name).includes(lower(on.name_contains))) return { ok: false };
    if (on.size && lower(ctx.target.stat_block?.size ?? '') !== lower(on.size)) return { ok: false };
    if (on.condition?.length && !on.condition.every((c) => conditionsOf(ctx.target).includes(lower(c)))) {
      return { ok: false };
    }
    if (on.bloodied && !bloodied(ctx.target)) return { ok: false };
    if (on.within_ft !== undefined && (ctx.distance_ft ?? Infinity) > on.within_ft) return { ok: false };
  }
  if (where.range === 'melee' && ctx.melee !== true) return { ok: false };
  if (where.range === 'ranged' && ctx.melee !== false) return { ok: false };
  if (typeof where.range === 'object' && (ctx.distance_ft ?? Infinity) > where.range.within_ft) return { ok: false };
  return { ok: true };
}

/** Armour, no armour or a Shield, off what is equipped: what `if.self.wearing` asks about. */
function isWearing(sheet: ClauseSheet, what: 'armor' | 'no_armor' | 'shield'): boolean {
  const worn = sheet.inventory.filter((item) => item.equipped).map((item) => lower(item.name));
  const shield = worn.some((name) => name.includes('shield'));
  const armor = worn.some((name) => /armor|mail|plate|leather|breastplate/.test(name));
  if (what === 'shield') return shield;
  return what === 'armor' ? armor : !armor;
}

// --- the numbers a clause names ----------------------------------------------

/** What a scaling token is worth on this sheet: the character's own level, half of it, or their proficiency. */
function tokenValue(sheet: ClauseSheet, token: string): number {
  if (token === 'level') return sheet.level;
  if (token === 'half_level') return Math.floor(sheet.level / 2);
  return sheet.proficiency_bonus;
}

/** A dice string with its scaling tokens resolved: "1d10+level" on a level 4 sheet is "1d10+4". */
export function resolveDice(sheet: ClauseSheet, dice: string): string {
  const resolved = dice.replace(/(half_level|level|prof)/gi, (token) => String(tokenValue(sheet, token.toLowerCase())));
  // "half_level" on its own is a number, not dice; the engine reads either.
  return resolved.trim();
}

/** What a clause amount comes to: a flat number, or null when it is dice the hook has to roll. */
export function flatAmount(sheet: ClauseSheet, amount: ClauseAmount): number | null {
  if (typeof amount === 'number') return amount;
  const token = lower(amount);
  if (token === 'prof') return sheet.proficiency_bonus;
  if (token === 'half_prof') return Math.floor(sheet.proficiency_bonus / 2);
  if (token === 'level' || token === 'half_level') return tokenValue(sheet, token);
  if (token.startsWith('ability:')) return sheet.abilities[token.slice('ability:'.length)]?.mod ?? 0;
  const resolved = resolveDice(sheet, amount);
  return /d\d/i.test(resolved) ? null : Number(resolved) || 0;
}

// --- uses --------------------------------------------------------------------

/** The resource key one clause of one feature spends: `homebrew:<id>:<n>`. */
export const clauseResourceKey = (index: string, clause: number): string => `${index}:${clause}`;

const usesRow = (sheet: ClauseSheet, key: string): { max: number; used: number } | null => {
  const row = sheet.features.find((f) => f.mechanics?.resource === key);
  return row?.mechanics ? { max: row.mechanics.max ?? 0, used: row.mechanics.used ?? 0 } : null;
};

/** How many uses a clause has, or null when it costs no resource at all. */
export function clauseUsesMax(sheet: ClauseSheet, uses: ClauseUses): { max: number; per: ResourcePeriod } | null {
  // once_ever means what it says: no rest gives it back, which is what the never period is for.
  if (typeof uses === 'string') return uses === 'once_ever' ? { max: 1, per: 'never' } : null;
  if ('charges' in uses) {
    if (uses.charges.recharge === 'never') return { max: uses.charges.max, per: 'never' };
    return { max: uses.charges.max, per: uses.charges.recharge === 'short' ? 'short' : 'long' };
  }
  return { max: uses.count === 'prof' ? sheet.proficiency_bonus : uses.count, per: uses.per };
}

/** What is left of a clause's uses; an unlimited clause always has one more. */
export function clauseUsesLeft(sheet: ClauseSheet, uses: ClauseUses, key: string): number {
  const spec = clauseUsesMax(sheet, uses);
  if (!spec) return Infinity;
  const row = usesRow(sheet, key);
  return Math.max(0, (row?.max ?? spec.max) - (row?.used ?? 0));
}

/** Whether a once-a-turn clause has already fired for this creature this turn. */
const spentThisTurn = (actor: Combatant | undefined, key: string): boolean =>
  (actor?.flags.homebrew_used ?? []).includes(key);

const oncePerTurn = (uses: ClauseUses): boolean => uses === 'once_per_turn' || uses === 'once_per_round';

// --- compiling ---------------------------------------------------------------

const WINDOWS: Record<Extract<ClauseDo, { kind: 'condition' }>['until'], RiderWindow> = {
  end_of_target_next_turn: 'end_of_its_next_turn',
  end_of_your_next_turn: 'end_of_your_next_turn',
  start_of_your_next_turn: 'start_of_your_next_turn',
  // "N rounds" carries its own count beside the window, which is what the effect row is written from.
  rounds: 'manual',
  save_ends: 'manual',
};

/**
 * The index a compiled handler is filed under: `homebrew:<id>`, or the feature's own name for an item.
 * Every feature of a subclass bundle points at the same library row, so each one takes its own name
 * too - otherwise the registry would hold the level 3 feature and drop the level 6 one.
 */
export function homebrewIndex(feature: ClauseHolder): string {
  const id = feature.mechanics?.homebrew_id;
  const base = `homebrew:${id ?? lower(feature.name)}`;
  return id !== undefined && feature.source === 'subclass' ? `${base}:${lower(feature.name)}` : base;
}

/** One boost the player or the DM may spend on a roll, as the roll card and the tool reply carry it. */
export interface RollBoost {
  id: string;
  name: string;
  describe: string;
  uses_left: number;
  /** What it does to the roll: Advantage, or a flat bonus added to the expression. */
  advantage: boolean;
  bonus: number;
  /** The resource row behind it, so whoever spends the use can write it without the registry. */
  label: string;
  max: number;
  per: ResourcePeriod;
  /** A rider chosen before the swing: the use rides on the rider and a miss costs nothing. */
  spend_on_fire?: boolean;
  /** The hook it rides on, so the reply can say what taking it buys. */
  when: ClauseWhen;
}

/**
 * Whether this clause is the player's to choose before the roll, the swing or the casting. Decision 1:
 * only "you can" is theirs; an `auto` clause with uses to spend fires by itself and pays for itself.
 */
export const isBoost = (clause: Clause): boolean =>
  clause.decide === 'ask_before' &&
  (clause.when === 'roll' || clause.when === 'cast' || RIDER_HOOKS.includes(clause.when));

/** A boost paid for where it lands rather than at the choice: a rider on a blow, and one on a casting. */
const spendsOnFire = (when: ClauseWhen): boolean => when === 'cast' || RIDER_HOOKS.includes(when);

/** The hooks a moment can pay for: a roll on its own, or a roll and the riders the blow may carry. */
export const ROLL_HOOK: ClauseWhen[] = ['roll'];

interface Compiled {
  feature: SheetFeature;
  clauses: Array<{ clause: Clause; at: number; key: string; note: string }>;
}

/**
 * The name of the row a clause's uses are counted on. One counter is the feature's own row, so the uses
 * sit on the feature the player reads; a feature with two counters gets one row for each.
 */
export function clauseLabel(feature: ClauseHolder, at: number): string {
  const counters = (feature.clauses ?? []).filter((clause) => typeof clause.uses !== 'string' || clause.uses === 'once_ever');
  return counters.length > 1 ? `${feature.name} #${at + 1}` : feature.name;
}

const noteOf = (feature: SheetFeature, clause: Clause): string =>
  `${feature.name}: ${clause.do.map(describeDo).join(', ')}`;

function clausesOf(feature: SheetFeature): Compiled {
  const index = homebrewIndex(feature);
  return {
    feature,
    clauses: (feature.clauses ?? []).map((clause, at) => ({
      clause,
      at,
      key: clauseResourceKey(index, at),
      note: noteOf(feature, clause),
    })),
  };
}

/** A reminder rider: the clause fired, the engine could not run it, and the DM is told at the hook. */
const remind = (feature: string, clause: Clause, reason: string): HitRider => ({
  kind: 'note',
  feature,
  note: `${feature}: ${describeClause(clause)} - ${reason}`,
  reminder: reason,
});

/** Whether the DM or the player chose this clause for this call, when the clause is theirs to choose. */
const chosen = (sheet: ClauseSheet, key: string): boolean => (sheet.chosen_boosts ?? []).includes(key);

/**
 * The riders one clause puts on a hit, a miss or a spell's damage. The uses are checked here and spent by
 * the engine when the rider lands, which is the order everything else in the registry keeps.
 */
function ridersOf(entry: Compiled['clauses'][number], feature: SheetFeature, ctx: ClauseCtx): HitRider[] {
  const { clause, key, note } = entry;
  const name = feature.name;
  const verdict = clauseApplies(clause, ctx);
  if (verdict.blocked) return [remind(name, clause, verdict.blocked.reason)];
  if (!verdict.ok) return [];
  if (clause.decide === 'dm') return [remind(name, clause, 'this one is yours to apply')];
  // Decision 1: what the prose says the player *can* do is theirs to take, and at a rider hook the
  // choice is made before the swing - so an unchosen one is on offer as a boost, not applied here.
  if (clause.decide === 'ask_after') {
    return [remind(name, clause, 'nothing asks you after the blow: declare this one before the swing')];
  }
  if (isBoost(clause) && !chosen(ctx.sheet, key)) return [];
  if (oncePerTurn(clause.uses) && spentThisTurn(ctx.actor, key)) return [];
  const left = clauseUsesLeft(ctx.sheet, clause.uses, key);
  if (left <= 0) return [];
  const spec = clauseUsesMax(ctx.sheet, clause.uses);
  const riders: HitRider[] = [];
  for (const what of clause.do) {
    switch (what.kind) {
      case 'extra_damage':
        riders.push({
          kind: 'damage',
          feature: name,
          dice: resolveDice(ctx.sheet, what.dice),
          damage_type: !what.type || what.type === 'same' ? (ctx.damage_type ?? null) : what.type,
          note: `${note}.`,
        });
        break;
      case 'bonus': {
        const flat = what.to === 'damage' ? flatAmount(ctx.sheet, what.amount) : null;
        if (what.to === 'damage' && flat !== null) {
          riders.push({
            kind: 'damage',
            feature: name,
            dice: String(flat),
            damage_type: ctx.damage_type ?? null,
            note: `${note}.`,
          });
        } else if (what.to === 'damage') {
          riders.push({
            kind: 'damage',
            feature: name,
            dice: resolveDice(ctx.sheet, String(what.amount)),
            damage_type: ctx.damage_type ?? null,
            note: `${note}.`,
          });
        } else {
          riders.push(remind(name, clause, `a bonus to ${what.to} does not land on a hit`));
        }
        break;
      }
      case 'condition':
        if (what.until === 'save_ends') {
          riders.push(remind(name, clause, SAVE_ENDS_REASON));
          break;
        }
        riders.push({
          kind: 'condition',
          feature: name,
          condition: lower(what.name),
          ends: WINDOWS[what.until],
          ...(what.until === 'rounds' ? { rounds: what.rounds ?? 1 } : {}),
          note: `${note}.`,
        });
        break;
      case 'mark_target':
        riders.push({ kind: 'condition', feature: name, condition: 'marked', ends: 'manual', note: `${note}.` });
        break;
      case 'push_ft':
        riders.push({ kind: 'push', feature: name, ft: what.amount, note: `${note}.` });
        break;
      case 'move_ft':
        riders.push({ kind: 'move', feature: name, ft: what.amount, note: `${note}.` });
        break;
      case 'temp_hp': {
        const amount = what.amount ?? flatAmount(ctx.sheet, what.dice ?? 0);
        if (amount === null) riders.push(remind(name, clause, 'temporary hit points in dice are rolled by you here'));
        else riders.push({ kind: 'temp_hp', feature: name, amount, on: 'self', note: `${note}.` });
        break;
      }
      case 'note':
        riders.push(remind(name, clause, what.text));
        break;
      case 'min_die':
      case 'max_damage_dice':
        riders.push(remind(name, clause, DIE_SURGERY_REASON));
        break;
      default:
        riders.push(remind(name, clause, `${describeDo(what)} does not land at this hook`));
    }
  }
  const real = riders.filter((rider) => rider.kind !== 'note');
  if (real.length === 0) return riders;
  // Plan, validate, spend, apply: the use rides on the first rider, so nothing is paid for a clause
  // whose riders were all refused above. A rationed rider lands on the first target of a casting and
  // no other - "one creature damaged by that spell" - so every rider of it is marked once per cast.
  if (spec) {
    real[0]!.spend = { resource: key, amount: 1 };
    for (const rider of real) rider.once_per_cast = true;
  }
  if (oncePerTurn(clause.uses)) {
    riders.push({
      kind: 'stance',
      feature: name,
      on: 'self',
      flags: { homebrew_used: [...(ctx.actor?.flags.homebrew_used ?? []), key] },
      note: `${name} is spent for this turn.`,
    });
  }
  return riders;
}

/**
 * Whether this clause applies itself at a roll: the `if` fits, it is not the DM's or a declared
 * stance, and either it is free, it was chosen, or it is an automatic clause with a use left.
 * Decision 1: `auto` fires by itself and pays for itself; `ask_before` waits to be taken.
 */
function firesOnRoll(entry: Compiled['clauses'][number], ctx: ClauseCtx): boolean {
  const { clause, key } = entry;
  const verdict = clauseApplies(clause, ctx);
  if (!verdict.ok || clause.decide === 'dm' || clause.decide === 'ask_after') return false;
  if (isBoost(clause)) return chosen(ctx.sheet, key);
  if (oncePerTurn(clause.uses) && spentThisTurn(ctx.actor, key)) return false;
  return clauseUsesLeft(ctx.sheet, clause.uses, key) > 0;
}

/** What a clause that fires by itself costs, so the engine spends it where the roll is made. */
function rollSpend(entry: Compiled['clauses'][number], ctx: ClauseCtx): Pick<RollSource, 'spend'> {
  const { clause, key } = entry;
  // A chosen boost was already paid for at the choice; only an automatic clause pays here.
  if (isBoost(clause) || clauseUsesMax(ctx.sheet, clause.uses) === null) return {};
  return { spend: { resource: key, amount: 1 } };
}

/** The two bonus targets the d20 itself carries; a check's own is added by checkBonus instead. */
const landsOnRoll = (to: string, kind: ClauseCtx['kind']): boolean =>
  (to === 'attack' && kind === 'attack') || (to === 'save' && kind === 'save');

/** Advantage, Disadvantage and the flat bonuses a `roll` clause puts on a D20 Test. */
function rollSourcesOf(entry: Compiled['clauses'][number], feature: SheetFeature, ctx: ClauseCtx): RollSource[] {
  const { clause, note } = entry;
  if (!firesOnRoll(entry, ctx)) return [];
  const cost = rollSpend(entry, ctx);
  const out: RollSource[] = [];
  for (const what of clause.do) {
    if (what.kind === 'advantage') out.push({ advantage: 'advantage', note, feature: feature.name });
    else if (what.kind === 'disadvantage') out.push({ advantage: 'disadvantage', note, feature: feature.name });
    else if (what.kind === 'bonus' && landsOnRoll(what.to, ctx.kind)) {
      const flat = flatAmount(ctx.sheet, what.amount) ?? 0;
      if (flat !== 0) out.push({ advantage: 'none', note, feature: feature.name, bonus: flat });
    }
  }
  // A clause whose only gift is a number on a check is applied by checkBonus and paid for here, which
  // is the one seam a roll has for a spend. The check reads its uses before this source is charged.
  const onCheck = ctx.kind === 'check' || ctx.kind === 'initiative';
  const onThisCheck = (what: ClauseDo): boolean =>
    what.kind === 'bonus' && (what.to === 'check' || (what.to === 'initiative' && ctx.kind === 'initiative'));
  if (out.length === 0 && onCheck && cost.spend && clause.do.some(onThisCheck)) {
    out.push({ advantage: 'none', note, feature: feature.name });
  }
  if (out.length > 0) Object.assign(out[0]!, cost);
  return out;
}

/** The flat bonus a `roll` clause adds to an ability check, a save or Initiative the engine rolls. */
function checkBonusOf(entry: Compiled['clauses'][number], ctx: ClauseCtx): { bonus: number; note: string } | null {
  const { clause, note } = entry;
  if (!firesOnRoll(entry, ctx)) return null;
  let bonus = 0;
  for (const what of clause.do) {
    if (what.kind !== 'bonus') continue;
    // A save bonus rides on the d20 itself; this hook is only asked about checks and Initiative.
    const lands = what.to === 'check' || (what.to === 'initiative' && ctx.kind === 'initiative');
    if (!lands) continue;
    bonus += flatAmount(ctx.sheet, what.amount) ?? 0;
  }
  return bonus === 0 ? null : { bonus, note };
}

/** What a `roll` clause with `bonus {to: heal}` adds to the hit points a spell restores. */
function healRiderOf(entry: Compiled['clauses'][number], feature: SheetFeature, ctx: ClauseCtx): HealRider[] {
  const { clause, note } = entry;
  if (!firesOnRoll(entry, ctx)) return [];
  let bonus = 0;
  for (const what of clause.do) {
    if (what.kind === 'bonus' && what.to === 'heal') bonus += flatAmount(ctx.sheet, what.amount) ?? 0;
  }
  if (bonus === 0) return [];
  // A rationed rider lands on the first creature the casting heals and no other, as a damage one does.
  const once = clauseUsesMax(ctx.sheet, clause.uses) ? { once_per_cast: true } : {};
  return [{ feature: feature.name, note: `${note}.`, bonus, ...once, ...rollSpend(entry, ctx) }];
}

/**
 * What the d20 hooks already did with this clause by the time an outcome hook sees it: Advantage and
 * a reroll declared on a `roll` clause, and the number a `when: initiative` clause puts on the roll.
 * Applied there, so this hook neither repeats it nor hands it back.
 */
const appliedOnTheD20 = (clause: Clause, what: ClauseDo): boolean =>
  (what.kind === 'bonus' && what.to === 'initiative') ||
  (clause.when === 'roll' && (what.kind === 'advantage' || what.kind === 'disadvantage' || what.kind === 'reroll'));

/** What an `action`, a `kill`, a turn edge or an Initiative clause hands the engine to apply. */
function outcomeOf(
  entry: Compiled['clauses'][number],
  feature: SheetFeature,
  ctx: ClauseCtx,
  economy: FeatureOutcome['economy'],
): FeatureOutcome | null {
  const { clause, key, note } = entry;
  const name = feature.name;
  const verdict = clauseApplies(clause, ctx);
  const notes: string[] = [];
  if (verdict.blocked) return { economy, text: `${name}: ${describeClause(clause)}`, notes: [reminderLine(name, clause, verdict.blocked.reason)] };
  if (!verdict.ok) return null;
  if (clause.decide === 'dm') {
    return { economy, text: name, notes: [reminderLine(name, clause, 'this one is yours to apply')] };
  }
  // Taking an action is already the choice; at every other hook a "you can" clause is offered, not taken.
  if (clause.when !== 'action' && clause.decide !== 'auto') {
    if (!isBoost(clause)) {
      return {
        economy,
        text: name,
        notes: [reminderLine(name, clause, 'the player chooses this one: apply it if they take it')],
      };
    }
    if (!chosen(ctx.sheet, key)) return null;
  }
  if (oncePerTurn(clause.uses) && spentThisTurn(ctx.actor, key)) return null;
  if (clauseUsesLeft(ctx.sheet, clause.uses, key) <= 0) return null;
  const spec = clauseUsesMax(ctx.sheet, clause.uses);
  const outcome: FeatureOutcome = { economy, text: note };
  let applied = false;
  for (const what of clause.do) {
    // A note is a reminder in the DM's own words, whatever hook it rides on.
    if (what.kind === 'note') {
      notes.push(reminderLine(name, clause, what.text));
      continue;
    }
    // Per verb and per hook: what this hook has no seam for comes back as a reminder, never as a spend.
    const capability = doCapability(clause, what);
    if (capability.status !== 'runs') {
      notes.push(reminderLine(name, clause, capability.reason ?? `${describeDo(what)} is yours to apply here`));
      continue;
    }
    if (appliedOnTheD20(clause, what)) continue;
    switch (what.kind) {
      case 'temp_hp': {
        const amount = what.amount ?? null;
        if (amount === null && what.dice) outcome.temp_hp_expr = resolveDice(ctx.sheet, what.dice);
        else outcome.temp_hp_amount = amount ?? 0;
        applied = true;
        break;
      }
      case 'extra_heal':
        outcome.heal_expr = resolveDice(ctx.sheet, what.dice);
        applied = true;
        break;
      case 'move_ft':
        outcome.movement_ft = what.amount;
        applied = true;
        break;
      case 'grant_inspiration':
        outcome.grant_inspiration = true;
        applied = true;
        break;
      case 'remove_condition':
        outcome.remove_conditions = [...(outcome.remove_conditions ?? []), lower(what.name)];
        applied = true;
        break;
      case 'free_standard_action':
        outcome.standard = [...(outcome.standard ?? []), what.name];
        applied = true;
        break;
      case 'extra_action':
        outcome.flags = { ...outcome.flags, action_surged: true };
        applied = true;
        break;
      case 'recover_slot':
        outcome.gain_slot = what.level;
        applied = true;
        break;
      case 'recover_resource': {
        const amount = flatAmount(ctx.sheet, what.amount);
        if (amount === null) notes.push(reminderLine(name, clause, 'a resource comes back in whole numbers here'));
        else {
          outcome.restore_resource = { key: what.key, amount };
          applied = true;
        }
        break;
      }
      case 'condition':
        outcome.self_condition = { name: lower(what.name), rounds: what.rounds ?? 1 };
        applied = true;
        break;
      case 'effect':
        outcome.action_effect = {
          effect: what.effect,
          concentration: what.concentration ?? false,
          duration_rounds: what.duration_rounds ?? what.effect.condition?.duration_rounds ?? null,
          range_ft:
            typeof clause.if?.range === 'object'
              ? clause.if.range.within_ft
              : clause.if?.range === 'melee'
                ? 5
                : (clause.if?.target?.within_ft ?? null),
        };
        applied = true;
        break;
      default:
        notes.push(reminderLine(name, clause, `${describeDo(what)} is yours to apply here`));
    }
  }
  if (notes.length) outcome.notes = notes;
  if (!applied) return notes.length ? outcome : null;
  if (spec) outcome.spend = { resource: key, amount: 1 };
  return outcome;
}

const reminderLine = (feature: string, clause: Clause, reason: string): string =>
  `${feature}: ${describeClause(clause)} - ${reason}`;

/**
 * One homebrew feature as a handler the registry can ask. The index is `homebrew:<id>`, the level is 0
 * because the sheet already decided the character has it, and every hook reads the same clause list.
 */
export function compileHomebrew(feature: SheetFeature, sheet?: CombatSheet): FeatureHandler | null {
  const clauses = feature.clauses ?? [];
  if (clauses.length === 0) return null;
  const index = homebrewIndex(feature);
  const compiled = clausesOf(feature);
  const at = (when: Clause['when'] | Clause['when'][]): Compiled['clauses'] =>
    compiled.clauses.filter((entry) => (Array.isArray(when) ? when : [when]).includes(entry.clause.when));

  const rollClauses = at('roll');
  const damageClauses = [...at('hit'), ...at('damage_dealt')];
  const spellClauses = [...at('spell_damage'), ...at('damage_dealt')];
  const missClauses = at('miss');
  const damageTakenClauses = at('damage_taken');
  const saveSucceededClauses = at('save_succeeded');
  const killClauses = at('kill');
  const castClauses = at('cast');
  const startClauses = at('turn_start');
  const endClauses = at('turn_end');
  const initiativeClauses = [...at('initiative'), ...rollClauses.filter((e) => e.clause.if?.kind === 'initiative')];
  const actionClauses = at('action');
  // A stance is declared before a D20 Test; a reroll of damage dice is not one, and reminds instead.
  const stanceClauses = rollClauses.filter(
    (entry) => entry.clause.decide === 'ask_after' && entry.clause.if?.kind !== 'damage',
  );
  // A reroll or a raised die on the damage roll: nothing reaches between the dice and the total, so
  // these hand the line back at the moment the damage is rolled.
  const surgeryClauses = rollClauses.filter((entry) =>
    entry.clause.do.some(
      (what) => doCapability(entry.clause, what).reason === DIE_SURGERY_REASON,
    ),
  );
  const healClauses = rollClauses.filter((entry) =>
    entry.clause.do.some((what) => what.kind === 'bonus' && what.to === 'heal'),
  );
  // An automatic reroll arms itself on every qualifying roll rather than waiting to be declared. Only
  // `if.kind` can be judged before the roll: one narrowed by anything else is handed back at the swing.
  const rerollClauses = rollClauses.filter(
    (entry) => entry.clause.decide === 'auto' && entry.clause.do.some((what) => what.kind === 'reroll'),
  );
  const judgedBeforeTheRoll = (entry: Compiled['clauses'][number]): boolean =>
    Object.keys(entry.clause.if ?? {}).every((where) => where === 'kind');
  const autoRerollClauses = rerollClauses.filter(judgedBeforeTheRoll);
  const stanceReminderClauses = rerollClauses.filter((entry) => !judgedBeforeTheRoll(entry));
  // A `when: initiative` clause that adds to the roll belongs on the Initiative d20 itself.
  const initiativeBonusClauses = at('initiative').filter((entry) =>
    entry.clause.do.some((what) => what.kind === 'bonus' && what.to === 'initiative'),
  );

  const resources = compiled.clauses
    .map((entry) => ({ entry, spec: sheet ? clauseUsesMax(sheet, entry.clause.uses) : null }))
    .filter((row) => row.spec !== null);

  const handler: FeatureHandler = {
    index,
    name: feature.name,
    class: sheet?.class_index ?? 'any',
    level: 0,
    resources: (on: CombatSheet) =>
      compiled.clauses.flatMap((entry) => {
        const spec = clauseUsesMax(on, entry.clause.uses);
        return spec ? [{ key: entry.key, label: clauseLabel(feature, entry.at), per: spec.per, max: spec.max }] : [];
      }),
  };
  // One clause with uses is the feature's own counter, so the sheet and the window can show it.
  if (resources.length === 1) {
    const only = resources[0]!.entry;
    handler.resource = {
      key: only.key,
      label: clauseLabel(feature, only.at),
      per: resources[0]!.spec!.per,
      max: (on: CombatSheet) => clauseUsesMax(on, only.clause.uses)?.max ?? 0,
    };
  }

  if (rollClauses.length > 0) {
    handler.beforeAttack = (ask) =>
      rollClauses.flatMap((entry) =>
        rollSourcesOf(entry, feature, {
          sheet: ask.sheet,
          actor: ask.actor,
          kind: 'attack',
          target: ask.target,
          distance_ft: ask.distance_ft,
          melee: ask.melee,
          source: ask.weapon ? 'weapon' : 'unarmed',
          ability: ask.ability,
          weapon: weaponCtx(ask.weapon, ask.melee),
        }),
      );
    handler.beforeSave = (ask) =>
      rollClauses.flatMap((entry) =>
        rollSourcesOf(entry, feature, { sheet: ask.sheet, actor: ask.actor, kind: 'save', save: ask.ability, ability: ask.ability }),
      );
  }

  if (rollClauses.length > 0 || initiativeBonusClauses.length > 0) {
    // The Initiative roll is a check, and a clause written at the Initiative hook rides on it here.
    const onCheck = (initiative: boolean): Compiled['clauses'] => [
      ...rollClauses,
      ...(initiative ? initiativeBonusClauses : []),
    ];
    handler.beforeCheck = (ask) =>
      onCheck(ask.initiative === true).flatMap((entry) =>
        rollSourcesOf(entry, feature, {
          sheet: ask.sheet,
          actor: ask.actor,
          kind: ask.initiative ? 'initiative' : 'check',
          skill: ask.skill ?? null,
          ability: ask.ability,
        }),
      );
    handler.checkBonus = (ask) =>
      onCheck(ask.initiative === true).reduce<{ bonus: number; note: string } | null>((found, entry) => {
        if (found) return found;
        return checkBonusOf(entry, {
          sheet: ask.sheet,
          actor: ask.actor,
          kind: ask.initiative ? 'initiative' : 'check',
          skill: ask.skill ?? null,
          ability: ask.ability,
        });
      }, null);
  }

  // The sheet carries one crit range and the attack reads it off: an unconditional clause sets it, and
  // one the DM narrowed or rationed cannot, so it comes back at the swing instead.
  const critClause = compiled.clauses.find((entry) => entry.clause.do.some((what) => what.kind === 'crit_range'));
  if (critClause) {
    const range = critClause.clause.do.find((what) => what.kind === 'crit_range');
    const conditional = critClause.clause.if !== undefined || critClause.clause.uses !== 'unlimited';
    if (range?.kind === 'crit_range' && !conditional) handler.critRange = () => range.min;
  }

  // A crit range the sheet could not take, handed back on the swing it would have widened.
  const critReminder = (): HitRider[] =>
    critClause && !handler.critRange ? [remind(feature.name, critClause.clause, CONDITIONAL_CRIT_REASON)] : [];
  // The damage roll is this same moment: a clause that says `kind: damage` is about these dice, so the
  // kind is taken as read rather than compared against the attack the hit came from.
  const surgeryReminders = (ctx: ClauseCtx): HitRider[] =>
    surgeryClauses.flatMap((entry) => {
      const verdict = clauseApplies(entry.clause, { ...ctx, kind: entry.clause.if?.kind ?? ctx.kind });
      if (verdict.blocked) return [remind(feature.name, entry.clause, verdict.blocked.reason)];
      return verdict.ok ? [remind(feature.name, entry.clause, DIE_SURGERY_REASON)] : [];
    });
  // A reroll narrowed by more than the kind of roll: the stance is armed before the roll, where none of
  // what narrows it is known, so nothing is armed and the line comes back on the swing instead.
  const stanceReminders = (): HitRider[] =>
    stanceReminderClauses.map((entry) => remind(feature.name, entry.clause, AUTO_STANCE_REASON));

  if (damageClauses.length > 0 || surgeryClauses.length > 0 || critClause || stanceReminderClauses.length > 0) {
    handler.onHit = (ask) => {
      const ctx: ClauseCtx = {
        sheet: ask.sheet,
        actor: ask.actor,
        target: ask.target,
        damage_type: ask.damage_type,
        distance_ft: ask.distance_ft,
        melee: ask.melee,
        source: ask.weapon ? 'weapon' : 'unarmed',
        weapon: weaponCtx(ask.weapon, ask.melee),
        kind: 'attack',
        roll: ask.roll,
      };
      return [
        ...damageClauses.flatMap((entry) => ridersOf(entry, feature, ctx)),
        ...surgeryReminders(ctx),
        ...critReminder(),
        ...stanceReminders(),
      ];
    };
  }
  if (missClauses.length > 0) {
    handler.onMiss = (ask) =>
      missClauses.flatMap((entry) =>
        ridersOf(entry, feature, {
          sheet: ask.sheet,
          actor: ask.actor,
          target: ask.target,
          damage_type: ask.damage_type,
          distance_ft: ask.distance_ft,
          melee: ask.melee,
          weapon: weaponCtx(ask.weapon, ask.melee),
          kind: 'attack',
          roll: ask.roll,
        }),
      );
  }
  if (spellClauses.length > 0 || surgeryClauses.length > 0) {
    handler.onSpellDamage = (ask) => {
      const ctx: ClauseCtx = {
        sheet: ask.sheet,
        actor: ask.actor,
        target: ask.target,
        damage_type: ask.damage_type,
        source: 'spell',
        spell: { name: ask.spell.name, school: ask.spell.school, level: ask.spell.level },
      };
      return [...spellClauses.flatMap((entry) => ridersOf(entry, feature, ctx)), ...surgeryReminders(ctx)];
    };
  }
  if (healClauses.length > 0) {
    handler.onHeal = (ask) =>
      healClauses.flatMap((entry) =>
        healRiderOf(entry, feature, {
          sheet: ask.sheet,
          actor: ask.actor,
          target: ask.target,
          source: 'spell',
          kind: 'heal',
          spell: { name: ask.spell.name, school: ask.spell.school, level: ask.spell.level },
        }),
      );
  }
  if (damageTakenClauses.length > 0) {
    handler.onDamageTakenOutcome = (ask) =>
      damageTakenClauses.reduce<FeatureOutcome | null>(
        (found, entry) => found ?? outcomeOf(entry, feature, {
          sheet: ask.sheet, actor: ask.actor, target: ask.attacker, damage_type: ask.damage_type, distance_ft: ask.distance_ft,
        }, 'free'),
        null,
      );
  }
  if (saveSucceededClauses.length > 0) {
    handler.onSaveSucceededOutcome = (ask) =>
      saveSucceededClauses.reduce<FeatureOutcome | null>(
        (found, entry) => found ?? outcomeOf(entry, feature, {
          sheet: ask.sheet, actor: ask.actor, target: ask.target, source: 'spell',
          spell: { name: ask.spell.name, school: ask.spell.school, level: ask.spell.level }, roll: ask.roll,
        }, 'free'),
        null,
      );
  }
  if (autoRerollClauses.length > 0) {
    // Decision 1 again: an automatic reroll is not declared, so it is armed on every roll it fits.
    handler.autoStance = (on, kind) => {
      for (const entry of autoRerollClauses) {
        const wanted = entry.clause.if?.kind;
        if (wanted !== undefined && wanted !== kind) continue;
        if (clauseUsesLeft(on, entry.clause.uses, entry.key) <= 0) continue;
        const spec = clauseUsesMax(on, entry.clause.uses);
        return {
          feature: feature.name,
          mode: 'reroll',
          on: [kind],
          ...(spec ? { spend: { resource: entry.key, amount: 1 } as FeatureCost } : {}),
        };
      }
      return null;
    };
  }
  if (killClauses.length > 0) {
    handler.onKill = (ask) =>
      killClauses.reduce<FeatureOutcome | null>(
        (found, entry) =>
          found ??
          outcomeOf(entry, feature, { sheet: ask.sheet, actor: ask.actor, target: ask.victim, distance_ft: ask.distance_ft }, 'free'),
        null,
      );
  }
  if (castClauses.length > 0) {
    handler.beforeCast = (ask) =>
      castClauses.flatMap((entry) => castModifiersOf(entry, feature, ask.sheet, ask.actor, ask.spell));
  }
  if (startClauses.length > 0) {
    handler.turnStart = (ask) =>
      startClauses.reduce<FeatureOutcome | null>(
        (found, entry) => found ?? outcomeOf(entry, feature, { sheet: ask.sheet, actor: ask.actor }, 'free'),
        null,
      );
  }
  if (endClauses.length > 0) {
    handler.turnEnd = (ask) =>
      endClauses.reduce<FeatureOutcome | null>(
        (found, entry) => found ?? outcomeOf(entry, feature, { sheet: ask.sheet, actor: ask.actor }, 'free'),
        null,
      );
  }
  if (initiativeClauses.length > 0) {
    handler.onInitiative = (ask) =>
      initiativeClauses.reduce<FeatureOutcome | null>(
        (found, entry) =>
          found ?? outcomeOf(entry, feature, { sheet: ask.sheet, actor: ask.actor, kind: 'initiative' }, 'free'),
        null,
      );
  }

  // An action clause the holder takes, and a stance they declare before the roll it waits for.
  const offered: FeatureAction[] = [];
  for (const entry of actionClauses) offered.push(actionOf(entry, feature, index));
  for (const entry of stanceClauses) offered.push(stanceAction(entry, feature, index));
  if (offered.length > 0) {
    handler.action = () => offered;
    handler.resolve = (ask) => {
      const stance = stanceClauses.find((entry) => stanceAction(entry, feature, index).id === ask.action_id);
      if (stance) return stanceOutcome(stance, feature, ask.sheet);
      const entry = actionClauses.find((one) => actionOf(one, feature, index).id === ask.action_id) ?? actionClauses[0]!;
      const outcome = outcomeOf(
          entry,
          feature,
          {
            sheet: ask.sheet,
            actor: ask.actor,
            target: ask.target ?? undefined,
            distance_ft: ask.target
              ? distanceBetween(ask.actor, ask.target)
              : ask.point
                ? distanceToPoint(ask.actor, ask.point)
                : undefined,
            melee: ask.target
              ? distanceBetween(ask.actor, ask.target) <= 5
              : ask.point
                ? distanceToPoint(ask.actor, ask.point) <= 5
                : undefined,
          },
          economyOf(entry.clause),
        );
      if (!outcome && entry.clause.do.some((what) => what.kind === 'effect')) {
        throw new Error(`${feature.name} does not apply to that target.`);
      }
      return outcome ?? { economy: economyOf(entry.clause), text: `${feature.name}: nothing applied.` };
    };
  }
  return handler;
}

const weaponCtx = (
  weapon: { properties?: Array<{ index: string }> } | undefined,
  melee: boolean,
): ClauseCtx['weapon'] => ({
  melee,
  ranged: !melee,
  properties: (weapon?.properties ?? []).map((p) => lower(p.index)),
});

/** The economy an action clause takes: what its `effect` says, or a whole action. */
function economyOf(clause: Clause): FeatureOutcome['economy'] {
  const effect = clause.do.find((what) => what.kind === 'effect');
  // One more action costs none of this turn's own, exactly as Action Surge is written.
  if (clause.do.some((what) => what.kind === 'extra_action')) return 'free';
  if (effect?.kind !== 'effect') return 'action';
  return effect.economy === 'bonus' ? 'bonus_action' : effect.economy === 'free' ? 'free' : effect.economy;
}

const actionId = (index: string, at: number): string => `${index.replace(/[^a-z0-9]+/gi, '_')}_${at}`;

function actionOf(entry: Compiled['clauses'][number], feature: SheetFeature, index: string): FeatureAction {
  const spec = entry.clause.uses;
  const effect = entry.clause.do.find((what) => what.kind === 'effect');
  return {
    id: actionId(index, entry.at),
    kind: economyOf(entry.clause) === 'bonus_action' ? 'bonus_action' : economyOf(entry.clause) === 'free' ? 'free' : 'action',
    name: feature.name,
    hint: describeClause(entry.clause),
    ...(typeof spec === 'string' && spec !== 'once_ever' ? {} : { cost: { resource: entry.key, amount: 1 } }),
    ...(effect?.kind === 'effect' &&
    (effect.effect.targets !== undefined || effect.effect.damage || effect.effect.healing || effect.effect.condition)
      ? { targets: effect.effect.kind === 'heal' ? ('ally' as const) : ('creature' as const) }
      : {}),
  };
}

function stanceAction(entry: Compiled['clauses'][number], feature: SheetFeature, index: string): FeatureAction {
  return {
    id: `${actionId(index, entry.at)}_declare`,
    kind: 'free',
    name: `${feature.name} (declare)`,
    hint: `${describeClause(entry.clause)} - declared before the roll and spent only when it fires.`,
  };
}

/** An `ask_after` roll clause as the stance the engine already has: declared now, spent when it fires. */
function stanceOutcome(entry: Compiled['clauses'][number], feature: SheetFeature, sheet: ClauseSheet): FeatureOutcome {
  const reroll = entry.clause.do.find((what) => what.kind === 'reroll');
  const on = entry.clause.if?.kind;
  const kinds: Array<'attack' | 'check' | 'save'> =
    on === 'attack' || on === 'check' || on === 'save' ? [on] : ['attack', 'check', 'save'];
  const spec = clauseUsesMax(sheet, entry.clause.uses);
  return {
    economy: 'free',
    text: `${feature.name} is declared: ${describeClause(entry.clause)}`,
    d20_stance: {
      feature: feature.name,
      mode: 'reroll',
      on: kinds,
      ...(spec ? { spend: { resource: entry.key, amount: 1 } as FeatureCost } : {}),
    },
    ...(reroll ? {} : { notes: [`${feature.name}: only a reroll is declared this way; the rest is yours to apply.`] }),
  };
}

/** What a `cast` clause does to a casting: the spell save DC, and a reminder for the rest. */
function castModifiersOf(
  entry: Compiled['clauses'][number],
  feature: SheetFeature,
  sheet: ClauseSheet,
  actor: Combatant,
  spell: { name: string; school: string; level: number },
): CastModifier[] {
  const { clause, key, note } = entry;
  const verdict = clauseApplies(clause, { sheet, actor, spell, source: 'spell' });
  const handBack = (why: string): CastModifier[] => [
    { kind: 'note', feature: feature.name, note: reminderLine(feature.name, clause, why), reminder: why },
  ];
  if (verdict.blocked) return handBack(verdict.blocked.reason);
  if (!verdict.ok) return [];
  if (clause.decide === 'dm') return handBack('this one is yours to apply');
  if (clause.decide === 'ask_after') return handBack('nothing asks you after the casting: this one is yours');
  // Decision 1: a "you can" clause on a casting is offered as a boost and applied only when it is taken.
  if (isBoost(clause) && !chosen(sheet, key)) {
    return handBack('the player chooses this one: name it in boosts on the casting and it is applied there');
  }
  if (clauseUsesLeft(sheet, clause.uses, key) <= 0) return [];
  const spec = clauseUsesMax(sheet, clause.uses);
  const out: CastModifier[] = [];
  for (const what of clause.do) {
    if (what.kind === 'bonus' && what.to === 'spell_save_dc') {
      out.push({ kind: 'save_dc', feature: feature.name, bonus: flatAmount(sheet, what.amount) ?? 0, note: `${note}.` });
    } else if (what.kind === 'bonus' && what.to === 'spell_attack') {
      out.push({ kind: 'attack_bonus', feature: feature.name, bonus: flatAmount(sheet, what.amount) ?? 0, note: `${note}.` });
    } else if (what.kind === 'advantage') {
      out.push({ kind: 'attack_advantage', feature: feature.name, note: `${note}.` });
    } else if (what.kind === 'free_standard_action' || what.kind === 'recover_slot' || what.kind === 'note') {
      const why = what.kind === 'note' ? what.text : `${describeDo(what)} is yours to apply on a casting`;
      out.push({ kind: 'note', feature: feature.name, note: reminderLine(feature.name, clause, why), reminder: why });
    } else {
      const why = `${describeDo(what)} does not reach a casting`;
      out.push({ kind: 'note', feature: feature.name, note: reminderLine(feature.name, clause, why), reminder: why });
    }
  }
  const real = out.filter((one) => one.kind !== 'note');
  if (spec && real.length > 0) real[0]!.spend = { resource: key, amount: 1 };
  return out;
}

// --- the passives, applied where a sheet is read -----------------------------

/** What the `always` clauses of a set of features add to a sheet, worked out at read time and never stored. */
export interface ClausePassives {
  ac: number;
  speed_ft: number;
  initiative: number;
  extra_attacks: number;
  resistances: string[];
  immunities: string[];
  vulnerabilities: string[];
  /** Ability score increases, capped at 20 where they are applied. */
  asi: Partial<Record<Ability, number>>;
  /** Skills the clauses make the holder proficient in, and the ones they double. */
  proficiencies: string[];
  expertise: string[];
  saves: Ability[];
  tools: string[];
  languages: string[];
  /** Weapons and armour the clauses train the holder in, as the proficiency lists name them. */
  weapons: string[];
  armor: string[];
  cantrips: string[];
  spells: string[];
  /** Spells a clause keeps prepared, which is more than knowing them. */
  prepared: string[];
  /** One line per passive, for the sheet to show where a number came from. */
  notes: string[];
  /** The `always` clauses the sheet could not run, handed back once per read. */
  reminders: Array<{ feature: string; text: string; reason: string }>;
}

const emptyPassives = (): ClausePassives => ({
  ac: 0,
  speed_ft: 0,
  initiative: 0,
  extra_attacks: 0,
  resistances: [],
  immunities: [],
  vulnerabilities: [],
  asi: {},
  proficiencies: [],
  expertise: [],
  saves: [],
  tools: [],
  languages: [],
  weapons: [],
  armor: [],
  cantrips: [],
  spells: [],
  prepared: [],
  notes: [],
  reminders: [],
});

/** As much of a sheet as an `always` clause can be judged against while that sheet is being built. */
export interface PassiveSheet {
  inventory: Array<{ name: string; equipped?: boolean }>;
}

/**
 * Whether an `always` clause's `if` can be answered while the sheet is built. What is worn is knowable
 * here; a condition on the light, the target or a roll belongs to a hook that has one.
 */
function passiveVerdict(clause: Clause, on: PassiveSheet | undefined): { ok: boolean; reason?: string } {
  const where = clause.if;
  if (!where || Object.keys(where).length === 0) return { ok: true };
  const wearing = where.self?.wearing;
  const onlySelf = Object.keys(where).length === 1 && where.self !== undefined;
  if (onlySelf && wearing && Object.keys(where.self!).length === 1) {
    if (!on) return { ok: false, reason: 'what is worn is only known where the whole sheet is read' };
    return { ok: isWearing({ inventory: on.inventory } as ClauseSheet, wearing) };
  }
  return { ok: false, reason: 'a passive narrowed by something the sheet cannot see is applied at the hook instead' };
}

/**
 * Every `always` clause of these features, added up. What the build cannot judge, or cannot run at all,
 * comes back as a reminder rather than vanishing: that is the hook an `always` clause has.
 */
export function clausePassives(features: ClauseHolder[], on?: PassiveSheet): ClausePassives {
  const out = emptyPassives();
  const push = (list: string[], value: string): void => {
    if (!list.includes(value)) list.push(value);
  };
  const handBack = (feature: ClauseHolder, clause: Clause, reason: string): void => {
    out.reminders.push({ feature: feature.name, text: describeClause(clause), reason });
  };
  for (const feature of features) {
    for (const clause of feature.clauses ?? []) {
      if (clause.when !== 'always') continue;
      if (clause.decide === 'dm') {
        handBack(feature, clause, 'this one is yours to apply');
        continue;
      }
      const verdict = passiveVerdict(clause, on);
      if (!verdict.ok) {
        if (verdict.reason) handBack(feature, clause, verdict.reason);
        continue;
      }
      const flat = (amount: ClauseAmount): number => flatAmount(sheetless(feature), amount) ?? 0;
      for (const what of clause.do) {
        switch (what.kind) {
          case 'bonus':
            if (what.to === 'ac') out.ac += flat(what.amount);
            else if (what.to === 'speed') out.speed_ft += flat(what.amount);
            else if (what.to === 'initiative') out.initiative += flat(what.amount);
            else {
              handBack(feature, clause, doCapability(clause, what).reason ?? `a bonus to ${what.to} has no passive seam`);
              break;
            }
            out.notes.push(`${feature.name}: ${describeDo(what)}`);
            break;
          case 'speed_ft':
            out.speed_ft += what.amount;
            out.notes.push(`${feature.name}: ${describeDo(what)}`);
            break;
          case 'extra_attack':
            out.extra_attacks += what.amount ?? 1;
            break;
          case 'resistance':
            for (const type of what.types) push(out.resistances, lower(type));
            break;
          case 'immunity':
            for (const type of what.types) push(out.immunities, lower(type));
            break;
          case 'vulnerability':
            for (const type of what.types) push(out.vulnerabilities, lower(type));
            break;
          case 'asi':
            out.asi[what.ability] = (out.asi[what.ability] ?? 0) + what.amount;
            break;
          case 'proficiency':
            if (what.skill) push(out.proficiencies, lower(what.skill));
            else if (what.save) out.saves.push(what.save);
            else if (what.weapon) push(out.weapons, what.weapon);
            else if (what.armor) push(out.armor, what.armor);
            else if (what.tool) push(out.tools, what.tool);
            else if (what.language) push(out.languages, what.language);
            break;
          case 'expertise':
            push(out.expertise, lower(what.skill));
            break;
          case 'cantrip_known':
            push(out.cantrips, what.name);
            break;
          case 'spell_known':
            push(out.spells, what.name);
            break;
          case 'always_prepared':
            push(out.spells, what.name);
            push(out.prepared, what.name);
            break;
          case 'crit_range':
            // The crit range is read off the registry rather than the sheet, so nothing is lost here.
            break;
          default:
            handBack(feature, clause, doCapability(clause, what).reason ?? `${describeDo(what)} is not a passive`);
            break;
        }
      }
    }
  }
  return out;
}

/** One feature row read on its own, for the scaling tokens a passive amount may carry. */
const sheetless = (feature: ClauseHolder): ClauseSheet => ({
  level: 1,
  proficiency_bonus: 2,
  abilities: {},
  features: [feature],
  inventory: [],
});

/** A score with its clause increase on it, never above 20 - which is what an ASI means on a sheet. */
export const withAsi = (score: number, increase: number | undefined): number =>
  increase ? Math.min(20, score + increase) : score;

// --- boosts ------------------------------------------------------------------

/**
 * The boosts these features offer at this moment: the `ask_before` clauses whose `if` fits it. `hooks`
 * says what the moment can pay for - a bare roll out of combat, or a swing that may carry riders too.
 */
export function boostsFor(
  sheet: ClauseSheet,
  features: ClauseHolder[],
  ctx: Omit<ClauseCtx, 'sheet'>,
  hooks: ClauseWhen[] = ROLL_HOOK,
): RollBoost[] {
  const out: RollBoost[] = [];
  for (const feature of features) {
    const index = homebrewIndex(feature);
    (feature.clauses ?? []).forEach((clause, at) => {
      if (!hooks.includes(clause.when) || !isBoost(clause)) return;
      if (!clauseApplies(clause, { ...ctx, sheet }).ok) return;
      const key = clauseResourceKey(index, at);
      const left = clauseUsesLeft(sheet, clause.uses, key);
      if (left <= 0) return;
      const spec = clauseUsesMax(sheet, clause.uses);
      const advantage = clause.do.some((what) => what.kind === 'advantage');
      const bonus = clause.do.reduce(
        (sum, what) => sum + (what.kind === 'bonus' ? (flatAmount(sheet, what.amount) ?? 0) : 0),
        0,
      );
      // A rider changes no die: it is taken before the swing and paid for when it lands.
      const onFire = spendsOnFire(clause.when);
      if (!onFire && !advantage && bonus === 0) return;
      out.push({
        id: key,
        name: feature.name,
        describe: describeClause(clause),
        uses_left: left === Infinity ? -1 : left,
        advantage: onFire ? false : advantage,
        bonus: onFire ? 0 : bonus,
        label: clauseLabel(feature, at),
        max: spec?.max ?? 0,
        per: spec?.per ?? 'long',
        when: clause.when,
        ...(onFire ? { spend_on_fire: true } : {}),
      });
    });
  }
  return out;
}
