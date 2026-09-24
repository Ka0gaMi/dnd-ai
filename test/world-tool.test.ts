import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { importRegion } from '../src/core/region.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { upsertEntity } from '../src/core/codex.js';
import { attitudeOf } from '../src/core/world-memory.js';
import { addContest, factionFaith, listFaiths, setExcommunicated } from '../src/core/world-faith-store.js';
import { currentGameDay, insertAgenda, listAgendas, listFactions } from '../src/core/world-store.js';

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

const textOf = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content[0]!.text;

interface WorldData {
  factions: Array<{
    id: number;
    name: string;
    type: string;
    secrecy: string;
    resources: number;
    attitude: { total: number; reasons: Array<{ reason: string; value: number; current: number }> };
  }>;
  agendas: Array<{
    id: number;
    faction: string;
    template: string;
    target_name: string;
    clock: string;
    status: string;
    known_to_party: boolean;
    portents: Array<{ text: string; heard: boolean }>;
  }>;
  recent_events: Array<{ day: number; text: string; severity: number; visibility: string }>;
  faiths: Array<{
    id: number;
    name: string;
    aspect: string;
    head: string | null;
    fervor: number;
    heresy_of: string | null;
    branches: Array<{ faction: string; realm: string | null; influence: string | null }>;
  }>;
  contests: Array<{ realm: string; faith: string; filled: number; size: number }>;
  excommunicated: Array<{ realm: string; until_day: number }>;
}

interface DeedData {
  target: { kind: string; id: number; name: string };
  recorded: Array<{ subject_kind: string; subject_id: number; subject_name: string; value: number; reason: string }>;
}

const WORLD_TABLES = [
  'world_state',
  'world_faction',
  'world_agenda',
  'world_event',
  'world_packet',
  'world_packet_arrival',
  'world_attitude',
  'world_visit',
] as const;

const ZERO_WORLD_ROWS: Record<(typeof WORLD_TABLES)[number], number> = {
  world_state: 0,
  world_faction: 0,
  world_agenda: 0,
  world_event: 0,
  world_packet: 0,
  world_packet_arrival: 0,
  world_attitude: 0,
  world_visit: 0,
};

/** Row counts for the living-world tables, so a refused call is proven to have written nothing. */
function worldRowCounts(campaignId: number): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of WORLD_TABLES) {
    const sql =
      table === 'world_packet_arrival'
        ? 'SELECT COUNT(*) AS n FROM world_packet_arrival WHERE packet_id IN (SELECT id FROM world_packet WHERE campaign_id = ?)'
        : `SELECT COUNT(*) AS n FROM ${table} WHERE campaign_id = ?`;
    counts[table] = (db.prepare(sql).get(campaignId) as { n: number }).n;
  }
  return counts;
}

