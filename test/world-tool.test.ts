import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { importRegion } from '../src/core/region.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { upsertEntity } from '../src/core/codex.js';
import { attitudeOf } from '../src/core/world-memory.js';
import { addContest, factionFaith, listFaiths, setExcommunicated } from '../src/core/world-faith-store.js';
import { currentGameDay, insertAgenda, listAgendas, listEvents, listFactions } from '../src/core/world-store.js';
import { replyData } from './helpers/reply.js';

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
  return replyData<{ campaign_id: number }>(created).campaign_id;
}

const textOf = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content[0]!.text;

/** The item lines under a section title of a reply text, up to the first line that is not an item. */
function section(text: string, title: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf(title);
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && !line.startsWith('- '));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** The "name: +3 reason; now band (+3)" lines a deed reply records, one per subject. */
const deedLines = (text: string): string[] => text.split('\n').filter((line) => /: [+-]\d+ .*; now .+ \([+-]?\d+\)$/.test(line));

/** What a deed stored, in order, so the recorded subjects can be checked without the reply's JSON. */
function attitudeRows(campaignId: number): Array<{ subject_kind: string; subject_id: number; value: number; reason: string }> {
  return db
    .prepare('SELECT subject_kind, subject_id, value, reason FROM world_attitude WHERE campaign_id = ? ORDER BY id')
    .all(campaignId) as Array<{ subject_kind: string; subject_id: number; value: number; reason: string }>;
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
    const text = textOf(result);
    const factions = section(text, 'Factions:');

    expect(factions.length).toBe(listFactions(db, campaign_id).length);
    expect(factions.length).toBeGreaterThan(0);
    // id, name, type, secrecy and resources.
    expect(factions[0]).toMatch(/^- #\d+ .+ \([^,()]+, [^,()]+, resources \d+[,)]/);
    // A zero attitude is never listed, so a faction the party has not touched carries none.
    expect(factions[0]).not.toMatch(/\): .+ \([+-]?\d+\)/);

    const agendas = section(text, 'Agendas (ids for reveal, setback, thwart):');
    expect(agendas.length).toBeGreaterThan(0);
    const stored = listAgendas(db, campaign_id);
    for (const line of agendas) {
      const id = Number(/^- #(\d+) /.exec(line)![1]);
      expect(['active', 'held']).toContain(stored.find((agenda) => agenda.id === id)!.status);
    }
    expect(agendas[0]).toMatch(/ \[\d+\/\d+\][ ;]/);
    // The recent-events section is there whenever the last 30 days hold a non-portent event.
    const today = currentGameDay(db, campaign_id);
    const recent = listEvents(db, campaign_id, { fromDay: today - 30 }).filter((event) => event.kind !== 'portent');
    expect(text.includes('Recent world events:')).toBe(recent.length > 0);
    expect(text).toContain('DM only');
    await client.close();
  });

  it('lists the seeded faith with its branches, a contest and an excommunication', async () => {
    const client = await connect();
    const campaign_id = await newCampaign(client, 'World Faiths');
    importRegion(db, campaign_id, dangerous, { source: 'generated' });

    const result = await client.callTool({ name: 'world', arguments: { campaign_id, op: 'get' } });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);

    const faiths = listFaiths(db, campaign_id);
    expect(faiths.length).toBeGreaterThan(0);
    expect(section(text, 'Faiths:').length).toBe(faiths.length);

    const temple = listFactions(db, campaign_id).find((faction) => faction.type === 'church')!;
    const link = factionFaith(db, campaign_id, temple.id);
    const realm = db
      .prepare('SELECT id, name FROM world_realm WHERE campaign_id = ?')
      .get(campaign_id) as { id: number; name: string };

    // The text carries no faith id or aspect, so the temple's faith is matched to the seeded one in the store.
    expect(link.faith_id).toBe(faiths[0]!.id);
    const seeded = faiths[0]!;
    const line = section(text, 'Faiths:').find((entry) => entry.startsWith(`- ${seeded.name} (`))!;
    expect(line).toContain(`(fervor ${seeded.fervor}, `);
    expect(line).not.toContain('heresy of');
    expect(line).toContain(`${temple.name} holds ${link.influence} sway in ${realm.name}`);
    expect(text).toContain('Faiths:');
    expect(text).toContain(seeded.name);

    addContest(db, campaign_id, realm.id, seeded.id, 3);
    const until = currentGameDay(db, campaign_id) + 180;
    setExcommunicated(db, campaign_id, realm.id, until);

    const after = await client.callTool({ name: 'world', arguments: { campaign_id, op: 'get' } });
    expect(section(textOf(after), 'Church contests:')).toContain(`- ${realm.name}: ${seeded.name} at 3/6`);
    expect(section(textOf(after), 'Excommunicated:')).toContain(`- ${realm.name} until day ${until}`);
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
    // The seeded world rolls its own agendas, and a seeded rivalry would add a second rival line at random.
    db.prepare("UPDATE world_agenda SET status = 'lost' WHERE campaign_id = ? AND target_kind = 'rival_faction'").run(campaign_id);
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
    const lines = deedLines(textOf(result));

    expect(lines.filter((line) => line.startsWith(`${target.name}: +3 saved their caravan; now `))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith(`${rival.name}: -1 saved their caravan (rival of ${target.name}); now `))).toHaveLength(1);
    // The text names subjects; their kind and ids are what the deed stored.
    expect(attitudeRows(campaign_id)).toEqual([
      { subject_kind: 'faction', subject_id: target.id, value: 3, reason: 'saved their caravan' },
      { subject_kind: 'faction', subject_id: rival.id, value: -1, reason: `saved their caravan (rival of ${target.name})` },
    ]);

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
    expect(deedLines(textOf(result)).map((line) => line.slice(0, line.indexOf(': ')))).toEqual([target!.name]);
    expect(attitudeRows(campaign_id).map((row) => row.subject_id)).toEqual([target!.id]);
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
    const lines = deedLines(textOf(result));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^The Silver Locket: \+2 returned it; now /);
    // The text names the subject; its kind is what the deed stored.
    expect(attitudeRows(campaign_id)).toEqual([expect.objectContaining({ subject_kind: 'entity', value: 2, reason: 'returned it' })]);
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
    expect(textOf(result)).toContain(`is now known to the party (clock ${agenda.clock_filled}/${agenda.clock_size}).`);
    expect(listAgendas(db, campaign_id).find((entry) => entry.id === agenda.id)!.known_to_party).toBe(true);

    const missing = await client.callTool({ name: 'world', arguments: { campaign_id, op: 'reveal', agenda: 999999 } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('No agenda 999999');
    await client.close();
  });

  it('serves the world guide', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'read_guide', arguments: { section: 'world' } });
    // A missing page answers with "No guide page", so its absence says the page was found.
    expect(textOf(result)).not.toContain('No guide page');
    expect(textOf(result)).toContain('portents');
    await client.close();
  });
});
