import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, campaignSnapshot } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { findPreset, settingPresets, toneDialWords } from '../src/core/presets.js';
import { getSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { registerPrompts } from '../src/mcp/prompts.js';
import { registerCampaignTools } from '../src/mcp/tools/campaign.js';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

/** Only the campaign tools and the prompts: the wizard does not need the rest of the server. */
async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'wizard-test', version: '0.0.0' });
  registerCampaignTools(server, db);
  registerPrompts(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('setting presets', () => {
  it('loads the bundled preset file', () => {
    const file = settingPresets();
    expect(file.presets).toHaveLength(14);
    expect(file.tone_dials).toHaveLength(6);
    expect(file.session_zero_fields.map((f) => f.id)).toEqual(['lines', 'veils']);
    for (const preset of file.presets) {
      expect(preset.pitch.length).toBeGreaterThan(20);
      expect(preset.sample_hooks.length).toBeGreaterThan(0);
    }
    expect(settingPresets()).toBe(file);
  });

  it('finds a preset and words a dial value', () => {
    expect(findPreset('classic-high-fantasy')?.name).toBe('Classic High Fantasy');
    expect(findPreset('space-opera')).toBeUndefined();
    expect(toneDialWords('lethality', 2)).toContain('Lethality');
    expect(toneDialWords('lethality', 2)).toContain('Fair');
  });
});

describe('create_campaign settings', () => {
  it('takes the setting preset, dials, lines and veils from a chat-created story', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'create_campaign',
      arguments: {
        name: 'The Mistward',
        story_shape: 'structured',
        settings: { setting_preset: 'gothic-horror', tone_dials: { horror: 3 }, lines: 'x', veils: 'y', needs_ai_fill: true },
      },
    });
    const { campaign_id } = result.structuredContent as { campaign_id: number };
    expect(getSettings(db, campaign_id)).toMatchObject({
      setting_preset: 'gothic-horror',
      tone_dials: { horror: 3 },
      lines: 'x',
      veils: 'y',
      needs_ai_fill: true,
    });
  });
});

describe('mark_story_filled', () => {
  it('writes the premise the DM invented and clears the flag', async () => {
    const { campaign_id } = createCampaign(db, {
      name: 'The Mistward',
      story_shape: 'structured',
      settings: { setting_preset: 'gothic-horror' },
    });
    expect(getSettings(db, campaign_id).needs_ai_fill).toBe(true);

    const client = await connect();
    const result = await client.callTool({
      name: 'mark_story_filled',
      arguments: { campaign_id, premise: 'A fog-bound village where no one has aged in fifty years.' },
    });

    expect(result.structuredContent).toMatchObject({ campaign_id, needs_ai_fill: false });
    expect(getSettings(db, campaign_id).needs_ai_fill).toBe(false);
    const snapshot = campaignSnapshot(db, campaign_id);
    expect(snapshot.campaign.premise).toBe('A fog-bound village where no one has aged in fifty years.');
    expect(snapshot.campaign.needs_ai_fill).toBe(false);
    expect(snapshot.campaign.setting_name).toBe('Gothic Horror');
  });

  it('names a story the player left untitled', async () => {
    const { campaign_id } = createCampaign(db, {
      name: 'Untitled story (2026-09-12)',
      story_shape: 'sandbox',
      settings: { setting_preset: 'gothic-horror', needs_ai_fill: { name: true, premise: true } },
    });
    const client = await connect();
    const result = await client.callTool({
      name: 'mark_story_filled',
      arguments: { campaign_id, name: 'The Mistward', premise: 'A fog-bound village where no one has aged.' },
    });

    expect(result.structuredContent).toMatchObject({ name: 'The Mistward', needs_ai_fill: false });
    const snapshot = campaignSnapshot(db, campaign_id);
    expect(snapshot.campaign.name).toBe('The Mistward');
    expect(snapshot.campaign.needs_fill).toEqual({ name: false, premise: false });
  });

  it('keeps asking for the name when only the premise was written', async () => {
    const { campaign_id } = createCampaign(db, {
      name: 'Untitled story (2026-09-12)',
      story_shape: 'sandbox',
      settings: { needs_ai_fill: { name: true, premise: true } },
    });
    const client = await connect();
    await client.callTool({
      name: 'mark_story_filled',
      arguments: { campaign_id, premise: 'A fog-bound village.' },
    });
    expect(campaignSnapshot(db, campaign_id).campaign.needs_fill).toEqual({ name: true, premise: false });
  });

  it('refuses an unknown campaign', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'mark_story_filled',
      arguments: { campaign_id: 999, premise: 'Nothing.' },
    });
    expect(result.isError).toBe(true);
  });
});

describe('new_story prompt', () => {
  it('lists the presets so a chat-created story can pick one', async () => {
    const client = await connect();
    const { messages } = await client.getPrompt({ name: 'new_story', arguments: {} });
    const text = (messages[0]?.content as { text: string }).text;
    expect(text).toContain('Classic High Fantasy (classic-high-fantasy)');
    expect(text).toContain('settings.setting_preset');
    expect(text).toContain('needs_ai_fill: true');
  });

  it('pre-fills the interview when a preset is passed', async () => {
    const client = await connect();
    const { messages } = await client.getPrompt({ name: 'new_story', arguments: { preset: 'gothic-horror' } });
    const text = (messages[0]?.content as { text: string }).text;
    expect(text).toContain('I already picked "Gothic Horror"');
    expect(text).not.toContain('Pirates & Swashbuckling (swashbuckling-pirates)');
  });
});

describe('the appearance the DM writes', () => {
  it('lands on the sheet the player and the DM both read', () => {
    const { campaign_id } = createCampaign(db, { name: 'Appearance', story_shape: 'sandbox' });
    const created = createCharacter(db, {
      campaign_id,
      name: 'Sable',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
      appearance: 'Broad, grey-bearded, with a burn scar across one cheek.',
    });
    expect(created.character?.appearance).toContain('grey-bearded');
    expect(campaignSnapshot(db, campaign_id).pc?.appearance).toContain('grey-bearded');
  });
});
