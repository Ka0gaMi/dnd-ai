// A2a-1: the rest rules brought to SRD 5.2.1 - 1 HP to start a short rest, at least 1 HP per Hit Point Die, a short
// rest's benefits from a long rest broken off after an hour, Concentration that outlasts a short rest, one item per rest.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advanceTime, nowState } from '../src/core/calendar.js';
import { createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import {
  addItem,
  applyDamage,
  concentrationOf,
  createCharacter,
  createCompanion,
  partyRest,
  rest,
  setExhaustion,
  sheetExtras,
  stabilize,
  useSpellSlot,
  type CreateCharacterInput,
  type RestInput,
} from '../src/core/character.js';
import { openPendingRolls, resolvePendingRoll, restWithPlayerRolls } from '../src/core/rolls.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'A2a-1 rests', story_shape: 'sandbox' }).campaign_id;
});

afterEach(() => {
  Math.random = realRandom;
});

function make(overrides: Partial<CreateCharacterInput>): number {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
    ...overrides,
  }).character!.id;
}

const fighter = (): number => make({});

const warlock = (): number =>
  make({
    name: 'Hex',
    species: 'Human',
    class: 'Warlock',
    background: 'Acolyte',
    abilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 },
    ability_bonuses: { cha: 2, int: 1 },
    skill_choices: ['arcana', 'deception', 'history'],
    cantrips: ['Eldritch Blast', 'Prestidigitation'],
    spells: ['Hex', 'Charm Person'],
    feature_options: { 'Eldritch Invocations': ['Pact of the Blade'] },
  });

const wizard = (): number =>
  make({
    name: 'Zel',
    species: 'Human',
    class: 'Wizard',
    background: 'Sage',
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    ability_bonuses: { int: 2, con: 1 },
    skill_choices: ['arcana', 'investigation', 'perception'],
    cantrips: ['Light', 'Mage Hand', 'Ray of Frost'],
    spells: ['Magic Missile', 'Shield', 'Sleep', 'Identify'],
    spellbook: ['Magic Missile', 'Shield', 'Sleep', 'Identify', 'Alarm', 'Feather Fall'],
  });

const cleric = (): number => {
  const id = make({
    name: 'Sella',
    species: 'Human',
    class: 'Cleric',
    background: 'Acolyte',
    abilities: { str: 13, dex: 10, con: 14, int: 8, wis: 15, cha: 12 },
    ability_bonuses: { wis: 2, cha: 1 },
    skill_choices: ['insight', 'religion', 'medicine'],
    cantrips: ['Guidance', 'Sacred Flame', 'Thaumaturgy'],
    spells: ['Bless', 'Cure Wounds', 'Guiding Bolt', 'Healing Word'],
  });
  db.prepare('UPDATE character SET spell_slots_json = ? WHERE id = ?').run(
    JSON.stringify({ '1': { max: 4, used: 0 }, '2': { max: 3, used: 0 } }),
    id,
  );
  return id;
};

const sheet = (id?: number) => getCharacterSheet(db, campaignId, id)!;
const clock = (): string => nowState(db, campaignId).date_text;

