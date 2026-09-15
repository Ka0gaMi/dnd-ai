import { beforeEach, describe, expect, it } from 'vitest';
import { advanceTime, getCalendar, nowState, seasonOf, setCalendar, timeOfDay } from '../src/core/calendar.js';
import { createCampaign } from '../src/core/campaign.js';
import { randomTables } from '../src/core/tables.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Timekeeping', story_shape: 'sandbox' }).campaign_id;
});

describe('the in-world calendar', () => {
  it('starts on the first morning of the first year', () => {
    const now = nowState(db, campaignId);
    expect(now).toMatchObject({ year: 1, month: 1, day: 1, hour: 8, minute: 0, month_name: 'Deepfrost' });
    expect(now.date_text).toBe('1 Deepfrost, year 1, 08:00');
    expect(now.time_of_day).toBe('morning');
    expect(now.season).toBe('winter');
    expect(getCalendar(db, campaignId).month_names).toHaveLength(12);
  });

  it('buckets the hours and derives the season from the month', () => {
    expect([0, 5, 8, 12, 15, 18, 20, 23].map(timeOfDay)).toEqual([
      'night',
      'dawn',
      'morning',
      'midday',
      'afternoon',
      'dusk',
      'evening',
      'night',
    ]);
    expect([12, 1, 3, 6, 9].map((month) => seasonOf(month))).toEqual([
      'winter',
      'winter',
      'spring',
      'summer',
      'autumn',
    ]);
  });

  it('rolls minutes into hours, hours into days and days into months and years', () => {
    expect(advanceTime(db, campaignId, { minutes: 90 })).toMatchObject({ hour: 9, minute: 30, day: 1 });
    expect(advanceTime(db, campaignId, { hours: 20 })).toMatchObject({ day: 2, hour: 5, time_of_day: 'dawn' });
    const later = advanceTime(db, campaignId, { days: 400 });
    expect(later).toMatchObject({ year: 2, month: 2, day: 12, season: 'winter' });
    expect(advanceTime(db, campaignId, { days: 120 }).season).toBe('summer');
  });

  it('reports what changed and logs one time event per move', () => {
    const moved = advanceTime(db, campaignId, { days: 1 });
    expect(moved.changed.date).toBe(true);
    const still = advanceTime(db, campaignId, {});
    expect(still.changed).toEqual({ date: false, time_of_day: false, season: false, weather: false });
    const events = db
      .prepare("SELECT text FROM event WHERE campaign_id = ? AND kind = 'time'")
      .all(campaignId) as Array<{ text: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toContain('2 Deepfrost, year 1');
  });

  it('rolls the weather from the season, the same way every time for a given day', () => {
    const first = nowState(db, campaignId);
    expect(randomTables().weather.winter).toContain(first.weather);
    expect(nowState(db, campaignId).weather).toBe(first.weather);

    const other = createCampaign(db, { name: 'Elsewhere', story_shape: 'sandbox' }).campaign_id;
    advanceTime(db, other, { days: 150 });
    const summer = nowState(db, other);
    expect(summer.season).toBe('summer');
    expect(randomTables().weather.summer).toContain(summer.weather);
    expect(nowState(db, other).weather).toBe(summer.weather);
  });
});

describe('setting the calendar', () => {
  it('sets an exact date and returns a now snapshot that matches what a fresh read gives back', () => {
    const set = setCalendar(db, campaignId, { year: 1042, month: 9, day: 14, hour: 16, minute: 30, era_name: 'Third Age' });
    expect(set).toMatchObject({
      year: 1042,
      month: 9,
      day: 14,
      hour: 16,
      minute: 30,
      month_name: 'Harvestmoon',
      season: 'autumn',
      time_of_day: 'afternoon',
      era_name: 'Third Age',
    });
    expect(set.date_text).toBe('14 Harvestmoon, year 1042 (Third Age), 16:30');
    expect(nowState(db, campaignId)).toMatchObject({
      year: 1042,
      month: 9,
      day: 14,
      hour: 16,
      minute: 30,
      date_text: set.date_text,
      weather: set.weather,
    });
  });

  it('logs a time event describing the set date', () => {
    setCalendar(db, campaignId, { year: 1042, month: 9, day: 14, hour: 16, minute: 30 });
    const events = db
      .prepare("SELECT text FROM event WHERE campaign_id = ? AND kind = 'time'")
      .all(campaignId) as Array<{ text: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toContain('14 Harvestmoon, 1042');
    expect(events[0]!.text).toContain('autumn');
  });

  it('flips the month-to-season mapping in the southern hemisphere', () => {
    const set = setCalendar(db, campaignId, { month: 1, hemisphere: 'south' });
    expect(set.season).toBe('summer');
    expect(getCalendar(db, campaignId).hemisphere).toBe('south');
    expect(seasonOf(6, 'south')).toBe('winter');
  });

  it('renames the months and keeps the new names on later reads', () => {
    const names = [
      'Firstmoon', 'Coldmoon', 'Rainmoon', 'Budmoon', 'Flowermoon', 'Sunmoon',
      'Hotmoon', 'Duskmoon', 'Grainmoon', 'Leafmoon', 'Frostmoon', 'Yearsend',
    ];
    const set = setCalendar(db, campaignId, { month: 3, month_names: names });
    expect(set.month_name).toBe('Rainmoon');
    expect(getCalendar(db, campaignId).month_names).toEqual(names);
  });

  it('rejects a day outside the calendar month length', () => {
    expect(() => setCalendar(db, campaignId, { day: 31 })).toThrow(/day/);
    expect(() => setCalendar(db, campaignId, { day: 0 })).toThrow(/day/);
    expect(() => setCalendar(db, campaignId, { month: 13 })).toThrow(/month/);
    expect(() => setCalendar(db, campaignId, { hour: 24 })).toThrow(/hour/);
  });

  it('keeps a season override through advance_time until it is cleared', () => {
    setCalendar(db, campaignId, { month: 1, day: 1, season_override: 'summer' });
    expect(advanceTime(db, campaignId, { hours: 5 }).season).toBe('summer');
    expect(advanceTime(db, campaignId, { days: 2 }).season).toBe('summer');

    setCalendar(db, campaignId, { season_override: null });
    expect(getCalendar(db, campaignId).month).toBe(1);
    expect(nowState(db, campaignId).season).toBe('winter');
  });
});
