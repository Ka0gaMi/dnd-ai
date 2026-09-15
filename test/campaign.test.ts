import { beforeEach, describe, expect, it } from 'vitest';
import {
  addCanonFact,
  addGlossaryEntry,
  campaignSnapshot,
  createCampaign,
  endSession,
  eventsSinceCheckpoint,
  getCharacterSheet,
  listCampaigns,
  loadCampaign,
  logEvent,
  saveCheckpoint,
  setCampaignDeleted,
  upsertQuests,
} from '../src/core/campaign.js';
import { createCharacter, createCompanion } from '../src/core/character.js';
import { upsertEntity } from '../src/core/codex.js';
import { updateSettings } from '../src/core/settings.js';
import { advanceChapter, openChapter } from '../src/core/story.js';
import { renderBriefing } from '../src/mcp/tools/campaign.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign() {
  return createCampaign(db, { name: 'The Ashfall Road', story_shape: 'structured', premise: 'A road of cinders.' });
}

describe('create and load', () => {
  it('round-trips a fresh campaign', () => {
    const created = newCampaign();
    expect(created.session.number).toBe(1);

    const briefing = loadCampaign(db, created.campaign_id);
    expect(briefing.campaign.name).toBe('The Ashfall Road');
    expect(briefing.campaign.story_shape).toBe('structured');
    expect(briefing.session.number).toBe(1);
    expect(briefing.pc).toBeNull();
    expect(briefing.open_quests).toEqual([]);
    expect(briefing.recent_events.at(-1)?.kind).toBe('system');
    expect(briefing.events_since_checkpoint).toBe(1);
  });

  it('starts a new session when the last one ended', () => {
    const { campaign_id } = newCampaign();
    saveCheckpoint(db, { campaign_id, scene_title: 'Departure', scene_summary: 'They left town at dawn.' });
    endSession(db, { campaign_id });

    const briefing = loadCampaign(db, campaign_id);
    expect(briefing.session.number).toBe(2);
    expect(briefing.last_recap).toContain('Departure');
  });

  it('rejects an unknown campaign id', () => {
    expect(() => loadCampaign(db, 999)).toThrow(/No campaign with id 999/);
  });

  it('hides a deleted campaign from the list and refuses to load it', () => {
    const { campaign_id } = newCampaign();
    expect(setCampaignDeleted(db, campaign_id, true)).toBe(true);
    expect(listCampaigns(db)).toEqual([]);
    expect(listCampaigns(db, true)[0]?.deleted_at).toBeTruthy();
    expect(() => loadCampaign(db, campaign_id)).toThrow(/was deleted by the player/);

    setCampaignDeleted(db, campaign_id, false);
    expect(loadCampaign(db, campaign_id).campaign.id).toBe(campaign_id);
  });
});

describe('save_checkpoint', () => {
  it('writes the scene, recap, facts, glossary and quests', () => {
    const { campaign_id } = newCampaign();
    const result = saveCheckpoint(db, {
      campaign_id,
      scene_title: 'The Burned Chapel',
      scene_summary: 'The party searched the chapel and found a sealed crypt.',
      canon_facts: [{ subject: 'Chapel of Sain', fact: 'Its crypt is sealed with a silver lock.' }],
      glossary: [{ term: 'Sain', definition: 'A minor god of embers.' }],
      quest_updates: [{ title: 'Open the crypt', kind: 'main', steps: [{ text: 'Find the silver key' }] }],
    });

    expect(result.session.recap_text).toBe(
      '1. The Burned Chapel: The party searched the chapel and found a sealed crypt.',
    );
    expect(result.open_quests).toHaveLength(1);
    expect(result.open_quests[0]?.steps[0]?.text).toBe('Find the silver key');

    const briefing = loadCampaign(db, campaign_id);
    expect(briefing.previous_scene?.title).toBe('The Burned Chapel');
    expect(briefing.canon_facts.map((f) => f.subject)).toEqual(['Chapel of Sain']);
    expect(briefing.glossary_terms).toEqual(['Sain']);
    expect(briefing.events_since_checkpoint).toBe(0);
  });

  it('accumulates scene summaries into the session recap', () => {
    const { campaign_id } = newCampaign();
    saveCheckpoint(db, { campaign_id, scene_title: 'One', scene_summary: 'First scene.' });
    const second = saveCheckpoint(db, { campaign_id, scene_title: 'Two', scene_summary: 'Second scene.' });
    expect(second.session.recap_text).toBe('1. One: First scene.\n2. Two: Second scene.');
  });
});

