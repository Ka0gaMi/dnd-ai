// Recovering outside a fight: the stabilise reply carries the engine's own 1d4 wake-up hours, and Second
// Wind or Wholeness of Body taken through use_action with no encounter heals off the character sheet.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import {
  applyDamage,
  awardXp,
  createCharacter,
  deathSave,
  levelUp,
  levelUpOptions,
  setCondition,
  type CreateCharacterInput,
  type LevelUpChoices,
} from '../src/core/character.js';
import { XP_THRESHOLDS, type Ability } from '../src/core/rules.js';
import { findClass, findSpecies, skillChoiceGroups } from '../src/srd/lookup.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { replyData } from './helpers/reply.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Recovery', story_shape: 'sandbox' }).campaign_id;
});

afterEach(() => {
  Math.random = realRandom;
});

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return replyData<T>(result);
}

/** The first legal pick of every skill group this class and species ask for, without repeats. */
function skillPicks(cls: string): string[] {
  const picks: string[] = [];
  for (const group of skillChoiceGroups(findClass(cls), findSpecies('Human'))) {
    picks.push(...group.from.filter((option) => !picks.includes(option)).slice(0, group.choose));
  }
  return picks;
}

function make(cls: string, abilities: Record<Ability, number>): number {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: cls === 'fighter' ? 'Bram' : 'Sora',
    species: 'Human',
    class: cls,
    background: 'Soldier',
    ability_method: 'manual',
    abilities,
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: skillPicks(cls),
  } as CreateCharacterInput).character!.id;
}

const sheet = (id?: number): CharacterSummary => getCharacterSheet(db, campaignId, id)!;

/** Levels a martial character to the target level, taking the subclass and spreading each ASI. */
function climbTo(id: number, level: number, subclass: string): void {
  awardXp(db, { campaign_id: campaignId, character_id: id, amount: XP_THRESHOLDS[level - 1]! });
  while (sheet(id).level < level) {
    const options = levelUpOptions(db, campaignId, id) as {
      subclass_choice?: unknown;
      ability_score_improvement?: unknown;
      feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
    };
    const choices: LevelUpChoices = { hp: 'average' };
    if (options.subclass_choice) choices.subclass = subclass;
    if (options.ability_score_improvement) choices.ability_increases = { int: 1, cha: 1 };
    if (options.feature_choices) {
      choices.feature_options = Object.fromEntries(options.feature_choices.map((spec) => [spec.feature, spec.from.slice(0, spec.choose)]));
    }
    levelUp(db, { campaign_id: campaignId, character_id: id, choices });
  }
}

const fighter = (): number => make('fighter', { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 });

const rollsFor = (purpose: string): Array<{ total: number }> =>
  db.prepare('SELECT total FROM roll WHERE campaign_id = ? AND purpose = ? ORDER BY id').all(campaignId, purpose) as Array<{
    total: number;
  }>;

const secondWindLeft = (id: number): number => {
  const row = (sheet(id).features as Array<{ mechanics?: { resource?: string; max?: number; used?: number } }>).find(
    (f) => f.mechanics?.resource === 'second_wind',
  )!;
  return (row.mechanics!.max ?? 0) - (row.mechanics!.used ?? 0);
};

describe('the stabilise wake-up roll', () => {
  const WAKE = 'Hours until a stable creature regains 1 HP';

  it('tells the DM the rolled hours, and advancing the clock by them wakes the character at 1 HP', async () => {
    const client = await connect();
    const id = fighter();
    applyDamage(db, { campaign_id: campaignId, amount: sheet(id).hp_max! });
    const stable = await call<{ wakes_in_hours: number; note: string }>(client, 'condition', {
      campaign_id: campaignId,
      op: 'stabilize',
      source: "Wren's healer's kit",
    });
    // The hours in the reply are the engine's one roll, and the note says not to roll again.
    expect(rollsFor(WAKE)).toEqual([{ total: stable.wakes_in_hours }]);
    expect(stable.wakes_in_hours).toBeGreaterThanOrEqual(1);
    expect(stable.wakes_in_hours).toBeLessThanOrEqual(4);
    expect(stable.note).toContain(`after ${stable.wakes_in_hours} hour`);
    expect(stable.note).toMatch(/Do not roll it again/);
    expect(stable.note).toContain('time {op: advance}');

    await call(client, 'time', { campaign_id: campaignId, op: 'advance', minutes: stable.wakes_in_hours * 60 - 1 });
    expect(sheet(id).hp_current).toBe(0);
    expect(sheet(id).stable).toBe(true);

    await call(client, 'time', { campaign_id: campaignId, op: 'advance', minutes: 1 });
    expect(sheet(id).hp_current).toBe(1);
    expect(sheet(id).stable).toBe(false);
    expect(sheet(id).conditions as string[]).not.toContain('unconscious');
  });

  it('reports the wake-up hours when three death saves stabilise the character', () => {
    const id = fighter();
    applyDamage(db, { campaign_id: campaignId, amount: sheet(id).hp_max! });
    Math.random = () => 0.6; // every d20 rolls 13
    deathSave(db, { campaign_id: campaignId });
    deathSave(db, { campaign_id: campaignId });
    const third = deathSave(db, { campaign_id: campaignId });
    expect(third.stable).toBe(true);
    expect(rollsFor(WAKE)).toEqual([{ total: third.wakes_in_hours }]);
  });
});

