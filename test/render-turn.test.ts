// Render turn: turnView touches only the combatants the call's log named, and renderTurn words the
// answer as plain text with no ASCII grid.
import { describe, expect, it } from 'vitest';
import type { LegalAction } from '../src/combat/actions.js';
import type { BattleMap } from '../src/combat/map.js';
import {
  renderTurn,
  turnView,
  type BattleState,
  type CombatLogEntry,
  type CombatantView,
  type EncounterRow,
} from '../src/combat/state.js';

let nextId = 1;

const combatant = (over: Partial<CombatantView> & Pick<CombatantView, 'id' | 'name' | 'team' | 'marker'>): CombatantView => ({
  encounter_id: 1,
  kind: 'pc',
  character_id: null,
  initiative: 10,
  initiative_order: nextId,
  x: 0,
  y: 0,
  size: 'M',
  hp_current: 20,
  hp_max: 20,
  temp_hp: 0,
  ac: 16,
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
  portrait_path: null,
  footprint: 1,
  armor_penalty: false,
  hp_fraction: 1,
  distance_ft: null,
  known: null,
  inspiration: null,
  exhaustion: null,
  class_features: [],
  ...over,
});

const map: BattleMap = { w: 10, h: 5, rows: Array.from({ length: 5 }, () => '.'.repeat(10)), features: [] };

const encounter: Omit<EncounterRow, 'map_json'> = {
  id: 1,
  campaign_id: 1,
  scene_id: null,
  status: 'active',
  round: 2,
  turn_index: 0,
  seed: 7,
  visibility: 'full',
  started_at: '2026-01-01T00:00:00.000Z',
  ended_at: null,
  outcome: null,
};

const entry = (over: Partial<CombatLogEntry> & Pick<CombatLogEntry, 'text'>): CombatLogEntry => ({
  id: nextId++,
  round: 2,
  actor_id: null,
  target_id: null,
  kind: 'attack',
  payload: null,
  ts: '2026-01-01T00:00:00.000Z',
  ...over,
});

const action = (id: string, label = id): LegalAction => ({ id, label, hint: '' });

const state = (over: {
  active?: BattleState['active'];
  legal_actions?: LegalAction[];
  combatants?: CombatantView[];
}): BattleState => ({
  encounter,
  map,
  round: 2,
  turn_index: 0,
  combatants: over.combatants ?? [],
  active: over.active === undefined ? { id: 1, name: 'Borg', team: 'party', kind: 'pc' } : over.active,
  legal_actions: over.legal_actions ?? [action('attack', 'Attack'), action('dash', 'Dash')],
  effects: [],
  log_tail: [],
});

const fixture = (): BattleState =>
  state({
    combatants: [
      combatant({ id: 1, name: 'Borg', team: 'party', marker: 'B', initiative_order: 1 }),
      combatant({
        id: 2,
        name: 'goblin',
        team: 'enemy',
        marker: 'g',
        kind: 'monster',
        initiative_order: 2,
        hp_current: 5,
      }),
      combatant({
        id: 3,
        name: 'ogre',
        team: 'enemy',
        marker: 'o',
        kind: 'monster',
        initiative_order: 3,
      }),
    ],
  });

const swingLog = (): CombatLogEntry[] => [
  entry({ id: 11, actor_id: 1, target_id: 2, text: 'Borg swings at goblin.' }),
  entry({ id: 12, actor_id: 1, target_id: 2, text: 'The goblin takes 6 damage.' }),
];

describe('turnView', () => {
  it('touches the actor and target once each, and leaves the bystander out', () => {
    const view = turnView(fixture(), swingLog());
    expect(view.touched.map((c) => c.id)).toEqual([1, 2]);
  });

  it('puts the active combatant first, then the others by initiative order', () => {
    const log = [entry({ actor_id: 2, target_id: 1, text: 'x' }), entry({ target_id: 3, text: 'y' })];
    const ogreActs = { ...fixture(), active: { id: 3, name: 'Ogre', team: 'enemy', kind: 'monster' } as BattleState['active'] };
    const view = turnView(ogreActs, log);
    expect(view.touched.map((c) => c.id)).toEqual([3, 1, 2]);
  });

  it('derives active_has_acted from the action-economy fields', () => {
    const base = fixture();
    expect(turnView(base, swingLog()).active_has_acted).toBe(false);

    const acted = fixture();
    acted.combatants = acted.combatants.map((c) => (c.id === 1 ? { ...c, action_used: true } : c));
    expect(turnView(acted, swingLog()).active_has_acted).toBe(true);

    const moved = fixture();
    moved.combatants = moved.combatants.map((c) =>
      c.id === 1 ? { ...c, flags: { moved_this_turn: true } } : c,
    );
    expect(turnView(moved, swingLog()).active_has_acted).toBe(true);
  });
});

describe('renderTurn', () => {
  it('renders the log lines, the round line, the actions and the touched combatants', () => {
    const text = renderTurn(fixture(), swingLog());
    const lines = text.split('\n');
    expect(lines[0]).toBe('Borg swings at goblin.');
    expect(lines[1]).toBe('The goblin takes 6 damage.');
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe('Round 2 - Borg is up, has not acted yet.');
    expect(lines[4]).toBe('Actions: attack (Attack), dash (Dash)');
    expect(lines[5]).toBe('B Borg: 20/20 HP, at 0,0');
    expect(lines[6]).toBe('g goblin: 5/20 HP, at 0,0');
    expect(lines[lines.length - 1]).toBe('Call get_battle_state for the map and every combatant.');
  });

  it('renders the no-active line and Actions: none', () => {
    const text = renderTurn(state({ active: null, legal_actions: [] }), [entry({ text: 'Nobody is left standing.' })]);
    const lines = text.split('\n');
    expect(lines).toContain('Round 2 - no active combatant.');
    expect(lines).toContain('Actions: none');
  });

  it('renders the acted round line once something was spent', () => {
    const acted = fixture();
    acted.combatants = acted.combatants.map((c) => (c.id === 1 ? { ...c, bonus_used: true } : c));
    expect(renderTurn(acted, swingLog())).toContain('Round 2 - Borg is up, has acted.');
  });

  it('renders temp HP, conditions and concentration in the legend wording', () => {
    const s = fixture();
    s.combatants = s.combatants.map((c) =>
      c.id === 2
        ? {
            ...c,
            temp_hp: 4,
            conditions: ['poisoned', 'frightened'],
            concentration: { name: 'bless' },
          }
        : c,
    );
    expect(renderTurn(s, swingLog())).toContain('g goblin: 5/20 HP, (+4 temp), poisoned, frightened, at 0,0, concentrating on bless');
  });

  it('renders a dead combatant with dead in place of the HP', () => {
    const s = fixture();
    s.combatants = s.combatants.map((c) => (c.id === 2 ? { ...c, alive: false, hp_current: 0 } : c));
    expect(renderTurn(s, swingLog())).toContain('g goblin: dead, at 0,0');
  });

  it('contains no ASCII grid row', () => {
    const lines = renderTurn(fixture(), swingLog()).split('\n');
    expect(lines.some((line) => /^\s{2,}\d+ [.\w~#]+$/.test(line))).toBe(false);
  });
});