describe('objectives, facts and glossary', () => {
  it('upserts quests and steps and hides closed quests', () => {
    const { campaign_id } = newCampaign();
    const [quest] = upsertQuests(db, campaign_id, [
      { title: 'Escort the caravan', kind: 'side', steps: [{ text: 'Reach the ford' }] },
    ]);
    expect(quest?.status).toBe('open');

    const stepId = quest!.steps[0]!.id;
    const afterStep = upsertQuests(db, campaign_id, [
      { id: quest!.id, title: 'Escort the caravan', steps: [{ id: stepId, text: 'Reach the ford', done: true }] },
    ]);
    expect(afterStep[0]?.steps[0]?.done).toBe(true);

    const afterClose = upsertQuests(db, campaign_id, [
      { id: quest!.id, title: 'Escort the caravan', status: 'done' },
    ]);
    expect(afterClose).toEqual([]);
  });

  it('supersedes a canon fact instead of deleting it', () => {
    const { campaign_id } = newCampaign();
    const first = addCanonFact(db, { campaign_id, subject: 'Mira', fact: 'Mira runs the inn.' });
    addCanonFact(db, { campaign_id, subject: 'Mira', fact: 'Mira sold the inn.', supersedes_id: first.id });

    const briefing = loadCampaign(db, campaign_id);
    expect(briefing.canon_facts.map((f) => f.fact)).toEqual(['Mira sold the inn.']);
    const row = db.prepare('SELECT active, superseded_by FROM canon_fact WHERE id = ?').get(first.id);
    expect(row).toMatchObject({ active: 0 });
  });

  it('refuses a restatement of an active fact on the same subject', () => {
    const { campaign_id } = newCampaign();
    const first = addCanonFact(db, { campaign_id, subject: 'Mira', fact: 'Mira runs the Copper Kettle inn.' });

    const again = addCanonFact(db, { campaign_id, subject: 'mira', fact: 'Mira runs the Copper Kettle inn!' });
    expect(again).toEqual({
      duplicate_of: first.id,
      hint: 'Near-duplicate of an existing fact; pass supersedes_id to replace it, or log_event for scene beats.',
    });

    const other = addCanonFact(db, { campaign_id, subject: 'Mira', fact: 'Mira lost a brother to the Ashfall.' });
    expect(other.id).toBeDefined();

    const superseded = addCanonFact(db, {
      campaign_id,
      subject: 'Mira',
      fact: 'Mira runs the Copper Kettle inn alone.',
      supersedes_id: first.id,
    });
    expect(superseded.id).toBeDefined();
    expect(loadCampaign(db, campaign_id).canon_facts.map((f) => f.fact)).toEqual([
      'Mira runs the Copper Kettle inn alone.',
      'Mira lost a brother to the Ashfall.',
    ]);
  });

  it('hints at consolidation once a subject has six active facts', () => {
    const { campaign_id } = newCampaign();
    const facts = [
      'Ashfall Keep stands on the cliff above Greywater.',
      'Its east gate collapsed during the siege.',
      'Lady Veil commands the garrison.',
      'A dry well hides the smugglers cellar.',
      'The bell tower burned down twenty years ago.',
      'Its cisterns still hold clean water.',
    ];
    for (const fact of facts) addCanonFact(db, { campaign_id, subject: 'Ashfall Keep', fact });
    const seventh = addCanonFact(db, {
      campaign_id,
      subject: 'Ashfall Keep',
      fact: 'Ravens nest in the ruined chapel.',
    });
    expect(seventh.id).toBeDefined();
    expect(seventh.hint).toMatch(/supersedes_id/);
  });

  it('overwrites a glossary term instead of duplicating it', () => {
    const { campaign_id } = newCampaign();
    addGlossaryEntry(db, { campaign_id, term: 'Emberwatch', definition: 'A watchtower.' });
    addGlossaryEntry(db, { campaign_id, term: 'Emberwatch', definition: 'A ruined watchtower.' });
    const rows = db.prepare('SELECT definition FROM glossary_entry WHERE campaign_id = ?').all(campaign_id);
    expect(rows).toEqual([{ definition: 'A ruined watchtower.' }]);
  });

  it('stamps new facts, glossary entries and quests with the open chapter', () => {
    const { campaign_id } = newCampaign();
    const chapter = openChapter(db, { campaign_id, title: 'The road out' });

    const fact = addCanonFact(db, { campaign_id, subject: 'Mira', fact: 'Mira runs the inn.' });
    addGlossaryEntry(db, { campaign_id, term: 'Emberwatch', definition: 'A watchtower.' });
    const [quest] = upsertQuests(db, campaign_id, [{ title: 'Escort the caravan' }]);
    saveCheckpoint(db, {
      campaign_id,
      scene_summary: 'They left town.',
      canon_facts: [{ subject: 'Ford', fact: 'The ford is washed out.' }],
    });

    const chapterOf = (sql: string, id: unknown) =>
      (db.prepare(sql).get(id) as { chapter_id: number | null }).chapter_id;
    expect(chapterOf('SELECT chapter_id FROM canon_fact WHERE id = ?', fact.id)).toBe(chapter.id);
    expect(chapterOf("SELECT chapter_id FROM glossary_entry WHERE term = 'Emberwatch' AND campaign_id = ?", campaign_id)).toBe(
      chapter.id,
    );
    expect(chapterOf('SELECT chapter_id FROM quest WHERE id = ?', quest!.id)).toBe(chapter.id);
    expect(
      chapterOf("SELECT chapter_id FROM canon_fact WHERE subject = 'Ford' AND campaign_id = ?", campaign_id),
    ).toBe(chapter.id);
  });

  it('carries chapter_id on the briefing facts, quests and recaps', () => {
    const { campaign_id } = newCampaign();
    const chapter = openChapter(db, { campaign_id, title: 'The road out' });
    addCanonFact(db, { campaign_id, subject: 'Mira', fact: 'Mira runs the inn.' });
    upsertQuests(db, campaign_id, [{ title: 'Escort the caravan' }]);
    advanceChapter(db, { campaign_id, summary: 'The road out is behind them.', title: 'The road on' });

    const briefing = loadCampaign(db, campaign_id);
    expect(briefing.canon_facts.every((f) => f.chapter_id === chapter.id)).toBe(true);
    expect(briefing.open_quests.every((q) => q.chapter_id === chapter.id)).toBe(true);
    expect(briefing.story.recaps).toHaveLength(1);
    expect(briefing.story.recaps[0]).toMatchObject({ id: chapter.id, chapter_id: chapter.id });
  });
});

