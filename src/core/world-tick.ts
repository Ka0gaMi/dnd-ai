// The living world's clock: advance day by day, fill each active agenda, fire its portents and
// resolve finished clocks, all deterministically from the stored world seed.
import type { Db } from '../db/connection.js';
import { AGENDA_TEMPLATES } from './agenda-templates.js';
import { mixSeed, seededRng } from './dice.js';
import { getSettings } from './settings.js';
import { storytellerCaps } from './storyteller.js';
import { faithMonth, faithOverdue } from './world-faith.js';
import { canResolve, firePortent, resolveAgenda } from './world-resolve.js';
import { pickAgenda } from './world-seed.js';
import {
  getWorldState,
  listAgendas,
  listFactions,
  saveWorldState,
  updateAgenda,
  type WorldAgenda,
  type WorldEvent,
} from './world-store.js';
import { agendaCooldownUntil } from './world-thwart.js';

export interface TickResult {
  from_day: number;
  to_day: number;
  events: WorldEvent[];
}

export const MAX_DAYS_PER_TICK = 60;

/** Keeps each day's turn-order seed apart from the per-agenda roll seed. */
const ORDER_SALT = 7919;
/** Every thirtieth day is a faith month. */
const FAITH_MONTH_DAYS = 30;
/** Keeps an idle faction's new pick apart from the seeding and resolution picks. */
const IDLE_SALT = 6151;
/** An idle faction whose try found nothing tries again this many days later. */
const IDLE_RETRY_DAYS = 7;

