// checkpoint {op: move}: the party's location changes mid-scene, so the window header and the briefing follow
// without the scene closing, world memory hears of it, and a rewind puts it back.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, type GameEvent } from '../src/core/bus.js';
import { campaignSnapshot } from '../src/core/campaign.js';
import { findPlace, importRegion } from '../src/core/region.js';
import { rewindToCheckpoint } from '../src/core/rewind.js';
import { lastVisit } from '../src/core/world-memory.js';
import { currentGameDay } from '../src/core/world-store.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { replyData } from './helpers/reply.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;

let db: Db;

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return replyData<T>(result);
}

const textOf = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0]!.text;

async function makeCampaign(client: Client, region = false): Promise<number> {
  const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
    name: 'On the Move',
    story_shape: 'sandbox',
  });
  if (region) importRegion(db, campaign_id, safe, { source: 'generated' });
  return campaign_id;
}

const save = (client: Client, campaign_id: number, extra: Record<string, unknown> = {}) =>
  call<{ scene: { id: number; location: string | null } }>(client, 'checkpoint', {
    op: 'save',
    campaign_id,
    scene_summary: 'They took rooms for the night.',
    ...extra,
  });

const move = <T = Record<string, unknown>>(client: Client, campaign_id: number, scene_location: string) =>
  call<T>(client, 'checkpoint', { op: 'move', campaign_id, scene_location });

const currentSceneId = (campaignId: number): number | null =>
  (db.prepare('SELECT current_scene_id AS id FROM campaign WHERE id = ?').get(campaignId) as { id: number | null }).id;

/** Every row the move could touch, to prove a call wrote nothing. */
const state = (campaignId: number) => ({
  campaign: db.prepare('SELECT * FROM campaign WHERE id = ?').get(campaignId),
  sessions: db.prepare('SELECT * FROM session WHERE campaign_id = ? ORDER BY id').all(campaignId),
  scenes: db.prepare('SELECT * FROM scene WHERE campaign_id = ? ORDER BY id').all(campaignId),
  events: db.prepare('SELECT id FROM event WHERE campaign_id = ? ORDER BY id').all(campaignId),
  visits: db.prepare('SELECT * FROM world_visit WHERE campaign_id = ? ORDER BY place_id').all(campaignId),
});

