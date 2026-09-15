// The clause language: what a homebrew feature does, written as data the engine can run - when it
// fires, what narrows it, what it does, how often, and who decides. H1 defined and priced clauses;
// H2 runs them at the engine's hooks (src/combat/homebrew.ts), and CLAUSE_SUPPORT says what still
// only reminds.
import { z } from 'zod';
import { conditionNames } from '../srd/lookup.js';

/** The hook a clause rides on: one per clause. */
export const CLAUSE_WHEN = [
  'always',
  'roll',
  'hit',
  'miss',
  'spell_damage',
  'damage_dealt',
  'damage_taken',
  'save_succeeded',
  'kill',
  'cast',
  'turn_start',
  'turn_end',
  'initiative',
  'rest_short',
  'rest_long',
  'dawn',
  'action',
] as const;

export type ClauseWhen = (typeof CLAUSE_WHEN)[number];

const ABILITY = z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']);

/** Decision 3: conditions are the SRD ones, plus the generic `marked` flag - nothing invented. */
export const allowedConditions = (): string[] => [...conditionNames(), 'marked'];

const conditionAllowed = (name: string): boolean =>
  allowedConditions().includes(name.trim().toLowerCase().replace(/\s+/g, '_'));

const conditionRefusal = (name: string): string =>
  `"${name}" is not a condition. Allowed conditions: ${allowedConditions().join(', ')}.`;

/**
 * The payload an `action` clause carries, and the effect a custom spell has: one shape for both.
 * It lives here rather than in progression.ts so the clause schema can use it without a cycle.
 */
export const spellEffectSchema = z.object({
  kind: z.enum(['attack', 'save', 'auto', 'heal', 'utility']),
  damage: z.object({ dice: z.string().min(1), type: z.string().min(1) }).optional(),
  save_ability: ABILITY.optional(),
  half_on_save: z.boolean().optional(),
  shape: z.object({ kind: z.enum(['sphere', 'cone', 'line', 'cube']), size_ft: z.number().int().min(5) }).optional(),
  healing: z.object({ dice: z.string().min(1) }).optional(),
  // Decision 3 holds here too, so a custom spell cannot invent a condition any more than a clause can.
  condition: z
    .object({ name: z.string().min(1), duration_rounds: z.number().int().min(1).optional() })
    .superRefine((value, ctx) => {
      if (conditionAllowed(value.name)) return;
      ctx.addIssue({ code: 'custom', path: ['name'], message: conditionRefusal(value.name) });
    })
    .optional(),
  targets: z.number().int().min(1).optional(),
});

export type SpellEffect = z.infer<typeof spellEffectSchema>;

/** A number, a dice expression, or the character's proficiency bonus or an ability modifier. */
const AMOUNT = z.union([
  z.number(),
  z
    .string()
    .regex(
      /^(\d*d\d+(\s*[+-]\s*(\d+|level|half_level|prof))?|level|half_level|prof|half_prof|ability:(str|dex|con|int|wis|cha))$/i,
      'An amount is a number, a dice expression such as "1d6" or "1d10+level", "level", "half_level", "prof", "half_prof" or "ability:cha".',
    ),
]);

export type ClauseAmount = z.infer<typeof AMOUNT>;

