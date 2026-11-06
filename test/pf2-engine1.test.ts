// PF2 engine fixes from the judged playtests: magic: null on inventory add, Resourceful on a long rest,
// no empty scene left behind by end_session, and SRD creature sizes Open5e flattens to "small".
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, endSession, getCharacterSheet, loadCampaign, logEvent, saveCheckpoint } from '../src/core/campaign.js';
import { createCharacter, createCompanion, partyRest, rest, type CreateCharacterInput } from '../src/core/character.js';
import { statBlockFor } from '../src/combat/encounter.js';
import { sizeCode } from '../src/combat/grid.js';
import { openDb, type Db } from '../src/db/connection.js';
import { registerInventoryTools } from '../src/mcp/tools/inventory.js';
import { captureCheckpoint, rewindToCheckpoint } from '../src/core/rewind.js';
import { creatures, CREATURE_SIZES } from '../src/srd/data.js';
import { srdSearch } from '../src/srd/lookup.js';
import { replyData, replyText } from './helpers/reply.js';

let db: Db;
let campaignId: number;

const hero = (species: string): CreateCharacterInput => ({
  campaign_id: campaignId,
  name: 'Wren',
  species,
  class: 'Fighter',
  background: 'Soldier',
  ability_method: 'standard_array',
  abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
  ability_bonuses: { str: 2, con: 1 },
  // Skillful gives a Human one more skill.
  skill_choices: species === 'Human' ? ['athletics', 'perception', 'stealth'] : ['athletics', 'perception'],
});

const inspiration = (id?: number): number =>
  (getCharacterSheet(db, campaignId, id) as unknown as { inspiration: number }).inspiration;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'PF2', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
});

describe('inventory {op: add} with magic: null', () => {
  it('treats the null as absent and adds the plain item', async () => {
    createCharacter(db, hero('Dwarf'));
    const server = new McpServer({ name: 'pf2-engine1', version: '0.0.0' });
    registerInventoryTools(server, db);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: 'inventory',
      arguments: { op: 'add', campaign_id: campaignId, name: 'Blanket', qty: 1, magic: null },
    });
    expect(result.isError, replyText(result)).toBeFalsy();
    const blanket = replyData<{ inventory: Array<{ name: string; magic?: unknown }> }>(result).inventory.find(
      (item) => item.name === 'Blanket',
    );
    expect(blanket).toBeDefined();
    expect(blanket!.magic).toBeUndefined();
    await client.close();
  });
});

describe('Resourceful: Heroic Inspiration after a long rest', () => {
  it('grants it to a Human player character and says so', () => {
    createCharacter(db, hero('Human'));
    expect(inspiration()).toBe(0);

    const rested = rest(db, { campaign_id: campaignId, kind: 'long' });

    expect(rested.heroic_inspiration).toBe('Resourceful: Wren gains Heroic Inspiration.');
    expect(inspiration()).toBe(1);
    const logged = db.prepare("SELECT text FROM event WHERE campaign_id = ? AND kind = 'inspiration'").all(campaignId);
    expect(logged).toEqual([{ text: 'Wren gains Heroic Inspiration (Resourceful).' }]);
  });

  it('never stacks a second one, and says so', () => {
    createCharacter(db, hero('Human'));
    db.prepare('UPDATE character SET inspiration = 1 WHERE campaign_id = ?').run(campaignId);

    const rested = rest(db, { campaign_id: campaignId, kind: 'long' });

    expect(rested.heroic_inspiration).toBe('Resourceful: Wren already has Heroic Inspiration, and it never stacks.');
    expect(inspiration()).toBe(1);
  });

  it('gives nothing on a short rest, an interrupted long rest or to another species', () => {
    createCharacter(db, hero('Human'));
    expect(rest(db, { campaign_id: campaignId, kind: 'short' }).heroic_inspiration).toBeUndefined();
    expect(rest(db, { campaign_id: campaignId, kind: 'long', hours: 3 }).heroic_inspiration).toBeUndefined();
    expect(inspiration()).toBe(0);

    const other = openDb(':memory:');
    const otherCampaign = createCampaign(other, { name: 'Dwarf', story_shape: 'sandbox' }).campaign_id;
    createCharacter(other, { ...hero('Dwarf'), campaign_id: otherCampaign });
    expect(rest(other, { campaign_id: otherCampaign, kind: 'long' }).heroic_inspiration).toBeUndefined();
  });

  it('reads out in a party rest for the player character, and passes over a Human companion', async () => {
    createCharacter(db, hero('Human'));
    const sella = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Sella',
      source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
    }).companion!.id;

    const rested = await partyRest(db, { campaign_id: campaignId, kind: 'long' }, async (one) => rest(db, one));

    expect(rested.members[0]).toContain('Resourceful: Wren gains Heroic Inspiration.');
    expect(rested.members[1]).not.toContain('Inspiration');
    expect(inspiration()).toBe(1);
    expect(inspiration(sella)).toBe(0);
  });
});

