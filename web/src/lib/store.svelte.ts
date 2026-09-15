import { CombatStore } from './combat.svelte';
import { DecisionStore, type PendingDecision } from './decisions.svelte';
import { forgetCreaturePortraits } from './portraits.svelte';
import { RollPromptStore } from './rollprompt.svelte';
import { DEFAULT_SETTINGS, mergeSettings, type CampaignSettings } from './settings';
import type {
  CombatEventPayload,
  Die,
  GameEvent,
  PendingRoll,
  RollEntry,
  RollGroup,
  RollRow,
  Snapshot,
} from './types';

export type ConnectionStatus = 'connecting' | 'live' | 'offline';

export type ServerMessage =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'event'; event: GameEvent }
  | { type: 'error'; message: string };

/**
 * What the caller must do after a message: rolls arrive incomplete, other events change the whole
 * snapshot, and a fight found running needs its log before the window opened.
 */
export type StoreAction = 'none' | 'resubscribe' | 'refresh-rolls' | 'load-combat-log';

const ROLL_LIMIT = 50;
/** How many rolls the ledger shows before the player expands it. */
export const RECENT_ROLLS = 5;
const EVENT_FEED_LIMIT = 8;
const D20_EXPR = /^\s*\d*d20/i;
/** Not story beats: showing them in the feed reads as noise and can linger until the next resubscribe. */
const NON_STORY_KINDS = new Set(['pending_roll', 'pending_decision', 'level_up_ready', 'portrait', 'settings']);

/**
 * Codex writes are logged as `entity`, `relationship` or `voice` and portraits as `portrait`; every
 * other kind is let through too, in case it touched an entry.
 */
const QUIET_FOR_CODEX = new Set(['roll', 'pending_roll', 'combat', 'settings']);

/**
 * Progression is written by `xp`, `level_up`, `feature`, `homebrew_feature` and `homebrew_decision`,
 * but preparing a level-up window or noting how the player played logs no event at all: anything
 * that is not one of these therefore refetches too, as the codex panel does.
 */
const QUIET_FOR_PROGRESSION = new Set(['roll', 'pending_roll', 'combat', 'settings', 'portrait', 'time']);

/**
 * Their own version bump above already asked the right panel to refetch on its own - the codex list
 * or entity page for `entity`/`relationship`/`voice`, the play-profile card for `play_note`, the
 * level-up panel for `level_up_ready` - so nothing else in the snapshot needs a whole new copy.
 */
const VERSION_ONLY_KINDS = new Set(['entity', 'relationship', 'voice', 'play_note', 'level_up_ready']);

/** Kinds known to change the snapshot itself - the sheet's xp, the in-world clock, a rewind or undo. */
const SNAPSHOT_KINDS = new Set(['xp', 'time', 'rewind', 'undo']);

export function isStoryEvent(kind: string): boolean {
  return !NON_STORY_KINDS.has(kind);
}

/** Whether an event could have changed an entity, a tie or a portrait: the panel refetches if so. */
export function isCodexEvent(kind: string): boolean {
  return !QUIET_FOR_CODEX.has(kind);
}

/** Whether the level-up window, the library or the play profile could have changed. */
export function isProgressionEvent(kind: string): boolean {
  return !QUIET_FOR_PROGRESSION.has(kind);
}

export class GameStore {
  snapshot = $state<Snapshot | null>(null);
  rolls = $state<RollEntry[]>([]);
  status = $state<ConnectionStatus>('offline');
  error = $state<string | null>(null);
  settings = $state<CampaignSettings>(DEFAULT_SETTINGS);
  combat = new CombatStore();
  prompts = new RollPromptStore();
  decisions = new DecisionStore();
  /** Bumped by anything that could have changed the codex, so the panel knows to refetch. */
  codexVersion = $state(0);
  /** The same, for the level-up window, the library and the play profile. */
  progressionVersion = $state(0);
  /** Set by the live connection: asks the server for a fresh snapshot (after a rewind, say). */
  resubscribe: (() => void) | null = null;

  apply(message: ServerMessage): StoreAction {
    switch (message.type) {
      case 'snapshot':
        this.snapshot = message.data;
        this.combat.applySnapshot(message.data.encounter);
        this.error = null;
        return this.combat.takeHistoryRequest() ? 'load-combat-log' : 'none';
      case 'error':
        this.error = message.message;
        return 'none';
      case 'event':
        return this.applyEvent(message.event);
      default:
        return 'none';
    }
  }

  setSettings(settings: CampaignSettings): void {
    this.settings = mergeSettings(this.settings, settings);
  }

  setRolls(rows: RollRow[]): void {
    this.rolls = rows.map(rollFromRow).slice(0, ROLL_LIMIT);
  }

