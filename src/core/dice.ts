import { DiceRoll } from '@dice-roller/rpg-dice-roller';

export type Advantage = 'none' | 'advantage' | 'disadvantage';
export type RollType = 'attack' | 'check' | 'save' | 'damage' | 'other';
export type Outcome = 'success' | 'failure' | 'critical_hit' | 'miss' | null;

export interface DieDetail {
  value: number;
  modifiers: string[];
}

export interface RollDetail {
  expr: string;
  requested_expr: string;
  advantage: Advantage;
  total: number;
  output: string;
  groups: Array<{ value: number; dice: DieDetail[] } | string | number>;
  natural_d20: number | null;
  natural: 20 | 1 | null;
  roll_type: RollType;
  dc: number | null;
  outcome: Outcome;
}

const LEADING_D20 = /^(\s*)(1?d20)/i;

/** Non-game randomness (map seeds): the only Math.random in the server lives here. */
export const randomSeed = (): number => Math.floor(Math.random() * 1_000_000);

export function rollDice(
  expr: string,
  options: { advantage?: Advantage; dc?: number | null; roll_type?: RollType; luck_bias?: number } = {},
): RollDetail {
  const advantage = options.advantage ?? 'none';
  const dc = options.dc ?? null;
  const rollType = options.roll_type ?? 'other';
  const isD20Check = LEADING_D20.test(expr);
  const rolled = applyAdvantage(expr, advantage, isD20Check, options.luck_bias ?? 0);

  let roll: DiceRoll;
  try {
    roll = new DiceRoll(rolled);
  } catch (err) {
    throw new Error(`Invalid dice notation "${expr}": ${(err as Error).message}`);
  }

  const groups = describeGroups(roll.rolls as unknown[]);
  const first = groups[0];
  const natural = isD20Check && typeof first === 'object' && first !== null ? first.value : null;

  return {
    expr: rolled,
    requested_expr: expr,
    advantage,
    total: roll.total,
    output: roll.output,
    groups,
    natural_d20: natural,
    natural: natural === 20 || natural === 1 ? natural : null,
    roll_type: rollType,
    dc,
    outcome: judge(roll.total, natural, dc, rollType),
  };
}

/**
 * The d20 pool: one die, one more for advantage or disadvantage, and |luck_bias| more from the
 * player's luck dial. The dial only adds dice when it pulls the same way as the advantage.
 */
function applyAdvantage(expr: string, advantage: Advantage, isD20Check: boolean, luckBias: number): string {
  if (!isD20Check) return expr;
  const high = advantage === 'none' ? luckBias > 0 : advantage === 'advantage';
  const luckAgrees = advantage === 'none' || high === luckBias > 0;
  const dice = 1 + (advantage === 'none' ? 0 : 1) + (luckAgrees ? Math.abs(Math.trunc(luckBias)) : 0);
  if (dice === 1) return expr;
  return expr.replace(LEADING_D20, `$1${dice}d20k${high ? 'h' : 'l'}1`);
}

/**
 * The roll as anyone but the player may see it: the dice the luck dial added are folded away, so the
 * expression and the output read as the roll that was asked for. Advantage is public and keeps its
 * two dice. `groups` still carries the whole pool, which is what the roll row and the ledger keep.
 */
export function withoutLuckPool(detail: RollDetail): RollDetail {
  const visible = applyAdvantage(detail.requested_expr, detail.advantage, LEADING_D20.test(detail.requested_expr), 0);
  if (visible === detail.expr) return detail;
  const shown = detail.advantage === 'none' ? 1 : 2;
  const output = detail.output
    .replace(/^[^:]*:/, `${visible}:`)
    .replace(/\[([^\]]*)\]/, (_match, inner: string) => `[${visibleDice(inner, shown)}]`);
  return { ...detail, expr: visible, output };
}

/** The die the pool kept, plus as many of the dropped ones as the visible expression rolls. */
function visibleDice(inner: string, count: number): string {
  const rolled = inner.split(', ');
  const kept = rolled.filter((die) => !die.endsWith('d'));
  const dropped = rolled.filter((die) => die.endsWith('d'));
  return [...kept, ...dropped.slice(0, Math.max(0, count - kept.length))].join(', ');
}