/** Everything a refused rest must leave as it found: the sheet, the clock, the journal and the dice rolled. */
function ledger(id?: number) {
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE campaign_id = ?`).get(campaignId) as { n: number }).n;
  return { sheet: sheet(id), extras: sheetExtras(db, campaignId, id), clock: clock(), events: count('event'), rolls: count('roll') };
}

const downed = (id?: number): void => {
  applyDamage(db, { campaign_id: campaignId, character_id: id, amount: sheet(id).hp_max as number });
};

describe('1. a short rest needs at least 1 Hit Point to start', () => {
  it('refuses a short rest at 0 HP, says to heal or stabilise first, and costs nothing', () => {
    fighter();
    downed();
    const before = ledger();
    expect(() => rest(db, { campaign_id: campaignId, kind: 'short', hit_dice_to_spend: 1 })).toThrow(
      'Borg is at 0 HP, and a short rest needs at least 1 Hit Point to start. Heal them first, or stabilise them; a stable creature regains 1 HP after 1d4 hours.',
    );
    expect(ledger()).toEqual(before);
  });

  it('tells a stable character to heal or wait, and costs nothing', () => {
    fighter();
    downed();
    stabilize(db, { campaign_id: campaignId, source: "a healer's kit" });
    const before = ledger();
    expect(() => rest(db, { campaign_id: campaignId, kind: 'short' })).toThrow(
      'Borg is at 0 HP, and a short rest needs at least 1 Hit Point to start. Heal them first; a stable creature regains 1 HP after 1d4 hours.',
    );
    expect(ledger()).toEqual(before);
  });

  it('refuses a long rest broken off after an hour at 0 HP, and lets a rest that gives nothing pass the time', () => {
    fighter();
    downed();
    const before = ledger();
    expect(() => rest(db, { campaign_id: campaignId, kind: 'long', hours: 2 })).toThrow(
      /^Borg is at 0 HP, and a long rest needs at least 1 Hit Point to start\./,
    );
    expect(ledger()).toEqual(before);

    const broken = rest(db, { campaign_id: campaignId, kind: 'long', hours: 0.5 });
    expect(broken.message).toMatch(/gives nothing back/);
    expect(sheet().hp_current).toBe(0);
  });

  it('leaves a member at 0 HP out of a party short rest and rests the others', async () => {
    fighter();
    const rook = createCompanion(db, { campaign_id: campaignId, name: 'Rook', source: { creature: 'Wolf' } }).companion!.id;
    downed();
    const rested = await partyRest(db, { campaign_id: campaignId, kind: 'short' }, async (one) => rest(db, one));
    expect(rested.members[0]).toMatch(/^Borg: does not rest - at 0 HP/);
    expect(rested.members[1]).toMatch(/^Rook: \d+\/\d+ HP/);
    expect(sheet(rook).hp_current).toBeGreaterThan(0);
  });
});

describe('2. each Hit Point Die heals at least 1', () => {
  it('floors every die at 1 after a negative Constitution modifier, on one card the player rolls', async () => {
    // CON 8: a -1 modifier, so a face of 1 would heal 0 without the floor.
    make({ abilities: { str: 15, dex: 14, con: 8, int: 12, wis: 10, cha: 13 }, ability_bonuses: { str: 2, dex: 1 } });
    db.prepare('UPDATE character SET hit_dice_json = ?, hp_max = 30, hp_current = 3 WHERE campaign_id = ?').run(
      JSON.stringify({ die: 'd10', max: 3, used: 0 }),
      campaignId,
    );
    updateSettings(db, campaignId, { cheat_mode: true });

    const pending = restWithPlayerRolls(db, { campaign_id: campaignId, kind: 'short', hit_dice_to_spend: 3 });
    const cards = openPendingRolls(db, campaignId);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ expr: '3d10', purpose: 'Short rest hit dice' });
    resolvePendingRoll(db, cards[0]!.id, { dice: [1, 1, 6] });

    const rested = await pending;
    // 1 and 1 floor at 1 each, 6 - 1 is 5: 7, where the old whole-spend sum gave 8 - 3 = 5.
    expect(rested.healed).toBe(7);
    expect(rested.hp_current).toBe(10);
    expect(rested.roll).toMatch(/\[1, 1, 6\]/);
    expect(rested.hit_dice).toEqual({ die: 'd10', max: 3, used: 3 });
    const logged = db.prepare("SELECT text FROM event WHERE campaign_id = ? AND kind = 'rest'").all(campaignId) as Array<{ text: string }>;
    expect(logged.at(-1)!.text).toMatch(/spending 3 hit dice for 7 HP \(10\/30\)/);
  });

  it('adds a positive modifier to each die', async () => {
    fighter(); // CON 15: +2
    db.prepare('UPDATE character SET hit_dice_json = ?, hp_max = 30, hp_current = 3 WHERE campaign_id = ?').run(
      JSON.stringify({ die: 'd10', max: 2, used: 0 }),
      campaignId,
    );
    updateSettings(db, campaignId, { cheat_mode: true });
    const pending = restWithPlayerRolls(db, { campaign_id: campaignId, kind: 'short', hit_dice_to_spend: 2 });
    resolvePendingRoll(db, openPendingRolls(db, campaignId)[0]!.id, { dice: [1, 4] });
    expect((await pending).healed).toBe(9);
  });
});

describe("3. a long rest broken off after an hour gives a short rest's benefits", () => {
  it('gives back Pact Magic and spends the Hit Point Dice passed, but no long-rest benefit', () => {
    const id = warlock();
    useSpellSlot(db, { campaign_id: campaignId, level: 1 });
    // Room enough that one die can never heal them to full, as a finished long rest would.
    db.prepare('UPDATE character SET hp_max = 30, hp_current = 5 WHERE id = ?').run(id);
    setExhaustion(db, { campaign_id: campaignId, delta: 1 });
    const hurt = sheet().hp_current as number;
    const startHour = nowState(db, campaignId).hour;

    const broken = rest(db, { campaign_id: campaignId, kind: 'long', interrupted: true, hours: 2, hit_dice_to_spend: 1 });

    expect(broken).toMatchObject({ kind: 'long', interrupted: true, hours: 2, pact_magic_restored: true, hit_dice_spent: 1 });
    expect(broken.message).toBe(
      "Hex's long rest was interrupted after 2 hours; resting at least 1 hour first gives the benefits of a short rest, and the long rest is still owed. Narrate what broke it off.",
    );
    expect(sheet().spell_slots).toEqual({ '1': { max: 1, used: 0 } });
    expect(sheet().hp_current).toBeGreaterThan(hurt);
    expect(sheet().hp_current).toBeLessThan(sheet().hp_max as number);
    expect(sheet().exhaustion).toBe(1);
    expect(sheetExtras(db, campaignId, id).last_long_rest_at).toBeNull();
    expect(nowState(db, campaignId).hour).toBe((startHour + 2) % 24);
    const logged = db.prepare("SELECT text FROM event WHERE campaign_id = ? AND kind = 'rest'").all(campaignId) as Array<{ text: string }>;
    expect(logged.at(-1)!.text).toMatch(/^Hex's long rest breaks off after 2 hours and gives the benefits of a short rest, spending 1 hit dice/);
  });

  it('gives nothing when broken off under an hour, or when a short rest is broken off', () => {
    warlock();
    useSpellSlot(db, { campaign_id: campaignId, level: 1 });
    const brief = rest(db, { campaign_id: campaignId, kind: 'long', hours: 0.5, hit_dice_to_spend: 1 });
    expect(brief.message).toMatch(/gives nothing back/);
    const short = rest(db, { campaign_id: campaignId, kind: 'short', interrupted: true });
    expect(short.message).toMatch(/gives nothing back/);
    expect(sheet().spell_slots).toEqual({ '1': { max: 1, used: 1 } });
    expect((sheet().hit_dice as { used: number }).used).toBe(0);
  });

  it('takes the short-rest features a player opts into', () => {
    const zel = wizard();
    useSpellSlot(db, { campaign_id: campaignId, character_id: zel, level: 1 });
    const broken = rest(db, { campaign_id: campaignId, character_id: zel, kind: 'long', hours: 3, arcane_recovery: true });
    expect(broken.arcane_recovery).toBeDefined();
    expect(sheet(zel).spell_slots).toMatchObject({ '1': { used: 0 } });

    // The short-rest-only features are no longer refused as spent on a short rest; each judges its own owner.
    const borg = fighter();
    expect(() =>
      rest(db, { campaign_id: campaignId, character_id: borg, kind: 'long', hours: 3, sorcerous_restoration: true }),
    ).toThrow('Borg has no Sorcerous Restoration.');
    expect(() => rest(db, { campaign_id: campaignId, character_id: borg, kind: 'long', sorcerous_restoration: true })).toThrow(
      /spent on a short rest/,
    );
  });

  it("reads out a short rest's benefits for each member of a broken-off party long rest", async () => {
    warlock();
    createCompanion(db, { campaign_id: campaignId, name: 'Rook', source: { creature: 'Wolf' } });
    useSpellSlot(db, { campaign_id: campaignId, level: 1 });
    const rested = await partyRest(db, { campaign_id: campaignId, kind: 'long', hours: 2 }, async (one) => rest(db, one));
    expect(rested.members[0]).toMatch(/^Hex: interrupted, a short rest's benefits: .*pact slots back/);
    expect(rested.members[1]).toMatch(/^Rook: interrupted, a short rest's benefits: /);
    expect(sheet().spell_slots).toEqual({ '1': { max: 1, used: 0 } });

    const brief = await partyRest(db, { campaign_id: campaignId, kind: 'long', hours: 0.5 }, async (one) => rest(db, one));
    expect(brief.members).toEqual(['Hex: interrupted, nothing back.', 'Rook: interrupted, nothing back.']);
  });
});

describe('4. a short rest ends Concentration only when the spell runs out during it', () => {
  const cast = (spell: string, level: number) => useSpellSlot(db, { campaign_id: campaignId, level, spell });

  it('keeps an 8-hour spell cast just now, and ends a 1-hour one', () => {
    cleric();
    cast('Suggestion', 2);
    const kept = rest(db, { campaign_id: campaignId, kind: 'short' });
    expect(kept.concentration_ended).toBeUndefined();
    expect(concentrationOf(db, campaignId)?.spell).toBe('Suggestion');

    cast('Alter Self', 2);
    const ended = rest(db, { campaign_id: campaignId, kind: 'short' });
    expect(ended.concentration_ended).toBe('Alter Self ends: its duration ran out during the rest.');
    expect(concentrationOf(db, campaignId)).toBeNull();
  });

  it('ends an 8-hour spell whose recorded start puts its end inside the rest', () => {
    cleric();
    cast('Suggestion', 2);
    advanceTime(db, campaignId, { hours: 7, minutes: 30 });
    expect(rest(db, { campaign_id: campaignId, kind: 'short' }).concentration_ended).toMatch(/^Suggestion ends/);
    expect(concentrationOf(db, campaignId)).toBeNull();
  });

  it('judges a record with no start minute by its stated duration, and keeps one with none', () => {
    const id = cleric();
    const hold = (duration: string | null): void => {
      db.prepare('UPDATE character SET concentration_json = ? WHERE id = ?').run(
        JSON.stringify({ spell: 'Old Spell', slot_level: 2, started_at: '1 Deepfrost, year 1, 08:00', duration }),
        id,
      );
    };
    hold('8 hours');
    expect(rest(db, { campaign_id: campaignId, kind: 'short' }).concentration_ended).toBeUndefined();
    hold(null);
    expect(rest(db, { campaign_id: campaignId, kind: 'short' }).concentration_ended).toBeUndefined();
    hold('Concentration, up to 1 hour');
    expect(rest(db, { campaign_id: campaignId, kind: 'short' }).concentration_ended).toMatch(/^Old Spell ends/);
  });

  it('measures a broken-off long rest by the hours it ran, and a finished one still ends it', () => {
    cleric();
    cast('Suggestion', 2);
    expect(rest(db, { campaign_id: campaignId, kind: 'long', hours: 3 }).concentration_ended).toBeUndefined();
    cast('Alter Self', 2);
    expect(rest(db, { campaign_id: campaignId, kind: 'long', hours: 3 }).concentration_ended).toMatch(/^Alter Self ends/);

    cast('Suggestion', 2);
    expect(rest(db, { campaign_id: campaignId, kind: 'long' }).concentration_ended).toBe('Suggestion ends: they slept.');
  });
});

describe('5. one item per short rest for attuning or identifying', () => {
  beforeEach(() => {
    fighter();
    for (const name of ['Cloak of Elvenkind', 'Boots of Speed', 'Bracers of Defense']) addItem(db, { campaign_id: campaignId, name });
    addItem(db, { campaign_id: campaignId, name: '+1 Longsword', unidentified: true });
  });

  const refused = (input: Partial<RestInput>): void => {
    const before = ledger();
    expect(() => rest(db, { campaign_id: campaignId, kind: 'short', ...input })).toThrow(
      /^Attuning to a magic item and identifying one each take a short rest focused on only that item, and this rest names 2\. Call rest once for each of them\.$/,
    );
    expect(ledger()).toEqual(before);
  };

  it('refuses two attunements, an attunement with an identify, or two identifies, and costs nothing', () => {
    refused({ attune: ['Cloak of Elvenkind', 'Boots of Speed'] });
    refused({ attune: ['Cloak of Elvenkind'], identify: ['Unidentified longsword'] });
    refused({ identify: ['Unidentified longsword', 'Boots of Speed'], hit_dice_to_spend: 1 });
  });

  it('takes one item a rest, lets an unattune ride along, and still caps attunement at three', () => {
    expect(rest(db, { campaign_id: campaignId, kind: 'short', attune: ['Cloak of Elvenkind'] }).attuned).toEqual(['Cloak of Elvenkind']);
    expect(rest(db, { campaign_id: campaignId, kind: 'short', identify: ['Unidentified longsword'] }).identified).toEqual(['+1 Longsword']);
    rest(db, { campaign_id: campaignId, kind: 'short', attune: ['Boots of Speed'] });
    const swapped = rest(db, { campaign_id: campaignId, kind: 'short', unattune: ['Boots of Speed'], attune: ['Bracers of Defense'] });
    expect(swapped).toMatchObject({ unattuned: ['Boots of Speed'], attuned: ['Bracers of Defense'] });
    rest(db, { campaign_id: campaignId, kind: 'short', attune: ['Boots of Speed'] });
    addItem(db, { campaign_id: campaignId, name: 'Amulet of Health' });
    expect(() => rest(db, { campaign_id: campaignId, kind: 'short', attune: ['Amulet of Health'] })).toThrow(/already attuned to three/);
  });

  it('refuses attuning on a party rest, which rests everyone alike', async () => {
    await expect(
      partyRest(db, { campaign_id: campaignId, kind: 'short', attune: ['Cloak of Elvenkind'] }, async (one) => rest(db, one)),
    ).rejects.toThrow(/^attune is one character's choice/);
  });
});

describe('the rest tool text', () => {
  it('no longer says every rest ends Concentration or that three items attune at once', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'a2a1-rest', version: '0.0.0' });
    await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === 'rest')!;
      const fields = tool.inputSchema.properties as Record<string, { description?: string }>;
      expect(tool.description).not.toContain('Any rest ends Concentration');
      expect(tool.description).toContain("Concentration ends only if the spell's duration runs out in it");
      expect(tool.description).toContain("a long rest broken off after 1 hour or more gives a short rest's benefits");
      expect(tool.description).toContain('Either rest needs at least 1 HP to start');
      expect(fields.attune!.description).not.toContain('three at a time');
      expect(fields.attune!.description).toContain('one item attuned or identified per rest');
    } finally {
      await client.close();
    }
  });
});
