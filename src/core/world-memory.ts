// The world's memory of the party: attitudes as fading, labelled reasons and the last day each
// place was seen.
import type { Db } from '../db/connection.js';

export type AttitudeSubject = { kind: 'faction' | 'entity'; id: number };

export interface AttitudeReason {
  id: number;
  value: number;
  reason: string;
  day: number;
  fade_days: number;
  cause_event_id: number | null;
  current: number;
}

interface AttitudeRow {
  id: number;
  value: number;
  reason: string;
  day: number;
  fade_days: number;
  cause_event_id: number | null;
}

/** Grudges fade slower than gratitude. */
export function defaultFadeDays(value: number): number {
  return value < 0 ? 120 : 60;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** A reason dated after today still counts in full; otherwise it decays linearly to zero. */
function decayed(value: number, day: number, fadeDays: number, today: number): number {
  const elapsed = today - day;
  if (elapsed <= 0) return value;
  return round1(value * Math.max(0, 1 - elapsed / fadeDays));
}

export function addAttitude(
  db: Db,
  campaignId: number,
  subject: AttitudeSubject,
  r: { value: number; reason: string; day: number; fade_days?: number; cause_event_id?: number | null },
): AttitudeReason {
  if (!Number.isInteger(r.value) || r.value === 0 || r.value < -5 || r.value > 5) {
    throw new Error(`Attitude value must be a non-zero integer between -5 and 5, got ${r.value}.`);
  }
  const reason = typeof r.reason === 'string' ? r.reason.trim() : '';
  if (reason === '') throw new Error('Attitude reason must not be blank.');

  const fadeDays = r.fade_days ?? defaultFadeDays(r.value);
  const causeEventId = r.cause_event_id ?? null;
  const info = db
    .prepare(
      `INSERT INTO world_attitude
         (campaign_id, subject_kind, subject_id, value, reason, cause_event_id, day, fade_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(campaignId, subject.kind, subject.id, r.value, reason, causeEventId, r.day, fadeDays);

  return {
    id: Number(info.lastInsertRowid),
    value: r.value,
    reason,
    day: r.day,
    fade_days: fadeDays,
    cause_event_id: causeEventId,
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
      `SELECT id, value, reason, day, fade_days, cause_event_id
         FROM world_attitude
        WHERE campaign_id = ? AND subject_kind = ? AND subject_id = ?`,
    )
    .all(campaignId, subject.kind, subject.id) as AttitudeRow[];

  const reasons = rows
    .map((row) => ({ ...row, current: decayed(row.value, row.day, row.fade_days, today) }))
    .filter((r) => r.current !== 0);
  reasons.sort((a, b) => Math.abs(b.current) - Math.abs(a.current) || a.id - b.id);

  const sum = round1(reasons.reduce((acc, r) => acc + r.current, 0));
  return { total: Math.max(-10, Math.min(10, sum)), reasons };
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
