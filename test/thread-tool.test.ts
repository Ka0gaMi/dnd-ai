import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import { addRumour, getRumours, type Clue, type PlotThread, type Rumour } from '../src/core/story.js';
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

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'thread-tool-test', version: '0.0.0' });
  registerStoryTools(server, db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name: 'thread', arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result.structuredContent as T;
}

const textOf = (result: CallToolResult): string => (result.content as Array<{ text: string }>)[0]!.text;

const dmBriefing = (): string => renderBriefing(campaignSnapshot(db, campaignId));

describe('thread{op: add} and thread{op: update}', () => {
  it('opens a thread that the briefing story arc shows', async () => {
    const client = await connect();
    const { thread } = await call<{ thread: PlotThread }>(client, {
      op: 'add',
      campaign_id: campaignId,
      title: 'Who set the fire?',
      summary: 'The reeve has the lamp oil.',
    });
    expect(thread).toMatchObject({ title: 'Who set the fire?', status: 'open', hidden: false });
    const briefing = dmBriefing();
    expect(briefing).toContain('## Story arc');
    expect(briefing).toContain(`Who set the fire? (id ${thread.id})`);
  });

  it('resolves a thread and takes it out of the open list', async () => {
    const client = await connect();
    const { thread } = await call<{ thread: PlotThread }>(client, {
      op: 'add',
      campaign_id: campaignId,
      title: 'Who set the fire?',
    });
    const { thread: updated } = await call<{ thread: PlotThread }>(client, {
      op: 'update',
      campaign_id: campaignId,
      id: thread.id,
      status: 'resolved',
    });
    expect(updated).toMatchObject({ id: thread.id, status: 'resolved' });
    expect(campaignSnapshot(db, campaignId).story.threads).toEqual([]);
    expect(dmBriefing()).toContain('Open threads:\n- None.');
  });

  it('teaches what op=add is missing when its required field is absent', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'thread',
      arguments: { op: 'add', campaign_id: campaignId },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe('Missing title for op=add (requires title). Re-call with title set.');
  });

  it('refuses a field another op uses on op=add', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'thread',
      arguments: { op: 'add', campaign_id: campaignId, title: 'Who set the fire?', status: 'resolved' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'status does not apply to op=add; it takes campaign_id, title, summary, hidden. Re-call without it.',
    );
  });
});

describe('thread{op: plant_clue} and thread{op: find_clue}', () => {
  it('plants a hidden clue the player window never sees but the DM reply carries', async () => {
    const client = await connect();
    const { clue } = await call<{ clue: Clue }>(client, {
      op: 'plant_clue',
      campaign_id: campaignId,
      text: 'A boot print in the ash, too small for a man.',
      hidden: true,
    });
    expect(clue).toMatchObject({ status: 'planted', hidden: true });
    expect(campaignSnapshot(db, campaignId, { forPlayer: true }).story.clues).toEqual([]);
    expect(dmBriefing()).toContain('[secret] A boot print in the ash');
  });

  it('reveals a found clue and marks the rumour that followed it', async () => {
    const client = await connect();
    const { thread } = await call<{ thread: PlotThread }>(client, {
      op: 'add',
      campaign_id: campaignId,
      title: 'Who set the fire?',
    });
    const rumour = addRumour(db, { campaign_id: campaignId, text: 'The reeve was seen buying lamp oil.' });
    const { clue } = await call<{ clue: Clue }>(client, {
      op: 'plant_clue',
      campaign_id: campaignId,
      text: 'A lamp-oil receipt.',
      thread_id: thread.id,
      hidden: true,
    });

    const found = await call<{ clue: Clue; rumour: Rumour | null }>(client, {
      op: 'find_clue',
      campaign_id: campaignId,
      id: clue.id,
      rumour_id: rumour.id,
    });
    expect(found.clue).toMatchObject({ status: 'found', hidden: false });
    expect(found.rumour?.thread_id).toBe(thread.id);
    expect(campaignSnapshot(db, campaignId, { forPlayer: true }).story.clues).toHaveLength(1);

    const followed = getRumours(db, campaignId, { for_player: true }).find((row) => row.id === rumour.id);
    expect(followed?.followed).toBe(true);
  });
});

describe('the thread tool surface', () => {
  it('advertises thread and none of the four old names', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('thread');
    for (const old of ['add_plot_thread', 'update_plot_thread', 'plant_clue', 'find_clue']) {
      expect(names).not.toContain(old);
    }
  });

  it('lists the four ops in the description', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === 'thread')?.description ?? '';
    for (const op of ['add', 'update', 'plant_clue', 'find_clue']) expect(description).toContain(`op=${op}:`);
  });
});
