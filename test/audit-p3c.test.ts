import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, createCompanion } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { advanceTurn, attack, startEncounter, useAction } from '../src/combat/engine.js';
import { getBattleState, listCombatants, type BattleState } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const MID_D20 = 0.5;

function makeCampaign(database: Db): number {
  const id = createCampaign(database, { name: 'Cover', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
    .campaign_id;
  createCharacter(database, {
    campaign_id: id,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
  return id;
}

/** A level 5 wizard companion with the slots and the spells these cover tests need. */
function makeWizard(): number {
  const id = createCompanion(db, {
    campaign_id: campaignId,
    name: 'Zel',
    source: { class: 'Wizard', species: 'Human', background: 'Sage' },
  }).companion!.id;
  db.prepare('UPDATE character SET level = 5, spells_json = ?, spell_slots_json = ?, inventory_json = ? WHERE id = ?').run(
    JSON.stringify({
      cantrips: ['Fire Bolt'],
      known: ['Fireball', 'Hold Person'],
      prepared: ['Fireball', 'Hold Person'],
      save_dc: 14,
      attack_bonus: 6,
    }),
    JSON.stringify({ '1': { max: 4, used: 0 }, '2': { max: 3, used: 0 }, '3': { max: 2, used: 0 } }),
    JSON.stringify([]),
    id,
  );
  return id;
}

/** A level 15 Devotion paladin: the smite, the aura and Smite of Protection, set straight on the row. */
function makePaladin(): number {
  const id = createCompanion(db, {
    campaign_id: campaignId,
    name: 'Dain',
    source: { class: 'Paladin', species: 'Human', background: 'Soldier' },
  }).companion!.id;
  db.prepare('UPDATE character SET level = 15, features_json = ?, spells_json = ?, spell_slots_json = ?, inventory_json = ? WHERE id = ?').run(
    JSON.stringify([{ name: "Paladin's Smite" }, { name: 'Aura of Protection' }, { name: 'Smite of Protection' }]),
    JSON.stringify({ cantrips: [], known: [], prepared: [], save_dc: 14, attack_bonus: 6 }),
    JSON.stringify({ '1': { max: 4, used: 0 } }),
    JSON.stringify([{ name: 'Longsword', qty: 1, equipped: true }]),
    id,
  );
  return id;
}

async function ambush(enemies = 1): Promise<BattleState> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: enemies }],
  });
  const state = getBattleState(db, campaignId)!;
  const rows = Array.from({ length: 14 }, () => '.'.repeat(60));
  const map: BattleMap = { w: 60, h: 14, rows, features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
  db.prepare("UPDATE combatant SET hp_max = 400, hp_current = 400 WHERE team = 'enemy'").run();
  return getBattleState(db, campaignId)!;
}

/** The open map with the listed cells turned into blocked pillars or walls. */
function mapWith(blocked: Array<[number, number]>): void {
  const rows = Array.from({ length: 14 }, () => Array.from({ length: 60 }, () => '.'));
  for (const [x, y] of blocked) rows[y]![x] = '#';
  const map: BattleMap = { w: 60, h: 14, rows: rows.map((row) => row.join('')), features: [] };
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), state.encounter.id);
}

const ids = (): { pc: number; zel: number; enemy: number[] } => {
  const combatants = listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
  return {
    pc: combatants.find((c) => c.kind === 'pc')!.id,
    zel: combatants.find((c) => c.name === 'Zel')!.id,
    enemy: combatants.filter((c) => c.team === 'enemy').map((c) => c.id),
  };
};

const pcId = (): number => listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.kind === 'pc')!.id;

const enemyIds = (): number[] =>
  listCombatants(db, getBattleState(db, campaignId)!.encounter.id)
    .filter((c) => c.team === 'enemy')
    .map((c) => c.id);

const place = (id: number, x: number, y: number): void => {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, id);
};

const startTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare(
    'UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?',
  ).run(id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === id),
    state.encounter.id,
  );
};

/** Rolls the fight forward with the real advance_turn until it is this combatant's turn. */
const turnOf = async (id: number): Promise<void> => {
  for (let step = 0; step < 30; step += 1) {
    const state = getBattleState(db, campaignId)!;
    if (state.combatants[state.encounter.turn_index]?.id === id) return;
    await advanceTurn(db, campaignId);
  }
  throw new Error(`The fight never came round to combatant ${id}.`);
};

const byId = (id: number) => listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === id)!;

