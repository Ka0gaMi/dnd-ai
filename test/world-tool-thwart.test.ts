// The world tool's interfering ops: setback, thwart and destroy, through the MCP surface.
// Factions and agendas are built by hand so the tests do not depend on the seeded fixture names.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { importRegion, type WorldPlace } from '../src/core/region.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { ensureWorld } from '../src/core/world-seed.js';
import {
  currentGameDay,
  insertAgenda,
  insertFaction,
  listAgendas,
  listFactions,
  type WorldAgenda,
  type WorldFaction,
} from '../src/core/world-store.js';

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
  settlements: WorldPlace[];
  dangers: WorldPlace[];
}

/** Imports the fixture and seeds the world once, so the tool's requireWorld will not add factions later. */
async function scene(client: Client, name: string): Promise<Scene> {
  const id = await newCampaign(client, name);
  const view = importRegion(db, id, dangerous, { source: 'generated' });
  ensureWorld(db, id);
  return {
    id,
    settlements: view.places.filter((place) => place.kind === 'settlement'),
    dangers: view.places.filter((place) => place.kind === 'danger'),
  };
}

let seq = 0;

function faction(campaignId: number, extra: Partial<Omit<WorldFaction, 'id'>> = {}): WorldFaction {
  seq += 1;
  return insertFaction(db, campaignId, {
    name: `Tool Faction ${seq}`,
    type: 'house',
    realm_id: null,
    county_id: null,
    place_id: null,
    secrecy: 'open',
    resources: 3,
    capacities: {},
    created_day: currentGameDay(db, campaignId),
    ...extra,
  });
}

function agenda(campaignId: number, f: WorldFaction, extra: Partial<Omit<WorldAgenda, 'id'>> = {}): WorldAgenda {
  return insertAgenda(db, campaignId, {
    faction_id: f.id,
    template: 'raid',
    target_kind: 'settlement',
    target_id: f.place_id,
    target_name: 'the target',
    clock_size: 6,
    clock_filled: 3,
    portents: [{ text: 'Smoke rises on the hills.', fired_day: null, heard: false }],
    status: 'active',
    started_day: currentGameDay(db, campaignId),
    ...extra,
  });
}

const agendaOf = (campaignId: number, id: number): WorldAgenda =>
  listAgendas(db, campaignId).find((entry) => entry.id === id)!;

const factionOf = (campaignId: number, id: number): WorldFaction =>
  listFactions(db, campaignId, { includeEnded: true }).find((entry) => entry.id === id)!;

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

beforeEach(() => {
  db = openDb(':memory:');
});

describe('world tool thwart ops', () => {
  it('setback lowers the clock through the tool', async () => {
    const client = await connect();
    const { id, settlements } = await scene(client, 'World Setback');
    const house = faction(id, { place_id: settlements[0]!.id });
    const plot = agenda(id, house, { clock_filled: 3 });

    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id: id, op: 'setback', agenda: plot.id, amount: 2, reason: 'burned the siege engines' },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('set back');
    expect(agendaOf(id, plot.id)).toMatchObject({ clock_filled: 1, status: 'active' });
    await client.close();
  });

  it('thwart marks the agenda lost, spends a resource and starts the 30-day cooldown', async () => {
    const client = await connect();
    const { id, settlements } = await scene(client, 'World Thwart');
    const house = faction(id, { place_id: settlements[0]!.id, resources: 3 });
    const plot = agenda(id, house);

    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id: id, op: 'thwart', agenda: plot.id, reason: 'exposed the plot' },
    });

    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      agenda: { status: string };
      faction: { resources: number };
      cooldown_until: number;
    };
    const today = currentGameDay(db, id);
    expect(data.cooldown_until).toBe(today + 30);
    expect(data.faction.resources).toBe(2);
    expect(agendaOf(id, plot.id)).toMatchObject({ status: 'lost', resolved_day: today });
    expect(factionOf(id, house.id).resources).toBe(2);
    await client.close();
  });

  it('destroy by faction id ends the faction and abandons its agendas', async () => {
    const client = await connect();
    const { id, settlements } = await scene(client, 'World Destroy Faction');
    const house = faction(id, { name: 'Tool House', place_id: settlements[0]!.id });
    const plot = agenda(id, house);

    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id: id, op: 'destroy', target: house.id, reason: 'toppled its lord' },
    });

    expect(result.isError).toBeFalsy();
    expect(factionOf(id, house.id).ended_day).toBe(currentGameDay(db, id));
    expect(agendaOf(id, plot.id).status).toBe('abandoned');
    expect(listFactions(db, id).map((entry) => entry.id)).not.toContain(house.id);
    await client.close();
  });

  it('destroy by a danger name clears every brood at that lair and leaves others', async () => {
    const client = await connect();
    const { id, dangers } = await scene(client, 'World Destroy Danger');
    const [lair, other] = dangers;
    const brood = faction(id, { name: 'Tool Brood Alpha', type: 'monsters', place_id: lair!.id });
    const elsewhere = faction(id, { name: 'Tool Brood Beta', type: 'monsters', place_id: other!.id });
    const raid = agenda(id, brood);

    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id: id, op: 'destroy', target: lair!.name },
    });

    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      danger: { id: number; name: string };
      destroyed: Array<{ id: number; name: string }>;
    };
    expect(data.danger).toEqual({ id: lair!.id, name: lair!.name });
    expect(data.destroyed.map((entry) => entry.name)).toContain('Tool Brood Alpha');
    expect(factionOf(id, brood.id).ended_day).not.toBeNull();
    expect(factionOf(id, elsewhere.id).ended_day).toBeNull();
    expect(agendaOf(id, raid.id).status).toBe('abandoned');
    await client.close();
  });

  it('refuses a bad amount, an unknown agenda, a missing reason and an unknown target, changing nothing', async () => {
    const client = await connect();
    const { id, settlements } = await scene(client, 'World Thwart Refuse');
    const house = faction(id, { place_id: settlements[0]!.id });
    const plot = agenda(id, house);

    const cases: Array<{ args: Record<string, unknown>; message: RegExp }> = [
      { args: { op: 'setback', agenda: plot.id, amount: 0, reason: 'a test' }, message: /1 to 3/ },
      { args: { op: 'setback', agenda: plot.id, amount: 4, reason: 'a test' }, message: /1 to 3/ },
      { args: { op: 'setback', agenda: 999999, amount: 1, reason: 'a test' }, message: /No agenda 999999/ },
      { args: { op: 'thwart', agenda: plot.id }, message: /Missing reason/ },
      { args: { op: 'destroy', target: house.id }, message: /needs a reason/ },
      { args: { op: 'destroy', target: 'NoSuchPlaceZzz' }, message: /danger site/ },
    ];

    for (const { args, message } of cases) {
      const before = rowSnapshot(id);
      const result = await client.callTool({ name: 'world', arguments: { campaign_id: id, ...args } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(message);
      expect(rowSnapshot(id)).toBe(before);
    }

    expect(agendaOf(id, plot.id)).toMatchObject({ clock_filled: 3, status: 'active' });
    await client.close();
  });
});