/** What narrows a clause: every field is optional and all of them are AND-ed. */
export const clauseIfSchema = z.object({
  self: z
    .object({
      bloodied: z.boolean().optional(),
      concentrating: z.boolean().optional(),
      raging: z.boolean().optional(),
      wearing: z.enum(['armor', 'no_armor', 'shield']).optional(),
      condition: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  source: z.enum(['spell', 'weapon', 'unarmed', 'any']).optional(),
  damage_type: z.array(z.string().min(1)).optional(),
  weapon: z
    .object({
      ranged: z.boolean().optional(),
      melee: z.boolean().optional(),
      property: z.array(z.string().min(1)).optional(),
      mastery: z.string().min(1).optional(),
    })
    .optional(),
  spell: z
    .object({
      school: z.string().min(1).optional(),
      level_min: z.number().int().min(0).max(9).optional(),
      level_max: z.number().int().min(0).max(9).optional(),
      name: z.string().min(1).optional(),
    })
    .optional(),
  skill: z.array(z.string().min(1)).optional(),
  ability: z.array(z.string().min(1)).optional(),
  save: z.array(z.string().min(1)).optional(),
  kind: z.enum(['attack', 'check', 'save', 'initiative', 'damage', 'heal', 'death_save']).optional(),
  target: z
    .object({
      type: z.array(z.string().min(1)).optional(),
      name_contains: z.string().min(1).optional(),
      size: z.string().min(1).optional(),
      condition: z.array(z.string().min(1)).optional(),
      bloodied: z.boolean().optional(),
      within_ft: z.number().int().min(0).optional(),
      is_only_target: z.boolean().optional(),
    })
    .optional(),
  range: z.union([z.enum(['melee', 'ranged']), z.object({ within_ft: z.number().int().min(0) })]).optional(),
  roll: z
    .object({
      natural_min: z.number().int().min(1).max(20).optional(),
      failed: z.boolean().optional(),
      succeeded: z.boolean().optional(),
      margin_at_least: z.number().int().optional(),
    })
    .optional(),
  light: z.enum(['bright', 'dim', 'dark']).optional(),
  terrain_tag: z.string().min(1).optional(),
});

export type ClauseIf = z.infer<typeof clauseIfSchema>;

/** The keys of `if`, which is what the capability table is keyed by. */
export const CLAUSE_IF_KEYS = Object.keys(clauseIfSchema.shape) as Array<keyof ClauseIf>;

export const BONUS_TO = [
  'attack',
  'damage',
  'ac',
  'check',
  'save',
  'initiative',
  'speed',
  'hp_max',
  'heal',
  'spell_save_dc',
  'spell_attack',
] as const;
export type BonusTo = (typeof BONUS_TO)[number];

/** What a clause does. Every variant carries a literal `kind`, so the union discriminates on it. */
export const clauseDoSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bonus'), to: z.enum(BONUS_TO), amount: AMOUNT }),
  z.object({ kind: z.literal('advantage') }),
  z.object({ kind: z.literal('disadvantage') }),
  z.object({ kind: z.literal('reroll'), keep: z.enum(['higher', 'new']) }),
  z.object({ kind: z.literal('min_die'), value: z.number().int().min(1).max(12) }),
  z.object({ kind: z.literal('crit_range'), min: z.number().int().min(15).max(20) }),
  z.object({ kind: z.literal('max_damage_dice') }),
  z.object({ kind: z.literal('extra_damage'), dice: z.string().min(1), type: z.string().min(1).optional() }),
  z.object({ kind: z.literal('extra_heal'), dice: z.string().min(1) }),
  z.object({
    kind: z.literal('temp_hp'),
    dice: z.string().min(1).optional(),
    amount: z.number().int().min(1).optional(),
  }),
  z.object({ kind: z.literal('push_ft'), amount: z.number().int().min(5) }),
  z.object({
    kind: z.literal('condition'),
    name: z.string().min(1),
    until: z.enum([
      'end_of_target_next_turn',
      'end_of_your_next_turn',
      'start_of_your_next_turn',
      'rounds',
      'save_ends',
    ]),
    rounds: z.number().int().min(1).optional(),
  }),
  z.object({ kind: z.literal('remove_condition'), name: z.string().min(1) }),
  z.object({
    kind: z.literal('move_ft'),
    amount: z.number().int().min(5),
    no_opportunity_attacks: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('grant_inspiration') }),
  z.object({ kind: z.literal('mark_target') }),
  z.object({
    kind: z.literal('proficiency'),
    skill: z.string().min(1).optional(),
    save: ABILITY.optional(),
    weapon: z.string().min(1).optional(),
    armor: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
    language: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal('expertise'), skill: z.string().min(1) }),
  z.object({ kind: z.literal('asi'), ability: ABILITY, amount: z.number().int().min(1).max(2) }),
  z.object({ kind: z.literal('resistance'), types: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('immunity'), types: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('vulnerability'), types: z.array(z.string().min(1)).min(1) }),
  z.object({ kind: z.literal('speed_ft'), amount: z.number().int() }),
  z.object({
    kind: z.literal('sense'),
    darkvision_ft: z.number().int().min(5).optional(),
    blindsight_ft: z.number().int().min(5).optional(),
    tremorsense_ft: z.number().int().min(5).optional(),
    truesight_ft: z.number().int().min(5).optional(),
  }),
  z.object({ kind: z.literal('spell_known'), name: z.string().min(1) }),
  z.object({ kind: z.literal('cantrip_known'), name: z.string().min(1) }),
  z.object({ kind: z.literal('always_prepared'), name: z.string().min(1) }),
  z.object({ kind: z.literal('hp_per_level'), amount: z.number().int().min(1).max(3) }),
  z.object({
    kind: z.literal('effect'),
    effect: spellEffectSchema,
    economy: z.enum(['action', 'bonus', 'reaction', 'free']),
    reaction_trigger: z.string().min(1).optional(),
    duration_rounds: z.number().int().min(1).optional(),
    concentration: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('free_standard_action'), name: z.enum(['dash', 'disengage', 'dodge', 'hide']) }),
  z.object({ kind: z.literal('extra_attack'), amount: z.number().int().min(1).max(3).optional() }),
  z.object({ kind: z.literal('extra_action') }),
  z.object({ kind: z.literal('recover_slot'), level: z.number().int().min(1).max(9) }),
  z.object({ kind: z.literal('recover_resource'), key: z.string().min(1), amount: AMOUNT }),
  z.object({
    kind: z.literal('note'),
    text: z.string().min(1),
    cost: z
      .number()
      .min(0.25)
      .max(1)
      .multipleOf(0.25)
      .optional()
      .describe('Your own estimate of what the prose is worth, when the engine cannot price it.'),
  }),
]);

