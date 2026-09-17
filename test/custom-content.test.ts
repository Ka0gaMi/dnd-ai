import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus } from '../src/core/bus.js';
import { createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import { awardXp, createCharacter, levelUp, levelUpOptions } from '../src/core/character.js';
import { resolveDecision, type PendingDecisionRow } from '../src/core/decisions.js';
import {
  listLibrary,
  spellBudget,
  spellReport,
  subclassReport,
  validateSpell,
  validateSubclass,
  withOptionDetails,
  type OptionDetail,
  type PowerReport,
} from '../src/core/progression.js';
import { updateSettings } from '../src/core/settings.js';
import { startEncounter, useAction } from '../src/combat/engine.js';
import { getBattleState, listCombatants } from '../src/combat/state.js';
import { registerProgressionTools } from '../src/mcp/tools/progression.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

/** The barbarian these tests level up; the SRD gives Path of the Berserker at 3, 6, 10 and 14. */
function barbarian(): number {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Vex',
    species: 'Human',
    class: 'Barbarian',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'survival', 'intimidation'],
  }).character!.id;
}

function wizard(): number {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Zel',
    species: 'Human',
    class: 'Wizard',
    background: 'Sage',
    ability_method: 'standard_array',
    abilities: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
    ability_bonuses: { int: 2, con: 1 },
    skill_choices: ['arcana', 'history', 'investigation'],
    cantrips: ['Fire Bolt', 'Light', 'Prestidigitation'],
    spells: ['Magic Missile', 'Shield', 'Mage Armor', 'Sleep'],
  }).character!.id;
}

async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerProgressionTools(server, db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result.structuredContent as T;
}

/** Stands in for a player who answers the dialog the moment it appears. */
function answerDecisions(decision: 'accept' | 'reject'): () => void {
  return bus.subscribe((event) => {
    if (event.kind !== 'pending_decision') return;
    resolveDecision(db, (event.payload as PendingDecisionRow).id, { decision });
  });
}

/** A subclass whose level 3 bundle fits and whose level 6 bundle is worth two feats. */
const STORM = {
  class: 'Barbarian',
  name: 'Path of the Storm',
  flavour_text: 'The thunder answers when you roar.',
  features: {
    '3': [
      {
        name: 'Thunderstep',
        text: 'You move like weather.',
        clauses: [{ when: 'always', do: [{ kind: 'speed_ft', amount: 10 }] }],
      },
    ],
    '6': [
      {
        name: 'Stormheart',
        text: 'Lightning rides your axe.',
        clauses: [
          { when: 'roll', if: { kind: 'attack' }, do: [{ kind: 'bonus', to: 'attack', amount: 2 }] },
          { when: 'always', do: [{ kind: 'bonus', to: 'ac', amount: 2 }] },
        ],
      },
    ],
  },
};

/** The same subclass cut down to what the SRD gives at those levels. */
const FAIR_STORM = {
  ...STORM,
  features: {
    '3': [
      {
        name: 'Thunderstep',
        text: 'You move like weather.',
        clauses: [{ when: 'always', do: [{ kind: 'speed_ft', amount: 10 }] }],
      },
    ],
    '6': [
      {
        name: 'Stormheart',
        text: 'Lightning rides your axe.',
        clauses: [
          { when: 'roll', if: { kind: 'attack' }, do: [{ kind: 'bonus', to: 'attack', amount: 1 }] },
          { when: 'always', do: [{ kind: 'bonus', to: 'ac', amount: 1 }] },
        ],
      },
    ],
  },
};

const EMBER_LANCE = {
  name: 'Ember Lance',
  level: 1,
  school: 'evocation',
  casting_time: 'action',
  range: '60 feet',
  components: 'V, S',
  duration: 'instantaneous',
  concentration: false,
  ritual: false,
  classes: ['Wizard'],
  effect: { kind: 'auto', damage: { dice: '2d6', type: 'fire' }, targets: 1 },
  text: 'A lance of embers spears one creature you can see.',
};

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Custom', story_shape: 'sandbox', settings: { player_rolls: 'none' } }).campaign_id;
});

afterEach(() => {
  Math.random = realRandom;
  db.close();
});

