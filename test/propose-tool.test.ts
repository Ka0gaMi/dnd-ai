import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { updateSettings } from '../src/core/settings.js';
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

/** A feature written as clauses, which is what the engine runs. */
const TRAPWRIGHT = {
  name: 'Trapwright',
  text: 'Your snares catch what walks past them.',
  mechanics: {},
  clauses: [{ when: 'always', do: [{ kind: 'proficiency', skill: 'stealth' }] }],
  justification: 'They have rigged a trap in every fight this chapter.',
};

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Propose', story_shape: 'sandbox' }).campaign_id;
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

describe('propose as one tool', () => {
  it('advertises the op enum in order with a line per op, and no old tool name', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('propose');
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
    const tool = tools.find((t) => t.name === 'propose')!;
    expect(tool.title).toBe('Propose homebrew content');
    const props = (tool.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.op!.enum).toEqual(['feature', 'subclass', 'spell', 'background']);
    const description = tool.description ?? '';
    expect(description).toContain('op=feature:');
    expect(description).toContain('op=subclass:');
    expect(description).toContain('op=spell:');
    expect(description).toContain('op=background:');
    expect(description).toContain('You must set op; there is no default.');
  });

  it('lands a feature written as clauses', async () => {
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const client = await connect();
    const result = await call<{ status: string; homebrew_id: number; report: { budget_used: number } }>(client, 'propose', {
      op: 'feature',
      campaign_id: campaignId,
      ...TRAPWRIGHT,
    });
    expect(result.status).toBe('applied');
    expect(result.report.budget_used).toBe(0.25);
    expect(db.prepare('SELECT kind, name FROM homebrew WHERE id = ?').get(result.homebrew_id)).toEqual({
      kind: 'feature',
      name: 'Trapwright',
    });
  });

  it('refuses legacy flat mechanics and names read_guide and check_mechanics', async () => {
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const client = await connect();
    await expect(
      call(client, 'propose', {
        op: 'feature',
        campaign_id: campaignId,
        name: 'Trapwright',
        text: 'Your snares catch what walks past them.',
        mechanics: { ac: 1 },
        justification: 'They have rigged a trap in every fight this chapter.',
      }),
    ).rejects.toThrow(
      /Legacy mechanics are no longer accepted: ac must be written as clauses .*Read read_guide \{section: "homebrew"\} and run check_mechanics/s,
    );
    expect(db.prepare('SELECT count(*) AS n FROM homebrew').get()).toEqual({ n: 0 });
  });

  it('answers a missing required field and a foreign field with teaching errors', async () => {
    const client = await connect();
    // text is required for op=feature but left out here.
    await expect(
      call(client, 'propose', {
        op: 'feature',
        campaign_id: campaignId,
        name: 'Trapwright',
        mechanics: {},
        justification: 'They have rigged a trap in every fight this chapter.',
      }),
    ).rejects.toThrow('Missing text for op=feature');

    // skills belongs to op=background, not op=feature.
    await expect(
      call(client, 'propose', {
        op: 'feature',
        campaign_id: campaignId,
        ...TRAPWRIGHT,
        skills: ['stealth', 'investigation'],
      }),
    ).rejects.toThrow(/skills does not apply to op=feature/);
    expect(db.prepare('SELECT count(*) AS n FROM homebrew').get()).toEqual({ n: 0 });
  });

  it('names the field at fault when a schema does not fit its op, and points a subclass sent as a spell at op=subclass', async () => {
    const client = await connect();
    await expect(
      call(client, 'propose', {
        op: 'spell',
        campaign_id: campaignId,
        justification: 'A cantrip for a hedge witch.',
        schema: { name: 'Ember', level: '1' },
      }),
    ).rejects.toThrow(/does not fit op=spell[\s\S]*level/);

    await expect(
      call(client, 'propose', {
        op: 'spell',
        campaign_id: campaignId,
        justification: 'Meant as a subclass.',
        schema: { class: 'Fighter', name: 'Trapwright', flavour_text: 'Rigs everything.', features: {} },
      }),
    ).rejects.toThrow(/That looks like a subclass: call propose \{op: subclass\}/);
    expect(db.prepare('SELECT count(*) AS n FROM homebrew').get()).toEqual({ n: 0 });
  });

  it('creates a background with its origin feat', async () => {
    const client = await connect();
    const result = await call<{
      status: string;
      homebrew_id: number;
      clause_status: Array<{ describe: string }>;
    }>(client, 'propose', {
      op: 'background',
      campaign_id: campaignId,
      name: 'Hedgewright',
      abilities: ['dex', 'int', 'wis'],
      origin_feat: {
        name: 'Hedge Sense',
        text: 'The wild tells you where things hide.',
        mechanics: {},
        clauses: [{ when: 'always', do: [{ kind: 'proficiency', skill: 'nature' }] }],
      },
      skills: ['stealth', 'investigation'],
      tool: 'Herbalism Kit',
      equipment: { items: [], gold: 10 },
      text: 'You grew up at the edge of the wood.',
    });
    expect(result.status).toBe('created');
    expect(result.clause_status).toHaveLength(1);
    const row = db.prepare('SELECT kind, schema_json FROM homebrew WHERE id = ?').get(result.homebrew_id) as {
      kind: string;
      schema_json: string;
    };
    expect(row.kind).toBe('background');
    expect((JSON.parse(row.schema_json) as { origin_feat: { name: string } }).origin_feat.name).toBe('Hedge Sense');
  });
});
