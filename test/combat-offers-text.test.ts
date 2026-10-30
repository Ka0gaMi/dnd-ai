// A DM that reads only the reply text still learns what the engine offers beside state and log: each
// offer lands in an "Offers:" block with the ids its next call needs, driven here through real tool calls.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import {
  awardXp,
  createCharacter,
  createCompanion,
  grantFeature,
  levelUp,
  levelUpOptions,
  spendFeatureResource,
  type CreateCharacterInput,
  type LevelUpChoices,
} from '../src/core/character.js';
import { clausesSchema, type ClauseInput } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import { XP_THRESHOLDS, type Ability } from '../src/core/rules.js';
import type { BattleMap } from '../src/combat/map.js';
import { getBattleState, listCombatants, type Combatant } from '../src/combat/state.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { classLevelRow, findClass, findSpecies, skillChoiceGroups, spellsForClass } from '../src/srd/lookup.js';
import { replyText } from './helpers/reply.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;
const HIT = { total: 30, natural: 12 };
const MISS = { total: 2, natural: 2 };
const ABILITIES = { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 };

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Offers', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
  Math.random = () => 0.5;
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

/** Calls a tool and keeps only its text, the one channel the DM reads; no reply carries structuredContent. */
async function say(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: { campaign_id: campaignId, ...args } });
  const text = replyText(result);
  if (result.isError) throw new Error(text);
  expect('structuredContent' in result).toBe(false);
  return text;
}

/** The "- " lines under the reply's "Offers:" heading; empty when the reply has none. */
function offersOf(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf('Offers:');
  if (start < 0) return [];
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('- ')) break;
    block.push(line);
  }
  return block;
}

// --- building a character -----------------------------------------------------

function skillPicks(cls: string): string[] {
  const picks: string[] = [];
  for (const group of skillChoiceGroups(findClass(cls), findSpecies('Human'))) {
    let taken = 0;
    for (const option of group.from) {
      if (taken >= group.choose) break;
      if (picks.includes(option)) continue;
      picks.push(option);
      taken += 1;
    }
  }
  return picks;
}

function make(cls: string, name: string): number {
  const data = findClass(cls);
  const casting = data.spellcasting ? classLevelRow(data.index, 1).spellcasting : undefined;
  return createCharacter(db, {
    campaign_id: campaignId,
    name,
    class: cls,
    species: 'Human',
    background: 'Soldier',
    ability_method: 'manual',
    abilities: ABILITIES,
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: skillPicks(cls),
    cantrips: spellsForClass(data.index, 0).slice(0, casting?.cantrips_known ?? 0),
    spells: spellsForClass(data.index, 1).slice(0, casting?.prepared_spells ?? 0),
  } as CreateCharacterInput).character!.id;
}

/** Levels a martial character up, taking the first legal answer to everything each level asks. */
function climbTo(characterId: number, level: number, subclass: string): void {
  awardXp(db, { campaign_id: campaignId, character_id: characterId, amount: XP_THRESHOLDS[level - 1]! });
  while ((getCharacterSheet(db, campaignId, characterId)!.level as number) < level) {
    const options = levelUpOptions(db, campaignId, characterId) as {
      subclass_choice?: unknown;
      ability_score_improvement?: unknown;
      feature_choices?: Array<{ feature: string; choose: number; from: string[] }>;
    };
    const choices: LevelUpChoices = { hp: 'average' };
    if (options.subclass_choice) choices.subclass = subclass;
    if (options.ability_score_improvement) {
      const abilities = getCharacterSheet(db, campaignId, characterId)!.abilities as Record<Ability, { score: number }>;
      const low = (Object.keys(abilities) as Ability[])
        .filter((a) => abilities[a].score < 20)
        .sort((a, b) => abilities[a].score - abilities[b].score);
      choices.ability_increases = { [low[0]!]: 1, [low[1]!]: 1 };
    }
    if (options.feature_choices) {
      choices.feature_options = Object.fromEntries(
        options.feature_choices.map((spec) => [spec.feature, spec.from.slice(0, spec.choose)]),
      );
    }
    levelUp(db, { campaign_id: campaignId, character_id: characterId, choices });
  }
}

const arm = (id: number, ...items: string[]): void => {
  db.prepare('UPDATE character SET inventory_json = ? WHERE id = ?').run(
    JSON.stringify(items.map((name) => ({ name, qty: 1, equipped: true }))),
    id,
  );
};

/** A Warrior of the Open Hand at level 3, out of armour: Deflect Attacks and Flurry of Blows. */
function monk(): number {
  const id = make('monk', 'Monk');
  climbTo(id, 3, 'Warrior of the Open Hand');
  arm(id);
  return id;
}

/** Writes the homebrew row and puts the feature it stands for on the sheet; returns the homebrew id. */
function grant(characterId: number, name: string, clauses: ClauseInput[]): number {
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
  return entry.id;
}

