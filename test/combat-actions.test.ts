import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, createCompanion } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';
import { advanceTurn, attack, moveToken, startEncounter, useAction } from '../src/combat/engine.js';
import { legalActions } from '../src/combat/actions.js';
import { planMove } from '../src/combat/grid.js';
import { combatSheet } from '../src/combat/sheet.js';
import { getBattleState, listCombatants, type BattleState } from '../src/combat/state.js';
import type { BattleMap } from '../src/combat/map.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const MID_D20 = 0.5;
const HIGH_D20 = 0.6; // 18 on a d20

function makeCampaign(database: Db): number {
  const id = createCampaign(database, { name: 'Actions', story_shape: 'sandbox', settings: { player_rolls: 'none' } })
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

async function ambush(enemies = 1): Promise<BattleState> {
  await startEncounter(db, {
    campaign_id: campaignId,
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior', count: enemies }],
  });
  return getBattleState(db, campaignId)!;
}

const ids = (): { pc: number; enemy: number[] } => {
  const combatants = listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
  return {
    pc: combatants.find((c) => c.kind === 'pc')!.id,
    enemy: combatants.filter((c) => c.team === 'enemy').map((c) => c.id),
  };
};

const place = (id: number, x: number, y: number): void => {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, id);
};

const giveTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  const index = state.combatants.findIndex((c) => c.id === id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(index, state.encounter.id);
};

/** A fresh turn for one combatant: the turn is theirs and the action economy is full again. */
const startTurn = (id: number): void => {
  db.prepare(
    'UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?',
  ).run(id);
  giveTurn(id);
};

const combatantOf = (id: number): BattleState['combatants'][number] =>
  getBattleState(db, campaignId)!.combatants.find((c) => c.id === id)!;

/** Replaces the generated map with a hand-built one, so the geometry under test is exactly known. */
function setMap(map: BattleMap): void {
  const encounterId = getBattleState(db, campaignId)!.encounter.id;
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), encounterId);
}

const plainMap = (rows: string[]): BattleMap => ({ w: rows[0]!.length, h: rows.length, rows, features: [] });

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = makeCampaign(db);
  Math.random = () => MID_D20;
});

afterEach(() => {
  Math.random = realRandom;
});

