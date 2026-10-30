// Every tool says whether it writes: hosts confirm unannotated tools as writes, and run read-only ones in parallel.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Tool } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { getBattleState } from '../src/combat/state.js';
import { createGameServer } from '../src/mcp/server.js';
import { resolvePendingRollsImmediately } from './helpers.js';

/** The tools whose every path only reads; every other tool, and every op tool with one writing op, writes. */
const READ_ONLY = [
  'check_mechanics',
  'find_position',
  'get_battle_state',
  'get_character_sheet',
  'get_codex',
  'list_character_options',
  'read_guide',
  'read_journal',
  'roll_table',
  'srd_lookup',
];

let db: Db;
let client: Client;
let tools: Tool[];
let stopClicking: () => void;

async function call(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
  return { isError: result.isError, text: result.content.map((c) => c.text ?? '').join('') };
}

beforeAll(async () => {
  db = openDb(':memory:');
  stopClicking = resolvePendingRollsImmediately(db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'annotations-test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  tools = (await client.listTools()).tools;
});

afterAll(async () => {
  stopClicking();
  await client.close();
});

describe('tool annotations', () => {
  it('gives every tool an explicit readOnlyHint', () => {
    const unset = tools.filter((tool) => typeof tool.annotations?.readOnlyHint !== 'boolean').map((tool) => tool.name);
    expect(unset).toEqual([]);
  });

  it('marks exactly the classified tools read-only, each of them idempotent and closed-world', () => {
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint === true);
    expect(readOnly.map((tool) => tool.name).sort()).toEqual(READ_ONLY);
    for (const tool of readOnly) {
      expect(tool.annotations, tool.name).toMatchObject({ idempotentHint: true, destructiveHint: false, openWorldHint: false });
    }
  });

  it('lets no write tool claim read-only', () => {
    const writes = tools.filter((tool) => !READ_ONLY.includes(tool.name));
    expect(writes.length).toBe(tools.length - READ_ONLY.length);
    for (const tool of writes) expect(tool.annotations?.readOnlyHint, tool.name).toBe(false);
  });

  it('changes nothing in the database when a read-only tool is called', async () => {
    const { text } = await call('create_campaign', { name: 'Readers', story_shape: 'sandbox' });
    const campaign_id = (JSON.parse(text) as { campaign_id: number }).campaign_id;
    const built = await call('create_character', {
      campaign_id,
      name: 'Borg',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    });
    expect(built.isError, built.text).toBeFalsy();
    const started = await call('start_encounter', {
      campaign_id,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior' }],
    });
    expect(started.isError, started.text).toBeFalsy();
    const fighters = getBattleState(db, campaign_id, false)!.combatants;
    const pc = fighters.find((c) => c.team === 'party')!.id;
    const goblin = fighters.find((c) => c.team === 'enemy')!.id;

    const calls: Record<string, Record<string, unknown>> = {
      check_mechanics: { campaign_id, text: 'You move quietly.' },
      find_position: { campaign_id, combatant_id: pc, within_reach_of: goblin },
      get_battle_state: { campaign_id },
      get_character_sheet: { campaign_id },
      get_codex: { campaign_id },
      list_character_options: { campaign_id, class: 'Rogue' },
      read_guide: { section: 'combat' },
      read_journal: { campaign_id },
      roll_table: { campaign_id, table: 'names' },
      srd_lookup: { kind: 'creature', query: 'Goblin Warrior' },
    };
    expect(Object.keys(calls).sort()).toEqual(READ_ONLY);
    const changes = (): number => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const wrote: string[] = [];
    for (const [name, args] of Object.entries(calls)) {
      const before = changes();
      const reply = await call(name, args);
      expect(reply.isError, `${name}: ${reply.text}`).toBeFalsy();
      if (changes() !== before) wrote.push(name);
    }
    expect(wrote).toEqual([]);
  });
});
