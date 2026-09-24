// Factions the party comes to know gain a player-safe codex entry: never secret, never naming a
// danger site, and never overwriting what the DM already wrote.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { upsertEntity } from '../src/core/codex.js';
import { firePortent, deliverWorldNews } from '../src/core/world-resolve.js';
import { ensureFactionEntity, linkKnownFactions } from '../src/core/world-codex.js';
import { placeDistance } from '../src/core/region-graph.js';
import { findPlace, getRegion, importRegion, type RegionView, type WorldPlace } from '../src/core/region.js';
import { ensureWorld } from '../src/core/world-seed.js';
import { insertAgenda, listFactions, updateFaction } from '../src/core/world-store.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function withWorld(realm: unknown): number {
  const campaignId = createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured' }).campaign_id;
  importRegion(db, campaignId, realm, { source: 'generated' });
  ensureWorld(db, campaignId);
  return campaignId;
}

function entityWithName(campaignId: number, name: string) {
  return db
    .prepare('SELECT id, kind, summary FROM entity WHERE campaign_id = ? AND lower(name) = lower(?)')
    .get(campaignId, name) as { id: number; kind: string; summary: string } | undefined;
}

function entityCount(campaignId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM entity WHERE campaign_id = ?').get(campaignId) as { n: number }).n;
}

function nearest(view: RegionView, place: WorldPlace): WorldPlace | undefined {
  let best: WorldPlace | undefined;
  let bestDistance = Infinity;
  for (const settlement of view.places) {
    if (settlement.kind !== 'settlement') continue;
    const distance = placeDistance(place, settlement);
    if (distance < bestDistance) {
      best = settlement;
      bestDistance = distance;
    }
  }
  return best;
}

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('ensureFactionEntity', () => {
  it('creates a faction entry with its summary and arms, and links it', () => {
    const campaignId = withWorld(safe);
    const faction = listFactions(db, campaignId).find((entry) => entry.type === 'house')!;

    const entityId = ensureFactionEntity(db, campaignId, faction);
    expect(entityId).not.toBeNull();

    const entity = entityWithName(campaignId, faction.name)!;
    expect(entity.kind).toBe('faction');
    expect(entity.summary).toContain('A noble house seated at');
    expect(entity.summary).toContain('Arms:');
    expect(listFactions(db, campaignId).find((entry) => entry.id === faction.id)!.entity_id).toBe(entity.id);
  });

  it('creates one entry when called twice with the same faction', () => {
    const campaignId = withWorld(safe);
    const faction = listFactions(db, campaignId).find((entry) => entry.type === 'guild')!;

    const first = ensureFactionEntity(db, campaignId, faction);
    const second = ensureFactionEntity(db, campaignId, faction);
    expect(second).toBe(first);
    expect(entityCount(campaignId)).toBe(1);
  });

  it('returns null and writes nothing for a secret faction', () => {
    const campaignId = withWorld(safe);
    const faction = listFactions(db, campaignId).find((entry) => entry.type === 'house')!;
    const secret = updateFaction(db, campaignId, faction.id, { secrecy: 'secret' });

    expect(ensureFactionEntity(db, campaignId, secret)).toBeNull();
    expect(entityWithName(campaignId, faction.name)).toBeUndefined();
    expect(entityCount(campaignId)).toBe(0);
  });

  it('names a monster brood by its nearest town and never by its lair', () => {
    const campaignId = withWorld(dangerous);
    const monster = listFactions(db, campaignId).find((entry) => entry.type === 'monsters')!;
    const view = getRegion(db, campaignId)!;
    const lair = view.places.find((place) => place.id === monster.place_id)!;
    const town = nearest(view, lair)!;

    const entityId = ensureFactionEntity(db, campaignId, monster);
    const entity = db.prepare('SELECT name, summary FROM entity WHERE id = ?').get(entityId) as {
      name: string;
      summary: string;
    };

    expect(entity.name).toBe(`The brood near ${town.name}`);
    expect(entity.summary).toContain('Something dangerous lairs in the wilds near');
    for (const danger of view.places.filter((place) => place.kind === 'danger')) {
      expect(entity.name).not.toContain(danger.name);
      expect(entity.summary).not.toContain(danger.name);
    }
  });

  it('links a DM-written faction entity without overwriting its summary', () => {
    const campaignId = withWorld(safe);
    const faction = listFactions(db, campaignId).find((entry) => entry.type === 'house')!;
    const written = upsertEntity(db, {
      campaign_id: campaignId,
      kind: 'faction',
      name: faction.name,
      summary: 'The DM already wrote this house.',
    });

    expect(ensureFactionEntity(db, campaignId, faction)).toBe(written.entity.id);
    expect(entityWithName(campaignId, faction.name)!.summary).toBe('The DM already wrote this house.');
    expect(listFactions(db, campaignId).find((entry) => entry.id === faction.id)!.entity_id).toBe(written.entity.id);
  });

  it('refuses a same-named non-faction entity and links nothing', () => {
    const campaignId = withWorld(safe);
    const faction = listFactions(db, campaignId).find((entry) => entry.type === 'house')!;
    upsertEntity(db, { campaign_id: campaignId, kind: 'place', name: faction.name, summary: 'A place, not a faction.' });

    expect(ensureFactionEntity(db, campaignId, faction)).toBeNull();
    expect(listFactions(db, campaignId).find((entry) => entry.id === faction.id)!.entity_id).toBeNull();
  });
});

