import { describe, expect, it } from 'vitest';
import { CombatStore, reachable, totals, visibleHp, visibleKnown } from '../src/lib/combat.svelte';
import { GameStore } from '../src/lib/store.svelte';
import type {
  BattleMap,
  BattleState,
  Combatant,
  CombatEventPayload,
  CombatLogEntry,
  GameEvent,
  KnownStats,
  Snapshot,
} from '../src/lib/types';

const combatant = (over: Partial<Combatant> = {}): Combatant => ({
  id: 1,
  kind: 'monster',
  character_id: null,
  name: 'Goblin',
  team: 'enemy',
  initiative: 12,
  initiative_order: 1,
  x: 1,
  y: 1,
  size: 'S',
  hp_current: 4,
  hp_max: 7,
  temp_hp: 0,
  ac: 15,
  speed: 30,
  conditions: [],
  flags: {},
  concentration: null,
  death_saves: { successes: 0, failures: 0 },
  movement_left: 30,
  action_used: false,
  bonus_used: false,
  reaction_used: false,
  visible: true,
  alive: true,
  footprint: 1,
  armor_penalty: false,
  hp_fraction: 4 / 7,
  distance_ft: 10,
  marker: 'g',
  known: null,
  inspiration: null,
  exhaustion: null,
  portrait_path: null,
  ...over,
});

const known = (over: Partial<KnownStats> = {}): KnownStats => ({
  cr: 0.25,
  type: 'humanoid',
  size: 'Small',
  speed: { walk: 30 },
  senses: ['darkvision 60 ft.'],
  damage_resistances: '',
  damage_immunities: 'poison',
  damage_vulnerabilities: '',
  condition_immunities: 'poisoned',
  ...over,
});

const entry = (over: Partial<CombatLogEntry> = {}): CombatLogEntry => ({
  id: 1,
  round: 1,
  actor_id: null,
  target_id: null,
  kind: 'move',
  payload: null,
  text: '',
  ts: '2026-09-11T10:00:00.000Z',
  ...over,
});

const map = (rows: string[]): BattleMap => ({
  w: rows[0]?.length ?? 0,
  h: rows.length,
  rows,
  features: [],
});

const state = (over: Partial<BattleState> = {}): BattleState => ({
  encounter: { id: 5, status: 'active', round: 1, turn_index: 0, seed: 7, visibility: 'bars', outcome: null },
  map: map(['....', '....', '....']),
  round: 1,
  turn_index: 0,
  combatants: [combatant()],
  active: { id: 1, name: 'Goblin', team: 'enemy', kind: 'monster' },
  legal_actions: [],
  effects: [],
  log_tail: [],
  ...over,
});

const snapshot = (encounter: BattleState | null): Snapshot => ({
  campaign: { id: 1, name: 'Ashfall', story_shape: 'sandbox', premise: null },
  session: { id: 1, number: 1, started_at: '2026-09-11T10:00:00.000Z' },
  last_recap: null,
  current_scene: null,
  previous_scene: null,
  pc: null,
  open_quests: [],
  canon_facts: [],
  recent_events: [],
  glossary_terms: [],
  events_since_checkpoint: 0,
  encounter,
});

describe('visibleHp', () => {
  it('shows the party in full whatever the DM set', () => {
    const pc = combatant({ team: 'party', kind: 'pc', hp_fraction: 0.3 });
    expect(visibleHp(pc, 'hidden')).toEqual({ numbers: true, bar: true, ac: true, bloodied: false, fraction: 0.3 });
  });

  it('gives enemies a bar without numbers by default', () => {
    expect(visibleHp(combatant({ hp_fraction: 0.8 }), 'bars')).toEqual({
      numbers: false,
      bar: true,
      ac: false,
      bloodied: false,
      fraction: 0.8,
    });
  });

  it('shows enemy numbers and AC only on full', () => {
    const view = visibleHp(combatant(), 'full');
    expect(view.numbers).toBe(true);
    expect(view.ac).toBe(true);
  });

  it('reduces a hidden enemy to a bloodied marker below half health', () => {
    expect(visibleHp(combatant({ hp_fraction: 0.4 }), 'hidden')).toMatchObject({ bar: false, bloodied: true });
    expect(visibleHp(combatant({ hp_fraction: 0.6 }), 'hidden')).toMatchObject({ bar: false, bloodied: false });
  });

  it('reads a dead combatant as empty, never bloodied', () => {
    expect(visibleHp(combatant({ alive: false, hp_fraction: 0.4 }), 'hidden')).toMatchObject({
      fraction: 0,
      bloodied: false,
    });
  });
});

