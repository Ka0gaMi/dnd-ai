// A2a-1 review fixes: an unidentified potion's dice stay the DM's, the purse follows a hand-set gold column, a
// hand-set AC hides unidentified gear, an empty days item recharges, and a rest without the clock still ends Concentration.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startEncounter, useAction } from '../src/combat/engine.js';
import type { BattleMap } from '../src/combat/map.js';
import { combatSheet } from '../src/combat/sheet.js';
import { combatLog, getBattleState, listCombatants, type CombatLogEntry } from '../src/combat/state.js';
import { useFeatureOutsideCombat } from '../src/combat/use-action.js';
import { bus, type GameEvent } from '../src/core/bus.js';
import { advanceTime, nowState } from '../src/core/calendar.js';
import { campaignSnapshot, createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import {
  addItem,
  applyDamage,
  concentrationOf,
  createCharacter,
  listInventory,
  partyRest,
  rest,
  sheetExtras,
  useSpellSlot,
  type CreateCharacterInput,
} from '../src/core/character.js';
import { setOverrides } from '../src/core/overrides.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { HOST, startHttpServer } from '../src/transport/http.js';

let db: Db;
let campaignId: number;
let events: GameEvent[];
let unsubscribe: () => void;
const realRandom = Math.random;
/** Every die rolls a 1, so 4d4+4 reads "[1, 1, 1, 1]+4 = 8". */
const LOWEST = (): number => 0;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Fixes', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  events = [];
  unsubscribe = bus.subscribe((event) => events.push(event));
});

afterEach(() => {
  unsubscribe();
  Math.random = realRandom;
});

function make(overrides: Partial<CreateCharacterInput> = {}): number {
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

const hpMax = (id: number): number => getCharacterSheet(db, campaignId, id)!.hp_max!;

// --- 1. an unidentified healing potion ------------------------------------------------

/** What would name a Potion of Greater Healing: its dice, and the four faces they showed. */
const GREATER_DICE = [/4d4/, /\[1, 1, 1, 1\]/];
const expectNoDice = (where: string, value: unknown): void => {
  const text = JSON.stringify(value);
  for (const leak of GREATER_DICE) expect(text, `${where}: ${leak}`).not.toMatch(leak);
};

async function ambush(): Promise<{ pc: number; encounterId: number }> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior' }],
  });
  const encounterId = getBattleState(db, campaignId)!.encounter.id;
  const map: BattleMap = { w: 20, h: 10, rows: Array.from({ length: 10 }, () => '.'.repeat(20)), features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), encounterId);
  const pc = listCombatants(db, encounterId).find((c) => c.kind === 'pc')!.id;
  const foe = listCombatants(db, encounterId).find((c) => c.team === 'enemy')!.id;
  db.prepare('UPDATE combatant SET x = 3, y = 5, action_used = 0, bonus_used = 0, reaction_used = 0 WHERE id = ?').run(pc);
  db.prepare('UPDATE combatant SET x = 10, y = 5 WHERE id = ?').run(foe);
  const index = getBattleState(db, campaignId)!.combatants.findIndex((c) => c.id === pc);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, encounterId);
  return { pc, encounterId };
}

const healLine = (log: CombatLogEntry[]): CombatLogEntry => log.filter((entry) => entry.kind === 'heal').at(-1)!;

