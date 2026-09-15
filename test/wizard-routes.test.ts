// The wizard routes with every field optional: an empty story, a half-made character kept as a draft,
// and a complete one that passes the new creation options through to the engine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { campaignSnapshot, getCampaign, getCharacterDraft, listCampaigns } from '../src/core/campaign.js';
import { openDb, type Db } from '../src/db/connection.js';
import { HOST, startHttpServer } from '../src/transport/http.js';
import { renderBriefing } from '../src/mcp/tools/campaign.js';

let base: string;
let db: Db;
let stop: () => Promise<void>;

beforeAll(async () => {
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: 'wizardroutes0123456789abcdef0123' });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** The create answers with the campaign in the list's own shape; the settings blob stays on the row. */
async function newCampaign(body: unknown): Promise<{ id: number; name: string; needs_fill: NeedsFill }> {
  const res = await post('/api/campaigns', body);
  expect(res.status).toBe(201);
  return (await res.json()) as { id: number; name: string; needs_fill: NeedsFill };
}

type NeedsFill = { name: boolean; premise: boolean };

const settingsOf = (campaignId: number): Record<string, unknown> =>
  JSON.parse(getCampaign(db, campaignId).settings_json!) as Record<string, unknown>;

/** A character the engine accepts as it stands: the wizard's "complete" path. */
const complete = {
  name: 'Sable',
  species: 'Dwarf',
  class: 'Fighter',
  background: 'Soldier',
  ability_method: 'standard_array' as const,
  abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
  ability_bonuses: { str: 2, con: 1 },
  skill_choices: ['athletics', 'perception'],
};

