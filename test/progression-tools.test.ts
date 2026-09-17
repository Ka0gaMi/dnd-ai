import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus } from '../src/core/bus.js';
import { createCampaign, endSession, ensureOpenSession } from '../src/core/campaign.js';
import { awardXp, createCharacter, grantSpell } from '../src/core/character.js';
import { openChapter } from '../src/core/story.js';
import { resolveDecision, type PendingDecisionRow } from '../src/core/decisions.js';
import { expandHomebrew, powerReport, saveHomebrew, type HomebrewRow, type PowerReport } from '../src/core/progression.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { registerProgressionTools } from '../src/mcp/tools/progression.js';

let db: Db;
let campaignId: number;
let characterId: number;

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerProgressionTools(server, db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result.structuredContent as T;
}

/** A second campaign with a spellcasting PC, so a recommendation has spells to be checked against. */
function wizardCampaign(): number {
  const id = createCampaign(db, { name: 'Spells', story_shape: 'sandbox' }).campaign_id;
  createCharacter(db, {
    campaign_id: id,
    name: 'Zel',
    species: 'Human',
    class: 'Wizard',
    background: 'Sage',
    ability_method: 'standard_array',
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    ability_bonuses: { int: 2, con: 1 },
    skill_choices: ['arcana', 'history', 'investigation'],
    cantrips: ['Fire Bolt', 'Light', 'Prestidigitation'],
    spells: ['Magic Missile', 'Shield', 'Mage Armor', 'Sleep'],
  });
  awardXp(db, { campaign_id: id, amount: 400 });
  return id;
}

/** Stands in for a player who answers the homebrew dialog the moment it appears. */
function answerDecisions(decision: 'accept' | 'reject'): () => void {
  return bus.subscribe((event) => {
    if (event.kind !== 'pending_decision') return;
    resolveDecision(db, (event.payload as PendingDecisionRow).id, { decision });
  });
}

/** The payload the newest decision row stores, which is what the player window is sent. */
type StoredPayload = { name: string; clause_status?: Array<{ describe: string; status: string; reasons: string[] }> };

function storedPayload(): StoredPayload {
  const row = db.prepare('SELECT payload_json FROM pending_decision ORDER BY id DESC LIMIT 1').get() as {
    payload_json: string;
  };
  return JSON.parse(row.payload_json) as StoredPayload;
}

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

const features = (): Array<{ name: string; source: string; mechanics?: { over_budget?: boolean } }> =>
  JSON.parse(
    (db.prepare('SELECT features_json FROM character WHERE id = ?').get(characterId) as { features_json: string })
      .features_json,
  ) as Array<{ name: string; source: string; mechanics?: { over_budget?: boolean } }>;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Tools', story_shape: 'sandbox' }).campaign_id;
  characterId = createCharacter(db, {
    campaign_id: campaignId,
    name: 'Vex',
    species: 'Human',
    class: 'Rogue',
    background: 'Criminal',
    ability_method: 'standard_array',
    abilities: { str: 8, dex: 15, con: 14, int: 13, wis: 12, cha: 10 },
    ability_bonuses: { dex: 2, int: 1 },
    skill_choices: ['acrobatics', 'perception', 'persuasion', 'athletics', 'survival'],
  }).character!.id;
});

afterEach(() => db.close());

