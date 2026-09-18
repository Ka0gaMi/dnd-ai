import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import {
  addItem,
  awardXp,
  createCharacter,
  createCompanion,
  levelUp,
  levelUpOptions,
  retireCompanion,
} from '../src/core/character.js';
import { createDecision } from '../src/core/decisions.js';
import { addPlayNote, powerReport, saveHomebrew } from '../src/core/progression.js';
import { openDb, type Db } from '../src/db/connection.js';
import registerCharacterRoutes from '../src/transport/routes/characters.js';
import registerDecisionRoutes from '../src/transport/routes/decisions.js';
import registerProgressionRoutes from '../src/transport/routes/progression.js';

let db: Db;
let base: string;
let campaignId: number;
let characterId: number;
let close: () => Promise<void>;

const get = async <T>(path: string): Promise<T> => (await fetch(`${base}${path}`)).json() as Promise<T>;

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

beforeEach(async () => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Routes', story_shape: 'sandbox' }).campaign_id;
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

  const app = express();
  app.use(express.json());
  registerCharacterRoutes(app, db);
  registerProgressionRoutes(app, db);
  registerDecisionRoutes(app, db);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  await close();
  db.close();
});

describe('the level-up panel', () => {
  it('serves the SRD options with the DM proposals and applies a homebrew choice', async () => {
    const entry = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'feature',
      name: 'Snare Master',
      schema: { text: 'Your snares are harder to spot.' },
      report: powerReport({ skill_proficiencies: ['stealth'] }),
    });
    db.prepare('UPDATE character SET pending_level_up_json = ? WHERE id = ?').run(
      JSON.stringify({
        to_level: 2,
        prepared_at: '2026-09-11T10:00:00.000Z',
        suggestions: [{ name: 'Snare Master', homebrew_id: entry.id }],
      }),
      characterId,
    );
    awardXp(db, { campaign_id: campaignId, amount: 300 });

    const panel = await get<{
      character_id: number;
      available: boolean;
      level_up: { to_level: number; prepared_at: string; srd: { hp: unknown }; suggestions: Array<{ name: string }> };
    }>(`/api/characters/${characterId}/level-up`);
    expect(panel.character_id).toBe(characterId);
    expect(panel.available).toBe(true);
    expect(panel.level_up.to_level).toBe(2);
    expect(panel.level_up.prepared_at).toBe('2026-09-11T10:00:00.000Z');
    expect(panel.level_up.srd.hp).toBeDefined();
    expect(panel.level_up.suggestions[0]!.name).toBe('Snare Master');

    const applied = await post<{ level: number; features_gained: string[] }>(
      `/api/characters/${characterId}/level-up`,
      { choices: { hp: 'average' }, homebrew_ids: [entry.id] },
    );
    expect(applied.status).toBe(200);
    expect(applied.body.level).toBe(2);
    expect(applied.body.features_gained).toContain('Snare Master');
    const after = db.prepare('SELECT pending_level_up_json FROM character WHERE id = ?').get(characterId);
    expect(after).toEqual({ pending_level_up_json: null });
  });

  it('carries the option details and the DM recommendations the window shows', async () => {
    awardXp(db, { campaign_id: campaignId, amount: 2700 });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', subclass: 'Thief' } });
    const recommendations = {
      asi: { abilities: ['dex'], why: 'Everything they do runs through Dexterity.' },
      hp: 'average',
    };
    db.prepare('UPDATE character SET pending_level_up_json = ? WHERE id = ?').run(
      JSON.stringify({ to_level: 4, prepared_at: '2026-09-11T10:00:00.000Z', suggestions: [], recommendations }),
      characterId,
    );

    const panel = await get<{
      level_up: {
        to_level: number;
        srd: { details: Record<string, { name: string; prerequisite?: string | null; short_text: string }> };
        recommendations: typeof recommendations;
      };
    }>(`/api/characters/${characterId}/level-up`);

    expect(panel.level_up.to_level).toBe(4);
    expect(panel.level_up.srd.details['Grappler']!.prerequisite).toContain('Level 4');
    expect(panel.level_up.srd.details['dex']).toEqual({ name: 'Dexterity', short_text: 'Agility, reflexes, and balance' });
    expect(panel.level_up.recommendations).toEqual(recommendations);
  });

  it('applies the suggestion the player took and drops the one they did not', async () => {
    const offer = (name: string): number =>
      saveHomebrew(db, {
        campaign_id: campaignId,
        kind: 'feature',
        name,
        schema: { text: `${name} on the sheet.`, mechanics: { skill_proficiencies: ['stealth'] } },
        report: powerReport({ skill_proficiencies: ['stealth'] }),
      }).id;
    const taken = offer('Snare Master');
    const dropped = offer('Wall Runner');
    db.prepare('UPDATE character SET pending_level_up_json = ? WHERE id = ?').run(
      JSON.stringify({
        to_level: 2,
        prepared_at: '2026-09-11T10:00:00.000Z',
        suggestions: [
          { name: 'Snare Master', homebrew_id: taken },
          { name: 'Wall Runner', homebrew_id: dropped },
        ],
      }),
      characterId,
    );
    awardXp(db, { campaign_id: campaignId, amount: 300 });

    const applied = await post<{ features_gained: string[] }>(`/api/characters/${characterId}/level-up`, {
      choices: { hp: 'average' },
      homebrew_ids: [taken],
    });
    expect(applied.status).toBe(200);
    expect(applied.body.features_gained).toContain('Snare Master');
    expect(applied.body.features_gained).not.toContain('Wall Runner');
    expect(db.prepare('SELECT id FROM homebrew WHERE id = ?').get(dropped)).toBeUndefined();
    const kept = db.prepare('SELECT schema_json FROM homebrew WHERE id = ?').get(taken) as { schema_json: string };
    expect(JSON.parse(kept.schema_json)).toMatchObject({ chosen: true });
  });

  it('says a level-up is available before the DM has prepared any options', async () => {
    const before = await get<{ available: boolean; level_up: unknown }>(`/api/characters/${characterId}/level-up`);
    expect(before.available).toBe(false);
    expect(before.level_up).toBeNull();

    awardXp(db, { campaign_id: campaignId, amount: 300 });
    const waiting = await get<{ available: boolean; level_up: unknown }>(`/api/characters/${characterId}/level-up`);
    expect(waiting.available).toBe(true);
    expect(waiting.level_up).toBeNull();
  });

  it('answers a bad level-up with the message the player has to act on', async () => {
    const refused = await post<{ error: string }>(`/api/characters/${characterId}/level-up`, { choices: {} });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/needs more XP/);
    expect((await post(`/api/characters/999/level-up`, {})).status).toBe(404);
  });
});

