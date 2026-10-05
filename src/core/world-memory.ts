// The world's memory of the party: attitudes as fading, labelled reasons and the last day each
// place was seen.
import type { Db } from '../db/connection.js';
import type { RegionView, WorldPlace } from './region.js';
import { travelDays } from './world-news.js';

export type AttitudeSubject = { kind: 'faction' | 'entity'; id: number };

export interface AttitudeReason {
  id: number;
  value: number;
  reason: string;
  day: number;
  fade_days: number;
  cause_event_id: number | null;
  permanent: boolean;
  place_id: number | null;
  realm_id: number | null;
  rival_of: number | null;
  current: number;
}

interface AttitudeRow {
  id: number;
  value: number;
  reason: string;
  day: number;
  fade_days: number;
  cause_event_id: number | null;
  permanent: number;
  place_id: number | null;
  realm_id: number | null;
  rival_of: number | null;
}

/** Days of travel from its place within which a deed of each size is known; a 5 is known across the map. */
export const DEED_KNOWN_DAYS: Readonly<Record<number, number>> = { 1: 1, 2: 2, 3: 5, 4: 10, 5: Number.POSITIVE_INFINITY };

/** Grudges fade slower than gratitude, and a deed of 3 or more far slower than a small one. */
export function defaultFadeDays(value: number): number {
  const large = Math.abs(value) >= 3;
  if (value < 0) return large ? 720 : 90;
  return large ? 180 : 30;
}

/** A deed of the greatest size, 5 either way, is never forgotten. */
export function isPermanentDeed(value: number): boolean {
  return Math.abs(value) === 5;
}