describe('propose_feature and rules_mode', () => {
  it('refuses an over-budget feature in a strict campaign', async () => {
    updateSettings(db, campaignId, { rules_mode: 'strict' });
    const client = await connect();
    const result = await call<{ status: string; report: PowerReport; message: string }>(client, 'propose_feature', {
      campaign_id: campaignId,
      ...TRAPWRIGHT,
    });
    expect(result.status).toBe('refused');
    expect(result.report.verdict).toBe('over_budget');
    expect(result.message).toMatch(/strict/);
    expect(features().some((f) => f.name === 'Trapwright')).toBe(false);
  });

  it('applies what fits the budget even in a strict campaign', async () => {
    updateSettings(db, campaignId, { rules_mode: 'strict' });
    const client = await connect();
    const result = await call<{ status: string; power_label: string }>(client, 'propose_feature', {
      ...TRAPWRIGHT,
      campaign_id: campaignId,
      mechanics: {},
      clauses: [{ when: 'always', do: [{ kind: 'proficiency', skill: 'stealth' }] }],
    });
    expect(result.status).toBe('applied');
    expect(result.power_label).toBe('within');
    expect(features().some((f) => f.name === 'Trapwright')).toBe(true);
  });

  it('asks the player in a flexible campaign and applies what they accept', async () => {
    const stop = answerDecisions('accept');
    const client = await connect();
    const result = await call<{ status: string; decision: { summary: string } }>(client, 'propose_feature', {
      campaign_id: campaignId,
      ...TRAPWRIGHT,
    });
    stop();
    expect(result.status).toBe('applied');
    expect(result.decision.summary).toBe('Player accepted "Trapwright" despite the over-budget warning.');
    expect(features().find((f) => f.name === 'Trapwright')?.mechanics?.over_budget).toBe(true);
  });

  it('drops what the player rejects', async () => {
    const stop = answerDecisions('reject');
    const client = await connect();
    const result = await call<{ status: string }>(client, 'propose_feature', { campaign_id: campaignId, ...TRAPWRIGHT });
    stop();
    expect(result.status).toBe('rejected');
    expect(features().some((f) => f.name === 'Trapwright')).toBe(false);
  });

  it('says awaiting_player when nobody answers in time, and the late answer still lands', async () => {
    updateSettings(db, campaignId, { roll_timeout_s: 1 });
    const client = await connect();
    const result = await call<{ status: string; decision_id: number; message: string }>(client, 'propose_feature', {
      campaign_id: campaignId,
      ...TRAPWRIGHT,
    });
    expect(result.status).toBe('awaiting_player');
    expect(result.message).toMatch(/briefing/);
    expect(features().some((f) => f.name === 'Trapwright')).toBe(false);

    resolveDecision(db, result.decision_id, { decision: 'accept' });
    expect(features().some((f) => f.name === 'Trapwright')).toBe(true);
  });

  it('applies at once with a warning in a freeform campaign', async () => {
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const client = await connect();
    const result = await call<{ status: string; warning: string; power_label: string }>(client, 'propose_feature', {
      campaign_id: campaignId,
      ...TRAPWRIGHT,
    });
    expect(result.status).toBe('applied');
    expect(result.power_label).toBe('over_budget');
    expect(result.warning).toMatch(/over-budget marker/);
  });

  it('marks a feature the player asked to be overpowered', async () => {
    const client = await connect();
    const result = await call<{ status: string; power_label: string; homebrew_id: number }>(client, 'propose_feature', {
      campaign_id: campaignId,
      ...TRAPWRIGHT,
      mechanics: {},
      clauses: [{ when: 'damage_dealt', do: [{ kind: 'extra_damage', dice: '4d6' }] }],
      allow_over_budget: true,
    });
    expect(result.status).toBe('applied');
    expect(result.power_label).toBe('over_budget');
    expect(features().find((f) => f.name === 'Trapwright')?.mechanics?.over_budget).toBe(true);
    const stored = db.prepare('SELECT power_label FROM homebrew WHERE id = ?').get(result.homebrew_id);
    expect(stored).toEqual({ power_label: 'over_budget' });
  });
});

describe('one story boon per chapter', () => {
  const FAIR = {
    ...TRAPWRIGHT,
    mechanics: {},
    clauses: [{ when: 'always', do: [{ kind: 'proficiency', skill: 'stealth' }] }],
  };

  it('applies the second one in the same chapter with a warning in a freeform campaign', async () => {
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const client = await connect();
    const first = await call<{ status: string; cadence_warning?: string }>(client, 'propose_feature', {
      campaign_id: campaignId,
      ...FAIR,
    });
    expect(first.status).toBe('applied');
    expect(first.cadence_warning).toBeUndefined();

    const second = await call<{ status: string; cadence_warning?: string }>(client, 'propose_feature', {
      campaign_id: campaignId,
      ...FAIR,
      name: 'Second Wind of Luck',
    });
    expect(second.status).toBe('applied');
    expect(second.cadence_warning).toMatch(/One story boon per chapter/);
  });

  it('refuses the second one in a strict campaign', async () => {
    updateSettings(db, campaignId, { rules_mode: 'strict' });
    const client = await connect();
    expect((await call<{ status: string }>(client, 'propose_feature', { campaign_id: campaignId, ...FAIR })).status).toBe(
      'applied',
    );

    const second = await call<{ status: string; message: string }>(client, 'propose_feature', {
      campaign_id: campaignId,
      ...FAIR,
      name: 'Second Wind of Luck',
    });
    expect(second.status).toBe('refused');
    expect(second.message).toMatch(/One story boon per chapter/);
    expect(features().some((f) => f.name === 'Second Wind of Luck')).toBe(false);
  });

  it('puts the second one to the player in a flexible campaign', async () => {
    updateSettings(db, campaignId, { rules_mode: 'flexible', roll_timeout_s: 1 });
    const client = await connect();
    // "Make it OP" is the player's own call, so the first one needs no dialog.
    const first = await call<{ status: string }>(client, 'propose_feature', {
      campaign_id: campaignId,
      ...FAIR,
      allow_over_budget: true,
    });
    expect(first.status).toBe('applied');

    const second = await call<{ status: string; decision_id: number }>(client, 'propose_feature', {
      campaign_id: campaignId,
      ...FAIR,
      name: 'Second Wind of Luck',
      allow_over_budget: true,
    });
    expect(second.status).toBe('awaiting_player');
    expect(features().some((f) => f.name === 'Second Wind of Luck')).toBe(false);

    resolveDecision(db, second.decision_id, { decision: 'accept' });
    expect(features().some((f) => f.name === 'Second Wind of Luck')).toBe(true);
  });

  it('starts the count again when a new chapter opens', async () => {
    updateSettings(db, campaignId, { rules_mode: 'strict' });
    const client = await connect();
    expect((await call<{ status: string }>(client, 'propose_feature', { campaign_id: campaignId, ...FAIR })).status).toBe(
      'applied',
    );

    // The cadence counts from when the chapter opened, so let the clock move past the first boon.
    await new Promise((resolve) => setTimeout(resolve, 2));
    openChapter(db, { campaign_id: campaignId, title: 'The Long Road' });

    const next = await call<{ status: string }>(client, 'propose_feature', {
      campaign_id: campaignId,
      ...FAIR,
      name: 'Second Wind of Luck',
    });
    expect(next.status).toBe('applied');
  });

  it('counts per session while no chapter has been opened at all', async () => {
    updateSettings(db, campaignId, { rules_mode: 'strict' });
    const client = await connect();
    expect((await call<{ status: string }>(client, 'propose_feature', { campaign_id: campaignId, ...FAIR })).status).toBe(
      'applied',
    );

    endSession(db, { campaign_id: campaignId });
    ensureOpenSession(db, campaignId);

    const nextSession = await call<{ status: string }>(client, 'propose_feature', {
      campaign_id: campaignId,
      ...FAIR,
      name: 'Second Wind of Luck',
    });
    expect(nextSession.status).toBe('applied');

    const sameSession = await call<{ status: string; message: string }>(client, 'propose_feature', {
      campaign_id: campaignId,
      ...FAIR,
      name: 'Third Wind of Luck',
    });
    expect(sameSession.status).toBe('refused');
    expect(sameSession.message).toMatch(/One story boon per chapter/);
  });

  it('leaves a homebrew spell out of the count: it is no story boon', async () => {
    const spells = wizardCampaign();
    updateSettings(db, spells, { rules_mode: 'strict' });
    // The event a homebrew spell writes looks like a feature; only what propose_feature applied counts.
    grantSpell(db, { campaign_id: spells, name: 'Ember Lance', level: 1 });

    const client = await connect();
    const result = await call<{ status: string }>(client, 'propose_feature', { campaign_id: spells, ...FAIR });
    expect(result.status).toBe('applied');
  });
});

