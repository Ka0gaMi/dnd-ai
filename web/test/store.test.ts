import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  GameStore,
  isCodexEvent,
  isD20,
  isProgressionEvent,
  isStoryEvent,
  rollChips,
  visibleRolls,
} from '../src/lib/store.svelte';
import type { GameEvent, RollEntry, RollRow, Snapshot } from '../src/lib/types';

const snapshot = (): Snapshot => ({
  campaign: { id: 1, name: 'Ashfall', story_shape: 'sandbox', premise: null },
  session: { id: 1, number: 1, started_at: '2026-09-10T10:00:00.000Z' },
  last_recap: null,
  current_scene: null,
  previous_scene: null,
  pc: null,
  open_quests: [],
  canon_facts: [],
  recent_events: [{ id: 1, ts: '2026-09-10T10:00:00.000Z', kind: 'system', text: 'Campaign created.' }],
  glossary_terms: [],
  events_since_checkpoint: 0,
});

const rollEvent = (event_id: number): GameEvent => ({
  campaign_id: 1,
  event_id,
  kind: 'roll',
  text: 'Stealth check: 1d20+3: [17]+3 = 20 vs DC 15 -> success',
  ts: '2026-09-10T10:05:00.000Z',
  payload: { expr: '1d20+3', total: 20, outcome: 'success', advantage: 'none' },
});

describe('GameStore', () => {
  it('stores a snapshot and clears the error', () => {
    const store = new GameStore();
    store.error = 'stale';
    expect(store.apply({ type: 'snapshot', data: snapshot() })).toBe('none');
    expect(store.snapshot?.campaign.name).toBe('Ashfall');
    expect(store.error).toBeNull();
  });

  it('asks for a fresh snapshot after a non-roll event and shows it in the feed', () => {
    const store = new GameStore();
    store.apply({ type: 'snapshot', data: snapshot() });
    const event: GameEvent = {
      campaign_id: 1,
      event_id: 2,
      kind: 'narration',
      text: 'The gate creaks open.',
      ts: '2026-09-10T10:02:00.000Z',
    };
    expect(store.apply({ type: 'event', event })).toBe('resubscribe');
    expect(store.snapshot?.recent_events.at(-1)?.text).toBe('The gate creaks open.');
    expect(store.rolls).toHaveLength(0);
  });

  it('logs a roll from the event payload and asks for the per-die detail', () => {
    const store = new GameStore();
    store.apply({ type: 'snapshot', data: snapshot() });
    expect(store.apply({ type: 'event', event: rollEvent(3) })).toBe('refresh-rolls');
    expect(store.rolls).toHaveLength(1);
    expect(store.rolls[0]).toMatchObject({
      purpose: 'Stealth check',
      expr: '1d20+3',
      total: 20,
      dc: 15,
      outcome: 'success',
      groups: [],
    });
  });

  it('replaces an optimistic roll with the fetched row instead of duplicating it', () => {
    const store = new GameStore();
    store.apply({ type: 'event', event: rollEvent(3) });
    const key = store.rolls[0]?.key;
    const row: RollRow = {
      id: 9,
      event_id: 3,
      expr: '1d20+3',
      groups: [{ value: 17, dice: [{ value: 17, modifiers: [] }] }],
      total: 20,
      purpose: 'Stealth check',
      dc: 15,
      outcome: 'success',
      ts: '2026-09-10T10:05:00.000Z',
    };
    store.setRolls([row]);
    expect(store.rolls).toHaveLength(1);
    expect(store.rolls[0]?.key).toBe(key);
    expect(store.rolls[0]?.groups).toHaveLength(1);
  });

  it('keeps a server error visible', () => {
    const store = new GameStore();
    expect(store.apply({ type: 'error', message: 'No campaign with id 7.' })).toBe('none');
    expect(store.error).toBe('No campaign with id 7.');
  });

  it('leaves pending rolls, portraits and settings out of the story feed', () => {
    const store = new GameStore();
    store.apply({ type: 'snapshot', data: snapshot() });
    const pending: GameEvent = {
      campaign_id: 1,
      event_id: null,
      kind: 'pending_roll',
      text: 'Stealth check vs DC 12',
      ts: '2026-09-10T10:02:00.000Z',
    };
    const portrait: GameEvent = {
      campaign_id: 1,
      event_id: 4,
      kind: 'portrait',
      text: 'Rowan gets a portrait.',
      ts: '2026-09-10T10:03:00.000Z',
    };
    const settings: GameEvent = {
      campaign_id: 1,
      event_id: 5,
      kind: 'settings',
      text: 'Campaign settings updated.',
      ts: '2026-09-10T10:04:00.000Z',
    };
    expect(store.apply({ type: 'event', event: pending })).toBe('none');
    expect(store.apply({ type: 'event', event: portrait })).toBe('resubscribe');
    expect(store.apply({ type: 'event', event: settings })).toBe('resubscribe');
    expect(store.snapshot?.recent_events.map((e) => e.text)).toEqual(['Campaign created.']);
  });

  const versionOnly = (kind: string, event_id: number): GameEvent => ({
    campaign_id: 1,
    event_id,
    kind,
    text: `${kind} happened`,
    ts: '2026-09-10T10:05:00.000Z',
  });

  it('asks only the right panel to refetch on entity, relationship, voice and play-note events', () => {
    const store = new GameStore();
    store.apply({ type: 'snapshot', data: snapshot() });
    for (const kind of ['entity', 'relationship', 'voice', 'play_note']) {
      expect(store.apply({ type: 'event', event: versionOnly(kind, 10) })).toBe('none');
    }
    expect(store.codexVersion).toBe(4);
    expect(store.progressionVersion).toBe(4);
    expect(store.snapshot?.recent_events.map((e) => e.kind)).toEqual([
      'system',
      'entity',
      'relationship',
      'voice',
      'play_note',
    ]);
  });

  it('keeps a ready level-up out of the story feed, but still bumps the progression panel', () => {
    const store = new GameStore();
    store.apply({ type: 'snapshot', data: snapshot() });
    expect(store.apply({ type: 'event', event: versionOnly('level_up_ready', 11) })).toBe('none');
    expect(store.progressionVersion).toBe(1);
    expect(store.snapshot?.recent_events.map((e) => e.text)).toEqual(['Campaign created.']);
  });

  it('refetches the whole snapshot for xp, the in-world clock, a rewind or an undo', () => {
    const store = new GameStore();
    store.apply({ type: 'snapshot', data: snapshot() });
    for (const kind of ['xp', 'time', 'rewind', 'undo']) {
      expect(store.apply({ type: 'event', event: versionOnly(kind, 12) })).toBe('resubscribe');
    }
  });
});

