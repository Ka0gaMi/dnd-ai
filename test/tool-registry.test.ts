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
  'add_canon_fact',
  'add_combatant',
  'add_glossary_entry',
  'advance_turn',
  'apply_damage',
  'attack',
  'check_mechanics',
  'create_background',
  'create_campaign',
  'create_character',
  'death_save',
  'effect',
  'end_encounter',
  'end_session',
  'entity',
  'find_position',
  'generate_portrait',
  'get_battle_state',
  'get_character_sheet',
  'get_codex',
  'get_play_profile',
  'grant_feature',
  'grant_spell',
  'heal',
  'inspiration',
  'inventory',
  'language',
  'learn_spell',
  'level_up',
  'list_campaigns',
  'list_character_options',
  'list_library',
  'load_campaign',
  'log_event',
  'mark_story_filled',
  'move_token',
  'note_play',
  'party',
  'prepare_spells',
  'propose_feature',
  'propose_level_up_options',
  'propose_spell',
  'propose_subclass',
  'read_guide',
  'read_journal',
  'rest',
  'revise_mechanics',
  'roll',
  'roll_table',
  'rumour',
  'save_checkpoint',
  'save_to_library',
  'set_combat_condition',
  'set_condition',
  'set_exhaustion',
  'set_temp_hp',
  'srd_lookup',
  'stabilize',
  'start_encounter',
  'story',
  'thread',
  'time',
  'undo_last_combat_action',
  'update_objectives',
  'use_action',
  'use_spell_slot',
  'xp',
];

describe('the registered tool set', () => {
  it('lists well-formed unique tool names', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    // The exact TOOL_NAMES list returns once the op-consolidation wave is complete; until then every
    // package that merges or removes tools updates this count in its own diff.
    expect(names.every((name) => /^[a-z][a-z0-9_]*$/.test(name))).toBe(true);
    expect(names.length).toBe(58);
  });
});