describe('the subclass power report', () => {
  it('prices every level bundle against the SRD subclass of that class', () => {
    const report = subclassReport(validateSubclass(STORM));
    expect(report.bundles).toEqual([
      { level: 3, used: 0.5, allowed: 1, verdict: 'within', features: ['Thunderstep'] },
      { level: 6, used: 2, allowed: 1, verdict: 'over_budget', features: ['Stormheart'] },
    ]);
    expect(report.verdict).toBe('over_budget');
    expect(report.text).toContain('Path of the Berserker');
    expect(report.text).toContain('Level 6: 2 of 1');
  });

  it('allows nothing at a level the SRD subclass gives nothing at', () => {
    const report = subclassReport(
      validateSubclass({ ...STORM, features: { '5': [{ name: 'Extra Squall', text: 'More.', mechanics: { ac: 1 } }] } }),
    );
    expect(report.bundles[0]).toMatchObject({ level: 5, allowed: 0, verdict: 'over_budget' });
    expect(report.text).toContain('gives nothing at level 5');
  });

  it('counts a bundle of prose as free and stays within budget', () => {
    const report = subclassReport(
      validateSubclass({ ...STORM, features: { '3': [{ name: 'Stormtongue', text: 'You speak with thunder.' }] } }),
    );
    expect(report.bundles[0]).toMatchObject({ used: 0, allowed: 1, verdict: 'within' });
    expect(report.verdict).toBe('within');
  });
});

describe('the spell power budget', () => {
  it('derives a per-level budget from the bundled SRD spells', () => {
    const area = spellBudget(3, 'aoe');
    expect(area.samples).toBeGreaterThan(0);
    expect(area.max_damage).toBeGreaterThanOrEqual(48);
    const single = spellBudget(1, 'single');
    expect(single.max_damage).toBeLessThan(20);
    expect(single.reference?.name).toBeTruthy();
  });

  it('keeps Fireball within the 3rd-level area budget', () => {
    const report = spellReport(
      validateSpell({
        ...EMBER_LANCE,
        name: 'Cinder Burst',
        level: 3,
        effect: {
          kind: 'save',
          damage: { dice: '8d6', type: 'fire' },
          save_ability: 'dex',
          half_on_save: true,
          shape: { kind: 'sphere', size_ft: 20 },
        },
      }),
    );
    expect(report.verdict).toBe('within');
    expect(report.budget_used).toBe(48);
  });

  it('calls a 2d10 single-target spell at level 1 over budget and says why', () => {
    const report = spellReport(validateSpell({ ...EMBER_LANCE, effect: { kind: 'auto', damage: { dice: '2d10', type: 'fire' } } }));
    expect(report.verdict).toBe('over_budget');
    expect(report.budget_used).toBe(20);
    expect(report.text).toContain('1st-level single-target budget');
  });

  it('prices a spell that only changes the fiction at a flat half a feat', () => {
    const report = spellReport(
      validateSpell({ ...EMBER_LANCE, name: 'Whispering Chalk', effect: { kind: 'utility' } }),
    );
    expect(report).toMatchObject({ budget_used: 0.5, budget_allowed: 1, verdict: 'within' });
  });
});

describe('propose_subclass and rules_mode', () => {
  it('refuses an over-budget subclass in a strict campaign', async () => {
    barbarian();
    updateSettings(db, campaignId, { rules_mode: 'strict' });
    const client = await connect();
    const result = await call<{ status: string; report: PowerReport; message: string }>(client, 'propose_subclass', {
      campaign_id: campaignId,
      schema: STORM,
      justification: 'They fight in every storm they can find.',
    });
    expect(result.status).toBe('refused');
    expect(result.message).toMatch(/strict/);
    expect(listLibrary(db, 'subclass')).toHaveLength(0);
    expect(db.prepare("SELECT count(*) AS n FROM homebrew WHERE kind = 'subclass'").get()).toEqual({ n: 0 });
  });

  it('asks the player in a flexible campaign and stores what they accept', async () => {
    barbarian();
    const stop = answerDecisions('accept');
    const client = await connect();
    const result = await call<{ status: string; decision: { summary: string; homebrew_id: number } }>(
      client,
      'propose_subclass',
      { campaign_id: campaignId, schema: STORM, justification: 'Storms follow them.' },
    );
    stop();
    expect(result.status).toBe('applied');
    expect(result.decision.summary).toContain('Path of the Storm');
    const stored = db.prepare('SELECT kind, power_label FROM homebrew WHERE id = ?').get(result.decision.homebrew_id);
    expect(stored).toEqual({ kind: 'subclass', power_label: 'over_budget' });
  });

  it('drops what the player rejects', async () => {
    barbarian();
    const stop = answerDecisions('reject');
    const client = await connect();
    const result = await call<{ status: string }>(client, 'propose_subclass', {
      campaign_id: campaignId,
      schema: STORM,
      justification: 'Storms follow them.',
    });
    stop();
    expect(result.status).toBe('rejected');
    expect(db.prepare("SELECT count(*) AS n FROM homebrew WHERE kind = 'subclass'").get()).toEqual({ n: 0 });
  });

  it('stores it at once with a warning in a freeform campaign', async () => {
    barbarian();
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const client = await connect();
    const result = await call<{ status: string; warning: string; power_label: string; homebrew_id: number }>(
      client,
      'propose_subclass',
      { campaign_id: campaignId, schema: STORM, justification: 'Storms follow them.' },
    );
    expect(result.status).toBe('applied');
    expect(result.power_label).toBe('over_budget');
    expect(result.warning).toMatch(/over-budget/);
  });

  it('labels a subclass the player asked to be overpowered', async () => {
    barbarian();
    const client = await connect();
    const result = await call<{ status: string; power_label: string }>(client, 'propose_subclass', {
      campaign_id: campaignId,
      schema: STORM,
      justification: 'They asked for it.',
      allow_over_budget: true,
    });
    expect(result.status).toBe('applied');
    expect(result.power_label).toBe('over_budget');
  });
});

