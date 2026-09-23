// The checkpoint family behind one `checkpoint` tool, through the MCP client: saving a scene,
// ending a session, and the campaign listing that moved onto `load_campaign`.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot } from '../src/core/campaign.js';
import { importRegion } from '../src/core/region.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';

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
  return result.structuredContent as T;
}

const textOf = (result: { content: Array<{ text: string }> }): string => result.content[0]!.text;

async function makeCampaign(client: Client): Promise<number> {
  const { campaign_id } = await call<{ campaign_id: number }>(client, 'create_campaign', {
    name: 'Checkpoint',
    story_shape: 'sandbox',
  });
  return campaign_id;
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('checkpoint {op: save}', () => {
  it('writes a checkpoint and resets the events-since-checkpoint count', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);
    await call(client, 'log_event', { campaign_id, kind: 'narration', text: 'A beat.' });
    await call(client, 'log_event', { campaign_id, kind: 'narration', text: 'Another beat.' });

    const saved = await call<{ scene: { id: number }; session: { recap_text: string } }>(client, 'checkpoint', {
      op: 'save',
      campaign_id,
      scene_title: 'Arrival',
      scene_summary: 'They arrived at the keep at dusk.',
    });
    expect(saved.session.recap_text).toContain('Arrival');

    const shown = await call<{ events_since_checkpoint: number; previous_scene: { title: string } | null }>(
      client,
      'load_campaign',
      { campaign_id },
    );
    expect(shown.events_since_checkpoint).toBe(0);
    expect(shown.previous_scene?.title).toBe('Arrival');
    await client.close();
  });

  it('writes the facts, quests and glossary the checkpoint bundles', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);

    await call(client, 'checkpoint', {
      op: 'save',
      campaign_id,
      scene_summary: 'They searched the chapel and found a sealed crypt.',
      canon_facts: [{ subject: 'Chapel of Sain', fact: 'Its crypt is sealed with a silver lock.' }],
      quest_updates: [{ title: 'Open the crypt', kind: 'main', steps: [{ text: 'Find the silver key' }] }],
      glossary: [{ term: 'Sain', definition: 'A minor god of embers.' }],
    });

    const shown = await call<{
      canon_facts: Array<{ subject: string }>;
      glossary_terms: string[];
      open_quests: Array<{ title: string }>;
    }>(client, 'load_campaign', { campaign_id });
    expect(shown.canon_facts.map((f) => f.subject)).toEqual(['Chapel of Sain']);
    expect(shown.glossary_terms).toEqual(['Sain']);
    expect(shown.open_quests.map((q) => q.title)).toEqual(['Open the crypt']);
    await client.close();
  });

  it('teaches which fields op=save needs', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);

    const missing = await client.callTool({ name: 'checkpoint', arguments: { op: 'save', campaign_id } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing as { content: Array<{ text: string }> })).toBe(
      'Missing scene_summary for op=save (requires scene_summary). Re-call with scene_summary set.',
    );
    await client.close();
  });

  it('refuses recap_override on op=save', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);

    const refused = await client.callTool({
      name: 'checkpoint',
      arguments: { op: 'save', campaign_id, scene_summary: 'A scene.', recap_override: 'Not here.' },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused as { content: Array<{ text: string }> })).toBe(
      'recap_override does not apply to op=save; it takes campaign_id, scene_summary, scene_title, scene_location, canon_facts, quest_updates, glossary. Re-call without it.',
    );
    await client.close();
  });

  it('records where the party is and starts the next scene there', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);

    const saved = await call<{ scene: { id: number; location: string | null } }>(client, 'checkpoint', {
      op: 'save',
      campaign_id,
      scene_summary: 'They reached the walled port.',
      scene_location: 'Redham',
    });
    expect(saved.scene.location).toBe('Redham');

    const closed = db.prepare('SELECT location_name FROM scene WHERE id = ?').get(saved.scene.id) as {
      location_name: string | null;
    };
    expect(closed.location_name).toBe('Redham');

    const { current_scene_id } = db.prepare('SELECT current_scene_id FROM campaign WHERE id = ?').get(campaign_id) as {
      current_scene_id: number;
    };
    const current = db.prepare('SELECT location_name FROM scene WHERE id = ?').get(current_scene_id) as {
      location_name: string | null;
    };
    expect(current.location_name).toBe('Redham');
    expect(campaignSnapshot(db, campaign_id).current_scene?.location_name).toBe('Redham');
    await client.close();
  });

  it('keeps the party where they are when the next save omits scene_location', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);
    await call(client, 'checkpoint', {
      op: 'save',
      campaign_id,
      scene_summary: 'They reached the walled port.',
      scene_location: 'Redham',
    });

    const second = await call<{ scene: { id: number; location: string | null } }>(client, 'checkpoint', {
      op: 'save',
      campaign_id,
      scene_summary: 'They spent the night at the inn.',
    });
    expect(second.scene.location).toBe('Redham');

    const closed = db.prepare('SELECT location_name FROM scene WHERE id = ?').get(second.scene.id) as {
      location_name: string | null;
    };
    expect(closed.location_name).toBe('Redham');

    const { current_scene_id } = db.prepare('SELECT current_scene_id FROM campaign WHERE id = ?').get(campaign_id) as {
      current_scene_id: number;
    };
    const current = db.prepare('SELECT location_name FROM scene WHERE id = ?').get(current_scene_id) as {
      location_name: string | null;
    };
    expect(current.location_name).toBe('Redham');
    await client.close();
  });

  it('treats a whitespace-only scene_location as absent', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);

    const saved = await call<{ scene: { id: number; location: string | null } }>(client, 'checkpoint', {
      op: 'save',
      campaign_id,
      scene_summary: 'They stayed put.',
      scene_location: '   ',
    });
    expect(saved.scene.location).toBeNull();

    const closed = db.prepare('SELECT location_name FROM scene WHERE id = ?').get(saved.scene.id) as {
      location_name: string | null;
    };
    expect(closed.location_name).toBeNull();
    await client.close();
  });

  it('shows the party on the region map after a save', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);
    importRegion(db, campaign_id, safe, { source: 'generated' });

    await call(client, 'checkpoint', {
      op: 'save',
      campaign_id,
      scene_summary: 'They reached the walled port.',
      scene_location: 'Redham',
    });

    const loaded = await client.callTool({ name: 'load_campaign', arguments: { campaign_id } });
    expect(textOf(loaded as { content: Array<{ text: string }> })).toContain('Party is at: Redham');
    expect(campaignSnapshot(db, campaign_id).region_briefing).toContain('Party is at: Redham');
    await client.close();
  });
});

