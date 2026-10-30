// The spoiler guard, through the MCP client: a write whose player-visible text restates a campaign secret gets one
// DM-only warning line, and the call itself is never refused or changed.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, type GameEvent } from '../src/core/bus.js';
import { campaignSnapshot } from '../src/core/campaign.js';
import { spoilerWarning } from '../src/core/spoiler-guard.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { replyText } from './helpers/reply.js';

const SECRET = "The Eelwrights' Compact is smuggling through the marsh and the watch captain is paid to look away.";
/** The thread summary the judged town playtest showed the player for ten turns. */
const LEAK =
  "Fishermen tell of a bell tolling at dusk near the east pilings' reed beds. No one has seen anything, and the Eelwrights' Compact discourages outsiders on the mere after dark: cover for smuggling.";

let db: Db;
let client: Client;
let campaignId: number;

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const next = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), next.connect(clientTransport)]);
  return next;
}

/** The reply text of a call that must succeed. */
async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: { campaign_id: campaignId, ...args } });
  expect(result.isError ?? false, replyText(result)).toBe(false);
  return replyText(result);
}

const warnings = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('Spoiler check:'));

beforeEach(async () => {
  db = openDb(':memory:');
  client = await connect();
  campaignId = 0;
  const created = await client.callTool({
    name: 'create_campaign',
    arguments: {
      name: 'The Hollow Market',
      story_shape: 'structured',
      premise: 'Bram arrives in Quillmere, a market town on a marsh causeway, looking for work and lodging.',
    },
  });
  campaignId = (JSON.parse(replyText(created).split('\n\n', 1)[0]!) as { campaign_id: number }).campaign_id;
  await call('story', { op: 'outline', ending: 'The party earns a place in Quillmere, or leaves it behind.', secret_notes: SECRET });
  await call('entity', {
    op: 'upsert',
    kind: 'faction',
    name: "The Eelwrights' Compact",
    summary: 'A guild of eel-trappers who control the marsh paths.',
  });
  await call('entity', {
    op: 'upsert',
    kind: 'npc',
    name: 'Hesper Dunmow',
    summary: 'Weary watch captain who keeps the causeway gate.',
    hidden_notes: "Takes the Compact's bribes to leave the causeway gate unbarred at night.",
  });
});

describe('spoiler guard', () => {
  it('warns once when a visible thread summary gives away the secret note, and still opens the thread', async () => {
    const text = await call('thread', { op: 'add', title: 'The drowned bell', summary: LEAK });
    expect(warnings(text)).toEqual([
      "Spoiler check: '...outsiders on the mere after dark: cover for smuggling' matches your secret note 'The Eelwrights' Compact is smuggling through the marsh and the watch captain is...' — the player sees this; reword it or mark it hidden.",
    ]);
    const row = db.prepare('SELECT summary, hidden FROM plot_thread WHERE campaign_id = ?').get(campaignId);
    expect(row).toEqual({ summary: LEAK, hidden: 0 });
  });

  it('stays quiet on text that only names the same faction or uses words the player has already seen', async () => {
    const quiet = [
      ['thread', { op: 'add', title: 'The drowned bell', summary: "The Eelwrights' Compact discourages outsiders on the mere after dark." }],
      ['remember', { op: 'fact', subject: 'Hesper Dunmow', fact: 'Hesper Dunmow, the watch captain, shuts the marsh gate at dusk.' }],
      ['log_event', { kind: 'narration', text: "Bram paid the Eelwrights' Compact two silver for a lantern." }],
    ] as const;
    for (const [name, args] of quiet) expect(warnings(await call(name, args))).toEqual([]);
  });

  it('never warns on fields hidden by design', async () => {
    const ledger = "The Eelwrights' Compact keeps its smuggling ledger in the boathouse.";
    const barges = "Waves the Eelwrights' Compact smuggling barges through the marsh.";
    const talk = "They say the Compact's smuggling runs through the marsh.";
    const hidden = [
      ['thread', { op: 'add', title: 'Who rings the bell?', summary: LEAK, hidden: true }],
      ['thread', { op: 'plant_clue', text: ledger, hidden: true }],
      ['entity', { op: 'upsert', kind: 'npc', name: 'Hesper Dunmow', hidden_notes: barges }],
      ['story', { op: 'outline', ending: barges, secret_notes: `${SECRET} ${ledger}` }],
      ['rumour', { op: 'add', text: talk }],
    ] as const;
    for (const [name, args] of hidden) expect(warnings(await call(name, args))).toEqual([]);
    // A thread already hidden stays hidden when an update leaves the flag alone.
    const id = (db.prepare('SELECT id FROM plot_thread WHERE hidden = 1').get() as { id: number }).id;
    expect(warnings(await call('thread', { op: 'update', id, summary: LEAK }))).toEqual([]);
    // Each of those texts would have warned in a field the player sees.
    for (const text of [LEAK, ledger, barges, talk]) {
      expect(spoilerWarning(db, 'log_event', { campaign_id: campaignId, kind: 'narration', text }), text).not.toBeNull();
    }
  });

  it("counts a codex entity's hidden notes as a secret about that entity", async () => {
    const fact = 'Hesper Dunmow keeps the gate unbarred for the Compact.';
    expect(warnings(await call('remember', { op: 'fact', subject: 'Hesper Dunmow', fact }))).toEqual([
      "Spoiler check: 'Hesper Dunmow keeps the gate unbarred for the Compact' matches Hesper Dunmow's hidden notes '...the Compact's bribes to leave the causeway gate unbarred at night' — the player sees this; reword it or mark it hidden.",
    ]);
  });

  it('checks the scene summary a checkpoint saves', async () => {
    const text = await call('checkpoint', { op: 'save', scene_summary: `Bram reached the docks. ${LEAK}` });
    expect(warnings(text)).toHaveLength(1);
  });

  it('adds nothing to a refused call', async () => {
    const result = await client.callTool({ name: 'thread', arguments: { op: 'update', campaign_id: campaignId, id: 9999, summary: LEAK } });
    expect(result.isError).toBe(true);
    expect(warnings(replyText(result))).toEqual([]);
  });

  it('no longer warns about a word the player has already been shown', async () => {
    await call('log_event', { kind: 'narration', text: 'Elowen said the town lives on smuggling.' });
    expect(warnings(await call('thread', { op: 'add', title: 'The drowned bell', summary: LEAK }))).toEqual([]);
  });

  it('never reaches the player: nothing published, stored or in the window snapshot carries the warning', async () => {
    const seen: GameEvent[] = [];
    const stop = bus.subscribe((event) => seen.push(event));
    let text: string;
    try {
      text = await call('thread', { op: 'add', title: 'The drowned bell', summary: LEAK });
    } finally {
      stop();
    }
    expect(warnings(text)).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain('Spoiler check');
    expect(JSON.stringify(campaignSnapshot(db, campaignId, { forPlayer: true }))).not.toContain('Spoiler check');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    for (const { name } of tables) {
      expect(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()), name).not.toContain('Spoiler check');
    }
  });

  it('ignores calls with nothing player-visible to check', () => {
    expect(spoilerWarning(db, 'thread', { op: 'find_clue', campaign_id: campaignId, text: 'smuggling' })).toBeNull();
    expect(spoilerWarning(db, 'roll', { campaign_id: campaignId, purpose: 'smuggling' })).toBeNull();
  });
});