describe('visibleKnown', () => {
  it('keeps an enemy stat block hidden until the DM reveals everything', () => {
    const goblin = combatant({ known: known() });
    expect(visibleKnown(goblin, 'bars')).toBeNull();
    expect(visibleKnown(goblin, 'hidden')).toBeNull();
    expect(visibleKnown(goblin, 'full')).toEqual(known());
  });

  it('shows the party its own stats whatever the DM set', () => {
    const wolf = combatant({ team: 'party', kind: 'companion', known: known({ cr: 0.5 }) });
    expect(visibleKnown(wolf, 'hidden')?.cr).toBe(0.5);
  });

  it('has nothing to show for a combatant without a stat block', () => {
    expect(visibleKnown(combatant({ team: 'party' }), 'full')).toBeNull();
  });
});

describe('totals', () => {
  it('adds damage to both sides of the exchange and counts healing', () => {
    const log = [
      entry({ id: 3, kind: 'heal', actor_id: 2, target_id: 1, payload: { amount: 4 } }),
      entry({ id: 2, kind: 'damage', actor_id: 2, target_id: 1, payload: { applied: 5 } }),
      entry({ id: 1, kind: 'damage', actor_id: 1, target_id: 2, payload: { applied: 3 } }),
    ];
    const result = totals(log);
    expect(result.get(1)).toEqual({ dealt: 3, taken: 5, healed: 4 });
    expect(result.get(2)).toEqual({ dealt: 5, taken: 3, healed: 0 });
  });

  it('counts an effect tick against the target and for whoever cast it', () => {
    const log = [
      entry({
        id: 5,
        kind: 'effect_tick',
        actor_id: 2,
        target_id: 1,
        payload: { effect_id: 3, name: 'Ignite', roll: { total: 6 }, result: { applied: 6 } },
      }),
      // No source: the damage still lands on the target.
      entry({ id: 4, kind: 'effect_tick', actor_id: null, target_id: 2, payload: { result: { applied: 2 } } }),
    ];
    const result = totals(log);
    expect(result.get(1)).toEqual({ dealt: 0, taken: 6, healed: 0 });
    expect(result.get(2)).toEqual({ dealt: 6, taken: 2, healed: 0 });
  });

  it('ignores entries that carry no numbers', () => {
    expect(totals([entry({ kind: 'move', actor_id: 1 })]).size).toBe(0);
  });

  it('adds up every hit in a long fight, not just the recent tail', () => {
    const log = Array.from({ length: 250 }, (_, i) =>
      entry({ id: i + 1, kind: 'damage', actor_id: 2, target_id: 1, payload: { applied: 1 } }),
    );
    expect(totals(log).get(1)).toEqual({ dealt: 0, taken: 250, healed: 0 });
  });
});