describe('the standard actions', () => {
  it('adds the speed again on a Dash and clears the flag next turn', async () => {
    await ambush();
    const { pc } = ids();
    giveTurn(pc);
    const dashed = (await useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'dash' })) as unknown as {
      movement_left: number;
    };
    expect(dashed.movement_left).toBe(60);
    expect(combatantOf(pc).flags.dashed).toBe(true);
    expect(combatantOf(pc).action_used).toBe(true);

    await advanceTurn(db, campaignId);
    await advanceTurn(db, campaignId);
    expect(combatantOf(pc).flags.dashed).toBeUndefined();
    expect(combatantOf(pc).movement_left).toBe(30);
  });

  it('drops the opportunity attack warning after a Disengage', async () => {
    await ambush();
    const { pc, enemy } = ids();
    setMap(plainMap(Array.from({ length: 10 }, () => '.'.repeat(14))));
    place(pc, 5, 5);
    place(enemy[0]!, 6, 5);
    giveTurn(pc);

    await useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'disengage' });
    const moved = moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 1, y: 5 } });
    expect(moved.opportunity_attack_warning).toEqual([]);
    expect(moved.log[0]!.text).toContain('Disengaged');
  });

  it('gives attacks against a dodging target disadvantage and its DEX saves advantage', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    giveTurn(pc);
    await useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'dodge' });
    expect(combatantOf(pc).flags.dodging).toBe(true);

    startTurn(enemy[0]!);
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: enemy[0]!,
      target_id: pc,
      action_name: 'Scimitar',
      roll: { total: 5, natural: 5 },
    });
    expect(swing.advantage).toBe('disadvantage');
    expect(swing.notes.join()).toContain('is dodging');

    const blast = await useAction(db, {
      campaign_id: campaignId,
      actor_id: enemy[0]!,
      action_name: 'Firebomb',
      target_id: pc,
      save_ability: 'dex',
      save_dc: 10,
      out_of_turn: true,
      reason: 'a lit flask arcs over',
    });
    const first = blast.targets[0] as { save: { advantage: string } };
    expect(first.save.advantage).toBe('advantage');
  });

  it('lends an ally advantage with Help and spends it on their next attack', async () => {
    createCompanion(db, { campaign_id: campaignId, name: 'Fang', source: { creature: 'Wolf' } });
    const state = await ambush();
    const { pc, enemy } = ids();
    const ally = state.combatants.find((c) => c.name === 'Fang')!.id;
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    place(ally, 1, 6);
    giveTurn(pc);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'help',
      target_id: ally,
      ally_target_id: enemy[0]!,
    });
    expect(combatantOf(ally).flags.helped_by).toMatchObject({ id: pc, name: 'Borg', against_id: enemy[0] });

    startTurn(ally);
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: ally,
      target_id: enemy[0]!,
      action_name: 'Bite',
      roll: { total: 5, natural: 5 },
    });
    expect(swing.notes.join()).toContain('helping');
    expect(combatantOf(ally).flags.helped_by).toBeUndefined();
  });

  it('refuses to Help with an attack on somebody out of reach', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 9, 5);
    giveTurn(pc);
    await expect(
      useAction(db, {
        campaign_id: campaignId,
        actor_id: pc,
        action_name: 'help',
        target_id: enemy[0]!,
        ally_target_id: enemy[0]!,
      }),
    ).rejects.toThrow(/within 5 ft/);
  });

  it('hides behind cover with a Stealth check and gives the hider away when they attack', async () => {
    await ambush();
    const { pc, enemy } = ids();
    // Three-quarters cover from the goblin: half is not enough to hide behind.
    setMap(
      plainMap([
        '..............',
        '..............',
        '..##..........',
        '..............',
        '..............',
        '..............',
      ]),
    );
    place(pc, 2, 1);
    place(enemy[0]!, 5, 4);
    giveTurn(pc);
    Math.random = () => HIGH_D20;

    const hidden = (await useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'hide' })) as unknown as {
      hidden: boolean;
      dc: number;
    };
    expect(hidden.dc).toBe(15);
    expect(hidden.hidden).toBe(true);
    expect(combatantOf(pc).conditions).toContain('invisible');
    expect(combatantOf(pc).flags.hidden).toBe(true);

    startTurn(pc);
    place(enemy[0]!, 3, 1);
    const swing = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
      roll: { total: 25, natural: 12 },
    });
    expect(swing.log.some((entry) => entry.kind === 'hide_end')).toBe(true);
    expect(combatantOf(pc).conditions).not.toContain('invisible');
  });

  it('refuses to hide in the open', async () => {
    await ambush();
    const { pc, enemy } = ids();
    setMap(plainMap(Array.from({ length: 8 }, () => '.'.repeat(14))));
    place(pc, 5, 5);
    place(enemy[0]!, 7, 5);
    giveTurn(pc);
    await expect(useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'hide' })).rejects.toThrow(
      /plain sight/,
    );
  });

  it('holds a readied action and releases it out of turn as a reaction', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    giveTurn(pc);
    await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'ready',
      trigger: 'the goblin steps into the doorway',
      readied_action: 'Unarmed Strike',
    });
    expect(combatantOf(pc).flags.ready).toEqual({
      trigger: 'the goblin steps into the doorway',
      action: 'Unarmed Strike',
    });

    giveTurn(enemy[0]!);
    const released = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
      roll: { total: 25, natural: 12 },
      out_of_turn: true,
      reason: 'the readied strike, as the goblin steps in',
    });
    expect(released.log.some((entry) => entry.kind === 'ready_release')).toBe(true);
    expect(combatantOf(pc).flags.ready).toBeUndefined();
    expect(combatantOf(pc).reaction_used).toBe(true);
  });

  it('spends the action on Utilize and refuses a second one', async () => {
    await ambush();
    const { pc } = ids();
    giveTurn(pc);
    const used = (await useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'utilize' })) as unknown as {
      utilized: boolean;
    };
    expect(used.utilized).toBe(true);
    await expect(useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'dodge' })).rejects.toThrow(
      /already taken their Action/,
    );
  });
});

