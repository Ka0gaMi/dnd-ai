import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign, getCharacterSheet, party } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { setOverrides } from '../src/core/overrides.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { HOST, startHttpServer } from '../src/transport/http.js';

const SECRET = 'overridestestsecret0123456789abcd';

let db: Db;
let campaignId: number;
let characterId: number;
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
  campaignId = createCampaign(db, { name: 'Overrides', story_shape: 'sandbox' }).campaign_id;
  characterId = createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  }).character!.id;
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('sheet overrides', () => {
  it('layers the hand-set number over the computed one and names it', () => {
    const computed = getCharacterSheet(db, campaignId)!;
    expect(computed.hand_set).toEqual([]);

    setOverrides(db, characterId, { ac: 21, passive_perception: 19 });
    const sheet = getCharacterSheet(db, campaignId)!;
    expect(sheet.ac).toBe(21);
    expect(sheet.passive_perception).toBe(19);
    expect(sheet.hand_set.sort()).toEqual(['ac', 'passive_perception']);
    expect(sheet.proficiency_bonus).toBe(computed.proficiency_bonus);
  });

  it('restores the computed value when a field is cleared', () => {
    const computed = getCharacterSheet(db, campaignId)!.ac;
    setOverrides(db, characterId, { ac: 21 });
    setOverrides(db, characterId, { ac: null });
    const sheet = getCharacterSheet(db, campaignId)!;
    expect(sheet.ac).toBe(computed);
    expect(sheet.hand_set).toEqual([]);
    expect(db.prepare('SELECT overrides_json FROM character WHERE id = ?').get(characterId)).toEqual({
      overrides_json: null,
    });
  });

  it('writes speed and gold to their column instead of overriding them', () => {
    setOverrides(db, characterId, { speed: 40, gold: 120 });
    const sheet = getCharacterSheet(db, campaignId)!;
    expect(sheet).toMatchObject({ speed: 40, gold: 120, hand_set: [] });
    expect(db.prepare('SELECT speed, gold FROM character WHERE id = ?').get(characterId)).toEqual({
      speed: 40,
      gold: 120,
    });
  });

  it('refuses to clear speed or gold, which are stored values', () => {
    setOverrides(db, characterId, { speed: 40 });
    expect(() => setOverrides(db, characterId, { speed: null })).toThrow(/stored values/);
    expect(() => setOverrides(db, characterId, { gold: null })).toThrow(/stored values/);
    expect(getCharacterSheet(db, campaignId)!.speed).toBe(40);
  });

  it('writes exhaustion to its column like speed and gold', () => {
    setOverrides(db, characterId, { exhaustion: 3 });
    const sheet = getCharacterSheet(db, campaignId)!;
    expect(sheet).toMatchObject({ exhaustion: 3, hand_set: [] });
    expect(db.prepare('SELECT exhaustion FROM character WHERE id = ?').get(characterId)).toEqual({ exhaustion: 3 });
  });

  it('accepts exhaustion from 0 to 6 and refuses outside that range', () => {
    setOverrides(db, characterId, { exhaustion: 0 });
    expect(getCharacterSheet(db, campaignId)!.exhaustion).toBe(0);
    setOverrides(db, characterId, { exhaustion: 6 });
    expect(getCharacterSheet(db, campaignId)!.exhaustion).toBe(6);
    expect(() => setOverrides(db, characterId, { exhaustion: 7 })).toThrow(/0 to 6/);
    expect(() => setOverrides(db, characterId, { exhaustion: -1 })).toThrow(/0 to 6/);
    expect(getCharacterSheet(db, campaignId)!.exhaustion).toBe(6);
  });

  it('logs an exhaustion change with its old and new value', () => {
    setOverrides(db, characterId, { exhaustion: 2 });
    const events = db
      .prepare("SELECT text, payload_json FROM event WHERE campaign_id = ? AND kind = 'override' ORDER BY id")
      .all(campaignId) as Array<{ text: string; payload_json: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload_json)).toMatchObject({
      character_id: characterId,
      field: 'exhaustion',
      old: 0,
      new: 2,
    });
  });

  it('shows the hand-set AC on the party line as well as on the sheet', () => {
    setOverrides(db, characterId, { ac: 21 });
    expect(party(db, campaignId).pc).toMatchObject({ ac: 21 });
    expect(getCharacterSheet(db, campaignId)!.ac).toBe(21);
  });

  it('logs every change with its old and new value', () => {
    setOverrides(db, characterId, { ac: 21 });
    setOverrides(db, characterId, { ac: null });
    const events = db
      .prepare("SELECT text, payload_json FROM event WHERE campaign_id = ? AND kind = 'override' ORDER BY id")
      .all(campaignId) as Array<{ text: string; payload_json: string }>;
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[0]!.payload_json)).toMatchObject({ character_id: characterId, field: 'ac', new: 21 });
    expect(JSON.parse(events[1]!.payload_json)).toMatchObject({ field: 'ac', old: 21, new: null });
    expect(events[1]!.text).toContain('cleared');
  });

  it('keeps hand_set in the window snapshot and out of the tool replies', async () => {
    setOverrides(db, characterId, { ac: 21 });
    expect(campaignSnapshot(db, campaignId).pc).toMatchObject({ ac: 21, hand_set: ['ac'] });

    const client = await connect();
    const sheetTool = (await client.callTool({
      name: 'get_character_sheet',
      arguments: { campaign_id: campaignId },
    })) as unknown as { content: Array<{ text: string }>; structuredContent: { character: Record<string, unknown> } };
    expect(sheetTool.structuredContent.character.ac).toBe(21);
    expect(sheetTool.structuredContent.character).not.toHaveProperty('hand_set');
    expect(sheetTool.content[0]!.text).not.toContain('hand_set');

    const damaged = (await client.callTool({
      name: 'set_temp_hp',
      arguments: { campaign_id: campaignId, amount: 3 },
    })) as unknown as { content: Array<{ text: string }>; structuredContent: { character: Record<string, unknown> } };
    expect(damaged.structuredContent.character).toMatchObject({ ac: 21 });
    expect(damaged.structuredContent.character).not.toHaveProperty('hand_set');
    expect(damaged.content[0]!.text).not.toContain('hand_set');

    const briefing = (await client.callTool({
      name: 'load_campaign',
      arguments: { campaign_id: campaignId },
    })) as unknown as { content: Array<{ text: string }>; structuredContent: { pc: Record<string, unknown> } };
    expect(briefing.structuredContent.pc.ac).toBe(21);
    expect(briefing.structuredContent.pc).not.toHaveProperty('hand_set');
    expect(briefing.content[0]!.text).not.toContain('hand_set');
    await client.close();
  });
});