export type ClauseDo = z.infer<typeof clauseDoSchema>;
export type ClauseDoKind = ClauseDo['kind'];

/** Every `do` verb the language has, which is what the capability table is keyed by. */
export const CLAUSE_DO_KINDS = clauseDoSchema.options.map((option) => option.shape.kind.value) as ClauseDoKind[];

export const clauseUsesSchema = z
  .union([
    z.enum(['unlimited', 'once_per_turn', 'once_per_round', 'once_ever']),
    z.object({
      per: z.enum(['short', 'long']),
      count: z.union([z.number().int().min(1).max(10), z.literal('prof')]),
    }),
    z.object({
      charges: z.object({
        max: z.number().int().min(1).max(20),
        recharge: z.enum(['dawn', 'dusk', 'short', 'long', 'never']),
        dice: z.string().min(1).optional(),
      }),
    }),
  ])
  .default('unlimited');

export type ClauseUses = z.infer<typeof clauseUsesSchema>;

export const CLAUSE_DECIDE = ['auto', 'ask_before', 'ask_after', 'dm'] as const;
export type ClauseDecide = (typeof CLAUSE_DECIDE)[number];

export const clauseSchema = z
  .object({
    when: z.enum(CLAUSE_WHEN),
    if: clauseIfSchema.optional(),
    do: z.array(clauseDoSchema).min(1),
    uses: clauseUsesSchema,
    decide: z.enum(CLAUSE_DECIDE).default('auto'),
  })
  .superRefine((clause, ctx) => {
    const named: Array<{ name: string; path: Array<string | number> }> = [];
    clause.do.forEach((entry, index) => {
      if (entry.kind === 'condition' || entry.kind === 'remove_condition') {
        named.push({ name: entry.name, path: ['do', index, 'name'] });
      }
    });
    for (const [index, name] of (clause.if?.self?.condition ?? []).entries()) {
      named.push({ name, path: ['if', 'self', 'condition', index] });
    }
    for (const [index, name] of (clause.if?.target?.condition ?? []).entries()) {
      named.push({ name, path: ['if', 'target', 'condition', index] });
    }
    for (const { name, path } of named) {
      if (conditionAllowed(name)) continue;
      ctx.addIssue({
        code: 'custom',
        path,
        message: conditionRefusal(name),
      });
    }
  });

export type Clause = z.infer<typeof clauseSchema>;
export type ClauseInput = z.input<typeof clauseSchema>;

/** Decision 4: four clauses per feature. Over the cap the DM splits it into two boons. */
export const CLAUSES_PER_FEATURE = 4;
/** Decision 4: two clauses per subclass-bundle level. */
export const CLAUSES_PER_BUNDLE_LEVEL = 2;

export const clausesSchema = z.array(clauseSchema).max(CLAUSES_PER_FEATURE);

/**
 * Decision 1: a gain applies itself; something the prose says the player *can* do is theirs to
 * choose - before the roll, or after it when the clause rerolls or raises a die.
 */
