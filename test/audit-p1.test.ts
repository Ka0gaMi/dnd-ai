// P1 of the SRD 5.2.1 parity audit: eight out-of-combat character-state defects.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advanceTime } from '../src/core/calendar.js';
import { createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import {
  applyDamage,
  createCharacter,
  deathSave,
  grantFeature,
  rest,
  setCondition,
  setExhaustion,
  stabilize,
  type CreateCharacterInput,
} from '../src/core/character.js';
import { updateSettings } from '../src/core/settings.js';
import { startEncounter } from '../src/combat/engine.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;
const realRandom = Math.random;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Audit P1', story_shape: 'sandbox' }).campaign_id;
});

afterEach(() => {
  Math.random = realRandom;
});

/** Every die takes a fixed value; used where a rule rolls its own 1d4. */
function fixRolls(value: number): void {
  Math.random = () => value;
}

function fighter(overrides: Partial<CreateCharacterInput> = {}) {
  return createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
    ...overrides,
  });
}

const sheet = () => getCharacterSheet(db, campaignId)!;
const saves = () => sheet().death_saves as { successes: number; failures: number };

describe('P1.1 damage at 0 HP can kill outright', () => {
  it('counts an ordinary hit at 0 HP as one failure and a massive one as death', () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 13 }); // exactly 0 HP, no overkill
    expect(sheet().status).toBe('active');

    const scratch = applyDamage(db, { campaign_id: campaignId, amount: 3 });
    expect(scratch.status).toBe('active');
    expect(scratch.death_saves).toEqual({ successes: 0, failures: 1 });

    const massive = applyDamage(db, { campaign_id: campaignId, amount: 13 });
    expect(massive.status).toBe('dead');
    expect(sheet().status).toBe('dead');
  });
});

describe('P1.2 a stabilised character rolls no death saves', () => {
  it('refuses the save until damage starts them again', () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 13 });
    stabilize(db, { campaign_id: campaignId, source: "a healer's kit" });
    expect(sheet().stable).toBe(true);
    expect(() => deathSave(db, { campaign_id: campaignId })).toThrow(/stable/i);

    applyDamage(db, { campaign_id: campaignId, amount: 2 });
    expect(sheet().stable).toBe(false);
    const save = deathSave(db, { campaign_id: campaignId, roll: { total: 20, natural_d20: 20 } });
    expect(save.hp_current).toBe(1);
  });
});

describe('P1.3 a long rest lifts exhaustion without food and drink', () => {
  it('removes one level even when the party ate nothing', () => {
    fighter();
    setExhaustion(db, { campaign_id: campaignId, delta: 2 });
    const rested = rest(db, { campaign_id: campaignId, kind: 'long', food_and_drink: false });
    expect(rested.exhaustion).toBe(1);
  });
});

describe('P1.4 a short rest from 0 HP clears death save failures', () => {
  it('resets the failures and the stable flag when it heals above 0', () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 13 });
    applyDamage(db, { campaign_id: campaignId, amount: 3 }); // one failure at 0 HP
    expect(saves().failures).toBe(1);

    const short = rest(db, { campaign_id: campaignId, kind: 'short', hit_dice_to_spend: 1 });
    expect(short.hp_current).toBeGreaterThan(0);
    expect(saves()).toEqual({ successes: 0, failures: 0 });
    expect(sheet().stable).toBe(false);
  });
});

describe('P1.5 a stable creature regains 1 HP after 1d4 hours', () => {
  it('wakes on the clock, not on the next rest', () => {
    fighter();
    applyDamage(db, { campaign_id: campaignId, amount: 13 });
    fixRolls(0.1); // the 1d4 hours come up 2
    stabilize(db, { campaign_id: campaignId, source: "a healer's kit" });
    expect(sheet().stable).toBe(true);

    advanceTime(db, campaignId, { hours: 8 });
    expect(sheet().hp_current).toBe(1);
    expect(sheet().stable).toBe(false);
    expect(sheet().conditions as string[]).not.toContain('unconscious');
  });
});

describe('P1.6 out-of-combat damage reads the damage lines', () => {
  it('halves a resisted type', () => {
    fighter(); // a Dwarf resists poison
    const hit = applyDamage(db, { campaign_id: campaignId, amount: 11, type: 'poison' });
    expect(hit.damage_taken).toBe(5);
    expect(sheet().hp_current).toBe(8);
  });

  it('doubles a vulnerability and ignores an immunity', () => {
    fighter();
    grantFeature(db, {
      campaign_id: campaignId,
      name: 'Frostmark',
      text: 'You are Vulnerable to Cold damage.',
      source: 'homebrew',
      mechanics: { vulnerabilities: ['cold'] },
    });
    grantFeature(db, {
      campaign_id: campaignId,
      name: 'Ironblood',
      text: 'You are Immune to Poison damage.',
      source: 'homebrew',
      mechanics: { immunities: ['poison'] },
    });

    expect(applyDamage(db, { campaign_id: campaignId, amount: 4, type: 'cold' }).damage_taken).toBe(8);
    expect(applyDamage(db, { campaign_id: campaignId, amount: 9, type: 'poison' }).damage_taken).toBe(0);
    expect(sheet().hp_current).toBe(5);
  });
});

describe('P1.7 set_condition honours condition immunities', () => {
  it('refuses a condition the sheet is immune to, and lets the rest through', () => {
    fighter();
    grantFeature(db, {
      campaign_id: campaignId,
      name: 'Warded Mind',
      text: 'You are immune to the Frightened condition.',
      source: 'homebrew',
      mechanics: { condition_immunities: 'frightened' },
    });

    expect(() => setCondition(db, { campaign_id: campaignId, condition: 'frightened', active: true })).toThrow(/immune/i);
    expect(setCondition(db, { campaign_id: campaignId, condition: 'prone', active: true }).conditions).toContain('prone');
  });
});

describe('P1.8 a rest cannot be taken during a fight', () => {
  it('refuses both kinds while the encounter runs', async () => {
    fighter();
    updateSettings(db, campaignId, { player_rolls: 'none' });
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 3,
      terrain: 'cave',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior' }],
    });

    expect(() => rest(db, { campaign_id: campaignId, kind: 'short' })).toThrow(/active encounter/i);
    expect(() => rest(db, { campaign_id: campaignId, kind: 'long' })).toThrow(/active encounter/i);
  });
});
