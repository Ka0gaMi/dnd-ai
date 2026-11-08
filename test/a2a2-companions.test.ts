// A2a-2 companions: a class companion added above level 1 is built level by level with engine defaults and an optional level_plan.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, holdEvents } from '../src/core/bus.js';
import { createCampaign, getCharacterSheet, type CharacterSummary } from '../src/core/campaign.js';
import { COMPANION_SPELL_PICKS, createCompanion } from '../src/core/character.js';
import { saveHomebrew } from '../src/core/progression.js';
import { XP_THRESHOLDS } from '../src/core/rules.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { classLevelRow, findSpell, spellsForClass, subclassesOf } from '../src/srd/lookup.js';
import { resolvePendingRollsImmediately } from './helpers.js';
import { replyData, replyText } from './helpers/reply.js';

let db: Db;
let campaignId: number;
let stopClicking: () => void;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Companions', story_shape: 'sandbox' }).campaign_id;
  stopClicking = resolvePendingRollsImmediately(db);
});

afterEach(() => {
  stopClicking();
});

type Feature = { name: string; source: string; text: string; mechanics?: Record<string, unknown> };
type Spells = { cantrips: string[]; known: string[]; prepared: string[]; spellbook?: string[]; granted?: string[] };
const features = (pc: CharacterSummary): Feature[] => pc.features as Feature[];
const score = (pc: CharacterSummary, ability: string): number =>
  (pc.abilities as Record<string, { score: number; mod: number }>)[ability]!.score;
const mod = (pc: CharacterSummary, ability: string): number =>
  (pc.abilities as Record<string, { score: number; mod: number }>)[ability]!.mod;
const spellsOf = (pc: CharacterSummary): Spells => pc.spells as Spells;
/** The reply's list of what the engine chose; a stat block companion's reply has none. */
const chosenOf = (result: object): string[] => (result as { chosen_for_you?: string[] }).chosen_for_you ?? [];

/** Everything a refused build must leave untouched. */
const counts = () =>
  Object.fromEntries(
    ['character', 'event', 'canon_fact', 'roll'].map((table) => [
      table,
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    ]),
  );

