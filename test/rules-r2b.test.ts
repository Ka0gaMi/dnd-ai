// The last of the character and roll rules: checks and saves composed from the sheet, passive checks,
// contests, group checks, the armour table's weight rules, the rest clock and concentration at the table.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { combatSheet } from '../src/combat/sheet.js';
import { advanceTime, nowState } from '../src/core/calendar.js';
import { bus, type GameEvent } from '../src/core/bus.js';
import { campaignSnapshot, createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import {
  addItem,
  applyDamage,
  concentrationOf,
  createCharacter,
  createCompanion,
  equipItem,
  rest,
  setExhaustion,
  sheetExtras,
  useSpellSlot,
  type CreateCharacterInput,
} from '../src/core/character.js';
import { openPendingRolls } from '../src/core/rolls.js';
import { updateSettings } from '../src/core/settings.js';
import { createGameServer } from '../src/mcp/server.js';
import { openDb, type Db } from '../src/db/connection.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'R2b', story_shape: 'sandbox' }).campaign_id;
});

afterEach(() => {
  Math.random = realRandom;
});

/** Every die comes up the same, so two sides of a contest can be made to tie on purpose. */
function fixRolls(value: number): void {
  Math.random = () => value;
}

async function connect(): Promise<{ client: Client; done: () => void }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  const unsubscribe = resolvePendingRollsImmediately(db);
  return {
    client,
    done: () => {
      unsubscribe();
      void client.close();
    },
  };
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as {
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent: T;
  };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
}

function make(overrides: Partial<CreateCharacterInput> & { class: string; species: string; background: string }) {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Test',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
    ability_bonuses: { str: 2, con: 1 },
    ...overrides,
  } as CreateCharacterInput);
}

const fighter = (overrides: Partial<CreateCharacterInput> = {}) =>
  make({
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    name: 'Borg',
    skill_choices: ['athletics', 'perception'],
    ...overrides,
  });

const cleric = () =>
  make({
    species: 'Human',
    class: 'Cleric',
    background: 'Acolyte',
    name: 'Sella',
    abilities: { str: 13, dex: 10, con: 14, int: 8, wis: 15, cha: 12 },
    ability_bonuses: { wis: 2, cha: 1 },
    skill_choices: ['insight', 'religion', 'medicine'],
    cantrips: ['Guidance', 'Sacred Flame', 'Thaumaturgy'],
    spells: ['Bless', 'Cure Wounds', 'Guiding Bolt', 'Healing Word'],
  });

const rogue = () =>
  make({
    species: 'Human',
    class: 'Rogue',
    background: 'Criminal',
    name: 'Sly',
    abilities: { str: 8, dex: 15, con: 13, int: 14, wis: 12, cha: 10 },
    ability_bonuses: { dex: 2, int: 1 },
    skill_choices: ['stealth', 'acrobatics', 'perception', 'sleight_of_hand', 'investigation'],
    feature_options: { Expertise: ['stealth', 'perception'] },
  });

interface RollReply extends Record<string, unknown> {
  total: number;
  expr: string;
  outcome: string | null;
  roll_type: string;
  modifier_from_sheet?: string;
  expr_modifier_ignored?: string;
  modifier?: {
    ability: string;
    skill: string | null;
    ability_mod: number;
    proficiency: number;
    expertise: boolean;
    exhaustion: number;
    total_modifier: number;
  };
}

