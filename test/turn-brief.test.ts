// The turn brief renderTurn ends every turn reply with: the foes in move + reach with distance, cover,
// AC and a wound word, the active monster's attacks, the call that closes a won fight, and no footer.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegalAction } from '../src/combat/actions.js';
import type { BattleMap } from '../src/combat/map.js';
import {
  activeEncounter,
  getBattleState,
  renderTurn,
  turnView,
  type BattleState,
  type CombatantView,
  type CombatLogEntry,
  type EncounterRow,
} from '../src/combat/state.js';
import { estimateTokens } from '../src/core/token-budget.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';
import { replyData } from './helpers/reply.js';

/** The Playability review's cap on one turn reply, in estimated tokens. */
const TURN_REPLY = 300;

const combatant = (over: Partial<CombatantView> & Pick<CombatantView, 'id' | 'name' | 'team' | 'marker'>): CombatantView => ({
  encounter_id: 1,
  kind: 'monster',
  character_id: null,
  initiative: 10,
  initiative_order: over.id,
  x: 0,
  y: 0,
  size: 'M',
  hp_current: 10,
  hp_max: 10,
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

const map: BattleMap = { w: 12, h: 5, rows: Array.from({ length: 5 }, () => '.'.repeat(12)), features: [] };

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

const glaive: LegalAction = { id: 'attack:Glaive', label: 'Attack: Glaive', hint: '+5 to hit, 1d10+3 slashing, reach 10 ft.' };

const state = (combatants: CombatantView[], legal_actions: LegalAction[] = [glaive]): BattleState => ({
  encounter,
  map,
  round: 2,
  turn_index: 0,
  combatants,
  active: { id: 1, name: 'Borg', team: 'party', kind: 'pc' },
  legal_actions,
  effects: [],
  log_tail: [],
});

const borg = (over: Partial<CombatantView> = {}): CombatantView =>
  combatant({ id: 1, name: 'Borg', team: 'party', marker: 'B', kind: 'pc', ac: 16, hp_current: 20, hp_max: 20, ...over });

/** Borg with a glaive (30 ft move + 10 ft reach) among foes near, behind one another, far and dead. */
const field = (): CombatantView[] => [
  borg(),
  combatant({ id: 2, name: 'goblin', team: 'enemy', marker: 'g', x: 2 }),
  combatant({ id: 3, name: 'ogre', team: 'enemy', marker: 'o', x: 4, ac: 11, hp_current: 29, hp_max: 59 }),
  combatant({ id: 4, name: 'wolf', team: 'enemy', marker: 'w', y: 4, ac: 13, hp_current: 2, hp_max: 11 }),
  combatant({ id: 5, name: 'bandit', team: 'enemy', marker: 'b', x: 11, y: 4, ac: 12, hp_current: 8, hp_max: 11 }),
  combatant({ id: 6, name: 'rat', team: 'enemy', marker: 'r', x: 1, y: 1, alive: false, hp_current: 0 }),
  combatant({ id: 7, name: 'Cira', team: 'party', marker: 'C', kind: 'companion', x: 6, y: 4 }),
];

const log: CombatLogEntry[] = [
  { id: 1, round: 2, actor_id: 1, target_id: null, kind: 'turn_start', payload: null, text: "Round 2: Borg's turn.", ts: '' },
];

const lastLine = (text: string): string => text.split('\n').at(-1)!;

describe('the turn brief', () => {
  it('lists only the living foes within move + reach, nearest first, with distance, cover, AC and a wound word', () => {
    expect(lastLine(renderTurn(state(field()), log))).toBe(
      'Foes within 40 ft (30 ft move + 10 ft reach): g goblin 10 ft, no cover, AC 15, untouched; ' +
        'o ogre 20 ft, half cover, AC 11, bloodied; w wolf 20 ft, no cover, AC 13, staggering.',
    );
  });

  it('never prints a foe hit point number', () => {
    const text = lastLine(renderTurn(state(field()), log));
    expect(text).not.toMatch(/\d+\/\d+|\bHP\b/);
  });

  it('names the nearest foe when none is in reach, and falls back to a 5 ft reach without a melee attack', () => {
    const far = field().map((c) => (c.id === 1 ? { ...c, movement_left: 0 } : c));
    expect(lastLine(renderTurn(state(far, []), log))).toBe(
      'No foe within 5 ft (0 ft move + 5 ft reach); nearest: g goblin 10 ft, no cover, AC 15, untouched.',
    );
  });

  it('caps the list at five foes and counts the rest', () => {
    const goblins = Array.from({ length: 7 }, (_, i) =>
      combatant({ id: 10 + i, name: `goblin ${i + 1}`, team: 'enemy', marker: String(i), x: 1 + i }),
    );
    const crowd = [borg(), ...goblins];
    const brief = lastLine(renderTurn(state(crowd), log));
    expect(brief.match(/, AC 15, untouched/g)).toHaveLength(5);
    expect(brief.endsWith('; 2 more.')).toBe(true);
  });

  it('closes a won fight with the end_encounter line instead of the foes', () => {
    const won = field().map((c) => (c.team === 'enemy' ? { ...c, alive: false, hp_current: 0 } : c));
    const text = renderTurn(state(won), log);
    expect(lastLine(text)).toBe('No enemies left standing: call end_encounter.');
    expect(text).not.toContain('Foes within');
  });

  it('drops the get_battle_state footer', () => {
    expect(renderTurn(state(field()), log)).not.toContain('get_battle_state');
  });
});

describe('the vitals and has_acted', () => {
  it('carries AC and flags on every touched combatant, in the JSON and in the words', () => {
    const flags = { dodging: true, ready: { trigger: 'it comes close', action: 'Glaive' } };
    const s = state([borg({ flags }), ...field().slice(1)]);
    const vitals = turnView(s, log).touched[0]!;
    expect(vitals.ac).toBe(16);
    expect(vitals.flags).toEqual(flags);
    expect(renderTurn(s, log)).toContain('B Borg: 20/20 HP, AC 16, dodging, readied Glaive, at 0,0');
  });

  it('counts a spent reaction as having acted', () => {
    const fresh = state(field());
    expect(turnView(fresh, log).active_has_acted).toBe(false);
    const reacted = state([borg({ reaction_used: true }), ...field().slice(1)]);
    expect(turnView(reacted, log).active_has_acted).toBe(true);
    expect(renderTurn(reacted, log)).toContain('Round 2 - Borg is up, has acted.');
  });
});

let db: Db;
let stopClicking: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  stopClicking = resolvePendingRollsImmediately(db);
});

