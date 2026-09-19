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

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'time-tool-test', version: '0.0.0' });
  registerStoryTools(server, db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name: 'time', arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result.structuredContent as T;
}

const textOf = (result: CallToolResult): string => (result.content as Array<{ text: string }>)[0]!.text;

const dmBriefing = (): string => renderBriefing(campaignSnapshot(db, campaignId));

describe('time{op: advance} and time{op: set_calendar}', () => {
  it('advances the clock and reports the new day in the briefing', async () => {
    const client = await connect();
    const moved = await call<{ date_text: string; time_of_day: string; season: string; weather: string }>(client, {
      op: 'advance',
      campaign_id: campaignId,
      days: 1,
      hours: 6,
    });
    expect(moved.date_text).toBe('2 Deepfrost, year 1, 14:00');
    expect(moved.time_of_day).toBe('afternoon');
    expect(moved.season).toBe('winter');
    expect(dmBriefing()).toContain('## Now');
    expect(dmBriefing()).toContain(moved.weather);
  });

  it('sets the calendar outright, and the clock then renders it', async () => {
    const client = await connect();
    const set = await call<{
      year: number;
      month: number;
      day: number;
      hour: number;
      minute: number;
      date_text: string;
      time_of_day: string;
      season: string;
      era_name: string | null;
    }>(client, {
      op: 'set_calendar',
      campaign_id: campaignId,
      year: 1042,
      month: 9,
      day: 14,
      hour: 16,
      minute: 30,
      era_name: 'Third Age',
    });
    expect(set).toMatchObject({
      year: 1042,
      month: 9,
      day: 14,
      hour: 16,
      minute: 30,
      season: 'autumn',
      time_of_day: 'afternoon',
      era_name: 'Third Age',
    });
    expect(set.date_text).toBe('14 Harvestmoon, year 1042 (Third Age), 16:30');

    const moved = await call<{ date_text: string; hour: number }>(client, {
      op: 'advance',
      campaign_id: campaignId,
      hours: 1,
    });
    expect(moved.date_text).toBe('14 Harvestmoon, year 1042 (Third Age), 17:30');
    expect(dmBriefing()).toContain('14 Harvestmoon');
  });

  it('rejects an op outside the family and names the two valid ops', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'time',
      arguments: { op: 'jump', campaign_id: campaignId },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/expected one of "advance"\|"set_calendar" at op/);
  });

  it('refuses a field from another op on op=advance', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'time',
      arguments: { op: 'advance', campaign_id: campaignId, year: 1042 },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'year does not apply to op=advance; it takes campaign_id, minutes, hours, days. Re-call without it.',
    );
  });

  it('refuses a field from another op on op=set_calendar', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'time',
      arguments: { op: 'set_calendar', campaign_id: campaignId, minutes: 30 },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      'minutes does not apply to op=set_calendar; it takes campaign_id, year, month, day, hour, minute, month_names, era_name, season_override, hemisphere. Re-call without it.',
    );
  });
});

describe('the time tool surface', () => {
  it('advertises time and rumour, none of the four old names, with a line per op', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('time');
    expect(names).toContain('rumour');
    for (const old of ['add_rumour', 'get_rumours', 'advance_time', 'set_calendar']) {
      expect(names).not.toContain(old);
    }
    const description = tools.find((tool) => tool.name === 'time')!.description ?? '';
    expect(description).toContain('op=advance:');
    expect(description).toContain('op=set_calendar:');
  });
});