  private applyEvent(event: GameEvent): StoreAction {
    if (isCodexEvent(event.kind)) this.codexVersion += 1;
    if (isProgressionEvent(event.kind)) this.progressionVersion += 1;
    if (this.snapshot && isStoryEvent(event.kind)) {
      this.snapshot.recent_events = [
        ...this.snapshot.recent_events,
        { id: event.event_id ?? 0, ts: event.ts, kind: event.kind, text: event.text },
      ].slice(-EVENT_FEED_LIMIT);
    }
    // A combat event carries the whole battle state, so the screen updates without a refetch.
    if (event.kind === 'combat') {
      this.combat.applyEvent(event.payload as CombatEventPayload);
      return 'none';
    }
    // The roll the DM is waiting on arrives whole: it goes straight onto the prompt card.
    if (event.kind === 'pending_roll') {
      this.prompts.add(event.payload as PendingRoll);
      return 'none';
    }
    // The question the DM is waiting on arrives whole too, and becomes the dialog.
    if (event.kind === 'pending_decision') {
      this.decisions.add(event.payload as PendingDecision);
      return 'none';
    }
    if (event.kind === 'settings') {
      // The patch is enough for the panel; the snapshot brings the fight's new visibility with it.
      this.settings = mergeSettings(this.settings, event.payload);
      return 'resubscribe';
    }
    if (event.kind === 'portrait') forgetCreaturePortraits();
    if (event.kind === 'checkpoint') this.combat.clearEncounter();
    if (event.kind === 'roll') {
      // Shown at once from the event, then refetched because the payload carries no per-die detail.
      this.rolls = [rollFromEvent(event), ...this.rolls].slice(0, ROLL_LIMIT);
      return 'refresh-rolls';
    }
    if (VERSION_ONLY_KINDS.has(event.kind)) return 'none';
    if (SNAPSHOT_KINDS.has(event.kind)) return 'resubscribe';
    // A conservative default for portrait, checkpoint and anything this window does not know about
    // yet: the whole snapshot is cheap to refetch, so it is the safe fallback.
    return 'resubscribe';
  }
}

/** Reconnect delay: 0.5s doubling to 10s. */
export function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 10_000);
}

export function isD20(expr: string): boolean {
  return D20_EXPR.test(expr);
}

export function visibleRolls(rolls: RollEntry[], expanded: boolean): RollEntry[] {
  return expanded ? rolls : rolls.slice(0, RECENT_ROLLS);
}

export interface Chip {
  label: string;
  tone: string;
}

export interface RollChips {
  natural: number | null;
  outcome: Chip | null;
}

const OUTCOMES: Record<string, Chip | undefined> = {
  success: { label: 'Success', tone: 'good' },
  failure: { label: 'Failure', tone: 'bad' },
  critical_hit: { label: 'Critical hit', tone: 'accent' },
  miss: { label: 'Miss', tone: 'bad' },
  critical_success: { label: 'Success', tone: 'good' },
  critical_failure: { label: 'Failure', tone: 'bad' },
};

/** Legacy rows carry the natural inside the outcome; new ones carry it beside it. */
const LEGACY_NATURAL: Record<string, number | undefined> = { critical_success: 20, critical_failure: 1 };

/** The chips beside a roll: "Natural 20"/"Natural 1" and the outcome, however the row spells it. */
export function rollChips(roll: RollEntry): RollChips {
  const outcome = roll.outcome ?? '';
  return {
    natural: roll.natural ?? LEGACY_NATURAL[outcome] ?? naturalFromDice(roll),
    outcome: OUTCOMES[outcome] ?? null,
  };
}

/** No `natural` from the server: read the kept d20 of the first group, as the die highlight does. */
function naturalFromDice(roll: RollEntry): number | null {
  if (!isD20(roll.expr)) return null;
  const kept = groupDice(roll.groups[0]).filter((die) => !die.modifiers.some((m) => m.startsWith('drop')));
  if (kept.some((die) => die.value === 20)) return 20;
  return kept.some((die) => die.value === 1) ? 1 : null;
}

export function groupDice(group: RollGroup | undefined): Die[] {
  return typeof group === 'object' && group !== null && 'dice' in group ? group.dice : [];
}

function rollFromRow(row: RollRow): RollEntry {
  return {
    key: rollKey(row.event_id, row.id),
    purpose: row.purpose ?? 'Roll',
    expr: row.expr,
    groups: row.groups ?? [],
    total: row.total,
    dc: row.dc,
    outcome: row.outcome,
    natural: row.natural ?? null,
    overridden: row.overridden === 1,
    ...(row.rules_applied?.length ? { rules_applied: row.rules_applied } : {}),
    ts: row.ts,
  };
}

function rollFromEvent(event: GameEvent): RollEntry {
  const payload = (event.payload ?? {}) as {
    expr?: string;
    total?: number;
    outcome?: string | null;
    natural?: number | null;
    rules_applied?: string[];
  };
  const dc = /vs DC (\d+)/.exec(event.text);
  return {
    key: rollKey(event.event_id, null),
    purpose: purposeFromText(event.text, payload.expr),
    expr: payload.expr ?? '',
    groups: [],
    total: payload.total ?? 0,
    dc: dc ? Number(dc[1]) : null,
    outcome: payload.outcome ?? null,
    natural: payload.natural ?? null,
    overridden: false,
    ...(payload.rules_applied?.length ? { rules_applied: payload.rules_applied } : {}),
    ts: event.ts,
  };
}

/** Same key for the optimistic entry and the refetched row, so the list does not re-animate. */
function rollKey(eventId: number | null, rollId: number | null): string {
  return eventId !== null ? `e${eventId}` : `r${rollId ?? Math.random()}`;
}

/** Event text is "<purpose>: <dice output> [vs DC n] [-> outcome]". */
function purposeFromText(text: string, expr?: string): string {
  const marker = expr ? text.indexOf(`${expr}:`) : -1;
  const head = marker > 0 ? text.slice(0, marker) : text;
  return head.replace(/[:\s]+$/, '') || text;
}
