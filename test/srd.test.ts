import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';
import { seedSrdGlossary } from '../src/srd/glossary.js';
import { conditionNames, findEquipment, findSpell, spellsForClass, srdSearch } from '../src/srd/lookup.js';
import { allRules, playingTheGame, ruleGlossary, ruleKey, rules, spellRules } from '../src/srd/data.js';

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
    // The Rules Glossary, the Playing-the-Game chapter and the Spells-chapter rules come from the SRD PDF.
    for (const term of [
      'Concentration',
      'D20 Test',
      'Unarmed Strike',
      'Attunement',
      'Heroic Inspiration',
      'One Spell with a Spell Slot per Turn',
      'D20 Tests',
      'Your Turn',
      'Ability Checks: Ability Modifier',
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

  it('loads the Playing-the-Game chapter, qualifying a name it repeats', () => {
    const chapter = playingTheGame();
    expect(chapter.length).toBeGreaterThanOrEqual(100);
    expect(chapter.length).toBeLessThanOrEqual(123);
    const names = chapter.map((rule) => rule.name);
    for (const name of ['D20 Tests', 'Your Turn', 'Death Saving Throws', 'Cover', 'Playing on a Grid']) {
      expect(names).toContain(name); // a name the chapter alone has stays bare
    }
    // "Ability Modifier" heads three subsections, so each is named for the subsection it belongs to.
    const modifiers = chapter.filter((rule) => rule.name.endsWith(': Ability Modifier'));
    expect(modifiers.map((rule) => rule.name)).toEqual([
      'Ability Checks: Ability Modifier',
      'Saving Throws: Ability Modifier',
      'Attack Rolls: Ability Modifier',
    ]);
    expect(modifiers[0]!.desc).toContain('An ability check is named for the ability modifier it uses');
    expect(modifiers[2]!.desc).toContain('Attack Roll Abilities');
    expect(new Set(names).size).toBe(names.length);
    // The page prints the spanning header above the column labels, and so does the extraction.
    expect(chapter.find((rule) => rule.name === 'Travel Pace')!.desc).toContain(
      'Distance Traveled Per …\nPace | Minute | Hour | Day\nFast | 400 feet | 4 miles | 30 miles',
    );
  });

  it('keeps the printed shape of a PDF entry: paragraphs, bullets and tables', () => {
    const desc = (name: string): string =>
      [...ruleGlossary(), ...spellRules()].find((rule) => rule.name === name)!.desc;

    // A run-in heading ("Damage.") starts a paragraph rather than running on inside the one before it.
    const unarmed = desc('Unarmed Strike').split('\n\n');
    expect(unarmed).toHaveLength(5);
    expect(unarmed[2]).toMatch(/^Damage\. You make an attack roll/);
    expect(desc('Long Rest')).toContain('\n• Rolling Initiative\n• Casting a spell other than a cantrip\n');

    // The page prints the Damage Types table in two halves, each with the header row.
    const rows = desc('Damage Types')
      .split('\n\n')
      .find((part) => part.includes(' | '))!
      .split('\n');
    expect(rows[0]).toBe('Type | Examples');
    expect(rows.filter((row) => row === 'Type | Examples')).toHaveLength(1);
    expect(rows).toContain('Lightning | Electricity');
    expect(rows).toContain('Necrotic | Life-draining energy');
    expect(desc('Dehydration [Hazard]')).toContain('Medium | 1 gallon\nLarge | 4 gallons');

    // A line ending in an em dash joins the next one with no space.
    expect(desc('Area of Effect')).toContain('such as a wall—is between');
    expect(desc('Simultaneous Effects')).toContain('player or GM—whose turn');
    for (const name of ['Area of Effect', 'Simultaneous Effects']) {
      expect(desc(name)).not.toContain('— ');
    }
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
  // The Playing-the-Game chapter now supplies "Cover" too, so the merge of two PDF sources is live: the
  // glossary's summary comes first and the chapter's rules and table follow. Open5e's text is still dropped.
  it('merges the glossary and the chapter for a name both PDF files carry', () => {
    const glossaryCover = ruleGlossary().find((rule) => rule.name.toLowerCase() === 'cover')!;
    const chapterCover = playingTheGame().find((rule) => rule.name.toLowerCase() === 'cover')!;
    const matches = allRules().filter((rule) => rule.name.toLowerCase() === 'cover');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.desc).toBe(`${glossaryCover.desc}\n\n${chapterCover.desc}`);
    expect(matches[0]!.desc).toContain('Three-Quarters | +5 bonus to AC and Dexterity saving throws');
    expect(matches[0]!.desc).not.toContain('|---|'); // Open5e's markdown table is dropped
  });

  it('keeps one entry, spelled as the glossary has it, for Knocking Out a Creature', () => {
    const glossaryRule = ruleGlossary().find((rule) => rule.name.toLowerCase() === 'knocking out a creature')!;
    const chapterRule = playingTheGame().find((rule) => rule.name.toLowerCase() === 'knocking out a creature')!;
    const matches = allRules().filter((rule) => rule.name.toLowerCase() === 'knocking out a creature');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.name).toBe(glossaryRule.name);
    expect(matches[0]!.desc).toBe(`${glossaryRule.desc}\n\n${chapterRule.desc}`);
  });

  it('drops the Open5e text for a name the Spells chapter supplies', () => {
    // The glossary spells this name in the singular ("Attack Roll"), so the PDF text here is the Spells
    // chapter's followed by the Playing-the-Game chapter's; Open5e's is not concatenated on.
    const spellRule = spellRules().find((rule) => rule.name.toLowerCase() === 'attack rolls')!;
    const chapterRule = playingTheGame().find((rule) => rule.name.toLowerCase() === 'attack rolls')!;
    const attack = allRules().find((rule) => rule.name.toLowerCase() === 'attack rolls')!;
    expect(attack.desc).toBe(`${spellRule.desc}\n\n${chapterRule.desc}`);
    expect(attack.desc).not.toContain('misses regardless of any modifiers');
  });

  it('serves the chapter text for an Open5e name the chapter now covers', () => {
    const chapterRule = playingTheGame().find((rule) => rule.name === 'Critical Hits')!;
    const open5e = rules().find((rule) => rule.fields.name === 'Critical Hits')!;
    const entry = allRules().find((rule) => rule.name.toLowerCase() === 'critical hits')!;
    expect(entry.desc).toBe(chapterRule.desc);
    expect(entry.desc).toContain("Roll the attack's damage dice twice"); // the PDF's straight quote
    expect(entry.desc).not.toBe(open5e.fields.desc);
  });

  it('keeps an Open5e-only rule with its Open5e text', () => {
    const pdfNames = new Set([...ruleGlossary(), ...spellRules(), ...playingTheGame()].map((rule) => ruleKey(rule.name)));
    // Open5e prints "Ability Checks" twice, once per chapter section; take a name it carries only once.
    const open5eNames = rules().map((rule) => ruleKey(rule.fields.name));
    const open5eOnly = rules().find(
      (rule) =>
        !pdfNames.has(ruleKey(rule.fields.name)) &&
        open5eNames.filter((name) => name === ruleKey(rule.fields.name)).length === 1,
    )!;
    const entry = allRules().find((rule) => ruleKey(rule.name) === ruleKey(open5eOnly.fields.name))!;
    expect(entry.name).toBe(open5eOnly.fields.name);
    expect(entry.desc).toBe(open5eOnly.fields.desc);
  });

  it('merges the two spellings of a name Open5e writes with a curly apostrophe', () => {
    const chapterRule = playingTheGame().find((rule) => rule.name === "The Bonus Doesn't Stack")!;
    const open5e = rules().find((rule) => rule.fields.name === 'The Bonus Doesn’t Stack')!;
    const matches = allRules().filter((rule) => ruleKey(rule.name) === "the bonus doesn't stack");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.name).toBe(chapterRule.name); // the PDF's straight apostrophe
    expect(matches[0]!.desc).toBe(chapterRule.desc);
    expect(matches[0]!.desc).not.toBe(open5e.fields.desc);
  });

  it('keeps one entry per distinct name across the four sources', () => {
    const distinct = new Set([
      ...rules().map((rule) => ruleKey(rule.fields.name)),
      ...ruleGlossary().map((rule) => ruleKey(rule.name)),
      ...spellRules().map((rule) => ruleKey(rule.name)),
      ...playingTheGame().map((rule) => ruleKey(rule.name)),
    ]);
    expect(allRules()).toHaveLength(distinct.size);
    // The key, not a bare lower-casing, is what makes that count right: one name differs only in its quote.
    const lowercased = new Set([
      ...rules().map((rule) => rule.fields.name.toLowerCase()),
      ...playingTheGame().map((rule) => rule.name.toLowerCase()),
    ]);
    expect(lowercased.size).toBeGreaterThan(
      new Set([...rules().map((rule) => ruleKey(rule.fields.name)), ...playingTheGame().map((rule) => ruleKey(rule.name))]).size,
    );
  });
});
