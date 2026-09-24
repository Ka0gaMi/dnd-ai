import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { findPlace, importRegion } from '../src/core/region.js';
import { insertEvent } from '../src/core/world-store.js';
import {
  addAttitude,
  attitudeOf,
  defaultFadeDays,
  lastVisit,
  recordVisit,
  type AttitudeSubject,
} from '../src/core/world-memory.js';
import { openDb, type Db } from '../src/db/connection.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;
}

const safe = fixture('realm-safe.json');

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(name = 'The Ashfall Road'): number {
  return createCampaign(db, { name, story_shape: 'structured' }).campaign_id;
}

function withRealm(campaignId: number): void {
  importRegion(db, campaignId, safe, { source: 'generated' });
}

const faction1: AttitudeSubject = { kind: 'faction', id: 1 };
const entity1: AttitudeSubject = { kind: 'entity', id: 1 };

describe('defaultFadeDays', () => {
  it('gives grudges a longer memory than gratitude', () => {
    expect(defaultFadeDays(3)).toBe(60);
    expect(defaultFadeDays(0)).toBe(60);
    expect(defaultFadeDays(-2)).toBe(120);
  });
});

describe('attitudes', () => {
  it('fades a positive reason over its default 60 days', () => {
    const campaignId = newCampaign();
    const reason = addAttitude(db, campaignId, faction1, {
      value: 3,
      reason: "saved the miller's son",
      day: 100,
    });
    expect(reason.fade_days).toBe(60);
    expect(reason.current).toBe(3);

    expect(attitudeOf(db, campaignId, faction1, 100).total).toBe(3);
    expect(attitudeOf(db, campaignId, faction1, 130).total).toBe(1.5);

    const gone = attitudeOf(db, campaignId, faction1, 160);
    expect(gone.reasons).toEqual([]);
    expect(gone.total).toBe(0);
  });

  it('fades a grudge over 120 days', () => {
    const campaignId = newCampaign();
    addAttitude(db, campaignId, faction1, { value: -2, reason: 'burned the shrine', day: 100 });
    expect(attitudeOf(db, campaignId, faction1, 100).total).toBe(-2);
    expect(attitudeOf(db, campaignId, faction1, 160).total).toBe(-1);
  });

  it('counts a reason dated after today in full', () => {
    const campaignId = newCampaign();
    addAttitude(db, campaignId, faction1, { value: 4, reason: 'a future debt', day: 200 });
    expect(attitudeOf(db, campaignId, faction1, 100).total).toBe(4);
  });

  it('sums several reasons, clamps at +10 and orders by current magnitude then id', () => {
    const campaignId = newCampaign();
    addAttitude(db, campaignId, faction1, { value: 5, reason: 'a', day: 100 });
    addAttitude(db, campaignId, faction1, { value: 5, reason: 'b', day: 100 });
    addAttitude(db, campaignId, faction1, { value: 3, reason: 'c', day: 100 });

    const view = attitudeOf(db, campaignId, faction1, 100);
    expect(view.total).toBe(10);
    expect(view.reasons.map((r) => r.reason)).toEqual(['a', 'b', 'c']);
    expect(view.reasons.map((r) => r.current)).toEqual([5, 5, 3]);
  });

  it('clamps at -10 and orders by current magnitude descending', () => {
    const campaignId = newCampaign();
    addAttitude(db, campaignId, entity1, { value: -2, reason: 'small slight', day: 100 });
    addAttitude(db, campaignId, entity1, { value: -5, reason: 'deep wound', day: 100 });
    addAttitude(db, campaignId, entity1, { value: -5, reason: 'betrayal', day: 100 });

    const view = attitudeOf(db, campaignId, entity1, 100);
    expect(view.total).toBe(-10);
    expect(view.reasons.map((r) => r.reason)).toEqual(['deep wound', 'betrayal', 'small slight']);
  });

  it('records the causing event', () => {
    const campaignId = newCampaign();
    const event = insertEvent(db, campaignId, {
      day: 100,
      kind: 'rescue',
      text: 'The party pulls a child from the millrace.',
      severity: 2,
      place_id: null,
      faction_id: null,
      agenda_id: null,
      causes: [],
      effects: {},
      visibility: 'public',
    });
    const reason = addAttitude(db, campaignId, faction1, {
      value: 2,
      reason: 'helped the miller',
      day: 100,
      cause_event_id: event.id,
    });
    expect(reason.cause_event_id).toBe(event.id);
    expect(attitudeOf(db, campaignId, faction1, 100).reasons[0].cause_event_id).toBe(event.id);
  });

  it('rejects invalid values and blank reasons', () => {
    const campaignId = newCampaign();
    expect(() => addAttitude(db, campaignId, faction1, { value: 0, reason: 'x', day: 1 })).toThrow(
      'Attitude value must be a non-zero integer between -5 and 5, got 0.',
    );
    expect(() => addAttitude(db, campaignId, faction1, { value: 6, reason: 'x', day: 1 })).toThrow(
      'Attitude value must be a non-zero integer between -5 and 5, got 6.',
    );
    expect(() => addAttitude(db, campaignId, faction1, { value: 1.5, reason: 'x', day: 1 })).toThrow(
      'Attitude value must be a non-zero integer between -5 and 5, got 1.5.',
    );
    expect(() => addAttitude(db, campaignId, faction1, { value: 3, reason: '   ', day: 1 })).toThrow(
      'Attitude reason must not be blank.',
    );
  });

  it('keeps factions and entities independent', () => {
    const campaignId = newCampaign();
    addAttitude(db, campaignId, faction1, { value: 4, reason: 'treaty', day: 100 });
    addAttitude(db, campaignId, entity1, { value: -3, reason: 'insult', day: 100 });

    expect(attitudeOf(db, campaignId, faction1, 100).total).toBe(4);
    expect(attitudeOf(db, campaignId, entity1, 100).total).toBe(-3);
  });
});

describe('visits', () => {
  it('remembers the last day and never moves it backwards', () => {
    const campaignId = newCampaign();
    withRealm(campaignId);
    const redham = findPlace(db, campaignId, 'Redham')!.id;

    expect(lastVisit(db, campaignId, redham)).toBeNull();
    expect(recordVisit(db, campaignId, redham, 100)).toEqual({ previous: null });
    expect(recordVisit(db, campaignId, redham, 130)).toEqual({ previous: 100 });
    expect(recordVisit(db, campaignId, redham, 120)).toEqual({ previous: 130 });
    expect(lastVisit(db, campaignId, redham)).toBe(130);
  });

  it('tracks places independently', () => {
    const campaignId = newCampaign();
    withRealm(campaignId);
    const redham = findPlace(db, campaignId, 'Redham')!.id;
    const ficengwind = findPlace(db, campaignId, 'Ficengwind')!.id;

    recordVisit(db, campaignId, redham, 100);
    expect(recordVisit(db, campaignId, ficengwind, 110)).toEqual({ previous: null });
    expect(lastVisit(db, campaignId, redham)).toBe(100);
    expect(lastVisit(db, campaignId, ficengwind)).toBe(110);
  });
});
