// The battle screen's state: the server's BattleState applied as it arrives, plus the fight log it writes.
import type {
  BattleMap,
  BattleState,
  Combatant,
  CombatantSummary,
  CombatEventPayload,
  CombatLogEntry,
  DefeatedFoe,
  KnownStats,
  Visibility,
} from './types';

/** Totals run over the full log, so this only guards against a truly pathological grind. */
const LOG_LIMIT = 2000;
const CELL_FT = 5;

export interface HpView {
  numbers: boolean;
  bar: boolean;
  ac: boolean;
  bloodied: boolean;
  fraction: number;
}

/** What the player may see of one combatant's health: the party always in full, enemies per the DM's setting. */
export function visibleHp(combatant: Combatant, visibility: Visibility): HpView {
  const fraction = combatant.alive ? Math.max(0, Math.min(1, combatant.hp_fraction)) : 0;
  if (combatant.team === 'party' || visibility === 'full') {
    return { numbers: true, bar: true, ac: true, bloodied: false, fraction };
  }
  if (visibility === 'bars') return { numbers: false, bar: true, ac: false, bloodied: false, fraction };
  return { numbers: false, bar: false, ac: false, bloodied: combatant.alive && fraction < 0.5, fraction };
}

/** The stat-block facts a card may show: the party always, an enemy only once the DM reveals everything. */
export function visibleKnown(combatant: Combatant, visibility: Visibility): KnownStats | null {
  if (!combatant.known) return null;
  return combatant.team === 'party' || visibility === 'full' ? combatant.known : null;
}

export interface StateChip {
  /** The flag this chip came from, so the tooltip can look its rule up. */
  flag: string;
  label: string;
}

/** The 2024 action states a combatant is carrying, as the chips beside its name. */
export function flagChips(combatant: Combatant, nameOf: (id: number) => string): StateChip[] {
  const flags = combatant.flags ?? {};
  const chips: StateChip[] = [];
  if (flags.dodging) chips.push({ flag: 'dodging', label: 'Dodging' });
  if (flags.disengaged) chips.push({ flag: 'disengaged', label: 'Disengaged' });
  if (flags.hidden) chips.push({ flag: 'hidden', label: 'Hidden' });
  if (flags.helped_by) chips.push({ flag: 'helped_by', label: `Helped by ${flags.helped_by.name}` });
  if (flags.ready) chips.push({ flag: 'ready', label: `Ready: ${flags.ready.trigger}` });
  if (flags.grappled_by !== undefined) {
    chips.push({ flag: 'grappled_by', label: `Grappled by ${nameOf(flags.grappled_by)}` });
  }
  if (flags.grappling?.length) {
    chips.push({ flag: 'grappling', label: `Grappling ${flags.grappling.map(nameOf).join(', ')}` });
  }
  return chips;
}

/** What each condition does, as the log entry that applied it spelled it out; the newest entry wins. */
export function conditionEffects(log: CombatLogEntry[]): Map<string, string> {
  const effects = new Map<string, string>();
  for (const entry of log) {
    if (entry.kind !== 'condition') continue;
    const p = (entry.payload ?? {}) as { condition?: string; effect?: string | null };
    if (!p.condition || !p.effect || effects.has(p.condition)) continue;
    effects.set(p.condition, p.effect);
  }
  return effects;
}

/** The combatants who were caught out when the fight began, from the initiative entries. */
export function surprisedIds(log: CombatLogEntry[]): Set<number> {
  const caught = new Set<number>();
  for (const entry of log) {
    const p = (entry.payload ?? {}) as { surprised?: boolean };
    if (entry.kind === 'initiative' && p.surprised && entry.actor_id !== null) caught.add(entry.actor_id);
  }
  return caught;
}

/** The "Not proficient…" note the server tacks onto a weapon hint, split out so it can be greyed. */
export function splitHint(hint: string): { hint: string; caveat: string | null } {
  const found = /\s*(Not proficient:[^.]*\.)/.exec(hint);
  if (!found) return { hint, caveat: null };
  return { hint: hint.replace(found[0], ' ').replace(/\s+/g, ' ').trim(), caveat: found[1]! };
}

export interface LogChip {
  label: string;
  tone: string;
}

