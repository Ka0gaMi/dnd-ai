// Audit P5a: how a d20 is built outside combat - Advantage and Disadvantage that cancel rather than
// stack, Heroic Inspiration's single-die reroll, and the two class features that ride on the roll.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import {
  addItem,
  awardXp,
  checkModifier,
  createCharacter,
  equipItem,
  grantFeature,
  grantInspirationDie,
  heldInspirationDie,
  levelUp,
  levelUpOptions,
  type CreateCharacterInput,
  type LevelUpChoices,
} from '../src/core/character.js';
import type { RollDetail } from '../src/core/dice.js';
import { clausesSchema, type ClauseInput } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import { createPendingRoll, inspirePendingRoll, netAdvantage } from '../src/core/rolls.js';
import { XP_THRESHOLDS } from '../src/core/rules.js';
import { classLevelRow, findClass, spellsForClass } from '../src/srd/lookup.js';
import { createGameServer } from '../src/mcp/server.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'P5a', story_shape: 'sandbox' }).campaign_id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function connect(): Promise<{ client: Client; done: () => void }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return { client, done: () => void client.close() };
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

interface RollReply extends Record<string, unknown> {
  advantage: string;
  expr: string;
  rules_applied?: string[];
  feature_die?: { spent: boolean; note: string };
}

function makeFighter(): number {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  } as CreateCharacterInput).character!.id;
}

/** Chain Mail is loud: the armour table sets Disadvantage on Stealth. */
function wearChainMail(characterId: number): void {
  addItem(db, { campaign_id: campaignId, character_id: characterId, name: 'Chain Mail', qty: 1 });
  equipItem(db, { campaign_id: campaignId, character_id: characterId, name: 'Chain Mail', equipped: true });
}

function grant(characterId: number, name: string, clauses: ClauseInput[]): void {
  const entry = saveHomebrew(db, {
    campaign_id: campaignId,
    kind: 'feature',
    name,
    schema: { name, text: name, clauses: clausesSchema.parse(clauses) },
  });
  grantFeature(db, {
    campaign_id: campaignId,
    character_id: characterId,
    name,
    text: name,
    source: 'homebrew',
    mechanics: { homebrew_id: entry.id },
  });
}

interface LevelOptions {
  subclass_choice?: unknown;
  ability_score_improvement?: unknown;
  feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
  spellcasting?: {
    cantrips_to_add: number;
    spells_to_add: number;
    cantrip_options: string[];
    spell_options: Record<string, string[]>;
  };
}

/** Levels a character to the target level, taking the first option each level offers. */
function climbTo(characterId: number, level: number, subclass: string): void {
  const owed = XP_THRESHOLDS[level - 1]! - getCharacterSheet(db, campaignId, characterId)!.xp;
  if (owed > 0) awardXp(db, { campaign_id: campaignId, character_id: characterId, amount: owed });
  while ((getCharacterSheet(db, campaignId, characterId)!.level as number) < level) {
    const options = levelUpOptions(db, campaignId, characterId) as LevelOptions;
    const sheet = getCharacterSheet(db, campaignId, characterId)!;
    const choices: LevelUpChoices = { hp: 'average' };
    if (options.subclass_choice) choices.subclass = subclass;
    if (options.ability_score_improvement) choices.ability_increases = { con: 1, wis: 1 };
    if (options.feature_choices) {
      choices.feature_options = Object.fromEntries(
        options.feature_choices.map((spec) => [spec.feature, spec.from.slice(0, spec.choose)]),
      );
    }
    if (options.spellcasting) {
      const spells = sheet.spells as { cantrips: string[]; known: string[] };
      choices.cantrips = options.spellcasting.cantrip_options
        .filter((name) => !spells.cantrips.includes(name))
        .slice(0, options.spellcasting.cantrips_to_add);
      choices.spells = Object.values(options.spellcasting.spell_options)
        .flat()
        .filter((name) => !spells.known.includes(name))
        .slice(0, options.spellcasting.spells_to_add);
    }
    levelUp(db, { campaign_id: campaignId, character_id: characterId, choices });
  }
}

/** A Fiend Patron Warlock at 6, who has Dark One's Own Luck. */
function makeWarlock(): number {
  const data = findClass('warlock');
  const casting = classLevelRow(data.index, 1).spellcasting;
  const id = createCharacter(db, {
    campaign_id: campaignId,
    name: 'Hex',
    species: 'Human',
    class: 'warlock',
    background: 'Acolyte',
    ability_method: 'manual',
    abilities: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 16 },
    ability_bonuses: { cha: 2, wis: 1 },
    skill_choices: ['arcana', 'deception', 'perception'],
    cantrips: spellsForClass(data.index, 0).slice(0, casting?.cantrips_known ?? 0),
    spells: spellsForClass(data.index, 1).slice(0, casting?.prepared_spells ?? 0),
  } as CreateCharacterInput).character!.id;
  climbTo(id, 6, 'Fiend Patron');
  return id;
}

