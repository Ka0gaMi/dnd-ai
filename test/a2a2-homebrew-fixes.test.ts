// A2a-2: the homebrew playtest's fixes - a custom-named magic weapon attacks by its own name, an
// unidentified one's clause never names it to the player, and rolled temporary hit points log their amount.
import { beforeEach, describe, expect, it } from 'vitest';
import { actionsFor, findAction } from '../src/combat/actions.js';
import { attack, startEncounter } from '../src/combat/engine.js';
import type { BattleMap } from '../src/combat/map.js';
import { combatSheet } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, type BattleState, type Combatant } from '../src/combat/state.js';
import { bus, type GameEvent } from '../src/core/bus.js';
import { campaignSnapshot, createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import { addItem, createCharacter, grantFeature } from '../src/core/character.js';
import { clausesSchema } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import {
  applyRollBoost,
  getPendingRoll,
  openPendingRolls,
  resolvePendingRoll,
  rollBoosts,
  type PendingRollRow,
} from '../src/core/rolls.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;
let pcId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, {
    name: 'Emberford',
    story_shape: 'sandbox',
    settings: { player_rolls: 'none' },
  }).campaign_id;
  pcId = createCharacter(db, {
    campaign_id: campaignId,
    name: 'Bram',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  }).character!.id;
  // Nothing from the starting kit, so every label below is one the test put there.
  setInventory([]);
});

const setInventory = (items: Array<Record<string, unknown>>): void => {
  db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(JSON.stringify(items), pcId);
};

const CINDERBRAND_CLAUSES = clausesSchema.parse([
  { when: 'hit', if: { weapon: { melee: true } }, do: [{ kind: 'extra_damage', dice: '1d4', type: 'fire' }], uses: 'once_per_turn' },
]);

/** Hilde's reforged greatsword, as the homebrew playtest seeds it: no +N, one fire rider. */
function cinderbrand(unidentified = false, clauses = CINDERBRAND_CLAUSES): void {
  addItem(db, {
    campaign_id: campaignId,
    character_id: pcId,
    name: 'Cinderbrand',
    equipped: true,
    magic: { rarity: 'uncommon', attunement: false, base: 'Greatsword', mechanics: { clauses } },
    ...(unidentified ? { unidentified: true } : {}),
  });
}

/** Works out what every item on Bram is, the way a rest spent on them would. */
const identifyAll = (): void => {
  const row = db.prepare('SELECT inventory_json FROM character WHERE id = ?').get(pcId) as { inventory_json: string };
  const items = JSON.parse(row.inventory_json) as Array<{ magic?: { identified?: boolean } }>;
  for (const item of items) if (item.magic) item.magic.identified = true;
  setInventory(items);
};

/** Gives Bram his Action back on the same turn, as the homebrew suite's resetAction does. */
const resetAction = (pc: number): void => {
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, movement_left = speed WHERE id = ?').run(pc);
};

/** A custom magic greatsword with no clause, written straight onto the row. */
const customGreatsword = (name: string, identified: boolean): Record<string, unknown> => ({
  name,
  qty: 1,
  equipped: true,
  magic: { rarity: 'uncommon', attunement: false, base: 'Greatsword', identified },
});

/** Puts the fight on Bram's turn, beside a goblin too healthy for one swing to fell. */
async function ambush(): Promise<{ pc: number; foe: number }> {
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
  db.prepare('UPDATE combatant SET x = 4, y = 5, hp_max = 200, hp_current = 200 WHERE id = ?').run(foe);
  const index = getBattleState(db, campaignId)!.combatants.findIndex((c) => c.id === pc);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, encounterId);
  return { pc, foe };
}

const bram = (): Combatant => listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.kind === 'pc')!;
const attackLabels = (state: BattleState): string[] =>
  state.legal_actions.filter((a) => a.id.startsWith('attack:')).map((a) => a.label);
/** The weapon names off the sheet's action list, for whoever reads it; a combatant with no stat block is enough. */
const weaponNames = (forPlayer: boolean): string[] =>
  actionsFor({ name: 'Bram' } as Combatant, combatSheet(db, pcId), forPlayer)
    .map((a) => a.name)
    .filter((name) => name !== 'Unarmed Strike');