describe('the library, the play profile and the decision dialog', () => {
  it('lists campaign homebrew beside the library and moves an entry over', async () => {
    const entry = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'feat',
      name: 'Trapwright',
      schema: { text: 'You rig snares.' },
      report: powerReport({ skill_proficiencies: ['stealth'] }),
    });
    const before = await get<{ campaign: unknown[]; library: unknown[] }>(`/api/campaigns/${campaignId}/library`);
    expect(before.campaign).toHaveLength(1);
    expect(before.library).toHaveLength(0);

    const saved = await post<{ scope: string }>(`/api/homebrew/${entry.id}/library`, {});
    expect(saved.body.scope).toBe('library');
    const after = await get<{ campaign: unknown[]; library: unknown[] }>(`/api/campaigns/${campaignId}/library`);
    expect(after.campaign).toHaveLength(0);
    expect(after.library).toHaveLength(1);
  });

  it('serves the play profile for one character', async () => {
    addPlayNote(db, { campaign_id: campaignId, character_id: characterId, tags: ['trap'], text: 'A snare in the door.' });
    const profile = await get<{ tags: Record<string, number> }>(
      `/api/campaigns/${campaignId}/play-profile?character_id=${characterId}`,
    );
    expect(profile.tags).toEqual({ trap: 1 });
  });

  it('keeps the fractional cost the DM put on an edited ability and prices the result again', async () => {
    const mechanics = { skill_proficiencies: ['stealth'] };
    const decision = createDecision(db, {
      campaign_id: campaignId,
      kind: 'homebrew_feature',
      payload: {
        name: 'Smoke Step',
        text: 'You step into smoke.',
        mechanics,
        report: powerReport(mechanics),
        character_id: null,
      },
    });
    const answered = await post<{ applied: boolean; power_label: string }>(`/api/decisions/${decision.id}/resolve`, {
      decision: 'edit',
      edits: {
        mechanics: {
          once_per: 'short',
          effect: 'Vanish for a round',
          effect_cost: 0.75,
          extra_damage: { dice: '2d6', per: 'hit' },
        },
      },
    });
    expect(answered.status).toBe(200);
    expect(answered.body.applied).toBe(true);
    expect(answered.body.power_label).toBe('over_budget');
    const entry = db.prepare('SELECT power_report_json FROM homebrew ORDER BY id DESC LIMIT 1').get() as {
      power_report_json: string;
    };
    // 1 for 2d6 on every hit, and the effect_cost of 0.75 carried through as the note's own price.
    const report = JSON.parse(entry.power_report_json) as { budget_used: number; items: Array<{ cost: number }> };
    expect(report).toMatchObject({ budget_used: 1.75, verdict: 'over_budget' });
    expect(report.items.map((item) => item.cost)).toEqual([1, 0.75]);
  });

  it('lists the open decision and resolves it', async () => {
    const mechanics = { to_hit: 1, ac: 1, speed: 10 };
    const decision = createDecision(db, {
      campaign_id: campaignId,
      kind: 'homebrew_feature',
      payload: {
        name: 'Trapwright',
        text: 'Your snares catch what walks past them.',
        mechanics,
        report: powerReport(mechanics),
        character_id: null,
      },
    });
    const open = await get<Array<{ id: number; payload: { name: string } }>>(`/api/campaigns/${campaignId}/decisions`);
    expect(open).toHaveLength(1);
    expect(open[0]!.payload.name).toBe('Trapwright');

    const answered = await post<{ summary: string; applied: boolean }>(`/api/decisions/${decision.id}/resolve`, {
      decision: 'accept',
    });
    expect(answered.status).toBe(200);
    expect(answered.body.summary).toBe('Player accepted "Trapwright" despite the over-budget warning.');
    expect(await get(`/api/campaigns/${campaignId}/decisions`)).toEqual([]);
    expect((await post(`/api/decisions/${decision.id}/resolve`, { decision: 'accept' })).status).toBe(409);
    expect((await post(`/api/decisions/${decision.id}/resolve`, { decision: 'maybe' })).status).toBe(400);
  });
});