describe('advantage and disadvantage never stack', () => {
  it('cancels two Advantages and one Disadvantage to a flat d20', async () => {
    const id = makeFighter();
    wearChainMail(id);
    grant(id, 'Catlike', [{ when: 'roll', if: { kind: 'check', skill: ['stealth'] }, do: [{ kind: 'advantage' }] }]);
    const { client, done } = await connect();
    try {
      // The DM's own Advantage, the homebrew clause's, and the armour's Disadvantage: one of each cancels.
      const result = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        character_id: id,
        purpose: 'Stealth check',
        skill: 'stealth',
        advantage: 'advantage',
        roller: 'dm',
      });
      expect(result.advantage).toBe('none');
      expect(result.expr).toMatch(/^1d20[+-]/);
      expect(result.rules_applied?.join(' ')).toMatch(/loud/);
    } finally {
      done();
    }
  });

  it('does not let a later Advantage overwrite the armour Disadvantage', async () => {
    const id = makeFighter();
    wearChainMail(id);
    grant(id, 'Catlike', [
      {
        when: 'roll',
        if: { kind: 'check', skill: ['stealth'] },
        do: [{ kind: 'advantage' }],
        uses: { per: 'long', count: 1 },
        decide: 'ask_before',
      },
    ]);
    const key = checkModifier(db, campaignId, id, { skill: 'stealth' }).boosts_available![0]!.id;
    const { client, done } = await connect();
    try {
      const result = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        character_id: id,
        purpose: 'Stealth check',
        skill: 'stealth',
        boosts: [key],
        roller: 'dm',
      });
      expect(result.advantage).toBe('none');
      expect(result.expr).toMatch(/^1d20[+-]/);
    } finally {
      done();
    }
  });

  it('nets the sources the way the rules read', () => {
    expect(netAdvantage(['advantage', 'advantage', 'disadvantage'])).toBe('none');
    expect(netAdvantage(['disadvantage', 'advantage', 'advantage'])).toBe('none');
    expect(netAdvantage(['advantage', 'advantage'])).toBe('advantage');
    expect(netAdvantage(['disadvantage', 'disadvantage'])).toBe('disadvantage');
    expect(netAdvantage(['none'])).toBe('none');
  });
});

describe('Heroic Inspiration rerolls one die', () => {
  it('rerolls the d20 that counted and keeps the other rather than rebuilding the pair', () => {
    const id = makeFighter();
    db.prepare('UPDATE character SET inspiration = 1 WHERE id = ?').run(id);
    const pending = createPendingRoll(db, {
      campaign_id: campaignId,
      character_id: id,
      expr: '1d20+5',
      purpose: 'Stealth check',
      roll_type: 'check',
      advantage: 'advantage',
    });
    // The preview the player saw: a 10 and a 20, Advantage keeping the 20.
    const preview: RollDetail = {
      expr: '2d20kh1+5',
      requested_expr: '1d20+5',
      advantage: 'advantage',
      total: 25,
      output: '2d20kh1+5: [20, 10d]+5 = 25',
      groups: [{ value: 20, dice: [{ value: 20, modifiers: [] }, { value: 10, modifiers: ['d'] }] }],
      natural_d20: 20,
      natural: 20,
      roll_type: 'check',
      dc: null,
      outcome: null,
    };
    db.prepare('UPDATE pending_roll SET preview_json = ? WHERE id = ?').run(JSON.stringify(preview), pending.id);

    // The reroll comes up a 1: the 10 still stands, and Advantage keeps it.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const roll = inspirePendingRoll(db, pending.id);

    expect(roll.inspired).toEqual({ from: 25, to: 15 });
    expect(roll.natural_d20).toBe(10);
    expect(roll.total).toBe(15);
  });
});

describe('a class feature die on the roll', () => {
  it('spends a Bardic Inspiration die even when it does not turn the failure', async () => {
    const id = makeFighter();
    grantInspirationDie(db, { campaign_id: campaignId, character_id: id, die: 6, from: 'Lyric' });
    const { client, done } = await connect();
    try {
      const hard = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        character_id: id,
        skill: 'arcana',
        dc: 40,
        purpose: 'Arcana check',
        bardic_inspiration: true,
      });
      expect(hard.feature_die?.spent).toBe(true);
      expect(hard.feature_die?.note).toMatch(/spent/);
      expect(heldInspirationDie(db, campaignId, id)).toBeNull();
    } finally {
      done();
    }
  });

  it("refuses Dark One's Own Luck on an attack or damage roll", async () => {
    const id = makeWarlock();
    const { client, done } = await connect();
    try {
      await expect(
        call(client, 'roll', {
          campaign_id: campaignId,
          character_id: id,
          expr: '1d20+5',
          roll_type: 'attack',
          dc: 14,
          purpose: 'Longsword attack',
          dark_ones_luck: true,
        }),
      ).rejects.toThrow(/ability check or a saving throw/);
      await expect(
        call(client, 'roll', {
          campaign_id: campaignId,
          character_id: id,
          expr: '2d6+3',
          roll_type: 'damage',
          purpose: 'Longsword damage',
          dark_ones_luck: true,
        }),
      ).rejects.toThrow(/ability check or a saving throw/);
    } finally {
      done();
    }
  });

  it("still offers Dark One's Own Luck on a check or a save", async () => {
    const id = makeWarlock();
    const { client, done } = await connect();
    try {
      const saved = await call<RollReply>(client, 'roll', {
        campaign_id: campaignId,
        character_id: id,
        save: 'wis',
        dc: 30,
        purpose: 'Wisdom save',
        dark_ones_luck: true,
      });
      expect(saved.rules_applied?.join(' ')).toMatch(/Dark One's Own Luck/);
    } finally {
      done();
    }
  });
});