/** Chips for what the payload actually carries; kinds without numbers fall back to the server's sentence. */
export function fightLogChips(entry: CombatLogEntry): LogChip[] {
  const p = (entry.payload ?? {}) as Record<string, unknown>;
  const chips: LogChip[] = [];
  const natural = (value: unknown): void => {
    if (value === 20) chips.push({ label: 'Natural 20', tone: 'accent' });
    if (value === 1) chips.push({ label: 'Natural 1', tone: 'bad' });
  };
  const saveChip = (): void => {
    const rolled = p.save as { total?: number; dc?: number; ability?: string } | undefined;
    if (rolled?.total === undefined) return;
    chips.push({ label: `${rolled.total} vs DC ${rolled.dc} ${(rolled.ability ?? '').toUpperCase()}`.trim(), tone: '' });
  };

  if (entry.kind === 'attack') {
    const roll = p.roll as { total?: number; natural?: number | null } | undefined;
    if (roll?.total !== undefined) chips.push({ label: `${roll.total} vs AC ${p.effective_ac}`, tone: '' });
    natural(p.natural ?? roll?.natural);
    chips.push(
      p.critical
        ? { label: 'Critical hit', tone: 'accent' }
        : p.hit
          ? { label: 'Hit', tone: 'good' }
          : { label: 'Miss', tone: 'bad' },
    );
    if (p.auto_crit) chips.push({ label: 'Helpless: automatic critical', tone: 'accent' });
    if (p.grip) chips.push({ label: p.grip === 'two_hands' ? 'Two-handed' : 'One-handed', tone: '' });
    if (p.cover && p.cover !== 'none') chips.push({ label: `${String(p.cover).replace('_', '-')} cover`, tone: '' });
  }
  if (entry.kind === 'damage' || entry.kind === 'effect_tick') {
    const result = (entry.kind === 'damage' ? p : (p.result ?? {})) as Record<string, unknown>;
    if (result.applied !== undefined) {
      chips.push({ label: `${result.applied} ${(p.type as string) ?? (p.damage_type as string) ?? ''}`.trim(), tone: 'bad' });
    }
    if (result.resistance) chips.push({ label: String(result.resistance), tone: 'warn' });
    if (Number(result.absorbed_by_temp_hp ?? 0) > 0) {
      chips.push({ label: `${result.absorbed_by_temp_hp} absorbed`, tone: '' });
    }
  }
  if (entry.kind === 'heal' && p.amount !== undefined) chips.push({ label: `+${p.amount} HP`, tone: 'good' });
  if (entry.kind === 'save' || entry.kind === 'concentration') {
    const rolled = p.save as { success?: boolean; total?: number } | undefined;
    if (rolled?.total !== undefined) {
      saveChip();
      chips.push(rolled.success ? { label: 'Save', tone: 'good' } : { label: 'Failed', tone: 'bad' });
    }
  }
  if (entry.kind === 'death_save' && p.result) {
    chips.push({ label: String(p.result).replace('_', ' '), tone: String(p.result).includes('success') ? 'good' : 'bad' });
  }
  if (entry.kind === 'move' && p.cost_ft !== undefined) {
    chips.push({ label: `${p.cost_ft} ft`, tone: '' });
    chips.push({ label: `${p.movement_left} ft left`, tone: '' });
    const dragged = (p.dragged ?? []) as Array<{ name?: string }>;
    if (dragged.length > 0) {
      chips.push({ label: `Drags ${dragged.map((d) => d.name ?? 'someone').join(', ')}`, tone: '' });
    }
  }
  if (entry.kind === 'initiative') {
    chips.push({ label: `Initiative ${p.initiative}`, tone: '' });
    if (p.surprised) chips.push({ label: 'Surprised', tone: 'warn' });
  }
  if (entry.kind === 'spell_slot') {
    chips.push({ label: `Level ${p.level} slot`, tone: 'accent' });
    chips.push({ label: `${p.remaining} left`, tone: '' });
  }
  if (entry.kind === 'grapple') {
    saveChip();
    chips.push(p.applied ? { label: 'Grappled', tone: 'bad' } : { label: 'Resisted', tone: 'good' });
    if (p.applied && p.escape_dc !== undefined) chips.push({ label: `Escape DC ${p.escape_dc}`, tone: '' });
  }
  if (entry.kind === 'shove') {
    saveChip();
    if (!p.applied) chips.push({ label: 'Resisted', tone: 'good' });
    else if (p.prone) chips.push({ label: 'Knocked prone', tone: 'bad' });
    else chips.push({ label: `Pushed ${p.pushed_ft ?? 0} ft`, tone: 'bad' });
  }
  return chips;
}