describe('the level-up route and the dialog agree on the choice keys', () => {
  it('passes a wizard spellbook through instead of stripping it', async () => {
    // Zod drops what it does not name, so a key the dialog sends but the schema omits
    // vanishes silently and the engine then refuses the level-up it was meant to complete.
    const wizardCampaign = createCampaign(db, { name: 'Tower', story_shape: 'sandbox' }).campaign_id;
    const wizard = createCharacter(db, {
      campaign_id: wizardCampaign,
      name: 'Isolde',
      species: 'Human',
      class: 'Wizard',
      background: 'Sage',
      ability_method: 'standard_array',
      abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
      ability_bonuses: { int: 2, con: 1 },
      skill_choices: ['arcana', 'history', 'insight'],
      cantrips: ['Fire Bolt', 'Light', 'Mage Hand'],
      spells: ['Magic Missile', 'Shield', 'Detect Magic', 'Sleep'],
    }).character!;
    awardXp(db, { campaign_id: wizardCampaign, amount: 300 });

    const options = levelUpOptions(db, wizardCampaign, wizard.id) as {
      spellcasting?: { spellbook?: { to_add: number; options: Record<string, string[]> } };
    };
    const book = options.spellcasting?.spellbook;
    expect(book?.to_add).toBe(2);
    const held = new Set(
      (
        JSON.parse(
          (db.prepare('SELECT spells_json FROM character WHERE id = ?').get(wizard.id) as { spells_json: string })
            .spells_json,
        ) as { spellbook?: string[] }
      ).spellbook?.map((name) => name.toLowerCase()) ?? [],
    );
    const additions = Object.values(book?.options ?? {})
      .flat()
      .filter((name) => !held.has(name.toLowerCase()))
      .slice(0, 2);
    expect(additions).toHaveLength(2);

    // Level 2 also adds one prepared spell, which must come from the pages the book now holds.
    const prepared = additions[0]!;
    const applied = await post<{ level: number; error?: string }>(`/api/characters/${wizard.id}/level-up`, {
      choices: { hp: 'average', spellbook: additions, spells: [prepared] },
    });
    expect(applied.status).toBe(200);
    expect(applied.body.level).toBe(2);
    const after = JSON.parse(
      (db.prepare('SELECT spells_json FROM character WHERE id = ?').get(wizard.id) as { spells_json: string })
        .spells_json,
    ) as { spellbook: string[] };
    for (const name of additions) expect(after.spellbook).toContain(name);
  });

  it('takes an ability increase that names only the abilities it raises', async () => {
    // An enum-keyed z.record is exhaustive in zod 4: it would demand all six abilities and
    // refuse the dialog's "+2 to dex", which is what every ASI level actually sends.
    awardXp(db, { campaign_id: campaignId, amount: 2700 });
    for (const level of [2, 3]) {
      const step = await post<{ level: number; error?: string }>(`/api/characters/${characterId}/level-up`, {
        // A Rogue picks its subclass at 3; the rest of the climb needs nothing but hit points.
        choices: level === 3 ? { hp: 'average', subclass: 'Thief' } : { hp: 'average' },
      });
      expect(step.body.error ?? `level ${level}`).toBe(`level ${level}`);
      expect(step.status).toBe(200);
    }
    const applied = await post<{ level: number; error?: string }>(`/api/characters/${characterId}/level-up`, {
      choices: { hp: 'average', ability_increases: { dex: 2 } },
    });
    expect(applied.status).toBe(200);
    expect(applied.body.level).toBe(4);

    const bogus = await post(`/api/characters/${characterId}/level-up`, {
      choices: { ability_increases: { charisma: 2 } },
    });
    expect(bogus.status).toBe(400);
  });
});

