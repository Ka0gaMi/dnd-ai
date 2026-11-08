// A2a-1: an unidentified item's +N never reaches the player as arithmetic; the window reads "+?" in its place.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attack, moveToken, startEncounter } from '../src/combat/engine.js';
import type { BattleMap } from '../src/combat/map.js';
import { getBattleState, listCombatants, type BattleState } from '../src/combat/state.js';
import { bus, type GameEvent } from '../src/core/bus.js';
import { campaignSnapshot, createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import { addItem, createCharacter, createCompanion, rest } from '../src/core/character.js';
import { setOverrides } from '../src/core/overrides.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;
let pcId: number;
let events: GameEvent[];
let unsubscribe: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, {
    name: 'Unknown bonus',
    story_shape: 'sandbox',
    settings: { player_rolls: 'none' },
  }).campaign_id;
  // Chain Mail 16 and STR 17: +5 to hit and 1d8+3 with a one-handed longsword before any magic.
  pcId = createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  }).character!.id;
  events = [];
  unsubscribe = bus.subscribe((event) => events.push(event));
});

afterEach(() => {
  unsubscribe();
});

/** An unidentified +1 longsword in hand and an unidentified +1 shield on the arm: AC 19, +6 and 1d8+4 in truth. */
function arm(characterId?: number): void {
  const owner = characterId === undefined ? {} : { character_id: characterId };
  addItem(db, { campaign_id: campaignId, ...owner, name: '+1 Longsword', unidentified: true, equipped: true });
  addItem(db, { campaign_id: campaignId, ...owner, name: '+1 Shield', unidentified: true, equipped: true });
}

const playerSheet = () => getCharacterSheet(db, campaignId, undefined, { for_player: true })!;
const dmSheet = () => getCharacterSheet(db, campaignId)!;
const swordHints = (state: BattleState): string[] =>
  state.legal_actions.filter((a) => a.id.toLowerCase().includes('longsword')).map((a) => `${a.label} | ${a.hint}`);

/** What the player must never read: the true names and the hidden +1 folded into a number. */
const TRUTH = ['+1 Longsword', '+1 Shield', '+1 AC', '+6 to hit', '1d8+4'];
const expectNoTruth = (payload: unknown): void => {
  const text = JSON.stringify(payload);
  for (const leak of TRUTH) expect(text, leak).not.toContain(leak);
};

/** Puts the fight on the PC's turn, beside a goblin too healthy for one swing to fell. */
async function ambush(): Promise<{ pc: number; foe: number; encounterId: number }> {
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
  return { pc, foe, encounterId };
}

describe('the player sheet leaves an unidentified +N out of AC and marks it', () => {
  it('shows AC 18 +? to the player and the true 19 to the DM', () => {
    arm();

    const player = playerSheet();
    expect(player.ac).toBe(18);
    expect(player.ac_unknown).toBe(true);
    expect(player.ac_breakdown).toMatchObject({ total: 18, magic_bonus: 0, shield: true });
    expect(player.ac_breakdown.notes).toContain('Unidentified shield: +? AC');
    expectNoTruth(player);

    // The snapshot the window subscribes to carries the same masked sheet.
    const snapshotPc = campaignSnapshot(db, campaignId, { forPlayer: true }).pc!;
    expect(snapshotPc).toMatchObject({ ac: 18, ac_unknown: true });
    expectNoTruth(snapshotPc);

    const dm = dmSheet();
    expect(dm.ac).toBe(19);
    expect(dm.ac_unknown).toBeUndefined();
    expect(dm.ac_breakdown).toMatchObject({ total: 19, magic_bonus: 1 });
    expect(dm.ac_breakdown.notes).toContain('Unidentified shield: +1 AC');
    expect(campaignSnapshot(db, campaignId).pc!.ac).toBe(19);
  });

  it("leaves a worn item's own unidentified ac_bonus out the same way", () => {
    addItem(db, {
      campaign_id: campaignId,
      name: 'Glimmering Band',
      magic: { rarity: 'rare', attunement: false, mechanics: { ac_bonus: 1 } },
      unidentified: true,
      equipped: true,
    });

    expect(dmSheet().ac).toBe(17);
    const player = playerSheet();
    expect(player).toMatchObject({ ac: 16, ac_unknown: true });
    expect(player.ac_breakdown.notes).toContain('Unidentified item: +? AC');
    expect(JSON.stringify(player)).not.toMatch(/Glimmering|\+1 AC/);
  });

  it('keeps a hand-set AC as the player typed it, with no marker on it', () => {
    arm();
    setOverrides(db, pcId, { ac: 21 });

    const player = playerSheet();
    expect(player.ac).toBe(21);
    expect(player.ac_unknown).toBeUndefined();
    // The breakdown still never spells the hidden +1 out.
    expect(player.ac_breakdown.notes).toContain('Unidentified shield: +? AC');
    expectNoTruth(player);
  });

  it("masks a companion's AC in the player's party row and companion sheet, not the DM's", () => {
    const rook = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Rook',
      source: { class: 'Fighter', species: 'Human', background: 'Soldier' },
    }).companion!.id;
    arm(rook);
    const trueAc = getCharacterSheet(db, campaignId, rook)!.ac!;

    const row = campaignSnapshot(db, campaignId, { forPlayer: true }).companions.find((c) => c.id === rook)!;
    expect(row).toMatchObject({ ac: trueAc - 1, ac_unknown: true });
    // The route behind the companion sheet the window opens.
    const sheet = getCharacterSheet(db, campaignId, rook, { for_player: true })!;
    expect(sheet).toMatchObject({ ac: trueAc - 1, ac_unknown: true });
    expectNoTruth(sheet);

    const dmRow = campaignSnapshot(db, campaignId).companions.find((c) => c.id === rook)!;
    expect(dmRow.ac).toBe(trueAc);
    expect(dmRow.ac_unknown).toBeUndefined();
  });
});