// --- the battlefield ----------------------------------------------------------

/** Opens a fight over MCP against one goblin, then flattens the map and lines everyone up in reach. */
async function fight(client: Client): Promise<string> {
  const started = await say(client, 'start_encounter', {
    seed: 7,
    terrain: 'road',
    size: 'small',
    enemies: [{ creature: 'Goblin Warrior' }],
  });
  setMap(Array.from({ length: 14 }, () => '.'.repeat(60)));
  let x = 3;
  for (const c of combatants()) place(c.id, x++, 5);
  db.prepare("UPDATE combatant SET hp_max = 200, hp_current = 200 WHERE team = 'enemy'").run();
  return started;
}

function setMap(rows: string[]): void {
  const map: BattleMap = { w: rows[0]!.length, h: rows.length, rows, features: [] };
  db.prepare('UPDATE encounter SET map_json = ? WHERE id = ?').run(JSON.stringify(map), getBattleState(db, campaignId)!.encounter.id);
}

const place = (id: number, x: number, y: number): void => {
  db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(x, y, id);
};

const combatants = (): Combatant[] => listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
const pc = (): Combatant => combatants().find((c) => c.kind === 'pc')!;
const foe = (): Combatant => combatants().find((c) => c.team === 'enemy')!;

/** Hands the combatant the turn with its action economy full. */
const startTurn = (id: number): void => {
  const state = getBattleState(db, campaignId)!;
  db.prepare('UPDATE combatant SET action_used = 0, bonus_used = 0, reaction_used = 0, movement_left = speed WHERE id = ?').run(id);
  db.prepare('UPDATE encounter SET turn_index = ? WHERE id = ?').run(
    state.combatants.findIndex((c) => c.id === id),
    state.encounter.id,
  );
};