describe('the character sheet route', () => {
  const rook = (): number =>
    createCompanion(db, { campaign_id: campaignId, name: 'Rook', source: { creature: 'Wolf' } }).companion!.id;

  it('serves a companion sheet in the shape the player already reads', async () => {
    const id = rook();
    const sheet = await get<{
      id: number;
      name: string;
      role: string;
      hp_current: number;
      features: unknown[];
      inventory: unknown[];
    }>(`/api/characters/${id}/sheet`);

    expect(sheet.id).toBe(id);
    expect(sheet.name).toBe('Rook');
    expect(sheet.role).toBe('companion');
    expect(sheet.hp_current).toBeGreaterThan(0);
    expect(Array.isArray(sheet.features)).toBe(true);
    expect(Array.isArray(sheet.inventory)).toBe(true);
  });

  it('masks an unidentified item exactly as the player sheet does', async () => {
    const id = rook();
    addItem(db, {
      campaign_id: campaignId,
      character_id: id,
      name: 'Cinderfang',
      unidentified: true,
      magic: { rarity: 'uncommon', bonus: 1, base: 'Longsword' },
    });

    const res = await fetch(`${base}/api/characters/${id}/sheet`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain('Cinderfang');
    const sheet = JSON.parse(text) as { inventory: Array<{ name: string }> };
    expect(sheet.inventory.map((item) => item.name)).toContain('Unidentified longsword');
  });

  it('serves the player character and matches the snapshot exactly', async () => {
    const res = await fetch(`${base}/api/characters/${characterId}/sheet`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(campaignSnapshot(db, campaignId, { forPlayer: true }).pc);
  });

  it('refuses a retired companion and an unknown character', async () => {
    const id = rook();
    retireCompanion(db, { campaign_id: campaignId, character_id: id });
    expect((await fetch(`${base}/api/characters/${id}/sheet`)).status).toBe(404);
    expect((await fetch(`${base}/api/characters/999999/sheet`)).status).toBe(404);
  });
});
