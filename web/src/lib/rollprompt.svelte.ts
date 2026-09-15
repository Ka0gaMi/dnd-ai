// The roll the DM is waiting for: one card at a time, from the ask to the result the ledger keeps.
import type { PendingRoll, RollGroup, RollResult } from './types';

/** waiting: nothing rolled yet · preview: cheat mode has seen the dice · editing: typing a result. */
export type RollPhase = 'waiting' | 'preview' | 'editing' | 'resolved';

/** The step of a fight a card belongs to, as the server tags it. */
export type RollStep = 'attack' | 'damage' | 'save' | 'check' | 'initiative' | 'death_save';

export interface RollContext {
  encounter_id: number | null;
  tool: string;
  step: RollStep;
  actor_id: number;
  target_id?: number;
}

const STEP_LABELS: Record<RollStep, string> = {
  attack: 'Attack',
  damage: 'Damage',
  save: 'Save',
  check: 'Ability check',
  initiative: 'Initiative',
  death_save: 'Death save',
};

/** The fight step the server tagged this card with, or null for a roll outside one. */
export function rollContext(roll: PendingRoll | null | undefined): RollContext | null {
  if (!roll?.context_json) return null;
  try {
    const parsed = JSON.parse(roll.context_json) as RollContext;
    return parsed && STEP_LABELS[parsed.step] ? parsed : null;
  } catch {
    return null;
  }
}

export const stepLabel = (step: RollStep): string => STEP_LABELS[step];

/**
 * What the card calls this roll. An ability check - a grapple, an escape, a Stealth check to hide -
 * comes tagged step 'check', so its own purpose names it rather than the step's plain "Ability check".
 */
