import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { saveHomebrew } from '../src/core/progression.js';
import { openDb, type Db } from '../src/db/connection.js';
import { registerProgressionTools } from '../src/mcp/tools/progression.js';

let db: Db;
let campaignId: number;

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerProgressionTools(server, db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result.structuredContent as T;
}

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Library', story_shape: 'sandbox' }).campaign_id;
  // The level the entry was balanced at is stamped on save, so a campaign needs a character to ask.
  createCharacter(db, {
    campaign_id: campaignId,
    name: 'Vex',
    species: 'Human',
    class: 'Rogue',
    background: 'Criminal',
    ability_method: 'standard_array',
    abilities: { str: 8, dex: 15, con: 14, int: 13, wis: 12, cha: 10 },
    ability_bonuses: { dex: 2, int: 1 },
    skill_choices: ['acrobatics', 'perception', 'persuasion', 'athletics', 'survival'],
  });
});

afterEach(() => db.close());

describe('library as one tool', () => {
  it('advertises save and list with a line per op, and no old tool name', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('library');
    for (const old of [
      'propose_feature',
      'propose_subclass',
      'propose_spell',
      'create_background',
      'save_to_library',
      'list_library',
      'get_play_profile',
    ]) {
      expect(names).not.toContain(old);
    }
    const tool = tools.find((t) => t.name === 'library')!;
    expect(tool.title).toBe('The homebrew library');
    const props = (tool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.op!.enum).toEqual(['save', 'list']);
    const description = tool.description ?? '';
    expect(description).toContain('op=save:');
    expect(description).toContain('op=list:');
    expect(description).toContain('You must set op; there is no default.');
  });

  it('saves an entry and lists it back', async () => {
    const entry = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'feature',
      name: 'Trapwright',
      schema: { text: 'Your snares catch what walks past them.' },
    });
    const client = await connect();

    const saved = await call<{ saved: { scope: string; balanced_at_level: number } }>(client, 'library', {
      op: 'save',
      homebrew_id: entry.id,
    });
    expect(saved.saved.scope).toBe('library');
    expect(saved.saved.balanced_at_level).toBe(1);

    const listed = await call<{ library: Array<{ name: string; kind: string }> }>(client, 'library', { op: 'list' });
    expect(listed.library).toHaveLength(1);
    expect(listed.library[0]).toMatchObject({ name: 'Trapwright', kind: 'feature' });
  });

  it('answers a missing required field and a foreign field with teaching errors', async () => {
    const client = await connect();
    await expect(call(client, 'library', { op: 'save' })).rejects.toThrow(
      'Missing homebrew_id for op=save (requires homebrew_id). Re-call with homebrew_id set.',
    );

    // kind belongs to op=list, not op=save.
    await expect(call(client, 'library', { op: 'save', homebrew_id: 1, kind: 'feat' })).rejects.toThrow(
      /kind does not apply to op=save/,
    );
  });
});
