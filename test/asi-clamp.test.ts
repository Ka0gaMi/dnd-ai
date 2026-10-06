// An ability score increase raises a score but can never lower it: a score already above 20 keeps its
// value, and the 20 cap only ever trims a raise.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter, grantFeature, type CreateCharacterInput } from '../src/core/character.js';
import { clausesSchema, type ClauseInput } from '../src/core/mechanics.js';
import { saveHomebrew } from '../src/core/progression.js';
import { withAsi } from '../src/combat/homebrew.js';
import { combatSheet } from '../src/combat/sheet.js';
import { openDb, type Db } from '../src/db/connection.js';
import { skillChoiceGroups, findClass, findSpecies } from '../src/srd/lookup.js';

let db: Db;
let campaignId: number;

const ABILITIES = { str: 14, dex: 14, con: 13, int: 10, wis: 12, cha: 16 };

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

function make(cls: string): number {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: cls,
    class: cls,
    species: 'Human',
    background: 'Acolyte',
    ability_method: 'manual',
    abilities: ABILITIES,
    ability_bonuses: { cha: 1, wis: 1, int: 1 },
    skill_choices: skillPicks(cls),
  } as CreateCharacterInput).character!.id;
}

/** Writes the homebrew row and puts the feature it stands for on the sheet. */
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

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'ASI', story_shape: 'sandbox' }).campaign_id;
});

afterEach(() => {
  db.close();
});

describe('withAsi', () => {
  it('never lowers a score that is already above 20', () => {
    expect(withAsi(22, 2)).toBe(22);
    expect(withAsi(22, 1)).toBe(22);
  });

  it('caps a raise at 20', () => {
    expect(withAsi(19, 2)).toBe(20);
    expect(withAsi(20, 1)).toBe(20);
  });

  it('raises a score below the cap by the clause amount', () => {
    expect(withAsi(15, 2)).toBe(17);
  });

  it('leaves the score alone when there is no increase', () => {
    expect(withAsi(15, undefined)).toBe(15);
    expect(withAsi(22, undefined)).toBe(22);
  });
});

describe('an ASI read off a sheet', () => {
  it('keeps a score already above 20 when the clause raises it', () => {
    const id = make('fighter');
    db.prepare('UPDATE character SET abilities_json = ? WHERE id = ?').run(
      JSON.stringify({ ...combatSheet(db, id).abilities, cha: { score: 22, mod: 6 } }),
      id,
    );
    grant(id, 'Overreach', [{ when: 'always', do: [{ kind: 'asi', ability: 'cha', amount: 2 }] }]);
    expect(combatSheet(db, id).abilities.cha!.score).toBe(22);
  });
});