describe('a subclass recreated from an official one', () => {
  const ORDER = {
    class: 'Barbarian',
    name: 'Path of the Gale',
    flavour_text: 'The wind answers when you roar.',
    features: {
      '3': [
        {
          name: 'Galestep',
          text: 'You move like weather.',
          clauses: [{ when: 'always', do: [{ kind: 'speed_ft', amount: 10 }] }],
        },
      ],
    },
  };

  it('takes two clauses at a bundle level and refuses a third', async () => {
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const client = await connect();
    const gale = { when: 'always', do: [{ kind: 'speed_ft', amount: 10 }] };
    const bundle = (clauses: unknown[]) => ({
      ...ORDER,
      features: { '3': [{ name: 'Galestep', text: 'You move like weather.', clauses }] },
    });
    const result = await call<{ status: string }>(client, 'propose_subclass', {
      campaign_id: campaignId,
      schema: bundle([gale, gale]),
      justification: 'The wind has carried them all chapter.',
    });
    expect(result.status).toBe('applied');
    await expect(
      call(client, 'propose_subclass', {
        campaign_id: campaignId,
        schema: bundle([gale, gale, gale]),
        justification: 'The wind has carried them all chapter.',
      }),
    ).rejects.toThrow();
  });

  it('stores the label it stands in for and hands it back', async () => {
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const client = await connect();
    const result = await call<{ status: string; homebrew_id: number; recreated_from: string }>(
      client,
      'propose_subclass',
      {
        campaign_id: campaignId,
        schema: ORDER,
        justification: 'The player wants the storm order they played last time.',
        recreated_from: 'Path of the Storm Herald',
      },
    );
    expect(result.status).toBe('applied');
    expect(result.recreated_from).toBe('Path of the Storm Herald');
    expect(db.prepare('SELECT recreated_from FROM homebrew WHERE id = ?').get(result.homebrew_id)).toEqual({
      recreated_from: 'Path of the Storm Herald',
    });
  });
});

