// What the player's window is told: a resumed session moves its session label on, and a roll the DM
// makes stays behind the screen unless the DM makes it public.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bus, type GameEvent } from '../src/core/bus.js';
import { campaignSnapshot, createCampaign, endSession, loadCampaign, saveCheckpoint } from '../src/core/campaign.js';
import { createCharacter, createCompanion } from '../src/core/character.js';
import { rollForTool } from '../src/core/rolls.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { HOST, startHttpServer } from '../src/transport/http.js';
import { replyData } from './helpers/reply.js';

let db: Db;
let base: string;
let stop: () => Promise<void>;
let campaignId: number;
let party: number[];
let pushed: GameEvent[];
let unsubscribe: () => void;

beforeAll(async () => {
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'windowlabels0123456789abcdef0123' });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

beforeEach(() => {
  // roll_mode auto: a player roll is made at once, so nothing waits on a click.
  campaignId = createCampaign(db, { name: 'Labels', story_shape: 'sandbox', settings: { roll_mode: 'auto' } }).campaign_id;
  const pc = createCharacter(db, {
    campaign_id: campaignId,
    name: 'Bram',
    species: 'Human',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception', 'insight'],
  }).character!.id;
  party = [pc, createCompanion(db, { campaign_id: campaignId, name: 'Wren', source: { creature: 'Mastiff' } }).companion!.id];
  pushed = [];
  unsubscribe = bus.subscribe((event) => {
    if (event.campaign_id === campaignId) pushed.push(event);
  });
});

afterEach(() => unsubscribe());

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'window-labels', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function roll(args: Record<string, unknown>): Promise<{ total: number | null; contest?: unknown }> {
  const client = await connect();
  const result = await client.callTool({ name: 'roll', arguments: { campaign_id: campaignId, ...args } });
  await client.close();
  expect(result.isError ?? false).toBe(false);
  return replyData(result);
}

/** The purposes in the player's dice panel, as the window fetches them. */
async function dicePanel(): Promise<string[]> {
  const rows = (await (await fetch(`${base}/api/campaigns/${campaignId}/rolls?limit=200`)).json()) as Array<{
    purpose: string;
  }>;
  return rows.map((row) => row.purpose);
}

/** Every text the player's window was told: the bus, the snapshot and the dice route. */
async function playerText(): Promise<string> {
  const snapshot = campaignSnapshot(db, campaignId, { forPlayer: true });
  return JSON.stringify([pushed, snapshot, await dicePanel()]);
}

describe('the session label after a resume', () => {
  it('tells an open window that the next session began, so its snapshot moves on', () => {
    saveCheckpoint(db, { campaign_id: campaignId, scene_title: 'The weir at night', scene_summary: 'They found Tobias.' });
    endSession(db, { campaign_id: campaignId });
    expect(campaignSnapshot(db, campaignId, { forPlayer: true }).session.number).toBe(1);
    pushed = [];

    loadCampaign(db, campaignId);

    expect(pushed.map((event) => [event.kind, event.text])).toEqual([['system', 'Session 2 began.']]);
    expect(campaignSnapshot(db, campaignId, { forPlayer: true }).session.number).toBe(2);
  });

  it('says nothing when the session is still open', () => {
    loadCampaign(db, campaignId);
    expect(pushed).toEqual([]);
  });
});

describe('a DM roll behind the screen', () => {
  it('hides a DM roll from the bus, the snapshot and the dice panel by default, but answers the DM', async () => {
    const answer = await roll({ expr: '1d2', purpose: 'Rat target: 1 = Bram, 2 = Wren' });

    expect(answer.total).toBeGreaterThanOrEqual(1);
    expect(await playerText()).not.toContain('Rat target');
    // The DM's own ledger still holds it, under a DM-only event.
    const row = db
      .prepare('SELECT e.kind AS kind FROM roll r JOIN event e ON e.id = r.event_id WHERE r.campaign_id = ?')
      .get(campaignId) as { kind: string };
    expect(row.kind).toBe('secret_roll');
  });

  it('hides a secret check composed from the sheet and both sides of a DM contest', async () => {
    await roll({ skill: 'perception', purpose: 'Spotting the cutpurse' });
    await roll({ skill: 'stealth', purpose: 'Slipping past the guard', contest: { opponent: { creature: 'Guard', skill: 'perception' } } });

    const told = await playerText();
    expect(told).not.toContain('Spotting the cutpurse');
    expect(told).not.toContain('Slipping past the guard');
  });

  it('shows a DM roll passed public: true', async () => {
    await roll({ expr: '1d6', purpose: 'Which road the cart takes', public: true });

    expect(await dicePanel()).toEqual(['Which road the cart takes']);
    expect(pushed.filter((event) => event.kind === 'roll').map((event) => event.text)).toEqual([
      expect.stringContaining('Which road the cart takes'),
    ]);
  });

  it("keeps the player's own rolls and group checks visible", async () => {
    await roll({ skill: 'athletics', purpose: 'Climbing the wall', roller: 'player' });
    await roll({ skill: 'athletics', purpose: 'Forcing the gate', roller: 'player', contest: { opponent: { bonus: 2, name: 'The gate' } } });
    await roll({ skill: 'perception', purpose: 'Listening at the door', group: party, dc: 10 });

    const panel = await dicePanel();
    expect(panel).toContain('Climbing the wall');
    expect(panel.filter((purpose) => purpose.includes('Forcing the gate'))).toHaveLength(2);
    expect(panel.filter((purpose) => purpose.startsWith('Listening at the door'))).toHaveLength(2);
  });

  it('leaves an engine roll the DM did not make through roll visible, as before', async () => {
    await rollForTool(db, { campaign_id: campaignId, expr: '1d20+2', purpose: 'Concentration save (Bless)', roller: 'dm' });
    expect(await dicePanel()).toEqual(['Concentration save (Bless)']);
  });
});
