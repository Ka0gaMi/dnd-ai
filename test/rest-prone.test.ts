// SRD 5.2.1 Long Rest: a 16-hour wait between long rests; and nobody stays prone once the fight is over.
import { beforeEach, describe, expect, it } from 'vitest';
import { advanceTime } from '../src/core/calendar.js';
import { createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import { applyDamage, createCharacter, heal, rest, stabilize, type CreateCharacterInput } from '../src/core/character.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Prone', story_shape: 'sandbox' }).campaign_id;
  createCharacter(db, {
    campaign_id: campaignId,
    name: 'Test',
    class: 'fighter',
    species: 'Human',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception', 'insight'],
  } as CreateCharacterInput);
});

const conditions = () => getCharacterSheet(db, campaignId)!.conditions;


function setConditions(list: string[]): void {
  db.prepare('UPDATE character SET conditions_json = ?, hp_current = 3 WHERE campaign_id = ?').run(
    JSON.stringify(list),
    campaignId,
  );
}

function startFight(): void {
  const encounter = db
    .prepare(
      `INSERT INTO encounter (campaign_id, status, round, turn_index, seed, map_json, started_at) VALUES (?, 'active', 1, 0, 1, '{}', ?)`,
    )
    .run(campaignId, new Date().toISOString()).lastInsertRowid;
  const pc = db.prepare('SELECT id, name FROM character WHERE campaign_id = ?').get(campaignId) as { id: number; name: string };
  db.prepare(`INSERT INTO combatant (encounter_id, kind, character_id, name, team) VALUES (?, 'pc', ?, ?, 'party')`).run(
    encounter,
    pc.id,
    pc.name,
  );
}

/** A stable PC at 0 HP, unconscious and prone, who wakes after 1 hour. */
function stableAndDown(): void {
  applyDamage(db, { campaign_id: campaignId, amount: 13 });
  const realRandom = Math.random;
  Math.random = () => 0.5;
  try {
    stabilize(db, { campaign_id: campaignId, source: "a healer's kit" });
  } finally {
    Math.random = realRandom;
  }
  db.prepare('UPDATE character SET conditions_json = ? WHERE campaign_id = ?').run(
    JSON.stringify(['unconscious', 'prone']),
    campaignId,
  );
}

describe('long rest wait', () => {
  it('refuses at 15 h 59 min after the last rest ended and allows exactly 16 h', () => {
    rest(db, { campaign_id: campaignId, kind: 'long' });
    advanceTime(db, campaignId, { hours: 15, minutes: 59 });
    expect(() => rest(db, { campaign_id: campaignId, kind: 'long' })).toThrow(
      /Test must wait 16 hours after a long rest before starting another; the last ended at .+\. A short rest is still theirs to take\./,
    );
    advanceTime(db, campaignId, { minutes: 1 });
    expect(rest(db, { campaign_id: campaignId, kind: 'long' })).toMatchObject({ kind: 'long' });
  });
});

describe('prone after a fight', () => {
  it('heal from 0 HP with no encounter clears prone and unconscious', () => {
    setConditions(['unconscious', 'prone']);
    db.prepare('UPDATE character SET hp_current = 0 WHERE campaign_id = ?').run(campaignId);
    heal(db, { campaign_id: campaignId, amount: 5 });
    expect(conditions()).toEqual([]);
  });

  it('heal from 0 HP during an active encounter keeps prone', () => {
    setConditions(['unconscious', 'prone']);
    db.prepare('UPDATE character SET hp_current = 0 WHERE campaign_id = ?').run(campaignId);
    startFight();
    heal(db, { campaign_id: campaignId, amount: 5 });
    expect(conditions()).toEqual(['prone']);
  });

  it('heal of a PC already above 0 HP leaves a deliberate prone alone', () => {
    setConditions(['prone']);
    heal(db, { campaign_id: campaignId, amount: 1 });
    expect(conditions()).toEqual(['prone']);
  });

  it('a finished long rest clears prone', () => {
    setConditions(['prone']);
    rest(db, { campaign_id: campaignId, kind: 'long' });
    expect(conditions()).toEqual([]);
  });

  it('a finished short rest clears prone', () => {
    setConditions(['prone']);
    rest(db, { campaign_id: campaignId, kind: 'short' });
    expect(conditions()).toEqual([]);
  });

  it('an interrupted rest does not', () => {
    setConditions(['prone']);
    rest(db, { campaign_id: campaignId, kind: 'long', interrupted: true, hours: 3 });
    rest(db, { campaign_id: campaignId, kind: 'short', interrupted: true, hours: 0 });
    expect(conditions()).toEqual(['prone']);
  });

  it('a short rest leaves a stable character at 0 HP unconscious and prone', () => {
    stableAndDown();
    rest(db, { campaign_id: campaignId, kind: 'short', advance_time: false });
    expect(conditions()).toEqual(['unconscious', 'prone']);
  });

  it('a stable character who wakes after 1d4 hours stands up outside a fight', () => {
    stableAndDown();
    advanceTime(db, campaignId, { hours: 1 });
    expect(getCharacterSheet(db, campaignId)!.hp_current).toBe(1);
    expect(conditions()).toEqual([]);
  });

  it('a stable character who wakes during a fight stays prone', () => {
    stableAndDown();
    startFight();
    advanceTime(db, campaignId, { hours: 1 });
    expect(conditions()).toEqual(['prone']);
  });
});
