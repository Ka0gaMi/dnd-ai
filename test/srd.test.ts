import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { seedSrdGlossary } from '../src/srd/glossary.js';
import { conditionNames, findEquipment, findSpell, spellsForClass, srdSearch } from '../src/srd/lookup.js';
import { allRules, ruleGlossary, rules, spellRules } from '../src/srd/data.js';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

describe('glossary seed', () => {
  it('fills the SRD glossary on open and does not duplicate it', () => {
    const count = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM glossary_entry WHERE campaign_id IS NULL AND source = 'srd'").get() as {
        n: number;
      }).n;
    expect(count()).toBeGreaterThan(50);

    const before = count();
    expect(seedSrdGlossary(db)).toBe(0);
    expect(count()).toBe(before);

    // A database seeded from older bundled text is rewritten, not left stale and not duplicated.
    db.prepare("UPDATE glossary_entry SET definition = 'stale' WHERE campaign_id IS NULL AND term = 'Cover'").run();
    expect(seedSrdGlossary(db)).toBe(before);
    expect(count()).toBe(before);
    expect(
      (db.prepare("SELECT definition FROM glossary_entry WHERE campaign_id IS NULL AND term = 'Cover'").get() as { definition: string }).definition,
    ).not.toBe('stale');

    const terms = (
      db.prepare('SELECT term FROM glossary_entry WHERE campaign_id IS NULL').all() as Array<{ term: string }>
    ).map((t) => t.term);
    expect(new Set(terms).size).toBe(terms.length);
    expect(terms).toContain('Prone (condition)');
    expect(terms).toContain('Stealth (skill)');
    // The Rules Glossary and the Spells-chapter rules are extracted from the official SRD 5.2.1 PDF.
    for (const term of [
      'Concentration',
      'D20 Test',
      'Unarmed Strike',
      'Attunement',
      'Heroic Inspiration',
      'One Spell with a Spell Slot per Turn',
    ]) {
      expect(terms).toContain(term);
    }
    // A condition is seeded once, as "Foo (condition)"; the glossary's tagged "Foo [Condition]" is skipped.
    expect(terms.filter((term) => term.endsWith(' [Condition]'))).toEqual([]);
  });
});