describe('spellcasting actions', () => {
  it('collapses a spell repeated on a legacy sheet into a single cast action', async () => {
    const cleric = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Sella',
      source: { class: 'Cleric', species: 'Human', background: 'Acolyte' },
    }).companion!.id;
    // Simulates a sheet written before duplicate validation existed.
    db.prepare('UPDATE character SET spells_json = ?, spell_slots_json = ? WHERE id = ?').run(
      JSON.stringify({
        spellcasting_ability: 'wis',
        cantrips: [],
        known: ['Detect Magic', 'Detect Magic'],
        prepared: ['Detect Magic', 'Detect Magic', 'Disguise Self', 'Disguise Self'],
        save_dc: 13,
        attack_bonus: 5,
      }),
      JSON.stringify({ '1': { max: 2, used: 0 } }),
      cleric,
    );
    const state = await ambush();
    const sella = listCombatants(db, state.encounter.id).find((c) => c.character_id === cleric)!;
    const actions = legalActions(sella, combatSheet(db, cleric));
    const castIds = actions.filter((a) => a.id.startsWith('cast:')).map((a) => a.id);
    expect(new Set(castIds).size).toBe(castIds.length);
    expect(castIds).toEqual(['cast:Detect Magic', 'cast:Disguise Self']);
  });
});

describe('the action economy', () => {
  it('refuses a second attack when Extra Attack does not cover it', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    giveTurn(pc);
    const roll = { total: 25, natural: 12 };
    const first = await attack(db, {
      campaign_id: campaignId,
      attacker_id: pc,
      target_id: enemy[0]!,
      action_name: 'Unarmed Strike',
      roll,
    });
    expect(first.attacks_used).toBe(1);
    expect(first.attacks_per_action).toBe(1);
    await expect(
      attack(db, { campaign_id: campaignId, attacker_id: pc, target_id: enemy[0]!, action_name: 'Unarmed Strike', roll }),
    ).rejects.toThrow(/already taken their Action/);
  });

  it('allows the swings Extra Attack grants and then stops', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    const character = listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === pc)!
      .character_id!;
    const features = JSON.parse(
      (db.prepare('SELECT features_json AS f FROM character WHERE id = ?').get(character) as { f: string }).f,
    ) as Array<Record<string, unknown>>;
    features.push({ name: 'Extra Attack', mechanics: { extra_attacks: 1 } });
    db.prepare('UPDATE character SET features_json = ? WHERE id = ?').run(JSON.stringify(features), character);
    expect(combatSheet(db, character).features.some((f) => f.name === 'Extra Attack')).toBe(true);

    giveTurn(pc);
    const roll = { total: 25, natural: 12 };
    const shot = { campaign_id: campaignId, attacker_id: pc, target_id: enemy[0]!, action_name: 'Unarmed Strike', roll };
    await attack(db, shot);
    const second = await attack(db, shot);
    expect(second.attacks_used).toBe(2);
    await expect(attack(db, shot)).rejects.toThrow(/all 2 attacks/);
  });
});

