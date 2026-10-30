// rest {party: true}: one clock advance for the whole party, nobody at 0 HP rests, and a long rest gives
// back every spent Hit Point Die (SRD 5.2.1), for one character as for the party.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { DAYS_PER_MONTH, MONTHS_PER_YEAR, nowState } from '../src/core/calendar.js';
import { getCharacterSheet } from '../src/core/campaign.js';
import { spendFeatureResource } from '../src/core/character.js';
import { resolvePendingRollsImmediately } from './helpers.js';

let db: Db;
let client: Client;
let stopClicking: () => void;

type HitDice = { die: string; max: number; used: number };
type PartyReply = { kind: string; members: string[] };
type AddResult = { companion: { id: number; name: string } };

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result.structuredContent as T;
}

async function refusal(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return (result.content as Array<{ text: string }>)[0]!.text;
}

/** The campaign clock in whole minutes, so a test can tell 8 hours from 24. */
function clock(campaignId: number): number {
  const now = nowState(db, campaignId);
  const days = (now.year * MONTHS_PER_YEAR + now.month) * DAYS_PER_MONTH + now.day;
  return days * 24 * 60 + now.hour * 60 + now.minute;
}

const sheet = (campaignId: number, id?: number) => getCharacterSheet(db, campaignId, id)!;

/** Marks every Hit Point Die as spent, the state a long day of short rests leaves behind. */
function spendAllHitDice(id: number): void {
  const row = db.prepare('SELECT hit_dice_json FROM character WHERE id = ?').get(id) as { hit_dice_json: string };
  const dice = JSON.parse(row.hit_dice_json) as HitDice;
  db.prepare('UPDATE character SET hit_dice_json = ? WHERE id = ?').run(JSON.stringify({ ...dice, used: dice.max }), id);
}