describe('the codex and progression blocks in the briefing', () => {
  it('renders whoever the scene and the last events name, and the progression state', () => {
    const { campaign_id } = newCampaign();
    updateSettings(db, campaign_id, { rules_mode: 'strict' });
    upsertEntity(db, { campaign_id, kind: 'npc', name: 'Mira', summary: 'The innkeeper of Emberwatch.' });
    upsertEntity(db, { campaign_id, kind: 'npc', name: 'Halden', summary: 'A caravan guard.' });
    // Push the codex writes out of the last-events window, so only the scene decides who is present.
    for (let i = 0; i < 8; i += 1) logEvent(db, { campaign_id, kind: 'narration', text: `Beat ${i}.` });
    saveCheckpoint(db, { campaign_id, scene_summary: 'Mira pours the last of the ale.' });

    const briefing = loadCampaign(db, campaign_id);
    expect(briefing.codex_briefing).toContain('Present:');
    expect(briefing.progression_briefing).toContain('Rules mode:');

    const rendered = renderBriefing(briefing);
    expect(rendered).toContain('## Codex');
    expect(rendered).toContain('- Mira (npc, alive)');
    expect(rendered).toContain('## Progression');
    // Halden is in the codex index but not in the scene, so he is not "present".
    expect(rendered.split('Known npc')[0]).not.toContain('Halden');
  });

  it('leaves both blocks out of the player snapshot, which never reads them', () => {
    const { campaign_id } = newCampaign();
    updateSettings(db, campaign_id, { rules_mode: 'strict' });
    upsertEntity(db, { campaign_id, kind: 'npc', name: 'Mira', summary: 'The innkeeper of Emberwatch.' });
    saveCheckpoint(db, { campaign_id, scene_summary: 'Mira pours the last of the ale.' });

    const player = campaignSnapshot(db, campaign_id, { forPlayer: true });
    expect(player.codex_briefing).toBe('');
    expect(player.progression_briefing).toBe('');

    const dm = campaignSnapshot(db, campaign_id);
    expect(dm.codex_briefing).toContain('Mira');
    expect(dm.progression_briefing).toContain('Rules mode:');
  });
});

describe('event log', () => {
  it('counts events since the last checkpoint', () => {
    const { campaign_id } = newCampaign();
    saveCheckpoint(db, { campaign_id, scene_summary: 'Baseline.' });
    expect(eventsSinceCheckpoint(db, campaign_id)).toBe(0);
    logEvent(db, { campaign_id, kind: 'narration', text: 'The door creaked open.' });
    logEvent(db, { campaign_id, kind: 'loot', text: 'Found 12 gold.', payload: { gold: 12 } });
    expect(eventsSinceCheckpoint(db, campaign_id)).toBe(2);
  });
});