describe('grapple, shove and escaping', () => {
  it('grapples on a failed save, holds the target at speed 0 and lets it break free', async () => {
    await ambush();
    const { pc, enemy } = ids();
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    giveTurn(pc);

    const grab = (await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'grapple',
      target_id: enemy[0]!,
    })) as unknown as { applied: boolean; dc: number; escape_dc: number };
    expect(grab.dc).toBe(13); // 8 + 3 STR + 2 proficiency
    expect(grab.applied).toBe(true);
    expect(combatantOf(enemy[0]!).conditions).toContain('grappled');
    expect(combatantOf(enemy[0]!).flags.grappled_by).toBe(pc);
    expect(combatantOf(pc).flags.grappling).toEqual([enemy[0]]);
    expect(combatantOf(enemy[0]!).movement_left).toBe(0);

    startTurn(enemy[0]!);
    expect(() => moveToken(db, { campaign_id: campaignId, combatant_id: enemy[0]!, to: { x: 6, y: 5 } })).toThrow(
      /speed 0 while grappled/,
    );
    const actions = legalActions(
      listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === enemy[0])!,
      null,
    );
    expect(actions.map((a) => a.id)).toContain('escape_grapple');

    Math.random = () => HIGH_D20;
    const escape = (await useAction(db, {
      campaign_id: campaignId,
      actor_id: enemy[0]!,
      action_name: 'escape_grapple',
    })) as unknown as { escaped: boolean };
    expect(escape.escaped).toBe(true);
    expect(combatantOf(enemy[0]!).conditions).not.toContain('grappled');
    expect(combatantOf(pc).flags.grappling ?? []).toEqual([]);
  });

  it('gives the grappled creature disadvantage against anyone but its grappler', async () => {
    createCompanion(db, { campaign_id: campaignId, name: 'Fang', source: { creature: 'Wolf' } });
    const state = await ambush();
    const { pc, enemy } = ids();
    const ally = state.combatants.find((c) => c.name === 'Fang')!.id;
    place(pc, 1, 5);
    place(enemy[0]!, 2, 5);
    place(ally, 2, 6);
    giveTurn(pc);
    await useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'grapple', target_id: enemy[0]! });

    startTurn(enemy[0]!);
    const wrongTarget = await attack(db, {
      campaign_id: campaignId,
      attacker_id: enemy[0]!,
      target_id: ally,
      action_name: 'Scimitar',
      roll: { total: 5, natural: 5 },
    });
    expect(wrongTarget.advantage).toBe('disadvantage');
    expect(wrongTarget.notes.join()).toContain('not its grappler');

    startTurn(enemy[0]!);
    const atGrappler = await attack(db, {
      campaign_id: campaignId,
      attacker_id: enemy[0]!,
      target_id: pc,
      action_name: 'Scimitar',
      roll: { total: 5, natural: 5 },
    });
    expect(atGrappler.advantage).toBe('none');
  });

  it('drags the grappled creature along at half speed', async () => {
    await ambush();
    const { pc, enemy } = ids();
    setMap(plainMap(Array.from({ length: 10 }, () => '.'.repeat(14))));
    place(pc, 5, 5);
    place(enemy[0]!, 6, 5);
    giveTurn(pc);
    await useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'grapple', target_id: enemy[0]! });

    startTurn(pc);
    const moved = moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 2, y: 5 } });
    expect(moved.position).toEqual({ x: 2, y: 5 });
    // 30 ft of speed drags at 15 ft, so the walk stops where the budget does.
    expect(moved.cost_ft).toBeLessThanOrEqual(15);
    const dragged = combatantOf(enemy[0]!);
    expect(Math.max(Math.abs(dragged.x - 2), Math.abs(dragged.y - 5))).toBeLessThanOrEqual(1);
  });

  it('shoves a target back 5 ft, or knocks it prone', async () => {
    await ambush();
    const { pc, enemy } = ids();
    setMap(plainMap(Array.from({ length: 10 }, () => '.'.repeat(14))));
    place(pc, 5, 5);
    place(enemy[0]!, 6, 5);
    giveTurn(pc);
    const shoved = (await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'shove',
      target_id: enemy[0]!,
    })) as unknown as { pushed_ft: number };
    expect(shoved.pushed_ft).toBe(5);
    expect(combatantOf(enemy[0]!).x).toBe(7);

    startTurn(pc);
    place(enemy[0]!, 6, 5);
    const floored = (await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'shove',
      target_id: enemy[0]!,
      shove_prone: true,
    })) as unknown as { prone: boolean };
    expect(floored.prone).toBe(true);
    expect(combatantOf(enemy[0]!).conditions).toContain('prone');
  });

  it('refuses to grapple something two sizes larger and honours a DM ruling on a shove', async () => {
    await ambush();
    const { pc, enemy } = ids();
    setMap(plainMap(Array.from({ length: 10 }, () => '.'.repeat(14))));
    place(pc, 5, 5);
    place(enemy[0]!, 6, 5);
    db.prepare("UPDATE combatant SET size = 'H' WHERE id = ?").run(enemy[0]!);
    giveTurn(pc);
    await expect(
      useAction(db, { campaign_id: campaignId, actor_id: pc, action_name: 'grapple', target_id: enemy[0]! }),
    ).rejects.toThrow(/more than one size larger/);

    db.prepare("UPDATE combatant SET size = 'S' WHERE id = ?").run(enemy[0]!);
    const shoved = (await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'shove',
      target_id: enemy[0]!,
      ruling: { reason: 'the goblin was charging and Borg used its own momentum', push_ft: 15, advantage: true },
    })) as unknown as { pushed_ft: number; save: { advantage: string }; ruling: string };
    expect(shoved.pushed_ft).toBe(15);
    expect(shoved.save.advantage).toBe('disadvantage');
    expect(shoved.ruling).toContain('momentum');
  });
});

