// The duplicate-call guard: an identical state-changing call within 10 s returns the first reply; turn tools, dice and reads are left alone.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';

type Reply = { content: Array<{ type: string; text?: string }>; isError?: boolean };

let db: Db;
let client: Client;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  db = openDb(':memory:');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'dedupe-test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(() => {
  vi.useRealTimers();
});

const call = async (name: string, args: Record<string, unknown>): Promise<Reply> =>
  (await client.callTool({ name, arguments: args })) as unknown as Reply;
const textOf = (reply: Reply): string => reply.content.map((c) => c.text ?? '').join('');
const campaign = (): number => createCampaign(db, { name: 'Dedupe', story_shape: 'sandbox' }).campaign_id;
const events = (): number => (db.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'narration'").get() as { n: number }).n;
const DUPLICATE = /Duplicate of the same call \d+ s ago - nothing was done twice\./;

describe('duplicate-call guard', () => {
  it('returns the first reply for an identical write within 10 s and writes once', async () => {
    const campaign_id = campaign();
    const args = { campaign_id, kind: 'narration', text: 'The door opens.' };
    const first = await call('log_event', args);
    vi.advanceTimersByTime(3000);
    const second = await call('log_event', args);
    expect(events()).toBe(1);
    expect(textOf(first)).not.toMatch(DUPLICATE);
    expect(textOf(second)).toMatch(/Duplicate of the same call 3 s ago/);
    expect(textOf(second).startsWith(textOf(first))).toBe(true);
  });

  it('ignores key order in the arguments', async () => {
    const campaign_id = campaign();
    await call('remember', { op: 'fact', campaign_id, subject: 'Mira', fact: 'Mira owns the inn.' });
    const again = await call('remember', { fact: 'Mira owns the inn.', subject: 'Mira', campaign_id, op: 'fact' });
    expect(textOf(again)).toMatch(DUPLICATE);
    expect(db.prepare('SELECT COUNT(*) AS n FROM canon_fact').get()).toEqual({ n: 1 });
  });

  it('writes again when another write came between the two', async () => {
    const campaign_id = campaign();
    const args = { campaign_id, kind: 'narration', text: 'Again.' };
    await call('log_event', args);
    await call('log_event', { campaign_id, kind: 'narration', text: 'Between.' });
    expect(textOf(await call('log_event', args))).not.toMatch(DUPLICATE);
    expect(events()).toBe(3);
  });

  it('writes again after 10 s', async () => {
    const campaign_id = campaign();
    const args = { campaign_id, kind: 'narration', text: 'Rain falls.' };
    await call('log_event', args);
    vi.advanceTimersByTime(10_500);
    const later = await call('log_event', args);
    expect(textOf(later)).not.toMatch(DUPLICATE);
    expect(events()).toBe(2);
  });

  it('writes again when an argument differs', async () => {
    const campaign_id = campaign();
    await call('log_event', { campaign_id, kind: 'narration', text: 'One.' });
    const other = await call('log_event', { campaign_id, kind: 'narration', text: 'Two.' });
    expect(textOf(other)).not.toMatch(DUPLICATE);
    expect(events()).toBe(2);
  });

  it('does not cache an error reply', async () => {
    const args = { campaign_id: 1, kind: 'narration', text: 'Too early.' };
    const refused = await call('log_event', args);
    expect(refused.isError).toBe(true);
    expect(campaign()).toBe(1);
    const retry = await call('log_event', args);
    expect(retry.isError).toBeFalsy();
    expect(textOf(retry)).not.toMatch(DUPLICATE);
    expect(events()).toBe(1);
  });

  it('shares one run between concurrent identical calls', async () => {
    const campaign_id = campaign();
    const args = { campaign_id, kind: 'narration', text: 'At once.' };
    const [a, b] = await Promise.all([call('log_event', args), call('log_event', args)]);
    expect(events()).toBe(1);
    expect([textOf(a), textOf(b)].filter((t) => DUPLICATE.test(t))).toHaveLength(1);
  });

  it('never dedupes combat turn tools or dice', async () => {
    const campaign_id = campaign();
    for (const [name, args] of [
      ['attack', { campaign_id }],
      ['advance_turn', { campaign_id }],
      ['roll', { campaign_id, notation: '1d20' }],
    ] as const) {
      const first = await call(name, args);
      const second = await call(name, args);
      expect(textOf(first)).not.toMatch(DUPLICATE);
      expect(textOf(second)).not.toMatch(DUPLICATE);
    }
  });

  it('leaves read-only tools alone', async () => {
    const campaign_id = campaign();
    await call('get_battle_state', { campaign_id });
    expect(textOf(await call('get_battle_state', { campaign_id }))).not.toMatch(DUPLICATE);
  });
});
