// A2a-2 review fixes: a homebrew subclass in homebrew_ids obeys the level_plan rule, and lineage spells backfill on load.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCompanion, listInventory, useSpellSlot } from '../src/core/character.js';
import { saveHomebrew } from '../src/core/progression.js';
import { openDb, type Db } from '../src/db/connection.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;
let stopClicking: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Fixes', story_shape: 'sandbox' }).campaign_id;
  stopClicking = resolvePendingRollsImmediately(db);
});

afterEach(() => {
  stopClicking();
});

const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('level_plan with a homebrew subclass in homebrew_ids', () => {
  it('refuses it at a level that offers no subclass, and creates nothing', () => {
    const id = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'subclass',
      name: 'Storm Knight',
      schema: { class: 'Fighter', name: 'Storm Knight', flavour_text: 'Thunder.', features: { '3': [{ name: 'Stormstep', text: 'Weather.' }] } },
    }).id;
    const before = [count('character'), count('event'), count('roll')];
    expect(() =>
      createCompanion(db, {
        campaign_id: campaignId,
        name: 'Bran',
        source: { class: 'Fighter', species: 'Human', background: 'Soldier', level: 3, level_plan: { '2': { homebrew_ids: [id] } } },
      }),
    ).toThrow(/chooses one at level 3: move it to level_plan\["3"\]/);
    expect([count('character'), count('event'), count('roll')]).toEqual(before);
  });
});

describe('lineage spell backfill', () => {
  const stored = (id: number) => db.prepare('SELECT features_json, spells_json FROM character WHERE id = ?').get(id) as { features_json: string; spells_json: string };
  const darkness = (id: number) => (JSON.parse(stored(id).features_json) as { name: string; mechanics?: Record<string, unknown> }[]).find((f) => f.name === 'Darkness');

  function oldDrow(): number {
    const built = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Vael',
      source: { class: 'Fighter', species: 'Elf', lineage: 'Elven Lineage: Drow', background: 'Soldier', level: 5 },
    });
    const id = built.companion!.id as number;
    const features = (JSON.parse(stored(id).features_json) as { name: string; mechanics?: Record<string, unknown> }[]).map((f) => {
      if (!f.mechanics?.lineage_spell) return f;
      const { lineage_spell, spellcasting_ability, resource, max, per, used, ...rest } = f.mechanics;
      void [lineage_spell, spellcasting_ability, resource, max, per, used];
      return { ...f, mechanics: rest };
    });
    const spells = JSON.parse(stored(id).spells_json) as Record<string, unknown>;
    spells.cantrips = (spells.cantrips as string[]).filter((s) => s !== 'Dancing Lights');
    spells.prepared = (spells.prepared as string[]).filter((s) => s !== 'Faerie Fire' && s !== 'Darkness');
    spells.granted = [];
    db.prepare('UPDATE character SET features_json = ?, spells_json = ? WHERE id = ?').run(JSON.stringify(features), JSON.stringify(spells), id);
    expect(darkness(id)!.mechanics?.lineage_spell).toBeUndefined();
    return id;
  }
  const load = (id: number) => listInventory(db, { campaign_id: campaignId, character_id: id });

  it('grants a level 5 Drow built the old way its spells and a full free cast, once', () => {
    const id = oldDrow();
    load(id);
    const spells = JSON.parse(stored(id).spells_json) as { cantrips: string[]; prepared: string[] };
    expect(spells.cantrips).toContain('Dancing Lights');
    expect(spells.prepared).toEqual(expect.arrayContaining(['Faerie Fire', 'Darkness']));
    expect(darkness(id)!.mechanics).toMatchObject({ lineage_spell: 'Darkness', resource: 'lineage_darkness', max: 1, used: 0 });

    const once = stored(id);
    load(id);
    expect(stored(id)).toEqual(once);
  });

  it('does not refill a free cast that was spent', () => {
    const id = oldDrow();
    load(id);
    useSpellSlot(db, { campaign_id: campaignId, character_id: id, level: 2, spell: 'Darkness' });
    expect(darkness(id)!.mechanics!.used).toBe(1);
    load(id);
    expect(darkness(id)!.mechanics!.used).toBe(1);
  });
});