describe('propose_spell and rules_mode', () => {
  it('refuses an over-budget spell in a strict campaign', async () => {
    wizard();
    updateSettings(db, campaignId, { rules_mode: 'strict' });
    const client = await connect();
    const result = await call<{ status: string; message: string }>(client, 'propose_spell', {
      campaign_id: campaignId,
      schema: { ...EMBER_LANCE, effect: { kind: 'auto', damage: { dice: '4d10', type: 'fire' } } },
      justification: 'They burned the whole camp down.',
    });
    expect(result.status).toBe('refused');
    expect(result.message).toMatch(/strict/);
  });

  it('asks the player in a flexible campaign and puts what they accept on the sheet', async () => {
    const characterId = wizard();
    const stop = answerDecisions('accept');
    const client = await connect();
    const result = await call<{ status: string; decision: { homebrew_id: number; spell: { added: boolean; where: string } } }>(
      client,
      'propose_spell',
      {
        campaign_id: campaignId,
        character_id: characterId,
        schema: { ...EMBER_LANCE, effect: { kind: 'auto', damage: { dice: '4d10', type: 'fire' } } },
        justification: 'They asked for fire.',
      },
    );
    stop();
    expect(result.status).toBe('applied');
    expect(result.decision.spell).toEqual({ added: true, where: 'prepared' });
    const sheet = getCharacterSheet(db, campaignId, characterId)!;
    expect((sheet.spells as { prepared: string[] }).prepared).toContain('Ember Lance');
  });

  it('stores a cantrip among the cantrips in a freeform campaign', async () => {
    const characterId = wizard();
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const client = await connect();
    const result = await call<{ status: string; spell: { where: string } }>(client, 'propose_spell', {
      campaign_id: campaignId,
      character_id: characterId,
      schema: { ...EMBER_LANCE, name: 'Ember Spark', level: 0, effect: { kind: 'auto', damage: { dice: '1d8', type: 'fire' } } },
      justification: 'A small trick they use constantly.',
    });
    expect(result.status).toBe('applied');
    expect(result.spell.where).toBe('cantrips');
    const sheet = getCharacterSheet(db, campaignId, characterId)!;
    expect((sheet.spells as { cantrips: string[] }).cantrips).toContain('Ember Spark');
  });

  it('lists the homebrew spells on the sheet beside the spell block', async () => {
    const characterId = wizard();
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const client = await connect();
    const result = await call<{ homebrew_id: number }>(client, 'propose_spell', {
      campaign_id: campaignId,
      character_id: characterId,
      schema: EMBER_LANCE,
      justification: 'Their signature.',
    });
    const sheet = getCharacterSheet(db, campaignId, characterId)!;
    expect(sheet.homebrew_spells).toEqual([{ name: 'Ember Lance', level: 1, homebrew_id: result.homebrew_id }]);
  });

  it('keeps subclasses and spells in the personal library', async () => {
    wizard();
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const client = await connect();
    const spell = await call<{ homebrew_id: number }>(client, 'propose_spell', {
      campaign_id: campaignId,
      schema: EMBER_LANCE,
      justification: 'Worth keeping.',
    });
    const subclass = await call<{ homebrew_id: number }>(client, 'propose_subclass', {
      campaign_id: campaignId,
      schema: FAIR_STORM,
      justification: 'Worth keeping.',
    });
    await call(client, 'save_to_library', { homebrew_id: spell.homebrew_id });
    await call(client, 'save_to_library', { homebrew_id: subclass.homebrew_id });
    const library = await call<{ library: Array<{ kind: string; name: string }> }>(client, 'list_library', {});
    expect(library.library.map((entry) => entry.kind).sort()).toEqual(['spell', 'subclass']);
    expect(listLibrary(db, 'spell').map((entry) => entry.name)).toEqual(['Ember Lance']);
  });
});