export function defaultDecide(prose: string, clause: { when: ClauseWhen; do: ClauseDo[] }): ClauseDecide {
  if (!/\byou (can|may)\b/i.test(prose)) return 'auto';
  // A passive applies itself, and taking an action is already the choice.
  if (clause.when === 'always' || clause.when === 'action') return 'auto';
  if (clause.do.some((entry) => entry.kind === 'reroll' || entry.kind === 'min_die')) return 'ask_after';
  // Before the roll on a roll clause, and before the swing at a rider hook: nothing asks the player
  // after a hit, so the choice is made before it and a miss costs nothing.
  return clause.when === 'roll' || RIDER_HOOKS.includes(clause.when) ? 'ask_before' : 'ask_after';
}

/** The hooks that ride on a blow already aimed: a hit, a miss, a spell's damage, a kill. */
export const RIDER_HOOKS: ClauseWhen[] = ['hit', 'miss', 'spell_damage', 'damage_dealt', 'kill'];

// --- what the engine can run today -------------------------------------------

export interface ClauseCapability {
  status: 'runs' | 'planned' | 'reminds';
  /** Why it is not run yet; absent when it runs. */
  reason?: string;
}

const RUNS: ClauseCapability = { status: 'runs' };
const planned = (reason: string): ClauseCapability => ({ status: 'planned', reason });
const reminds = (reason: string): ClauseCapability => ({ status: 'reminds', reason });

function whenSupport(): Record<ClauseWhen, ClauseCapability> {
  const table = Object.fromEntries(CLAUSE_WHEN.map((when) => [when, RUNS])) as Record<ClauseWhen, ClauseCapability>;
  table.damage_taken = planned('the damage-taken seam only offers a reaction; a clause there is a reminder');
  table.save_succeeded = planned('only half damage on a successful save has a seam, which no verb says yet');
  table.rest_short = planned('a rest restores resources; a clause that fires on one waits for H3');
  table.rest_long = table.rest_short;
  table.dawn = reminds('only an item recharges at dawn; a feature that fires at dawn waits for H3');
  return table;
}

function ifSupport(): Record<keyof ClauseIf, ClauseCapability> {
  const table = Object.fromEntries(CLAUSE_IF_KEYS.map((key) => [key, RUNS])) as Record<
    keyof ClauseIf,
    ClauseCapability
  >;
  table.roll = planned('the hooks fire before the roll is known, so a condition on its result reminds');
  table.light = reminds('light is not modelled until R7');
  table.terrain_tag = reminds('terrain is not modelled until R9');
  return table;
}

/** The damage dice are rolled in one place and read in another; nothing reaches between the two. */
export const DIE_SURGERY_REASON = 'damage-die surgery is not modelled: the reminder comes at the damage roll';

function doSupport(): Record<ClauseDoKind, ClauseCapability> {
  const table = Object.fromEntries(CLAUSE_DO_KINDS.map((kind) => [kind, RUNS])) as Record<
    ClauseDoKind,
    ClauseCapability
  >;
  table.min_die = reminds(DIE_SURGERY_REASON);
  table.max_damage_dice = reminds(DIE_SURGERY_REASON);
  table.hp_per_level = reminds('hit points are set when the level is taken; nothing reads them back off the sheet');
  table.sense = reminds('senses are not modelled until R7');
  table.note = reminds('a note is a reminder at the hook, which is what it is for');
  table.effect = planned('an action with its own damage, save or shape is executed by H3');
  return table;
}

/** `bonus` is one verb with eleven targets, and only the hit point maximum has nowhere to land. */
function bonusSupport(): Record<BonusTo, ClauseCapability> {
  const table = Object.fromEntries(BONUS_TO.map((to) => [to, RUNS])) as Record<BonusTo, ClauseCapability>;
  table.hp_max = reminds('a hit point maximum is stored, not read: raising it would have to be written to the row');
  return table;
}

/** Which part of the language the engine has a hook for, and why the rest only reminds. */
export const CLAUSE_SUPPORT: {
  when: Record<ClauseWhen, ClauseCapability>;
  if: Record<keyof ClauseIf, ClauseCapability>;
  do: Record<ClauseDoKind, ClauseCapability>;
  /** Per target of `bonus`, which the `do` row cannot say on its own. */
  bonus_to: Record<BonusTo, ClauseCapability>;
} = { when: whenSupport(), if: ifSupport(), do: doSupport(), bonus_to: bonusSupport() };