describe('a custom-named magic weapon with no +N', () => {
  it('is listed by its own name, and an attack by that name hits and fires its clause', async () => {
    cinderbrand();
    const { pc, foe } = await ambush();

    expect(attackLabels(getBattleState(db, campaignId, false)!)).toContain('Attack: Cinderbrand');
    expect(attackLabels(campaignSnapshot(db, campaignId, { forPlayer: true }).encounter!)).toContain('Attack: Cinderbrand');

    const swung = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: foe,
      action_name: 'Cinderbrand',
      roll: { total: 30, natural: 12 },
    });
    expect(swung.hit).toBe(true);
    // The greatsword's own 2d6 and STR +3, then the fire rider the item carries.
    expect((swung.log.find((e) => e.kind === 'damage')!.payload as { expr: string }).expr).toBe('2d6+3');
    const features = (swung as { features?: Array<{ feature: string; damage?: number }> }).features ?? [];
    const fire = features.find((f) => f.feature === 'Cinderbrand');
    expect(fire?.damage).toBeGreaterThanOrEqual(1);
  });

  it('still answers to its kind when it is the only greatsword carried', async () => {
    cinderbrand();
    await ambush();
    expect(findAction(bram(), combatSheet(db, pcId), 'Greatsword').name).toBe('Cinderbrand');

    // With a second greatsword the kind is ambiguous, and the plain one takes its own name.
    setInventory([customGreatsword('Cinderbrand', true), customGreatsword('Emberfang', true)]);
    expect(() => findAction(bram(), combatSheet(db, pcId), 'Greatsword')).toThrow(/no action called "Greatsword"/);
    setInventory([customGreatsword('Cinderbrand', true), { name: 'Greatsword', qty: 1, equipped: false }]);
    expect(findAction(bram(), combatSheet(db, pcId), 'Greatsword').name).toBe('Greatsword');
  });

  it('shows the player only its masked name while it is unidentified', async () => {
    cinderbrand(true);
    await ambush();

    const player = campaignSnapshot(db, campaignId, { forPlayer: true }).encounter!;
    expect(attackLabels(player)).toContain('Attack: Unidentified greatsword');
    expect(JSON.stringify(player.legal_actions)).not.toContain('Cinderbrand');
    expect(attackLabels(getBattleState(db, campaignId)!)).toEqual(attackLabels(player));
    expect(attackLabels(getBattleState(db, campaignId, false)!)).toContain('Attack: Cinderbrand');

    // The DM's true name resolves to the masked action, so nothing the player reads carries it.
    const sheet = combatSheet(db, pcId);
    expect(findAction(bram(), sheet, 'Cinderbrand').name).toBe('Unidentified greatsword');
    expect(findAction(bram(), sheet, 'Greatsword').name).toBe('Unidentified greatsword');
    expect(weaponNames(true)).toHaveLength(weaponNames(false).length);
  });
});

describe('weapon labels that must not move', () => {
  it('keeps a mundane Greatsword as "Greatsword"', () => {
    setInventory([{ name: 'Greatsword', qty: 1, equipped: true }]);
    expect(weaponNames(true)).toEqual(['Greatsword']);
    expect(weaponNames(false)).toEqual(['Greatsword']);
  });

  it('numbers two weapons of a kind, masked or not, in the same order for both audiences', () => {
    setInventory([
      { name: 'Greatsword', qty: 1, equipped: true },
      { name: 'Greatsword', qty: 1, equipped: false },
    ]);
    expect(weaponNames(true)).toEqual(['Greatsword', 'Greatsword (2)']);

    setInventory([customGreatsword('Cinderbrand', true), customGreatsword('Cinderbrand', true)]);
    expect(weaponNames(false)).toEqual(['Cinderbrand', 'Cinderbrand (2)']);

    setInventory([customGreatsword('Cinderbrand', false), customGreatsword('Emberfang', false)]);
    expect(weaponNames(true)).toEqual(['Unidentified greatsword', 'Unidentified greatsword (2)']);
    expect(weaponNames(false)).toEqual(['Cinderbrand', 'Emberfang']);
  });
});