/** A Fighter subclass the DM wrote, with bundles at 3 and at 7. */
function stormSubclass(name = 'Storm Knight'): number {
  return saveHomebrew(db, {
    campaign_id: campaignId,
    kind: 'subclass',
    name,
    schema: {
      class: 'Fighter',
      name,
      flavour_text: 'Thunder follows the blade.',
      features: {
        '3': [{ name: 'Stormstep', text: 'You move like weather.' }],
        '7': [{ name: 'Thunderclap Guard', text: 'Lightning answers a blow aimed at you.' }],
      },
    },
  }).id;
}

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('a class companion built above level 1', () => {
  it('builds a level 5 Fighter: Champion, STR raised at 4, average hit points and Extra Attack', () => {
    const built = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Bran',
      source: { class: 'Fighter', species: 'Human', background: 'Soldier', level: 5 },
    });
    const pc = built.companion!;

    expect(pc).toMatchObject({ level: 5, xp: XP_THRESHOLDS[4], subclass: 'Champion', role: 'companion', status: 'active' });
    expect((pc.hit_dice as { max: number }).max).toBe(5);
    // Soldier's +2 lands on STR (17), and the level 4 increase takes it to 19.
    expect(score(pc, 'str')).toBe(19);
    expect(features(pc).find((f) => f.name === 'Ability Score Improvement')?.text).toBe('Raised STR +2 at level 4.');
    // d10: 10 + CON at level 1, then the fixed average of 6 + CON at each of levels 2 to 5.
    const con = mod(pc, 'con');
    expect(pc.hp_max).toBe(10 + con + 4 * (6 + con));
    expect(pc.hp_current).toBe(pc.hp_max);
    expect(features(pc).find((f) => f.name === 'Extra Attack')).toMatchObject({ mechanics: { extra_attacks: 1 } });
    const champion = subclassesOf('fighter')[0]!.features.filter((f) => f.level <= 5).map((f) => f.name);
    expect(features(pc).filter((f) => f.source === 'subclass').map((f) => f.name)).toEqual(champion);
    expect(chosenOf(built)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Level 3: subclass Champion/),
        expect.stringMatching(/^Level 4: Ability Score Improvement STR \+2/),
      ]),
    );
  });

  it('builds a level 5 Wizard with the SRD subclass, the table counts and no alphabetical-first spells', () => {
    // Criminal's origin feat is Alert, so every spell on the sheet is one the class itself picked.
    const { companion } = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Zel',
      source: { class: 'Wizard', species: 'Human', background: 'Criminal', level: 5 },
    });
    const pc = companion!;
    const spells = spellsOf(pc);
    const row = classLevelRow('wizard', 5).spellcasting!;

    expect(pc.subclass).toBe(subclassesOf('wizard')[0]!.name);
    expect(spells.granted ?? []).toEqual([]);
    expect(spells.cantrips).toHaveLength(row.cantrips_known!);
    expect(spells.prepared).toHaveLength(row.prepared_spells!);
    expect(spells.spellbook).toHaveLength(6 + 2 * 4);
    expect(pc.spell_slots).toMatchObject({ '1': { max: 4 }, '2': { max: 3 }, '3': { max: 2 } });
    for (const name of spells.prepared) expect(spells.spellbook).toContain(name);
    expect(spells.prepared.some((name) => findSpell(name)?.level === 3)).toBe(true);

    // None of the lists is the top of the alphabet, and none holds the first name at any level it draws on.
    expect(spells.cantrips.slice(0, 3)).not.toEqual(spellsForClass('wizard', 0).slice(0, 3));
    expect(spells.prepared.slice(0, 4)).not.toEqual(spellsForClass('wizard', 1).slice(0, 4));
    expect(spells.cantrips).not.toContain(spellsForClass('wizard', 0)[0]);
    for (const level of [1, 2, 3]) expect(spells.spellbook).not.toContain(spellsForClass('wizard', level)[0]);
    expect(spells.cantrips).toContain('Fire Bolt');
    expect(spells.prepared).toEqual(expect.arrayContaining(['Shield', 'Magic Missile', 'Fireball']));
  });

  it('lets a level_plan set the subclass and one Ability Score Improvement, filling the rest', () => {
    stormSubclass();
    const built = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Bran',
      source: {
        class: 'Fighter',
        species: 'Human',
        background: 'Soldier',
        level: 6,
        level_plan: { '3': { subclass: 'Storm Knight' }, '4': { ability_increases: { dex: 1, con: 1 } } },
      },
    });
    const pc = built.companion!;

    expect(pc.subclass).toBe('Storm Knight');
    const increases = features(pc).filter((f) => f.name === 'Ability Score Improvement').map((f) => f.text);
    // The plan's level 4 increase, then the engine's own +2 to STR at the Fighter's extra level 6 one.
    expect(increases).toEqual(['Raised DEX +1, CON +1 at level 4.', 'Raised STR +2 at level 6.']);
    expect(score(pc, 'str')).toBe(19);
    expect(score(pc, 'dex')).toBe(16);
    const lines = chosenOf(built).join('\n');
    expect(lines).not.toMatch(/subclass/);
    expect(lines).not.toMatch(/Level 4: Ability Score Improvement/);
    expect(lines).toMatch(/Level 6: Ability Score Improvement STR \+2/);
  });

  it('takes a feat only when the plan names one, filling the ability it raises', () => {
    const built = createCompanion(db, {
      campaign_id: campaignId,
      name: 'Bran',
      source: { class: 'Fighter', species: 'Human', background: 'Soldier', level: 4, level_plan: { '4': { feat: 'Grappler' } } },
    });
    const pc = built.companion!;

    expect(features(pc).some((f) => f.name === 'Grappler')).toBe(true);
    expect(features(pc).some((f) => f.name === 'Ability Score Improvement')).toBe(false);
    expect(score(pc, 'str')).toBe(18);
    expect(chosenOf(built).join('\n')).toMatch(/Level 4: Grappler raises STR/);
  });

  it('takes a campaign homebrew subclass by its id through the party tool', async () => {
    const homebrewId = stormSubclass();
    const client = await connect();
    const added = replyData<{ companion: CharacterSummary; chosen_for_you: string[] }>(
      await client.callTool({
        name: 'party',
        arguments: {
          campaign_id: campaignId,
          op: 'add',
          name: 'Bran',
          source: {
            class: 'Fighter',
            species: 'Human',
            background: 'Soldier',
            level: 7,
            level_plan: { '3': { subclass_homebrew_id: homebrewId } },
          },
        },
      }),
    );
    await client.close();

    expect(added.companion).toMatchObject({ subclass: 'Storm Knight', level: 7 });
    const row = db.prepare('SELECT subclass_homebrew_id FROM character WHERE id = ?').get(added.companion.id);
    expect(row).toEqual({ subclass_homebrew_id: homebrewId });
    // Both bundles land at their levels, carrying the homebrew id, and nothing of the SRD Champion does.
    const subclassFeatures = features(added.companion).filter((f) => f.source === 'subclass');
    expect(subclassFeatures.map((f) => f.name)).toEqual(['Stormstep', 'Thunderclap Guard']);
    expect(subclassFeatures.every((f) => f.mechanics?.homebrew_id === homebrewId)).toBe(true);
    expect(added.chosen_for_you.join('\n')).not.toMatch(/subclass/);
  });

  it('refuses a bad level_plan entry and leaves nothing behind, a hit point roll included', () => {
    const before = counts();
    expect(() =>
      createCompanion(db, {
        campaign_id: campaignId,
        name: 'Bran',
        personality: 'Loyal to a fault.',
        source: {
          class: 'Fighter',
          species: 'Human',
          background: 'Soldier',
          level: 5,
          level_plan: { '2': { hp: 'roll' }, '3': { subclass: 'Battle Master' } },
        },
      }),
    ).toThrow(/Bran could not be built at level 3, so nothing was created: Unknown subclass "Battle Master".*level_plan\["3"\]/);
    expect(counts()).toEqual(before);
  });

  it('refuses a level_plan entry above the target level, or a pick at a level that offers none, before building', () => {
    const before = counts();
    const build = (level_plan: Record<string, Record<string, unknown>>) => () =>
      createCompanion(db, {
        campaign_id: campaignId,
        name: 'Bran',
        source: { class: 'Fighter', species: 'Human', background: 'Soldier', level: 5, level_plan },
      });
    expect(build({ '6': { ability_increases: { str: 2 } } })).toThrow(/level_plan has an entry for level 6, above the level 5/);
    expect(build({ '1': { spells: [] } })).toThrow(/level_plan is keyed by the levels gained, 2 to 5/);
    expect(build({ '2': { subclass: 'Champion' } })).toThrow(/chooses one at level 3: move it to level_plan\["3"\]/);
    expect(build({ '5': { ability_increases: { str: 2 } } })).toThrow(/only at levels 4, 6, 8, 12, 14, 16/);
    expect(counts()).toEqual(before);
  });

  it('rolls a planned hit point die through dice.ts and records it', () => {
    createCompanion(db, {
      campaign_id: campaignId,
      name: 'Bran',
      source: { class: 'Fighter', species: 'Human', background: 'Soldier', level: 2, level_plan: { '2': { hp: 'roll' } } },
    });
    const rolls = db.prepare('SELECT expr, purpose FROM roll WHERE campaign_id = ?').all(campaignId);
    expect(rolls).toEqual([{ expr: '1d10', purpose: 'Level 2 hit points' }]);
  });
});