describe('checks and saves composed from the sheet', () => {
  it('reads the modifier off the sheet and returns the breakdown', async () => {
    fighter();
    const { client, done } = await connect();
    try {
      const result = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Athletics check',
        skill: 'athletics',
        dc: 10,
        roller: 'player',
      });
      // STR 17 (+3) and proficient in Athletics at level 1 (+2).
      expect(result.modifier).toMatchObject({
        ability: 'str',
        skill: 'athletics',
        ability_mod: 3,
        proficiency: 2,
        expertise: false,
        exhaustion: 0,
        total_modifier: 5,
      });
      expect(result.modifier_from_sheet).toBe('+5');
      expect(result.expr).toMatch(/1d20\+5/);
      expect(result.roll_type).toBe('check');
    } finally {
      done();
    }
  });

  it('ignores a modifier the DM left in expr and says so', async () => {
    fighter();
    const { client, done } = await connect();
    try {
      const result = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Athletics check',
        skill: 'athletics',
        expr: '1d20+3',
        roller: 'player',
      });
      expect(result.modifier_from_sheet).toBe('+5');
      expect(result.expr_modifier_ignored).toBe('+3');
    } finally {
      done();
    }
  });

  it('doubles the proficiency bonus for Expertise and subtracts exhaustion', async () => {
    rogue();
    setExhaustion(db, { campaign_id: campaignId, level: 1 });
    const { client, done } = await connect();
    try {
      const result = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Stealth check',
        skill: 'stealth',
        roller: 'player',
      });
      // DEX 17 (+3), Expertise (+4), exhaustion 1 (-2).
      expect(result.modifier).toMatchObject({ ability_mod: 3, proficiency: 4, expertise: true, exhaustion: 2 });
      expect(result.modifier!.total_modifier).toBe(5);
    } finally {
      done();
    }
  });

  it('infers a saving throw and adds the save proficiency', async () => {
    fighter();
    const { client, done } = await connect();
    try {
      const result = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Constitution save against the fumes',
        save: 'con',
        dc: 12,
        roller: 'player',
      });
      expect(result.roll_type).toBe('save');
      // CON 14 (+2) and a Fighter is proficient in CON saves (+2).
      expect(result.modifier).toMatchObject({ ability: 'con', skill: null, ability_mod: 2, proficiency: 2 });
    } finally {
      done();
    }
  });

  it('rolls a raw ability check with no proficiency at all', async () => {
    fighter();
    const { client, done } = await connect();
    try {
      const result = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Raw Strength to shift the portcullis',
        ability: 'str',
        roller: 'player',
      });
      expect(result.modifier).toMatchObject({ ability: 'str', skill: null, proficiency: 0, total_modifier: 3 });
    } finally {
      done();
    }
  });

  it('names the skills it knows when the DM invents one', async () => {
    fighter();
    const { client, done } = await connect();
    try {
      await expect(
        call(client, 'roll', { campaign_id: campaignId, purpose: 'Haggling', skill: 'haggling', roller: 'player' }),
      ).rejects.toThrow(/is not a skill/);
    } finally {
      done();
    }
  });
});

describe('passive checks', () => {
  it('is 10 plus the modifier, with 5 either way for advantage, and rolls no dice', async () => {
    fighter();
    const { client, done } = await connect();
    try {
      const flat = await call<{ total: number; passive: boolean; outcome: string | null }>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Perception check',
        skill: 'perception',
        passive: true,
        dc: 13,
      });
      // WIS 10 (+0) and proficient (+2): 10 + 2.
      expect(flat).toMatchObject({ passive: true, total: 12, outcome: 'failure' });

      const keen = await call<{ total: number }>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Perception check',
        skill: 'perception',
        passive: true,
        advantage: 'advantage',
      });
      expect(keen.total).toBe(17);
      const dulled = await call<{ total: number }>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Perception check',
        skill: 'perception',
        passive: true,
        advantage: 'disadvantage',
      });
      expect(dulled.total).toBe(7);

      expect(openPendingRolls(db, campaignId)).toHaveLength(0);
      const rows = db.prepare('SELECT purpose FROM roll WHERE campaign_id = ?').all(campaignId);
      expect(rows).toHaveLength(0);
    } finally {
      done();
    }
  });

  it('logs it for the DM alone: no roll row, no bus event and nothing in the recent events', async () => {
    fighter();
    const seen: GameEvent[] = [];
    const unsubscribe = bus.subscribe((event) => seen.push(event));
    const { client, done } = await connect();
    try {
      await call(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Perception check',
        skill: 'perception',
        passive: true,
        dc: 13,
      });
    } finally {
      done();
      unsubscribe();
    }

    const logged = db
      .prepare("SELECT text, payload_json FROM event WHERE campaign_id = ? AND kind = 'passive_check'")
      .all(campaignId) as Array<{ text: string; payload_json: string }>;
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!.payload_json)).toMatchObject({
      character: 'Borg',
      skill: 'perception',
      total: 12,
      dc: 13,
      outcome: 'failure',
    });
    // The DC and the outcome stay out of the text, which is the line a log reader sees.
    expect(logged[0]!.text).not.toMatch(/13|failure/);

    expect(seen.some((event) => event.kind === 'passive_check')).toBe(false);
    expect(campaignSnapshot(db, campaignId).recent_events.some((event) => event.kind === 'passive_check')).toBe(false);
  });
});