describe('an unidentified magic item whose clause fires', () => {
  it("names nothing but the player's word for it in the player's log, the bus event or the battle state", async () => {
    const events: GameEvent[] = [];
    const unsubscribe = bus.subscribe((event) => events.push(event));
    try {
      cinderbrand(true);
      const { pc, foe } = await ambush();
      const swung = await attack(db, {
        campaign_id: campaignId,
        attacker_id: pc,
        target_id: foe,
        action_name: 'Unidentified greatsword',
        roll: { total: 30, natural: 12 },
      });
      expect(swung.hit).toBe(true);
    } finally {
      unsubscribe();
    }

    const player = campaignSnapshot(db, campaignId, { forPlayer: true });
    const tail = player.encounter!.log_tail;
    expect(tail.map((e) => e.text)).toContainEqual(expect.stringMatching(/^Unidentified greatsword: Extra 1d4 fire damage\. Goblin Warrior takes \d+ more/));
    expect(tail.map((e) => e.text)).toContain('Unidentified greatsword is spent for this turn.');
    // The once-a-turn mark, the handler's index and its name ride the battle state too.
    expect(JSON.stringify(player)).not.toMatch(/cinderbrand/i);
    const combat = events.filter((e) => e.kind === 'combat');
    expect(combat.length).toBeGreaterThan(0);
    expect(JSON.stringify(combat)).not.toMatch(/cinderbrand/i);

    // The DM's view keeps the truth where it reads it, and the fight log both share says what landed.
    const dm = getBattleState(db, campaignId, false)!;
    expect(weaponNames(false)).toEqual(['Cinderbrand']);
    expect(dm.log_tail.some((e) => e.text.startsWith('Unidentified greatsword: Extra 1d4 fire damage.'))).toBe(true);
  });

  it('keeps a use spent before it was identified spent after', async () => {
    const rationed = clausesSchema.parse([
      { when: 'hit', do: [{ kind: 'extra_damage', dice: '1d4', type: 'fire' }], uses: { per: 'long', count: 1 } },
    ]);
    cinderbrand(true, rationed);
    const { pc, foe } = await ambush();
    const fireOf = (result: unknown): Array<{ feature: string; damage?: number }> =>
      ((result as { features?: Array<{ feature: string; damage?: number }> }).features ?? []).filter((f) => f.damage !== undefined);

    const first = await attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: foe, action_name: 'Unidentified greatsword', roll: { total: 30, natural: 12 } });
    expect(fireOf(first).map((f) => f.feature)).toEqual(['Unidentified greatsword']);
    // The spend's own line reads the player's word for it too.
    const spent = first.log.find((e) => e.kind === 'feature_resource')!;
    expect(spent.text).toBe('Bram spends 1 Unidentified greatsword: 0 of 1 left.');

    identifyAll();
    resetAction(pc);
    const second = await attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: foe, action_name: 'Cinderbrand', roll: { total: 30, natural: 12 } });
    expect(second.hit).toBe(true);
    expect(fireOf(second)).toEqual([]);
    expect(combatSheet(db, pcId).features.find((f) => f.mechanics?.resource === 'homebrew:cinderbrand:0')?.mechanics?.used).toBe(1);
  });
});