describe('listCampaigns', () => {
  it('reports the active PC, not a retired one', () => {
    const { campaign_id } = newCampaign();
    createCharacter(db, {
      campaign_id,
      name: 'Borg',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    });
    createCharacter(db, {
      campaign_id,
      name: 'Nim',
      species: 'Human',
      class: 'Wizard',
      background: 'Sage',
      ability_method: 'standard_array',
      abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
      ability_bonuses: { int: 2, con: 1 },
      skill_choices: ['arcana', 'investigation', 'perception'],
      cantrips: ['Light', 'Mage Hand', 'Ray of Frost'],
      spells: ['Magic Missile', 'Shield', 'Sleep', 'Detect Magic'],
    });

    const [row] = listCampaigns(db);
    expect(row?.pc).toEqual({ name: 'Nim', level: 1, class: 'Wizard' });
  });
});

describe('character sheet', () => {
  it('is null until WP2 fills the character table', () => {
    const { campaign_id } = newCampaign();
    expect(getCharacterSheet(db, campaign_id)).toBeNull();

    const ts = new Date().toISOString();
    db.prepare(
      "INSERT INTO character (campaign_id, name, is_pc, class, level, hp_current, hp_max, abilities_json, created_at, updated_at) VALUES (?, 'Bran', 1, 'Fighter', 3, 21, 28, '{\"str\":16}', ?, ?)",
    ).run(campaign_id, ts, ts);

    const sheet = getCharacterSheet(db, campaign_id);
    expect(sheet).toMatchObject({ name: 'Bran', class: 'Fighter', level: 3, hp_current: 21 });
    expect(sheet?.abilities).toEqual({ str: 16 });
    expect(loadCampaign(db, campaign_id).pc?.name).toBe('Bran');
  });

  it('backfills legacy inventory items with no weight_lb from SRD data, and persists it once', () => {
    const { campaign_id } = newCampaign();
    const ts = new Date().toISOString();
    const inventory = [
      { name: 'Leather Armor', qty: 1 },
      { name: "Dungeoneer's Pack", qty: 1 },
      { name: "Grandmother's Locket", qty: 1 },
    ];
    db.prepare(
      "INSERT INTO character (campaign_id, name, is_pc, class, level, hp_current, hp_max, abilities_json, inventory_json, created_at, updated_at) VALUES (?, 'Zara', 1, 'Rogue', 1, 10, 10, '{\"str\":12}', ?, ?, ?)",
    ).run(campaign_id, JSON.stringify(inventory), ts, ts);

    const sheet = getCharacterSheet(db, campaign_id);
    const items = sheet?.inventory as Array<{ name: string; weight_lb?: number; notes?: string }>;
    expect(items.find((i) => i.name === 'Leather Armor')?.weight_lb).toBe(10);
    expect(items.find((i) => i.name === "Dungeoneer's Pack")?.weight_lb).toBe(55);
    expect(items.find((i) => i.name === "Grandmother's Locket")).toMatchObject({
      weight_lb: 0,
      notes: 'weight unknown',
    });
    expect(sheet?.carried_lb).toBe(10 + 55 + 0);

    const row = db.prepare('SELECT inventory_json FROM character WHERE campaign_id = ?').get(campaign_id) as {
      inventory_json: string;
    };
    expect(JSON.parse(row.inventory_json)).toEqual(items);
  });
});

describe('companions', () => {
  function withParty() {
    const { campaign_id } = newCampaign();
    createCharacter(db, {
      campaign_id,
      name: 'Borg',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    });
    createCompanion(db, { campaign_id, name: 'Rook', source: { creature: 'Wolf' } });
    createCompanion(db, {
      campaign_id,
      name: 'Sella',
      source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
    });
    return campaign_id;
  }

  it('lists them in the briefing beside the PC', () => {
    const campaignId = withParty();
    const briefing = loadCampaign(db, campaignId);

    expect(briefing.pc?.name).toBe('Borg');
    expect(briefing.companions).toHaveLength(2);
    expect(briefing.companions[0]).toMatchObject({
      name: 'Rook',
      role: 'companion',
      class: null,
      creature: 'Wolf',
      level: 1,
      hp_current: 11,
      hp_max: 11,
    });
    expect(briefing.companions[1]).toMatchObject({ name: 'Sella', class: 'Cleric', creature: null, level: 1 });
  });

  it('renders the whole party in the briefing text', () => {
    const campaignId = withParty();
    const rendered = renderBriefing(loadCampaign(db, campaignId));
    const party = rendered.slice(rendered.indexOf('## Party')).split('\n');

    expect(party[1]).toBe('- Borg, Fighter 1, HP 13/13');
    expect(party[2]).toBe('- Rook, Wolf 1, HP 11/11');
    expect(party[3]).toContain('- Sella, Cleric 1, HP ');
  });

  it('lists them on the campaign card', () => {
    withParty();
    const [row] = listCampaigns(db);
    expect(row?.pc).toEqual({ name: 'Borg', level: 1, class: 'Fighter' });
    expect(row?.companions).toEqual([
      { name: 'Rook', class: 'Wolf', level: 1, hp: '11/11' },
      { name: 'Sella', class: 'Cleric', level: 1, hp: expect.any(String) },
    ]);
  });
});