describe('events held until the build commits', () => {
  /** Every bus event during `fn`, with whether a transaction was still open when it reached the bus. */
  function published(fn: () => void): Array<{ kind: string; text: string; inTransaction: boolean }> {
    const seen: Array<{ kind: string; text: string; inTransaction: boolean }> = [];
    const off = bus.subscribe((event) => seen.push({ kind: event.kind, text: event.text, inTransaction: db.inTransaction }));
    try {
      fn();
    } finally {
      off();
    }
    return seen;
  }

  it('publishes nothing for a build refused at level 3', () => {
    const seen = published(() =>
      expect(() =>
        createCompanion(db, {
          campaign_id: campaignId,
          name: 'Bran',
          source: { class: 'Fighter', species: 'Human', background: 'Soldier', level: 5, level_plan: { '3': { subclass: 'Battle Master' } } },
        }),
      ).toThrow(/could not be built at level 3/),
    );
    expect(seen).toEqual([]);
  });

  it('publishes the events of a good build once it has committed', () => {
    const seen = published(() =>
      createCompanion(db, {
        campaign_id: campaignId,
        name: 'Bran',
        source: { class: 'Fighter', species: 'Human', background: 'Soldier', level: 3 },
      }),
    );
    const story = seen.filter((event) => ['character', 'level_up'].includes(event.kind)).map((event) => event.text);
    expect(story).toEqual([
      expect.stringMatching(/^Bran the Human Fighter \(Soldier\) joins the story/),
      expect.stringMatching(/^Bran reaches level 2/),
      expect.stringMatching(/^Bran reaches level 3/),
    ]);
    expect(seen.every((event) => !event.inTransaction)).toBe(true);
  });

  it('flushes an inner hold into the outer one and drops what a throwing hold queued', () => {
    const event = (text: string) => ({ campaign_id: campaignId, event_id: null, kind: 'test', text, ts: '' });
    const texts = (fn: () => void) => published(fn).map((e) => e.text);

    expect(
      texts(() =>
        holdEvents(() => {
          bus.publish(event('outer'));
          holdEvents(() => bus.publish(event('inner')));
          // The inner hold has returned, but its event waits for the outer one.
          expect(published(() => undefined)).toEqual([]);
        }),
      ),
    ).toEqual(['outer', 'inner']);
    expect(
      texts(() =>
        expect(() =>
          holdEvents(() => {
            holdEvents(() => bus.publish(event('inner')));
            throw new Error('outer fails');
          }),
        ).toThrow('outer fails'),
      ),
    ).toEqual([]);
    expect(
      texts(() =>
        holdEvents(() => {
          bus.publish(event('kept'));
          expect(() =>
            holdEvents(() => {
              bus.publish(event('dropped'));
              throw new Error('inner fails');
            }),
          ).toThrow('inner fails');
        }),
      ),
    ).toEqual(['kept']);
    // Every hold has closed, so the bus is live again.
    expect(texts(() => bus.publish(event('live')))).toEqual(['live']);
  });
});