/** One written part of an expression: a group of dice, or a flat number. */
interface Term {
  sign: 1 | -1;
  count: number;
  sides: number;
  flat: number;
}

const TERM = /^([+-])?\s*(?:(\d*)d(\d+)|(\d+))$/i;

/** The terms of a plain expression ("2d6+1d4+3"), in the order they are written; null for anything else. */
function terms(expr: string): Term[] | null {
  const parts = expr.replace(/\s+/g, '').split(/(?=[+-])/);
  const out: Term[] = [];
  for (const part of parts) {
    const match = TERM.exec(part);
    if (!match) return null;
    const sign = match[1] === '-' ? -1 : 1;
    if (match[3]) out.push({ sign, count: Number(match[2] || '1'), sides: Number(match[3]), flat: 0 });
    else out.push({ sign, count: 0, sides: 0, flat: Number(match[4]) });
  }
  return out.length > 0 ? out : null;
}

/** How many sides each die of an expression has, in written order; null when its dice cannot be edited. */
export function expressionDice(expr: string): number[] | null {
  const parsed = terms(expr);
  if (!parsed) return null;
  const sides: number[] = [];
  for (const term of parsed) for (let i = 0; i < term.count; i += 1) sides.push(term.sides);
  return sides;
}

/**
 * Cheat mode edits the dice themselves, never the total or the modifiers: one value per die the
 * expression rolls (the kept ones - advantage and the luck dial roll their pool by themselves), and
 * the total, the natural, the output and the outcome all follow from them.
 */
export function applyRollOverride(detail: RollDetail, dice: number[]): RollDetail {
  const parsed = terms(detail.requested_expr);
  if (!parsed) return detail;
  const groups: RollDetail['groups'] = [];
  let total = 0;
  let natural: number | null = null;
  let taken = 0;
  let output = '';
  parsed.forEach((term, index) => {
    const sign = term.sign === -1 ? '-' : index === 0 ? '' : '+';
    if (term.count === 0) {
      total += term.sign * term.flat;
      if (index > 0) groups.push(term.sign === -1 ? '-' : '+');
      groups.push(term.flat);
      output += `${sign}${term.flat}`;
      return;
    }
    const values = dice.slice(taken, taken + term.count);
    taken += term.count;
    const sum = values.reduce((running, value) => running + value, 0);
    total += term.sign * sum;
    if (natural === null && term.sides === 20) natural = values[0] ?? null;
    if (index > 0) groups.push(term.sign === -1 ? '-' : '+');
    groups.push({ value: sum, dice: values.map((value) => ({ value, modifiers: [] })) });
    output += `${sign}[${values.join(', ')}]`;
  });
  return {
    ...detail,
    total,
    output: `${detail.requested_expr}: ${output} = ${total}`,
    groups,
    natural_d20: natural,
    natural: natural === 20 || natural === 1 ? natural : null,
    outcome: judge(total, natural, detail.dc, detail.roll_type),
  };
}

/** 2024 rules: a natural 20 or 1 only decides the result on an attack roll, never on a check or save. */
function judge(total: number, natural: number | null, dc: number | null, rollType: RollType): Outcome {
  if (rollType === 'attack') {
    if (natural === 20) return 'critical_hit';
    if (natural === 1) return 'miss';
  }
  if (dc === null) return null;
  return total >= dc ? 'success' : 'failure';
}

function describeGroups(rolls: unknown[]): RollDetail['groups'] {
  return rolls.map((group) => {
    if (typeof group === 'object' && group !== null && 'rolls' in group) {
      const g = group as { value: number; rolls: Array<{ value: number; modifiers: Set<string> }> };
      return {
        value: g.value,
        dice: g.rolls.map((die) => ({ value: die.value, modifiers: [...die.modifiers] })),
      };
    }
    return group as string | number;
  });
}