describe('reachable', () => {
  const walker = combatant({ id: 9, team: 'party', kind: 'pc', x: 0, y: 0, movement_left: 10 });

  it('spreads in eight directions within the budget', () => {
    const cells = reachable(map(['...', '...', '...']), [walker], walker);
    expect(cells.has('1,1')).toBe(true);
    expect(cells.has('2,2')).toBe(true);
    expect(cells.has('0,0')).toBe(false);
  });

  it('charges double for difficult ground', () => {
    const short = combatant({ ...walker, movement_left: 5 });
    const cells = reachable(map(['.~.', '...', '...']), [short], short);
    expect(cells.has('1,0')).toBe(false);
    expect(cells.has('1,1')).toBe(true);
  });

  it('treats blocked cells and other creatures as walls', () => {
    const blocker = combatant({ id: 4, x: 1, y: 1 });
    const cells = reachable(map(['.#.', '...', '...']), [walker, blocker], walker);
    expect(cells.has('1,0')).toBe(false);
    expect(cells.has('1,1')).toBe(false);
  });

  it('refuses to cut a corner between two blocked cells, as the engine does', () => {
    // The gap from (0,0) to (1,1) is pinched by walls on both side cells.
    const cells = reachable(map(['.#.', '#..', '...']), [walker], walker);
    expect(cells.has('1,1')).toBe(false);
    expect(cells.has('0,1')).toBe(false);
    expect(cells.has('1,0')).toBe(false);
  });

  it('allows a diagonal past a single blocked cell', () => {
    const cells = reachable(map(['.#.', '...', '...']), [walker], walker);
    expect(cells.has('1,1')).toBe(true);
  });

  it('gives nothing to a combatant with no movement left', () => {
    expect(reachable(map(['...']), [walker], combatant({ ...walker, movement_left: 0 })).size).toBe(0);
    expect(reachable(map(['...']), [walker], null).size).toBe(0);
  });

  it('keeps a large token inside the map and off blocked cells', () => {
    const ogre = combatant({ id: 7, team: 'party', x: 0, y: 0, size: 'L', footprint: 2, movement_left: 10 });
    const cells = reachable(map(['..#.', '....', '....', '....']), [ogre], ogre);
    expect(cells.has('1,1')).toBe(true);
    expect(cells.has('2,0')).toBe(false);
    expect(cells.has('3,0')).toBe(false);
  });
});

const combatEvent = (payload: CombatEventPayload): GameEvent => ({
  campaign_id: 1,
  event_id: 11,
  kind: 'combat',
  text: 'Rowan attacks the goblin.',
  ts: '2026-09-11T10:01:00.000Z',
  payload,
});

