import { beforeEach, describe, expect, it } from 'vitest';
import { advanceTime, isCalendarSet, setCalendar, setWeather } from '../src/core/calendar.js';
import { campaignSnapshot, createCampaign, logEvent } from '../src/core/campaign.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

const windowSet = (): boolean => campaignSnapshot(db, campaignId).calendar_set;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Timekeeping', story_shape: 'sandbox' }).campaign_id;
});

describe('calendar_set', () => {
  it('is false for a fresh campaign', () => {
    expect(isCalendarSet(db, campaignId)).toBe(false);
    expect(windowSet()).toBe(false);
  });

  it('stays false after setWeather', () => {
    setWeather(db, campaignId, 'a driving thunderstorm');
    expect(isCalendarSet(db, campaignId)).toBe(false);
    expect(windowSet()).toBe(false);
  });

  it('stays false after advanceTime with a delta', () => {
    advanceTime(db, campaignId, { hours: 3 });
    expect(isCalendarSet(db, campaignId)).toBe(false);
    expect(windowSet()).toBe(false);
  });

  it('is true after setCalendar', () => {
    setCalendar(db, campaignId, { year: 1492, month: 3, day: 5 });
    expect(isCalendarSet(db, campaignId)).toBe(true);
    expect(windowSet()).toBe(true);
  });

  it('stays true through advanceTime and setWeather', () => {
    setCalendar(db, campaignId, { year: 1492 });
    advanceTime(db, campaignId, { days: 2 });
    setWeather(db, campaignId, 'fog');
    expect(isCalendarSet(db, campaignId)).toBe(true);
    expect(windowSet()).toBe(true);
  });

  it('recognises an older campaign by its calendar time event', () => {
    db.prepare('UPDATE campaign SET calendar_json = ? WHERE id = ?').run(
      JSON.stringify({ year: 1492, month: 3, day: 5 }),
      campaignId,
    );
    expect(isCalendarSet(db, campaignId)).toBe(false);
    logEvent(db, {
      campaign_id: campaignId,
      kind: 'time',
      text: 'The calendar is set to 5 Seedtide, 1492 (spring, morning).',
    });
    expect(isCalendarSet(db, campaignId)).toBe(true);
    expect(windowSet()).toBe(true);
  });
});