describe('overrides endpoint', () => {
  it('refuses while cheat mode is off', async () => {
    const res = await post(`/api/characters/${characterId}/overrides`, { ac: 21 });
    expect(res.status).toBe(403);
    expect(getCharacterSheet(db, campaignId)!.hand_set).toEqual([]);
  });

  it('hand-sets the sheet in cheat mode', async () => {
    updateSettings(db, campaignId, { cheat_mode: true });
    const res = await post(`/api/characters/${characterId}/overrides`, { ac: 21, speed: 40 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { overrides: Record<string, number>; character: Record<string, unknown> };
    expect(body.overrides).toEqual({ ac: 21 });
    expect(body.character).toMatchObject({ ac: 21, speed: 40, hand_set: ['ac'] });
  });

  it('rejects an unknown field and an unknown character', async () => {
    updateSettings(db, campaignId, { cheat_mode: true });
    expect((await post(`/api/characters/${characterId}/overrides`, { xp: 9000 })).status).toBe(400);
    expect((await post('/api/characters/999999/overrides', { ac: 21 })).status).toBe(404);
  });

  it('answers 400 when the player tries to clear speed or gold', async () => {
    updateSettings(db, campaignId, { cheat_mode: true });
    const res = await post(`/api/characters/${characterId}/overrides`, { speed: null });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('set a number');
  });

  it('answers 400 when exhaustion is set outside 0-6', async () => {
    updateSettings(db, campaignId, { cheat_mode: true });
    const tooHigh = await post(`/api/characters/${characterId}/overrides`, { exhaustion: 7 });
    expect(tooHigh.status).toBe(400);
    const tooLow = await post(`/api/characters/${characterId}/overrides`, { exhaustion: -1 });
    expect(tooLow.status).toBe(400);
    expect(getCharacterSheet(db, campaignId)!.exhaustion).toBe(0);
  });
});
