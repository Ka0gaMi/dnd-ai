import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addCanonFact, createCampaign } from '../src/core/campaign.js';
import {
  codexBriefing,
  getEntity,
  linkEntities,
  setVoiceCard,
  upsertEntity,
  type EntityView,
  type TreeNode,
} from '../src/core/codex.js';
import { registerCodexTools } from '../src/mcp/tools/codex.js';
import registerCodexRoutes from '../src/transport/routes/codex.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;
let httpServer: Server | null = null;

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'codex-test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerCodexTools(server, db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result.structuredContent as T;
}

/** The route module on its own ephemeral port; the real server's port is never touched. */
async function apiBase(): Promise<string> {
  const app = express();
  app.use(express.json());
  registerCodexRoutes(app, db);
  httpServer = createServer(app);
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(httpServer!.address() as AddressInfo).port}`;
}

function addCompanion(name: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO character (campaign_id, name, is_pc, role, status, created_at, updated_at) VALUES (?, ?, 0, 'companion', 'active', ?, ?)",
      )
      .run(campaignId, name, '2026-01-01', '2026-01-01').lastInsertRowid,
  );
}

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Codex Test', story_shape: 'sandbox' }).campaign_id;
});

afterEach(async () => {
  if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  httpServer = null;
});

describe('upsert_entity', () => {
  it('creates an entry, then merges the next call into it by name', async () => {
    const client = await connect();
    const first = await call<{ entity: EntityView; created: boolean }>(client, 'entity', {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'npc',
      name: 'Mira Vance',
      summary: 'The innkeeper of Ashfall.',
      notes: 'Keeps a crossbow under the bar.',
    });
    expect(first.created).toBe(true);
    expect(first.entity.status).toBe('alive');

    const second = await call<{ entity: EntityView; created: boolean }>(client, 'entity', {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'npc',
      name: 'mira vance',
      summary: 'The innkeeper who owes the Ash Court money.',
      notes: 'Her brother vanished three winters ago.',
      hidden_notes: 'She is the one who burned the granary.',
    });
    expect(second.created).toBe(false);
    expect(second.entity.id).toBe(first.entity.id);
    expect(second.entity.name).toBe('Mira Vance');
    expect(second.entity.summary).toBe('The innkeeper who owes the Ash Court money.');
    expect(second.entity.notes).toBe('Keeps a crossbow under the bar.\nHer brother vanished three winters ago.');
    expect(second.entity.hidden_notes).toBe('She is the one who burned the granary.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity').get()).toEqual({ n: 1 });
  });

  it('links an npc entry to the companion of the same name', async () => {
    const companionId = addCompanion('Nim');
    const client = await connect();
    const { entity } = await call<{ entity: EntityView }>(client, 'entity', {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'npc',
      name: 'nim',
      summary: 'The halfling scout travelling with the party.',
    });
    expect(entity.character_id).toBe(companionId);
  });

  it('leaves a place entry unlinked even when a character shares the name', async () => {
    addCompanion('Harrow');
    const client = await connect();
    const { entity } = await call<{ entity: EntityView }>(client, 'entity', {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'place',
      name: 'Harrow',
      summary: 'A village under the ridge.',
    });
    expect(entity.character_id).toBeNull();
  });
});

describe('consistency guard', () => {
  it('warns about notes that restate what is already written and keeps them out', async () => {
    const client = await connect();
    await call(client, 'entity', {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'npc',
      name: 'Grask',
      notes: 'Grask leads the Ash Court and hates the river guild.',
    });
    const again = await call<{ entity: EntityView; warnings: string[] }>(client, 'entity', {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'npc',
      name: 'Grask',
      notes: 'Grask leads the Ash Court and hates the river guild.',
    });
    expect(again.warnings).toContain('near-duplicate of existing notes');
    expect(again.entity.notes).toBe('Grask leads the Ash Court and hates the river guild.');
  });

  it('warns when a status change fights an active canon fact, and writes it anyway', async () => {
    addCanonFact(db, { campaign_id: campaignId, subject: 'Grask', fact: 'Grask is alive and hiding in the marsh.' });
    const client = await connect();
    await call(client, 'entity', { op: 'upsert', campaign_id: campaignId, kind: 'npc', name: 'Grask' });
    const killed = await call<{ entity: EntityView; warnings: string[] }>(client, 'entity', {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'npc',
      name: 'Grask',
      status: 'dead',
    });
    expect(killed.entity.status).toBe('dead');
    expect(killed.warnings.join(' ')).toContain('contradicts a canon fact');
  });

  it('keeps new notes when it is the summary that restates what is already written', async () => {
    addCanonFact(db, {
      campaign_id: campaignId,
      subject: 'Grask',
      fact: 'Grask leads the Ash Court and hates the river guild.',
    });
    const client = await connect();
    await call(client, 'entity', {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'npc',
      name: 'Grask',
      notes: 'First seen at the ford.',
    });
    const again = await call<{ entity: EntityView; warnings: string[] }>(client, 'entity', {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'npc',
      name: 'Grask',
      summary: 'Grask leads the Ash Court and hates the river guild.',
      notes: 'He keeps a knife in his boot and never drinks first.',
    });
    expect(again.warnings).toEqual(['summary restates an existing canon fact']);
    expect(again.entity.notes).toBe('First seen at the ford.\nHe keeps a knife in his boot and never drinks first.');
  });

  it('says nothing about fresh notes on a fresh entry', async () => {
    const client = await connect();
    const { warnings } = await call<{ warnings: string[] }>(client, 'entity', {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'faction',
      name: 'The Ash Court',
      notes: 'Merchants who bought the old garrison and its debts.',
    });
    expect(warnings).toEqual([]);
  });
});

describe('relationships', () => {
  beforeEach(async () => {
    const client = await connect();
    for (const name of ['Mira', 'Grask', 'Tamsin', 'Ash Court']) {
      await call(client, 'entity', {
        op: 'upsert',
        campaign_id: campaignId,
        kind: name === 'Ash Court' ? 'faction' : 'npc',
        name,
      });
    }
  });

  it('reads a symmetric tie from both ends without storing it twice', async () => {
    const client = await connect();
    await call(client, 'entity', { op: 'link', campaign_id: campaignId, from: 'Mira', to: 'Grask', type: 'spouse' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM relationship').get()).toEqual({ n: 1 });

    const grask = await call<EntityView>(client, 'entity', { op: 'get', campaign_id: campaignId, name: 'Grask' });
    expect(grask.relations).toHaveLength(1);
    expect(grask.relations[0]!.as).toBe('spouse');
    expect(grask.relations[0]!.direction).toBe('in');
    expect(grask.relations[0]!.entity.name).toBe('Mira');
  });

  it('inverts an asymmetric tie when read from the other end', async () => {
    const client = await connect();
    await call(client, 'entity', { op: 'link', campaign_id: campaignId, from: 'Mira', to: 'Tamsin', type: 'parent' });
    const tamsin = await call<EntityView>(client, 'entity', { op: 'get', campaign_id: campaignId, name: 'Tamsin' });
    expect(tamsin.relations[0]!.type).toBe('parent');
    expect(tamsin.relations[0]!.as).toBe('child');

    const court = await call<EntityView>(client, 'entity', { op: 'get', campaign_id: campaignId, name: 'Ash Court' });
    expect(court.relations).toEqual([]);
  });

  it('does not duplicate a tie that is already there, whichever way round a symmetric one is sent', async () => {
    const client = await connect();
    await call(client, 'entity', { op: 'link', campaign_id: campaignId, from: 'Mira', to: 'Grask', type: 'ally' });
    const again = await call<{ created: boolean }>(client, 'entity', {
      op: 'link',
      campaign_id: campaignId,
      from: 'Grask',
      to: 'Mira',
      type: 'ally',
    });
    expect(again.created).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relationship').get()).toEqual({ n: 1 });
  });

  it('treats a tie sent as its own inverse as the one already stored', async () => {
    const client = await connect();
    await call(client, 'entity', { op: 'link', campaign_id: campaignId, from: 'Mira', to: 'Tamsin', type: 'parent' });
    const again = await call<{ created: boolean }>(client, 'entity', {
      op: 'link',
      campaign_id: campaignId,
      from: 'Tamsin',
      to: 'Mira',
      type: 'child',
    });
    expect(again.created).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM relationship').get()).toEqual({ n: 1 });

    const tamsin = await call<EntityView>(client, 'entity', { op: 'get', campaign_id: campaignId, name: 'Tamsin' });
    expect(tamsin.relations).toHaveLength(1);
    expect(tamsin.relations[0]!.as).toBe('child');
  });

  it('builds the tree three links deep and no further', async () => {
    const client = await connect();
    for (const name of ['Edrin', 'Sela', 'Bram']) {
      await call(client, 'entity', { op: 'upsert', campaign_id: campaignId, kind: 'npc', name });
    }
    // Mira -> Tamsin -> Edrin -> Sela -> Bram, a chain one longer than the tree goes.
    await call(client, 'entity', { op: 'link', campaign_id: campaignId, from: 'Mira', to: 'Tamsin', type: 'parent' });
    await call(client, 'entity', { op: 'link', campaign_id: campaignId, from: 'Tamsin', to: 'Edrin', type: 'parent' });
    await call(client, 'entity', { op: 'link', campaign_id: campaignId, from: 'Edrin', to: 'Sela', type: 'parent' });
    await call(client, 'entity', { op: 'link', campaign_id: campaignId, from: 'Sela', to: 'Bram', type: 'parent' });
    await call(client, 'entity', { op: 'link', campaign_id: campaignId, from: 'Mira', to: 'Ash Court', type: 'member_of' });

    const base = await apiBase();
    const mira = db.prepare("SELECT id FROM entity WHERE name = 'Mira'").get() as { id: number };
    const { tree } = (await (await fetch(`${base}/api/campaigns/${campaignId}/entities/${mira.id}/tree`)).json()) as {
      tree: TreeNode;
    };
    expect(tree.name).toBe('Mira');
    expect(tree.links.map((link) => link.name).sort()).toEqual(['Ash Court', 'Tamsin']);
    const tamsin = tree.links.find((link) => link.name === 'Tamsin')!;
    expect(tamsin.relation).toBe('parent');
    const sela = tamsin.links[0]!.links[0]!;
    expect(tamsin.links[0]!.name).toBe('Edrin');
    expect(sela.name).toBe('Sela');
    expect(sela.links).toHaveLength(0);
  });
});

describe('codex listing and voice cards', () => {
  it('filters the compact list by kind and by query', async () => {
    const client = await connect();
    await call(client, 'entity', {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'npc',
      name: 'Mira',
      summary: 'Innkeeper of Ashfall.',
    });
    await call(client, 'entity', { op: 'upsert', campaign_id: campaignId, kind: 'place', name: 'Ashfall' });
    await call(client, 'entity', { op: 'upsert', campaign_id: campaignId, kind: 'item', name: 'The Grey Key' });

    const byKind = await call<{ entities: Array<{ name: string }> }>(client, 'get_codex', {
      campaign_id: campaignId,
      kind: 'place',
    });
    expect(byKind.entities.map((e) => e.name)).toEqual(['Ashfall']);

    const byQuery = await call<{ entities: Array<{ name: string; has_voice: boolean }> }>(client, 'get_codex', {
      campaign_id: campaignId,
      query: 'ashfall',
    });
    expect(byQuery.entities.map((e) => e.name).sort()).toEqual(['Ashfall', 'Mira']);
    expect(byQuery.entities.every((e) => e.has_voice === false)).toBe(true);
  });

  it('merges voice card fields and clears one with an empty string', async () => {
    const client = await connect();
    await call(client, 'entity', { op: 'upsert', campaign_id: campaignId, kind: 'npc', name: 'Mira' });
    await call(client, 'entity', {
      op: 'voice',
      campaign_id: campaignId,
      name: 'Mira',
      speech_pattern: 'Short sentences, no small talk.',
      catchphrase: 'Coin first.',
      fear: 'the Ash Court',
    });
    const merged = await call<EntityView>(client, 'entity', {
      op: 'voice',
      campaign_id: campaignId,
      name: 'Mira',
      goal: 'buy back the deed',
      fear: '',
    });
    expect(merged.voice).toEqual({
      speech_pattern: 'Short sentences, no small talk.',
      catchphrase: 'Coin first.',
      goal: 'buy back the deed',
    });
  });
});

describe('hidden notes', () => {
  beforeEach(async () => {
    const client = await connect();
    await call(client, 'entity', {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'npc',
      name: 'Mira',
      summary: 'The innkeeper.',
      hidden_notes: 'She burned the granary.',
    });
  });

  it('reaches the DM tool but not the player API', async () => {
    const client = await connect();
    const forDm = await call<EntityView>(client, 'entity', { op: 'get', campaign_id: campaignId, name: 'Mira' });
    expect(forDm.hidden_notes).toBe('She burned the granary.');

    const base = await apiBase();
    const entityRow = db.prepare('SELECT id FROM entity').get() as { id: number };
    const body = (await (await fetch(`${base}/api/campaigns/${campaignId}/entities/${entityRow.id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(body.name).toBe('Mira');
    expect('hidden_notes' in body).toBe(false);
  });

  it('reaches the player API once the spoiler toggle is on', async () => {
    db.prepare('UPDATE campaign SET settings_json = ? WHERE id = ?').run(
      JSON.stringify({ show_secrets: true }),
      campaignId,
    );
    const base = await apiBase();
    const entityRow = db.prepare('SELECT id FROM entity').get() as { id: number };
    const body = (await (await fetch(`${base}/api/campaigns/${campaignId}/entities/${entityRow.id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(body.hidden_notes).toBe('She burned the granary.');
  });
});

describe('codex routes', () => {
  it('lists, filters and walks the tree', async () => {
    const client = await connect();
    await call(client, 'entity', { op: 'upsert', campaign_id: campaignId, kind: 'npc', name: 'Mira' });
    await call(client, 'entity', { op: 'upsert', campaign_id: campaignId, kind: 'faction', name: 'Ash Court' });
    await call(client, 'entity', { op: 'link', campaign_id: campaignId, from: 'Mira', to: 'Ash Court', type: 'member_of' });
    const base = await apiBase();

    const all = (await (await fetch(`${base}/api/campaigns/${campaignId}/codex`)).json()) as {
      entities: Array<{ name: string }>;
    };
    expect(all.entities.map((e) => e.name).sort()).toEqual(['Ash Court', 'Mira']);

    const factions = (await (await fetch(`${base}/api/campaigns/${campaignId}/codex?kind=faction`)).json()) as {
      entities: Array<{ name: string }>;
    };
    expect(factions.entities.map((e) => e.name)).toEqual(['Ash Court']);

    const mira = db.prepare("SELECT id FROM entity WHERE name = 'Mira'").get() as { id: number };
    const tree = (await (await fetch(`${base}/api/campaigns/${campaignId}/entities/${mira.id}/tree`)).json()) as {
      tree: TreeNode;
    };
    expect(tree.tree.links[0]!.name).toBe('Ash Court');
    expect(tree.tree.links[0]!.relation).toBe('member_of');

    const missing = await fetch(`${base}/api/campaigns/${campaignId}/entities/9999`);
    expect(missing.status).toBe(404);
  });
});

describe('codexBriefing', () => {
  it('is empty while the codex is', () => {
    expect(codexBriefing(db, campaignId)).toBe('');
  });

  it('lists whoever is present with their voice card, then indexes every name by kind', async () => {
    const client = await connect();
    await call(client, 'entity', {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'npc',
      name: 'Mira',
      summary: 'The innkeeper of Ashfall.',
      voice: { speech_pattern: 'Short sentences.', catchphrase: 'Coin first.', goal: 'buy back the deed' },
    });
    await call(client, 'entity', { op: 'upsert', campaign_id: campaignId, kind: 'npc', name: 'Grask' });
    await call(client, 'entity', { op: 'upsert', campaign_id: campaignId, kind: 'place', name: 'Ashfall' });

    const block = codexBriefing(db, campaignId, { present: ['mira', 'Nobody'] });
    expect(block.split('\n')).toEqual([
      '## Codex',
      'Present:',
      '- Mira (npc, alive) - The innkeeper of Ashfall.',
      '  voice: Short sentences. | "Coin first." | wants buy back the deed',
      'Known npc: Grask, Mira',
      'Known place: Ashfall',
    ]);
    expect(codexBriefing(db, campaignId)).not.toContain('Present:');
  });

  it('keeps hidden notes out of the block', async () => {
    const client = await connect();
    await call(client, 'entity', {
      op: 'upsert',
      campaign_id: campaignId,
      kind: 'npc',
      name: 'Mira',
      hidden_notes: 'She burned the granary.',
    });
    expect(codexBriefing(db, campaignId, { present: ['Mira'] })).not.toContain('granary');
    expect(getEntity(db, campaignId, 'Mira', { include_hidden: true }).hidden_notes).toContain('granary');
  });
});

describe('event kinds', () => {
  const lastEventKind = (): string =>
    (db.prepare('SELECT kind FROM event WHERE campaign_id = ? ORDER BY id DESC LIMIT 1').get(campaignId) as {
      kind: string;
    }).kind;

  it('logs kind entity on create and on update', () => {
    upsertEntity(db, { campaign_id: campaignId, kind: 'npc', name: 'Mira' });
    expect(lastEventKind()).toBe('entity');

    upsertEntity(db, { campaign_id: campaignId, kind: 'npc', name: 'Mira', summary: 'The innkeeper.' });
    expect(lastEventKind()).toBe('entity');
  });

  it('logs kind relationship on link_entities', () => {
    upsertEntity(db, { campaign_id: campaignId, kind: 'npc', name: 'Mira' });
    upsertEntity(db, { campaign_id: campaignId, kind: 'npc', name: 'Grask' });
    linkEntities(db, { campaign_id: campaignId, from: 'Mira', to: 'Grask', type: 'knows' });
    expect(lastEventKind()).toBe('relationship');
  });

  it('logs kind voice on set_voice_card', () => {
    upsertEntity(db, { campaign_id: campaignId, kind: 'npc', name: 'Mira' });
    setVoiceCard(db, campaignId, 'Mira', { catchphrase: 'Coin first.' });
    expect(lastEventKind()).toBe('voice');
  });
});
