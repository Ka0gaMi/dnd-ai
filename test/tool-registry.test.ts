import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

const TOOL_NAMES = [
  'add_combatant',
  'advance_turn',
  'attack',
  'check_mechanics',
  'checkpoint',
  'condition',
  'create_campaign',
  'create_character',
  'effect',
  'end_encounter',
  'entity',
  'find_position',
  'generate_portrait',
  'get_battle_state',
  'get_character_sheet',
  'get_codex',
  'grant_feature',
  'hp',
  'inspiration',
  'inventory',
  'language',
  'level_up',
  'library',
  'list_character_options',
  'load_campaign',
  'log_event',
  'mark_story_filled',
  'move_token',
  'note_play',
  'party',
  'propose',
  'propose_level_up_options',
  'read_guide',
  'read_journal',
  'region',
  'remember',
  'rest',
  'revise_mechanics',
  'roll',
  'roll_table',
  'rumour',
  'spells',
  'srd_lookup',
  'start_encounter',
  'story',
  'thread',
  'time',
  'undo_last_combat_action',
  'update_objectives',
  'use_action',
  'xp',
];

describe('the registered tool set', () => {
  it('lists well-formed unique tool names', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names.every((name) => /^[a-z][a-z0-9_]*$/.test(name))).toBe(true);
    expect(names.sort()).toEqual(TOOL_NAMES);
  });
});
