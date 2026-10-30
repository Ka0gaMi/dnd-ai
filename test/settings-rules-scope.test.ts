import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { bus, type GameEvent } from '../src/core/bus.js';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { resolveDecision, type PendingDecisionRow } from '../src/core/decisions.js';
import { PLAYER_ONLY_SETTINGS, getSettings, updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { replyData } from './helpers/reply.js';

let db: Db;
let campaignId: number;

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** What settings_json holds, read straight off the row. */
function stored(): Record<string, unknown> {
  const row = db.prepare('SELECT settings_json FROM campaign WHERE id = ?').get(campaignId) as { settings_json: string };
  return JSON.parse(row.settings_json) as Record<string, unknown>;
}

/** Writes settings_json as an old campaign saved it, past the validation a write goes through now. */
function storeRaw(settings: Record<string, unknown>): void {
  db.prepare('UPDATE campaign SET settings_json = ? WHERE id = ?').run(JSON.stringify(settings), campaignId);
}

/** The payloads of the settings events a call sends the window. */
function settingsEvents(run: () => void): unknown[] {
  const events: GameEvent[] = [];
  const unsubscribe = bus.subscribe((event) => events.push(event));
  try {
    run();
  } finally {
    unsubscribe();
  }
  return events.filter((event) => event.kind === 'settings').map((event) => event.payload);
}

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Rules Scope', story_shape: 'sandbox' }).campaign_id;
});

afterEach(() => db.close());

describe('rules_mode without strict', () => {
  it('reads a stored strict as flexible and keeps the rest of what is stored', () => {
    storeRaw({ rules_mode: 'strict', lines: 'no spiders' });
    expect(getSettings(db, campaignId)).toMatchObject({ rules_mode: 'flexible', lines: 'no spiders' });
    // A patch that leaves rules_mode alone answers with flexible as well.
    expect(updateSettings(db, campaignId, { difficulty: 'deadly' })).toMatchObject({
      rules_mode: 'flexible',
      difficulty: 'deadly',
      lines: 'no spiders',
    });
  });

  it('stores flexible when a client still writes strict, and tells the window flexible', () => {
    const payloads = settingsEvents(() => {
      expect(updateSettings(db, campaignId, { rules_mode: 'strict' as never }).rules_mode).toBe('flexible');
    });
    expect(stored().rules_mode).toBe('flexible');
    expect(payloads).toEqual([{ rules_mode: 'flexible' }]);
  });

  it('offers only flexible and freeform, and no tool mentions strict', async () => {
    let error: unknown;
    try {
      updateSettings(db, campaignId, { rules_mode: 'lenient' as never });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(z.ZodError);
    expect((error as z.ZodError).issues[0]).toMatchObject({ path: ['rules_mode'], values: ['flexible', 'freeform'] });
    expect(updateSettings(db, campaignId, { rules_mode: 'freeform' }).rules_mode).toBe('freeform');

    const client = await connect();
    const { tools } = await client.listTools();
    expect(JSON.stringify(tools)).not.toMatch(/\bstrict\b/i);
    await client.close();
  });
});

describe('over-budget homebrew in a flexible campaign', () => {
  /** Three always-on clauses: well over a feat's worth. */
  const TRAPWRIGHT = {
    name: 'Trapwright',
    text: 'Your snares catch what walks past them.',
    mechanics: {},
    clauses: [
      { when: 'roll', if: { kind: 'attack' }, do: [{ kind: 'bonus', to: 'attack', amount: 1 }] },
      { when: 'always', do: [{ kind: 'bonus', to: 'ac', amount: 1 }] },
      { when: 'always', do: [{ kind: 'speed_ft', amount: 10 }] },
    ],
    justification: 'They have rigged a trap in every fight this chapter.',
  };

  beforeEach(() => {
    createCharacter(db, {
      campaign_id: campaignId,
      name: 'Vex',
      species: 'Human',
      class: 'Rogue',
      background: 'Criminal',
      ability_method: 'standard_array',
      abilities: { str: 8, dex: 15, con: 14, int: 13, wis: 12, cha: 10 },
      ability_bonuses: { dex: 2, int: 1 },
      skill_choices: ['acrobatics', 'perception', 'persuasion', 'athletics', 'survival'],
    });
  });

  it.each([
    ['by default', () => undefined],
    ['when the campaign was stored as strict', () => storeRaw({ rules_mode: 'strict' })],
  ])('still goes to the player %s', async (_label, setup) => {
    setup();
    // Stands in for a player who accepts the dialog the moment it appears.
    const stop = bus.subscribe((event) => {
      if (event.kind !== 'pending_decision') return;
      resolveDecision(db, (event.payload as PendingDecisionRow).id, { decision: 'accept' });
    });
    const client = await connect();
    const result = await client.callTool({ name: 'propose', arguments: { op: 'feature', campaign_id: campaignId, ...TRAPWRIGHT } });
    stop();
    await client.close();

    expect(result.isError).toBeFalsy();
    expect(replyData(result)).toMatchObject({
      status: 'applied',
      report: { verdict: 'over_budget' },
      decision: { summary: 'Player accepted "Trapwright" despite the over-budget warning.' },
    });
    expect(db.prepare('SELECT kind FROM pending_decision WHERE campaign_id = ?').all(campaignId)).toEqual([
      { kind: 'homebrew_feature' },
    ]);
  });
});

describe('dc_disclosure', () => {
  it('defaults to hidden and round-trips shown', () => {
    expect(getSettings(db, campaignId).dc_disclosure).toBe('hidden');
    expect(updateSettings(db, campaignId, { dc_disclosure: 'shown' }).dc_disclosure).toBe('shown');
    expect(getSettings(db, campaignId).dc_disclosure).toBe('shown');
    expect(stored().dc_disclosure).toBe('shown');

    expect(() => updateSettings(db, campaignId, { dc_disclosure: 'always' as never })).toThrow();
    expect(updateSettings(db, campaignId, { dc_disclosure: 'hidden' }).dc_disclosure).toBe('hidden');
    expect(getSettings(db, campaignId).dc_disclosure).toBe('hidden');
  });

  it('reaches the window in the settings event and is a table setting, not one of the player-only dials', () => {
    expect(settingsEvents(() => updateSettings(db, campaignId, { dc_disclosure: 'shown' }))).toEqual([
      { dc_disclosure: 'shown' },
    ]);
    expect(PLAYER_ONLY_SETTINGS as readonly string[]).not.toContain('dc_disclosure');
  });
});