describe('setting presets and the unfinished-story flag', () => {
  const SETTINGS = {
    setting_preset: 'gothic-horror',
    tone_dials: { lethality: 2, horror: 3 },
    lines: 'harm to children',
    veils: 'torture',
  };

  function shell(premise?: string) {
    return createCampaign(db, { name: 'The Mistward', story_shape: 'structured', premise, settings: SETTINGS });
  }

  it('stores the wizard settings and flags a story that has only a name and a setting', () => {
    const { campaign_id } = shell();
    const { campaign } = loadCampaign(db, campaign_id);
    expect(campaign).toMatchObject({
      premise: null,
      setting_preset: 'gothic-horror',
      setting_name: 'Gothic Horror',
      tone_dials: { lethality: 2, horror: 3 },
      lines: 'harm to children',
      veils: 'torture',
      needs_ai_fill: true,
    });
  });

  it('does not flag a story that came with a premise', () => {
    const { campaign_id } = shell('A village where no one has aged in fifty years.');
    expect(loadCampaign(db, campaign_id).campaign.needs_ai_fill).toBe(false);
  });

  it('leaves a campaign created without settings alone', () => {
    const { campaign_id } = newCampaign();
    expect(loadCampaign(db, campaign_id).campaign).toMatchObject({
      setting_preset: null,
      setting_name: null,
      needs_ai_fill: false,
    });
  });

  it('carries the setting on the chooser rows', () => {
    shell();
    const [row] = listCampaigns(db);
    expect(row).toMatchObject({
      name: 'The Mistward',
      premise: null,
      setting_preset: 'gothic-horror',
      setting_name: 'Gothic Horror',
      needs_ai_fill: true,
    });
    expect(row).not.toHaveProperty('settings_json');
  });

  it('renders the setting and the fill instruction in the briefing', () => {
    const { campaign_id } = shell();
    const rendered = renderBriefing(loadCampaign(db, campaign_id));
    const setting = rendered.slice(rendered.indexOf('## Setting'), rendered.indexOf('## Recap'));

    expect(setting).toContain('Gothic Horror: Mist, curses');
    expect(setting).toContain('Tone: dreadful');
    expect(setting).toContain('Themes: curses');
    expect(setting).toContain('Lethality: Fair');
    expect(setting).toContain('Horror: Explicit dread and gore');
    expect(setting).toContain('Lines - never put these on screen: harm to children');
    expect(setting).toContain('Veils - keep these off screen: torture');
    expect(rendered).toContain('## THIS STORY IS NOT FINISHED');
    expect(rendered).toContain('mark_story_filled');
  });

  it('drops the raw settings line once the setting block says it in words', () => {
    const { campaign_id } = shell();
    const rendered = renderBriefing(loadCampaign(db, campaign_id));
    expect(rendered).toContain('## Setting');
    expect(rendered).not.toContain('Settings: {');

    // A story from chat has no preset, so the settings that are not the player's own dials are
    // still shown as they were stored.
    const legacy = createCampaign(db, { name: 'From chat', story_shape: 'sandbox' }).campaign_id;
    updateSettings(db, legacy, { cheat_mode: true, lines: 'no harm to children' });
    const legacyRendered = renderBriefing(loadCampaign(db, legacy));
    expect(legacyRendered).not.toContain('## Setting');
    expect(legacyRendered).toContain('Settings: {"lines":"no harm to children"}');
    expect(legacyRendered).not.toContain('cheat_mode');
  });

  it('drops the fill instruction once the story has a premise', () => {
    const { campaign_id } = shell('A village where no one has aged in fifty years.');
    const rendered = renderBriefing(loadCampaign(db, campaign_id));
    expect(rendered).toContain('## Setting');
    expect(rendered).not.toContain('THIS STORY IS NOT FINISHED');
  });
});