describe('1. an unidentified healing potion keeps its dice from the player', () => {
  it('out of a fight: the roll is a DM-only secret roll, and the player reads only the hit points', () => {
    const id = make();
    addItem(db, { campaign_id: campaignId, character_id: id, name: 'Potion of Greater Healing', unidentified: true });
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: hpMax(id) - 1 });
    events = [];
    Math.random = LOWEST;
    const drunk = useFeatureOutsideCombat(db, { campaign_id: campaignId, actor_id: id, action_name: 'Potion of Greater Healing' });

    expect(drunk).toMatchObject({ healed: 8, text: 'Borg drinks an Unidentified potion.' });
    expectNoDice('bus', events);
    expect(events.map((e) => e.text).join('\n')).toMatch(/Borg regains 8 HP/);
    expectNoDice('recent events', campaignSnapshot(db, campaignId, { forPlayer: true }).recent_events);
    // The DM keeps the true roll: in the reply, and as a recorded roll under a secret_roll event.
    expect(drunk.roll).toContain('4d4+4');
    expect(
      db.prepare('SELECT event.kind, event.text, roll.total FROM roll JOIN event ON event.id = roll.event_id WHERE roll.campaign_id = ?').all(campaignId),
    ).toEqual([{ kind: 'secret_roll', text: expect.stringContaining('4d4+4: [1, 1, 1, 1]+4 = 8'), total: 8 }]);
  });

  it('out of a fight: an identified potion still rolls into the player dice log', () => {
    const id = make();
    addItem(db, { campaign_id: campaignId, character_id: id, name: 'Potion of Healing' });
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: hpMax(id) - 1 });
    events = [];
    Math.random = LOWEST;
    useFeatureOutsideCombat(db, { campaign_id: campaignId, actor_id: id, action_name: 'Potion of Healing' });
    expect(events.find((e) => e.kind === 'roll')?.text).toBe('Potion of Healing: 2d4+2: [1, 1]+2 = 4');
  });

  it('in a fight: the heal line carries a player copy without the dice, and the DM keeps them', async () => {
    const id = make();
    addItem(db, { campaign_id: campaignId, character_id: id, name: 'Potion of Greater Healing', unidentified: true });
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: hpMax(id) - 1 });
    const { pc, encounterId } = await ambush();
    events = [];
    Math.random = LOWEST;
    const drunk = (await useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'Potion of Greater Healing' })) as unknown as {
      roll: string;
      healed: number;
      log: CombatLogEntry[];
    };

    expect(drunk.healed).toBe(8);
    expectNoDice('bus', events);
    const playerTail = getBattleState(db, campaignId)!.log_tail;
    expectNoDice('player log_tail', playerTail);
    expect(healLine(playerTail).text).toBe(`Borg regains 8 HP (9/${hpMax(id)}).`);
    expectNoDice('player snapshot', campaignSnapshot(db, campaignId, { forPlayer: true }));
    // The DM's reply, tail and stored log keep the true roll.
    expect(drunk.roll).toContain('4d4+4');
    expect(healLine(drunk.log).text).toContain('(4d4+4: [1, 1, 1, 1]+4 = 8)');
    expect(healLine(getBattleState(db, campaignId, false)!.log_tail).text).toContain('4d4+4');
    expect(healLine(combatLog(db, encounterId)).text).toContain('4d4+4');
  });

  it('in a fight: an identified potion reads its dice to the player as before', async () => {
    const id = make();
    addItem(db, { campaign_id: campaignId, character_id: id, name: 'Potion of Healing' });
    applyDamage(db, { campaign_id: campaignId, character_id: id, amount: hpMax(id) - 1 });
    const { pc } = await ambush();
    Math.random = LOWEST;
    await useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'Potion of Healing' });
    const line = healLine(getBattleState(db, campaignId)!.log_tail);
    expect(line.text).toBe(`Borg regains 4 HP (2d4+2: [1, 1]+2 = 4) (5/${hpMax(id)}).`);
    expect(line.payload).not.toHaveProperty('player_copy');
  });
});

// --- 2. the purse behind a hand-set gold column ---------------------------------------

describe('2. rowCoins re-mints the purse from a hand-set gold column, as loadPc does', () => {
  it("agrees on carried weight and speed in every reader after the reviewer's probe", () => {
    // STR 13: 195 lb of capacity, which 9000 gp (180 lb) on top of the Soldier's kit would pass.
    const id = make({ abilities: { str: 13, dex: 15, con: 14, int: 8, wis: 12, cha: 10 }, ability_bonuses: { dex: 2, con: 1 } });
    db.prepare('UPDATE character SET coins_json = ?, gold = ? WHERE id = ?').run(JSON.stringify({ gp: 9000 }), 9000, id);
    setOverrides(db, id, { gold: 10 });

    const player = getCharacterSheet(db, campaignId, id, { for_player: true })!;
    const dm = getCharacterSheet(db, campaignId, id)!;
    const pack = listInventory(db, { campaign_id: campaignId, character_id: id });
    expect(pack.coins).toMatchObject({ gp: 10 });
    expect(player.carried_lb).toBe(pack.carried_lb);
    expect(dm.carried_lb).toBe(pack.carried_lb);
    expect(player.carried_lb).toBeLessThan(195);
    expect([player.encumbered, dm.encumbered, pack.encumbered]).toEqual([false, false, false]);
    const speed = sheetExtras(db, campaignId, id).speed;
    expect(speed).toBeGreaterThan(5);
    expect([player.speed, dm.speed, combatSheet(db, id).speed]).toEqual([speed, speed, speed]);
  });
});

// --- 3. a hand-set AC over an unidentified shield --------------------------------------

/** The true AC 19 and the true name, which the player must never read. */
const SHIELD_TRUTH = [/\+1 Shield/, /\+1 AC/, /"ac":19/, /AC 19/, /was 19/, /"old":19/];
const expectNoShieldTruth = (where: string, value: unknown): void => {
  const text = JSON.stringify(value);
  for (const leak of SHIELD_TRUTH) expect(text, `${where}: ${leak}`).not.toMatch(leak);
};