describe('the play profile, backgrounds and the library', () => {
  it('notes play and reads it back with the engine tallies', async () => {
    const client = await connect();
    await call(client, 'note_play', {
      campaign_id: campaignId,
      character_id: characterId,
      tags: ['trap', 'engineering'],
      text: 'Rigged the chandelier to drop on the cultists.',
    });
    const profile = await call<{ tags: Record<string, number>; exemplars: Array<{ text: string }>; engine: unknown }>(
      client,
      'get_play_profile',
      { campaign_id: campaignId, character_id: characterId },
    );
    expect(profile.tags).toEqual({ trap: 1, engineering: 1 });
    expect(profile.exemplars[0]!.text).toContain('chandelier');
    expect(profile.engine).toBeDefined();
  });

  it('writes a background, builds a character from it and keeps it in the library', async () => {
    const client = await connect();
    await expect(
      call(client, 'create_background', {
        campaign_id: campaignId,
        name: 'Bad Shape',
        abilities: ['dex', 'dex', 'int'],
        origin_feat: 'Alert',
        skills: ['stealth', 'investigation'],
        tool: "Thieves' Tools",
        equipment: { items: [], gold: 10 },
        text: 'Broken.',
      }),
    ).rejects.toThrow(/three different abilities/);

    const created = await call<{ status: string; homebrew_id: number; report: PowerReport }>(
      client,
      'create_background',
      {
        campaign_id: campaignId,
        name: 'Trapwright',
        abilities: ['dex', 'int', 'wis'],
        origin_feat: 'Alert',
        skills: ['stealth', 'investigation'],
        tool: "Thieves' Tools",
        equipment: { items: [{ name: 'Dagger', qty: 1 }], gold: 15 },
        text: 'You grew up rigging snares under the city.',
      },
    );
    expect(created.status).toBe('created');
    expect(created.report.budget_used).toBe(1);

    const built = createCharacter(db, {
      campaign_id: campaignId,
      name: 'Nix',
      species: 'Human',
      class: 'Rogue',
      background: 'Trapwright',
      ability_method: 'standard_array',
      abilities: { str: 8, dex: 15, con: 14, int: 13, wis: 12, cha: 10 },
      ability_bonuses: { dex: 2, int: 1 },
      skill_choices: ['acrobatics', 'perception', 'persuasion', 'athletics', 'survival'],
    });
    expect(built.character!.background).toBe('Trapwright');

    const saved = await call<{ saved: { scope: string } }>(client, 'save_to_library', {
      homebrew_id: created.homebrew_id,
    });
    expect(saved.saved.scope).toBe('library');
    const listed = await call<{ library: Array<{ name: string; kind: string }> }>(client, 'list_library', {});
    expect(listed.library).toHaveLength(1);
    expect(listed.library[0]!.name).toBe('Trapwright');
  });

  it('keeps one homebrew suggestion per level-up and names the rest back to the DM', async () => {
    const client = await connect();
    const result = await call<{
      level_up: { suggestions: Array<{ name: string }> };
      suggestions_refused: string[];
      message: string;
    }>(client, 'propose_level_up_options', {
      campaign_id: campaignId,
      suggestions: [
        {
          name: 'Snare Master',
          text: 'Your snares are harder to spot.',
          mechanics: { skill_proficiencies: ['stealth'] },
          justification: 'Every fight starts with a trap.',
        },
        {
          name: 'Wall Runner',
          text: 'You move faster along walls.',
          mechanics: { speed: 10 },
          justification: 'They climb everything.',
        },
      ],
    });
    expect(result.level_up.suggestions.map((s) => s.name)).toEqual(['Snare Master']);
    expect(result.suggestions_refused).toEqual(['Wall Runner']);
    expect(result.message).toMatch(/One homebrew suggestion per level-up: "Snare Master" was kept/);
    expect(db.prepare('SELECT name FROM homebrew').all()).toEqual([{ name: 'Snare Master' }]);
  });

  it('stores the suggestion as homebrew the window can send back, and says the level-up is ready', async () => {
    const client = await connect();
    const result = await call<{
      level_up: { to_level: number; suggestions: Array<{ name: string; homebrew_id: number }> };
    }>(client, 'propose_level_up_options', {
      campaign_id: campaignId,
      suggestions: [
        {
          name: 'Snare Master',
          text: 'Your snares are harder to spot.',
          mechanics: { skill_proficiencies: ['stealth'] },
          justification: 'Every fight starts with a trap.',
        },
      ],
    });
    const ids = result.level_up.suggestions.map((s) => s.homebrew_id);
    expect(ids.every((id) => Number.isInteger(id))).toBe(true);
    const rows = db
      .prepare('SELECT id, kind, scope, created_by, power_label, power_report_json FROM homebrew ORDER BY id')
      .all() as Array<{ id: number; kind: string; scope: string; created_by: string; power_report_json: string }>;
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(rows.every((r) => r.kind === 'feature' && r.scope === 'campaign' && r.created_by === 'dm')).toBe(true);
    expect(JSON.parse(rows[0]!.power_report_json)).toMatchObject({ verdict: 'within' });

    const stored = JSON.parse(
      (db.prepare('SELECT pending_level_up_json FROM character WHERE id = ?').get(characterId) as {
        pending_level_up_json: string;
      }).pending_level_up_json,
    ) as { suggestions: Array<{ homebrew_id: number }> };
    expect(stored.suggestions.map((s) => s.homebrew_id)).toEqual(ids);

    const event = db
      .prepare("SELECT text FROM event WHERE campaign_id = ? AND kind = 'level_up_ready' ORDER BY id DESC LIMIT 1")
      .get(campaignId) as { text: string };
    expect(event.text).toBe('Level-up to 2 is ready — choose in the window');
  });

  it('logs the event kinds the window and the briefing read', async () => {
    const client = await connect();
    await call(client, 'note_play', {
      campaign_id: campaignId,
      character_id: characterId,
      tags: ['trap'],
      text: 'Rigged the chandelier to drop on the cultists.',
    });
    awardXp(db, { campaign_id: campaignId, amount: 300 });
    await call(client, 'propose_level_up_options', { campaign_id: campaignId, suggestions: [] });

    const kinds = (
      db.prepare('SELECT kind, text FROM event WHERE campaign_id = ? ORDER BY id').all(campaignId) as Array<{
        kind: string;
        text: string;
      }>
    ).filter((row) => ['play_note', 'xp', 'level_up_ready'].includes(row.kind));
    expect(kinds.map((row) => row.kind)).toEqual(['play_note', 'xp', 'level_up_ready']);
    expect(kinds[0]!.text).toBe('Rigged the chandelier to drop on the cultists.');
  });

  it('stores the recommendations it checked against the options, with the option details', async () => {
    const client = await connect();
    const spellCampaign = wizardCampaign();
    const result = await call<{
      level_up: {
        srd: { details: Record<string, { name: string; school?: string; short_text: string }> };
        recommendations: { spells: Array<{ name: string; why: string }>; hp: string };
      };
    }>(client, 'propose_level_up_options', {
      campaign_id: spellCampaign,
      suggestions: [],
      recommendations: {
        spells: [{ name: 'grease', why: 'A slick floor is how they have won every fight this chapter.' }],
        hp: 'average',
      },
    });

    expect(result.level_up.recommendations.spells[0]!.name).toBe('Grease');
    expect(result.level_up.recommendations.hp).toBe('average');
    expect(result.level_up.srd.details['Grease']).toMatchObject({ name: 'Grease', school: 'conjuration' });

    const stored = JSON.parse(
      (db.prepare("SELECT pending_level_up_json FROM character WHERE campaign_id = ?").get(spellCampaign) as {
        pending_level_up_json: string;
      }).pending_level_up_json,
    ) as { recommendations: { spells: Array<{ name: string }> }; srd: { details: Record<string, unknown> } };
    expect(stored.recommendations.spells[0]!.name).toBe('Grease');
    expect(stored.srd.details['Grease']).toBeDefined();
  });

  it('refuses a recommendation the player could not take, and lists what they can', async () => {
    const client = await connect();
    const spellCampaign = wizardCampaign();
    await expect(
      call(client, 'propose_level_up_options', {
        campaign_id: spellCampaign,
        suggestions: [],
        recommendations: { spells: [{ name: 'Fireball', why: 'Boom.' }] },
      }),
    ).rejects.toThrow(/"Fireball" is not among the spells offered at this level\. Valid options: .*Comprehend Languages/);
    const stored = db.prepare('SELECT pending_level_up_json FROM character WHERE campaign_id = ?').get(spellCampaign);
    expect(stored).toEqual({ pending_level_up_json: null });
  });

  it('prepares the level-up window with the SRD options and the DM suggestions', async () => {
    const client = await connect();
    const result = await call<{
      character_id: number;
      level_up: { to_level: number; suggestions: Array<{ name: string; report: PowerReport }> };
    }>(client, 'propose_level_up_options', {
      campaign_id: campaignId,
      suggestions: [
        {
          name: 'Snare Master',
          text: 'Your snares are harder to spot.',
          mechanics: { skill_proficiencies: ['stealth'] },
          justification: 'Every fight starts with a trap.',
        },
      ],
    });
    expect(result.character_id).toBe(characterId);
    expect(result.level_up.to_level).toBe(2);
    expect(result.level_up.suggestions[0]!.report.verdict).toBe('within');
    const stored = db.prepare('SELECT pending_level_up_json FROM character WHERE id = ?').get(characterId) as {
      pending_level_up_json: string;
    };
    expect(JSON.parse(stored.pending_level_up_json)).toMatchObject({ to_level: 2 });
  });
});