describe('isStoryEvent', () => {
  it('excludes pseudo-events pushed over the socket', () => {
    expect(isStoryEvent('pending_roll')).toBe(false);
    expect(isStoryEvent('pending_decision')).toBe(false);
    expect(isStoryEvent('portrait')).toBe(false);
    expect(isStoryEvent('settings')).toBe(false);
  });

  it('keeps real campaign events, combat included', () => {
    expect(isStoryEvent('narration')).toBe(true);
    expect(isStoryEvent('roll')).toBe(true);
    expect(isStoryEvent('combat')).toBe(true);
  });
});

describe('the decision the DM is waiting on', () => {
  it('goes onto the dialog rather than the feed, and asks for nothing else', () => {
    const store = new GameStore();
    store.apply({ type: 'snapshot', data: snapshot() });
    const event: GameEvent = {
      campaign_id: 1,
      event_id: 9,
      kind: 'pending_decision',
      text: 'Trapwright: within the power budget.',
      ts: '2026-09-10T10:06:00.000Z',
      payload: {
        id: 4,
        campaign_id: 1,
        kind: 'homebrew_feature',
        created_at: '2026-09-10T10:06:00.000Z',
        resolved_at: null,
        payload: {
          name: 'Trapwright',
          text: 'You rig a trap in a minute flat.',
          mechanics: { to_hit: 1 },
          report: { budget_used: 0.5, budget_allowed: 1, items: [], verdict: 'within', text: '' },
          character_id: 4,
        },
      },
    };
    expect(store.apply({ type: 'event', event })).toBe('none');
    expect(store.decisions.current?.id).toBe(4);
    expect(store.snapshot?.recent_events.map((e) => e.text)).toEqual(['Campaign created.']);
  });
});

