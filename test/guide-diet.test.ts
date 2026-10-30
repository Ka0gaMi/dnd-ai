import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { GUIDE_SECTIONS, guideTopics, readGuide, registerGuideTools } from '../src/mcp/tools/guide.js';

const CARD_CAP = 600;
const TOPIC_CAP = 2 * 1024;

/** The pages served by topic: their card and topic list without a topic, one topic with it. */
const SPLIT_PAGES = ['combat', 'class-features'] as const;

/** Cards still over the cap on pages owned by other packages; each leaves this list when its page is split. */
const CARD_OVER_CAP: ReadonlySet<string> = new Set(['homebrew', 'world']);

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'guide-diet-test', version: '0.0.0' });
  registerGuideTools(server, db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type GuideResult = { text: string; structured: Record<string, unknown> | undefined; isError: boolean };

async function readGuideTool(client: Client, args: Record<string, unknown>): Promise<GuideResult> {
  const result = await client.callTool({ name: 'read_guide', arguments: args });
  return {
    text: (result.content as Array<{ text: string }>)[0]!.text,
    structured: result.structuredContent as Record<string, unknown> | undefined,
    isError: result.isError === true,
  };
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');
const pageText = (section: string): string =>
  readFileSync(fileURLToPath(new URL(`../docs/guide/${section}.md`, import.meta.url)), 'utf8');

describe('guide budgets', () => {
  it('opens every page with a card of at most 600 characters', () => {
    const over = GUIDE_SECTIONS.filter((section) => !CARD_OVER_CAP.has(section))
      .map((section) => ({ section, card: guideTopics(readGuide(section).text).card.length }))
      .filter(({ card }) => card > CARD_CAP);
    expect(over).toEqual([]);
  });

  it('keeps every topic of a split page within 2 KB and gives each page several topics', () => {
    for (const section of SPLIT_PAGES) {
      const { topics } = guideTopics(pageText(section));
      expect(topics.length, section).toBeGreaterThan(3);
      const over = topics.filter((topic) => bytes(topic.text) > TOPIC_CAP).map((topic) => `${section}/${topic.name}`);
      expect(over).toEqual([]);
      expect(new Set(topics.map((topic) => topic.name)).size, `${section} topic names are unique`).toBe(topics.length);
    }
  });
});

describe('read_guide by topic', () => {
  it('returns only the turn-loop topic of the combat page', async () => {
    const client = await connect();
    const loop = await readGuideTool(client, { section: 'combat', topic: 'turn-loop' });
    expect(loop.isError).toBe(false);
    expect(loop.text.startsWith('## Turn loop\n')).toBe(true);
    expect(loop.text).toContain('advance_turn');
    expect(loop.text).toContain('get_battle_state');
    expect(loop.text.match(/^## /gm)).toHaveLength(1);
    expect(loop.text).not.toContain('# Running a fight');
    expect(bytes(loop.text)).toBeLessThanOrEqual(TOPIC_CAP);
  });

  it('answers without a topic with the card and the topic list, not the whole page', async () => {
    const client = await connect();
    const combat = await readGuideTool(client, { section: 'combat' });
    const { card, topics } = guideTopics(pageText('combat'));
    expect(combat.text.startsWith(card)).toBe(true);
    expect(combat.text).toContain('read_guide {section: "combat", topic: "<name>"}');
    for (const topic of topics) expect(combat.text).toContain(`- ${topic.name}`);
    expect(combat.text).toContain('- turn-loop');
    expect(combat.text).not.toMatch(/^## /m);
    expect(combat.text).not.toContain('find_position {combatant_id');
    expect(bytes(combat.text)).toBeLessThan(bytes(pageText('combat')) / 5);
  });

  it('matches a topic by its heading too and refuses an unknown one with the list', async () => {
    const client = await connect();
    const byHeading = await readGuideTool(client, { section: 'combat', topic: 'Turn loop' });
    expect(byHeading.text.startsWith('## Turn loop')).toBe(true);
    const unknown = await readGuideTool(client, { section: 'combat', topic: 'flanking' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('No topic "flanking" in the combat guide');
    expect(unknown.text).toContain('turn-loop');
  });

  it('still returns a page that is not split whole when no topic is asked for', async () => {
    const client = await connect();
    const region = await readGuideTool(client, { section: 'region' });
    expect(region.text).toBe(pageText('region'));
  });
});

describe('class features', () => {
  it('live on their own page, out of the combat page', async () => {
    const client = await connect();
    const page = await readGuideTool(client, { section: 'class-features' });
    expect(page.isError).toBe(false);
    expect(page.structured?.found).toBe(true);
    expect(page.text.startsWith('# Class features')).toBe(true);
    for (const name of ['feature-actions', 'attack-flags', 'reactions', 'metamagic-and-overchannel', 'left-to-you']) {
      expect(page.text).toContain(`- ${name}`);
    }

    const actions = await readGuideTool(client, { section: 'class-features', topic: 'feature-actions' });
    expect(actions.text).toContain('`second_wind`');
    const left = await readGuideTool(client, { section: 'class-features', topic: 'left-to-you' });
    expect(left.text).toContain('Left to you, and why');

    const combat = pageText('combat');
    for (const moved of ['Features with an action of their own', 'Metamagic', 'Wild Shape', 'Left to you, and why', 'Sculpt Spells (']) {
      expect(combat, moved).not.toContain(moved);
    }
    expect(combat).toContain('class-features');
  });
});

describe('read_guide reply shape', () => {
  it('keeps a card or a topic in the text only, not again in structuredContent', async () => {
    const client = await connect();
    const replies = [
      await readGuideTool(client, { section: 'combat' }),
      await readGuideTool(client, { section: 'combat', topic: 'turn-loop' }),
      await readGuideTool(client, { section: 'class-features' }),
      await readGuideTool(client, { section: 'class-features', topic: 'reactions' }),
    ];
    for (const result of replies) {
      expect(result.structured).toBeDefined();
      expect(result.structured!.found).toBe(true);
      expect(result.structured).not.toHaveProperty('text');
      expect(JSON.stringify(result.structured).length).toBeLessThan(100);
    }
    expect(replies[1]!.structured).toEqual({ section: 'combat', topic: 'turn-loop', found: true });
  });
});
