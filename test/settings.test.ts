import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, type GameEvent } from '../src/core/bus.js';
import { campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import {
  DEFAULT_SETTINGS,
  PLAYER_ONLY_SETTINGS,
  getSettings,
  updateSettings,
} from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';

async function connect(database: Db): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(database).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Settings Test', story_shape: 'sandbox' }).campaign_id;
});

describe('campaign settings', () => {
  it('defaults when nothing was ever stored', () => {
    expect(getSettings(db, campaignId)).toEqual(DEFAULT_SETTINGS);
  });

  it('merges a patch over the current settings without dropping unrelated fields', () => {
    updateSettings(db, campaignId, { visibility: 'full', luck_bias: 1 });
    const first = getSettings(db, campaignId);
    expect(first).toMatchObject({ visibility: 'full', luck_bias: 1, roll_mode: 'player' });

    updateSettings(db, campaignId, { roll_mode: 'auto' });
    const second = getSettings(db, campaignId);
    expect(second).toMatchObject({ visibility: 'full', luck_bias: 1, roll_mode: 'auto' });
  });

  it('preserves unknown keys already present in settings_json', () => {
    const withExtra = createCampaign(db, {
      name: 'Has Extra',
      story_shape: 'sandbox',
      settings: { visibility: 'hidden', some_future_field: 'kept' },
    }).campaign_id;

    updateSettings(db, withExtra, { luck_bias: -1 });
    const row = db.prepare('SELECT settings_json FROM campaign WHERE id = ?').get(withExtra) as {
      settings_json: string;
    };
    expect(JSON.parse(row.settings_json)).toMatchObject({ some_future_field: 'kept', luck_bias: -1 });
  });

  it('rejects an invalid patch', () => {
    expect(() => updateSettings(db, campaignId, { visibility: 'nonsense' as never })).toThrow();
    expect(() => updateSettings(db, campaignId, { luck_bias: 99 })).toThrow();
  });

  it('takes the three player_rolls settings and nothing else', () => {
    expect(getSettings(db, campaignId).player_rolls).toBe('all');
    expect(updateSettings(db, campaignId, { player_rolls: 'd20_only' }).player_rolls).toBe('d20_only');
    expect(updateSettings(db, campaignId, { player_rolls: 'none' }).player_rolls).toBe('none');
    expect(() => updateSettings(db, campaignId, { player_rolls: 'some' as never })).toThrow();
    expect(getSettings(db, campaignId).player_rolls).toBe('none');
  });

  it('caps the roll timeout at ten minutes', () => {
    expect(updateSettings(db, campaignId, { roll_timeout_s: 600 }).roll_timeout_s).toBe(600);
    expect(() => updateSettings(db, campaignId, { roll_timeout_s: 601 })).toThrow();
    expect(getSettings(db, campaignId).roll_timeout_s).toBe(600);
  });

  it('emits a settings event on the bus', () => {
    const events: GameEvent[] = [];
    const unsubscribe = bus.subscribe((event) => events.push(event));
    updateSettings(db, campaignId, { cheat_mode: true });
    unsubscribe();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ campaign_id: campaignId, kind: 'settings' });
  });
});

describe('the table settings the DM sees', () => {
  it('defaults to standard difficulty, standard treasure and the rules coach on', () => {
    expect(getSettings(db, campaignId)).toMatchObject({
      difficulty: 'standard',
      treasure_pacing: 'standard',
      rules_coach: true,
    });
    expect(PLAYER_ONLY_SETTINGS as readonly string[]).not.toContain('difficulty');
    expect(PLAYER_ONLY_SETTINGS as readonly string[]).not.toContain('treasure_pacing');
    expect(PLAYER_ONLY_SETTINGS as readonly string[]).not.toContain('rules_coach');
  });

  it('takes only the values the rules allow', () => {
    expect(updateSettings(db, campaignId, { difficulty: 'deadly' }).difficulty).toBe('deadly');
    expect(updateSettings(db, campaignId, { treasure_pacing: 'sparse' }).treasure_pacing).toBe('sparse');
    expect(updateSettings(db, campaignId, { rules_coach: false }).rules_coach).toBe(false);
    expect(() => updateSettings(db, campaignId, { difficulty: 'brutal' as never })).toThrow();
    expect(() => updateSettings(db, campaignId, { treasure_pacing: 'rich' as never })).toThrow();
  });

  it('states all three in the briefing, and turns the coach line off with the setting', async () => {
    const client = await connect(db);
    const briefing = async (): Promise<string> => {
      const loaded = (await client.callTool({
        name: 'load_campaign',
        arguments: { campaign_id: campaignId },
      })) as unknown as { content: Array<{ text: string }> };
      return loaded.content[0]!.text;
    };

    const first = await briefing();
    expect(first).toContain(
      'Difficulty: standard — encounter budgets are normalised for a solo party; a fight the player deliberately picks keeps its real strength.',
    );
    expect(first).toContain('Treasure pacing: standard');
    expect(first).toContain('Rules coach: on — the first time a rule matters this session, explain it in one sentence');

    updateSettings(db, campaignId, { difficulty: 'deadly', treasure_pacing: 'generous', rules_coach: false });
    const second = await briefing();
    expect(second).toContain('Difficulty: deadly');
    expect(second).toContain('Treasure pacing: generous');
    expect(second).toContain('Rules coach: off — do not explain rules unless asked');
    await client.close();
  });
});

describe('the player-only dials', () => {
  it('stays out of load_campaign, text and structured alike, but not out of the window snapshot', async () => {
    updateSettings(db, campaignId, {
      cheat_mode: true,
      luck_bias: 2,
      roll_mode: 'auto',
      player_rolls: 'none',
      roll_timeout_s: 30,
      visibility: 'full',
      lines: 'no harm to children',
    });

    const client = await connect(db);
    const loaded = (await client.callTool({
      name: 'load_campaign',
      arguments: { campaign_id: campaignId },
    })) as unknown as { content: Array<{ text: string }>; structuredContent: { campaign: { settings: unknown } } };
    const text = loaded.content[0]!.text;
    for (const key of PLAYER_ONLY_SETTINGS) {
      expect(text).not.toContain(key);
      expect(JSON.stringify(loaded.structuredContent)).not.toContain(key);
    }
    // What is left is still shown to the DM.
    expect(loaded.structuredContent.campaign.settings).toEqual({ lines: 'no harm to children' });
    expect(text).toContain('Settings: {"lines":"no harm to children"}');
    await client.close();

    const snapshot = campaignSnapshot(db, campaignId).campaign.settings as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      cheat_mode: true,
      luck_bias: 2,
      roll_mode: 'auto',
      player_rolls: 'none',
      roll_timeout_s: 30,
      visibility: 'full',
    });
  });
});