describe('Second Wind with no fight running', () => {
  it('spends a use and heals the character off the sheet through use_action', async () => {
    const client = await connect();
    const id = fighter();
    applyDamage(db, { campaign_id: campaignId, amount: sheet(id).hp_max! - 1 });
    const before = secondWindLeft(id);
    const wind = await call<{ healed: number; hp_current: number; hp_max: number; uses_left: number; uses_max: number }>(
      client,
      'use_action',
      { campaign_id: campaignId, actor_id: id, action_name: 'second_wind' },
    );
    // 1d10 + Fighter level 1, rolled once by the engine and shown in the dice log.
    expect(rollsFor('Second Wind')).toEqual([{ total: wind.healed }]);
    expect(wind.healed).toBeGreaterThanOrEqual(2);
    expect(wind.healed).toBeLessThanOrEqual(11);
    expect(wind.hp_current).toBe(Math.min(wind.hp_max, 1 + wind.healed));
    expect(sheet(id).hp_current).toBe(wind.hp_current);
    expect(wind.uses_left).toBe(before - 1);
    expect(secondWindLeft(id)).toBe(before - 1);
  });

  it('refuses with no uses left and costs nothing', async () => {
    const client = await connect();
    const id = fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 5 });
    for (let n = secondWindLeft(id); n > 0; n -= 1) {
      await call(client, 'use_action', { campaign_id: campaignId, actor_id: id, action_name: 'second_wind' });
      applyDamage(db, { campaign_id: campaignId, amount: 5 });
    }
    const hp = sheet(id).hp_current;
    const rolled = rollsFor('Second Wind').length;
    await expect(
      call(client, 'use_action', { campaign_id: campaignId, actor_id: id, action_name: 'second_wind' }),
    ).rejects.toThrow(/has 0 of \d+ Second Wind left/);
    expect(sheet(id).hp_current).toBe(hp);
    expect(rollsFor('Second Wind')).toHaveLength(rolled);
  });

  it('refuses a character who is down or incapacitated, spending nothing', async () => {
    const client = await connect();
    const id = fighter();
    const uses = secondWindLeft(id);
    applyDamage(db, { campaign_id: campaignId, amount: 3 });
    setCondition(db, { campaign_id: campaignId, condition: 'stunned', active: true });
    await expect(
      call(client, 'use_action', { campaign_id: campaignId, actor_id: id, action_name: 'second_wind' }),
    ).rejects.toThrow(/stunned and takes no action/);
    setCondition(db, { campaign_id: campaignId, condition: 'stunned', active: false });
    applyDamage(db, { campaign_id: campaignId, amount: sheet(id).hp_current! });
    await expect(
      call(client, 'use_action', { campaign_id: campaignId, actor_id: id, action_name: 'second_wind' }),
    ).rejects.toThrow(/down and cannot act/);
    expect(secondWindLeft(id)).toBe(uses);
    expect(rollsFor('Second Wind')).toHaveLength(0);
  });

  it('still refuses anything else without an encounter', async () => {
    const client = await connect();
    const id = fighter();
    await expect(
      call(client, 'use_action', { campaign_id: campaignId, actor_id: id, action_name: 'action_surge' }),
    ).rejects.toThrow(/no active encounter/);
    await expect(
      call(client, 'use_action', { campaign_id: campaignId, actor_id: id, action_name: 'dash' }),
    ).rejects.toThrow(/no active encounter/);
  });
});

describe('Wholeness of Body with no fight running', () => {
  it('heals a Warrior of the Open Hand off the sheet', async () => {
    const client = await connect();
    const id = make('monk', { str: 10, dex: 15, con: 13, int: 8, wis: 14, cha: 12 });
    climbTo(id, 6, 'Warrior of the Open Hand');
    applyDamage(db, { campaign_id: campaignId, amount: sheet(id).hp_max! - 1 });
    const whole = await call<{ action: string; healed: number; hp_current: number; uses_left: number; uses_max: number }>(
      client,
      'use_action',
      { campaign_id: campaignId, actor_id: id, action_name: 'wholeness_of_body' },
    );
    expect(whole.action).toBe('wholeness_of_body');
    expect(rollsFor('Wholeness of Body')).toHaveLength(1);
    expect(whole.healed).toBeGreaterThanOrEqual(1);
    expect(sheet(id).hp_current).toBe(1 + whole.healed);
    expect(whole.uses_left).toBe(whole.uses_max - 1);
  });
});