describe('improvised moves and the search budget', () => {
  it('lets a ruling carry the mover through an occupied cell but not onto it', async () => {
    await ambush(2);
    const { pc, enemy } = ids();
    setMap(
      plainMap([
        '##############',
        '..............',
        '##############',
      ]),
    );
    place(pc, 1, 1);
    place(enemy[0]!, 3, 1);
    place(enemy[1]!, 12, 1);
    giveTurn(pc);

    // Without the ruling the goblin is a wall: the walk stops in front of it.
    const stopped = moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 5, y: 1 } });
    expect(stopped.position).toEqual({ x: 2, y: 1 });
    expect(stopped.reached_target).toBe(false);

    startTurn(pc);
    place(pc, 1, 1);
    const slid = moveToken(db, {
      campaign_id: campaignId,
      combatant_id: pc,
      to: { x: 5, y: 1 },
      ruling: { reason: 'Borg wins a DC 15 Acrobatics check to slide under the goblin' },
    });
    expect(slid.position).toEqual({ x: 5, y: 1 });
    expect(slid.log[0]!.text).toContain('DM ruling: Borg wins a DC 15 Acrobatics check');
    expect(combatantOf(enemy[0]!).x).toBe(3); // the goblin it slid under has not moved

    // Ending the move on somebody is still out: the walk stops in the last free cell.
    startTurn(pc);
    const blocked = moveToken(db, {
      campaign_id: campaignId,
      combatant_id: pc,
      to: { x: 12, y: 1 },
      ruling: { reason: 'and again, past the second one' },
    });
    expect(blocked.position).not.toEqual({ x: 12, y: 1 });
  });

  it('says the path search ran out of budget instead of calling it unreachable', async () => {
    await ambush();
    const { pc } = ids();
    const rows = Array.from({ length: 70 }, () => '.'.repeat(70));
    // A sealed chamber: the goal cannot be entered, and finding that out costs more than the budget.
    rows[34] = `${'.'.repeat(33)}###${'.'.repeat(34)}`;
    rows[35] = `${'.'.repeat(33)}#.#${'.'.repeat(34)}`;
    rows[36] = `${'.'.repeat(33)}###${'.'.repeat(34)}`;
    const map = plainMap(rows);
    setMap(map);
    place(pc, 1, 1);

    const mover = listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === pc)!;
    const plan = planMove(map, [mover], mover, { x: 34, y: 35 }, 1000);
    expect(plan.reached).toBe(false);
    expect(plan.budget_exhausted).toBe(true);

    giveTurn(pc);
    const moved = moveToken(db, { campaign_id: campaignId, combatant_id: pc, to: { x: 34, y: 35 } }) as unknown as {
      search_note?: string;
    };
    expect(moved.search_note).toContain('nearer waypoint');
  });
});