describe('combat events', () => {
  it('applies the state from the event without asking for a new snapshot', () => {
    const store = new GameStore();
    store.apply({ type: 'snapshot', data: snapshot(null) });
    const hurt = state({ round: 2, combatants: [combatant({ hp_current: 1, hp_fraction: 1 / 7 })] });
    const action = store.apply({
      type: 'event',
      event: combatEvent({
        tool: 'attack',
        encounter_id: 5,
        log: [entry({ id: 20, kind: 'damage', actor_id: 2, target_id: 1, payload: { applied: 3 } })],
        state: hurt,
      }),
    });
    expect(action).toBe('none');
    expect(store.combat.state?.round).toBe(2);
    expect(store.combat.log.map((e) => e.id)).toEqual([20]);
    expect(store.combat.totals.get(1)?.taken).toBe(3);
  });

  it('keeps the log newest first and never repeats an entry the snapshot already carried', () => {
    const combat = new CombatStore();
    combat.applySnapshot(state({ log_tail: [entry({ id: 1 }), entry({ id: 2 })] }));
    combat.applyEvent({ tool: 'move_token', encounter_id: 5, log: [entry({ id: 2 }), entry({ id: 3 })], state: state() });
    expect(combat.log.map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it('collapses a duplicate legal action id from an older server instead of crashing the keyed list', () => {
    const combat = new CombatStore();
    const dupe = [
      { id: 'cast:Detect Magic', label: 'Cast Detect Magic', hint: 'a' },
      { id: 'cast:Detect Magic', label: 'Cast Detect Magic', hint: 'b' },
    ];
    combat.applySnapshot(state({ legal_actions: dupe }));
    expect(combat.state?.legal_actions).toEqual([dupe[0]]);
    combat.applyEvent({ tool: 'move_token', encounter_id: 5, log: [], state: state({ legal_actions: dupe }) });
    expect(combat.state?.legal_actions).toEqual([dupe[0]]);
  });

  it('remembers the end-of-fight summary until the DM saves a checkpoint', () => {
    const store = new GameStore();
    const ended = state({ encounter: { ...state().encounter, status: 'ended', outcome: 'victory' }, round: 3 });
    store.apply({
      type: 'event',
      event: combatEvent({
        tool: 'end_encounter',
        encounter_id: 5,
        log: [
          entry({
            id: 30,
            kind: 'encounter_end',
            payload: { outcome: 'victory', xp_suggestion: 100, defeated: ['Goblin'] },
          }),
        ],
        state: ended,
      }),
    });
    expect(store.combat.lastEnd).toEqual({
      encounter_id: 5,
      outcome: 'victory',
      rounds: 3,
      xp_suggestion: 100,
      defeated: [{ name: 'Goblin', cr: null, xp: 0 }],
      combatants: null,
    });

    // The server only reports active encounters, so the next snapshot has none: the card stays.
    store.apply({ type: 'snapshot', data: snapshot(null) });
    expect(store.combat.lastEnd?.outcome).toBe('victory');

    store.apply({
      type: 'event',
      event: { campaign_id: 1, event_id: 12, kind: 'checkpoint', text: 'Checkpoint saved.', ts: '2026-09-11T10:02:00.000Z' },
    });
    expect(store.combat.lastEnd).toBeNull();
    expect(store.combat.state).toBeNull();
  });

  it('reads the end-of-fight numbers off the summary the event carries', () => {
    const combat = new CombatStore();
    const ended = state({ encounter: { ...state().encounter, status: 'ended', outcome: 'victory' }, round: 4 });
    combat.applyEvent({
      tool: 'end_encounter',
      encounter_id: 5,
      log: [entry({ id: 30, kind: 'encounter_end', payload: { outcome: 'victory', xp_suggestion: 0, defeated: [] } })],
      state: ended,
      summary: {
        rounds: 3,
        defeated: [{ name: 'Goblin', cr: 0.25, xp: 50 }],
        xp_suggestion: 50,
        combatants: [
          { id: 1, name: 'Goblin', team: 'enemy', damage_dealt: 4, damage_taken: 9, healed: 0, alive: false },
        ],
      },
    });
    expect(combat.lastEnd).toEqual({
      encounter_id: 5,
      outcome: 'victory',
      rounds: 3,
      xp_suggestion: 50,
      defeated: [{ name: 'Goblin', cr: 0.25, xp: 50 }],
      combatants: [{ id: 1, name: 'Goblin', team: 'enemy', damage_dealt: 4, damage_taken: 9, healed: 0, alive: false }],
    });
  });

  it('asks for the fight log once per encounter and keeps it in order', () => {
    const store = new GameStore();
    const running = state({ log_tail: [entry({ id: 8 }), entry({ id: 9 })] });
    expect(store.apply({ type: 'snapshot', data: snapshot(running) })).toBe('load-combat-log');
    expect(store.apply({ type: 'snapshot', data: snapshot(running) })).toBe('none');
    // The endpoint answers oldest first, overlapping the tail the snapshot already carried.
    store.combat.seedHistory([entry({ id: 7 }), entry({ id: 8 }), entry({ id: 9 })]);
    expect(store.combat.log.map((e) => e.id)).toEqual([9, 8, 7]);
  });

  it('keeps a long fight whole so totals do not undercount it', () => {
    const combat = new CombatStore();
    const entries = Array.from({ length: 250 }, (_, i) =>
      entry({ id: i + 1, kind: 'damage', actor_id: 2, target_id: 1, payload: { applied: 1 } }),
    );
    combat.applySnapshot(state({ log_tail: entries }));
    expect(combat.log.length).toBe(250);
    expect(combat.totals.get(1)?.taken).toBe(250);
  });

  it('clears the history mark on a failed fetch so the next snapshot retries it', () => {
    const combat = new CombatStore();
    combat.applySnapshot(state());
    expect(combat.takeHistoryRequest()).toBe(true);
    expect(combat.takeHistoryRequest()).toBe(false);
    combat.clearHistoryRequest();
    expect(combat.takeHistoryRequest()).toBe(true);
  });

  it('drops the previous fight when a new encounter starts', () => {
    const combat = new CombatStore();
    combat.applyEvent({ tool: 'attack', encounter_id: 5, log: [entry({ id: 1 })], state: state() });
    const next = state({ encounter: { ...state().encounter, id: 6 } });
    combat.applyEvent({ tool: 'start_encounter', encounter_id: 6, log: [entry({ id: 40 })], state: next });
    expect(combat.log.map((e) => e.id)).toEqual([40]);
    expect(combat.state?.encounter.id).toBe(6);
  });
});