/**
 * The hooks that hand the engine an outcome with no action of its own behind it: Initiative, the two
 * turn edges and a kill. They apply what the engine can write on the spot and nothing else.
 */
export const OUTCOME_HOOKS: ClauseWhen[] = ['initiative', 'turn_start', 'turn_end', 'kill'];

const OUTCOME_VERBS: ClauseDoKind[] = [
  'temp_hp',
  'extra_heal',
  'move_ft',
  'grant_inspiration',
  'remove_condition',
  'recover_resource',
  'condition',
  'extra_action',
];

/**
 * What each narrowed hook runs, verb by verb and bonus target by bonus target. Everything else written
 * there is a reminder: the hook has nowhere to put it. A bonus to Initiative is in because it rides on
 * the Initiative roll itself, which is the one number that hook adds.
 */
const HOOK_VERBS: Partial<Record<ClauseWhen, ClauseDoKind[]>> = {
  initiative: OUTCOME_VERBS,
  turn_start: OUTCOME_VERBS,
  turn_end: OUTCOME_VERBS,
  kill: OUTCOME_VERBS,
  cast: ['advantage'],
};

const HOOK_BONUS: Partial<Record<ClauseWhen, BonusTo[]>> = {
  initiative: ['initiative'],
  turn_start: [],
  turn_end: [],
  kill: [],
  cast: ['spell_save_dc', 'spell_attack'],
};

const hookReason = (what: string, when: ClauseWhen): string =>
  `${what} does not land at the ${when} hook: the clause is handed back there as a reminder instead`;

/**
 * What one `do` entry of this clause is worth at the hook it rides on. Four verbs answer differently
 * depending on where they land: a bonus by its target, a reroll on damage dice rather than a d20, a
 * crit range the sheet cannot hold because the clause narrows or rations it, and anything written at
 * a narrowed hook that the hook cannot carry.
 */
export function doCapability(clause: Pick<Clause, 'when' | 'if' | 'uses'>, entry: ClauseDo): ClauseCapability {
  const verbs = HOOK_VERBS[clause.when];
  if (entry.kind === 'bonus') {
    if (verbs) {
      return (HOOK_BONUS[clause.when] ?? []).includes(entry.to)
        ? RUNS
        : reminds(hookReason(`a bonus to ${entry.to}`, clause.when));
    }
    return CLAUSE_SUPPORT.bonus_to[entry.to];
  }
  if (entry.kind === 'reroll' && clause.if?.kind === 'damage') return { status: 'reminds', reason: DIE_SURGERY_REASON };
  if (entry.kind === 'crit_range' && (clause.if !== undefined || clause.uses !== 'unlimited')) {
    return { status: 'reminds', reason: CONDITIONAL_CRIT_REASON };
  }
  if (entry.kind === 'condition' && entry.until === 'save_ends') {
    return { status: 'reminds', reason: SAVE_ENDS_REASON };
  }
  const support = CLAUSE_SUPPORT.do[entry.kind];
  if (support.status === 'runs' && verbs && !verbs.includes(entry.kind)) {
    return reminds(hookReason(entry.kind.replace(/_/g, ' '), clause.when));
  }
  return support;
}

/** The crit range is read off the sheet once per swing, with no room for an `if` or a counter. */
export const CONDITIONAL_CRIT_REASON =
  'a crit range with a condition or a limited number of uses is not modelled: the sheet carries one number';

/** A stance is armed before the roll, where nothing but the kind of roll coming is known. */
export const AUTO_STANCE_REASON =
  'an automatic reroll is armed before the roll, where what narrows this one cannot be judged: declare it yourself when it fits';

/** A save that ends a condition needs the ability and the DC to roll it, which no clause names. */
export const SAVE_ENDS_REASON =
  'a save-ends duration is not modelled: the clause names no save ability or DC for the target to end it with';

export interface ClauseStatus {
  status: 'runs' | 'planned' | 'reminds';
  reasons: string[];
}

/**
 * Whether the engine applies this clause, has a seam waiting for it, or hands it back as a
 * reminder, and why. The table is per verb: where a verb runs at one hook and not at another - a
 * reroll on a D20 Test but not on damage dice - the engine reminds at the hook it cannot run.
 */