describe('levelling into a custom subclass', () => {
  /** Stores the subclass without a dialog, the way a freeform campaign does. */
  async function storeStorm(schema: Record<string, unknown> = FAIR_STORM): Promise<number> {
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const client = await connect();
    const result = await call<{ homebrew_id: number }>(client, 'propose_subclass', {
      campaign_id: campaignId,
      schema,
      justification: 'Storms follow them.',
    });
    return result.homebrew_id;
  }

  it('offers the custom subclass beside the SRD one and applies it by id', async () => {
    const characterId = barbarian();
    const homebrewId = await storeStorm();
    awardXp(db, { campaign_id: campaignId, amount: 900 }); // level 3

    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } }); // to 2
    const options = withOptionDetails(
      levelUpOptions(db, campaignId, characterId) as Record<string, unknown>,
      db,
      campaignId,
    );
    const choice = (options.subclass_choice as Array<Record<string, unknown>>).find((s) => s.name === 'Path of the Storm');
    expect(choice).toMatchObject({ homebrew: true, homebrew_id: homebrewId, power_label: 'within' });
    expect((options.subclass_choice as Array<{ name: string }>).some((s) => s.name === 'Path of the Berserker')).toBe(true);
    expect((options.details as Record<string, OptionDetail>)['Path of the Storm']).toMatchObject({
      homebrew: true,
      homebrew_id: homebrewId,
    });

    const levelled = levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', subclass_homebrew_id: homebrewId } });
    expect(levelled.subclass).toBe('Path of the Storm');
    expect(levelled.features_gained).toContain('Thunderstep');
    const row = db.prepare('SELECT subclass, subclass_homebrew_id FROM character WHERE id = ?').get(characterId);
    expect(row).toEqual({ subclass: 'Path of the Storm', subclass_homebrew_id: homebrewId });
  });

  it('gives the later bundles at the levels they are written for', async () => {
    const characterId = barbarian();
    const homebrewId = await storeStorm();
    awardXp(db, { campaign_id: campaignId, amount: 14000 }); // level 6
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', subclass_homebrew_id: homebrewId } });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', ability_increases: { str: 2 } } }); // 4
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } }); // 5

    const names = (): string[] =>
      (getCharacterSheet(db, campaignId, characterId)!.features as Array<{ name: string }>).map((f) => f.name);
    expect(names()).not.toContain('Stormheart');
    expect(levelUpOptions(db, campaignId, characterId)).toMatchObject({
      subclass_features: [{ name: 'Stormheart', homebrew: true }],
    });

    const sixth = levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    expect(sixth.features_gained).toContain('Stormheart');
    const feature = (getCharacterSheet(db, campaignId, characterId)!.features as Array<{
      name: string;
      source: string;
      mechanics?: { homebrew_id?: number };
    }>).find((f) => f.name === 'Stormheart')!;
    expect(feature.source).toBe('subclass');
    expect(feature.mechanics?.homebrew_id).toBe(homebrewId);
  });

  it('refuses a custom subclass written for another class', async () => {
    barbarian();
    const homebrewId = await storeStorm({ ...FAIR_STORM, class: 'Wizard', name: 'Path of the Gale' });
    awardXp(db, { campaign_id: campaignId, amount: 900 });
    levelUp(db, { campaign_id: campaignId, choices: { hp: 'average' } });
    expect(() => levelUp(db, { campaign_id: campaignId, choices: { hp: 'average', subclass_homebrew_id: homebrewId } })).toThrow(
      /Wizard subclass/,
    );
  });
});