/** Whether a deed of this value done at deedPlace is known at place, by days of travel between them. */
export function deedKnownAt(view: RegionView, deedPlace: WorldPlace, value: number, place: WorldPlace): boolean {
  const range = DEED_KNOWN_DAYS[Math.abs(value)] ?? 0;
  return range === Number.POSITIVE_INFINITY || travelDays(view, deedPlace, place) <= range;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** A permanent reason, or one dated after today, counts in full; otherwise it decays linearly to zero. */
function decayed(row: Pick<AttitudeRow, 'value' | 'day' | 'fade_days' | 'permanent'>, today: number): number {
  const elapsed = today - row.day;
  if (row.permanent === 1 || elapsed <= 0) return row.value;
  return round1(row.value * Math.max(0, 1 - elapsed / row.fade_days));
}

export function addAttitude(
  db: Db,
  campaignId: number,
  subject: AttitudeSubject,
  r: {
    value: number;
    reason: string;
    day: number;
    fade_days?: number;
    cause_event_id?: number | null;
    permanent?: boolean;
    place_id?: number | null;
    realm_id?: number | null;
    rival_of?: number | null;
  },
): AttitudeReason {
  if (!Number.isInteger(r.value) || r.value === 0 || r.value < -5 || r.value > 5) {
    throw new Error(`Attitude value must be a non-zero integer between -5 and 5, got ${r.value}.`);
  }
  const reason = typeof r.reason === 'string' ? r.reason.trim() : '';
  if (reason === '') throw new Error('Attitude reason must not be blank.');

  const fadeDays = r.fade_days ?? defaultFadeDays(r.value);
  const causeEventId = r.cause_event_id ?? null;
  const permanent = r.permanent ?? isPermanentDeed(r.value);
  const placeId = r.place_id ?? null;
  const realmId = r.realm_id ?? null;
  const rivalOf = r.rival_of ?? null;
  const info = db
    .prepare(
      `INSERT INTO world_attitude
         (campaign_id, subject_kind, subject_id, value, reason, cause_event_id, day, fade_days,
          permanent, place_id, realm_id, rival_of)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      campaignId,
      subject.kind,
      subject.id,
      r.value,
      reason,
      causeEventId,
      r.day,
      fadeDays,
      permanent ? 1 : 0,
      placeId,
      realmId,
      rivalOf,
    );

  return {
    id: Number(info.lastInsertRowid),
    value: r.value,
    reason,
    day: r.day,
    fade_days: fadeDays,
    cause_event_id: causeEventId,
    permanent,
    place_id: placeId,
    realm_id: realmId,
    rival_of: rivalOf,
    current: r.value,
  };
}

export function attitudeOf(
  db: Db,
  campaignId: number,
  subject: AttitudeSubject,
  today: number,
): { total: number; reasons: AttitudeReason[] } {
  const rows = db
    .prepare(
      `SELECT id, value, reason, day, fade_days, cause_event_id, permanent, place_id, realm_id, rival_of
         FROM world_attitude
        WHERE campaign_id = ? AND subject_kind = ? AND subject_id = ?`,
    )
    .all(campaignId, subject.kind, subject.id) as AttitudeRow[];

  const reasons = rows
    .map((row) => ({ ...row, permanent: row.permanent === 1, current: decayed(row, today) }))
    .filter((r) => r.current !== 0);
  reasons.sort((a, b) => Math.abs(b.current) - Math.abs(a.current) || a.id - b.id);

  const sum = round1(reasons.reduce((acc, r) => acc + r.current, 0));
  return { total: Math.max(-10, Math.min(10, sum)), reasons };
}

interface KnownRow extends Pick<AttitudeRow, 'id' | 'value' | 'reason' | 'day' | 'fade_days' | 'permanent'> {
  subject_name: string | null;
}

/** What the party is best known for in a realm, strongest memory first, as words without numbers; DM-only. */
export function knownFor(db: Db, campaignId: number, realmId: number, today: number, limit = 3): string[] {
  // A rival's backlash only echoes a deed already listed, and a deed of 5 is known in every realm.
  const rows = db
    .prepare(
      `SELECT a.id, a.value, a.reason, a.day, a.fade_days, a.permanent, COALESCE(f.name, e.name) AS subject_name
         FROM world_attitude a
         LEFT JOIN world_faction f ON a.subject_kind = 'faction' AND f.id = a.subject_id
         LEFT JOIN entity e ON a.subject_kind = 'entity' AND e.id = a.subject_id
        WHERE a.campaign_id = ? AND a.rival_of IS NULL AND (a.realm_id = ? OR abs(a.value) = 5)`,
    )
    .all(campaignId, realmId) as KnownRow[];

  const ranked = rows
    .map((row) => ({ row, current: decayed(row, today) }))
    .filter((entry) => entry.current !== 0)
    .sort((a, b) => Math.abs(b.current) - Math.abs(a.current) || b.row.day - a.row.day || a.row.id - b.row.id);

  const lines: string[] = [];
  for (const { row } of ranked) {
    if (lines.length >= limit) break;
    const line = `${row.reason} (${row.value > 0 ? 'helped' : 'harmed'} ${row.subject_name ?? 'someone'})`;
    if (!lines.includes(line)) lines.push(line);
  }
  return lines;
}

export function recordVisit(db: Db, campaignId: number, placeId: number, day: number): { previous: number | null } {
  const row = db
    .prepare('SELECT last_seen_day FROM world_visit WHERE campaign_id = ? AND place_id = ?')
    .get(campaignId, placeId) as { last_seen_day: number } | undefined;
  const previous = row ? row.last_seen_day : null;
  const next = previous === null ? day : Math.max(previous, day);

  db.prepare(
    `INSERT INTO world_visit (campaign_id, place_id, last_seen_day) VALUES (?, ?, ?)
     ON CONFLICT(campaign_id, place_id) DO UPDATE SET last_seen_day = excluded.last_seen_day`,
  ).run(campaignId, placeId, next);

  return { previous };
}

export function lastVisit(db: Db, campaignId: number, placeId: number): number | null {
  const row = db
    .prepare('SELECT last_seen_day FROM world_visit WHERE campaign_id = ? AND place_id = ?')
    .get(campaignId, placeId) as { last_seen_day: number } | undefined;
  return row ? row.last_seen_day : null;
}