describe('srd lookup', () => {
  it('finds a spell by name with its rules text', () => {
    const { results } = srdSearch('spell', 'fireball');
    const [fireball] = results as Array<{ name: string; level: number; text: string; classes: string[] }>;
    expect(fireball!.name).toBe('Fireball');
    expect(fireball!.level).toBe(3);
    expect(fireball!.text).toMatch(/8d6/);
    expect(fireball!.classes).toContain('wizard');
    expect(findSpell('Fireball')?.school).toBe('evocation');
  });

  it('searches the other kinds and respects the limit', () => {
    expect((srdSearch('creature', 'goblin', 3).results as Array<{ name: string }>).length).toBeLessThanOrEqual(3);
    expect((srdSearch('condition', 'prone').results[0] as { name: string }).name).toBe('prone');
    expect((srdSearch('condition', 'grappled').results[0] as { name: string }).name).toBe('grappled');
    expect((srdSearch('armor', 'chain mail').results[0] as { armor_class: { base: number } }).armor_class.base).toBe(16);
    expect(srdSearch('rule', 'resting').results[0]).toMatchObject({ name: 'Resting' });
    expect(srdSearch('feat', 'alert').results[0]).toMatchObject({ name: 'Alert' });
  });

  it('searches the Rules Glossary and the Spells-chapter rules', () => {
    expect(ruleGlossary().length).toBeGreaterThanOrEqual(150);
    expect(spellRules().length).toBeGreaterThanOrEqual(24);
    const names = allRules().map((rule) => rule.name);
    for (const name of [
      'Ability Check',
      'Weapon Attack',
      'Glossary Conventions',
      'Gaining Spells',
      'Combining Spell Effects',
      'Concentration',
      'Unarmed Strike',
      'One Spell with a Spell Slot per Turn',
      'Casting in Armor',
      'Identifying an Ongoing Spell',
    ]) {
      expect(names).toContain(name);
    }

    // The extractor segments structurally, so pin a few authoritative formulas: a heading-style or PDF
    // change that silently dropped or reshaped an entry would fail here.
    const desc = (name: string): string =>
      [...ruleGlossary(), ...spellRules()].find((rule) => rule.name === name)!.desc;
    expect(desc('Concentration')).toContain('10 or half the damage taken (round down)');
    expect(desc('Unarmed Strike')).toContain('1 plus your Strength modifier');
    expect(desc('One Spell with a Spell Slot per Turn')).toContain('expend only one spell slot');
    // A sidebar floats beside a paragraph; each keeps its own text (the margin-column fix).
    expect(desc('Material (M)')).toContain('Spellcasting Focus');
    expect(desc('Identifying an Ongoing Spell')).not.toContain('Spellcasting Focus');

    expect(srdSearch('rule', 'concentration').results[0]).toMatchObject({ name: 'Concentration' });
    expect(srdSearch('rule', 'unarmed strike').results[0]).toMatchObject({ name: 'Unarmed Strike' });
    expect(srdSearch('rule', 'one spell with a spell slot per turn').results[0]).toMatchObject({
      name: 'One Spell with a Spell Slot per Turn',
    });
    // The PDF wins the collision: the spells chapter's save-DC formula is the text that stays reachable.
    expect((srdSearch('rule', 'spell save dc').results as Array<{ name: string }>).map((r) => r.name)).toContain(
      'Saving Throws',
    );
    // Exact lookup ignores the SRD's bracketed tag.
    expect(srdSearch('rule', 'Dodge', 5, true).results[0]).toMatchObject({ name: 'Dodge [Action]' });
  });

  it('scores by tokenized name and rules text instead of a whole-string substring', () => {
    const { results } = srdSearch('rule', 'Rolling 20 ability check natural 20', 10);
    const names = (results as Array<{ name: string }>).map((r) => r.name);
    expect(names).toContain('Ability Checks'); // matches on name tokens
    expect(names).toContain('D20 Test'); // the Glossary entry that defines a d20 test
    // The PDF wins name collisions, so "Attack Rolls" now carries the Spells chapter's text instead of Open5e's;
    // a rule-text phrase from that chapter still reaches it and ranks it first.
    expect(srdSearch('rule', 'require the caster to make an attack roll').results[0]).toMatchObject({
      name: 'Attack Rolls',
    });
    const abilityChecks = (results as Array<{ name: string; kind: string; score: number; snippet: string }>).find(
      (r) => r.name === 'Ability Checks',
    )!;
    expect(abilityChecks.kind).toBe('rule');
    expect(abilityChecks.score).toBeGreaterThan(0);
    expect(abilityChecks.snippet.length).toBeGreaterThan(0);
  });

  it('returns suggestions instead of an empty miss when nothing scores', () => {
    const { results, suggestions } = srdSearch('rule', 'xyzzy plugh qwzxcvbn');
    expect(results).toEqual([]);
    expect(suggestions).toHaveLength(5);

    const spellMiss = srdSearch('spell', 'zzqxvbwerpq');
    expect(spellMiss.results).toEqual([]);
    expect(spellMiss.suggestions).toHaveLength(5);
  });

  it('returns the full stat block when the query names one creature', () => {
    const { results } = srdSearch('creature', 'Goblin Warrior');
    const [goblin] = results as Array<{
      name: string;
      ac: number;
      hp: number;
      saves: Record<string, number>;
      skills: Record<string, number>;
      senses: string[];
      languages: string;
      actions: Array<{
        name: string;
        kind: string;
        attack_bonus?: number;
        reach_ft?: number;
        range_ft?: number;
        damage?: Array<{ dice: string; type: string | null }>;
        text: string;
      }>;
      bonus_actions: Array<{ name: string }>;
    }>;
    expect(goblin).toMatchObject({ name: 'Goblin Warrior', ac: 15, hp: 10, languages: 'Common, Goblin' });
    expect(goblin!.saves.dex).toBe(2);
    expect(goblin!.skills.stealth).toBe(6);
    expect(goblin!.senses).toContain('darkvision 60 ft.');

    const scimitar = goblin!.actions.find((a) => a.name === 'Scimitar')!;
    expect(scimitar.kind).toBe('melee_weapon_attack');
    expect(scimitar.attack_bonus).toBe(4);
    expect(scimitar.reach_ft).toBe(5);
    expect(scimitar.damage![0]).toEqual({ dice: '1d6+2', type: 'slashing' });
    expect(scimitar.text).toMatch(/Melee Attack Roll/);

    const shortbow = goblin!.actions.find((a) => a.name === 'Shortbow')!;
    expect(shortbow.kind).toBe('ranged_weapon_attack');
    expect(shortbow.range_ft).toBe(80);
    expect(goblin!.bonus_actions.map((a) => a.name)).toContain('Nimble Escape');
  });

  it('lists compact matches when several creatures match', () => {
    const many = srdSearch('creature', 'dragon', 5).results as Array<Record<string, unknown>>;
    expect(many).toHaveLength(5);
    expect(Object.keys(many[0]!).sort()).toEqual(['cr', 'name', 'size', 'type']);
    expect(srdSearch('creature', 'dragon', 1).results[0]).toHaveProperty('actions');
  });

  it('keeps the text of actions that are not attacks', () => {
    const [lich] = srdSearch('creature', 'Lich', 1).results as Array<{
      actions: Array<{ name: string; kind: string; text: string; attack_bonus?: number; uses?: string }>;
      legendary_actions: Array<{ name: string }>;
    }>;
    const spellcasting = lich!.actions.find((a) => a.name === 'Spellcasting')!;
    expect(spellcasting.attack_bonus).toBeUndefined();
    expect(spellcasting.kind).toBe('action');
    expect(spellcasting.text).toMatch(/casts/i);
    expect(lich!.actions.find((a) => a.name === 'Multiattack')?.text).toMatch(/attack/i);
    expect(lich!.legendary_actions.length).toBeGreaterThan(0);
  });

  it('types the weapon fields the equipment data carries', () => {
    expect(findEquipment('Longsword')!.two_handed_damage).toEqual({
      damage_dice: '1d10',
      damage_type: { index: 'slashing', name: 'Slashing', url: '/api/2024/damage-types/slashing' },
    });
    expect(findEquipment('Dagger')!.throw_range).toEqual({ normal: 20, long: 60 });
    expect(findEquipment('Longbow')!.range).toEqual({ normal: 150, long: 600 });
    expect(findEquipment('Longsword')!.mastery!.name).toBe('Sap');
  });

  it('lists a species with its lineages and their traits', () => {
    const [elf] = srdSearch('species', 'Elf', 1).results as Array<{
      name: string;
      traits: Array<{ name: string }>;
      lineages: Array<{ name: string; traits: Array<{ name: string; text: string }> }>;
    }>;
    expect(elf!.traits.map((t) => t.name)).toContain('Fey Ancestry');
    expect(elf!.traits.map((t) => t.name)).not.toContain('Misty Step');
    expect(elf!.lineages.map((l) => l.name)).toEqual([
      'Elven Lineage: Drow',
      'Elven Lineage: High Elf',
      'Elven Lineage: Wood Elf',
    ]);
    const high = elf!.lineages.find((l) => l.name === 'Elven Lineage: High Elf')!;
    expect(high.traits.map((t) => t.name)).toContain('Misty Step');
    expect(high.traits[0]!.text.length).toBeGreaterThan(0);
    expect((srdSearch('species', 'Human', 1).results[0] as { lineages: unknown[] }).lineages).toEqual([]);
  });

  it('knows which spells a class may take', () => {
    expect(conditionNames()).toHaveLength(15);
    expect(spellsForClass('wizard', 0)).toContain('Mage Hand');
    expect(spellsForClass('wizard', 0)).not.toContain('Sacred Flame');
    expect(spellsForClass('cleric', 1)).toContain('Cure Wounds');
  });
});