describe('check_mechanics', () => {
  const FORCEFUL_FOCUS = [
    {
      when: 'spell_damage',
      if: { damage_type: ['force'] },
      do: [{ kind: 'extra_damage', dice: '1d6', type: 'force' }],
      uses: 'once_per_turn',
    },
  ];

  it('prices clauses, says the engine runs them, and writes nothing', async () => {
    const client = await connect();
    const result = await call<{
      report: PowerReport;
      clauses: Array<{ describe: string; status: string; reasons: string[] }>;
    }>(client, 'check_mechanics', {
      campaign_id: campaignId,
      text: 'Your force magic bites deeper.',
      clauses: FORCEFUL_FOCUS,
    });
    expect(result.report.budget_used).toBe(0.25);
    // The interpreter reads this one at the spell-damage hook: it runs.
    expect(result.clauses).toEqual([
      {
        describe: 'Extra 1d6 force damage when a spell deals force damage, once per turn',
        status: 'runs',
        reasons: [],
        decide: 'auto',
      },
    ]);
    expect(db.prepare('SELECT count(*) AS n FROM homebrew').get()).toEqual({ n: 0 });
  });

  it('says which clause only reminds, and why', async () => {
    const client = await connect();
    const result = await call<{ clauses: Array<{ status: string; reasons: string[] }> }>(client, 'check_mechanics', {
      campaign_id: campaignId,
      text: 'You see what the dark hides.',
      clauses: [{ when: 'roll', if: { light: 'dim' }, do: [{ kind: 'advantage' }] }],
    });
    expect(result.clauses[0]!.status).toBe('reminds');
    expect(result.clauses[0]!.reasons.join(' ')).toMatch(/R7/);
  });

  it('refuses the older mechanics fields and prices nothing', async () => {
    const client = await connect();
    const result = await call<{ refused: string; report?: PowerReport; clauses: unknown[] }>(client, 'check_mechanics', {
      campaign_id: campaignId,
      text: 'Your snares catch what walks past them.',
      mechanics: { to_hit: 1, skill_proficiencies: ['stealth'] },
    });
    expect(result.refused).toMatch(/Legacy mechanics are no longer accepted: to_hit, skill_proficiencies/);
    expect(result.report).toBeUndefined();
    expect(result.clauses).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM homebrew').get()).toEqual({ n: 0 });
  });
});

