import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bus, type GameEvent } from '../src/core/bus.js';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, grantInspiration } from '../src/core/character.js';
import { createGameServer } from '../src/mcp/server.js';
import {
  RollError,
  getPendingRoll,
  openPendingRolls,
  resolvePendingRoll,
  rollForTool,
  type PendingRollRow,
} from '../src/core/rolls.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { HOST, startHttpServer } from '../src/transport/http.js';

const SECRET = 'rollstestsecret0123456789abcdef01';

let db: Db;
let campaignId: number;
let base: string;
let stop: () => Promise<void>;

beforeAll(async () => {
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: SECRET });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

beforeEach(() => {
  campaignId = createCampaign(db, { name: 'Rolls', story_shape: 'sandbox' }).campaign_id;
});

function ask(overrides: Record<string, unknown> = {}): Promise<Awaited<ReturnType<typeof rollForTool>>> {
  return rollForTool(db, {
    expr: '1d20+5',
    purpose: 'Stealth check',
    dc: 12,
    roll_type: 'check',
    campaign_id: campaignId,
    roller: 'player',
    ...overrides,
  });
}

function openRoll(): PendingRollRow {
  const rows = openPendingRolls(db, campaignId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function rollRow(id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM roll WHERE id = ?').get(id) as Record<string, unknown>;
}

function preview(id: number): Promise<Response> {
  return fetch(`${base}/api/rolls/${id}/preview`, { method: 'POST' });
}

function resolve(id: number, body: unknown = {}): Promise<Response> {
  return fetch(`${base}/api/rolls/${id}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('player-clicked rolls', () => {
  it('waits for the player and returns what they rolled', async () => {
    const waiting = ask();
    const pending = openRoll();
    expect(pending).toMatchObject({ expr: '1d20+5', purpose: 'Stealth check', dc: 12, roll_type: 'check' });

    const rolled = resolvePendingRoll(db, pending.id);
    const result = await waiting;

    expect(result.id).toBe(rolled.id);
    expect(result.total).toBe(rolled.total);
    expect(getPendingRoll(db, pending.id)).toMatchObject({ source: 'player' });
    expect(rollRow(result.id!)).toMatchObject({ overridden: 0, purpose: 'Stealth check' });
  });

  it('pushes the pending roll to the companion window', async () => {
    const events: GameEvent[] = [];
    const unsubscribe = bus.subscribe((event) => events.push(event));
    const waiting = ask({ purpose: 'Dexterity save', roll_type: 'save', dc: 15 });
    const pending = openRoll();
    resolvePendingRoll(db, pending.id);
    await waiting;
    unsubscribe();

    const pushed = events.find((e) => e.kind === 'pending_roll');
    expect(pushed).toMatchObject({ campaign_id: campaignId, event_id: null, text: 'Dexterity save vs DC 15' });
    expect(pushed?.payload).toMatchObject({ id: pending.id, expr: '1d20+5', roll_type: 'save', advantage: 'none' });
  });

  it('rolls it server-side when the player does not answer in time', async () => {
    updateSettings(db, campaignId, { roll_timeout_s: 1 });
    const result = await ask();
    expect(result.id).not.toBeNull();
    expect(openPendingRolls(db, campaignId)).toHaveLength(0);
    expect(db.prepare('SELECT source FROM pending_roll WHERE campaign_id = ?').get(campaignId)).toEqual({
      source: 'auto',
    });
  });

  it('rolls straight away in auto mode and for the DM', async () => {
    updateSettings(db, campaignId, { roll_mode: 'auto' });
    const auto = await ask();
    expect(auto.total).toBeGreaterThan(0);

    updateSettings(db, campaignId, { roll_mode: 'player' });
    const dm = await ask({ roller: 'dm' });
    expect(dm.total).toBeGreaterThan(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pending_roll WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 0 });
  });

  it('records the luck dial on the roll row and nowhere else', async () => {
    updateSettings(db, campaignId, { luck_bias: 2, roll_mode: 'auto' });
    const result = await ask();
    expect(rollRow(result.id!)).toMatchObject({ luck_bias_applied: 2, expr: '3d20kh1+5' });
    expect(result).not.toHaveProperty('luck_bias');
  });

  it('leaves the dice the DM rolls for monsters alone: the dial is the player’s only', async () => {
    updateSettings(db, campaignId, { luck_bias: 2 });
    const result = await ask({ roller: 'dm' });
    expect(rollRow(result.id!)).toMatchObject({ luck_bias_applied: 0, expr: '1d20+5' });
  });

  it('keeps the pool the dial rolled out of what the DM reads back', async () => {
    updateSettings(db, campaignId, { luck_bias: 2, roll_mode: 'auto' });
    const result = await ask();
    // What the tool answers with: the roll that was asked for, and only the die that was kept.
    expect(result.expr).toBe('1d20+5');
    expect(result.output).toContain('1d20+5');
    expect(result.output).not.toContain('3d20');
    expect(JSON.stringify(result.groups)).not.toBe('');

    const event = db.prepare('SELECT text, payload_json FROM event WHERE kind = ? ORDER BY id DESC').get('roll') as {
      text: string;
      payload_json: string;
    };
    expect(event.text).toContain('1d20+5');
    expect(event.text).not.toContain('3d20');
    expect(JSON.parse(event.payload_json) as { expr: string }).toMatchObject({ expr: '1d20+5' });

    // The player's ledger still shows every die the dial rolled, dropped ones included.
    const ledger = (await (await fetch(`${base}/api/campaigns/${campaignId}/rolls`)).json()) as Array<{
      id: number;
      expr: string;
      groups: Array<{ dice: unknown[] }>;
    }>;
    const row = ledger.find((r) => r.id === result.id)!;
    expect(row.expr).toBe('3d20kh1+5');
    expect(row.groups[0]!.dice).toHaveLength(3);
  });

  it('refuses an override without cheat mode', () => {
    const waiting = ask();
    const pending = openRoll();
    expect(() => resolvePendingRoll(db, pending.id, { dice: [20] })).toThrow(RollError);
    expect(getPendingRoll(db, pending.id)?.resolved_at).toBeNull();
    resolvePendingRoll(db, pending.id);
    return waiting;
  });
});

describe('resolve endpoint', () => {
  it('resolves the roll the DM is waiting on', async () => {
    const waiting = ask();
    const pending = openRoll();
    const res = await resolve(pending.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; total: number };
    const result = await waiting;
    expect(result.id).toBe(body.id);
    expect(result.total).toBe(body.total);
  });

  it('answers 403 for an override while cheat mode is off', async () => {
    const waiting = ask();
    const pending = openRoll();
    const res = await resolve(pending.id, { override: { dice: [20] } });
    expect(res.status).toBe(403);
    expect(getPendingRoll(db, pending.id)?.resolved_at).toBeNull();
    resolvePendingRoll(db, pending.id);
    await waiting;
  });

  it('takes the dice the player set in cheat mode and keeps the flag out of the tool result', async () => {
    updateSettings(db, campaignId, { cheat_mode: true });
    const waiting = ask();
    const pending = openRoll();
    const res = await resolve(pending.id, { override: { dice: [20] } });
    expect(res.status).toBe(200);

    const result = await waiting;
    expect(result.total).toBe(25);
    expect(result.natural).toBe(20);
    expect(result.outcome).toBe('success');
    expect(Object.keys(result)).toEqual(
      expect.not.arrayContaining(['overridden', 'source', 'original', 'luck_bias_applied']),
    );
    expect(result.output).toBe('1d20+5: [20]+5 = 25');

    expect(rollRow(result.id!)).toMatchObject({ overridden: 1, total: 25 });
    // The player window greys an edited roll out, so the log endpoint has to say which one it was.
    const log = (await (await fetch(`${base}/api/campaigns/${campaignId}/rolls`)).json()) as Array<{
      id: number;
      overridden: number;
    }>;
    expect(log.find((r) => r.id === result.id)?.overridden).toBe(1);
    const stored = JSON.parse(getPendingRoll(db, pending.id)!.result_json!) as {
      overridden: boolean;
      source: string;
      original: { total: number };
    };
    expect(stored).toMatchObject({ overridden: true, source: 'override' });
    expect(typeof stored.original.total).toBe('number');
  });

  it('answers 409 when the roll was already resolved and 404 when it never existed', async () => {
    const waiting = ask();
    const pending = openRoll();
    expect((await resolve(pending.id)).status).toBe(200);
    expect((await resolve(pending.id)).status).toBe(409);
    expect((await resolve(999_999)).status).toBe(404);
    await waiting;
  });

  it('refuses dice the expression cannot roll and leaves the card waiting', async () => {
    updateSettings(db, campaignId, { cheat_mode: true });
    const waiting = ask();
    const pending = openRoll();

    expect((await resolve(pending.id, { override: { dice: [21] } })).status).toBe(400);
    expect((await resolve(pending.id, { override: { dice: [0] } })).status).toBe(400);
    expect((await resolve(pending.id, { override: { dice: [10, 10] } })).status).toBe(400);
    // A total on its own is not an edit any more: the dice are what cheat mode sets.
    const refused = await resolve(pending.id, { override: { total: 30 } });
    expect(refused.status).toBe(400);
    expect((await refused.json()) as { error: string }).toMatchObject({ error: expect.stringContaining('dice') });
    expect(getPendingRoll(db, pending.id)?.resolved_at).toBeNull();

    expect((await resolve(pending.id, { override: { dice: [14] } })).status).toBe(200);
    expect((await waiting).total).toBe(19);
  });

  it('lists the rolls still waiting for the player', async () => {
    const waiting = ask();
    const res = await fetch(`${base}/api/campaigns/${campaignId}/pending-rolls`);
    expect(res.status).toBe(200);
    expect((await res.json()) as PendingRollRow[]).toHaveLength(1);
    resolvePendingRoll(db, openRoll().id);
    await waiting;
  });
});

describe('preview endpoint', () => {
  it('rolls once and lets accepting it stand on those dice', async () => {
    updateSettings(db, campaignId, { cheat_mode: true });
    const waiting = ask();
    const pending = openRoll();

    const res = await preview(pending.id);
    expect(res.status).toBe(200);
    const shown = (await res.json()) as { id: number | null; total: number; groups: unknown[] };
    expect(shown.id).toBeNull();
    expect(shown.groups.length).toBeGreaterThan(0);

    // Asking twice shows the same roll: the dice are not rolled again behind the player's back.
    const again = (await (await preview(pending.id)).json()) as { total: number };
    expect(again.total).toBe(shown.total);

    expect((await resolve(pending.id)).status).toBe(200);
    const result = await waiting;
    expect(result.total).toBe(shown.total);
    expect(rollRow(result.id!)).toMatchObject({ total: shown.total, overridden: 0 });
  });

  it('keeps the previewed roll as the original when the player edits it', async () => {
    updateSettings(db, campaignId, { cheat_mode: true });
    const waiting = ask();
    const pending = openRoll();
    const shown = (await (await preview(pending.id)).json()) as { total: number };

    expect((await resolve(pending.id, { override: { dice: [20] } })).status).toBe(200);
    const result = await waiting;
    expect(result.total).toBe(25);
    const stored = JSON.parse(getPendingRoll(db, pending.id)!.result_json!) as { original: { total: number } };
    expect(stored.original.total).toBe(shown.total);
  });

  it('answers 403 without cheat mode, 409 once resolved and 404 when it never existed', async () => {
    const waiting = ask();
    const pending = openRoll();
    expect((await preview(pending.id)).status).toBe(403);

    updateSettings(db, campaignId, { cheat_mode: true });
    expect((await preview(pending.id)).status).toBe(200);
    expect((await resolve(pending.id)).status).toBe(200);
    expect((await preview(pending.id)).status).toBe(409);
    expect((await preview(999_999)).status).toBe(404);
    await waiting;
  });
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** The PC every roll in here belongs to, for the dials that only apply to them. */
function makePc(): void {
  createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
}

/** A tool call reaches the server a tick later, so its card takes a moment to appear. */
async function waitForOpenRoll(): Promise<PendingRollRow> {
  for (let tries = 0; tries < 100; tries += 1) {
    const open = openPendingRolls(db, campaignId);
    if (open.length > 0) return open[0]!;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('No roll was asked for.');
}

describe('the roller reminder', () => {
  const rollText = async (client: Client, args: Record<string, unknown>): Promise<string> => {
    const result = await client.callTool({ name: 'roll', arguments: { expr: '1d20+5', purpose: 'Stealth check', ...args } });
    return (result.content as Array<{ text: string }>)[0]!.text;
  };

  const REMINDER = 'Pass roller: "player"';

  beforeEach(makePc);

  it('nudges the DM once when roller was left off a roll the player would click', async () => {
    const client = await connect();
    const text = await rollText(client, { campaign_id: campaignId, roll_type: 'check' });
    expect(text).toContain('Reminder: this looks like a roll for the player.');
    expect(text.match(/Pass roller/g)).toHaveLength(1);
    expect(text).toContain('"total"');
    await client.close();
  });

  it('stays quiet for a damage roll, a stated roller and automatic rolls', async () => {
    const client = await connect();
    expect(await rollText(client, { campaign_id: campaignId, roll_type: 'damage' })).not.toContain(REMINDER);
    expect(await rollText(client, { campaign_id: campaignId, roller: 'dm' })).not.toContain(REMINDER);
    expect(await rollText(client, {})).not.toContain(REMINDER);

    updateSettings(db, campaignId, { roll_mode: 'auto' });
    expect(await rollText(client, { campaign_id: campaignId, roll_type: 'save' })).not.toContain(REMINDER);
    await client.close();
  });
});

describe('heroic inspiration in the roll flow', () => {
  const inspire = (id: number): Promise<Response> => fetch(`${base}/api/rolls/${id}/inspire`, { method: 'POST' });

  const pcInspiration = (): number =>
    (db.prepare('SELECT inspiration FROM character WHERE campaign_id = ? AND is_pc = 1').get(campaignId) as {
      inspiration: number;
    }).inspiration;

  beforeEach(() => {
    makePc();
    grantInspiration(db, { campaign_id: campaignId });
  });

  it('shows the d20 first, then buys a second one with the inspiration', async () => {
    const waiting = ask();
    const pending = openRoll();
    // No cheat mode here: the provisional roll is what the reroll is decided on.
    const shown = (await (await preview(pending.id)).json()) as { total: number };

    const res = await inspire(pending.id);
    expect(res.status).toBe(200);
    const rerolled = (await res.json()) as { total: number; inspired: { from: number; to: number } };
    expect(rerolled.inspired).toEqual({ from: shown.total, to: rerolled.total });

    const result = await waiting;
    expect(result.total).toBe(rerolled.total);
    expect(result.inspired).toEqual(rerolled.inspired);
    expect(pcInspiration()).toBe(0);

    const event = db.prepare("SELECT text FROM event WHERE kind = 'inspiration' ORDER BY id DESC").get() as {
      text: string;
    };
    expect(event.text).toBe(`Borg spends Heroic Inspiration: ${shown.total} → ${rerolled.total}`);
    const stored = JSON.parse(getPendingRoll(db, pending.id)!.result_json!) as {
      original: { total: number };
      inspired: { from: number; to: number };
    };
    expect(stored.original.total).toBe(shown.total);
    expect(stored.inspired.to).toBe(rerolled.total);
  });

  it('has nothing left to spend on the next roll', async () => {
    const first = ask();
    const one = openRoll();
    await preview(one.id);
    expect((await inspire(one.id)).status).toBe(200);
    await first;

    const second = ask();
    const two = openRoll();
    expect((await preview(two.id)).status).toBe(403);
    expect((await inspire(two.id)).status).toBe(409);
    resolvePendingRoll(db, two.id);
    await second;
  });

  it('is never offered on a damage roll', async () => {
    const waiting = ask({ expr: '2d6+3', purpose: 'Greatsword damage', roll_type: 'damage', dc: undefined });
    const pending = openRoll();
    expect((await preview(pending.id)).status).toBe(403);
    expect((await inspire(pending.id)).status).toBe(400);
    expect(pcInspiration()).toBe(1);
    resolvePendingRoll(db, pending.id);
    await waiting;
  });

  it('tells the DM the reroll was bought with it', async () => {
    const client = await connect();
    const running = client.callTool({
      name: 'roll',
      arguments: {
        expr: '1d20+5',
        purpose: 'Stealth check',
        dc: 12,
        roll_type: 'check',
        campaign_id: campaignId,
        roller: 'player',
      },
    });
    const pending = await waitForOpenRoll();
    const shown = (await (await preview(pending.id)).json()) as { total: number };
    const rerolled = (await (await inspire(pending.id)).json()) as { total: number };

    const answer = (await running) as unknown as { content: Array<{ text: string }> };
    expect(answer.content[0]!.text).toContain(
      `Heroic Inspiration spent (rerolled ${shown.total} → ${rerolled.total}).`,
    );
    await client.close();
  });
});