/** Fisher–Yates shuffle of a copy of `list`, driven only by the given generator. */
function shuffled<T>(list: readonly T[], rng: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** A major agenda may not resolve while the quiet window that follows a major event is open. */
function quietMajor(agenda: WorldAgenda, day: number, quietUntil: number, majorSeverity: number): boolean {
  if (day >= quietUntil) return false;
  const template = AGENDA_TEMPLATES.find((entry) => entry.id === agenda.template);
  return template !== undefined && template.on_win.severity >= majorSeverity;
}

/** The clock value at which an agenda's portent at `index` becomes due. */
function portentThreshold(index: number, clockSize: number, portentCount: number): number {
  return Math.max(1, Math.ceil(((index + 1) * (clockSize - 1)) / portentCount));
}

/** Indices of unfired portents the clock has already reached, in index order. */
function duePortents(agenda: WorldAgenda): number[] {
  const indices: number[] = [];
  for (let index = 0; index < agenda.portents.length; index += 1) {
    const threshold = portentThreshold(index, agenda.clock_size, agenda.portents.length);
    if (agenda.portents[index]!.fired_day === null && threshold <= agenda.clock_filled) indices.push(index);
  }
  return indices;
}

/** True when every day since the last faith month spent its whole budget, so some of its news may still wait. */
function faithNewsWaiting(db: Db, campaignId: number, day: number, monthDay: number, cap: number): boolean {
  const full = db
    .prepare(
      'SELECT COUNT(*) AS n FROM (SELECT day FROM world_event WHERE campaign_id = ? AND day >= ? AND day < ? GROUP BY day HAVING COUNT(*) >= ?)',
    )
    .get(campaignId, monthDay, day, cap) as { n: number };
  return full.n === day - monthDay;
}

/** True while an agenda is still active or held and its faction lives; a win earlier the same day may end either. */
function stillInPlay(db: Db, campaignId: number, agendaId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM world_agenda a JOIN world_faction f ON f.id = a.faction_id
        WHERE a.campaign_id = ? AND a.id = ? AND a.status IN ('active', 'held') AND f.ended_day IS NULL`,
    )
    .get(campaignId, agendaId);
  return row !== undefined;
}

/**
 * Hands each living faction left without an agenda a new one, first on the day after it went idle or its thwart
 * cooldown ends, then every IDLE_RETRY_DAYS while nothing is open to it.
 */
function pickForIdle(db: Db, campaignId: number, day: number, seed: number): void {
  const idle = db
    .prepare(
      `SELECT f.id AS id, COALESCE(MAX(COALESCE(a.resolved_day, a.started_day)), f.created_day) AS since
         FROM world_faction f LEFT JOIN world_agenda a ON a.campaign_id = f.campaign_id AND a.faction_id = f.id
        WHERE f.campaign_id = ? AND f.ended_day IS NULL
        GROUP BY f.id
       HAVING COALESCE(SUM(a.status IN ('active', 'held')), 0) = 0
        ORDER BY f.id`,
    )
    .all(campaignId) as Array<{ id: number; since: number }>;
  if (idle.length === 0) return;
  const factions = listFactions(db, campaignId);
  for (const row of idle) {
    const from = Math.max(row.since + 1, agendaCooldownUntil(db, campaignId, row.id) ?? -Infinity);
    if (day < from || (day - from) % IDLE_RETRY_DAYS !== 0) continue;
    const faction = factions.find((entry) => entry.id === row.id);
    if (faction) pickAgenda(db, campaignId, faction, day, seed, IDLE_SALT);
  }
}

/**
 * Advances the world one day at a time toward targetDay, stopping after MAX_DAYS_PER_TICK days. A
 * tick with no world yet, or one that targets a past day, writes nothing.
 */
export function tickTo(db: Db, campaignId: number, targetDay: number): TickResult {
  const state = getWorldState(db, campaignId);
  if (!state) return { from_day: targetDay, to_day: targetDay, events: [] };

  const from = state.last_tick_day;
  if (targetDay <= from) return { from_day: from, to_day: from, events: [] };

  const last = Math.min(targetDay, from + MAX_DAYS_PER_TICK);
  const caps = storytellerCaps(getSettings(db, campaignId).storyteller);
  if (!caps) {
    saveWorldState(db, campaignId, { ...state, last_tick_day: last });
    return { from_day: from, to_day: last, events: [] };
  }

  const events: WorldEvent[] = [];
  let quietUntil = state.quiet_until_day;

  for (let day = from + 1; day <= last; day += 1) {
    let eventsToday = 0;
    // Snapshot both groups so an agenda created today, by a resolution or a heresy, waits for tomorrow, in turn order.
    const orderRng = seededRng(mixSeed(state.seed, day, ORDER_SALT));
    const held = shuffled(listAgendas(db, campaignId, { status: 'held' }), orderRng);
    const active = shuffled(listAgendas(db, campaignId, { status: 'active' }), orderRng);

    // The faith month speaks before the agendas so a crowded day cannot silence it; news past the cap waits.
    const monthDay = day - (day % FAITH_MONTH_DAYS);
    const faithNews =
      monthDay === day
        ? faithMonth(db, campaignId, day, state.seed, caps.events_per_day - eventsToday)
        : faithNewsWaiting(db, campaignId, day, monthDay, caps.events_per_day)
          ? faithOverdue(db, campaignId, day, monthDay, state.seed, caps.events_per_day - eventsToday)
          : [];
    events.push(...faithNews);
    eventsToday += faithNews.length;

    // A resolution counts against the day's cap and extends the quiet window when it is major.
    const resolveOrHold = (agenda: WorldAgenda): void => {
      // Quiet days block majors only; the clock stays full and the agenda is retried once it closes.
      if (quietMajor(agenda, day, quietUntil, caps.major_severity)) return;
      if (canResolve(db, campaignId, agenda, day)) {
        // A win that wipes out a brood also writes its destruction, which counts and is returned like the win.
        const { event, consequences } = resolveAgenda(db, campaignId, agenda, day, state.seed);
        events.push(event, ...consequences);
        eventsToday += 1 + consequences.length;
        if (event.severity >= caps.major_severity) quietUntil = day + caps.quiet_days_after_major + 1;
      } else {
        updateAgenda(db, campaignId, agenda.id, { status: 'held' });
      }
    };

    for (const agenda of held) {
      if (eventsToday >= caps.events_per_day) break;
      if (!stillInPlay(db, campaignId, agenda.id)) continue;
      if (canResolve(db, campaignId, agenda, day)) resolveOrHold(agenda);
    }

    const factions = listFactions(db, campaignId);
    for (const agenda of active) {
      if (eventsToday >= caps.events_per_day) break;
      // The list was read at dawn, so a brood wiped out by an earlier win today must not act on it.
      if (!stillInPlay(db, campaignId, agenda.id)) continue;
      const faction = factions.find((entry) => entry.id === agenda.faction_id);
      if (!faction) continue;

      let current = agenda;

      // Overdue warnings fire first and spend the turn, so the roll waits for another day.
      const overdue = duePortents(current);
      if (overdue.length > 0) {
        for (const index of overdue) {
          if (eventsToday >= caps.events_per_day) break;
          events.push(firePortent(db, campaignId, current, index, day));
          eventsToday += 1;
          current = listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!;
        }
        continue;
      }

      // A full clock whose warnings have all fired resolves or holds without another roll.
      if (current.clock_filled >= current.clock_size) {
        resolveOrHold(current);
        continue;
      }

      const rng = seededRng(mixSeed(state.seed, day, agenda.faction_id, agenda.started_day));
      const p = Math.min(0.5, (0.04 + 0.015 * faction.resources) * caps.threat_scale);
      if (rng() >= p) continue;

      current = updateAgenda(db, campaignId, agenda.id, { clock_filled: current.clock_filled + 1 });
      for (const index of duePortents(current)) {
        if (eventsToday >= caps.events_per_day) break;
        events.push(firePortent(db, campaignId, current, index, day));
        eventsToday += 1;
        current = listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!;
      }

      const allPortentsFired = current.portents.every((portent) => portent.fired_day !== null);
      if (current.clock_filled >= current.clock_size && allPortentsFired && eventsToday < caps.events_per_day) {
        resolveOrHold(current);
      }
    }

    pickForIdle(db, campaignId, day, state.seed);

    saveWorldState(db, campaignId, { seed: state.seed, last_tick_day: day, quiet_until_day: quietUntil });
  }

  return { from_day: from, to_day: last, events };
}
