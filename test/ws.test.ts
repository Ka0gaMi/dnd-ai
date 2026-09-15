import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createCampaign, endSession, logEvent, saveCheckpoint } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { setOverrides } from '../src/core/overrides.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { HOST, startHttpServer } from '../src/transport/http.js';

let db: Db;
let url: string;
let origin: string;
let stop: () => Promise<void>;

beforeAll(async () => {
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'wssecret' });
  url = `ws://${HOST}:${started.port}/ws`;
  origin = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

function nextMessage(socket: WebSocket): Promise<{ type: string; data?: unknown; event?: unknown }> {
  return new Promise((resolve) => socket.once('message', (raw) => resolve(JSON.parse(String(raw)))));
}

describe('websocket seam', () => {
  it('sends a snapshot on subscribe and then forwards events', async () => {
    const { campaign_id } = createCampaign(db, { name: 'Watched', story_shape: 'sandbox' });
    const socket = new WebSocket(url);
    await new Promise((resolve) => socket.once('open', resolve));

    socket.send(JSON.stringify({ type: 'subscribe', campaignId: campaign_id }));
    const snapshot = await nextMessage(socket);
    expect(snapshot.type).toBe('snapshot');
    expect((snapshot.data as { campaign: { name: string } }).campaign.name).toBe('Watched');

    const pending = nextMessage(socket);
    logEvent(db, { campaign_id, kind: 'narration', text: 'A bell rang.' });
    const pushed = await pending;
    expect(pushed.type).toBe('event');
    expect((pushed.event as { text: string }).text).toBe('A bell rang.');

    socket.close();
  });

  it('keeps the hand-set marker in the snapshot the player window gets', async () => {
    const { campaign_id } = createCampaign(db, { name: 'Hand set', story_shape: 'sandbox' });
    const character = createCharacter(db, {
      campaign_id,
      name: 'Borg',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    }).character!.id;
    setOverrides(db, character, { ac: 21 });

    const socket = new WebSocket(url);
    await new Promise((resolve) => socket.once('open', resolve));
    socket.send(JSON.stringify({ type: 'subscribe', campaignId: campaign_id }));
    const snapshot = await nextMessage(socket);
    expect((snapshot.data as { pc: { ac: number; hand_set: string[] } }).pc).toMatchObject({
      ac: 21,
      hand_set: ['ac'],
    });

    socket.close();
  });

  it('keeps the player dials in the snapshot the player window gets', async () => {
    const { campaign_id } = createCampaign(db, { name: 'Dials', story_shape: 'sandbox' });
    updateSettings(db, campaign_id, { cheat_mode: true, luck_bias: 2, roll_mode: 'auto', visibility: 'full' });

    const socket = new WebSocket(url);
    await new Promise((resolve) => socket.once('open', resolve));
    socket.send(JSON.stringify({ type: 'subscribe', campaignId: campaign_id }));
    const snapshot = await nextMessage(socket);
    expect((snapshot.data as { campaign: { settings: Record<string, unknown> } }).campaign.settings).toMatchObject({
      cheat_mode: true,
      luck_bias: 2,
      roll_mode: 'auto',
      visibility: 'full',
    });

    socket.close();
  });

  it('subscribes without opening a new session after end_session', () => {
    const { campaign_id } = createCampaign(db, { name: 'Ended', story_shape: 'sandbox' });
    saveCheckpoint(db, { campaign_id, scene_summary: 'They made camp.' });
    endSession(db, { campaign_id });
    const sessions = () =>
      (db.prepare('SELECT id, number, ended_at FROM session WHERE campaign_id = ? ORDER BY id').all(campaign_id));
    const before = sessions();

    return new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { origin });
      socket.once('open', () => socket.send(JSON.stringify({ type: 'subscribe', campaignId: campaign_id })));
      socket.once('message', (raw) => {
        try {
          const message = JSON.parse(String(raw)) as { type: string; data: { session: { number: number } } };
          expect(message.type).toBe('snapshot');
          expect(message.data.session.number).toBe(1);
          expect(sessions()).toEqual(before);
          resolve();
        } catch (err) {
          reject(err as Error);
        } finally {
          socket.close();
        }
      });
    });
  });

  it('refuses a connection from a foreign origin', async () => {
    const socket = new WebSocket(url, { origin: 'http://evil.example' });
    const code = await new Promise<number>((resolve) => socket.once('close', resolve));
    expect(code).toBe(1008);
  });

  it('accepts a connection from the server origin', async () => {
    const socket = new WebSocket(url, { origin });
    await new Promise((resolve) => socket.once('open', resolve));
    socket.close();
  });
});