describe('contests', () => {
  it('rolls both sides and leaves a tie as it was', async () => {
    fighter();
    fixRolls(0.5);
    const { client, done } = await connect();
    try {
      const result = await call<{
        contest: {
          character: { name: string; total: number };
          opponent: { name: string; bonus: number; total: number; from: string };
          winner: string;
          tie?: string;
        };
      }>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Shoving the door shut',
        skill: 'athletics',
        contest: { opponent: { bonus: 5, name: 'the ghoul' } },
      });
      expect(result.contest.character.total).toBe(result.contest.opponent.total);
      expect(result.contest.winner).toBe('tie');
      expect(result.contest.tie).toMatch(/stays as it was/);
      expect(result.contest.opponent).toMatchObject({ name: 'the ghoul', bonus: 5, from: 'the bonus you passed' });
    } finally {
      done();
    }
  });

  it('reads the other side off an SRD stat block', async () => {
    fighter();
    const { client, done } = await connect();
    try {
      const result = await call<{ contest: { opponent: { name: string; bonus: number; from: string }; winner: string } }>(
        client,
        'roll',
        {
          campaign_id: campaignId,
          purpose: 'Hiding from the aboleth',
          skill: 'stealth',
          contest: { opponent: { creature: 'Aboleth', skill: 'perception' } },
        },
      );
      expect(result.contest.opponent).toMatchObject({ name: 'Aboleth', bonus: 10, from: 'its stat block' });
      expect(['character', 'opponent', 'tie']).toContain(result.contest.winner);
    } finally {
      done();
    }
  });

  it('refuses a contest with no opponent at all', async () => {
    fighter();
    const { client, done } = await connect();
    try {
      await expect(
        call(client, 'roll', {
          campaign_id: campaignId,
          purpose: 'Arm wrestling',
          skill: 'athletics',
          contest: { opponent: {} },
        }),
      ).rejects.toThrow(/opponent.character_id, opponent.creature or opponent.bonus/);
    } finally {
      done();
    }
  });
});

describe('group checks', () => {
  it('succeeds when at least half the group beats the DC', async () => {
    const pc = fighter().character!.id;
    const second = cleric().character!.id;
    fixRolls(0.95); // every d20 comes up 20
    const { client, done } = await connect();
    try {
      const result = await call<{
        group_check: { members: Array<{ name: string; outcome: string }>; successes: number; needed: number; succeeded: boolean };
      }>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Wading the river',
        skill: 'athletics',
        dc: 10,
        group: [pc, second],
      });
      expect(result.group_check.members).toHaveLength(2);
      expect(result.group_check.needed).toBe(1);
      expect(result.group_check.successes).toBe(2);
      expect(result.group_check.succeeded).toBe(true);
    } finally {
      done();
    }
  });

  it('fails the group when fewer than half succeed', async () => {
    const pc = fighter().character!.id;
    const second = cleric().character!.id;
    fixRolls(0.05); // every d20 comes up low
    const { client, done } = await connect();
    try {
      const result = await call<{ group_check: { successes: number; succeeded: boolean } }>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Wading the river',
        skill: 'athletics',
        dc: 25,
        group: [pc, second],
      });
      expect(result.group_check.successes).toBe(0);
      expect(result.group_check.succeeded).toBe(false);
    } finally {
      done();
    }
  });
});

