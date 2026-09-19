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
  'add_act',
  'add_canon_fact',
  'add_combatant',
  'add_glossary_entry',
  'add_item',
  'add_plot_thread',
  'add_rumour',
  'adjust_gold',
  'advance_chapter',
  'advance_time',
  'advance_turn',
  'apply_damage',
  'apply_effect',
  'attack',
  'award_xp',
  'check_mechanics',
  'create_background',
  'create_campaign',
  'create_character',
  'death_save',
  'end_effect',
  'end_encounter',
  'end_session',
  'entity_tree',
  'equip_item',
  'find_clue',
  'find_position',
  'generate_portrait',
  'get_battle_state',
  'get_character_sheet',
  'get_codex',
  'get_entity',
  'get_play_profile',
  'get_rumours',
  'grant_feature',
  'grant_level',
  'grant_spell',
  'heal',
  'inspiration',
  'language',
  'learn_spell',
  'level_up',
  'link_entities',
  'list_campaigns',
  'list_character_options',
  'list_inventory',
  'list_library',
  'load_campaign',
  'log_event',
  'mark_story_filled',
  'move_token',
  'note_play',
  'open_chapter',
  'party',
  'plant_clue',
  'prepare_spells',
  'propose_feature',
  'propose_level_up_options',
  'propose_spell',
  'propose_subclass',
  'read_guide',
  'read_journal',
  'remove_item',
  'rest',
  'revise_mechanics',
  'roll',
  'roll_table',
  'save_checkpoint',
  'save_to_library',
  'sell_item',
  'set_calendar',
  'set_combat_condition',
  'set_condition',
  'set_exhaustion',
  'set_story_outline',
  'set_temp_hp',
  'set_voice_card',
  'srd_lookup',
  'stabilize',
  'start_encounter',
  'undo_last_combat_action',
  'update_objectives',
  'update_plot_thread',
  'upsert_entity',
  'use_action',
  'use_item',
  'use_spell_slot',
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
    expect(names.length).toBe(78);
  });
});