describe('linkKnownFactions', () => {
  it('links a faction entity the reveal flow already added', () => {
    const campaignId = withWorld(safe);
    const realm = listFactions(db, campaignId).find((entry) => entry.type === 'realm')!;
    const written = upsertEntity(db, {
      campaign_id: campaignId,
      kind: 'faction',
      name: realm.name,
      summary: 'The realm the reveal flow added.',
    });

    linkKnownFactions(db, campaignId);
    expect(listFactions(db, campaignId).find((entry) => entry.id === realm.id)!.entity_id).toBe(written.entity.id);
  });
});

describe('world tool hooks', () => {
  it('creates a faction codex entry from a deed against it', async () => {
    const client = await connect();
    const created = await client.callTool({
      name: 'create_campaign',
      arguments: { name: 'World Codex Deed', story_shape: 'sandbox' },
    });
    const campaignId = (created.structuredContent as { campaign_id: number }).campaign_id;
    importRegion(db, campaignId, safe, { source: 'generated' });
    await client.callTool({ name: 'world', arguments: { campaign_id: campaignId, op: 'get' } });

    const faction = listFactions(db, campaignId).find((entry) => entry.type === 'house')!;
    const result = await client.callTool({
      name: 'world',
      arguments: { campaign_id: campaignId, op: 'deed', target: faction.name, value: 2, reason: 'saved their hall' },
    });
    expect(result.isError).toBeFalsy();

    const stored = listFactions(db, campaignId).find((entry) => entry.id === faction.id)!;
    expect(stored.entity_id).not.toBeNull();
    expect(entityWithName(campaignId, faction.name)!.kind).toBe('faction');
    await client.close();
  });
});

describe('deliverWorldNews hook', () => {
  it("creates the faction's entry when discovering its agenda", () => {
    const campaignId = withWorld(safe);
    const faction = listFactions(db, campaignId).find((entry) => entry.type === 'house')!;
    const seat = findPlace(db, campaignId, faction.place_id!)!;

    const agenda = insertAgenda(db, campaignId, {
      faction_id: faction.id,
      template: 'build',
      target_kind: 'own_seat',
      target_id: seat.id,
      target_name: seat.name,
      clock_size: 8,
      clock_filled: 0,
      portents: [
        { text: 'Scaffolding rises.', fired_day: null, heard: false },
        { text: 'Masons arrive.', fired_day: null, heard: false },
      ],
      status: 'active',
      started_day: 1,
    });

    firePortent(db, campaignId, agenda, 0, 100);
    firePortent(db, campaignId, agenda, 1, 100);

    const result = deliverWorldNews(db, campaignId, seat.id, 100);
    expect(result.discovered.map((entry) => entry.id)).toContain(agenda.id);
    expect(listFactions(db, campaignId).find((entry) => entry.id === faction.id)!.entity_id).not.toBeNull();
  });
});
