// Progression: the power budget a homebrew feature is measured against, the homebrew store and
// personal library, the play profile the DM levels a character from, and the progression briefing.
import { z } from 'zod';
import type { Db } from '../db/connection.js';
import { getCampaign, logEvent } from './campaign.js';
import { currentChapter } from './story.js';
import { SKILL_KEYS } from './rules.js';
import { DEFAULT_SETTINGS, getSettings } from './settings.js';
import * as srd from '../srd/data.js';
import { ABILITY_NAMES } from '../srd/glossary.js';
import { findClass, findSpell, subclassesOf } from '../srd/lookup.js';
import {
  CLAUSES_PER_BUNDLE_LEVEL,
  classifyClause,
  clauseSchema,
  describeClause,
  describeDo,
  spellEffectSchema,
  usesWords,
  type BonusTo,
  type Clause,
  type ClauseAmount,
  type ClauseDo,
  type ClauseIf,
  type ClauseStatus,
  type ClauseUses,
} from './mechanics.js';

const nowIso = (): string => new Date().toISOString();

/** The tags the DM may hang on a moment of play; a fixed list, so the profile can be counted. */
export const PLAY_TAGS = [
  'improvise',
  'engineering',
  'trap',
  'environment',
  'stealth',
  'social',
  'brute_force',
  'magic',
  'ranged',
  'melee',
  'leadership',
  'mercy',
  'cruelty',
  'exploration',
  'investigation',
] as const;

