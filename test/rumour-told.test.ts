import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bus, type GameEvent } from '../src/core/bus.js';
import { createCampaign } from '../src/core/campaign.js';
import type { Rumour } from '../src/core/story.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { HOST, startHttpServer } from '../src/transport/http.js';
import { replyData, replyText } from './helpers/reply.js';

let db: Db;
let client: Client;
let base: string;
let stop: () => Promise<void>;
let campaignId: number;

beforeAll(async () => {
  db = openDb(':memory:');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'rumour-told-test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  const started = await startHttpServer(db, { port: 0, secret: 'rumourtold0123456789abcdef012345' });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await client.close();
  await stop();
});

beforeEach(() => {
  campaignId = createCampaign(db, { name: 'The Ashfall Road', story_shape: 'sandbox' }).campaign_id;
});

const rumour = async (args: Record<string, unknown>) =>
  client.callTool({ name: 'rumour', arguments: { campaign_id: campaignId, ...args } });

async function add(text: string, truth: 'true' | 'false' | 'twisted' = 'true'): Promise<Rumour> {
  return replyData<{ rumour: Rumour }>(await rumour({ op: 'add', text, truth })).rumour;
}

/** The player window's Heard list, read from the route it fetches. */
const windowHeard = async (): Promise<Array<Record<string, unknown>>> =>
  (await fetch(`${base}/api/campaigns/${campaignId}/rumours`)).json() as Promise<Array<Record<string, unknown>>>;

/** The briefing's Heard section, up to the next heading. */
async function briefingHeard(): Promise<string> {
  const text = replyText(await client.callTool({ name: 'load_campaign', arguments: { campaign_id: campaignId } }));
  return text.split('## Heard')[1]!.split('\n## ')[0]!;
}

/** Runs body while recording the bus events this campaign publishes to the window. */
async function published(body: () => Promise<unknown>): Promise<GameEvent[]> {
  const seen: GameEvent[] = [];
  const off = bus.subscribe((event) => {
    if (event.campaign_id === campaignId) seen.push(event);
  });
  try {
    await body();
  } finally {
    off();
  }
  return seen;
}

const heardAt = (id: number): string | null =>
  (db.prepare('SELECT heard_at FROM rumour WHERE id = ?').get(id) as { heard_at: string | null }).heard_at;

describe('rumour {op: get}', () => {
  it('lists candidates, unheard first, and marks nothing heard', async () => {
    const mill = await add('The mill is haunted.', 'twisted');
    const road = await add('The road is closed.');

    let listed: Rumour[] = [];
    const events = await published(async () => {
      listed = replyData<{ rumours: Rumour[] }>(await rumour({ op: 'get' })).rumours;
    });

    expect(listed.map((r) => r.id)).toEqual([mill.id, road.id]);
    expect(listed.every((r) => r.heard_at === null)).toBe(true);
    expect(events).toEqual([]);
    expect([heardAt(mill.id), heardAt(road.id)]).toEqual([null, null]);
    expect(await windowHeard()).toEqual([]);
    expect(await briefingHeard()).toContain('None.');
  });
});

describe('rumour {op: tell}', () => {
  it('marks exactly the told ids heard, and the window and the briefing see only those', async () => {
    const mill = await add('The mill is haunted.', 'twisted');
    const road = await add('The road is closed.');
    await rumour({ op: 'get' });

    let told: Rumour[] = [];
    const events = await published(async () => {
      told = replyData<{ rumours: Rumour[] }>(await rumour({ op: 'tell', ids: [mill.id] })).rumours;
    });

    expect(told.map((r) => r.id)).toEqual([mill.id]);
    expect(told[0]!.heard_at).not.toBeNull();
    expect(heardAt(road.id)).toBeNull();
    expect(events.map((e) => [e.kind, e.text])).toEqual([['story', 'Rumour heard: The mill is haunted.']]);
    expect(events[0]!.payload).toEqual({ rumour_id: mill.id, thread_id: null });

    const heard = await windowHeard();
    expect(heard.map((r) => r.id)).toEqual([mill.id]);
    expect(heard[0]).not.toHaveProperty('truth');
    const section = await briefingHeard();
    expect(section).toContain(`The mill is haunted. (twisted, id ${mill.id})`);
    expect(section).not.toContain('The road is closed.');
  });

  it('refuses an unknown id, naming the retry, and marks none of the others', async () => {
    const mill = await add('The mill is haunted.');
    let result: Awaited<ReturnType<typeof rumour>> | undefined;
    const events = await published(async () => {
      result = await rumour({ op: 'tell', ids: [mill.id, 9999] });
    });

    expect(result!.isError).toBe(true);
    expect(replyText(result)).toBe(
      `No rumour 9999 in campaign ${campaignId}. Nothing was marked heard; re-call rumour {op: tell} with ids from rumour {op: get}.`,
    );
    expect(heardAt(mill.id)).toBeNull();
    expect(events).toEqual([]);
  });

  it('refuses an already-heard id, naming the retry, and marks none of the others', async () => {
    const mill = await add('The mill is haunted.');
    const road = await add('The road is closed.');
    await rumour({ op: 'tell', ids: [mill.id] });
    const stamp = heardAt(mill.id);

    let result: Awaited<ReturnType<typeof rumour>> | undefined;
    const events = await published(async () => {
      result = await rumour({ op: 'tell', ids: [road.id, mill.id] });
    });

    expect(result!.isError).toBe(true);
    expect(replyText(result)).toBe(
      `Already heard: rumour ${mill.id}. Nothing was marked heard; re-call rumour {op: tell} without it.`,
    );
    expect(heardAt(road.id)).toBeNull();
    expect(heardAt(mill.id)).toBe(stamp);
    expect(events).toEqual([]);
  });

  it('refuses another campaign\'s rumour as unknown', async () => {
    const elsewhere = await add('The baron is dead.');
    campaignId = createCampaign(db, { name: 'Another Road', story_shape: 'sandbox' }).campaign_id;
    const result = await rumour({ op: 'tell', ids: [elsewhere.id] });
    expect(result.isError).toBe(true);
    expect(replyText(result)).toMatch(/^No rumour/);
    expect(heardAt(elsewhere.id)).toBeNull();
  });
});

describe('rumour {op: get, heard: true}', () => {
  it('lists only the heard rumours, including ones an older server already marked heard', async () => {
    const mill = await add('The mill is haunted.');
    const road = await add('The road is closed.');
    const baron = await add('The baron is dead.');
    await rumour({ op: 'tell', ids: [mill.id] });
    // A campaign saved while get still marked rumours heard keeps them heard.
    db.prepare('UPDATE rumour SET heard_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', baron.id);

    const heard = replyData<{ rumours: Rumour[] }>(await rumour({ op: 'get', heard: true, limit: 20 })).rumours;
    expect(heard.map((r) => r.id)).toEqual([mill.id, baron.id]);
    expect(heard.map((r) => r.truth)).toEqual(['true', 'true']);

    expect((await windowHeard()).map((r) => r.id)).toEqual([mill.id, baron.id]);
    expect(heardAt(road.id)).toBeNull();
  });
});