describe('legacy mechanics are refused', () => {
  it('refuses a feature written with legacy mechanics, stores nothing and opens no decision', async () => {
    const client = await connect();
    const before = db.prepare('SELECT count(*) AS n FROM homebrew').get();
    await expect(
      call(client, 'propose_feature', {
        campaign_id: campaignId,
        name: 'Trapwright',
        text: 'Your snares catch what walks past them.',
        mechanics: { ac: 1 },
        justification: 'They have rigged a trap in every fight this chapter.',
      }),
    ).rejects.toThrow(/Legacy mechanics are no longer accepted: ac must be written as clauses/);
    expect(db.prepare('SELECT count(*) AS n FROM homebrew').get()).toEqual(before);
    expect(db.prepare('SELECT count(*) AS n FROM pending_decision').get()).toEqual({ n: 0 });
  });

  it('refuses a feature that carries legacy mechanics beside valid clauses', async () => {
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const client = await connect();
    await expect(
      call(client, 'propose_feature', {
        campaign_id: campaignId,
        name: 'Fleet Foot',
        text: 'You outrun the fight.',
        mechanics: { speed: 10 },
        clauses: [{ when: 'always', do: [{ kind: 'speed_ft', amount: 10 }] }],
        justification: 'They have outrun everything all chapter.',
      }),
    ).rejects.toThrow(/Legacy mechanics are no longer accepted: speed must be written as clauses/);
    expect(db.prepare('SELECT count(*) AS n FROM homebrew').get()).toEqual({ n: 0 });
  });

  it('still applies a proposal written with clauses and no mechanics', async () => {
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const client = await connect();
    const result = await call<{ status: string }>(client, 'propose_feature', {
      campaign_id: campaignId,
      name: 'Fleet Foot',
      text: 'You outrun the fight.',
      mechanics: {},
      clauses: [{ when: 'always', do: [{ kind: 'speed_ft', amount: 10 }] }],
      justification: 'They have outrun everything all chapter.',
    });
    expect(result.status).toBe('applied');
    expect(db.prepare('SELECT count(*) AS n FROM homebrew').get()).toEqual({ n: 1 });
  });

  it('refuses a subclass feature written as legacy mechanics and names the level and feature', async () => {
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const client = await connect();
    await expect(
      call(client, 'propose_subclass', {
        campaign_id: campaignId,
        schema: {
          class: 'Barbarian',
          name: 'Path of the Ash',
          flavour_text: 'The fire answers when you call.',
          features: { '3': [{ name: 'Ashen Oath', text: 'Ash coats your blade.', mechanics: { ac: 1 } }] },
        },
        justification: 'The player asked for the ash order.',
      }),
    ).rejects.toThrow(/Level 3 "Ashen Oath": Legacy mechanics are no longer accepted: ac must be written as clauses/);
    expect(db.prepare("SELECT count(*) AS n FROM homebrew WHERE kind = 'subclass'").get()).toEqual({ n: 0 });

    const applied = await call<{ status: string }>(client, 'propose_subclass', {
      campaign_id: campaignId,
      schema: {
        class: 'Barbarian',
        name: 'Path of the Ash',
        flavour_text: 'The fire answers when you call.',
        features: {
          '3': [
            {
              name: 'Ashen Oath',
              text: 'Ash coats your blade.',
              clauses: [{ when: 'always', do: [{ kind: 'bonus', to: 'ac', amount: 1 }] }],
            },
          ],
        },
      },
      justification: 'The player asked for the ash order.',
    });
    expect(applied.status).toBe('applied');
  });

  it('still reads a saved row with legacy mechanics back as clauses', () => {
    const entry = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'feature',
      name: 'Old Ward',
      schema: { mechanics: { ac: 1 } },
    });
    const row = db.prepare('SELECT * FROM homebrew WHERE id = ?').get(entry.id) as HomebrewRow;
    const expanded = expandHomebrew(row);
    expect(expanded.clauses).toHaveLength(1);
    expect(expanded.clauses[0]).toMatchObject({ when: 'always', do: [{ kind: 'bonus', to: 'ac', amount: 1 }] });
  });
});