interface SaveView {
  target_id: number;
  save: { ability: string; bonus: number; success: boolean } | null;
}

const savesOf = (result: unknown): Map<number, SaveView['save']> =>
  new Map(
    (result as { targets: SaveView[] }).targets.map((entry) => [entry.target_id, entry.save]),
  );

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = makeCampaign(db);
  Math.random = () => MID_D20;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('cover and spells (audit P3c)', () => {
  it('refuses a single-target save spell against a creature in Total Cover, and spends nothing', async () => {
    const zel = makeWizard();
    await ambush();
    const { enemy } = ids();
    // A wall from top to bottom: every line from the caster to the goblin is blocked, so cover is total.
    mapWith(Array.from({ length: 14 }, (_, y) => [5, y] as [number, number]));
    place(zel, 1, 5);
    place(enemy[0]!, 10, 5);
    startTurn(zel);

    await expect(
      useAction(db, {
        campaign_id: campaignId,
        actor_id: zel,
        action_name: 'Hold Person',
        spell: 'Hold Person',
        target_id: enemy[0]!,
      }),
    ).rejects.toThrow(/total cover/);

    // A refused casting costs nothing.
    const slots = db.prepare('SELECT spell_slots_json FROM character WHERE id = ?').get(zel) as {
      spell_slots_json: string;
    };
    expect(JSON.parse(slots.spell_slots_json)['2']).toEqual({ max: 3, used: 0 });
  });

  it('measures area cover from the point of origin, not from the caster', async () => {
    const zel = makeWizard();
    await ambush(3);
    const { pc, enemy } = ids();
    // The pillar at x=18 shields G1 from the burst at (20,5); the wall at x=10 shields G2 from the
    // caster at (1,5) but not from the burst. G3 stands open to both and is the reference.
    mapWith([
      [18, 5],
      [10, 6],
    ]);
    place(pc, 55, 13);
    place(zel, 1, 5);
    place(enemy[0]!, 17, 5);
    place(enemy[1]!, 21, 8);
    place(enemy[2]!, 20, 2);
    startTurn(zel);

    const cast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: zel,
      action_name: 'Fireball',
      spell: 'Fireball',
      point: { x: 20, y: 5 },
    });

    const saves = savesOf(cast);
    const shieldFromBurst = saves.get(enemy[0]!)!;
    const shieldFromCaster = saves.get(enemy[1]!)!;
    const open = saves.get(enemy[2]!)!;
    // Same creature for all three: any difference on the DEX save is the cover each one is owed.
    expect(shieldFromBurst.bonus - open.bonus).toBeGreaterThanOrEqual(2);
    expect(shieldFromCaster.bonus - open.bonus).toBe(0);
  });

  it("lends Half Cover to a Dexterity save and lapses at the start of the paladin's next turn (Smite of Protection)", async () => {
    const paladin = makePaladin();
    await ambush();
    const pc = pcId();
    const enemy = enemyIds();
    place(pc, 55, 13);
    place(paladin, 3, 5);
    place(enemy[0]!, 4, 5);

    const blastAt = async (): Promise<number> => {
      const blast = await useAction(db, {
        campaign_id: campaignId,
        actor_id: enemy[0]!,
        action_name: 'Necrotic Blast',
        target_id: paladin,
        save_ability: 'dex',
        save_dc: 15,
      });
      return savesOf(blast).get(paladin)!.bonus;
    };

    // Before the smite: no aura, so this is the plain Dexterity save bonus.
    await turnOf(enemy[0]!);
    const plain = await blastAt();

    // The paladin hits, then smites: the aura lends Half Cover until the start of their next turn.
    await turnOf(paladin);
    await attack(db, {
      campaign_id: campaignId,
      attacker_id: paladin,
      target_id: enemy[0]!,
      action_name: 'Longsword',
      roll: { total: 40, natural: 12 },
    });
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: paladin,
      action_name: 'Divine Smite',
      spell: 'Divine Smite',
      slot_level: 1,
      target_id: enemy[0]!,
    });
    expect(byId(paladin).flags.smite_protection).toEqual({ rounds_left: 1 });

    // Through the goblin's own turn the aura still shelters, and the save is +2.
    await turnOf(enemy[0]!);
    expect(byId(paladin).flags.smite_protection).toBeDefined();
    expect(await blastAt()).toBe(plain + 2);

    // Start of the paladin's next turn: the window closes.
    await turnOf(paladin);
    expect(byId(paladin).flags.smite_protection).toBeUndefined();
  });
});
