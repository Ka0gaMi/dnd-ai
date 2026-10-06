// Fixes reviewed on branch kk/w0-fix-tools: the player rewind reply stays player-safe, and two
// world-tool targets refuse a colliding number or a dead faction without writing anything.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, saveCheckpoint } from '../src/core/campaign.js';
import { importRegion } from '../src/core/region.js';
import { captureCheckpoint, rewindToCheckpoint } from '../src/core/rewind.js';
import { ensureWorld } from '../src/core/world-seed.js';
import { addAttitude } from '../src/core/world-memory.js';
import { currentGameDay, insertFaction, listFactions, updateFaction } from '../src/core/world-store.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { HOST, startHttpServer } from '../src/transport/http.js';

const SECRET = 'w0atoolfixessecret0123456789abcdef';
const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

let db: Db;

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function newCampaign(client: Client, name: string): Promise<number> {
  const created = await client.callTool({ name: 'create_campaign', arguments: { name, story_shape: 'sandbox' } });
  return (created.structuredContent as { campaign_id: number }).campaign_id;
}

const textOf = (result: unknown): string => (result as { content: Array<{ text: string }> }).content[0]!.text;

interface Scene {
  id: number;
  settlements: Array<{ id: number; name: string }>;
  dangers: Array<{ id: number; name: string }>;
}

/** Imports the fixture and seeds the world once, so the tool's requireWorld will not add factions later. */
async function scene(client: Client, name: string, realm: unknown = dangerous): Promise<Scene> {
  const id = await newCampaign(client, name);
  const view = importRegion(db, id, realm, { source: 'generated' });
  ensureWorld(db, id);
  return {
    id,
    settlements: view.places.filter((place) => place.kind === 'settlement'),
    dangers: view.places.filter((place) => place.kind === 'danger'),
  };
}

/** Every living-world row plus the realm rewrites ensureWorld may do, so a refusal can be proven inert. */
function rowSnapshot(campaignId: number): string {
  const tables = [
    'world_faction',
    'world_agenda',
    'world_event',
    'world_packet',
    'world_packet_arrival',
    'world_attitude',
    'world_faith',
  ];
  const parts = tables.map((table) => {
    const sql =
      table === 'world_packet_arrival'
        ? 'SELECT * FROM world_packet_arrival WHERE packet_id IN (SELECT id FROM world_packet WHERE campaign_id = ?) ORDER BY rowid'
        : `SELECT * FROM ${table} WHERE campaign_id = ? ORDER BY rowid`;
    return db.prepare(sql).all(campaignId);
  });
  parts.push(db.prepare('SELECT name, government FROM world_realm WHERE campaign_id = ? ORDER BY id').all(campaignId));
  return JSON.stringify(parts);
}

const count = (campaignId: number, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE campaign_id = ?`).get(campaignId) as { n: number }).n;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('player rewind route', () => {
  it('carries a player-safe briefing while the DM path keeps its own', async () => {
    const campaignId = createCampaign(db, { name: 'Rewind Leak', story_shape: 'sandbox' }).campaign_id;
    const view = importRegion(db, campaignId, safe, { source: 'generated' });
    ensureWorld(db, campaignId);

    // A hidden settlement state and a secret faction both reach the DM briefing and nothing else.
    const settlement = view.places.filter((place) => place.kind === 'settlement')[0]!;
    const today = currentGameDay(db, campaignId);
    db.prepare(
      `INSERT INTO world_place_state (campaign_id, place_id, state, until_day, updated_day)
       VALUES (?, ?, 'besieged', ?, ?)`,
    ).run(campaignId, settlement.id, today + 30, today);
    const secret = insertFaction(db, campaignId, {
      name: 'The Silent Chorus',
      type: 'gang',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'secret',
      resources: 3,
      capacities: {},
      created_day: today,
    });
    addAttitude(db, campaignId, { kind: 'faction', id: secret.id }, { value: 3, reason: 'paid in secret', day: today });

    const saved = saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'The party camps.' });
    captureCheckpoint(db, campaignId, saved.scene.id);

    const started = await startHttpServer(db, { port: 0, secret: SECRET });
    try {
      const base = `http://${HOST}:${started.port}`;
      const res = await fetch(`${base}/api/campaigns/${campaignId}/rewind`, { method: 'POST' });
      expect(res.status).toBe(200);
      const playerJson = JSON.stringify(await res.json());
      expect(playerJson).not.toContain(`${settlement.name} \u2014 besieged`);
      expect(playerJson).not.toContain('The Silent Chorus');
      expect(playerJson).not.toContain('paid in secret');
    } finally {
      await started.close();
    }

    const dm = rewindToCheckpoint(db, campaignId);
    expect(dm.briefing.world_briefing).toContain(`${settlement.name} \u2014 besieged`);
    expect(dm.briefing.world_briefing).toContain('The Silent Chorus');
    expect(dm.briefing.world_briefing).toContain('paid in secret');
  });
});

describe('world destroy with a colliding numeric target', () => {
  it('refuses and changes nothing', async () => {
    const client = await connect();
    const { id, dangers } = await scene(client, 'Destroy Collision');
    const usedIds = new Set(listFactions(db, id, { includeEnded: true }).map((faction) => faction.id));
    const danger = dangers.find((place) => !usedIds.has(place.id))!;
    expect(danger).toBeDefined();

    // Move a fresh faction onto the danger site's id, so one number names both.
    const house = insertFaction(db, id, {
      name: 'Collision House',
      type: 'house',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'open',
      resources: 3,
      capacities: {},
      created_day: currentGameDay(db, id),
    });
    db.prepare('UPDATE world_faction SET id = ? WHERE id = ?').run(danger.id, house.id);

    const before = rowSnapshot(id);
    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id: id, op: 'destroy', target: danger.id },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/both the faction .* and the danger site/);
    expect(textOf(result)).toContain('Collision House');
    expect(rowSnapshot(id)).toBe(before);
    await client.close();
  });
});

describe('world deed against an ended faction', () => {
  it('refuses and writes nothing', async () => {
    const client = await connect();
    const { id } = await scene(client, 'Deed Ended', safe);
    const house = insertFaction(db, id, {
      name: 'Fallen House',
      type: 'house',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'open',
      resources: 3,
      capacities: {},
      created_day: currentGameDay(db, id),
    });
    updateFaction(db, id, house.id, { ended_day: currentGameDay(db, id) });
    const attitudesBefore = count(id, 'world_attitude');
    const entitiesBefore = count(id, 'entity');

    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id: id, op: 'deed', target: 'Fallen House', value: 2, reason: 'a test' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/ended on day/);
    expect(textOf(result)).toContain('Fallen House');
    expect(count(id, 'world_attitude')).toBe(attitudesBefore);
    expect(count(id, 'entity')).toBe(entitiesBefore);
    await client.close();
  });
});