const placeId = (campaignId: number, name: string): number => findPlace(db, campaignId, name)!.id;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('checkpoint {op: move}', () => {
  it('moves the header and the briefing to the new place without closing the scene', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client, true);
    await save(client, campaign_id, { scene_location: 'Stormcourtby' });
    const sceneId = currentSceneId(campaign_id);
    const published: GameEvent[] = [];
    const stop = bus.subscribe((event) => published.push(event));

    const moved = await move(client, campaign_id, 'Redham');
    stop();

    expect(moved).toEqual({ campaign_id, moved: true, from: 'Stormcourtby', to: 'Redham', scene_id: sceneId });
    expect(currentSceneId(campaign_id)).toBe(sceneId);
    expect(db.prepare('SELECT ended_at FROM scene WHERE id = ?').get(sceneId)).toEqual({ ended_at: null });
    // The window's header reads the player snapshot's current scene.
    const player = campaignSnapshot(db, campaign_id, { forPlayer: true });
    expect(player.current_scene?.location_name).toBe('Redham');
    // Auto-reveal follows the move with Redham's codex events, so the move is no longer the last one.
    expect(player.recent_events.find((event) => event.kind === 'party_moved')).toMatchObject({
      text: 'The party moved from Stormcourtby to Redham.',
    });
    expect(player.recent_events.some((event) => event.text.includes('rules Redham'))).toBe(true);
    expect(published.map((event) => event.kind)).toContain('party_moved');
    expect(campaignSnapshot(db, campaign_id).region_briefing).toContain('Party is at: Redham');
    const loaded = await client.callTool({ name: 'load_campaign', arguments: { campaign_id } });
    expect(textOf(loaded)).toContain('Party is at: Redham');
    await client.close();
  });

  it('tells world memory the party left, as a save would', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client, true);
    await save(client, campaign_id, { scene_location: 'Stormcourtby' });
    const stormcourtby = placeId(campaign_id, 'Stormcourtby');
    expect(lastVisit(db, campaign_id, stormcourtby)).toBeNull();

    await move(client, campaign_id, 'Redham');

    expect(lastVisit(db, campaign_id, stormcourtby)).toBe(currentGameDay(db, campaign_id));
    await client.close();
  });

  it('is a no-op that says so when the party is already there', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client, true);
    await save(client, campaign_id, { scene_location: 'Stormcourtby' });
    const before = state(campaign_id);

    const same = await move(client, campaign_id, ' stormcourtby ');

    expect(same).toEqual({
      campaign_id,
      moved: false,
      location: 'Stormcourtby',
      note: 'The party is already at Stormcourtby; nothing changed.',
    });
    expect(state(campaign_id)).toEqual(before);
    await client.close();
  });

  it('refuses a blank place and changes nothing', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);
    await save(client, campaign_id, { scene_location: 'The Gilded Goose' });
    const before = state(campaign_id);

    const blank = await client.callTool({ name: 'checkpoint', arguments: { op: 'move', campaign_id, scene_location: '  ' } });
    expect(blank.isError).toBe(true);
    expect(textOf(blank)).toBe(
      'Missing scene_location (it was blank). Re-call checkpoint {op: move} with the place the party is now.',
    );
    const absent = await client.callTool({ name: 'checkpoint', arguments: { op: 'move', campaign_id } });
    expect(absent.isError).toBe(true);
    expect(textOf(absent)).toContain('Missing scene_location for op=move');
    expect(state(campaign_id)).toEqual(before);
    await client.close();
  });

  it('opens a scene after end_session, and that scene survives the next end_session', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);
    await save(client, campaign_id, { scene_location: 'The Gilded Goose' });
    await call(client, 'checkpoint', { op: 'end_session', campaign_id });
    expect(currentSceneId(campaign_id)).toBeNull();

    const moved = await move<{ from: string; scene_id: number }>(client, campaign_id, 'The mill');

    expect(moved.from).toBe('The Gilded Goose');
    expect(currentSceneId(campaign_id)).toBe(moved.scene_id);
    const snapshot = campaignSnapshot(db, campaign_id, { forPlayer: true });
    expect(snapshot.session.number).toBe(2);
    expect(snapshot.current_scene).toMatchObject({ id: moved.scene_id, location_name: 'The mill' });

    await call(client, 'checkpoint', { op: 'end_session', campaign_id });
    expect(db.prepare('SELECT location_name, ended_at IS NOT NULL AS closed FROM scene WHERE id = ?').get(moved.scene_id)).toEqual({
      location_name: 'The mill',
      closed: 1,
    });
    await client.close();
  });

  it('is put back by a rewind to the last save', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client, true);
    await save(client, campaign_id, { scene_location: 'Stormcourtby' });
    await move(client, campaign_id, 'Redham');

    const rewound = rewindToCheckpoint(db, campaign_id, { forPlayer: true });

    expect(rewound.briefing.current_scene?.location_name).toBe('Stormcourtby');
    expect(campaignSnapshot(db, campaign_id).region_briefing).toContain('Party is at: Stormcourtby');
    expect(lastVisit(db, campaign_id, placeId(campaign_id, 'Stormcourtby'))).toBeNull();
    expect(
      db.prepare("SELECT reverted FROM event WHERE campaign_id = ? AND kind = 'party_moved'").all(campaign_id),
    ).toEqual([{ reverted: 1 }]);
    await client.close();
  });

  it('is put back by a rewind when it opened a scene after end_session', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);
    await save(client, campaign_id, { scene_location: 'The Gilded Goose' });
    await call(client, 'checkpoint', { op: 'end_session', campaign_id });
    const moved = await move<{ scene_id: number }>(client, campaign_id, 'The mill');

    rewindToCheckpoint(db, campaign_id);

    expect(db.prepare('SELECT 1 FROM scene WHERE id = ?').get(moved.scene_id)).toBeUndefined();
    expect(campaignSnapshot(db, campaign_id).current_scene?.location_name).toBe('The Gilded Goose');
    await client.close();
  });

  it('carries into the next save that names no place', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);
    await save(client, campaign_id, { scene_location: 'The Gilded Goose' });
    await move(client, campaign_id, 'The mill');

    const saved = await save(client, campaign_id, { scene_summary: 'They found the miller hiding.' });

    expect(saved.scene.location).toBe('The mill');
    expect(campaignSnapshot(db, campaign_id, { forPlayer: true }).current_scene?.location_name).toBe('The mill');
    await client.close();
  });

  it('is listed on the checkpoint tool', async () => {
    const client = await connect();
    const checkpoint = (await client.listTools()).tools.find((tool) => tool.name === 'checkpoint')!;
    expect(checkpoint.description).toContain(
      '\nop=move: Say where the party is now without closing the scene. Requires scene_location.',
    );
    await client.close();
  });
});