describe('the luck dial and the click card belong to the player character', () => {
  const companion = (name: string): number =>
    createCompanion(db, {
      campaign_id: campaignId,
      name,
      source: { class: 'Fighter', species: 'Human', background: 'Soldier' },
    }).companion!.id;

  it("gives a companion's roll no luck and no card, even when the DM sends it through the player flow", async () => {
    fighter();
    const friend = companion('Kess');
    updateSettings(db, campaignId, { luck_bias: 2 });
    const { client, done } = await connect();
    try {
      await call(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Athletics check',
        skill: 'athletics',
        character_id: friend,
        roller: 'player',
        dc: 10,
      });
    } finally {
      done();
    }

    const rows = db
      .prepare('SELECT luck_bias_applied FROM roll WHERE campaign_id = ?')
      .all(campaignId) as Array<{ luck_bias_applied: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.luck_bias_applied).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pending_roll WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 0 });
  });

  it('asks the player for one die in a group check and rolls the companions server-side', async () => {
    const pc = fighter().character!.id;
    const first = companion('Kess');
    const second = companion('Rill');
    updateSettings(db, campaignId, { luck_bias: 2 });
    const { client, done } = await connect();
    try {
      const result = await call<{
        group_check: { members: Array<{ name: string }>; successes: number; needed: number; succeeded: boolean };
      }>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Wading the river',
        skill: 'athletics',
        dc: 10,
        group: [pc, first, second],
      });
      expect(result.group_check.members).toHaveLength(3);
      // Half of three, rounded up: two of them have to make it.
      expect(result.group_check.needed).toBe(2);
      expect(result.group_check.succeeded).toBe(result.group_check.successes >= 2);
    } finally {
      done();
    }

    expect(db.prepare('SELECT COUNT(*) AS n FROM pending_roll WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 1 });
    const lucky = db
      .prepare('SELECT COUNT(*) AS n FROM roll WHERE campaign_id = ? AND luck_bias_applied != 0')
      .get(campaignId) as { n: number };
    expect(lucky.n).toBe(1);
  });
});

describe('the armour table weight rules', () => {
  it('takes 10 ft off a wearer too weak for the armour and shows why', () => {
    const id = cleric().character!.id; // STR 13 is not enough for Chain Mail's 13? it is; weaken them below it
    db.prepare("UPDATE character SET abilities_json = json_set(abilities_json, '$.str.score', 10, '$.str.mod', 0) WHERE id = ?").run(id);
    addItem(db, { campaign_id: campaignId, name: 'Chain Mail', qty: 1 });
    equipItem(db, { campaign_id: campaignId, name: 'Chain Mail', equipped: true });

    const extras = sheetExtras(db, campaignId, id);
    expect(extras.speed).toBe(20);
    expect(extras.speed_reason).toMatch(/Chain Mail needs Strength 13/);
    expect(extras.stealth_disadvantage).toBe(true);
    expect(combatSheet(db, id).speed).toBe(20);
    expect(combatSheet(db, id).stealth_disadvantage).toBe(true);
  });

  it("shows the player's window the same sheet the DM's tools see", () => {
    const id = cleric().character!.id;
    db.prepare("UPDATE character SET abilities_json = json_set(abilities_json, '$.str.score', 10, '$.str.mod', 0) WHERE id = ?").run(id);
    addItem(db, { campaign_id: campaignId, name: 'Chain Mail', qty: 1 });
    equipItem(db, { campaign_id: campaignId, name: 'Chain Mail', equipped: true });

    const snapshot = campaignSnapshot(db, campaignId, { forPlayer: true });
    expect(snapshot.pc).toMatchObject({ speed: 20, stealth_disadvantage: true, concentrating_on: null, last_long_rest_at: null });
    expect(snapshot.pc!.speed_reason).toMatch(/Chain Mail needs Strength 13/);
  });

  it('gives Disadvantage on a Stealth check composed from the sheet', async () => {
    fighter();
    addItem(db, { campaign_id: campaignId, name: 'Chain Mail', qty: 1 });
    equipItem(db, { campaign_id: campaignId, name: 'Chain Mail', equipped: true });
    const { client, done } = await connect();
    try {
      const result = await call<RollReply & { advantage: string; rules_applied?: string[] }>(client, 'roll', {
        campaign_id: campaignId,
        purpose: 'Stealth check',
        skill: 'stealth',
        roller: 'player',
      });
      expect(result.advantage).toBe('disadvantage');
      expect(result.rules_applied?.join(' ')).toMatch(/loud/);
    } finally {
      done();
    }
  });
});