/** The lines under the chips: the DM's ruling, and whatever the attack's own notes said. */
export function fightLogNotes(entry: CombatLogEntry): string[] {
  const p = (entry.payload ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  if (typeof p.ruling === 'string' && p.ruling.trim()) lines.push(`DM ruling: ${p.ruling}`);
  if (entry.kind === 'attack') for (const note of (p.notes ?? []) as string[]) lines.push(note);
  return lines;
}

export interface Totals {
  dealt: number;
  taken: number;
  healed: number;
}

/** The range an undo row named as taken back, read narrowly off the payload without widening the type. */
export function revertedRange(entry: CombatLogEntry): { from: number; to: number } | null {
  if (entry.kind !== 'undo') return null;
  const payload = (entry.payload ?? {}) as { reverted_log_ids?: { from?: unknown; to?: unknown } };
  const range = payload.reverted_log_ids;
  if (typeof range?.from !== 'number' || typeof range?.to !== 'number') return null;
  return { from: range.from, to: range.to };
}

/** Every log id the fight's undo rows named, so the window can strike those rows through. */
export function revertedLogIds(log: CombatLogEntry[]): Set<number> {
  const ids = new Set<number>();
  for (const entry of log) {
    const range = revertedRange(entry);
    if (!range) continue;
    for (let id = range.from; id <= range.to; id += 1) ids.add(id);
  }
  return ids;
}

/** Damage and healing per combatant id, counted the same way the server's end-of-fight summary does. */
export function totals(log: CombatLogEntry[]): Map<number, Totals> {
  const result = new Map<number, Totals>();
  const reverted = revertedLogIds(log);
  const of = (id: number): Totals => {
    const existing = result.get(id);
    if (existing) return existing;
    const fresh = { dealt: 0, taken: 0, healed: 0 };
    result.set(id, fresh);
    return fresh;
  };
  for (const entry of log) {
    if (reverted.has(entry.id)) continue;
    const payload = (entry.payload ?? {}) as { applied?: number; amount?: number; result?: { applied?: number } };
    // An effect's damage sits under `result`, and counts for whoever put the effect there.
    const applied = entry.kind === 'damage' ? payload.applied : entry.kind === 'effect_tick' ? payload.result?.applied : 0;
    if (applied) {
      if (entry.target_id !== null) of(entry.target_id).taken += applied;
      if (entry.actor_id !== null) of(entry.actor_id).dealt += applied;
    }
    if (entry.kind === 'heal' && payload.amount && entry.target_id !== null) {
      of(entry.target_id).healed += payload.amount;
    }
  }
  return result;
}

const cellAt = (map: BattleMap, x: number, y: number): string =>
  x < 0 || y < 0 || x >= map.w || y >= map.h ? '#' : (map.rows[y]?.[x] ?? '#');

export const cellKey = (x: number, y: number): string => `${x},${y}`;

/** Cells the active combatant could still walk to: as the engine moves, difficult ground double, creatures impassable. */
export function reachable(map: BattleMap, combatants: Combatant[], active: Combatant | null): Set<string> {
  const done = new Set<string>();
  if (!active || !active.alive || active.movement_left <= 0) return done;

  const taken = new Set<string>();
  for (const c of combatants) {
    if (!c.alive || c.id === active.id) continue;
    for (let dy = 0; dy < c.footprint; dy += 1) {
      for (let dx = 0; dx < c.footprint; dx += 1) taken.add(cellKey(c.x + dx, c.y + dy));
    }
  }

  const fp = active.footprint;
  const standable = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x + fp > map.w || y + fp > map.h) return false;
    for (let dy = 0; dy < fp; dy += 1) {
      for (let dx = 0; dx < fp; dx += 1) {
        if (cellAt(map, x + dx, y + dy) === '#') return false;
        if (taken.has(cellKey(x + dx, y + dy))) return false;
      }
    }
    return true;
  };

  // Dijkstra over the whole budget: a big token pays for the cell its top-left corner enters.
  const best = new Map<string, number>([[cellKey(active.x, active.y), 0]]);
  let frontier = [{ x: active.x, y: active.y, spent: 0 }];
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const step of frontier) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const x = step.x + dx;
          const y = step.y + dy;
          if (!standable(x, y)) continue;
          // No corner cutting, as the engine's A* has it: a diagonal needs one of its two side cells open.
          if (dx !== 0 && dy !== 0 && !standable(x, step.y) && !standable(step.x, y)) continue;
          const spent = step.spent + (cellAt(map, x, y) === '~' ? CELL_FT * 2 : CELL_FT);
          if (spent > active.movement_left) continue;
          const key = cellKey(x, y);
          if ((best.get(key) ?? Infinity) <= spent) continue;
          best.set(key, spent);
          done.add(key);
          next.push({ x, y, spent });
        }
      }
    }
    frontier = next;
  }
  return done;
}