export function classifyClause(clause: Clause): ClauseStatus {
  const found: ClauseCapability[] = [];
  const collect = (capability: ClauseCapability | undefined): void => {
    if (capability && capability.status !== 'runs') found.push(capability);
  };
  collect(CLAUSE_SUPPORT.when[clause.when]);
  for (const key of CLAUSE_IF_KEYS) {
    if (clause.if?.[key] !== undefined) collect(CLAUSE_SUPPORT.if[key]);
  }
  // The one `if` field the engine accepts and cannot count: a spell's other targets.
  if (clause.if?.target?.is_only_target) {
    collect(reminds("the engine does not count a spell's other targets here"));
  }
  for (const entry of clause.do) collect(doCapability(clause, entry));
  // A clause that only carries a note is a reminder by definition, whatever else it says.
  const noteOnly = clause.do.every((entry) => entry.kind === 'note');
  const status: ClauseStatus['status'] =
    noteOnly || found.some((capability) => capability.status === 'reminds')
      ? 'reminds'
      : found.length > 0
        ? 'planned'
        : 'runs';
  return { status, reasons: [...new Set(found.map((capability) => capability.reason!).filter(Boolean))] };
}

// --- one plain English line per clause ---------------------------------------

const list = (values: string[]): string =>
  values.length <= 1 ? (values[0] ?? '') : `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;

const words = (value: string): string => value.replace(/_/g, ' ');

const amountWords = (amount: ClauseAmount): string => {
  if (typeof amount === 'number') return amount >= 0 ? `+${amount}` : String(amount);
  if (amount === 'prof') return 'your proficiency bonus';
  if (amount === 'half_prof') return 'half your proficiency bonus';
  if (amount === 'level') return 'your level';
  if (amount === 'half_level') return 'half your level';
  if (amount.startsWith('ability:')) return `your ${amount.slice('ability:'.length).toUpperCase()} modifier`;
  return diceWords(amount);
};

/** A dice string with its scaling tokens in words: "1d10+level" reads "1d10 + your level". */
const diceWords = (dice: string): string =>
  dice
    .replace(/\+\s*half_level/i, ' + half your level')
    .replace(/\+\s*level/i, ' + your level')
    .replace(/\+\s*prof\b/i, ' + your proficiency bonus');

const SOURCE_WORDS: Record<'spell' | 'weapon' | 'unarmed', string> = {
  spell: 'a spell',
  weapon: 'a weapon',
  unarmed: 'an Unarmed Strike',
};

const ECONOMY_WORDS: Record<'action' | 'bonus' | 'reaction' | 'free', string> = {
  action: 'as an action',
  bonus: 'as a Bonus Action',
  reaction: 'as a Reaction',
  free: 'for free',
};

const ROLL_WORDS: Record<NonNullable<ClauseIf['kind']>, string> = {
  attack: 'an attack roll',
  check: 'an ability check',
  save: 'a saving throw',
  initiative: 'Initiative',
  damage: 'damage',
  heal: 'healing',
  death_save: 'a death saving throw',
};

/** The two bonus targets whose plain name is not what they are called at the table. */
const BONUS_WORDS: Partial<Record<BonusTo, string>> = {
  spell_save_dc: 'your spell save DC',
  spell_attack: 'your spell attack rolls',
  hp_max: 'your hit point maximum',
};

/** What one `do` entry does, in words: the part of a clause the power report prices. */
export function describeDo(entry: ClauseDo): string {
  switch (entry.kind) {
    case 'bonus':
      return `${amountWords(entry.amount)} to ${BONUS_WORDS[entry.to] ?? words(entry.to)}`;
    case 'advantage':
      return 'Advantage';
    case 'disadvantage':
      return 'Disadvantage';
    case 'reroll':
      return entry.keep === 'higher' ? 'roll the dice twice and keep the better' : 'reroll the die and keep the new roll';
    case 'min_die':
      return `treat a die below ${entry.value} as ${entry.value}`;
    case 'crit_range':
      return `a Critical Hit on ${entry.min} or higher`;
    case 'max_damage_dice':
      return 'the damage dice count as their highest roll';
    case 'extra_damage':
      return `Extra ${diceWords(entry.dice)}${entry.type && entry.type !== 'same' ? ` ${entry.type}` : ''} damage`;
    case 'extra_heal':
      return `Extra ${diceWords(entry.dice)} healing`;
    case 'temp_hp':
      return `${entry.dice ? diceWords(entry.dice) : entry.amount} Temporary Hit Points`;
    case 'push_ft':
      return `push the target ${entry.amount} ft`;
    case 'condition':
      return `the ${words(entry.name)} condition until ${words(entry.until)}${entry.rounds ? ` (${entry.rounds} rounds)` : ''}`;
    case 'remove_condition':
      return `end the ${words(entry.name)} condition`;
    case 'move_ft':
      return `move ${entry.amount} ft${entry.no_opportunity_attacks ? ' without provoking Opportunity Attacks' : ''}`;
    case 'grant_inspiration':
      return 'Heroic Inspiration';
    case 'mark_target':
      return 'mark the target';
    case 'proficiency':
      return `Proficiency in ${words(
        entry.skill ?? entry.weapon ?? entry.armor ?? entry.tool ?? entry.language ?? `${entry.save ?? ''} saves`,
      )}`;
    case 'expertise':
      return `Expertise in ${words(entry.skill)}`;
    case 'asi':
      return `${entry.ability.toUpperCase()} +${entry.amount}`;
    case 'resistance':
      return `Resistance to ${list(entry.types)} damage`;
    case 'immunity':
      return `Immunity to ${list(entry.types)} damage`;
    case 'vulnerability':
      return `Vulnerability to ${list(entry.types)} damage`;
    case 'speed_ft':
      return `${entry.amount >= 0 ? '+' : ''}${entry.amount} ft Speed`;
    case 'sense':
      return Object.entries(entry)
        .filter(([key, value]) => key !== 'kind' && typeof value === 'number')
        .map(([key, value]) => `${words(key.replace('_ft', ''))} ${value} ft`)
        .join(', ');
    case 'spell_known':
      return `${entry.name} known`;
    case 'cantrip_known':
      return `the ${entry.name} cantrip`;
    case 'always_prepared':
      return `${entry.name} always prepared`;
    case 'hp_per_level':
      return `+${entry.amount} hit points per level`;
    case 'effect': {
      const what =
        entry.effect.damage !== undefined
          ? `${entry.effect.damage.dice} ${entry.effect.damage.type} damage`
          : entry.effect.healing !== undefined
            ? `${entry.effect.healing.dice} healing`
            : entry.effect.condition !== undefined
              ? `the ${words(entry.effect.condition.name)} condition`
              : 'an effect';
      return `${what} ${ECONOMY_WORDS[entry.economy]}`;
    }
    case 'free_standard_action':
      return `${entry.name[0]!.toUpperCase()}${entry.name.slice(1)} for free`;
    case 'extra_attack':
      return `${entry.amount ?? 1} extra attack`;
    case 'extra_action':
      return 'one more action on your turn';
    case 'recover_slot':
      return `a level ${entry.level} spell slot back`;
    case 'recover_resource':
      return `${amountWords(entry.amount)} ${words(entry.key)} back`;
    case 'note':
      return entry.text;
  }
}

function whenWords(clause: Clause): string {
  const damageTypes = clause.if?.damage_type ? `${list(clause.if.damage_type)} ` : '';
  switch (clause.when) {
    case 'always':
      return '';
    case 'roll':
      // An un-narrowed roll clause rides on any D20 Test, not on an ability check in particular.
      return `when you roll ${clause.if?.kind ? ROLL_WORDS[clause.if.kind] : 'a D20 Test'}`;
    case 'hit':
      return 'when you hit';
    case 'miss':
      return 'when you miss';
    case 'spell_damage':
      return `when a spell deals ${damageTypes}damage`;
    case 'damage_dealt':
      return `when you deal ${damageTypes}damage`;
    case 'damage_taken':
      return `when you take ${damageTypes}damage`;
    case 'save_succeeded':
      return 'when a target succeeds on the saving throw';
    case 'kill':
      return 'when you drop a creature to 0 hit points';
    case 'cast':
      return 'when you cast a spell';
    case 'turn_start':
      return 'at the start of your turn';
    case 'turn_end':
      return 'at the end of your turn';
    case 'initiative':
      return 'when you roll Initiative';
    case 'rest_short':
      return 'on a Short Rest';
    case 'rest_long':
      return 'on a Long Rest';
    case 'dawn':
      return 'at dawn';
    // An action clause says its own economy in the `do`, so the trigger adds nothing.
    case 'action':
      return '';
  }
}

function ifWords(clause: Clause): string[] {
  const where = clause.if;
  if (!where) return [];
  const parts: string[] = [];
  if (where.self?.bloodied) parts.push('while bloodied');
  if (where.self?.concentrating) parts.push('while concentrating');
  if (where.self?.raging) parts.push('while raging');
  if (where.self?.wearing) parts.push(`while wearing ${words(where.self.wearing)}`);
  if (where.self?.condition?.length) parts.push(`while ${list(where.self.condition.map(words))}`);
  if (where.source && where.source !== 'any') parts.push(`with ${SOURCE_WORDS[where.source]}`);
  if (where.weapon?.melee) parts.push('with a melee weapon');
  if (where.weapon?.ranged) parts.push('with a ranged weapon');
  if (where.weapon?.property?.length) parts.push(`with a ${list(where.weapon.property)} weapon`);
  if (where.weapon?.mastery) parts.push(`with the ${where.weapon.mastery} mastery`);
  if (where.spell?.school) parts.push(`with a ${where.spell.school} spell`);
  if (where.spell?.name) parts.push(`with ${where.spell.name}`);
  if (where.spell?.level_min !== undefined) parts.push(`with a spell of level ${where.spell.level_min} or higher`);
  if (where.spell?.level_max !== undefined) parts.push(`with a spell of level ${where.spell.level_max} or lower`);
  if (where.skill?.length) parts.push(`on ${list(where.skill.map(words))}`);
  if (where.ability?.length) parts.push(`on ${list(where.ability.map((a) => a.toUpperCase()))}`);
  if (where.save?.length) parts.push(`on ${list(where.save.map((a) => a.toUpperCase()))} saves`);
  if (where.target?.type?.length) parts.push(`against ${list(where.target.type)}`);
  if (where.target?.name_contains) parts.push(`against ${where.target.name_contains}`);
  if (where.target?.size) parts.push(`against a ${where.target.size} creature`);
  if (where.target?.condition?.length) parts.push(`against a ${list(where.target.condition.map(words))} creature`);
  if (where.target?.bloodied) parts.push('against a bloodied creature');
  if (where.target?.within_ft !== undefined) parts.push(`within ${where.target.within_ft} ft`);
  if (where.target?.is_only_target) parts.push('when it is the only target');
  if (typeof where.range === 'string') parts.push(`at ${where.range} range`);
  else if (where.range) parts.push(`within ${where.range.within_ft} ft`);
  if (where.roll?.natural_min !== undefined) parts.push(`on a natural ${where.roll.natural_min} or higher`);
  if (where.roll?.failed) parts.push('when the roll fails');
  if (where.roll?.succeeded) parts.push('when the roll succeeds');
  if (where.roll?.margin_at_least !== undefined) parts.push(`by ${where.roll.margin_at_least} or more`);
  if (where.light) parts.push(`in ${where.light} light`);
  if (where.terrain_tag) parts.push(`on ${words(where.terrain_tag)} ground`);
  return parts;
}

/** How often a clause fires, in words; an unlimited clause says nothing. */
export function usesWords(uses: ClauseUses): string {
  if (uses === 'unlimited') return '';
  if (typeof uses === 'string') return words(uses);
  if ('charges' in uses) {
    const { max, recharge } = uses.charges;
    return `${max} charges${recharge === 'never' ? '' : `, recharging on a ${words(recharge)}`}`;
  }
  const count = uses.count === 'prof' ? 'proficiency bonus' : String(uses.count);
  return `${count} per ${uses.per} rest`;
}

/** One plain English line for a clause: what it does, when it fires, and how often. */
export function describeClause(clause: Clause): string {
  const what = clause.do.map(describeDo).filter(Boolean).join(', ');
  const when = [whenWords(clause), ...ifWords(clause)].filter(Boolean).join(' ');
  const often = usesWords(clause.uses);
  const line = [what, when].filter(Boolean).join(' ');
  return often ? `${line}, ${often}` : line;
}

export const describeClauses = (clauses: Clause[]): string[] => clauses.map(describeClause);