describe('isProgressionEvent', () => {
  it('refetches on the kinds that level, grant or note something', () => {
    expect(isProgressionEvent('xp')).toBe(true);
    expect(isProgressionEvent('level_up')).toBe(true);
    expect(isProgressionEvent('homebrew_decision')).toBe(true);
    // Preparing a level-up window logs no event of its own, so anything else refetches too.
    expect(isProgressionEvent('system')).toBe(true);
  });

  it('ignores the kinds that only move dice or pixels', () => {
    expect(isProgressionEvent('roll')).toBe(false);
    expect(isProgressionEvent('combat')).toBe(false);
    expect(isProgressionEvent('portrait')).toBe(false);
    expect(isProgressionEvent('time')).toBe(false);
  });
});

describe('isCodexEvent', () => {
  it('ignores the kinds that can never touch a codex entry', () => {
    expect(isCodexEvent('roll')).toBe(false);
    expect(isCodexEvent('pending_roll')).toBe(false);
    expect(isCodexEvent('combat')).toBe(false);
    expect(isCodexEvent('settings')).toBe(false);
  });

  it('refetches on the kinds that can: the codex writes log as system events', () => {
    expect(isCodexEvent('system')).toBe(true);
    expect(isCodexEvent('story')).toBe(true);
    expect(isCodexEvent('portrait')).toBe(true);
  });
});

describe('reconnect', () => {
  it('backs off exponentially up to ten seconds', () => {
    expect(backoffMs(0)).toBe(500);
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(4)).toBe(8000);
    expect(backoffMs(10)).toBe(10_000);
  });

  it('detects d20 expressions for nat 20 / nat 1 highlighting', () => {
    expect(isD20('1d20+3')).toBe(true);
    expect(isD20('d20')).toBe(true);
    expect(isD20('2d6+1')).toBe(false);
  });
});

const entry = (over: Partial<RollEntry> = {}): RollEntry => ({
  key: 'e1',
  purpose: 'Attack',
  expr: '1d20+5',
  groups: [],
  total: 18,
  dc: 15,
  outcome: null,
  natural: null,
  overridden: false,
  ts: '2026-09-10T10:05:00.000Z',
  ...over,
});

describe('visibleRolls', () => {
  const rolls = Array.from({ length: 8 }, (_, i) => entry({ key: `e${i}` }));

  it('shows the newest five while collapsed', () => {
    expect(visibleRolls(rolls, false).map((roll) => roll.key)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
  });

  it('shows everything once expanded', () => {
    expect(visibleRolls(rolls, true)).toHaveLength(8);
  });

  it('leaves a short list alone', () => {
    expect(visibleRolls(rolls.slice(0, 3), false)).toHaveLength(3);
  });
});

describe('rollChips', () => {
  it('reads the natural the server sends', () => {
    expect(rollChips(entry({ natural: 20, outcome: 'critical_hit' }))).toEqual({
      natural: 20,
      outcome: { label: 'Critical hit', tone: 'accent' },
    });
    expect(rollChips(entry({ natural: 1, outcome: 'miss' }))).toEqual({
      natural: 1,
      outcome: { label: 'Miss', tone: 'bad' },
    });
  });

  it('labels plain outcomes', () => {
    expect(rollChips(entry({ outcome: 'success' })).outcome).toEqual({ label: 'Success', tone: 'good' });
    expect(rollChips(entry({ outcome: 'failure' })).outcome).toEqual({ label: 'Failure', tone: 'bad' });
    expect(rollChips(entry()).outcome).toBeNull();
  });

  it('splits the legacy critical outcomes into a natural plus a plain outcome', () => {
    expect(rollChips(entry({ outcome: 'critical_success' }))).toEqual({
      natural: 20,
      outcome: { label: 'Success', tone: 'good' },
    });
    expect(rollChips(entry({ outcome: 'critical_failure' }))).toEqual({
      natural: 1,
      outcome: { label: 'Failure', tone: 'bad' },
    });
  });

  it('falls back to the first group’s d20 when the row carries no natural', () => {
    const groups = [{ value: 20, dice: [{ value: 20, modifiers: [] }] }];
    expect(rollChips(entry({ groups })).natural).toBe(20);
    expect(rollChips(entry({ expr: '3d6', groups })).natural).toBeNull();
  });

  it('ignores a dropped die from advantage', () => {
    const groups = [
      { value: 20, dice: [{ value: 1, modifiers: ['drop'] }, { value: 20, modifiers: [] }] },
    ];
    expect(rollChips(entry({ groups })).natural).toBe(20);
  });
});
