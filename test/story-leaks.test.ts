// Three story and codex leaks: find_clue with nothing to match, entity get with nothing to name, and the
// outline's ending reaching the player's story view.
import { Client, InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import {
  addPlotThread,
  addRumour,
  findClue,
  openChapter,
  plantClue,
  setStoryOutline,
  storyArc,
} from '../src/core/story.js';
import { openDb, type Db } from '../src/db/connection.js';
import { registerCodexTools } from '../src/mcp/tools/codex.js';
import { registerStoryTools } from '../src/mcp/tools/story.js';
import { HOST, startHttpServer } from '../src/transport/http.js';

const FIND_CLUE_REFUSAL =
  "Pass id or text to thread {op: find_clue}: the clue id from the briefing, or part of the clue's text to match. Nothing was marked found.";
const ENTITY_GET_REFUSAL =
  'Missing id or name for op=get. Re-call with id (from get_codex or the briefing) or name (as the player hears it).';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, {
    name: 'The Ashfall Road',
    story_shape: 'structured',
    premise: 'A road of cinders.',
  }).campaign_id;
});

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'story-leaks-test', version: '0.0.0' });
  registerStoryTools(server, db);
  registerCodexTools(server, db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const textOf = (result: CallToolResult): string => (result.content as Array<{ text: string }>)[0]!.text;

function setShowSecrets(value: boolean): void {
  db.prepare('UPDATE campaign SET settings_json = ? WHERE id = ?').run(JSON.stringify({ show_secrets: value }), campaignId);
}

const clueRows = (): unknown[] =>
  db.prepare('SELECT id, status, hidden, found_at_scene_id FROM clue WHERE campaign_id = ? ORDER BY id').all(campaignId);
const eventCount = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM event WHERE campaign_id = ?').get(campaignId) as { n: number }).n;

describe('thread {op: find_clue} with neither id nor text', () => {
  it('refuses with a teaching error and reveals nothing, the hidden clue included', async () => {
    openChapter(db, { campaign_id: campaignId, title: 'Cinders' });
    const thread = addPlotThread(db, { campaign_id: campaignId, title: 'Who set the fire?' });
    const hidden = plantClue(db, { campaign_id: campaignId, text: 'A boot print in the ash.', thread_id: thread.id, hidden: true });
    plantClue(db, { campaign_id: campaignId, text: 'A scorched lamp.', thread_id: thread.id });
    const rumour = addRumour(db, { campaign_id: campaignId, text: 'The reeve bought lamp oil.' });
    const clues = clueRows();
    const events = eventCount();
    const client = await connect();

    for (const extra of [{}, { text: '   ' }, { rumour_id: rumour.id }]) {
      const result = (await client.callTool({
        name: 'thread',
        arguments: { op: 'find_clue', campaign_id: campaignId, ...extra },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(FIND_CLUE_REFUSAL);
    }
    expect(() => findClue(db, { campaign_id: campaignId })).toThrow(FIND_CLUE_REFUSAL);

    expect(clueRows()).toEqual(clues);
    expect(eventCount()).toBe(events);
    expect(db.prepare('SELECT thread_id FROM rumour WHERE id = ?').get(rumour.id)).toEqual({ thread_id: null });
    const playerClues = storyArc(db, campaignId, { forPlayer: true }).clues;
    expect(playerClues.map((c) => c.text)).toEqual(['A scorched lamp.']);
    expect(playerClues.some((c) => c.id === hidden.id)).toBe(false);
  });

  it("matches '%', '_' and '\\' literally, so they cannot reveal a hidden clue without them", async () => {
    const hidden = plantClue(db, { campaign_id: campaignId, text: 'A boot print in the ash.', hidden: true });
    const clues = clueRows();
    const events = eventCount();
    const client = await connect();

    for (const text of ['%', '_', '\\']) {
      const result = (await client.callTool({
        name: 'thread',
        arguments: { op: 'find_clue', campaign_id: campaignId, text },
      })) as CallToolResult;
      expect(result.isError, text).toBe(true);
      expect(textOf(result)).toMatch(/No matching planted clue/);
    }
    expect(clueRows()).toEqual(clues);
    expect(eventCount()).toBe(events);

    // Unescaped, '%' would have matched the older hidden clue first.
    const literal = plantClue(db, { campaign_id: campaignId, text: 'A note: 100% the reeve.', hidden: true });
    expect(findClue(db, { campaign_id: campaignId, text: '%' }).clue.id).toBe(literal.id);
    expect(storyArc(db, campaignId, { forPlayer: true }).clues.some((c) => c.id === hidden.id)).toBe(false);
  });
});

describe('entity {op: get} with neither id nor name', () => {
  it('refuses with a teaching error that names what to pass', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'entity',
      arguments: { op: 'get', campaign_id: campaignId },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(ENTITY_GET_REFUSAL);
  });
});

describe('the outline in the player story view', () => {
  beforeEach(() => {
    openChapter(db, { campaign_id: campaignId, title: 'Cinders' });
    setStoryOutline(db, {
      campaign_id: campaignId,
      premise: 'A road of cinders.',
      ending: 'The forge is put out.',
      secret_notes: 'The smith is dead.',
    });
  });

  it('drops the ending and the secret notes for the player, and keeps both for the DM', () => {
    const player = storyArc(db, campaignId, { forPlayer: true }).outline;
    expect(player).toEqual({ premise: 'A road of cinders.', ending: null, secret_notes: null });
    expect(campaignSnapshot(db, campaignId, { forPlayer: true }).story.outline).toEqual(player);

    const dm = storyArc(db, campaignId).outline;
    expect(dm).toEqual({ premise: 'A road of cinders.', ending: 'The forge is put out.', secret_notes: 'The smith is dead.' });
    expect(campaignSnapshot(db, campaignId).story.outline).toEqual(dm);
  });

  it('gives the player both once their spoiler toggle is on, like the other secrets', () => {
    setShowSecrets(true);
    expect(storyArc(db, campaignId, { forPlayer: true }).outline).toMatchObject({
      ending: 'The forge is put out.',
      secret_notes: 'The smith is dead.',
    });
  });

  it('keeps the ending and the secret notes out of the story route', async () => {
    const started = await startHttpServer(db, { port: 0, secret: 'storyleaks0123456789abcdef012345' });
    try {
      const response = await fetch(`http://${HOST}:${started.port}/api/campaigns/${campaignId}/story`);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain('The forge is put out.');
      expect(body).not.toContain('The smith is dead.');
      const story = JSON.parse(body) as { outline: Record<string, unknown> };
      expect(story.outline).toEqual({ premise: 'A road of cinders.', ending: null, secret_notes: null });
    } finally {
      await started.close();
    }
  });
});