describe('end_session leaves no empty scene behind', () => {
  const scenes = () =>
    db.prepare('SELECT id, session_id, title, summary, ended_at FROM scene WHERE campaign_id = ? ORDER BY id').all(campaignId) as Array<{
      id: number;
      session_id: number;
      title: string | null;
      summary: string | null;
      ended_at: string | null;
    }>;
  const currentScene = () =>
    (db.prepare('SELECT current_scene_id AS id FROM campaign WHERE id = ?').get(campaignId) as { id: number | null }).id;

  it('drops the scene the last save opened when nothing was played in it', () => {
    saveCheckpoint(db, { campaign_id: campaignId, scene_title: 'The mill', scene_location: 'Marrowbrook', scene_summary: 'They met Orla.' });
    endSession(db, { campaign_id: campaignId });

    expect(scenes()).toEqual([expect.objectContaining({ title: 'The mill', summary: 'They met Orla.' })]);
    expect(currentScene()).toBeNull();
    const [{ id: mill }] = scenes();
    expect(db.prepare("SELECT scene_id FROM event WHERE campaign_id = ? AND kind = 'checkpoint'").all(campaignId)).toEqual([
      { scene_id: mill },
    ]);
    const briefing = loadCampaign(db, campaignId);
    expect(briefing.session.number).toBe(2);
    expect(briefing.current_scene).toBeNull();
    expect(briefing.previous_scene).toMatchObject({ title: 'The mill', location_name: 'Marrowbrook' });

    // The next session's first save opens its own scene, as it did before.
    const saved = saveCheckpoint(db, { campaign_id: campaignId, scene_title: 'The road', scene_summary: 'They set out.' });
    expect(saved.scene).toMatchObject({ title: 'The road', location: null });
    expect(scenes().filter((scene) => scene.session_id === briefing.session.id).map((scene) => scene.title)).toEqual([
      'The road',
      null,
    ]);
  });

  it('still rewinds to the save, which brings the dropped scene back', () => {
    const saved = saveCheckpoint(db, { campaign_id: campaignId, scene_title: 'The mill', scene_summary: 'They met Orla.' });
    captureCheckpoint(db, campaignId, saved.scene.id);
    const opened = currentScene();
    endSession(db, { campaign_id: campaignId });

    rewindToCheckpoint(db, campaignId);

    expect(currentScene()).toBe(opened);
    expect(scenes().map((scene) => scene.id)).toEqual([saved.scene.id, opened]);
  });

  it('keeps and closes a scene that saw play after the last save', () => {
    saveCheckpoint(db, { campaign_id: campaignId, scene_title: 'The mill', scene_summary: 'They met Orla.' });
    logEvent(db, { campaign_id: campaignId, kind: 'narration', text: 'They walk out into the sleet.' });
    endSession(db, { campaign_id: campaignId });

    const [, played] = scenes();
    expect(played).toMatchObject({ title: null, summary: null });
    expect(played!.ended_at).not.toBeNull();
  });
});

describe('SRD creature sizes', () => {
  it('reads the Bandit as Medium, the first size its SRD 5.2.1 type line prints', () => {
    const bandit = statBlockFor('Bandit');
    expect(bandit.size).toBe('medium');
    expect(sizeCode(bandit.size)).toBe('M');
    expect(srdSearch('creature', 'Pira', 5).results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Pirate', size: 'medium' }),
        expect.objectContaining({ name: 'Piranha', size: 'tiny' }),
      ]),
    );
  });

  it('reads a Tiny creature as tiny rather than small', () => {
    expect(statBlockFor('Cat').size).toBe('tiny');
    expect(sizeCode(statBlockFor('Imp').size)).toBe('T');
  });

  it('corrects only creatures that exist, and leaves no humanoid filed as small', () => {
    const names = new Set(creatures().map((c) => c.fields.name));
    expect(Object.keys(CREATURE_SIZES).filter((name) => !names.has(name))).toEqual([]);
    expect(Object.keys(CREATURE_SIZES)).toHaveLength(61);
    expect(creatures().filter((c) => c.fields.type === 'humanoid' && c.fields.size !== 'medium')).toEqual([]);
    expect(creatures().filter((c) => c.fields.size === 'tiny')).toHaveLength(25);
  });
});