describe('revise_mechanics', () => {
  /** A feature saved the old way: prose the engine never ran, which is what a revision is for. */
  async function storedFeature(): Promise<number> {
    return saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'feature',
      name: 'Forceful Focus',
      schema: {
        text: 'Your force magic bites deeper.',
        mechanics: { features_text: 'Once a turn your force spells deal an extra 1d6 force damage.' },
      },
    }).id;
  }

  it('restates a feature as clauses, prices that row again and logs it', async () => {
    const homebrewId = await storedFeature();
    const client = await connect();
    const result = await call<{ status: string; report: PowerReport; clauses: Array<{ describe: string }> }>(
      client,
      'revise_mechanics',
      {
        campaign_id: campaignId,
        homebrew_id: homebrewId,
        clauses: [
          {
            when: 'spell_damage',
            if: { damage_type: ['force'] },
            do: [{ kind: 'extra_damage', dice: '1d6', type: 'force' }],
            uses: 'once_per_turn',
          },
        ],
        reason: 'The engine can run it now.',
      },
    );
    expect(result.status).toBe('revised');
    expect(result.report.budget_used).toBe(0.25);
    expect(result.clauses[0]!.describe).toBe(
      'Extra 1d6 force damage when a spell deals force damage, once per turn',
    );

    const row = db.prepare('SELECT schema_json, power_report_json FROM homebrew WHERE id = ?').get(homebrewId) as {
      schema_json: string;
      power_report_json: string;
    };
    // A revision replaces the rule: the clauses are what the row says now, and the legacy
    // mechanics go with it, so the row prices at the one number the revision was given.
    expect(JSON.parse(row.schema_json).clauses).toHaveLength(1);
    expect(JSON.parse(row.schema_json).mechanics).toEqual({});
    expect(JSON.parse(row.power_report_json).budget_used).toBe(0.25);
    expect(powerReport(JSON.parse(row.schema_json)).budget_used).toBe(0.25);
    const event = db
      .prepare("SELECT text FROM event WHERE kind = 'homebrew_revised' ORDER BY id DESC LIMIT 1")
      .get() as { text: string };
    expect(event.text).toMatch(/Forceful Focus restated/);
  });

  it('refuses a restatement above the budget outside a freeform campaign', async () => {
    const homebrewId = await storedFeature();
    updateSettings(db, campaignId, { rules_mode: 'flexible' });
    const client = await connect();
    const result = await call<{ status: string; message: string }>(client, 'revise_mechanics', {
      campaign_id: campaignId,
      homebrew_id: homebrewId,
      clauses: [{ when: 'damage_dealt', do: [{ kind: 'extra_damage', dice: '4d6' }] }],
      reason: 'Making it what the player remembers.',
    });
    expect(result.status).toBe('refused');
    expect(result.message).toMatch(/propose_feature/);
    const row = db.prepare('SELECT schema_json FROM homebrew WHERE id = ?').get(homebrewId) as { schema_json: string };
    expect(JSON.parse(row.schema_json).clauses).toBeUndefined();
  });

  it('refuses anything that is not a feature', async () => {
    const spell = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'spell',
      name: 'Ember Bolt',
      schema: { text: 'A dart of fire.' },
    });
    const client = await connect();
    const result = await call<{ status: string; message: string }>(client, 'revise_mechanics', {
      campaign_id: campaignId,
      homebrew_id: spell.id,
      clauses: [{ when: 'always', do: [{ kind: 'resistance', types: ['fire'] }] }],
      reason: 'It should have been a rule.',
    });
    expect(result.status).toBe('refused');
    expect(result.message).toMatch(/propose_spell/);
    const row = db.prepare('SELECT schema_json FROM homebrew WHERE id = ?').get(spell.id) as { schema_json: string };
    expect(JSON.parse(row.schema_json).clauses).toBeUndefined();
  });

  it("refuses another campaign's entry", async () => {
    const other = wizardCampaign();
    const theirs = saveHomebrew(db, {
      campaign_id: other,
      kind: 'feature',
      name: 'Ember Step',
      schema: { text: 'You step through the fire.' },
    });
    const client = await connect();
    const result = await call<{ status: string; message: string }>(client, 'revise_mechanics', {
      campaign_id: campaignId,
      homebrew_id: theirs.id,
      clauses: [{ when: 'always', do: [{ kind: 'resistance', types: ['fire'] }] }],
      reason: 'It should have been a rule.',
    });
    expect(result.status).toBe('refused');
    expect(result.message).toMatch(/belongs to another campaign/);
    const row = db.prepare('SELECT schema_json FROM homebrew WHERE id = ?').get(theirs.id) as { schema_json: string };
    expect(JSON.parse(row.schema_json).clauses).toBeUndefined();
  });
});