describe('rests', () => {
  it('takes 8 hours, stamps the sheet and refuses a second long rest inside 24 in-game hours', () => {
    fighter();
    const before = nowState(db, campaignId).hour;
    const first = rest(db, { campaign_id: campaignId, kind: 'long' });
    expect(nowState(db, campaignId).hour).toBe((before + 8) % 24);
    expect(first.last_long_rest_at).toMatch(/Deepfrost/);
    expect(sheetExtras(db, campaignId).last_long_rest_at).toBe(first.last_long_rest_at);

    advanceTime(db, campaignId, { hours: 10 });
    expect(() => rest(db, { campaign_id: campaignId, kind: 'long' })).toThrow(
      /one long rest per 24 hours; the last ended at/,
    );
    // A short rest is always available.
    expect(rest(db, { campaign_id: campaignId, kind: 'short' })).toMatchObject({ kind: 'short' });

    advanceTime(db, campaignId, { hours: 24 });
    expect(rest(db, { campaign_id: campaignId, kind: 'long' })).toMatchObject({ kind: 'long' });
  });

  it('gives nothing back when the rest is interrupted, and leaves no stamp', () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 5 });
    const hurt = getCharacterSheet(db, campaignId)!.hp_current;

    const broken = rest(db, { campaign_id: campaignId, kind: 'long', interrupted: true, hours: 3 });
    expect(broken.interrupted).toBe(true);
    expect(broken.message).toMatch(/gives nothing back/);
    expect(getCharacterSheet(db, campaignId)!.hp_current).toBe(hurt);
    expect(sheetExtras(db, campaignId).last_long_rest_at).toBeNull();
    // The hours it did take are gone from the clock.
    expect(nowState(db, campaignId).hour).toBe(11);

    // Under 8 hours counts as interrupted without saying so.
    expect(rest(db, { campaign_id: campaignId, kind: 'long', hours: 6 })).toMatchObject({ interrupted: true });
    // And the long rest is still theirs to take.
    expect(rest(db, { campaign_id: campaignId, kind: 'long' })).toMatchObject({ kind: 'long' });
  });

  it('lets an interrupted long rest through inside 24 hours, and takes force only in freeform', () => {
    fighter();
    rest(db, { campaign_id: campaignId, kind: 'long' });
    advanceTime(db, campaignId, { hours: 2 });

    // A broken-off rest gives nothing back, so the one-a-day rule has nothing to refuse.
    expect(rest(db, { campaign_id: campaignId, kind: 'long', interrupted: true, hours: 2 })).toMatchObject({
      interrupted: true,
    });

    // The default flexible mode holds the line and refuses force outright.
    expect(() => rest(db, { campaign_id: campaignId, kind: 'long' })).toThrow(
      /one long rest per 24 hours; the last ended at/,
    );
    expect(() => rest(db, { campaign_id: campaignId, kind: 'long', force: true })).toThrow(
      'force bypasses the long-rest rule only in freeform rules_mode; core rules apply here.',
    );

    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    expect(() => rest(db, { campaign_id: campaignId, kind: 'long' })).toThrow(
      /In freeform mode pass force: true to allow it as your ruling\./,
    );
    expect(rest(db, { campaign_id: campaignId, kind: 'long', force: true })).toMatchObject({
      kind: 'long',
      rules_note: 'freeform: a second long rest inside 24 hours, allowed by the DM',
    });
  });

  it('carries rules_note only when force actually bypassed the 24-hour rule', () => {
    fighter();
    updateSettings(db, campaignId, { rules_mode: 'freeform' });

    // Nothing to bypass yet, so force is accepted but the note would be a lie.
    const first = rest(db, { campaign_id: campaignId, kind: 'long', force: true });
    expect(first).not.toHaveProperty('rules_note');

    advanceTime(db, campaignId, { hours: 2 });
    // Now force actually stands in for the refused 24-hour rule.
    expect(rest(db, { campaign_id: campaignId, kind: 'long', force: true })).toMatchObject({
      kind: 'long',
      rules_note: 'freeform: a second long rest inside 24 hours, allowed by the DM',
    });
  });

  it('leaves the clock where it is when advance_time is false', () => {
    fighter();
    const before = nowState(db, campaignId).date_text;
    rest(db, { campaign_id: campaignId, kind: 'short', advance_time: false });
    expect(nowState(db, campaignId).date_text).toBe(before);
  });
});