describe('a stat block companion', () => {
  it('refuses a Wolf at level 3 at no cost and says what to do instead', async () => {
    const before = counts();
    expect(() =>
      createCompanion(db, { campaign_id: campaignId, name: 'Rook', source: { creature: 'Wolf', level: 3 } }),
    ).toThrow(/Wolf companion is an SRD stat block, which has no levels.*Pick a tougher creature instead/);

    const client = await connect();
    const result = await client.callTool({
      name: 'party',
      arguments: { campaign_id: campaignId, op: 'add', name: 'Rook', source: { creature: 'Wolf', level: 3 } },
    });
    await client.close();
    expect(result.isError).toBe(true);
    expect(replyText(result)).toMatch(/tougher creature/);
    expect(counts()).toEqual(before);
  });

  it('still adds a Wolf at level 1', () => {
    const { companion } = createCompanion(db, { campaign_id: campaignId, name: 'Rook', source: { creature: 'Wolf', level: 1 } });
    expect(companion).toMatchObject({ species: 'Wolf', level: 1, class: null });
  });
});

describe('the reply', () => {
  it("names what the engine chose at each level, so the DM can tell the player", async () => {
    const client = await connect();
    const added = replyData<{ companion: CharacterSummary; chosen_for_you: string[] }>(
      await client.callTool({
        name: 'party',
        arguments: {
          campaign_id: campaignId,
          op: 'add',
          name: 'Sella',
          source: { class: 'Cleric', species: 'Human', background: 'Acolyte', level: 5 },
        },
      }),
    );
    await client.close();

    const sheet = getCharacterSheet(db, campaignId, added.companion.id)!;
    const spells = spellsOf(sheet);
    const byLevel = Object.fromEntries(added.chosen_for_you.map((line) => [line.split(':')[0], line]));
    expect(Object.keys(byLevel)).toEqual(['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5']);
    expect(byLevel['Level 1']).toMatch(/cantrips Sacred Flame, Guidance, Light; spells Healing Word, Bless, Cure Wounds, Guiding Bolt/);
    expect(byLevel['Level 3']).toMatch(/subclass Life Domain/);
    expect(byLevel['Level 4']).toMatch(/Ability Score Improvement WIS \+2/);
    expect(byLevel['Level 5']).toMatch(/spells Spirit Guardians, Mass Healing Word/);
    // Every spell the reply names is on the sheet.
    for (const name of ['Sacred Flame', 'Healing Word', 'Spirit Guardians', 'Mass Healing Word']) {
      expect([...spells.cantrips, ...spells.prepared]).toContain(name);
    }
  });
});

describe('the default spell order', () => {
  it('names only SRD spells, each at the spell level it is listed under', () => {
    COMPANION_SPELL_PICKS.forEach((names, level) => {
      for (const name of names) expect(findSpell(name)?.level, name).toBe(level);
    });
  });
});