describe('3. a player hand-set AC never reads out the AC an unidentified shield hides', () => {
  it('logs the was-figure as the player knows it and answers the player route with the player copy', async () => {
    const id = make();
    addItem(db, { campaign_id: campaignId, character_id: id, name: '+1 Shield', unidentified: true, equipped: true });
    updateSettings(db, campaignId, { cheat_mode: true });
    // Chain Mail 16, a Shield +2 and the hidden +1: the DM's 19 is the player's 18 +?.
    expect(getCharacterSheet(db, campaignId, id)!.ac).toBe(19);
    const server = await startHttpServer(db, { port: 0, secret: 'a2a1fixestestsecret0123456789abc' });
    try {
      events = [];
      const res = await fetch(`http://${HOST}:${server.port}/api/characters/${id}/overrides`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ac: 21 }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { character: Record<string, unknown> };
      expect(body.character).toMatchObject({ ac: 21, hand_set: ['ac'] });
      expectNoShieldTruth('response', body);
      const told = events.find((e) => e.kind === 'override')!;
      expect(told.text).toBe('Borg: ac hand-set to 21 (was 18 +?).');
      expectNoShieldTruth('override event', told);
      // The DM's own copy still knows the shield.
      expect(JSON.stringify(getCharacterSheet(db, campaignId, id))).toMatch(/\+1 Shield/);
    } finally {
      await server.close();
    }
  });
});

// --- 4. a days item added empty ------------------------------------------------------

describe('4. a days item added or set with no charges left recharges after its days', () => {
  const toad = () => listInventory(db, { campaign_id: campaignId }).items.find((i) => i.name === 'Jade Toad')!.magic!.charges!;
  const jadeToad = (current: number): void => {
    addItem(db, { campaign_id: campaignId, name: 'Jade Toad', magic: { rarity: 'rare', charges: { current, max: 1, recharge: 'days', days: 2 } } });
  };

  it('starts its wait when it is added empty', () => {
    make();
    jadeToad(0);
    expect(toad().empty_since).toBeDefined();
    advanceTime(db, campaignId, { days: 1, hours: 23 });
    expect(toad().current).toBe(0);
    advanceTime(db, campaignId, { hours: 1 });
    expect(toad()).toMatchObject({ current: 1, max: 1 });
    expect(toad().empty_since).toBeUndefined();
  });

  it('starts its wait when its charges are set to empty on an item already carried', () => {
    make();
    jadeToad(1);
    advanceTime(db, campaignId, { days: 3 });
    jadeToad(0);
    advanceTime(db, campaignId, { days: 1, hours: 23 });
    expect(toad().current).toBe(0);
    advanceTime(db, campaignId, { hours: 1 });
    expect(toad().current).toBe(1);
  });
});

// --- 5. Concentration across a rest that leaves the clock alone ------------------------

describe('5. a rest with advance_time false still ends a spell that runs out inside it', () => {
  function cleric(): number {
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
  }
  const suggestion = (): void => {
    useSpellSlot(db, { campaign_id: campaignId, level: 2, spell: 'Suggestion' });
  };
  const clock = (): string => nowState(db, campaignId).date_text;

  it('ends an 8-hour spell cast 7.5 hours before a short rest that leaves the clock alone', () => {
    cleric();
    suggestion();
    advanceTime(db, campaignId, { hours: 7, minutes: 30 });
    const before = clock();
    const rested = rest(db, { campaign_id: campaignId, kind: 'short', advance_time: false });
    expect(rested.concentration_ended).toBe('Suggestion ends: its duration ran out during the rest.');
    expect(concentrationOf(db, campaignId)).toBeNull();
    expect(clock()).toBe(before);
  });

  it('keeps an 8-hour spell cast just now through a short rest that leaves the clock alone', () => {
    cleric();
    suggestion();
    expect(rest(db, { campaign_id: campaignId, kind: 'short', advance_time: false }).concentration_ended).toBeUndefined();
    expect(concentrationOf(db, campaignId)?.spell).toBe('Suggestion');
  });

  it('counts a party rest, which moves the clock first, only once', async () => {
    cleric();
    suggestion();
    advanceTime(db, campaignId, { hours: 6, minutes: 30 });
    await partyRest(db, { campaign_id: campaignId, kind: 'short' }, async (one) => rest(db, one));
    expect(concentrationOf(db, campaignId)?.spell).toBe('Suggestion');
    // Now 7.5 hours in, the next hour's rest outlasts it.
    const rested = await partyRest(db, { campaign_id: campaignId, kind: 'short' }, async (one) => rest(db, one));
    expect(rested.members.join(' ')).toMatch(/Suggestion ends/);
    expect(concentrationOf(db, campaignId)).toBeNull();
  });
});