describe('custom spells at level-up and in a fight', () => {
  async function storeSpell(schema: Record<string, unknown>, characterId?: number): Promise<number> {
    updateSettings(db, campaignId, { rules_mode: 'freeform' });
    const client = await connect();
    const result = await call<{ homebrew_id: number }>(client, 'propose_spell', {
      campaign_id: campaignId,
      ...(characterId === undefined ? {} : { character_id: characterId }),
      schema,
      justification: 'They earned it.',
    });
    return result.homebrew_id;
  }

  it('offers the custom spell among the level-up spell options with its own details', async () => {
    const characterId = wizard();
    const homebrewId = await storeSpell(EMBER_LANCE);
    awardXp(db, { campaign_id: campaignId, amount: 300 }); // level 2

    const options = withOptionDetails(
      levelUpOptions(db, campaignId, characterId) as Record<string, unknown>,
      db,
      campaignId,
    );
    const spellcasting = options.spellcasting as { spell_options: Record<string, string[]> };
    expect(spellcasting.spell_options['1']).toContain('Ember Lance');
    expect((options.details as Record<string, OptionDetail>)['Ember Lance']).toMatchObject({
      homebrew: true,
      homebrew_id: homebrewId,
      level: 1,
      school: 'evocation',
    });

    const toAdd = (options.spellcasting as { spells_to_add: number }).spells_to_add;
    const picks = ['Ember Lance', 'Detect Magic', 'Feather Fall', 'Grease'].slice(0, toAdd);
    // A Wizard's level also copies two spells into the book their prepared list is drawn from.
    const levelled = levelUp(db, {
      campaign_id: campaignId,
      choices: { hp: 'average', spells: picks, spellbook: ['Ember Lance', 'Thunderwave'] },
    });
    expect((levelled.character!.spells as { prepared: string[] }).prepared).toContain('Ember Lance');
  });

  it('casts a custom spell in combat from its own schema', async () => {
    const characterId = wizard();
    await storeSpell(EMBER_LANCE, characterId);
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior', count: 1 }],
    });
    const combatants = listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
    const pc = combatants.find((c) => c.kind === 'pc')!.id;
    const goblin = combatants.find((c) => c.team === 'enemy')!.id;
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(1, 5, pc);
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(2, 5, goblin);
    Math.random = () => 0.5; // 3 on a d6, so 2d6 lands 6

    const result = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Ember Lance',
      target_id: goblin,
      out_of_turn: true,
      reason: 'the test acts out of turn',
    });
    const target = result.targets[0] as { damage: { applied: number } };
    expect(target.damage.applied).toBe(6);
    expect(result.log.some((entry) => entry.text.includes('fire damage'))).toBe(true);
  });

  it('rolls the save from the caster spell DC and leaves the condition the spell names', async () => {
    const characterId = wizard();
    await storeSpell(
      {
        ...EMBER_LANCE,
        name: 'Emberfall',
        effect: {
          kind: 'save',
          damage: { dice: '2d6', type: 'fire' },
          save_ability: 'dex',
          half_on_save: true,
          shape: { kind: 'sphere', size_ft: 10 },
          condition: { name: 'prone', duration_rounds: 2 },
        },
      },
      characterId,
    );
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior', count: 1 }],
    });
    const combatants = listCombatants(db, getBattleState(db, campaignId)!.encounter.id);
    const pc = combatants.find((c) => c.kind === 'pc')!.id;
    const goblin = combatants.find((c) => c.team === 'enemy')!.id;
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(1, 5, pc);
    db.prepare('UPDATE combatant SET x = ?, y = ? WHERE id = ?').run(4, 5, goblin);
    Math.random = () => 0; // a natural 1: the save fails

    const dc = (getCharacterSheet(db, campaignId, characterId)!.spells as { save_dc: number }).save_dc;
    const result = await useAction(db, {
      campaign_id: campaignId,
      actor_id: pc,
      action_name: 'Emberfall',
      point: { x: 4, y: 5 },
      out_of_turn: true,
      reason: 'the test acts out of turn',
    });
    const target = result.targets[0] as { save: { dc: number; success: boolean }; effect_id: number | null };
    expect(target.save.success).toBe(false);
    expect(result.log.some((entry) => entry.text.includes(`DC ${dc}`))).toBe(true);
    expect(target.effect_id).not.toBeNull();
    expect(listCombatants(db, getBattleState(db, campaignId)!.encounter.id).find((c) => c.id === goblin)!.conditions).toContain(
      'prone',
    );
  });
});