describe('the attack hints leave an unidentified +N out and mark it', () => {
  it('says "+5 +? to hit, 1d8+3 +?" in the player battle state and "+6, 1d8+4" in the DM one', async () => {
    arm();
    await ambush();

    const player = campaignSnapshot(db, campaignId, { forPlayer: true }).encounter!;
    expect(swordHints(player)).toEqual([
      'Attack: Unidentified longsword | +5 +? to hit, 1d8+3 +? slashing, reach 5 ft.',
    ]);
    expectNoTruth(player.legal_actions);
    // A caller that never names its audience gets the player's copy.
    expect(swordHints(getBattleState(db, campaignId)!)).toEqual(swordHints(player));

    expect(swordHints(getBattleState(db, campaignId, false)!)).toEqual([
      'Attack: +1 Longsword | +6 to hit, 1d8+4 slashing, reach 5 ft.',
    ]);
  });

  it('pushes the marked hint on the bus event, and the engine still rolls the true +1', async () => {
    arm();
    const { pc, foe } = await ambush();

    // A step spends no Action, so the event's list still offers the swing.
    moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 3, y: 6 } });
    const event = events.filter((e) => e.kind === 'combat').at(-1)!;
    const state = (event.payload as { state: BattleState }).state;
    expect(swordHints(state)).toEqual(['Attack: Unidentified longsword | +5 +? to hit, 1d8+3 +? slashing, reach 5 ft.']);
    expectNoTruth(state.legal_actions);
    expect(JSON.stringify(event)).not.toMatch(/\+1 Longsword|\+1 Shield/);

    const swung = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: foe,
      action_name: 'Unidentified longsword',
      roll: { total: 30, natural: 12 },
    });
    expect(swung.hit).toBe(true);
    const damage = swung.log.find((e) => e.kind === 'damage')!;
    expect((damage.payload as { expr: string }).expr).toBe('1d8+4');
  });
});

describe('identifying the gear shows the player the true numbers', () => {
  it('drops the marker from the sheet and the hint once both items are known', async () => {
    arm();
    rest(db, { campaign_id: campaignId, kind: 'short', identify: ['Unidentified shield', 'Unidentified longsword'] });

    const player = playerSheet();
    expect(player.ac).toBe(19);
    expect(player.ac_unknown).toBeUndefined();
    expect(player.ac_breakdown).toMatchObject({ total: 19, magic_bonus: 1 });
    expect(player.ac_breakdown.notes).toContain('+1 Shield: +1 AC');

    await ambush();
    const hints = swordHints(campaignSnapshot(db, campaignId, { forPlayer: true }).encounter!);
    expect(hints).toEqual(['Attack: +1 Longsword | +6 to hit, 1d8+4 slashing, reach 5 ft.']);
    expect(hints.join(' ')).not.toContain('+?');
  });
});