describe('the Offers block in a combat reply', () => {
  it('offers Deflect Attacks to the one a hit landed on (reactions_available)', async () => {
    monk();
    const client = await connect();
    await fight(client);
    const text = await say(client, 'attack', {
      attacker_id: foe().id,
      target_id: pc().id,
      action_name: 'Scimitar',
      roll: HIT,
      out_of_turn: true,
      reason: 'the goblin swings',
    });
    expect(offersOf(text)).toContain(
      '- Deflect Attacks: Monk may spend its reaction to take 1d10 + 2 + 3 off the next such hit: use_action {action_name: "deflect_attacks"} before that attack.',
    );
    // The actor_id that use_action needs is on the Monk's touched line.
    expect(text).toContain(`Monk #${pc().id}: `);
    await client.close();
  });

  it('offers the deflected blow back with the attacker id (deflect_redirect_available)', async () => {
    monk();
    const client = await connect();
    await fight(client);
    startTurn(pc().id);
    await say(client, 'use_action', { actor_id: pc().id, action_name: 'deflect_attacks' });
    const text = await say(client, 'attack', {
      attacker_id: foe().id,
      target_id: pc().id,
      action_name: 'Scimitar',
      roll: HIT,
      out_of_turn: true,
      reason: 'the goblin swings into a deflection',
    });
    expect(offersOf(text)).toContain(
      `- Deflect redirect (attacker #${foe().id}, within 5 ft): Monk took the blow to 0 and may spend 1 Focus Point to throw the force back: use_action {action_name: "deflect_redirect", target_id, out_of_turn: true, reason: "Deflect Attacks"} before the next turn.`,
    );
    await client.close();
  });

  it('lists a homebrew boost by the id the next call takes, with what it does and its uses left (boosts_available)', async () => {
    const id = make('fighter', 'Borg');
    arm(id, 'Longsword');
    const homebrew = grant(id, "Hunter's Certainty", [
      { when: 'roll', if: { kind: 'attack' }, do: [{ kind: 'advantage' }], uses: { per: 'long', count: 1 }, decide: 'ask_before' },
    ]);
    const client = await connect();
    await fight(client);
    startTurn(pc().id);
    const text = await say(client, 'attack', {
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: HIT,
    });
    expect(offersOf(text)).toContain(
      `- Boosts, by id in boosts: homebrew:${homebrew}:0 (Hunter's Certainty: Advantage when you roll an attack roll, 1 per long rest, 1 use left).`,
    );
    await client.close();
  });

  it('reminds a missed swing of the Bardic Inspiration die it holds (bardic_inspiration_available)', async () => {
    make('bard', 'Bard');
    const squire = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Squire',
      source: { class: 'Fighter', species: 'Human', background: 'Soldier' },
    }).companion!.id;
    arm(squire, 'Longsword');
    const client = await connect();
    await fight(client);
    const ally = combatants().find((c) => c.character_id === squire)!;
    startTurn(pc().id);
    await say(client, 'use_action', { actor_id: pc().id, action_name: 'bardic_inspiration', target_id: ally.id });
    startTurn(ally.id);
    const text = await say(client, 'attack', {
      attacker_id: ally.id,
      target_id: foe().id,
      action_name: 'Longsword',
      roll: MISS,
    });
    expect(offersOf(text)).toContain(
      '- Squire is holding a d6 of Bardic Inspiration: pass inspiration true on the next attack and it is added when the swing would otherwise miss.',
    );
    await client.close();
  });

  it('offers Persistent Rage in the start_encounter reply, before the turn-loop pointer (persistent_rage_available)', async () => {
    const id = make('barbarian', 'Barbarian');
    climbTo(id, 15, 'Path of the Berserker');
    arm(id, 'Greataxe');
    spendFeatureResource(db, { campaign_id: campaignId, character_id: id, resource: 'rage', amount: 3 });
    const client = await connect();
    const text = await fight(client);
    expect(offersOf(text)).toEqual([
      `- Persistent Rage: use_action {actor_id: ${pc().id}, action_name: "persistent_rage_regain"} takes back all 3 expended uses of Rage, free of any action, until the end of Barbarian's first turn of this fight.`,
    ]);
    expect(text.trimEnd().split('\n').at(-1)).toContain('read_guide {section: "combat", topic: "turn-loop"}');
    await client.close();
  });

  it('lists every Initiative reminder in the start_encounter reply, past the battle text log tail (reminders)', async () => {
    const id = make('fighter', 'Borg');
    for (let i = 1; i <= 5; i += 1) {
      grant(id, `Omen ${i}`, [{ when: 'initiative', decide: 'ask_after', do: [{ kind: 'note', text: `Omen number ${i} may swap places.` }] }]);
    }
    const client = await connect();
    const text = await fight(client);
    for (let i = 1; i <= 5; i += 1) expect(text).toContain(`Omen number ${i} may swap places.`);
    expect(offersOf(text).some((line) => line.startsWith('- Reminder: ') && line.includes('Omen number 1 '))).toBe(true);
    await client.close();
  });

  it('names who a paused move waits on and where it was headed, and drops the block once waived (paused_for_reactions)', async () => {
    const id = make('fighter', 'Borg');
    arm(id, 'Longsword');
    const client = await connect();
    await fight(client);
    place(pc().id, 4, 5);
    place(foe().id, 5, 5);
    startTurn(pc().id);
    const text = await say(client, 'move_token', { combatant_id: pc().id, to: { x: 1, y: 5 } });
    expect(offersOf(text)).toEqual([
      `- Move paused for reactions from #${foe().id} Goblin Warrior; remaining target (1,5).`,
      '- Goblin Warrior may take an opportunity attack against Borg as they leave its reach; resolve it with attack {out_of_turn: true, reason: ...} or pass waive_reactions to move_token to let it go, then call move_token again to continue.',
    ]);
    // The block follows the log, so the turn brief still closes the reply.
    expect(text.trimEnd().split('\n').at(-1)).toMatch(/^(Foes within|No foe within)/);

    const waived = await say(client, 'move_token', { combatant_id: pc().id, to: { x: 1, y: 5 }, waive_reactions: true });
    expect(waived).not.toContain('Offers:');
    await client.close();
  });

  it('passes the path search note on when the search ran out of budget (search_note)', async () => {
    make('fighter', 'Borg');
    const client = await connect();
    await fight(client);
    // A sealed chamber on a big map: finding out it cannot be entered costs more than the search budget.
    const rows = Array.from({ length: 70 }, () => '.'.repeat(70));
    rows[34] = `${'.'.repeat(33)}###${'.'.repeat(34)}`;
    rows[35] = `${'.'.repeat(33)}#.#${'.'.repeat(34)}`;
    rows[36] = `${'.'.repeat(33)}###${'.'.repeat(34)}`;
    setMap(rows);
    place(pc().id, 1, 1);
    place(foe().id, 68, 68);
    startTurn(pc().id);
    const text = await say(client, 'move_token', { combatant_id: pc().id, to: { x: 34, y: 35 } });
    expect(offersOf(text)).toContain(
      '- The path search ran out of budget before finding the way there; move to a nearer waypoint and go on from it.',
    );
    await client.close();
  });

  it('counts the Flurry of Blows strikes still owed (flurry_strikes_left)', async () => {
    monk();
    const client = await connect();
    await fight(client);
    startTurn(pc().id);
    await say(client, 'use_action', { actor_id: pc().id, action_name: 'flurry_of_blows' });
    const text = await say(client, 'attack', {
      attacker_id: pc().id,
      target_id: foe().id,
      action_name: 'Unarmed Strike',
      roll: HIT,
      flurry: true,
    });
    expect(offersOf(text)).toContain('- Flurry of Blows: 1 Unarmed Strike left, each with attack {flurry: true}.');
    await client.close();
  });
});