export interface EncounterEnd {
  encounter_id: number;
  outcome: string;
  rounds: number;
  xp_suggestion: number;
  defeated: DefeatedFoe[];
  /** What the server counted; null when the event carried no summary and the numbers were rebuilt. */
  combatants: CombatantSummary[] | null;
}

function endSummary(payload: CombatEventPayload): EncounterEnd | null {
  const entry = payload.log.find((e) => e.kind === 'encounter_end');
  if (!entry) return null;
  const fields = (entry.payload ?? {}) as { outcome?: string; xp_suggestion?: number; defeated?: string[] };
  const outcome = fields.outcome ?? payload.state.encounter.outcome ?? 'over';
  const summary = payload.summary;
  if (summary) {
    return {
      encounter_id: payload.encounter_id,
      outcome,
      rounds: summary.rounds,
      xp_suggestion: summary.xp_suggestion,
      defeated: summary.defeated,
      combatants: summary.combatants,
    };
  }
  return {
    encounter_id: payload.encounter_id,
    outcome,
    rounds: payload.state.round,
    xp_suggestion: fields.xp_suggestion ?? 0,
    defeated: (fields.defeated ?? []).map((name) => ({ name, cr: null, xp: 0 })),
    combatants: null,
  };
}

/** Newest first, no duplicates: the snapshot's tail, the fetched history and the event's entries overlap. */
function mergeLog(current: CombatLogEntry[], incoming: CombatLogEntry[]): CombatLogEntry[] {
  const seen = new Set(current.map((entry) => entry.id));
  const fresh = incoming.filter((entry) => !seen.has(entry.id));
  return [...fresh, ...current].sort((a, b) => b.id - a.id).slice(0, LOG_LIMIT);
}

/** A duplicate id here would crash the keyed `{#each}` in the battle panel; an older server may still send one. */
function dedupeState(state: BattleState): BattleState {
  const seen = new Set<string>();
  const legal_actions = state.legal_actions.filter((action) => (seen.has(action.id) ? false : seen.add(action.id)));
  return legal_actions.length === state.legal_actions.length ? state : { ...state, legal_actions };
}

export class CombatStore {
  state = $state<BattleState | null>(null);
  log = $state<CombatLogEntry[]>([]);
  /** The last fight's summary, kept until the DM saves a checkpoint. */
  lastEnd = $state<EncounterEnd | null>(null);
  /** The encounter whose full log was already asked for, so later snapshots do not refetch it. */
  private historyFor: number | null = null;

  get active(): Combatant | null {
    const id = this.state?.active?.id;
    return this.state?.combatants.find((c) => c.id === id) ?? null;
  }

  get totals(): Map<number, Totals> {
    return totals(this.log);
  }

  /** The ids the fight's undo rows took back: the window strikes them through but never hides them. */
  get revertedIds(): Set<number> {
    return revertedLogIds(this.log);
  }

  /** A `combat` event carries the whole state: apply it, no refetch. */
  applyEvent(payload: CombatEventPayload): void {
    if (this.state && this.state.encounter.id !== payload.encounter_id) this.log = [];
    this.state = dedupeState(payload.state);
    this.log = mergeLog(this.log, payload.log);
    const ended = endSummary(payload);
    if (ended) this.lastEnd = ended;
  }

  applySnapshot(encounter: BattleState | null | undefined): void {
    if (!encounter) {
      // The server only reports active encounters: keep the ended fight on screen for its summary.
      if (!this.lastEnd) this.clearEncounter();
      return;
    }
    if (this.state && this.state.encounter.id !== encounter.encounter.id) this.log = [];
    if (encounter.encounter.status === 'active') this.lastEnd = null;
    this.state = dedupeState(encounter);
    this.log = mergeLog(this.log, encounter.log_tail);
  }

  /** True once per active encounter: the caller then fetches the whole log and hands it to `seedHistory`. */
  takeHistoryRequest(): boolean {
    const id = this.state?.encounter.status === 'active' ? this.state.encounter.id : null;
    if (id === null || id === this.historyFor) return false;
    this.historyFor = id;
    return true;
  }

  /** The fight so far, oldest first: what happened before the window opened. */
  seedHistory(entries: CombatLogEntry[]): void {
    this.log = mergeLog(this.log, entries);
  }

  /** The fetch `takeHistoryRequest` asked for failed: clear the mark so the next snapshot or event retries it. */
  clearHistoryRequest(): void {
    this.historyFor = null;
  }

  clearEncounter(): void {
    this.state = null;
    this.log = [];
    this.lastEnd = null;
    this.historyFor = null;
  }
}