afterEach(() => stopClicking());

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; result: unknown }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  if (result.isError) throw new Error(text);
  return { text, result };
}

/** A lone Fighter against the enemies given, on a small road. */
async function openFight(client: Client, enemies: Array<{ creature: string; count?: number }>): Promise<number> {
  const { result } = await call(client, 'create_campaign', { name: 'Turn Brief', story_shape: 'sandbox' });
  const campaignId = replyData<{ campaign_id: number }>(result).campaign_id;
  await call(client, 'create_character', {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
  await call(client, 'start_encounter', { campaign_id: campaignId, seed: 7, terrain: 'road', size: 'small', enemies });
  return campaignId;
}

/** The DM's view of the fight, read from the engine since get_battle_state answers in words. */
const battle = (campaignId: number): BattleState => getBattleState(db, campaignId, false)!;

describe('advance_turn', () => {
  it("brings the goblin's attacks on its turn, and none on the PC's", async () => {
    const client = await connect();
    const campaignId = await openFight(client, [{ creature: 'Goblin Warrior' }]);
    const seen = { monster: false, pc: false };
    for (let step = 0; step < 4; step += 1) {
      const { text } = await call(client, 'advance_turn', { campaign_id: campaignId });
      const up = battle(campaignId).active!;
      if (up.kind === 'monster') {
        seen.monster = true;
        expect(text).toContain(
          'Attacks: Scimitar +4 to hit, 1d6+2 slashing, reach 5 ft; Shortbow +4 to hit, 1d6+2 piercing, range 80/320 ft',
        );
        expect(lastLine(text)).toMatch(/^No foe within 35 ft \(30 ft move \+ 5 ft reach\); nearest: B Borg \d+ ft, .+, untouched\.$/);
      } else {
        seen.pc = true;
        expect(text).not.toContain('Attacks:');
        expect(lastLine(text)).toMatch(/^No foe within 35 ft .*; nearest: g Goblin Warrior \d+ ft, .+, AC 15, untouched\.$/);
      }
      expect(text).not.toContain('get_battle_state');
    }
    expect(seen).toEqual({ monster: true, pc: true });
  });

  it('says to call end_encounter once the last enemy is down', async () => {
    const client = await connect();
    const campaignId = await openFight(client, [{ creature: 'Goblin Warrior' }]);
    db.prepare("UPDATE combatant SET hp_current = 0, alive = 0 WHERE team = 'enemy'").run();
    const { text } = await call(client, 'advance_turn', { campaign_id: campaignId });
    expect(lastLine(text)).toBe('No enemies left standing: call end_encounter.');
  });

  it(`keeps every reply of a crowded round within ${TURN_REPLY} tokens`, async () => {
    const client = await connect();
    const campaignId = await openFight(client, [
      { creature: 'Goblin Warrior', count: 4 },
      { creature: 'Wolf', count: 2 },
      { creature: 'Goblin Boss' },
    ]);
    // Crowd every enemy onto the free cells nearest the PC.
    const field0 = battle(campaignId);
    const pc = field0.combatants.find((c) => c.kind === 'pc')!;
    const free: Array<{ x: number; y: number }> = [];
    field0.map.rows.forEach((row, y) =>
      [...row].forEach((cell, x) => {
        if (cell !== '#' && !(x === pc.x && y === pc.y)) free.push({ x, y });
      }),
    );
    const gap = (cell: { x: number; y: number }): number => Math.max(Math.abs(cell.x - pc.x), Math.abs(cell.y - pc.y));
    free.sort((a, b) => gap(a) - gap(b));
    const enemies = field0.combatants.filter((c) => c.team === 'enemy');
    enemies.forEach((c, i) => db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(free[i]!.x, free[i]!.y, c.id));

    const sizes: number[] = [];
    let pcBrief = '';
    for (let step = 0; step < 1 + enemies.length; step += 1) {
      const { text } = await call(client, 'advance_turn', { campaign_id: campaignId });
      sizes.push(estimateTokens(text));
      if (battle(campaignId).active?.kind === 'pc') pcBrief = lastLine(text);
    }
    expect(pcBrief).toMatch(/^Foes within 35 ft .*; 2 more\.$/);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(TURN_REPLY);
  });
});

describe('the player battle state', () => {
  afterAll(() => {
    vi.doUnmock('../src/core/secret-fields.js');
    vi.resetModules();
  });

  it('carries no combatant flag the secret-field registry names DM-only, while the DM view keeps it', async () => {
    const client = await connect();
    const campaignId = await openFight(client, [{ creature: 'Goblin Warrior' }]);
    db.prepare("UPDATE combatant SET flags_json = ? WHERE team = 'enemy'").run(
      JSON.stringify({ dodging: true, zqx_plan: 'flank the wizard' }),
    );
    // The registry holds no combatant flag yet, so this run registers one the way a later package would.
    vi.doMock('../src/core/secret-fields.js', async (importOriginal) => {
      const real = await importOriginal<typeof import('../src/core/secret-fields.js')>();
      const planted = { id: 'test_plan', source: 'combatant.flags_json.zqx_plan', secret_while: 'always' };
      return { ...real, DM_ONLY_FIELDS: [...real.DM_ONLY_FIELDS, planted] };
    });
    vi.resetModules();
    const fresh = await import('../src/combat/state.js');
    const foe = (s: BattleState | null): CombatantView => s!.combatants.find((c) => c.team === 'enemy')!;

    const player = fresh.getBattleState(db, campaignId, true);
    expect(foe(player).flags).toEqual({ dodging: true });
    expect(JSON.stringify(player)).not.toContain('flank the wizard');
    expect(foe(fresh.battleState(db, activeEncounter(db, campaignId)!, false)).flags).toEqual({
      dodging: true,
      zqx_plan: 'flank the wizard',
    });
  });
});