export function rollLabel(roll: PendingRoll, context: RollContext | null): string {
  if (roll.roll_type === 'check') {
    const head = roll.purpose.split(/[:(]/)[0]!.trim();
    return head || 'Check';
  }
  return context ? STEP_LABELS[context.step] : roll.roll_type.replace(/_/g, ' ');
}

const TERM = /^([+-])?\s*(?:(\d*)d(\d+)|(\d+))$/i;

const parts = (expr: string): string[] => expr.replace(/\s+/g, '').split(/(?=[+-])/);

/** How many sides each die of an expression has, in written order; null when it is not a plain one. */
export function expressionDice(expr: string): number[] | null {
  const sides: number[] = [];
  for (const part of parts(expr)) {
    const match = TERM.exec(part);
    if (!match) return null;
    if (match[3]) for (let i = 0; i < Number(match[2] || '1'); i += 1) sides.push(Number(match[3]));
  }
  return sides.length > 0 ? sides : null;
}

/** The flat part of an expression, as the Change form shows it beside the dice boxes. */
export function modifierText(expr: string): string {
  let flat = 0;
  for (const part of parts(expr)) {
    const match = TERM.exec(part);
    if (!match || match[4] === undefined) continue;
    flat += (match[1] === '-' ? -1 : 1) * Number(match[4]);
  }
  return flat === 0 ? '' : flat > 0 ? `+${flat}` : `-${Math.abs(flat)}`;
}

/** The total the boxes would make, or null while one of them is empty or shows what the die cannot. */
export function editedTotal(expr: string, dice: string[]): number | null {
  const sides = expressionDice(expr);
  if (!sides || sides.length !== dice.length) return null;
  let total = 0;
  for (const [index, typed] of dice.entries()) {
    const value = Number(typed.trim());
    if (typed.trim() === '' || !Number.isInteger(value) || value < 1 || value > sides[index]!) return null;
    total += value;
  }
  return total + Number(modifierText(expr) || 0);
}

/** The dice a result kept, as the boxes start out: the dropped ones belong to the pool, not the player. */
export function keptDice(groups: RollGroup[]): string[] {
  const kept: string[] = [];
  for (const group of groups) {
    if (typeof group !== 'object' || group === null || !('dice' in group)) continue;
    for (const die of group.dice) {
      if (!die.modifiers.some((modifier) => modifier.startsWith('drop'))) kept.push(String(die.value));
    }
  }
  return kept;
}

/** Oldest first: the DM waits on the cards in the order they were asked for. */
const inOrder = (rows: PendingRoll[]): PendingRoll[] => [...rows].sort((a, b) => a.id - b.id);

/** Seconds before the DM stops waiting: the roll card counts down with it, and so does a decision. */
export function secondsLeft(row: { created_at: string }, timeoutS: number, now: number): number {
  const started = Date.parse(row.created_at);
  if (Number.isNaN(started)) return timeoutS;
  return Math.max(0, Math.ceil((started + timeoutS * 1000 - now) / 1000));
}

export class RollPromptStore {
  /** Oldest first: the DM waits on them in order. */
  queue = $state<PendingRoll[]>([]);
  phase = $state<RollPhase>('waiting');
  result = $state<RollResult | null>(null);
  /** What the cheat-mode player is typing: one box per die, the preview's dice until they change them. */
  edit = $state<string[]>([]);
  note = $state<string | null>(null);
  error = $state<string | null>(null);
  busy = $state(false);

  get current(): PendingRoll | null {
    return this.queue[0] ?? null;
  }

  /** The fight step of the card on screen, for the chip above it. */
  get context(): RollContext | null {
    return rollContext(this.current);
  }

  /** The dice the Change form asks for; empty when the expression is not one the player can set. */
  get editableDice(): number[] {
    return this.current ? (expressionDice(this.current.expr) ?? []) : [];
  }

  /** The open rolls on connect; already-queued ones keep their place and their phase. */
  setOpen(rows: PendingRoll[]): void {
    const known = new Set(this.queue.map((row) => row.id));
    this.queue = inOrder([...this.queue, ...rows.filter((row) => !known.has(row.id) && row.resolved_at === null)]);
  }

  add(row: PendingRoll): void {
    if (this.queue.some((queued) => queued.id === row.id)) return;
    this.queue = inOrder([...this.queue, row]);
  }

  /** A selected boost recomputes the pending-roll card before its dice are on the table. */
  updateCurrent(row: PendingRoll): void {
    if (this.current?.id !== row.id) return;
    this.queue = [row, ...this.queue.slice(1)];
  }

  /** A boost was applied to the card on screen: the card stands, and the player may roll again. */
  boosted(row: PendingRoll): void {
    this.busy = false;
    this.updateCurrent(row);
  }

  start(): void {
    this.busy = true;
    this.error = null;
  }

  /** Cheat mode rolled the real dice: show them, with every die ready to edit. */
  showPreview(result: RollResult): void {
    this.busy = false;
    this.phase = 'preview';
    this.result = result;
    this.edit = keptDice(result.groups);
  }

  /** "Change" on a preview, or "Set result" before rolling at all. */
  editResult(): void {
    if (this.edit.length !== this.editableDice.length) this.edit = this.editableDice.map(() => '');
    this.phase = 'editing';
  }

  showResult(result: RollResult): void {
    this.busy = false;
    this.phase = 'resolved';
    this.result = result;
  }

  /** 409: the timeout or the DM got there first, so the ledger already has the answer. */
  resolvedElsewhere(): void {
    this.busy = false;
    this.phase = 'resolved';
    this.result = null;
    this.note = 'Rolled without you.';
  }

  fail(message: string): void {
    this.busy = false;
    this.error = message;
  }

  /** The card collapses: the roll now lives in the dice ledger. */
  dismiss(): void {
    this.queue = this.queue.slice(1);
    this.phase = 'waiting';
    this.result = null;
    this.note = null;
    this.error = null;
    this.busy = false;
    this.edit = [];
  }

  clear(): void {
    this.queue = [];
    this.dismiss();
  }
}
