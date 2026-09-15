import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus, type GameEvent } from '../src/core/bus.js';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import {
  DecisionError,
  awaitDecision,
  createDecision,
  openDecisions,
  resolveDecision,
  type HomebrewDecisionPayload,
} from '../src/core/decisions.js';
import { powerReport } from '../src/core/progression.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

function payload(over = true): HomebrewDecisionPayload {
  const mechanics = over ? { to_hit: 1, ac: 1, speed: 10 } : { skill_proficiencies: ['stealth'] };
  return {
    name: 'Trapwright',
    text: 'Your snares catch what walks past them.',
    mechanics,
    justification: 'They have rigged a trap in every fight this chapter.',
    report: powerReport(mechanics),
    character_id: null,
  };
}

function fighter(): void {
  createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
}

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Decisions', story_shape: 'sandbox' }).campaign_id;
  fighter();
});

afterEach(() => db.close());

describe('pending decisions', () => {
  it('pushes the dialog to the player window and lists it while it is open', () => {
    const seen: GameEvent[] = [];
    const off = bus.subscribe((event) => seen.push(event));
    const row = createDecision(db, { campaign_id: campaignId, kind: 'homebrew_feature', payload: payload() });
    off();

    const pushed = seen.find((event) => event.kind === 'pending_decision')!;
    expect(pushed.campaign_id).toBe(campaignId);
    expect(pushed.text).toContain('over the power budget');
    const carried = pushed.payload as { id: number; kind: string; payload: HomebrewDecisionPayload };
    expect(carried.id).toBe(row.id);
    expect(carried.kind).toBe('homebrew_feature');
    expect(carried.payload.report.verdict).toBe('over_budget');
    expect(openDecisions(db, campaignId)).toHaveLength(1);
  });

  it('applies what the player accepts and says so in one line', () => {
    const row = createDecision(db, { campaign_id: campaignId, kind: 'homebrew_feature', payload: payload() });
    const result = resolveDecision(db, row.id, { decision: 'accept' });
    expect(result.applied).toBe(true);
    expect(result.power_label).toBe('over_budget');
    expect(result.summary).toBe('Player accepted "Trapwright" despite the over-budget warning.');

    const event = db
      .prepare("SELECT text FROM event WHERE campaign_id = ? AND kind = 'homebrew_decision' ORDER BY id DESC LIMIT 1")
      .get(campaignId) as { text: string };
    expect(event.text).toBe(result.summary);
    const features = JSON.parse(
      (db.prepare('SELECT features_json FROM character WHERE campaign_id = ?').get(campaignId) as { features_json: string })
        .features_json,
    ) as Array<{ name: string; source: string; mechanics?: { over_budget?: boolean } }>;
    const applied = features.find((f) => f.name === 'Trapwright')!;
    expect(applied.source).toBe('homebrew');
    expect(applied.mechanics?.over_budget).toBe(true);
    expect(openDecisions(db, campaignId)).toHaveLength(0);
    expect(() => resolveDecision(db, row.id, { decision: 'accept' })).toThrow(DecisionError);
  });

  it('changes nothing when the player says no', () => {
    const row = createDecision(db, { campaign_id: campaignId, kind: 'homebrew_feature', payload: payload() });
    const result = resolveDecision(db, row.id, { decision: 'reject' });
    expect(result.applied).toBe(false);
    expect(result.summary).toBe('Player rejected "Trapwright".');
    expect(db.prepare('SELECT COUNT(*) AS n FROM homebrew').get()).toEqual({ n: 0 });
  });

  it('prices the edit the player made before accepting it', () => {
    const row = createDecision(db, { campaign_id: campaignId, kind: 'homebrew_feature', payload: payload() });
    const result = resolveDecision(db, row.id, {
      decision: 'edit',
      edits: { name: 'Snare Sense', mechanics: { skill_proficiencies: ['perception'] } },
    });
    expect(result.summary).toBe('Player edited and accepted "Snare Sense".');
    expect(result.power_label).toBe('within');
    const entry = db.prepare('SELECT name, power_label FROM homebrew').get() as { name: string; power_label: string };
    expect(entry).toEqual({ name: 'Snare Sense', power_label: 'within' });
  });

  it('waits for the answer and gives up when it does not come', async () => {
    const answered = createDecision(db, { campaign_id: campaignId, kind: 'homebrew_feature', payload: payload(false) });
    setTimeout(() => resolveDecision(db, answered.id, { decision: 'accept' }), 5);
    const result = await awaitDecision(db, answered.id, 2000);
    expect(result?.applied).toBe(true);

    const ignored = createDecision(db, { campaign_id: campaignId, kind: 'homebrew_feature', payload: payload(false) });
    expect(await awaitDecision(db, ignored.id, 20)).toBeNull();
    // The late answer still stands, so nothing is lost when the DM has moved on.
    expect(resolveDecision(db, ignored.id, { decision: 'accept' }).applied).toBe(true);
  });
});