describe('allRules prefers the PDF text', () => {
  it('uses the glossary text alone for a name the glossary and Open5e share', () => {
    const glossaryCover = ruleGlossary().find((rule) => rule.name.toLowerCase() === 'cover')!;
    const cover = allRules().find((rule) => rule.name.toLowerCase() === 'cover')!;
    expect(cover.desc).toBe(glossaryCover.desc);
    expect(cover.desc).not.toContain('As detailed in the Cover table');
  });

  it('keeps one entry, spelled and worded as the glossary has it, for Knocking Out a Creature', () => {
    const glossaryRule = ruleGlossary().find((rule) => rule.name.toLowerCase() === 'knocking out a creature')!;
    const matches = allRules().filter((rule) => rule.name.toLowerCase() === 'knocking out a creature');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.name).toBe(glossaryRule.name);
    expect(matches[0]!.desc).toBe(glossaryRule.desc);
  });

  it('drops the Open5e text for a name the Spells chapter supplies', () => {
    // The glossary spells this name in the singular ("Attack Roll"), so among the PDF files it is the
    // Spells chapter alone: its text is the whole description and Open5e's is not concatenated on.
    const spellRule = spellRules().find((rule) => rule.name.toLowerCase() === 'attack rolls')!;
    const attack = allRules().find((rule) => rule.name.toLowerCase() === 'attack rolls')!;
    expect(attack.desc).toBe(spellRule.desc);
    expect(attack.desc).not.toContain('misses regardless of any modifiers');
  });

  it('keeps an Open5e-only rule with its Open5e text', () => {
    const pdfNames = new Set([...ruleGlossary(), ...spellRules()].map((rule) => rule.name.toLowerCase()));
    const open5eOnly = rules().find((rule) => !pdfNames.has(rule.fields.name.toLowerCase()))!;
    const entry = allRules().find((rule) => rule.name.toLowerCase() === open5eOnly.fields.name.toLowerCase())!;
    expect(entry.name).toBe(open5eOnly.fields.name);
    expect(entry.desc).toBe(open5eOnly.fields.desc);
  });

  it('keeps one entry per distinct name across the three sources', () => {
    const distinct = new Set([
      ...rules().map((rule) => rule.fields.name.toLowerCase()),
      ...ruleGlossary().map((rule) => rule.name.toLowerCase()),
      ...spellRules().map((rule) => rule.name.toLowerCase()),
    ]);
    expect(allRules()).toHaveLength(distinct.size);
  });
});