/** Borg the Fighter, Rook the wolf and Sella the cleric; returns their ids. */
async function makeParty(): Promise<{ campaignId: number; borg: number; rook: number; sella: number }> {
  const { campaign_id: campaignId } = await call<{ campaign_id: number }>('create_campaign', {
    name: 'Camp',
    story_shape: 'sandbox',
  });
  await call('create_character', {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
  const rook = await call<AddResult>('party', { campaign_id: campaignId, op: 'add', name: 'Rook', source: { creature: 'Wolf' } });
  const sella = await call<AddResult>('party', {
    campaign_id: campaignId,
    op: 'add',
    name: 'Sella',
    source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
  });
  return { campaignId, borg: sheet(campaignId).id as number, rook: rook.companion.id, sella: sella.companion.id };
}

beforeEach(async () => {
  db = openDb(':memory:');
  stopClicking = resolvePendingRollsImmediately(db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  stopClicking();
  await client.close();
});

describe('rest {party: true}', () => {
  it('moves the clock once and gives every member back their HP and all their spent Hit Point Dice', async () => {
    const { campaignId, borg, rook, sella } = await makeParty();
    await call('hp', { campaign_id: campaignId, op: 'damage', amount: 5 });
    await call('hp', { campaign_id: campaignId, op: 'damage', amount: 4, character_id: rook });
    await call('hp', { campaign_id: campaignId, op: 'damage', amount: 3, character_id: sella });
    for (const id of [borg, rook, sella]) spendAllHitDice(id);
    expect((sheet(campaignId, rook).hit_dice as HitDice).max).toBeGreaterThan(1);
    const before = clock(campaignId);

    const rested = await call<PartyReply>('rest', { campaign_id: campaignId, kind: 'long', party: true });

    expect(clock(campaignId) - before).toBe(8 * 60);
    for (const id of [borg, rook, sella]) {
      const member = sheet(campaignId, id);
      expect(member.hp_current).toBe(member.hp_max);
      expect((member.hit_dice as HitDice).used).toBe(0);
    }
    expect(rested.members).toHaveLength(3);
    expect(rested.members[0]).toMatch(/^Borg: /);
    expect(rested.members[1]).toMatch(/^Rook: .*2\/2 Hit Point Dice/);
    expect(rested.members[2]).toMatch(/^Sella: /);
  });

  it('leaves a member at 0 HP out of the rest and names them, while the others rest', async () => {
    const { campaignId, borg, sella } = await makeParty();
    await call('hp', { campaign_id: campaignId, op: 'damage', amount: 4 });
    const down = sheet(campaignId, sella);
    await call('hp', { campaign_id: campaignId, op: 'damage', amount: down.hp_max as number, character_id: sella });
    expect(sheet(campaignId, sella).hp_current).toBe(0);

    const rested = await call<PartyReply>('rest', { campaign_id: campaignId, kind: 'long', party: true });

    expect(rested.members[2]).toMatch(/^Sella: does not rest - at 0 HP/);
    expect(sheet(campaignId, sella).hp_current).toBe(0);
    expect(sheet(campaignId, sella).conditions).toContain('unconscious');
    expect(sheet(campaignId, sella).last_long_rest_at).toBeNull();
    expect(sheet(campaignId, borg).hp_current).toBe(sheet(campaignId, borg).hp_max);
  });

  it('takes a short rest for the party on one hour and hands short-rest uses back', async () => {
    const { campaignId, borg, rook } = await makeParty();
    spendFeatureResource(db, { campaign_id: campaignId, character_id: borg, resource: 'second_wind' });
    await call('hp', { campaign_id: campaignId, op: 'damage', amount: 3, character_id: rook });
    const hurt = sheet(campaignId, rook).hp_current;
    const before = clock(campaignId);

    const rested = await call<PartyReply>('rest', { campaign_id: campaignId, kind: 'short', party: true });

    expect(clock(campaignId) - before).toBe(60);
    expect(rested.kind).toBe('short');
    expect(rested.members[0]).toMatch(/^Borg: .*back: Second Wind \(one use\)/);
    // No Hit Point Dice are spent on a party short rest, so nobody heals.
    expect(sheet(campaignId, rook).hp_current).toBe(hurt);
    expect(rested.members.map((line) => line.split(':')[0])).toEqual(['Borg', 'Rook', 'Sella']);
  });

  it('refuses a party long rest when one member cannot take it, and changes nobody and not the clock', async () => {
    const { campaignId, borg, rook } = await makeParty();
    // Rook alone had a long rest just now, without the hours passing.
    await call('rest', { campaign_id: campaignId, kind: 'long', character_id: rook, advance_time: false });
    await call('hp', { campaign_id: campaignId, op: 'damage', amount: 5 });
    spendAllHitDice(borg);
    const borgBefore = sheet(campaignId, borg);
    const rookBefore = sheet(campaignId, rook);
    const before = clock(campaignId);

    const text = await refusal('rest', { campaign_id: campaignId, kind: 'long', party: true });

    expect(text).toMatch(/Rook gets one long rest per 24 hours/);
    expect(clock(campaignId)).toBe(before);
    expect(sheet(campaignId, borg)).toEqual(borgBefore);
    expect(sheet(campaignId, rook)).toEqual(rookBefore);
  });

  it('refuses when nobody is on their feet, without moving the clock', async () => {
    const { campaignId, rook, sella } = await makeParty();
    for (const id of [undefined, rook, sella]) {
      const hp = sheet(campaignId, id).hp_max as number;
      await call('hp', { campaign_id: campaignId, op: 'damage', amount: hp, ...(id ? { character_id: id } : {}) });
    }
    const before = clock(campaignId);

    const text = await refusal('rest', { campaign_id: campaignId, kind: 'long', party: true });

    expect(text).toMatch(/^Nobody in the party can rest\. Borg: does not rest/);
    expect(clock(campaignId)).toBe(before);
  });

  it('refuses a per-character choice on a party rest', async () => {
    const { campaignId } = await makeParty();
    const before = clock(campaignId);
    const text = await refusal('rest', { campaign_id: campaignId, kind: 'short', party: true, hit_dice: 1 });
    expect(text).toMatch(/^hit_dice is one character's choice/);
    expect(clock(campaignId)).toBe(before);
  });
});

describe('a single-character long rest (SRD 5.2.1)', () => {
  it('gives back all spent Hit Point Dice, not half', async () => {
    const { campaignId, rook } = await makeParty();
    spendAllHitDice(rook);
    const max = (sheet(campaignId, rook).hit_dice as HitDice).max;
    expect(max).toBeGreaterThan(1);

    await call('rest', { campaign_id: campaignId, kind: 'long', character_id: rook });

    expect(sheet(campaignId, rook).hit_dice).toMatchObject({ max, used: 0 });
  });

  it('refuses a long rest at 0 HP and leaves the clock alone', async () => {
    const { campaignId } = await makeParty();
    await call('hp', { campaign_id: campaignId, op: 'damage', amount: sheet(campaignId).hp_max as number });
    const before = clock(campaignId);

    const text = await refusal('rest', { campaign_id: campaignId, kind: 'long' });

    expect(text).toMatch(/^Borg is at 0 HP, and a long rest needs at least 1 Hit Point to start\./);
    expect(clock(campaignId)).toBe(before);
    expect(sheet(campaignId).hp_current).toBe(0);
  });
});