describe("an unidentified magic item's counter keys", () => {
  it('reach the player only in an opaque form, on the sheet, the snapshot, the log, the bus and the roll card', async () => {
    cinderbrand(
      true,
      clausesSchema.parse([
        { when: 'hit', do: [{ kind: 'extra_damage', dice: '1d4', type: 'fire' }], uses: { per: 'long', count: 1 } },
        { when: 'roll', if: { kind: 'attack' }, do: [{ kind: 'advantage' }], uses: { per: 'long', count: 1 }, decide: 'ask_before' },
      ]),
    );
    const { pc, foe } = await ambush();
    updateSettings(db, campaignId, { roll_mode: 'player', player_rolls: 'd20_only' });
    const events: GameEvent[] = [];
    const unsubscribe = bus.subscribe((event) => events.push(event));
    const realRandom = Math.random;
    let card: PendingRollRow | undefined;
    try {
      const running = attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: foe, action_name: 'Unidentified greatsword' });
      for (let tries = 0; tries < 100 && !card; tries += 1) {
        card = openPendingRolls(db, campaignId)[0];
        if (!card) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // The card as the player's window reads it: the route adds the boosts to the row.
      const shownCard = { ...card!, ...rollBoosts(card!) };
      expect(JSON.stringify(shownCard)).not.toMatch(/cinderbrand/i);
      const offered = shownCard.boosts_available.map((one) => one.id);
      expect(offered).toEqual([expect.stringMatching(/^homebrew:item_[a-z0-9]+:1$/)]);
      // The window sends back the id it was shown, and the engine spends the true counter.
      expect(applyRollBoost(db, card!.id, offered[0]!).advantage).toBe('advantage');
      expect(rollBoosts(getPendingRoll(db, card!.id)!).boosts_chosen).toEqual(['homebrew:cinderbrand:1']);
      // 0.041 pins every d20 to a natural 20, so the swing lands and the rider spends its use.
      Math.random = () => 0.041;
      resolvePendingRoll(db, card!.id);
      expect((await running).hit).toBe(true);
    } finally {
      Math.random = realRandom;
      unsubscribe();
    }

    const dmSheet = getCharacterSheet(db, campaignId)!;
    const counters = (dmSheet.features as Array<{ mechanics?: { resource?: string; used?: number } }>)
      .filter((f) => f.mechanics?.resource?.startsWith('homebrew:cinderbrand:'))
      .map((f) => [f.mechanics!.resource, f.mechanics!.used]);
    expect(counters).toEqual([
      ['homebrew:cinderbrand:1', 1],
      ['homebrew:cinderbrand:0', 1],
    ]);

    const playerSheet = getCharacterSheet(db, campaignId, undefined, { for_player: true })!;
    expect(JSON.stringify(playerSheet)).not.toMatch(/cinderbrand/i);
    expect(JSON.stringify(playerSheet.features)).toMatch(/"resource":"homebrew:item_[a-z0-9]+:0"/);
    const snapshot = campaignSnapshot(db, campaignId, { forPlayer: true });
    expect(JSON.stringify(snapshot)).not.toMatch(/cinderbrand/i);
    expect(snapshot.encounter!.log_tail.some((e) => e.kind === 'feature_resource')).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toMatch(/cinderbrand/i);

    // The DM's copies keep the true key.
    const dmTail = getBattleState(db, campaignId, false)!.log_tail;
    expect(dmTail.filter((e) => e.kind === 'feature_resource').map((e) => (e.payload as { resource: string }).resource)).toContain(
      'homebrew:cinderbrand:0',
    );
    expect(getPendingRoll(db, card!.id)!.context_json).toContain('homebrew:cinderbrand:1');
  });
});

describe('temporary hit points a clause rolls', () => {
  it('are logged with the amount rolled', async () => {
    const name = 'Forge-Tempered';
    const clauses = clausesSchema.parse([
      { when: 'damage_taken', do: [{ kind: 'temp_hp', dice: '1d8' }], uses: { per: 'short', count: 1 } },
    ]);
    const entry = saveHomebrew(db, { campaign_id: campaignId, kind: 'feature', name, schema: { name, text: name, clauses } });
    grantFeature(db, { campaign_id: campaignId, character_id: pcId, name, text: name, source: 'homebrew', mechanics: { homebrew_id: entry.id } });
    const { pc, foe } = await ambush();

    const struck = await attack(db, {
      campaign_id: campaignId,
      attacker_id: foe,
      target_id: pc,
      action_name: 'Scimitar',
      roll: { total: 25, natural: 15 },
      out_of_turn: true,
      reason: 'the raider swings back',
    });
    const gained = bram().temp_hp;
    expect(gained).toBeGreaterThanOrEqual(1);
    const line = struck.log.find((e) => e.text.startsWith(`${name}:`))!;
    expect(line.text).toBe(`${name}: ${gained} Temporary Hit Points (1d8: [${gained}] = ${gained})`);
    expect(line.payload).toMatchObject({ temp_hp: gained });
  });
});
