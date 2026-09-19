import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';

// Asserted as a subset: other work packages add tools of their own.
const TOOL_NAMES = [
  'add_canon_fact',
  'add_combatant',
  'add_glossary_entry',
  'advance_time',
  'advance_turn',
  'apply_effect',
  'attack',
  'award_xp',
  'condition',
  'create_campaign',
  'create_character',
  'end_effect',
  'end_encounter',
  'end_session',
  'get_battle_state',
  'get_character_sheet',
  'get_codex',
  'grant_feature',
  'hp',
  'level_up',
  'list_campaigns',
  'list_character_options',
  'load_campaign',
  'log_event',
  'move_token',
  'note_play',
  'open_chapter',
  'propose_feature',
  'read_guide',
  'rest',
  'roll',
  'save_checkpoint',
  'set_calendar',
  'spells',
  'start_encounter',
  'srd_lookup',
  'update_objectives',
  'use_action',
];

let db: Db;

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

beforeEach(() => {
  db = openDb(':memory:');
});

/** A level 3 Sorcerer, the level their second-level slots arrive at. */
async function sorcerer(client: Client): Promise<{ campaign_id: number; character_id: number }> {
  const created = await client.callTool({
    name: 'create_campaign',
    arguments: { name: 'Owed a Spell', story_shape: 'sandbox' },
  });
  const campaign_id = (created.structuredContent as { campaign_id: number }).campaign_id;
  const character = await client.callTool({
    name: 'create_character',
    arguments: {
      campaign_id,
      name: 'Ryn',
      species: 'Human',
      class: 'Sorcerer',
      background: 'Acolyte',
      ability_method: 'standard_array',
      abilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 },
      ability_bonuses: { cha: 2, int: 1 },
      skill_choices: ['arcana', 'persuasion', 'insight'],
      cantrips: ['Fire Bolt', 'Light', 'Prestidigitation', 'Shocking Grasp'],
      spells: ['Burning Hands', 'Shield'],
    },
  });
  const character_id = (character.structuredContent as { character: { id: number } }).character.id;
  await client.callTool({ name: 'award_xp', arguments: { campaign_id, character_id, amount: 900 } });
  await client.callTool({
    name: 'level_up',
    arguments: { campaign_id, character_id, choices: { hp: 'average', spells: ['Thunderwave', 'Sleep'] } },
  });
  await client.callTool({
    name: 'level_up',
    arguments: {
      campaign_id,
      character_id,
      choices: { hp: 'average', spells: ['Grease', 'Magic Missile'], subclass: 'Draconic Sorcery' },
    },
  });
  return { campaign_id, character_id };
}