describe('checkpoint {op: end_session}', () => {
  it('ends the session and returns the recap', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);
    await call(client, 'checkpoint', {
      op: 'save',
      campaign_id,
      scene_title: 'Departure',
      scene_summary: 'They left town at dawn.',
    });

    const ended = await call<{ session_number: number; recap_text: string; ended_at: string }>(client, 'checkpoint', {
      op: 'end_session',
      campaign_id,
    });
    expect(ended.session_number).toBe(1);
    expect(ended.recap_text).toContain('Departure');
    expect(ended.ended_at).toBeTruthy();

    const shown = await call<{ session: { number: number }; last_recap: string }>(client, 'load_campaign', {
      campaign_id,
    });
    expect(shown.session.number).toBe(2);
    expect(shown.last_recap).toContain('Departure');
    await client.close();
  });

  it('uses recap_override when the player asks for a specific wording', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);
    await call(client, 'checkpoint', { op: 'save', campaign_id, scene_summary: 'They made camp.' });

    const ended = await call<{ recap_text: string }>(client, 'checkpoint', {
      op: 'end_session',
      campaign_id,
      recap_override: 'The road goes on.',
    });
    expect(ended.recap_text).toBe('The road goes on.');
    await client.close();
  });

  it('refuses scene_summary on op=end_session', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);

    const refused = await client.callTool({
      name: 'checkpoint',
      arguments: { op: 'end_session', campaign_id, scene_summary: 'A scene.' },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused as { content: Array<{ text: string }> })).toBe(
      'scene_summary does not apply to op=end_session; it takes campaign_id, recap_override. Re-call without it.',
    );
    await client.close();
  });
});

describe('load_campaign', () => {
  it('lists every saved campaign when campaign_id is left out', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);

    const listed = await call<{ campaigns: Array<{ id: number; name: string }> }>(client, 'load_campaign', {});
    expect(listed.campaigns.find((c) => c.id === campaign_id)?.name).toBe('Checkpoint');
    await client.close();
  });

  it('loads the briefing when the id is passed', async () => {
    const client = await connect();
    const campaign_id = await makeCampaign(client);

    const loaded = await client.callTool({ name: 'load_campaign', arguments: { campaign_id } });
    expect(textOf(loaded as { content: Array<{ text: string }> })).toContain('# Checkpoint');
    await client.close();
  });

  it('advertises the merged tools and none of the removed ones', async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['remember', 'checkpoint', 'load_campaign']));
    for (const gone of ['add_canon_fact', 'add_glossary_entry', 'save_checkpoint', 'end_session', 'list_campaigns']) {
      expect(names).not.toContain(gone);
    }
    await client.close();
  });
});
