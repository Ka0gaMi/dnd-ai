import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import { openDb, type Db } from '../src/db/connection.js';
import { renderBriefing } from '../src/mcp/tools/campaign.js';
import { registerStoryTools } from '../src/mcp/tools/story.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, {
    name: 'The Ashfall Road',
    story_shape: 'structured',
    premise: 'A road of cinders.',
  }).campaign_id;
});

/** Only the story tools: the rest of the server is not what is under test. */
async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'story-tool-test', version: '0.0.0' });
  registerStoryTools(server, db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const textOf = (result: CallToolResult): string => (result.content as Array<{ text: string }>)[0]!.text;

describe('the story tool', () => {
  it('sets the outline through op=outline, and the briefing story reflects it', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'story',
      arguments: {
        op: 'outline',
        campaign_id: campaignId,
        premise: 'Ash falls on the old road.',
        ending: 'The forge is put out.',
        secret_notes: 'The smith is already dead.',
      },
    });
    expect(result.isError).toBeUndefined();
    expect(campaignSnapshot(db, campaignId).story.outline).toMatchObject({
      premise: 'Ash falls on the old road.',
      ending: 'The forge is put out.',
      secret_notes: 'The smith is already dead.',
    });
    const briefing = renderBriefing(campaignSnapshot(db, campaignId));
    expect(briefing).toContain('## Story arc');
    expect(briefing).toContain('Planned ending: The forge is put out.');
    expect(briefing).toContain('[secret] DM notes: The smith is already dead.');
    await client.close();
  });

  it('adds an act through op=act', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'story',
      arguments: { op: 'act', campaign_id: campaignId, title: 'The Road South', goal: 'Reach the forge.' },
    });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as {
      act: { number: number; title: string };
      acts: Array<{ number: number }>;
    };
    expect(structured.act).toMatchObject({ number: 1, title: 'The Road South' });
    expect(structured.acts).toHaveLength(1);
    await client.close();
  });

  it('opens a chapter through op=open_chapter', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'story',
      arguments: { op: 'open_chapter', campaign_id: campaignId, title: 'Cinders', goal: 'Leave the village.' },
    });
    expect(result.isError).toBeUndefined();
    const { chapter } = result.structuredContent as { chapter: { number: number; title: string; status: string } };
    expect(chapter).toMatchObject({ number: 1, title: 'Cinders', status: 'open' });
    await client.close();
  });

  it('closes the open chapter and opens the next through op=advance_chapter', async () => {
    const client = await connect();
    await client.callTool({
      name: 'story',
      arguments: { op: 'open_chapter', campaign_id: campaignId, title: 'Cinders' },
    });
    const result = await client.callTool({
      name: 'story',
      arguments: {
        op: 'advance_chapter',
        campaign_id: campaignId,
        summary: 'The village burned and the party took the south road.',
        title: 'The Long Walk',
      },
    });
    expect(result.isError).toBeUndefined();
    const { closed, opened } = result.structuredContent as {
      closed: { number: number; status: string; summary: string };
      opened: { number: number; title: string; status: string };
    };
    expect(closed).toMatchObject({ number: 1, status: 'closed', summary: 'The village burned and the party took the south road.' });
    expect(opened).toMatchObject({ number: 2, title: 'The Long Walk', status: 'open' });
    await client.close();
  });

  it('answers a missing required field on op=act with the teaching error', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'story',
      arguments: { op: 'act', campaign_id: campaignId },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Missing title for op=act (requires title). Re-call with title set.');
    await client.close();
  });

  it('refuses a field from another op on op=advance_chapter', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'story',
      arguments: { op: 'advance_chapter', campaign_id: campaignId, summary: 'A recap.', premise: 'Not this op.' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'premise does not apply to op=advance_chapter; it takes campaign_id, summary, title, goal, act_id. Re-call without it.',
    );
    await client.close();
  });

  it('advertises story and not the four tools it replaced, with a line per op', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('story');
    for (const old of ['set_story_outline', 'add_act', 'open_chapter', 'advance_chapter']) {
      expect(names).not.toContain(old);
    }
    const description = tools.find((tool) => tool.name === 'story')!.description ?? '';
    expect(description).toContain('op=outline:');
    expect(description).toContain('op=act:');
    expect(description).toContain('op=open_chapter:');
    expect(description).toContain('op=advance_chapter:');
    await client.close();
  });
});
