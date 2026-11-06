import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import { nowState } from '../src/core/calendar.js';
import { openDb, type Db } from '../src/db/connection.js';
import { renderBriefing } from '../src/mcp/tools/campaign.js';
import { registerStoryTools } from '../src/mcp/tools/story.js';
import { replyData } from './helpers/reply.js';

let db: Db;
let campaignId: number;
const STORM = 'a raging purple stormfront';

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Weather', story_shape: 'structured', premise: 'Skies.' }).campaign_id;
});

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'time-weather-test', version: '0.0.0' });
  registerStoryTools(server, db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name: 'time', arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return replyData<T>(result);
}

const briefing = (): string => renderBriefing(campaignSnapshot(db, campaignId));

describe('time{op: weather}', () => {
  it('shows in the reply, the clock and the briefing, and survives an advance within the day', async () => {
    const client = await connect();
    const set = await call<{ weather: string; date_text: string; season: string; time_of_day: string }>(client, {
      op: 'weather',
      campaign_id: campaignId,
      weather: `  ${STORM} `,
    });
    expect(set).toMatchObject({ weather: STORM, season: 'winter', time_of_day: 'morning' });
    expect(nowState(db, campaignId).weather).toBe(STORM);
    expect(briefing()).toContain(STORM);

    const moved = await call<{ weather: string }>(client, { op: 'advance', campaign_id: campaignId, hours: 3 });
    expect(moved.weather).toBe(STORM);
  });

  it('reverts to the rolled weather once the day changes', async () => {
    const client = await connect();
    await call(client, { op: 'weather', campaign_id: campaignId, weather: STORM });
    const moved = await call<{ weather: string }>(client, { op: 'advance', campaign_id: campaignId, hours: 17 });
    expect(moved.weather).not.toBe(STORM);
    expect(nowState(db, campaignId).weather).not.toBe(STORM);
  });

  it('is cleared by set_calendar', async () => {
    const client = await connect();
    await call(client, { op: 'weather', campaign_id: campaignId, weather: STORM });
    const set = await call<{ weather: string }>(client, { op: 'set_calendar', campaign_id: campaignId, hour: 9 });
    expect(set.weather).not.toBe(STORM);
  });

  it('refuses empty text and changes nothing', async () => {
    const client = await connect();
    const before = db.prepare('SELECT calendar_json FROM campaign WHERE id = ?').get(campaignId);
    const events = (): number => (db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n;
    const n = events();
    const result = (await client.callTool({
      name: 'time',
      arguments: { op: 'weather', campaign_id: campaignId, weather: '   ' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/must not be empty/);
    expect(db.prepare('SELECT calendar_json FROM campaign WHERE id = ?').get(campaignId)).toEqual(before);
    expect(events()).toBe(n);
  });
});