describe('concentration outside a fight', () => {
  it('records it from use_spell_slot and ends the first spell when a second one starts', () => {
    const id = cleric().character!.id;
    db.prepare('UPDATE character SET spell_slots_json = ? WHERE id = ?').run('{"1":{"max":5,"used":0}}', id);
    const first = useSpellSlot(db, { campaign_id: campaignId, level: 1, spell: 'Bless' }) as {
      concentrating_on?: { spell: string; slot_level: number; duration: string | null };
    };
    expect(first.concentrating_on).toMatchObject({ spell: 'Bless', slot_level: 1, duration: '1 minute' });
    expect(concentrationOf(db, campaignId)?.spell).toBe('Bless');
    expect(sheetExtras(db, campaignId).concentrating_on?.spell).toBe('Bless');

    const second = useSpellSlot(db, { campaign_id: campaignId, level: 1, spell: 'Hold Person' }) as {
      concentration_ended?: string;
    };
    expect(second.concentration_ended).toMatch(/Bless ends/);
    expect(concentrationOf(db, campaignId)?.spell).toBe('Hold Person');

    // A spell that needs no concentration leaves what they hold alone.
    const spared = useSpellSlot(db, { campaign_id: campaignId, level: 1, spell: 'Cure Wounds' });
    expect(spared).not.toHaveProperty('concentration_ended');
    expect(concentrationOf(db, campaignId)?.spell).toBe('Hold Person');
  });

  it('rolls the Constitution save at DC 10 or half the damage and ends it on a failure', async () => {
    const id = cleric().character!.id;
    // Tough enough to stay up under the hit, so the save is the thing being tested.
    db.prepare('UPDATE character SET hp_max = 60, hp_current = 60 WHERE id = ?').run(id);
    useSpellSlot(db, { campaign_id: campaignId, level: 1, spell: 'Bless' });
    fixRolls(0.05); // every d20 comes up low, so the save fails
    const { client, done } = await connect();
    try {
      const result = await call<{ concentration_save?: { dc: number; outcome: string; concentration: string } }>(
        client,
        'apply_damage',
        { campaign_id: campaignId, amount: 30, type: 'necrotic' },
      );
      expect(result.concentration_save).toMatchObject({ dc: 15, outcome: 'failure', concentration: 'ended' });
      expect(concentrationOf(db, campaignId)).toBeNull();
    } finally {
      done();
    }
  });

  it('ends when they drop to 0 hit points and when they rest', () => {
    cleric();
    useSpellSlot(db, { campaign_id: campaignId, level: 1, spell: 'Bless' });
    const down = applyDamage(db, { campaign_id: campaignId, amount: 100 }) as unknown as {
      concentration_ended?: string;
    };
    expect(down.concentration_ended).toMatch(/Bless ends/);
    expect(concentrationOf(db, campaignId)).toBeNull();

    const back = cleric().character!.id;
    useSpellSlot(db, { campaign_id: campaignId, character_id: back, level: 1, spell: 'Bless' });
    const rested = rest(db, { campaign_id: campaignId, character_id: back, kind: 'short' });
    expect(rested.concentration_ended).toMatch(/Bless ends/);
    expect(concentrationOf(db, campaignId, back)).toBeNull();
  });
});