describe('the story step', () => {
  it('takes a story with nothing filled in and leaves the name and the premise to the DM', async () => {
    const created = await newCampaign({ setting_preset: 'gothic-horror', tone_dials: { horror: 3 } });
    expect(created.name).toMatch(/^Untitled story \(/);
    expect(created.needs_fill).toEqual({ name: true, premise: true });
    expect(settingsOf(created.id)).toMatchObject({
      setting_preset: 'gothic-horror',
      tone_dials: { horror: 3 },
      needs_ai_fill: { name: true, premise: true },
    });

    const snapshot = campaignSnapshot(db, created.id);
    expect(snapshot.campaign.needs_ai_fill).toBe(true);
    expect(snapshot.campaign.needs_fill).toEqual({ name: true, premise: true });
  });

  it('flags only the premise when the player named the story', async () => {
    const created = await newCampaign({ name: 'The Ashfall Road', story_shape: 'sandbox' });
    expect(created.name).toBe('The Ashfall Road');
    expect(created.needs_fill).toEqual({ name: false, premise: true });
    expect(settingsOf(created.id)).toMatchObject({ needs_ai_fill: { premise: true } });
    expect(campaignSnapshot(db, created.id).campaign.needs_fill).toEqual({ name: false, premise: true });
  });

  it('flags nothing when both are written', async () => {
    const created = await newCampaign({ name: 'The Salt Crown', premise: 'A pirate queen wants her flagship back.' });
    expect(settingsOf(created.id)).toMatchObject({ needs_ai_fill: false });
    expect(campaignSnapshot(db, created.id).campaign.needs_ai_fill).toBe(false);
  });

  it('answers the create with the same row the campaign list shows', async () => {
    const res = await post('/api/campaigns', { name: 'The Picker Row', setting_preset: 'gothic-horror' });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Record<string, unknown> & { id: number };
    expect(created).toMatchObject({
      name: 'The Picker Row',
      setting_name: 'Gothic Horror',
      pc: null,
      character_draft: null,
      last_recap_snippet: null,
      needs_fill: { name: false, premise: true },
    });
    // The raw row's blobs are not the picker's business.
    expect(created).not.toHaveProperty('settings_json');
    expect(created).not.toHaveProperty('character_draft_json');
    expect(created).toEqual(listCampaigns(db).find((c) => c.id === created.id));
  });
});

describe('the character step', () => {
  it('keeps an empty character as an empty draft and makes no character row', async () => {
    const story = await newCampaign({ name: 'Empty Character' });
    const res = await post(`/api/campaigns/${story.id}/character`, {});
    expect(res.status).toBe(201);
    const body = (await res.json()) as { character: null; character_draft: unknown; draft_summary: string };
    expect(body.character).toBeNull();
    expect(body.character_draft).toEqual({});
    expect(body.draft_summary).toMatch(/nothing chosen yet/);

    const snapshot = campaignSnapshot(db, story.id);
    expect(snapshot.pc).toBeNull();
    expect(snapshot.character_draft).toEqual({});
  });

  it('keeps a partly filled character as a draft', async () => {
    const story = await newCampaign({ name: 'Partial Character' });
    const res = await post(`/api/campaigns/${story.id}/character`, {
      name: '  Rowan  ',
      class: 'Rogue',
      gender: 'female',
      idea: 'a gambler who owes the wrong people',
      ability_method: 'point_buy',
      species: '',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { character: null; draft_summary: string };
    expect(body.character).toBeNull();
    expect(getCharacterDraft(db, story.id)).toEqual({
      name: 'Rowan',
      class: 'Rogue',
      gender: 'female',
      idea: 'a gambler who owes the wrong people',
      ability_method: 'point_buy',
    });
    expect(body.draft_summary).toContain('Rowan');
    expect(body.draft_summary).toContain('female Rogue');
    expect(campaignSnapshot(db, story.id).character_draft).toMatchObject({ name: 'Rowan' });
  });

  it('creates the character when every required answer is there, and says what it chose for the player', async () => {
    const story = await newCampaign({ name: 'Complete Character' });
    const res = await post(`/api/campaigns/${story.id}/character`, complete);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      character: { name: string; proficiencies: { languages: string[] } };
      languages_chosen_for_you?: string[];
      equipment_chosen_for_you?: string[];
    };
    expect(body.character).toMatchObject({ name: 'Sable', class: 'Fighter' });
    // Nothing was said about languages, so the engine filled them in and reported which.
    expect(body.languages_chosen_for_you?.length).toBe(2);
    expect(body.character.proficiencies.languages).toContain('Common');
  });

  it('passes the new creation options through to the engine', async () => {
    const story = await newCampaign({ name: 'Every Option' });
    const res = await post(`/api/campaigns/${story.id}/character`, {
      ...complete,
      languages: ['Elvish', 'Dwarvish'],
      feature_options: { 'Fighting Style': ['Defense'] },
      background_equipment_choice: 'a',
      equipment_picks: ['Dice'],
      appearance: 'ignored by the route',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      character: { proficiencies: { languages: string[] }; features: Array<{ name: string; text: string }> };
      languages_chosen_for_you?: string[];
    };
    expect(body.character.proficiencies.languages).toEqual(['Common', 'Elvish', 'Dwarvish']);
    expect(body.languages_chosen_for_you).toBeUndefined();
    expect(body.character.features.some((f) => f.name === 'Fighting Style' && f.text.includes('Defense'))).toBe(true);
  });

  it('keeps a character whose species still needs a lineage as a draft', async () => {
    const story = await newCampaign({ name: 'Lineage Missing' });
    const res = await post(`/api/campaigns/${story.id}/character`, {
      ...complete,
      species: 'Elf',
      skill_choices: ['athletics', 'perception', 'insight'],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { character: null; character_draft: { species: string }; draft_summary: string };
    expect(body.character).toBeNull();
    expect(body.character_draft.species).toBe('Elf');
    expect(body.draft_summary).toContain('lineage still to choose');
    expect(body.draft_summary).toContain('Elven Lineage: High Elf');
  });

  it('creates the character once the lineage is there and applies it', async () => {
    const story = await newCampaign({ name: 'Lineage Chosen' });
    const res = await post(`/api/campaigns/${story.id}/character`, {
      ...complete,
      species: 'Dragonborn',
      lineage: 'Draconic Ancestor: Red',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { character: { lineage: string; resistances: string[] } };
    expect(body.character.lineage).toBe('Draconic Ancestor: Red');
    expect(body.character.resistances).toContain('fire');
  });

  it('lists the lineages a species offers in the options', async () => {
    const options = (await (await fetch(`${base}/api/srd/options?species=Elf`)).json()) as {
      species: Array<{ name: string; lineages: string[] }>;
      species_detail: { lineages: Array<{ name: string; traits: Array<{ name: string }> }> };
    };
    expect(options.species.find((s) => s.name === 'Human')!.lineages).toEqual([]);
    expect(options.species.find((s) => s.name === 'Elf')!.lineages).toHaveLength(3);
    expect(options.species_detail.lineages.map((l) => l.name)).toContain('Elven Lineage: Wood Elf');
  });

  it('passes the six spellbook pages a Wizard chose through instead of filling two in', async () => {
    const story = await newCampaign({ name: 'Spellbook' });
    const spellbook = ['Magic Missile', 'Shield', 'Sleep', 'Detect Magic', 'Alarm', 'Feather Fall'];
    const res = await post(`/api/campaigns/${story.id}/character`, {
      ...complete,
      name: 'Zel',
      species: 'Human',
      class: 'Wizard',
      background: 'Sage',
      abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
      ability_bonuses: { int: 2, con: 1 },
      skill_choices: ['arcana', 'investigation', 'perception'],
      cantrips: ['Light', 'Mage Hand', 'Ray of Frost'],
      spells: ['Magic Missile', 'Shield', 'Sleep', 'Detect Magic'],
      spellbook,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      character: { spells: { spellbook: string[] } };
      spellbook_chosen_for_you?: string[];
    };
    expect(body.character.spells.spellbook).toEqual(spellbook);
    expect(body.spellbook_chosen_for_you).toBeUndefined();
  });

  it('reports an illegal option as a 400 with the message the engine gives', async () => {
    const story = await newCampaign({ name: 'Bad Option' });
    const res = await post(`/api/campaigns/${story.id}/character`, { ...complete, languages: ['Elvish'] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/languages/i);
  });

  it('clears the draft once the character is created', async () => {
    const story = await newCampaign({ name: 'Draft Then Character' });
    await post(`/api/campaigns/${story.id}/character`, { class: 'Fighter', idea: 'a soldier turned guard' });
    expect(getCharacterDraft(db, story.id)).not.toBeNull();

    await post(`/api/campaigns/${story.id}/character`, complete);
    expect(getCharacterDraft(db, story.id)).toBeNull();
    expect(campaignSnapshot(db, story.id).character_draft).toBeNull();
  });
});

describe('the briefing', () => {
  it('asks the DM for the name, the premise and the rest of the character', async () => {
    const story = await newCampaign({ setting_preset: 'gothic-horror' });
    await post(`/api/campaigns/${story.id}/character`, { name: 'Rowan', class: 'Rogue', gender: 'female' });

    const rendered = renderBriefing(campaignSnapshot(db, story.id));
    expect(rendered).toContain('## THIS STORY IS NOT FINISHED');
    expect(rendered).toContain('a name and a premise');
    expect(rendered).toContain('## COMPLETE THE CHARACTER BEFORE PLAY');
    expect(rendered).toContain('Rowan, female Rogue');
    expect(rendered).toContain('appearance');
  });

  it('drops the character block once the character exists', async () => {
    const story = await newCampaign({ name: 'Briefing Done', premise: 'A road, a wolf, a debt.' });
    await post(`/api/campaigns/${story.id}/character`, { class: 'Fighter' });
    await post(`/api/campaigns/${story.id}/character`, complete);

    const rendered = renderBriefing(campaignSnapshot(db, story.id));
    expect(rendered).not.toContain('COMPLETE THE CHARACTER');
    expect(rendered).not.toContain('THIS STORY IS NOT FINISHED');
  });
});