/** ensureWorld rewrites realm government and name, so a refused call must leave them untouched. */
function worldRealmSnapshot(campaignId: number): unknown[] {
  return db.prepare('SELECT name, government FROM world_realm WHERE campaign_id = ? ORDER BY id').all(campaignId);
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('world tool', () => {
  it('is listed', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('world');
    await client.close();
  });

  it('teaches when the campaign has no region map', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'No World');
    const calls = [
      { campaign_id, op: 'get' },
      { campaign_id, op: 'deed', target: 'Anyone', value: 1, reason: 'a test' },
      { campaign_id, op: 'reveal', agenda: 1 },
    ];
    for (const args of calls) {
      const result = await client.callTool({ name: 'world', arguments: args });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('no region map yet');
    }
    await client.close();
  });

  it('lists factions and the active and held agendas', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'World Get');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const result = await client.callTool({ name: 'world', arguments: { campaign_id, op: 'get' } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as unknown as WorldData;

    expect(data.factions.length).toBe(listFactions(db, campaign_id).length);
    expect(data.factions.length).toBeGreaterThan(0);
    expect(data.factions[0]).toMatchObject({
      id: expect.any(Number),
      name: expect.any(String),
      type: expect.any(String),
      secrecy: expect.any(String),
      resources: expect.any(Number),
    });
    expect(data.factions[0]!.attitude.total).toBe(0);

    expect(data.agendas.length).toBeGreaterThan(0);
    expect(data.agendas.every((agenda) => agenda.status === 'active' || agenda.status === 'held')).toBe(true);
    expect(data.agendas[0]!.clock).toMatch(/^\d+\/\d+$/);
    expect(Array.isArray(data.recent_events)).toBe(true);
    expect(textOf(result)).toContain('DM only');
    await client.close();
  });

  it('lists the seeded faith with its branches, a contest and an excommunication', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'World Faiths');
    importRegion(db, campaign_id, dangerous, { source: 'generated' });

    const result = await client.callTool({ name: 'world', arguments: { campaign_id, op: 'get' } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as unknown as WorldData;

    const faiths = listFaiths(db, campaign_id);
    expect(faiths.length).toBeGreaterThan(0);
    expect(data.faiths.length).toBe(faiths.length);

    const temple = listFactions(db, campaign_id).find((faction) => faction.type === 'church')!;
    const link = factionFaith(db, campaign_id, temple.id);
    const realm = db
      .prepare('SELECT id, name FROM world_realm WHERE campaign_id = ?')
      .get(campaign_id) as { id: number; name: string };

    const seeded = data.faiths.find((faith) => faith.id === link.faith_id)!;
    expect(seeded).toMatchObject({
      id: faiths[0]!.id,
      name: faiths[0]!.name,
      aspect: faiths[0]!.aspect,
      fervor: faiths[0]!.fervor,
      heresy_of: null,
    });
    expect(seeded.branches).toContainEqual({
      faction: temple.name,
      realm: realm.name,
      influence: link.influence,
    });
    expect(textOf(result)).toContain('Faiths:');
    expect(textOf(result)).toContain(seeded.name);

    addContest(db, campaign_id, realm.id, seeded.id, 3);
    const until = currentGameDay(db, campaign_id) + 180;
    setExcommunicated(db, campaign_id, realm.id, until);

    const after = await client.callTool({ name: 'world', arguments: { campaign_id, op: 'get' } });
    const contested = after.structuredContent as unknown as WorldData;
    expect(contested.contests).toContainEqual({ realm: realm.name, faith: seeded.name, filled: 3, size: 6 });
    expect(contested.excommunicated).toContainEqual({ realm: realm.name, until_day: until });
    expect(textOf(after)).toContain('Church contests:');
    expect(textOf(after)).toContain('Excommunicated:');
    await client.close();
  });

  it('records a deed and turns a rival against the party at half strength', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'World Deed');
    importRegion(db, campaign_id, safe, { source: 'generated' });
    await client.callTool({ name: 'world', arguments: { campaign_id, op: 'get' } });

    const factions = listFactions(db, campaign_id);
    const target = factions[0]!;
    const rival = factions[1]!;
    insertAgenda(db, campaign_id, {
      faction_id: target.id,
      template: 'trade_monopoly',
      target_kind: 'rival_faction',
      target_id: rival.id,
      target_name: rival.name,
      clock_size: 8,
      clock_filled: 0,
      portents: [],
      status: 'active',
      started_day: currentGameDay(db, campaign_id),
    });

    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id, op: 'deed', target: target.name, value: 3, reason: 'saved their caravan' },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as unknown as DeedData;

    const targetEntry = data.recorded.find((entry) => entry.subject_id === target.id)!;
    expect(targetEntry.subject_kind).toBe('faction');
    expect(targetEntry.value).toBe(3);
    expect(targetEntry.reason).toBe('saved their caravan');

    const rivalEntry = data.recorded.find((entry) => entry.subject_id === rival.id)!;
    expect(rivalEntry.value).toBe(-1);
    expect(rivalEntry.reason).toBe(`saved their caravan (rival of ${target.name})`);

    const today = currentGameDay(db, campaign_id);
    expect(attitudeOf(db, campaign_id, { kind: 'faction', id: target.id }, today).total).toBe(3);
    expect(attitudeOf(db, campaign_id, { kind: 'faction', id: rival.id }, today).total).toBe(-1);
    await client.close();
  });

  it('creates a codex entry only for the target faction, not its rivals', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'World Deed Codex');
    importRegion(db, campaign_id, safe, { source: 'generated' });
    await client.callTool({ name: 'world', arguments: { campaign_id, op: 'get' } });

    const [target, rival] = listFactions(db, campaign_id);
    insertAgenda(db, campaign_id, {
      faction_id: target!.id,
      template: 'trade_monopoly',
      target_kind: 'rival_faction',
      target_id: rival!.id,
      target_name: rival!.name,
      clock_size: 8,
      clock_filled: 0,
      portents: [],
      status: 'active',
      started_day: currentGameDay(db, campaign_id),
    });

    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id, op: 'deed', target: target!.name, value: 3, reason: 'saved their caravan' },
    });
    expect(result.isError).toBeFalsy();

    const stored = new Map(listFactions(db, campaign_id).map((faction) => [faction.id, faction]));
    expect(stored.get(target!.id)!.entity_id).not.toBeNull();
    expect(stored.get(rival!.id)!.entity_id).toBeNull();
    expect(attitudeOf(db, campaign_id, { kind: 'faction', id: rival!.id }, currentGameDay(db, campaign_id)).total).toBe(-1);
    const rivalEntity = db
      .prepare('SELECT id FROM entity WHERE campaign_id = ? AND lower(name) = lower(?)')
      .get(campaign_id, rival!.name);
    expect(rivalEntity).toBeUndefined();
    await client.close();
  });

  it('lets a small favour go unnoticed by the rivals', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'World Small Deed');
    importRegion(db, campaign_id, safe, { source: 'generated' });
    await client.callTool({ name: 'world', arguments: { campaign_id, op: 'get' } });

    const [target, rival] = listFactions(db, campaign_id);
    insertAgenda(db, campaign_id, {
      faction_id: target!.id,
      template: 'trade_monopoly',
      target_kind: 'rival_faction',
      target_id: rival!.id,
      target_name: rival!.name,
      clock_size: 8,
      clock_filled: 0,
      portents: [],
      status: 'active',
      started_day: currentGameDay(db, campaign_id),
    });

    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id, op: 'deed', target: target!.name, value: 1, reason: 'carried a letter' },
    });
    const data = result.structuredContent as unknown as DeedData;
    expect(data.recorded.map((entry) => entry.subject_id)).toEqual([target!.id]);
    await client.close();
  });

  it('refuses a deed of 0 or out of range and writes nothing', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'World Refuse');
    importRegion(db, campaign_id, safe, { source: 'generated' });
    await client.callTool({ name: 'world', arguments: { campaign_id, op: 'get' } });
    const target = listFactions(db, campaign_id)[0]!;

    for (const value of [0, 6, -6]) {
      const result = await client.callTool({
        name: 'world',
        arguments: { campaign_id, op: 'deed', target: target.name, value, reason: 'a test' },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('non-zero integer');
    }

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM world_attitude WHERE campaign_id = ?')
      .get(campaign_id) as { n: number };
    expect(count.n).toBe(0);
    await client.close();
  });

  it('records a deed against a codex entity by name', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'World Entity');
    importRegion(db, campaign_id, safe, { source: 'generated' });
    upsertEntity(db, { campaign_id, kind: 'item', name: 'The Silver Locket' });

    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id, op: 'deed', target: 'The Silver Locket', value: 2, reason: 'returned it' },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as unknown as DeedData;
    expect(data.target.kind).toBe('entity');
    expect(data.recorded).toEqual([
      expect.objectContaining({ subject_kind: 'entity', subject_name: 'The Silver Locket', value: 2, reason: 'returned it' }),
    ]);
    await client.close();
  });

  it('refuses an unknown target', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'World Unknown');
    importRegion(db, campaign_id, safe, { source: 'generated' });

    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id, op: 'deed', target: 'Nobody Here', value: 2, reason: 'a test' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('world {op: get}');
    await client.close();
  });

  it('refuses a deed of 0 without seeding the world', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'World Refuse Zero');
    importRegion(db, campaign_id, safe, { source: 'generated' });
    const realmsBefore = worldRealmSnapshot(campaign_id);

    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id, op: 'deed', target: 'Anyone', value: 0, reason: 'a test' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('non-zero integer');
    expect(worldRowCounts(campaign_id)).toEqual(ZERO_WORLD_ROWS);
    expect(worldRealmSnapshot(campaign_id)).toEqual(realmsBefore);
    await client.close();
  });

  it('refuses a deed with an unknown target without seeding the world', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'World Refuse Unknown');
    importRegion(db, campaign_id, safe, { source: 'generated' });
    const realmsBefore = worldRealmSnapshot(campaign_id);

    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id, op: 'deed', target: 'Nobody Here', value: 2, reason: 'a test' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('world {op: get}');
    expect(worldRowCounts(campaign_id)).toEqual(ZERO_WORLD_ROWS);
    expect(worldRealmSnapshot(campaign_id)).toEqual(realmsBefore);
    await client.close();
  });

  it('refuses an unknown agenda without seeding the world', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'World Refuse Agenda');
    importRegion(db, campaign_id, safe, { source: 'generated' });
    const realmsBefore = worldRealmSnapshot(campaign_id);

    const result = await client.callTool({ name: 'world', arguments: { campaign_id, op: 'reveal', agenda: 999999 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('No agenda 999999');
    expect(worldRowCounts(campaign_id)).toEqual(ZERO_WORLD_ROWS);
    expect(worldRealmSnapshot(campaign_id)).toEqual(realmsBefore);
    await client.close();
  });

  it('reveals an agenda to the party and refuses an unknown one', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'World Reveal');
    importRegion(db, campaign_id, safe, { source: 'generated' });
    await client.callTool({ name: 'world', arguments: { campaign_id, op: 'get' } });

    const agenda = listAgendas(db, campaign_id).find((entry) => entry.status === 'active')!;
    const result = await client.callTool({ name: 'world', arguments: { campaign_id, op: 'reveal', agenda: agenda.id } });
    expect(result.isError).toBeFalsy();
    const summary = (result.structuredContent as unknown as { agenda: { known_to_party: boolean } }).agenda;
    expect(summary.known_to_party).toBe(true);
    expect(listAgendas(db, campaign_id).find((entry) => entry.id === agenda.id)!.known_to_party).toBe(true);

    const missing = await client.callTool({ name: 'world', arguments: { campaign_id, op: 'reveal', agenda: 999999 } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('No agenda 999999');
    await client.close();
  });

  it('serves the world guide', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'read_guide', arguments: { section: 'world' } });
    const guide = result.structuredContent as unknown as { found: boolean; text: string };
    expect(guide.found).toBe(true);
    expect(guide.text).toContain('portents');
    await client.close();
  });
});
