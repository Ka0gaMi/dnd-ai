// In-world time: a plain 12-month, 30-day calendar with a season derived from the month and the
// day's weather rolled from the season table. Real-world dates stay on the event rows.
import type { Db } from '../db/connection.js';
import { getCampaign, logEvent } from './campaign.js';
import { rechargeDailyItems } from './character.js';
import { hashSeed, rollTable } from './tables.js';

export type Season = 'winter' | 'spring' | 'summer' | 'autumn';
export type TimeOfDay = 'night' | 'dawn' | 'morning' | 'midday' | 'afternoon' | 'dusk' | 'evening';
export type Hemisphere = 'north' | 'south';

export interface Calendar {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  month_names: string[];
  season: Season;
  era_name: string | null;
  season_override: Season | null;
  hemisphere: Hemisphere;
}

export interface NowState {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  month_name: string;
  date_text: string;
  time_of_day: TimeOfDay;
  season: Season;
  weather: string;
}

export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;

/** Fantasy-neutral month names, tied to no published setting. */
export const MONTH_NAMES = [
  'Deepfrost',
  'Thawmoon',
  'Seedtide',
  'Bloomrise',
  'Greenhold',
  'Highsun',
  'Sunwane',
  'Goldfield',
  'Harvestmoon',
  'Leaffall',
  'Mistwane',
  'Longnight',
];

export const DEFAULT_CALENDAR: Calendar = {
  year: 1,
  month: 1,
  day: 1,
  hour: 8,
  minute: 0,
  month_names: MONTH_NAMES,
  season: 'winter',
  era_name: null,
  season_override: null,
  hemisphere: 'north',
};

const OPPOSITE_SEASON: Record<Season, Season> = {
  winter: 'summer',
  summer: 'winter',
  spring: 'autumn',
  autumn: 'spring',
};

/** Northern hemisphere by default; a southern one flips the month->season mapping. */
export function seasonOf(month: number, hemisphere: Hemisphere = 'north'): Season {
  const north: Season = month === 12 || month <= 2 ? 'winter' : month <= 5 ? 'spring' : month <= 8 ? 'summer' : 'autumn';
  return hemisphere === 'south' ? OPPOSITE_SEASON[north] : north;
}

/** A calendar's season is its override if one is set, else derived from the month and hemisphere. */
export function resolveSeason(cal: Pick<Calendar, 'month' | 'season_override' | 'hemisphere'>): Season {
  return cal.season_override ?? seasonOf(cal.month, cal.hemisphere);
}

export function timeOfDay(hour: number): TimeOfDay {
  if (hour < 5) return 'night';
  if (hour < 7) return 'dawn';
  if (hour < 11) return 'morning';
  if (hour < 13) return 'midday';
  if (hour < 17) return 'afternoon';
  if (hour < 19) return 'dusk';
  if (hour < 22) return 'evening';
  return 'night';
}

/** The same campaign on the same in-world day always gets the same weather. */
export function weatherFor(campaignId: number, cal: Calendar): string {
  return rollTable('weather', {
    key: cal.season,
    seed: hashSeed('weather', campaignId, cal.year, cal.month, cal.day),
  }).result;
}