/** The numbers a homebrew feature is allowed to touch: everything the power budget can price. */
export const mechanicsSchema = z.object({
  asi: z
    .array(z.object({ ability: z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha']), amount: z.number().int().min(1).max(2) }))
    .optional(),
  to_hit: z.number().int().min(0).max(5).optional(),
  ac: z.number().int().min(0).max(5).optional(),
  extra_damage: z.object({ dice: z.string(), per: z.enum(['turn', 'hit']) }).optional(),
  once_per: z.enum(['short', 'long']).optional(),
  effect: z.string().optional().describe('What the once-per-rest ability does.'),
  effect_cost: z
    .number()
    .min(0.5)
    .max(1)
    .optional()
    .describe('How strong that ability is: 0.5 minor, 1 as good as a feat. It becomes the note clause\'s cost.'),
  skill_proficiencies: z.array(z.string()).optional(),
  speed: z.number().int().min(0).max(30).optional().describe('Extra walking speed in feet.'),
  resistances: z.array(z.string()).optional(),
  spells: z.array(z.string()).optional().describe('Spells the feature grants, priced as 1st-level spells.'),
  features_text: z
    .string()
    .optional()
    .describe(
      'Prose with no numbers behind it; it costs nothing. Numbers written here are priced as always-on bonuses - prefer the structured fields.',
    ),
  /** Set by the server when a feature is applied above the budget on purpose. */
  over_budget: z.boolean().optional(),
});

export type Mechanics = z.infer<typeof mechanicsSchema>;

export interface PowerItem {
  part: string;
  cost: number;
  rule: string;
}

export interface PowerReport {
  budget_used: number;
  budget_allowed: number;
  items: PowerItem[];
  verdict: 'within' | 'over_budget';
  text: string;
}

const quarter = (value: number): number => Math.round(value * 4) / 4;

/** The average of a dice expression such as "1d6" or "2d8"; anything unparsable averages 0. */
function diceAverage(expr: string): number {
  let total = 0;
  for (const [, count, faces] of expr.matchAll(/(\d*)d(\d+)/gi)) {
    total += (Number(count || 1) * (Number(faces) + 1)) / 2;
  }
  // A scaling token is priced at the reference: a level 4 character, whose proficiency bonus reads +3
  // here as it does everywhere else in this table. Re-pricing is not retroactive, so the anchor is fixed.
  for (const [, token] of expr.matchAll(/(?:^\s*|[+-]\s*)(half_level|level|prof)(?![a-z_])/gi)) {
    total += SCALING_AT_REFERENCE[token.toLowerCase() as keyof typeof SCALING_AT_REFERENCE];
  }
  return total;
}

/** The level a scaling token is priced at, and what each token is worth there. */
export const PRICING_REFERENCE_LEVEL = 4;
const SCALING_AT_REFERENCE = { level: PRICING_REFERENCE_LEVEL, half_level: PRICING_REFERENCE_LEVEL / 2, prof: 3 };

/**
 * What the numbers written into a note are worth: a flat bonus at the +1-costs-0.5 rate and a dice
 * expression at the extra damage rate. Bare numbers - a range, a DC - cost nothing beyond the floor.
 */
function textCost(text: string): number {
  let cost = 0;
  for (const [expr] of text.matchAll(/\d*d\d+/gi)) cost += quarter((diceAverage(expr) / diceAverage('1d6')) * 0.5);
  for (const [, flat] of text.matchAll(/(?<!\d)[+-]\s*(\d+)(?!\s*d\d)/gi)) cost += quarter(Number(flat) * 0.5);
  return cost;
}

// --- pricing v2: one price per clause ----------------------------------------

/** Any priced clause costs at least this much, so nothing with a rule behind it is free. */
const CLAUSE_FLOOR = 0.25;

/** What a +1 is worth, by what it is added to; speed and hit points are priced per foot and point. */
const BONUS_RATE: Record<BonusTo, number> = {
  attack: 0.5,
  damage: 0.5,
  ac: 0.5,
  save: 0.5,
  heal: 0.5,
  check: 0.25,
  initiative: 0.25,
  speed: 0.05,
  hp_max: 0.1,
  // A spell save DC and a spell attack roll are priced like an attack: half a feat a point.
  spell_save_dc: 0.5,
  spell_attack: 0.5,
};

const diceUnits = (dice: string): number => diceAverage(dice) / diceAverage('1d6');

/** An amount in the units its rate is quoted in: dice count as 1d6s, prof as +3. */
function amountUnits(amount: ClauseAmount): number {
  if (typeof amount === 'number') return amount;
  if (amount === 'prof') return 3;
  if (amount === 'half_prof') return 1.5;
  // A scaling token is worth what it is at the reference level; "1d10+level" falls through to the dice.
  if (amount === 'level') return PRICING_REFERENCE_LEVEL;
  if (amount === 'half_level') return PRICING_REFERENCE_LEVEL / 2;
  if (amount.startsWith('ability:')) return 3;
  return diceUnits(amount);
}

/** What a condition is worth: the longer it sticks, the dearer, and a save to end it is the dearest. */
function conditionCost(entry: Extract<ClauseDo, { kind: 'condition' }>): number {
  switch (entry.until) {
    case 'start_of_your_next_turn':
      return 0.75;
    case 'rounds':
      return Math.min(2, 1 + ((entry.rounds ?? 1) - 1) * 0.25);
    case 'save_ends':
      return 1.5;
    // Until the end of a turn, yours or theirs: one round of it either way.
    default:
      return 1;
  }
}

/** What a spell-shaped effect is worth: its dice at the extra damage rate, or a flat half a feat. */
function effectCost(entry: Extract<ClauseDo, { kind: 'effect' }>): number {
  const damage = entry.effect.damage ? diceUnits(entry.effect.damage.dice) * 0.5 : 0;
  const healing = entry.effect.healing ? diceUnits(entry.effect.healing.dice) * 0.5 : 0;
  const condition = entry.effect.condition ? 1 : 0;
  return Math.max(damage, healing, condition, 0.5);
}

/**
 * What one effect is worth before the clause is narrowed, anchored at one feat = 1. The whole table
 * is here, and the calibration test over the SRD origin feats is what keeps it honest.
 */
function doCost(entry: ClauseDo): number {
  switch (entry.kind) {
    case 'bonus':
      return BONUS_RATE[entry.to] * amountUnits(entry.amount);
    case 'advantage':
    case 'disadvantage':
      return 1;
    case 'reroll':
      return entry.keep === 'higher' ? 2.5 : 0.25;
    case 'min_die':
      return 0.5;
    case 'crit_range':
      return 20 - entry.min;
    case 'max_damage_dice':
      return 1.5;
    case 'extra_damage':
      return diceUnits(entry.dice) * 0.5;
    case 'extra_heal':
      return diceUnits(entry.dice) * 0.5;
    case 'temp_hp':
      return (entry.dice ? diceUnits(entry.dice) : (entry.amount ?? 0) / 3.5) * 0.25;
    case 'push_ft':
      return 0.5;
    case 'condition':
      return conditionCost(entry);
    case 'remove_condition':
      return 0.5;
    case 'move_ft':
      return 0.25;
    case 'grant_inspiration':
    case 'mark_target':
      return 0.25;
    case 'proficiency':
      return entry.save ? 0.5 : 0.25;
    case 'expertise':
      return 0.5;
    case 'asi':
      return entry.amount * 0.5;
    case 'resistance':
      return entry.types.length * 0.5;
    // Immunity is resistance that never runs out: three times what resistance to the same type costs.
    case 'immunity':
      return entry.types.length * 1.5;
    case 'vulnerability':
      return 0;
    case 'speed_ft':
      return Math.max(0, entry.amount) * 0.05;
    case 'sense':
      return 0.5;
    case 'spell_known':
      return 0.5;
    case 'cantrip_known':
    case 'always_prepared':
      return 0.25;
    case 'hp_per_level':
      return entry.amount * 0.5;
    case 'effect':
      return effectCost(entry);
    case 'free_standard_action':
      return 0.5;
    // Extra Attack is a level 5 class feature, never a feat: one more attack is worth two of them.
    case 'extra_attack':
      return (entry.amount ?? 1) * 2;
    // Action Surge is a whole second action: worth two feats, as an extra attack is.
    case 'extra_action':
      return 2;
    case 'recover_slot':
      return entry.level * 0.25;
    case 'recover_resource':
      return 0.5;
    // Prose is never free once it carries a rule: the DM's own estimate, or what its numbers are worth.
    case 'note':
      return Math.max(entry.cost ?? CLAUSE_FLOOR, quarter(textCost(entry.text)));
  }
}

/**
 * How much narrower than "always, against anyone" the clause is; conditions stack and multiply.
 * `if.kind` names the roll the clause rides on rather than narrowing it, so it costs nothing.
 */
function narrowness(where: ClauseIf | undefined): { factor: number; label: string } {
  const parts: Array<{ factor: number; label: string }> = [];
  if (where) {
    if (where.damage_type?.length) parts.push({ factor: 0.75, label: 'one damage type' });
    if (where.source && where.source !== 'any') parts.push({ factor: 0.75, label: `one source (${where.source})` });
    if (where.weapon) parts.push({ factor: 0.75, label: 'one kind of weapon' });
    if (where.spell) parts.push({ factor: 0.75, label: 'one kind of spell' });
    if (where.self && Object.keys(where.self).length > 0) parts.push({ factor: 0.75, label: 'one state you are in' });
    if (where.skill?.length) parts.push({ factor: 0.5, label: 'one skill family' });
    if (where.ability?.length || where.save?.length) parts.push({ factor: 0.5, label: 'one ability' });
    if (where.target?.type?.length || where.target?.name_contains || where.target?.size) {
      parts.push({ factor: 0.5, label: 'one target type' });
    }
    if (where.target?.condition?.length || where.target?.bloodied) {
      parts.push({ factor: 0.75, label: 'a target in one state' });
    }
    if (where.range) parts.push({ factor: 0.75, label: 'one range' });
    if (where.roll) parts.push({ factor: 0.5, label: 'one roll result' });
    if (where.light) parts.push({ factor: 0.75, label: 'one light level' });
    if (where.terrain_tag) parts.push({ factor: 0.75, label: 'one kind of ground' });
  }
  if (parts.length === 0) return { factor: 1, label: 'unconditional' };
  return {
    factor: parts.reduce((product, part) => product * part.factor, 1),
    label: parts.map((part) => part.label).join(' and '),
  };
}

/** More uses are worth more, but never more than the same thing at will. */
const countFactor = (count: number | 'prof'): number => (count === 'prof' ? 2 : count === 1 ? 1 : count <= 3 ? 1.5 : 2);

function frequency(uses: ClauseUses): { factor: number; label: string } {
  if (uses === 'unlimited') return { factor: 1, label: 'at will' };
  if (uses === 'once_per_turn') return { factor: 0.5, label: 'once per turn' };
  if (uses === 'once_per_round') return { factor: 0.5, label: 'once per round' };
  if (uses === 'once_ever') return { factor: 0.1, label: 'once ever' };
  if ('charges' in uses) {
    const base = uses.charges.recharge === 'never' ? 0.1 : uses.charges.recharge === 'short' ? 0.5 : 0.25;
    return { factor: Math.min(1, base * countFactor(uses.charges.max)), label: usesWords(uses) };
  }
  const base = uses.per === 'short' ? 0.5 : 0.25;
  return { factor: Math.min(1, base * countFactor(uses.count)), label: usesWords(uses) };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** The tokens whose value depends on the character: "half_level", "level", "1d10+level". */
const SCALING_TOKEN = /(half_level|level)/i;

/** One clause's price: what it does, times how narrow it is, times how often it fires. */
export function clauseItem(clause: Clause): PowerItem {
  // A drawback never buys power back, so every effect is floored at nothing before they are summed.
  const effects = clause.do.map((entry) => ({
    label: describeDo(entry),
    cost: Math.max(0, doCost(entry)),
    note: entry.kind === 'note',
  }));
  const narrow = narrowness(clause.if);
  const often = frequency(clause.uses);
  // A note is priced as the whole of what it stands for, so how often it fires is already inside it.
  const notes = effects.filter((part) => part.note).reduce((sum, part) => sum + part.cost, 0);
  const effect = effects.filter((part) => !part.note).reduce((sum, part) => sum + part.cost, 0);
  const raw = effect * narrow.factor * often.factor + notes;
  const cost = Math.max(CLAUSE_FLOOR, quarter(raw));
  const sum = effects.map((part) => `${part.label} (${round2(part.cost)})`).join(' + ');
  const factors = effect > 0 ? ` × ${narrow.label} (${narrow.factor}) × ${often.label} (${often.factor})` : '';
  const rounded = cost === round2(raw) ? '' : raw < CLAUSE_FLOOR ? ` → floor ${cost}` : ` → ${cost}`;
  // A clause that scales with the character is priced once, at the level the table is anchored to.
  const scaling = SCALING_TOKEN.test(JSON.stringify(clause.do))
    ? `; a scaling token is priced at level ${PRICING_REFERENCE_LEVEL}`
    : '';
  return {
    part: describeClause(clause),
    cost,
    rule: `${sum}${factors} = ${round2(raw)}${rounded}${scaling}`,
  };
}

const clauseOf = (
  when: Clause['when'],
  entries: ClauseDo[],
  rest: Partial<Pick<Clause, 'if' | 'uses' | 'decide'>> = {},
): Clause => ({ when, do: entries, uses: 'unlimited', decide: 'auto', ...rest });

/**
 * The flat mechanics fields as clauses, so a feature written before the language - or by a DM who
 * still writes numbers - is priced and run the same way. Nothing is stored: this reads a row.
 */
export function convertLegacyMechanics(mechanics: Mechanics): Clause[] {
  const clauses: Clause[] = [];
  for (const bump of mechanics.asi ?? []) {
    clauses.push(clauseOf('always', [{ kind: 'asi', ability: bump.ability, amount: bump.amount }]));
  }
  if (mechanics.to_hit) {
    clauses.push(
      clauseOf('roll', [{ kind: 'bonus', to: 'attack', amount: mechanics.to_hit }], { if: { kind: 'attack' } }),
    );
  }
  if (mechanics.ac) clauses.push(clauseOf('always', [{ kind: 'bonus', to: 'ac', amount: mechanics.ac }]));
  if (mechanics.extra_damage) {
    const { dice, per } = mechanics.extra_damage;
    clauses.push(
      clauseOf('damage_dealt', [{ kind: 'extra_damage', dice }], {
        uses: per === 'turn' ? 'once_per_turn' : 'unlimited',
      }),
    );
  }
  if (mechanics.once_per) {
    // What the DM priced the ability at is what the note costs; half a feat when they said nothing.
    const cost = Math.min(1, Math.max(0.5, mechanics.effect_cost ?? 0.5));
    clauses.push(
      clauseOf('action', [{ kind: 'note', text: mechanics.effect ?? 'An ability', cost }], {
        uses: { per: mechanics.once_per, count: 1 },
      }),
    );
  }
  for (const skill of mechanics.skill_proficiencies ?? []) {
    clauses.push(clauseOf('always', [{ kind: 'proficiency', skill }]));
  }
  if (mechanics.speed) clauses.push(clauseOf('always', [{ kind: 'speed_ft', amount: mechanics.speed }]));
  for (const resistance of mechanics.resistances ?? []) {
    clauses.push(clauseOf('always', [{ kind: 'resistance', types: [resistance] }]));
  }
  for (const spell of mechanics.spells ?? []) {
    clauses.push(clauseOf('always', [{ kind: 'spell_known', name: spell }]));
  }
  if (mechanics.features_text) {
    clauses.push(clauseOf('always', [{ kind: 'note', text: mechanics.features_text }]));
  }
  return clauses;
}

/**
 * Prices a homebrew feature against one feat's worth of power - the level 1 origin feat and the
 * ability score improvement at level 4 are both worth 1 - and says in plain words how it adds up.
 * Legacy mechanics fields are converted to clauses first, so both shapes are priced the same way.
 */
export function powerReport(mechanics: Mechanics & { clauses?: Clause[] }, budgetAllowed = 1): PowerReport {
  const clauses = [...convertLegacyMechanics(mechanics), ...(mechanics.clauses ?? [])];
  const items: PowerItem[] = clauses.map(clauseItem);

  const used = quarter(items.reduce((sum, item) => sum + item.cost, 0));
  const verdict: PowerReport['verdict'] = used > budgetAllowed ? 'over_budget' : 'within';
  const text = [
    `Power budget: ${used} of ${budgetAllowed} (${verdict === 'within' ? 'within budget' : 'over budget'}).`,
    ...items.map((item) => `- ${item.part}: ${item.cost} - ${item.rule}`),
    verdict === 'within'
      ? 'This is about as strong as a feat, so it is fair to hand out.'
      : `This is ${quarter(used - budgetAllowed)} above one feat's worth of power; it will outshine the rules the rest of the game runs on.`,
  ].join('\n');
  return { budget_used: used, budget_allowed: budgetAllowed, items, verdict, text };
}

// --- the homebrew store ------------------------------------------------------

export type HomebrewKind = 'background' | 'feat' | 'feature' | 'subclass' | 'spell';

export interface HomebrewRow {
  id: number;
  campaign_id: number | null;
  scope: 'campaign' | 'library';
  kind: HomebrewKind;
  name: string;
  schema_json: string;
  power_report_json: string | null;
  power_label: 'within' | 'over_budget';
  created_by: 'dm' | 'player';
  created_at: string;
  /** The character's level when the entry was kept for the library; NULL until it is saved there. */
  balanced_at_level: number | null;
  /** The official subclass this one is a recreation of, when the DM said so. */
  recreated_from: string | null;
}

/** The row with its JSON columns already parsed: what every reply and the library list carry. */
export interface Homebrew extends Omit<HomebrewRow, 'schema_json' | 'power_report_json'> {
  schema: Record<string, unknown>;
  power_report: PowerReport | null;
  /** What it does, as clauses: the stored ones, or its legacy mechanics read as clauses. */
  clauses: Clause[];
  /** Per clause, in plain words: runs, planned or reminds, with the reasons. Computed, never stored. */
  clause_status: HomebrewClauseStatus[];
}

/** One clause of an entry as the library shows it: what it says, and whether the engine runs it. */
export interface HomebrewClauseStatus extends ClauseStatus {
  describe: string;
}

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * The clauses an entry runs on: the ones it was stored with, or its legacy mechanics read as
 * clauses. Reading converts; nothing is rewritten until the entry is written again.
 */
export function schemaClauses(schema: Record<string, unknown>, kind?: HomebrewKind): Clause[] {
  if (Array.isArray(schema.clauses)) {
    const stored = z.array(clauseSchema).safeParse(schema.clauses);
    return stored.success ? stored.data : [];
  }
  // A bundle keeps its clauses inside its level features, so they are gathered in level order.
  if (kind === 'subclass') {
    const bundles = (schema.features ?? {}) as Record<string, Array<{ clauses?: unknown }>>;
    return Object.keys(bundles)
      .sort((a, b) => Number(a) - Number(b))
      .flatMap((level) =>
        (bundles[level] ?? []).flatMap((feature) => {
          const stored = z.array(clauseSchema).safeParse(feature.clauses ?? []);
          return stored.success ? stored.data : [];
        }),
      );
  }
  const mechanics = mechanicsSchema.safeParse(schema.mechanics ?? {});
  return mechanics.success ? convertLegacyMechanics(mechanics.data) : [];
}

export function expandHomebrew(row: HomebrewRow): Homebrew {
  const schema = parse<Record<string, unknown>>(row.schema_json, {});
  const clauses = schemaClauses(schema, row.kind);
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    scope: row.scope,
    kind: row.kind,
    name: row.name,
    schema,
    clauses,
    clause_status: clauses.map((clause) => ({ describe: describeClause(clause), ...classifyClause(clause) })),
    power_report: parse<PowerReport | null>(row.power_report_json, null),
    power_label: row.power_label,
    created_by: row.created_by,
    created_at: row.created_at,
    balanced_at_level: row.balanced_at_level ?? null,
    recreated_from: row.recreated_from ?? null,
  };
}

export function saveHomebrew(
  db: Db,
  input: {
    campaign_id: number | null;
    kind: HomebrewKind;
    name: string;
    schema: Record<string, unknown>;
    report?: PowerReport | null;
    power_label?: 'within' | 'over_budget';
    created_by?: 'dm' | 'player';
    /** A label for a recreation of a known official subclass; nothing of it is bundled with the app. */
    recreated_from?: string | null;
  },
): Homebrew {
  const id = Number(
    db
      .prepare(
        'INSERT INTO homebrew (campaign_id, scope, kind, name, schema_json, power_report_json, power_label, created_by, created_at, recreated_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.campaign_id,
        input.campaign_id === null ? 'library' : 'campaign',
        input.kind,
        input.name,
        JSON.stringify(input.schema),
        input.report ? JSON.stringify(input.report) : null,
        input.power_label ?? input.report?.verdict ?? 'within',
        input.created_by ?? 'dm',
        nowIso(),
        input.recreated_from ?? null,
      ).lastInsertRowid,
  );
  return getHomebrew(db, id)!;
}

/**
 * Restates what one entry does and prices it again. Decision 5 keeps history: this touches the row
 * being revised and nothing else, and no other entry's report or label is rewritten. A revision
 * replaces the rule, so the legacy mechanics go with it and the row prices as one thing.
 */
export function reviseHomebrewClauses(db: Db, id: number, clauses: Clause[], report: PowerReport): Homebrew {
  const existing = getHomebrew(db, id);
  if (!existing) throw new Error(`No homebrew with id ${id}.`);
  db.prepare('UPDATE homebrew SET schema_json = ?, power_report_json = ?, power_label = ? WHERE id = ?').run(
    JSON.stringify({ ...existing.schema, mechanics: {}, clauses }),
    JSON.stringify(report),
    report.verdict,
    id,
  );
  return getHomebrew(db, id)!;
}

export function getHomebrew(db: Db, id: number): Homebrew | undefined {
  const row = db.prepare('SELECT * FROM homebrew WHERE id = ?').get(id) as HomebrewRow | undefined;
  return row ? expandHomebrew(row) : undefined;
}

/**
 * The clauses of one feature row on a sheet. A boon is the whole entry; a subclass bundle is not -
 * every feature row of it points at the same library id, so it takes only the clauses of the level
 * feature that bears its name, and never the bundle's other levels.
 */
export function featureClauses(db: Db, id: number, name: string, level: number): Clause[] {
  const entry = getHomebrew(db, id);
  if (!entry) return [];
  if (entry.kind !== 'subclass') return entry.clauses;
  const bundles = ((entry.schema as Partial<SubclassSchema>).features ?? {}) as Record<string, FeatureSpec[]>;
  const wanted = name.trim().toLowerCase();
  const matches: Array<{ at: number; clauses: Clause[] }> = [];
  for (const at of Object.keys(bundles).sort((a, b) => Number(a) - Number(b))) {
    for (const feature of bundles[at] ?? []) {
      if (feature.name.trim().toLowerCase() !== wanted) continue;
      const stored = z.array(clauseSchema).safeParse((feature as { clauses?: unknown }).clauses ?? []);
      matches.push({ at: Number(at), clauses: stored.success ? stored.data : [] });
    }
  }
  if (matches.length <= 1) return matches[0]?.clauses ?? [];
  // Two levels named a feature the same way: the one in force is the last granted at or below this level.
  const reached = matches.filter((one) => one.at <= level);
  return (reached.length ? reached[reached.length - 1] : matches[0])!.clauses;
}

/** Everything this campaign may use: its own homebrew plus whatever is in the personal library. */
export function listHomebrew(db: Db, campaignId: number | null, kind?: HomebrewKind): Homebrew[] {
  const rows = db
    .prepare(
      `SELECT * FROM homebrew WHERE (campaign_id = ? OR scope = 'library') AND (? IS NULL OR kind = ?) ORDER BY id`,
    )
    .all(campaignId, kind ?? null, kind ?? null) as HomebrewRow[];
  return rows.map(expandHomebrew);
}

export function listLibrary(db: Db, kind?: HomebrewKind): Homebrew[] {
  const rows = db
    .prepare(`SELECT * FROM homebrew WHERE scope = 'library' AND (? IS NULL OR kind = ?) ORDER BY id`)
    .all(kind ?? null, kind ?? null) as HomebrewRow[];
  return rows.map(expandHomebrew);
}

/** The level the character stands at right now: what a library entry was balanced against. */
function currentLevel(db: Db, campaignId: number | null): number | null {
  if (campaignId === null) return null;
  const row = db
    .prepare("SELECT level FROM character WHERE campaign_id = ? AND is_pc = 1 AND status = 'active' ORDER BY id DESC LIMIT 1")
    .get(campaignId) as { level: number } | undefined;
  return row?.level ?? null;
}

/**
 * Moving an entry to the library keeps it usable everywhere, so it belongs to no campaign any more.
 * The level it was balanced at is stamped on the way out, because the library has no campaign to ask.
 */
export function saveToLibrary(db: Db, id: number): Homebrew {
  const existing = getHomebrew(db, id);
  if (!existing) throw new Error(`No homebrew with id ${id}.`);
  const level = existing.balanced_at_level ?? currentLevel(db, existing.campaign_id);
  db.prepare("UPDATE homebrew SET scope = 'library', campaign_id = NULL, balanced_at_level = ? WHERE id = ?").run(
    level,
    id,
  );
  return getHomebrew(db, id)!;
}

/** A background the DM wrote, found by name the way findBackground finds an SRD one. */
export function findHomebrewBackground(db: Db, campaignId: number, name: string): Homebrew | undefined {
  const row = db
    .prepare(
      `SELECT * FROM homebrew WHERE kind = 'background' AND lower(name) = lower(?) AND (campaign_id = ? OR scope = 'library') ORDER BY id DESC LIMIT 1`,
    )
    .get(name.trim(), campaignId) as HomebrewRow | undefined;
  return row ? expandHomebrew(row) : undefined;
}

// --- custom backgrounds ------------------------------------------------------

/** A 2024 background: three abilities, an origin feat, two skills, a tool and starting equipment. */
export const backgroundSchema = z.object({
  name: z.string().min(1),
  abilities: z.array(z.enum(['str', 'dex', 'con', 'int', 'wis', 'cha'])).length(3),
  origin_feat: z.union([
    z.string().min(1),
    z.object({ name: z.string().min(1), text: z.string().min(1), mechanics: mechanicsSchema }),
  ]),
  skills: z.array(z.string().min(1)).length(2),
  tool: z.string().min(1),
  equipment: z.object({
    items: z.array(z.object({ name: z.string().min(1), qty: z.number().int().min(1).default(1) })).default([]),
    gold: z.number().int().min(0).default(0),
  }),
  text: z.string().min(1),
});

export type BackgroundSchema = z.infer<typeof backgroundSchema>;

/** Validates the 2024 shape beyond what the types can say: distinct abilities, real skills. */
export function validateBackground(input: unknown): BackgroundSchema {
  const parsed = backgroundSchema.parse(input);
  if (new Set(parsed.abilities).size !== 3) throw new Error('A background raises three different abilities.');
  const skills = parsed.skills.map((s) => s.trim().toLowerCase().replace(/[\s-]/g, '_'));
  if (new Set(skills).size !== 2) throw new Error('A background grants two different skill proficiencies.');
  for (const skill of skills) {
    if (!SKILL_KEYS.includes(skill)) throw new Error(`"${skill}" is not a skill. Valid skills: ${SKILL_KEYS.join(', ')}.`);
  }
  return { ...parsed, skills };
}

// --- play notes and the play profile ----------------------------------------

export function addPlayNote(
  db: Db,
  input: { campaign_id: number; character_id?: number; tags: string[]; text: string },
): { id: number; tags: string[]; text: string } {
  const campaign = getCampaign(db, input.campaign_id);
  const tags = input.tags.map((tag) => tag.trim().toLowerCase());
  for (const tag of tags) {
    if (!(PLAY_TAGS as readonly string[]).includes(tag)) {
      throw new Error(`"${tag}" is not a play tag. Valid tags: ${PLAY_TAGS.join(', ')}.`);
    }
  }
  const id = Number(
    db
      .prepare(
        'INSERT INTO play_note (campaign_id, character_id, tags_json, text, scene_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.campaign_id,
        input.character_id ?? null,
        JSON.stringify(tags),
        input.text,
        campaign.current_scene_id,
        nowIso(),
      ).lastInsertRowid,
  );
  logEvent(db, {
    campaign_id: input.campaign_id,
    kind: 'play_note',
    text: input.text,
    payload: { note_id: id, character_id: input.character_id ?? null, tags },
  });
  return { id, tags, text: input.text };
}

interface PlayNoteRow {
  id: number;
  character_id: number | null;
  tags_json: string;
  text: string;
  created_at: string;
}

const countInto = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Which combatant rows belong to this character, so the fight log can be read as theirs. */
function combatantIds(db: Db, campaignId: number, characterId: number): number[] {
  return (
    db
      .prepare(
        'SELECT c.id AS id FROM combatant c JOIN encounter e ON e.id = c.encounter_id WHERE e.campaign_id = ? AND c.character_id = ?',
      )
      .all(campaignId, characterId) as Array<{ id: number }>
  ).map((row) => row.id);
}

export interface PlayProfile extends Record<string, unknown> {
  tags: Record<string, number>;
  /** Rolls the player edited or the luck dial pulled: they exist, but they say nothing about play. */
  excluded_rolls: number;
  exemplars: Array<{ text: string; tags: string[]; created_at: string }>;
  engine: {
    skills: Record<string, number>;
    rolls: Record<string, number>;
    actions: Record<string, number>;
    effects: Record<string, number>;
  };
}

/**
 * How this character actually plays: the DM's tags and best lines, plus what the engine has seen
 * them do - the skills they roll, the attacks they make and the effects they leave on the field.
 */
export function playProfile(db: Db, campaignId: number, characterId?: number): PlayProfile {
  getCampaign(db, campaignId);
  const notes = db
    .prepare(
      `SELECT id, character_id, tags_json, text, created_at FROM play_note
       WHERE campaign_id = ? AND (? IS NULL OR character_id = ?) ORDER BY id DESC`,
    )
    .all(campaignId, characterId ?? null, characterId ?? null) as PlayNoteRow[];

  const tags: Record<string, number> = {};
  for (const note of notes) for (const tag of parse<string[]>(note.tags_json, [])) countInto(tags, tag);

  // The best five: the most recent twenty, and of those the ones that say the most.
  const exemplars = [...notes.slice(0, 20)]
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, 5)
    .map((note) => ({ text: note.text, tags: parse<string[]>(note.tags_json, []), created_at: note.created_at }));

  const skills: Record<string, number> = {};
  const rolls: Record<string, number> = {};
  const purposes = db
    .prepare('SELECT purpose, overridden, luck_bias_applied FROM roll WHERE campaign_id = ?')
    .all(campaignId) as Array<{ purpose: string | null; overridden: number; luck_bias_applied: number }>;
  let excluded = 0;
  for (const row of purposes) {
    // An edited roll and a roll the luck dial pulled are not evidence of how this character plays.
    if (row.overridden === 1 || row.luck_bias_applied !== 0) {
      excluded += 1;
      continue;
    }
    const text = (row.purpose ?? '').toLowerCase();
    for (const key of SKILL_KEYS) if (text.includes(key.replace(/_/g, ' '))) countInto(skills, key);
    if (text.startsWith('attack')) countInto(rolls, 'attack');
    else if (text.startsWith('damage')) countInto(rolls, 'damage');
    else if (text.includes('saving throw')) countInto(rolls, 'save');
    else countInto(rolls, 'check');
  }

  const actions: Record<string, number> = {};
  const effects: Record<string, number> = {};
  const ids = characterId === undefined ? null : combatantIds(db, campaignId, characterId);
  if (ids === null || ids.length > 0) {
    const rows = db
      .prepare(
        `SELECT l.kind AS kind, l.payload_json AS payload_json FROM combat_log l
         JOIN combatant c ON c.id = l.actor_id
         JOIN encounter e ON e.id = l.encounter_id
         WHERE e.campaign_id = ? AND (? IS NULL OR c.character_id = ?)`,
      )
      .all(campaignId, characterId ?? null, characterId ?? null) as Array<{ kind: string; payload_json: string | null }>;
    for (const row of rows) {
      const payload = parse<{ action?: string; name?: string }>(row.payload_json, {});
      if ((row.kind === 'attack' || row.kind === 'action') && payload.action) countInto(actions, payload.action);
      if (row.kind === 'effect_start' && payload.name) countInto(effects, payload.name);
    }
  }

  return { tags, excluded_rolls: excluded, exemplars, engine: { skills, rolls, actions, effects } };
}

// --- homebrew cadence --------------------------------------------------------

/**
 * How many story boons have gone on a sheet since the open chapter began - or, with no chapter open,
 * since this session started. With neither there is nothing to count from, so the cadence does not apply.
 */
export function boonsThisChapter(db: Db, campaignId: number): number {
  const chapter = currentChapter(db, campaignId);
  const session = getCampaign(db, campaignId).current_session_id;
  if (!chapter && !session) return 0;
  const rows = (
    chapter
      ? db
          .prepare("SELECT payload_json FROM event WHERE campaign_id = ? AND kind = 'feature' AND ts >= ?")
          .all(campaignId, chapter.started_at)
      : db
          .prepare("SELECT payload_json FROM event WHERE campaign_id = ? AND kind = 'feature' AND session_id = ?")
          .all(campaignId, session)
  ) as Array<{ payload_json: string | null }>;
  // Only what propose_feature applied counts: a homebrew spell is not a boon.
  return rows.filter((row) => parse<{ boon?: boolean }>(row.payload_json, {}).boon === true).length;
}

/** The line the DM is refused with when a second story boon is proposed inside the same chapter. */
export const ONE_BOON_PER_CHAPTER =
  'One story boon per chapter: a homebrew feature has already gone on the sheet since this chapter - or this session, with no chapter open - began. Hand this one out in the next chapter, or let the player decide.';

// --- the briefing block ------------------------------------------------------

interface DecisionSummaryRow {
  id: number;
  kind: string;
  payload_json: string;
  decision_json: string | null;
  resolved_at: string | null;
}

/**
 * The progression block of the campaign briefing: how this table runs and what is waiting. Empty
 * when there is nothing beyond the default rules/XP mode to say, so a fresh story stays short.
 */
export function progressionBriefing(db: Db, campaignId: number): string {
  const settings = getSettings(db, campaignId);
  const pc = db
    .prepare("SELECT id, name, level, xp, pending_level_up_json FROM character WHERE campaign_id = ? AND is_pc = 1 AND status = 'active' LIMIT 1")
    .get(campaignId) as
    | { id: number; name: string; level: number; xp: number; pending_level_up_json: string | null }
    | undefined;

  const prepared = pc ? parse<{ to_level?: number } | null>(pc.pending_level_up_json, null) : null;

  const open = db
    .prepare('SELECT id, kind, payload_json FROM pending_decision WHERE campaign_id = ? AND resolved_at IS NULL ORDER BY id')
    .all(campaignId) as DecisionSummaryRow[];

  const recent = db
    .prepare(
      'SELECT id, kind, payload_json, decision_json, resolved_at FROM pending_decision WHERE campaign_id = ? AND resolved_at IS NOT NULL ORDER BY id DESC LIMIT 3',
    )
    .all(campaignId) as DecisionSummaryRow[];
  const recentSummaries = recent
    .map((row) => parse<{ summary?: string }>(row.decision_json, {}).summary)
    .filter((summary): summary is string => !!summary);

  const profile = playProfile(db, campaignId);
  const top = Object.entries(profile.tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const defaultModes = settings.rules_mode === DEFAULT_SETTINGS.rules_mode && settings.xp_mode === DEFAULT_SETTINGS.xp_mode;
  const nothingToSay =
    defaultModes && !prepared?.to_level && open.length === 0 && recentSummaries.length === 0 && top.length === 0;
  if (nothingToSay) return '';

  const lines: string[] = ['## Progression', `Rules mode: ${settings.rules_mode}. XP mode: ${settings.xp_mode}.`];

  if (pc) {
    lines.push(
      prepared?.to_level
        ? `Level-up waiting for ${pc.name}: options for level ${prepared.to_level} are prepared.`
        : `${pc.name} is level ${pc.level} (${pc.xp} XP).`,
    );
  }

  for (const row of open) {
    const payload = parse<{ name?: string }>(row.payload_json, {});
    lines.push(`Waiting on the player: ${payload.name ?? row.kind} (decision ${row.id}).`);
  }

  for (const summary of recentSummaries) lines.push(summary);

  if (top.length) {
    lines.push(`Plays: ${top.map(([tag, count]) => `${tag} x${count}`).join(', ')}.`);
    const exemplar = profile.exemplars[0];
    if (exemplar) lines.push(`For example: ${exemplar.text}`);
  }
  return lines.join('\n');
}

/** An SRD feat is the unit the budget is measured in, so its report is a flat 1 of 1. */
export function srdFeatReport(name: string): PowerReport {
  const items: PowerItem[] = [
    { part: `${name} (SRD origin feat)`, cost: 1, rule: "An SRD feat is exactly one feat's worth of power." },
  ];
  return {
    budget_used: 1,
    budget_allowed: 1,
    items,
    verdict: 'within',
    text: `Power budget: 1 of 1 (within budget).\n- ${items[0]!.part}: 1 - ${items[0]!.rule}`,
  };
}

// --- level-up option details and the DM's recommendations --------------------

/** What the window's tooltip shows for one choosable option; the spell fields are absent elsewhere. */
export interface OptionDetail {
  name: string;
  short_text: string;
  level?: number;
  school?: string;
  casting_time?: string;
  range?: string;
  duration?: string;
  concentration?: boolean;
  prerequisite?: string | null;
  /** Set on an option the DM wrote, so the window can badge it and send its id back. */
  homebrew?: boolean;
  homebrew_id?: number;
}

const SHORT_TEXT_MAX = 300;

/** SRD descriptions run for paragraphs; a tooltip gets the first 300 characters of one line. */
function shortText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= SHORT_TEXT_MAX ? flat : `${flat.slice(0, SHORT_TEXT_MAX - 1).trimEnd()}…`;
}

function spellDetail(name: string): OptionDetail | undefined {
  const spell = findSpell(name);
  if (!spell) return undefined;
  return {
    name: spell.name,
    level: spell.level,
    school: spell.school,
    casting_time: spell.casting_time,
    range: spell.range_text,
    duration: spell.duration,
    concentration: spell.concentration,
    short_text: shortText(spell.desc),
  };
}

function featDetail(name: string): OptionDetail | undefined {
  const feat = srd.feats().find((f) => f.name === name);
  if (!feat) return undefined;
  const parts = [
    feat.prerequisites?.minimum_level ? `Level ${feat.prerequisites.minimum_level}` : '',
    feat.prerequisite_options?.desc ?? '',
  ].filter(Boolean);
  return { name: feat.name, prerequisite: parts.length ? parts.join('; ') : null, short_text: shortText(feat.description) };
}

/** A subclass is chosen at level 3, so what it is worth knowing is what it gives at level 3. */
function subclassDetail(name: string): OptionDetail | undefined {
  const subclass = srd.subclasses().find((s) => s.name === name);
  if (!subclass) return undefined;
  const features = subclass.features.filter((f) => f.level === 3);
  const text = features.length
    ? features.map((f) => `${f.name}: ${f.description}`).join(' ')
    : subclass.summary ?? subclass.description;
  return { name: subclass.name, short_text: shortText(text) };
}

const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

function abilityDetail(key: string): OptionDetail | undefined {
  const name = ABILITY_NAMES[key];
  const described = srd.abilityDescriptions().find((a) => a.fields.describes === key);
  if (!name || !described) return undefined;
  return { name, short_text: shortText(described.fields.desc) };
}

/** A campaign or library spell the level-up window offers, looked up when the SRD has no such name. */
function homebrewSpellDetailFor(db: Db, campaignId: number, name: string): OptionDetail | undefined {
  const entry = findHomebrewSpell(db, campaignId, name);
  return entry ? homebrewSpellDetail(entry) : undefined;
}

/**
 * Tooltip details for spells by name, keyed by the spell's own spelling: the SRD's when it has one,
 * the campaign's or the library's when the DM wrote it. A name neither knows is left out.
 */
export function spellOptionDetails(names: string[], db?: Db, campaignId?: number): Record<string, OptionDetail> {
  const details: Record<string, OptionDetail> = {};
  for (const name of names) {
    const detail =
      spellDetail(name) ?? (db && campaignId !== undefined ? homebrewSpellDetailFor(db, campaignId, name) : undefined);
    if (detail) details[detail.name] = detail;
  }
  return details;
}

/** Tooltip text for every option the player can choose at this level, keyed by the option's name. */
export function levelUpOptionDetails(
  options: Record<string, unknown>,
  db?: Db,
  campaignId?: number,
): Record<string, OptionDetail> {
  const details: Record<string, OptionDetail> = {};
  const put = (detail: OptionDetail | undefined): void => {
    if (detail) details[detail.name] = detail;
  };

  const spellcasting = options.spellcasting as
    | { cantrip_options?: string[]; spell_options?: Record<string, string[]> }
    | undefined;
  Object.assign(
    details,
    spellOptionDetails(
      [...(spellcasting?.cantrip_options ?? []), ...Object.values(spellcasting?.spell_options ?? {}).flat()],
      db,
      campaignId,
    ),
  );

  for (const subclass of (options.subclass_choice as
    | Array<{ name: string; text?: string; homebrew?: boolean; homebrew_id?: number }>
    | undefined) ?? []) {
    put(
      subclass.homebrew
        ? {
            name: subclass.name,
            short_text: shortText(subclass.text ?? ''),
            homebrew: true,
            ...(subclass.homebrew_id === undefined ? {} : { homebrew_id: subclass.homebrew_id }),
          }
        : subclassDetail(subclass.name),
    );
  }

  const asi = options.ability_score_improvement as { feat_options?: Array<{ name: string }> } | undefined;
  if (asi) {
    for (const feat of asi.feat_options ?? []) put(featDetail(feat.name));
    for (const key of ABILITY_KEYS) {
      const detail = abilityDetail(key);
      if (detail) details[key] = detail;
    }
  }
  return details;
}

/** The SRD options with the tooltip map beside them: what the window and the stored window carry. */
export function withOptionDetails(options: Record<string, unknown>, db?: Db, campaignId?: number): Record<string, unknown> {
  return { ...options, details: levelUpOptionDetails(options, db, campaignId) };
}

export interface Recommendation {
  name: string;
  why: string;
}

export interface LevelUpRecommendations {
  spells?: Recommendation[];
  cantrips?: Recommendation[];
  subclass?: Recommendation;
  feat?: Recommendation;
  asi?: { abilities: string[]; why: string };
  hp?: 'average' | 'roll';
}

/** The option's own spelling, so a recommendation keys straight into the details map. */
function canonical(valid: string[], name: string, what: string): string {
  const match = valid.find((option) => option.toLowerCase() === name.trim().toLowerCase());
  if (!match) {
    throw new Error(
      valid.length
        ? `"${name}" is not among the ${what} offered at this level. Valid options: ${valid.join(', ')}.`
        : `No ${what} are offered at this level, so "${name}" cannot be recommended.`,
    );
  }
  return match;
}

/**
 * Checks the DM's recommendations against the options actually on offer, so the window never shows a
 * recommendation the player cannot take. Names come back in the SRD's own spelling.
 */
export function validateRecommendations(
  options: Record<string, unknown>,
  recommendations: LevelUpRecommendations,
): LevelUpRecommendations {
  const spellcasting = options.spellcasting as
    | { cantrip_options?: string[]; spell_options?: Record<string, string[]> }
    | undefined;
  const spellOptions = Object.values(spellcasting?.spell_options ?? {}).flat();
  const cantripOptions = spellcasting?.cantrip_options ?? [];
  const subclassOptions = ((options.subclass_choice as Array<{ name: string }> | undefined) ?? []).map((s) => s.name);
  const asi = options.ability_score_improvement as { feat_options?: Array<{ name: string }> } | undefined;
  const featOptions = (asi?.feat_options ?? []).map((f) => f.name);

  const checked: LevelUpRecommendations = {};
  if (recommendations.spells) {
    checked.spells = recommendations.spells.map((r) => ({ ...r, name: canonical(spellOptions, r.name, 'spells') }));
  }
  if (recommendations.cantrips) {
    checked.cantrips = recommendations.cantrips.map((r) => ({ ...r, name: canonical(cantripOptions, r.name, 'cantrips') }));
  }
  if (recommendations.subclass) {
    checked.subclass = { ...recommendations.subclass, name: canonical(subclassOptions, recommendations.subclass.name, 'subclasses') };
  }
  if (recommendations.feat) {
    checked.feat = { ...recommendations.feat, name: canonical(featOptions, recommendations.feat.name, 'feats') };
  }
  if (recommendations.asi) {
    if (!asi) throw new Error('No ability score improvement is offered at this level.');
    const abilities = recommendations.asi.abilities.map((ability) =>
      canonical([...ABILITY_KEYS], ability, 'ability scores'),
    );
    checked.asi = { ...recommendations.asi, abilities };
  }
  if (recommendations.hp) checked.hp = recommendations.hp;
  return checked;
}

// --- custom subclasses -------------------------------------------------------

/** One feature of a custom subclass: how it reads, and the numbers behind it if it has any. */
export const featureSpecSchema = z.object({
  name: z.string().min(1),
  text: z.string().min(1),
  mechanics: mechanicsSchema.optional(),
  clauses: z.array(clauseSchema).max(CLAUSES_PER_BUNDLE_LEVEL).optional(),
});

export type FeatureSpec = z.infer<typeof featureSpecSchema>;

/** A subclass is feature bundles at the levels its class gives subclass features at. */
export const subclassSchema = z.object({
  class: z.string().min(1),
  name: z.string().min(1),
  flavour_text: z.string().min(1),
  features: z.record(
    z.string().regex(/^\d+$/, 'A feature bundle is keyed by its level, e.g. "3".'),
    z.array(featureSpecSchema).min(1),
  ),
});

export type SubclassSchema = z.infer<typeof subclassSchema>;

/** Validates the shape beyond the types: a real class, and levels a character actually reaches. */
export function validateSubclass(input: unknown): SubclassSchema {
  const parsed = subclassSchema.parse(input);
  const cls = findClass(parsed.class);
  const levels = Object.keys(parsed.features).map(Number);
  if (levels.length === 0) throw new Error('A subclass needs at least one level bundle, e.g. features: { "3": [...] }.');
  for (const level of levels) {
    if (level < 1 || level > 20) throw new Error(`Level ${level} is not a level a character reaches.`);
    // Decision 4: a bundle level carries two clauses; more than that is two boons, not one bundle.
    const clauses = (parsed.features[String(level)] ?? []).reduce((sum, f) => sum + (f.clauses?.length ?? 0), 0);
    if (clauses > CLAUSES_PER_BUNDLE_LEVEL) {
      throw new Error(
        `Level ${level} has ${clauses} clauses; a subclass bundle level carries ${CLAUSES_PER_BUNDLE_LEVEL}. Split the rest into a later level.`,
      );
    }
  }
  return { ...parsed, class: cls.name };
}

/** The one SRD subclass a class has, which every custom one for that class is measured against. */
const referenceSubclass = (className: string): srd.SubclassData | undefined => subclassesOf(findClass(className).index)[0];

/**
 * What the SRD subclass is worth at this level: its own mechanics when the data carries any, one
 * feat's worth when it is prose - which is what the bundled SRD is - and nothing at a level it
 * gives no feature at.
 */
function srdBundleAllowance(reference: srd.SubclassData | undefined, level: number): number {
  const features = (reference?.features ?? []).filter((f) => f.level === level);
  if (features.length === 0) return 0;
  const priced = features.reduce(
    (sum, feature) => sum + powerReport((feature as { mechanics?: Mechanics }).mechanics ?? {}).budget_used,
    0,
  );
  return priced > 0 ? quarter(priced) : 1;
}

export interface BundleReport {
  level: number;
  used: number;
  allowed: number;
  verdict: 'within' | 'over_budget';
  features: string[];
}

/** A power report with the per-level detail the subclass dialog shows beside the overall verdict. */
export interface SubclassReport extends PowerReport {
  bundles: BundleReport[];
}

/** Prices every level bundle against what the SRD subclass of the same class gives at that level. */
export function subclassReport(schema: SubclassSchema): SubclassReport {
  const reference = referenceSubclass(schema.class);
  const items: PowerItem[] = [];
  const bundles: BundleReport[] = [];
  for (const level of Object.keys(schema.features).map(Number).sort((a, b) => a - b)) {
    const features = schema.features[String(level)] ?? [];
    const allowed = srdBundleAllowance(reference, level);
    let used = 0;
    for (const feature of features) {
      const report = powerReport({ ...(feature.mechanics ?? {}), clauses: feature.clauses });
      used = quarter(used + report.budget_used);
      items.push({
        part: `Level ${level} - ${feature.name}`,
        cost: report.budget_used,
        rule: report.items.length
          ? report.items.map((item) => `${item.part} (${item.cost})`).join(', ')
          : 'Text with no numbers behind it costs nothing.',
      });
    }
    bundles.push({
      level,
      used,
      allowed,
      verdict: used > allowed ? 'over_budget' : 'within',
      features: features.map((f) => f.name),
    });
  }

  const verdict: PowerReport['verdict'] = bundles.some((b) => b.verdict === 'over_budget') ? 'over_budget' : 'within';
  const used = quarter(bundles.reduce((sum, b) => sum + b.used, 0));
  const allowed = quarter(bundles.reduce((sum, b) => sum + b.allowed, 0));
  const referenceName = reference ? reference.name : `the SRD ${schema.class} subclass`;
  const text = [
    `Power budget: ${used} of ${allowed} (${verdict === 'within' ? 'within budget' : 'over budget'}), measured against ${referenceName}.`,
    ...bundles.map(
      (bundle) =>
        `- Level ${bundle.level}: ${bundle.used} of ${bundle.allowed} (${bundle.features.join(', ')})${
          bundle.allowed === 0 ? ` - ${referenceName} gives nothing at level ${bundle.level}.` : ''
        }`,
    ),
    verdict === 'within'
      ? 'Every bundle is worth about what the SRD subclass gives at that level, so it is fair to hand out.'
      : `Over budget at level ${bundles
          .filter((b) => b.verdict === 'over_budget')
          .map((b) => b.level)
          .join(', ')}; it will outshine the subclass the rules ship with.`,
  ].join('\n');
  return { budget_used: used, budget_allowed: allowed, items, verdict, bundles, text };
}

/** The custom subclasses this campaign may choose for a class: its own plus the personal library. */
export function customSubclasses(db: Db, campaignId: number, className: string): Homebrew[] {
  const wanted = className.trim().toLowerCase();
  return listHomebrew(db, campaignId, 'subclass').filter(
    (entry) => String((entry.schema as Partial<SubclassSchema>).class ?? '').toLowerCase() === wanted,
  );
}

/** The features a custom subclass gives at one level, or none when it gives nothing there. */
export function customSubclassFeatures(db: Db, homebrewId: number | null, level: number): FeatureSpec[] {
  if (homebrewId === null) return [];
  const entry = getHomebrew(db, homebrewId);
  if (!entry || entry.kind !== 'subclass') return [];
  return ((entry.schema as Partial<SubclassSchema>).features ?? {})[String(level)] ?? [];
}

// --- custom spells -----------------------------------------------------------

/** A spell the DM wrote, as data the combat engine can execute rather than prose it has to read. */
export const spellSchema = z.object({
  name: z.string().min(1),
  level: z.number().int().min(0).max(9),
  school: z.string().min(1),
  casting_time: z.string().min(1),
  range: z.string().min(1),
  components: z.string().min(1),
  duration: z.string().min(1),
  concentration: z.boolean().default(false),
  ritual: z.boolean().default(false),
  classes: z.array(z.string().min(1)).optional(),
  // The same effect an `action` clause carries, so a spell and a feature's action are one shape.
  effect: spellEffectSchema,
  text: z.string().min(1),
});

export type SpellSchema = z.infer<typeof spellSchema>;

/** Validates what the types cannot: a save spell needs a save, a healing spell needs healing dice. */
export function validateSpell(input: unknown): SpellSchema {
  const parsed = spellSchema.parse(input);
  const { kind, damage, healing, save_ability, condition } = parsed.effect;
  if (kind === 'save' && !save_ability) throw new Error('A save spell needs save_ability; the DC comes from the caster.');
  if (kind === 'heal' && !healing) throw new Error('A healing spell needs effect.healing.dice.');
  if ((kind === 'attack' || kind === 'auto') && !damage && !condition) {
    throw new Error(`A ${kind} spell needs effect.damage or effect.condition; use kind "utility" for one that does neither.`);
  }
  return parsed;
}

/** The maximum a dice expression can roll, which is how spell damage is compared here. */
function maxRoll(expr: string): number {
  let total = 0;
  for (const [, count, faces] of expr.matchAll(/(\d*)d(\d+)/gi)) total += Number(count || 1) * Number(faces);
  for (const [, sign, flat] of expr.matchAll(/([+-])\s*(\d+)(?!\s*d)/gi)) total += (sign === '-' ? -1 : 1) * Number(flat);
  return total;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export type SpellBudgetKind = 'single' | 'aoe' | 'heal';

export interface SpellBudget {
  level: number;
  kind: SpellBudgetKind;
  /** The most a spell of this level and kind may roll: the median of the SRD spells beside it. */
  max_damage: number;
  samples: number;
  /** The SRD spell closest to that number, so the report can name one the DM knows. */
  reference: { name: string; dice: string } | null;
}

/** The SRD spells of one level the budget is the median of. */
function srdSpellSamples(level: number, kind: SpellBudgetKind): Array<{ name: string; dice: string; max: number }> {
  const rows = srd.spells().filter((s) => s.fields.level === level && s.fields.damage_roll);
  const wanted = rows.filter((s) => {
    const fields = s.fields as srd.SpellFields & { shape_type?: string | null };
    // Open5e leaves damage_types empty on the spells whose dice heal rather than hurt.
    if (kind === 'heal') return fields.damage_types.length === 0 && /regains?\b/i.test(fields.desc);
    if (fields.damage_types.length === 0) return false;
    return (kind === 'aoe') === Boolean(fields.shape_type);
  });
  return wanted.map((s) => ({ name: s.fields.name, dice: s.fields.damage_roll!, max: maxRoll(s.fields.damage_roll!) }));
}

const budgetCache = new Map<string, SpellBudget>();

/** What a spell of this level may roll: the median of the SRD spells it stands beside. */
export function spellBudget(level: number, kind: SpellBudgetKind): SpellBudget {
  const key = `${level}:${kind}`;
  const cached = budgetCache.get(key);
  if (cached) return cached;
  const samples = srdSpellSamples(level, kind);
  // The SRD heals at few levels; where it does not, healing is held to the single-target budget.
  if (samples.length === 0) {
    const fallback: SpellBudget =
      kind === 'single'
        ? { level, kind, max_damage: (level + 1) * 8, samples: 0, reference: null }
        : { ...spellBudget(level, 'single'), kind };
    budgetCache.set(key, fallback);
    return fallback;
  }
  const max = median(samples.map((s) => s.max))!;
  const reference = [...samples].sort((a, b) => Math.abs(a.max - max) - Math.abs(b.max - max))[0]!;
  const budget: SpellBudget = {
    level,
    kind,
    max_damage: max,
    samples: samples.length,
    reference: { name: reference.name, dice: reference.dice },
  };
  budgetCache.set(key, budget);
  return budget;
}

const SPELL_LEVEL_NAMES = [
  'cantrip',
  '1st-level',
  '2nd-level',
  '3rd-level',
  '4th-level',
  '5th-level',
  '6th-level',
  '7th-level',
  '8th-level',
  '9th-level',
];

const spellLevelName = (level: number): string => SPELL_LEVEL_NAMES[level] ?? `level ${level}`;

const BUDGET_LABEL: Record<SpellBudgetKind, string> = { single: 'single-target', aoe: 'area', heal: 'healing' };

/** Prices a spell the DM wrote against the SRD spells of its own level. */
export function spellReport(schema: SpellSchema): PowerReport {
  const { effect, level } = schema;

  if (effect.kind === 'utility' || (!effect.damage && !effect.healing)) {
    const item: PowerItem = {
      part: `${schema.name}: no damage and no healing`,
      cost: 0.5,
      rule: 'A spell that only changes the fiction is priced at a flat 0.5.',
    };
    return {
      budget_used: 0.5,
      budget_allowed: 1,
      items: [item],
      verdict: 'within',
      text: `Power budget: 0.5 of 1 (within budget).\n- ${item.part}: ${item.cost} - ${item.rule}\nA ${spellLevelName(level)} spell with no dice behind it always fits.`,
    };
  }

  const healing = effect.kind === 'heal' && effect.healing !== undefined;
  const dice = healing ? effect.healing!.dice : effect.damage!.dice;
  const kind: SpellBudgetKind = healing ? 'heal' : effect.shape ? 'aoe' : 'single';
  const budget = spellBudget(level, kind);
  const rolled = maxRoll(dice);
  const items: PowerItem[] = [
    {
      part: healing
        ? `${dice} healing`
        : `${dice} ${effect.damage!.type} damage${effect.shape ? ` in a ${effect.shape.size_ft} ft ${effect.shape.kind}` : ''}`,
      cost: rolled,
      rule: budget.reference
        ? `The ${spellLevelName(level)} SRD ${BUDGET_LABEL[kind]} spells roll ${budget.max_damage} at most on the median of ${budget.samples}, about ${budget.reference.name} (${budget.reference.dice}).`
        : `A ${spellLevelName(level)} ${BUDGET_LABEL[kind]} spell is held to ${budget.max_damage}.`,
    },
  ];

  let used = rolled;
  if (effect.condition) {
    const rider = quarter(budget.max_damage * 0.25);
    used += rider;
    items.push({
      part: `Leaves the target ${effect.condition.name}${effect.condition.duration_rounds ? ` for ${effect.condition.duration_rounds} rounds` : ''}`,
      cost: rider,
      rule: 'A condition on top of the dice costs a quarter of the level budget.',
    });
  }

  const verdict: PowerReport['verdict'] = used > budget.max_damage ? 'over_budget' : 'within';
  const explanation = `${dice}${healing ? ' healing' : ` ${effect.damage!.type}`} at ${
    level === 0 ? 'cantrip level' : `level ${level}`
  } rolls ${rolled} at most, ${used > budget.max_damage ? 'above' : 'within'} the ${spellLevelName(level)} ${BUDGET_LABEL[kind]} budget of ${budget.max_damage}${
    budget.reference ? ` (about ${budget.reference.name}, ${budget.reference.dice})` : ''
  }.`;
  const text = [
    `Power budget: ${used} of ${budget.max_damage} (${verdict === 'within' ? 'within budget' : 'over budget'}).`,
    ...items.map((item) => `- ${item.part}: ${item.cost} - ${item.rule}`),
    explanation,
    verdict === 'within'
      ? 'It sits where the rules put spells of its level, so it is fair to hand out.'
      : `Cut it to ${budget.max_damage} at most, or write it as a spell of a higher level.`,
  ].join('\n');
  return { budget_used: used, budget_allowed: budget.max_damage, items, verdict, text };
}

/** A spell the DM wrote, found by name the way findSpell finds an SRD one. */
export function findHomebrewSpell(db: Db, campaignId: number, name: string): Homebrew | undefined {
  const row = db
    .prepare(
      `SELECT * FROM homebrew WHERE kind = 'spell' AND lower(name) = lower(?) AND (campaign_id = ? OR scope = 'library') ORDER BY id DESC LIMIT 1`,
    )
    .get(name.trim(), campaignId) as HomebrewRow | undefined;
  return row ? expandHomebrew(row) : undefined;
}

/** Whether a class may cast this custom spell; one with no class list is open to every caster. */
export function spellFitsClass(schema: Partial<SpellSchema>, className: string): boolean {
  const classes = schema.classes ?? [];
  return classes.length === 0 || classes.some((c) => c.trim().toLowerCase() === className.trim().toLowerCase());
}

/** The custom spells of one level this campaign's class may take: its own plus the library's. */
export function customSpells(db: Db, campaignId: number, className: string, level: number): Homebrew[] {
  return listHomebrew(db, campaignId, 'spell').filter((entry) => {
    const schema = entry.schema as Partial<SpellSchema>;
    return schema.level === level && spellFitsClass(schema, className);
  });
}

/** The homebrew spells on a sheet, for the homebrew_spells block beside spells_json. */
export function homebrewSpellsOn(
  db: Db,
  campaignId: number,
  spells: { cantrips?: string[]; known?: string[]; prepared?: string[] } | null,
): Array<{ name: string; level: number; homebrew_id: number }> {
  if (!spells) return [];
  const names = new Set([...(spells.cantrips ?? []), ...(spells.known ?? []), ...(spells.prepared ?? [])]);
  const out: Array<{ name: string; level: number; homebrew_id: number }> = [];
  for (const name of names) {
    const entry = findHomebrewSpell(db, campaignId, name);
    if (entry) {
      out.push({ name: entry.name, level: Number((entry.schema as Partial<SpellSchema>).level ?? 0), homebrew_id: entry.id });
    }
  }
  return out;
}

export interface CustomSpellParams {
  damage_expr?: string;
  damage_type?: string;
  save_ability?: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
  save_dc?: number;
  half_on_save?: boolean;
  shape?: { kind: 'sphere' | 'cone' | 'line' | 'cube'; size_ft: number };
  heal_expr?: string;
  concentration?: boolean;
  effect?: {
    name: string;
    kind: 'condition';
    tick: 'end';
    ends: 'rounds' | 'concentration' | 'manual';
    remaining_rounds?: number;
  };
}

/** The use_action parameters a custom spell resolves to; the DC is the caster's own spell save DC. */
export function customSpellParams(schema: SpellSchema, saveDc: number | null): CustomSpellParams {
  const { effect } = schema;
  const save = effect.kind === 'save' ? effect.save_ability : undefined;
  return {
    ...(effect.damage ? { damage_expr: effect.damage.dice, damage_type: effect.damage.type } : {}),
    ...(save ? { save_ability: save } : {}),
    ...(save && saveDc !== null ? { save_dc: saveDc } : {}),
    ...(effect.half_on_save === undefined ? {} : { half_on_save: effect.half_on_save }),
    ...(effect.shape ? { shape: effect.shape } : {}),
    ...(effect.healing ? { heal_expr: effect.healing.dice } : {}),
    ...(schema.concentration ? { concentration: true } : {}),
    ...(effect.condition
      ? {
          effect: {
            name: effect.condition.name.trim().toLowerCase(),
            kind: 'condition' as const,
            tick: 'end' as const,
            ends: effect.condition.duration_rounds
              ? ('rounds' as const)
              : schema.concentration
                ? ('concentration' as const)
                : ('manual' as const),
            ...(effect.condition.duration_rounds ? { remaining_rounds: effect.condition.duration_rounds } : {}),
          },
        }
      : {}),
  };
}

/** The custom spell a combatant is casting by name, with its parameters already mapped. */
export function customSpellAction(db: Db, campaignId: number, name: string, saveDc: number | null): CustomSpellParams | null {
  const entry = findHomebrewSpell(db, campaignId, name);
  if (!entry) return null;
  const parsed = spellSchema.safeParse(entry.schema);
  return parsed.success ? customSpellParams(parsed.data, saveDc) : null;
}

/** The tooltip entry for a custom spell, built from its schema the way an SRD one is from the SRD. */
export function homebrewSpellDetail(entry: Homebrew): OptionDetail {
  const schema = entry.schema as Partial<SpellSchema>;
  return {
    name: entry.name,
    level: schema.level ?? 0,
    school: schema.school,
    casting_time: schema.casting_time,
    range: schema.range,
    duration: schema.duration,
    concentration: schema.concentration ?? false,
    short_text: shortText(schema.text ?? ''),
    homebrew: true,
    homebrew_id: entry.id,
  };
}