describe('the library shows what each clause does', () => {
  it('lists a subclass bundle with the status of the clauses at every level', async () => {
    const bundle = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'subclass',
      name: 'Way of the Ember',
      schema: {
        class: 'Monk',
        name: 'Way of the Ember',
        flavour_text: 'They carry the forge with them.',
        features: {
          '6': [
            {
              name: 'Ember Skin',
              text: 'Fire no longer bites.',
              clauses: [{ when: 'always', do: [{ kind: 'resistance', types: ['fire'] }] }],
            },
          ],
          '3': [
            {
              name: 'Ember Strike',
              text: 'Your strikes carry the coals.',
              clauses: [
                { when: 'hit', do: [{ kind: 'extra_damage', dice: '1d4', type: 'fire' }], uses: 'once_per_turn' },
              ],
            },
          ],
        },
      },
    });
    const client = await connect();
    await call(client, 'save_to_library', { homebrew_id: bundle.id });
    const listed = await call<{
      library: Array<{ name: string; clause_status: Array<{ describe: string; status: string; reasons: string[] }> }>;
    }>(client, 'list_library', { kind: 'subclass' });
    // The bundle's clauses, in level order, each with what the engine will do with it.
    expect(listed.library[0]!.clause_status).toEqual([
      { describe: 'Extra 1d4 fire damage when you hit, once per turn', status: 'runs', reasons: [] },
      { describe: 'Resistance to fire damage', status: 'runs', reasons: [] },
    ]);
  });
});

describe('a proposal tells the player what each clause will do', () => {
  it('reports a clause the engine runs', async () => {
    const stop = answerDecisions('accept');
    const client = await connect();
    await call(client, 'propose_feature', {
      campaign_id: campaignId,
      name: 'Forceful Focus',
      text: 'Your force magic bites deeper.',
      mechanics: {},
      clauses: [
        {
          when: 'spell_damage',
          if: { damage_type: ['force'] },
          do: [{ kind: 'extra_damage', dice: '1d6', type: 'force' }],
          uses: 'once_per_turn',
        },
      ],
      justification: 'They have leaned on force magic all chapter.',
    });
    stop();
    expect(storedPayload().clause_status).toEqual([
      { describe: 'Extra 1d6 force damage when a spell deals force damage, once per turn', status: 'runs', reasons: [] },
    ]);
  });

  it('reports a verb the engine can only remind about, with the reason', async () => {
    const stop = answerDecisions('accept');
    const client = await connect();
    await call(client, 'propose_feature', {
      campaign_id: campaignId,
      name: 'Ironhide',
      text: 'Your hide turns the blade.',
      mechanics: {},
      clauses: [{ when: 'always', do: [{ kind: 'min_die', value: 3 }] }],
      justification: 'They have taken a beating all chapter.',
    });
    stop();
    const line = storedPayload().clause_status![0]!;
    expect(line.status).toBe('reminds');
    expect(line.reasons.join(' ')).toMatch(/damage-die surgery/);
  });

  it('reads a note clause as a reminder, with the reason', async () => {
    const stop = answerDecisions('accept');
    const client = await connect();
    await call(client, 'propose_feature', {
      campaign_id: campaignId,
      name: 'Arcane Ward',
      text: 'The ward takes the blow for you.',
      mechanics: {},
      clauses: [{ when: 'always', do: [{ kind: 'note', text: 'Reduce the damage you take by 3.' }] }],
      justification: 'They have been shielding the party all chapter.',
    });
    stop();
    const line = storedPayload().clause_status![0]!;
    expect(line.describe).toMatch(/Reduce the damage/);
    expect(line.status).toBe('reminds');
    expect(line.reasons.join(' ')).toMatch(/note is a reminder/);
  });

  it('sends a subclass proposal its clauses in the order the schema stores them', async () => {
    const stop = answerDecisions('accept');
    const client = await connect();
    await call(client, 'propose_subclass', {
      campaign_id: campaignId,
      schema: {
        class: 'Barbarian',
        name: 'Path of the Ember',
        flavour_text: 'They carry the forge with them.',
        features: {
          '6': [
            {
              name: 'Ember Skin',
              text: 'Fire no longer bites.',
              clauses: [{ when: 'always', do: [{ kind: 'resistance', types: ['fire'] }] }],
            },
          ],
          '3': [
            {
              name: 'Ember Strike',
              text: 'Your strikes carry the coals.',
              clauses: [
                { when: 'hit', do: [{ kind: 'extra_damage', dice: '1d4', type: 'fire' }], uses: 'once_per_turn' },
              ],
            },
          ],
        },
      },
      justification: 'The forge order they asked for.',
    });
    stop();
    expect(storedPayload().clause_status).toEqual([
      { describe: 'Extra 1d4 fire damage when you hit, once per turn', status: 'runs', reasons: [] },
      { describe: 'Resistance to fire damage', status: 'runs', reasons: [] },
    ]);
  });

  it('says nothing about clauses for a spell, which carries none', async () => {
    const stop = answerDecisions('accept');
    const client = await connect();
    await call(client, 'propose_spell', {
      campaign_id: campaignId,
      schema: {
        name: 'Ember Lance',
        level: 1,
        school: 'evocation',
        casting_time: 'action',
        range: '60 feet',
        components: 'V, S',
        duration: 'instantaneous',
        concentration: false,
        ritual: false,
        effect: { kind: 'auto', damage: { dice: '2d6', type: 'fire' }, targets: 1 },
        text: 'A lance of embers spears one creature you can see.',
      },
      justification: 'They burned the whole camp down.',
    });
    stop();
    expect(storedPayload().clause_status).toBeUndefined();
  });
});