function monthName(cal: Calendar): string {
  return cal.month_names[cal.month - 1] ?? `month ${cal.month}`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function dateText(cal: Calendar): string {
  const era = cal.era_name ? ` (${cal.era_name})` : '';
  return `${cal.day} ${monthName(cal)}, year ${cal.year}${era}, ${pad(cal.hour)}:${pad(cal.minute)}`;
}

export function getCalendar(db: Db, campaignId: number): Calendar {
  const campaign = getCampaign(db, campaignId);
  let stored: Partial<Calendar> = {};
  if (campaign.calendar_json) {
    try {
      stored = JSON.parse(campaign.calendar_json) as Partial<Calendar>;
    } catch {
      stored = {};
    }
  }
  const cal = { ...DEFAULT_CALENDAR, ...stored };
  return { ...cal, season: resolveSeason(cal) };
}

export function nowState(db: Db, campaignId: number): NowState {
  const cal = getCalendar(db, campaignId);
  return {
    year: cal.year,
    month: cal.month,
    day: cal.day,
    hour: cal.hour,
    minute: cal.minute,
    month_name: monthName(cal),
    date_text: dateText(cal),
    time_of_day: timeOfDay(cal.hour),
    season: cal.season,
    weather: weatherFor(campaignId, cal),
  };
}

/** Adds the minutes, hours and days, rolling over into months and years. */
function addTime(cal: Calendar, delta: { minutes?: number; hours?: number; days?: number }): Calendar {
  const minutes =
    cal.minute + (delta.minutes ?? 0) + (delta.hours ?? 0) * 60 + (delta.days ?? 0) * 24 * 60 + cal.hour * 60;
  const days = cal.day - 1 + Math.floor(minutes / (24 * 60));
  const months = cal.month - 1 + Math.floor(days / DAYS_PER_MONTH);
  const month = (months % MONTHS_PER_YEAR) + 1;
  return {
    ...cal,
    year: cal.year + Math.floor(months / MONTHS_PER_YEAR),
    month,
    day: (days % DAYS_PER_MONTH) + 1,
    hour: Math.floor(minutes / 60) % 24,
    minute: minutes % 60,
    season: resolveSeason({ month, season_override: cal.season_override, hemisphere: cal.hemisphere }),
  };
}

export interface TimeChange extends NowState {
  changed: { date: boolean; time_of_day: boolean; season: boolean; weather: boolean };
}

/**
 * Moves the campaign clock, stores the calendar, rolls the new day's weather and logs a time event.
 * A delta of nothing is a read: it changes and logs nothing.
 */
export function advanceTime(
  db: Db,
  campaignId: number,
  delta: { minutes?: number; hours?: number; days?: number } = {},
): TimeChange {
  const before = nowState(db, campaignId);
  const cal = addTime(getCalendar(db, campaignId), delta);
  const moved = (delta.minutes ?? 0) + (delta.hours ?? 0) + (delta.days ?? 0) !== 0;
  if (moved) {
    db.prepare('UPDATE campaign SET calendar_json = ? WHERE id = ?').run(JSON.stringify(cal), campaignId);
  }
  const after = nowState(db, campaignId);
  const changed = {
    date: after.day !== before.day || after.month !== before.month || after.year !== before.year,
    time_of_day: after.time_of_day !== before.time_of_day,
    season: after.season !== before.season,
    weather: after.weather !== before.weather,
  };
  if (moved) {
    logEvent(db, {
      campaign_id: campaignId,
      kind: 'time',
      text: `Time passes: it is now ${after.time_of_day} on ${after.date_text} (${after.season}, ${after.weather}).`,
      payload: { calendar: cal, weather: after.weather, changed },
    });
    // A wand that recharges at dawn fills up the moment the clock passes it.
    rechargeDailyItems(db, campaignId, before, after);
  }
  return { ...after, changed };
}

export interface SetCalendarInput {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  month_names?: string[];
  era_name?: string;
  season_override?: Season | null;
  hemisphere?: Hemisphere;
}

export interface CalendarSet extends NowState {
  era_name: string | null;
}

/**
 * Sets the campaign clock to an exact date, keeping any field the caller omits. Recomputes the
 * season (an override wins until cleared), rolls the new date's weather and logs a time event.
 */
export function setCalendar(db: Db, campaignId: number, input: SetCalendarInput): CalendarSet {
  const before = getCalendar(db, campaignId);
  const month = input.month ?? before.month;
  if (!Number.isInteger(month) || month < 1 || month > MONTHS_PER_YEAR) {
    throw new Error(`month must be between 1 and ${MONTHS_PER_YEAR}.`);
  }
  const day = input.day ?? before.day;
  if (!Number.isInteger(day) || day < 1 || day > DAYS_PER_MONTH) {
    throw new Error(`day must be between 1 and ${DAYS_PER_MONTH}.`);
  }
  const hour = input.hour ?? before.hour;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error('hour must be between 0 and 23.');
  }
  const cal: Calendar = {
    year: input.year ?? before.year,
    month,
    day,
    hour,
    minute: input.minute ?? before.minute,
    month_names: input.month_names ?? before.month_names,
    season: 'winter',
    era_name: input.era_name ?? before.era_name,
    season_override: input.season_override !== undefined ? input.season_override : before.season_override,
    hemisphere: input.hemisphere ?? before.hemisphere,
  };
  cal.season = resolveSeason(cal);
  db.prepare('UPDATE campaign SET calendar_json = ? WHERE id = ?').run(JSON.stringify(cal), campaignId);
  const after = nowState(db, campaignId);
  logEvent(db, {
    campaign_id: campaignId,
    kind: 'time',
    text: `The calendar is set to ${cal.day} ${monthName(cal)}, ${cal.year} (${after.season}, ${after.time_of_day}).`,
    payload: { calendar: cal },
  });
  return { ...after, era_name: cal.era_name };
}