describe('MCP surface', () => {
  it('exposes every tool with a description and annotations', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(expect.arrayContaining(TOOL_NAMES));
    expect(tools.length).toBeGreaterThanOrEqual(TOOL_NAMES.length);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(80);
      expect(tool.annotations).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
    }
    expect(tools.find((t) => t.name === 'list_campaigns')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'roll')?.annotations?.readOnlyHint).toBe(false);
    await client.close();
  });

  it('exposes the resume and new_story prompts', async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['new_story', 'resume']);

    const resume = await client.getPrompt({ name: 'resume', arguments: {} });
    expect(JSON.stringify(resume.messages)).toContain('list_campaigns');
    const withId = await client.getPrompt({ name: 'resume', arguments: { campaign_id: '3' } });
    expect(JSON.stringify(withId.messages)).toContain('campaign 3');
    await client.close();
  });

  it('rolls dice through the tool and returns structured content', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'roll',
      arguments: { expr: '1d20+5', purpose: 'Perception check', dc: 10 },
    });
    const structured = result.structuredContent as {
      total: number;
      outcome: string | null;
      expr: string;
      roll_type: string;
    };
    expect(structured.expr).toBe('1d20+5');
    expect(structured.total).toBeGreaterThanOrEqual(6);
    expect(structured.roll_type).toBe('other');
    expect(['success', 'failure']).toContain(structured.outcome);
    expect((result.content as Array<{ type: string; text: string }>)[0]?.type).toBe('text');
    await client.close();
  });

  it('treats an attack roll differently from a check', async () => {
    const client = await connect();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.041); // every d20 rolls 20
    const attack = await client.callTool({
      name: 'roll',
      arguments: { expr: '1d20', purpose: 'Scimitar attack', dc: 25, roll_type: 'attack' },
    });
    expect((attack.structuredContent as { outcome: string; natural: number }).outcome).toBe('critical_hit');

    const check = await client.callTool({
      name: 'roll',
      arguments: { expr: '1d20', purpose: 'Athletics check', dc: 25, roll_type: 'check' },
    });
    const checked = check.structuredContent as { outcome: string; natural: number | null };
    expect(checked.outcome).toBe('failure');
    expect(checked.natural).toBe(20);
    random.mockRestore();
    await client.close();
  });

  it('returns a creature stat block ready to roll from', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'srd_lookup',
      arguments: { kind: 'creature', query: 'Goblin Warrior' },
    });
    const { results } = result.structuredContent as {
      results: Array<{ name: string; actions: Array<{ name: string; attack_bonus?: number }> }>;
    };
    expect(results[0]?.name).toBe('Goblin Warrior');
    expect(results[0]?.actions.find((a) => a.name === 'Scimitar')?.attack_bonus).toBe(4);
    await client.close();
  });

  it('creates and loads a campaign end to end', async () => {
    const client = await connect();
    const created = await client.callTool({
      name: 'create_campaign',
      arguments: { name: 'Tunnel Test', story_shape: 'sandbox', premise: 'Testing.' },
    });
    const campaignId = (created.structuredContent as { campaign_id: number }).campaign_id;

    await client.callTool({
      name: 'save_checkpoint',
      arguments: { campaign_id: campaignId, scene_title: 'Arrival', scene_summary: 'They arrived.' },
    });
    const loaded = await client.callTool({ name: 'load_campaign', arguments: { campaign_id: campaignId } });
    const text = (loaded.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('# Tunnel Test');
    expect(text).toContain('Arrival');
    await client.close();
  });

  it('drops the dials that belong to the player when the DM passes them to create_campaign', async () => {
    const client = await connect();
    const created = await client.callTool({
      name: 'create_campaign',
      arguments: {
        name: 'Not the DM to set',
        story_shape: 'sandbox',
        settings: { cheat_mode: true, show_secrets: true, lines: 'harm to children' },
      },
    });
    const campaign_id = (created.structuredContent as { campaign_id: number }).campaign_id;
    const stored = getSettings(db, campaign_id);
    expect(stored.cheat_mode).toBe(false);
    expect(stored.show_secrets).toBe(false);
    expect(stored.lines).toBe('harm to children');
    await client.close();
  });

  it('nags when too many events pass without a checkpoint', async () => {
    const client = await connect();
    const created = await client.callTool({
      name: 'create_campaign',
      arguments: { name: 'Nag', story_shape: 'sandbox' },
    });
    const campaign_id = (created.structuredContent as { campaign_id: number }).campaign_id;

    let last = '';
    for (let i = 0; i < 26; i++) {
      const res = await client.callTool({
        name: 'log_event',
        arguments: { campaign_id, kind: 'narration', text: `Beat ${i}.` },
      });
      last = (res.content as Array<{ text: string }>)[0]!.text;
    }
    expect(last).toContain('Reminder: call save_checkpoint.');
    await client.close();
  });

  it('grants a Sorcerer a spell the DM owes them, once', async () => {
    const client = await connect();
    const { campaign_id, character_id } = await sorcerer(client);

    const granted = await client.callTool({
      name: 'spells',
      arguments: { campaign_id, character_id, op: 'grant', spell: 'Web', reason: 'two picks eaten by duplicates' },
    });
    const result = granted.structuredContent as {
      added: boolean;
      where: string;
      spells: { known: string[]; prepared: string[] };
    };
    expect(result.added).toBe(true);
    expect(result.where).toBe('prepared');
    expect(result.spells.known).toContain('Web');
    expect(result.spells.prepared).toContain('Web');

    const sheet = await client.callTool({ name: 'get_character_sheet', arguments: { campaign_id, character_id } });
    const character = (sheet.structuredContent as { character: { spells: { prepared: string[] } } }).character;
    expect(character.spells.prepared).toContain('Web');

    const again = await client.callTool({
      name: 'spells',
      arguments: { campaign_id, character_id, op: 'grant', spell: 'Web', reason: 'the same debt, paid twice' },
    });
    expect((again.structuredContent as { added: boolean }).added).toBe(false);

    await client.close();
  });

  it('refuses a spell that is not on the class list', async () => {
    const client = await connect();
    const { campaign_id, character_id } = await sorcerer(client);
    const wrongList = await client.callTool({
      name: 'spells',
      arguments: { campaign_id, character_id, op: 'grant', spell: 'Cure Wounds', reason: 'a healer would be nice' },
    });
    expect(wrongList.isError).toBe(true);
    expect((wrongList.content as Array<{ text: string }>)[0]!.text).toContain('is not a Sorcerer spell of level 1-2');
    await client.close();
  });

  it('sends a Wizard back to spells {op: learn}', async () => {
    const client = await connect();
    const created = await client.callTool({
      name: 'create_campaign',
      arguments: { name: 'Spellbook', story_shape: 'sandbox' },
    });
    const campaign_id = (created.structuredContent as { campaign_id: number }).campaign_id;
    await client.callTool({
      name: 'create_character',
      arguments: {
        campaign_id,
        name: 'Zel',
        species: 'Human',
        class: 'Wizard',
        background: 'Sage',
        ability_method: 'standard_array',
        abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
        ability_bonuses: { int: 2, con: 1 },
        skill_choices: ['arcana', 'history', 'investigation'],
        cantrips: ['Fire Bolt', 'Light', 'Prestidigitation'],
        spells: ['Magic Missile', 'Shield', 'Mage Armor', 'Sleep'],
        spellbook: ['Magic Missile', 'Shield', 'Mage Armor', 'Sleep', 'Grease', 'Thunderwave'],
      },
    });
    const refused = await client.callTool({
      name: 'spells',
      arguments: { campaign_id, spell: 'Grease', op: 'grant', reason: 'a reward from the archmage' },
    });
    expect(refused.isError).toBe(true);
    expect((refused.content as Array<{ text: string }>)[0]!.text).toContain('spells {op: learn}');
    await client.close();
  });

  it('levels a class-built companion through the level_up tool by character_id', async () => {
    const client = await connect();
    const created = await client.callTool({
      name: 'create_campaign',
      arguments: { name: 'Companion Level Up', story_shape: 'sandbox' },
    });
    const campaign_id = (created.structuredContent as { campaign_id: number }).campaign_id;

    const companion = await client.callTool({
      name: 'create_companion',
      arguments: { name: 'Rook', source: { class: 'Fighter', species: 'Human', background: 'Soldier' }, campaign_id },
    });
    const character_id = (companion.structuredContent as { companion: { id: number } }).companion.id;

    const award = await client.callTool({
      name: 'award_xp',
      arguments: { campaign_id, character_id, amount: 300 },
    });
    expect((award.structuredContent as { level_up_available: boolean }).level_up_available).toBe(true);

    const levelled = await client.callTool({
      name: 'level_up',
      arguments: { campaign_id, character_id, choices: { hp: 'average' } },
    });
    const result = levelled.structuredContent as { level: number; character: { id: number } };
    expect(result.level).toBe(2);
    expect(result.character.id).toBe(character_id);
    await client.close();
  });
});
