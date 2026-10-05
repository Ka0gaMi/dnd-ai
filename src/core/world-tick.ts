// The living world's clock: advance day by day, fill each active agenda, fire its portents and
// resolve finished clocks, all deterministically from the stored world seed.
import type { Db } from '../db/connection.js';
import { AGENDA_TEMPLATES } from './agenda-templates.js';
import { mixSeed, seededRng } from './dice.js';
import { matchPlace } from './place-match.js';
import { findPlace, getRegion } from './region.js';
import { getSettings } from './settings.js';
import { storytellerCaps } from './storyteller.js';
import { faithMonth, faithOverdue } from './world-faith.js';
import { newsRadiusDays, travelDays } from './world-news.js';
import {
  agendaPlaceId,
  canResolve,
  firePortent,
  heardCount,
  portentRadiusDays,
  resolveAgenda,
  visibilityFor,
} from './world-resolve.js';
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

/** Whether news from a place, travelling `radiusDays`, reaches the party; secret news reaches no one. */
type Perceives = (placeId: number | null, radiusDays: number, visibility: WorldEvent['visibility']) => boolean;

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

/** How far an event's news travels: a portent stays local, anything else goes by its severity. */
function newsReach(event: Pick<WorldEvent, 'kind' | 'severity' | 'visibility'>): number {
  return event.kind === 'portent' ? portentRadiusDays(event.visibility) : newsRadiusDays(event.severity);
}

/**
 * Reads where the party stands from the latest scene location; with no known place every event counts, as under
 * the old global cap. Travel days are cached per origin, since the party stays put for the whole tick.
 */
function partyPerception(db: Db, campaignId: number): Perceives {
  const scene = db
    .prepare(
      'SELECT location_name FROM scene WHERE campaign_id = ? AND location_name IS NOT NULL ORDER BY id DESC LIMIT 1',
    )
    .get(campaignId) as { location_name: string } | undefined;
  const view = scene ? getRegion(db, campaignId) : null;
  const matched = scene && view ? matchPlace(db, campaignId, scene.location_name) : undefined;
  const party = matched ? view?.places.find((place) => place.id === matched.id) : undefined;
  if (!view || !party) return () => true;

  const places = new Map(view.places.map((place) => [place.id, place]));
  const days = new Map<number, number>();
  return (placeId, radiusDays, visibility) => {
    if (visibility === 'secret' || placeId === null) return false;
    let travel = days.get(placeId);
    if (travel === undefined) {
      const origin = places.get(placeId);
      travel = origin ? travelDays(view, origin, party) : Infinity;
      days.set(placeId, travel);
    }
    return travel <= radiusDays;
  };
}

/** True when every day since the last faith month spent its whole budget on news the party perceives. */
function faithNewsWaiting(
  db: Db,
  campaignId: number,
  day: number,
  monthDay: number,
  cap: number,
  perceives: Perceives,
): boolean {
  const rows = db
    .prepare(
      'SELECT day, kind, severity, place_id, visibility FROM world_event WHERE campaign_id = ? AND day >= ? AND day < ?',
    )
    .all(campaignId, monthDay, day) as Array<Pick<WorldEvent, 'day' | 'kind' | 'severity' | 'place_id' | 'visibility'>>;
  const spent = new Map<number, number>();
  for (const row of rows) {
    if (perceives(row.place_id, newsReach(row), row.visibility)) spent.set(row.day, (spent.get(row.day) ?? 0) + 1);
  }
  for (let past = monthDay; past < day; past += 1) if ((spent.get(past) ?? 0) < cap) return false;
  return true;
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
  const perceives = partyPerception(db, campaignId);

  // An agenda's place and its faction's secrecy hold for the whole tick, so each is read once.
  const placeOf = new Map<number, number | null>();
  const agendaPlace = (agenda: WorldAgenda): number | null => {
    if (!placeOf.has(agenda.id)) placeOf.set(agenda.id, agendaPlaceId(db, campaignId, agenda));
    return placeOf.get(agenda.id)!;
  };
  const visibilityOf = new Map<number, WorldEvent['visibility']>();
  const agendaVisibility = (agenda: WorldAgenda): WorldEvent['visibility'] => {
    if (!visibilityOf.has(agenda.faction_id)) {
      const faction = listFactions(db, campaignId, { includeEnded: true }).find((f) => f.id === agenda.faction_id);
      visibilityOf.set(agenda.faction_id, faction ? visibilityFor(faction.secrecy) : 'public');
    }
    return visibilityOf.get(agenda.faction_id)!;
  };
  // Mirrors resolveAgenda: an unheard hold that went ahead on its timeout is news across the whole map.
  const winReach = (agenda: WorldAgenda, placeId: number | null): number => {
    const template = AGENDA_TEMPLATES.find((entry) => entry.id === agenda.template);
    if (!template) return 0;
    const timedOut =
      template.on_win.irreversible &&
      placeId !== null &&
      findPlace(db, campaignId, placeId)?.known_to_party === true &&
      heardCount(agenda) < 2;
    return timedOut ? Infinity : newsRadiusDays(template.on_win.severity);
  };
  const portentSeen = (agenda: WorldAgenda): boolean => {
    const visibility = agendaVisibility(agenda);
    return perceives(agendaPlace(agenda), portentRadiusDays(visibility), visibility);
  };
  const winSeen = (agenda: WorldAgenda): boolean => {
    const placeId = agendaPlace(agenda);
    return perceives(placeId, winReach(agenda, placeId), agendaVisibility(agenda));
  };

  for (let day = from + 1; day <= last; day += 1) {
    // Only news the party would hear spends the day's budget; distant events never wait for it.
    let spent = 0;
    const full = (): boolean => spent >= caps.events_per_day;
    const record = (event: WorldEvent, reach = newsReach(event)): boolean => {
      events.push(event);
      const seen = perceives(event.place_id, reach, event.visibility);
      if (seen) spent += 1;
      return seen;
    };

    // Snapshot both groups so an agenda created today, by a resolution or a heresy, waits for tomorrow, in turn order.
    const orderRng = seededRng(mixSeed(state.seed, day, ORDER_SALT));
    const held = shuffled(listAgendas(db, campaignId, { status: 'held' }), orderRng);
    const active = shuffled(listAgendas(db, campaignId, { status: 'active' }), orderRng);

    // The faith month speaks before the agendas so a crowded day cannot silence it; news past the cap waits.
    const monthDay = day - (day % FAITH_MONTH_DAYS);
    if (monthDay === day || faithNewsWaiting(db, campaignId, day, monthDay, caps.events_per_day, perceives)) {
      let budget = caps.events_per_day - spent;
      let news =
        monthDay === day
          ? faithMonth(db, campaignId, day, state.seed, budget)
          : faithOverdue(db, campaignId, day, monthDay, state.seed, budget);
      for (const event of news) record(event);
      // Distant news filled the faith budget without spending the day's, so what still waits may speak now.
      while (news.length >= budget && !full()) {
        budget = caps.events_per_day - spent;
        news = faithOverdue(db, campaignId, day, monthDay, state.seed, budget);
        for (const event of news) record(event);
      }
    }

    // A perceived resolution spends the budget and, when major, opens the quiet window; distant ones never wait.
    const resolveOrHold = (agenda: WorldAgenda): void => {
      if (full() && winSeen(agenda)) return;
      // Quiet days block majors only; the clock stays full and the agenda is retried once it closes.
      if (quietMajor(agenda, day, quietUntil, caps.major_severity) && winSeen(agenda)) return;
      if (canResolve(db, campaignId, agenda, day)) {
        // A win that wipes out a brood also writes its destruction, which counts and is returned like the win.
        const { event, consequences } = resolveAgenda(db, campaignId, agenda, day, state.seed);
        const seen = record(event, event.kind === 'agenda_won' ? winReach(agenda, event.place_id) : newsReach(event));
        for (const consequence of consequences) record(consequence);
        if (seen && event.severity >= caps.major_severity) quietUntil = day + caps.quiet_days_after_major + 1;
      } else {
        updateAgenda(db, campaignId, agenda.id, { status: 'held' });
      }
    };

    for (const agenda of held) {
      if (!stillInPlay(db, campaignId, agenda.id)) continue;
      if (canResolve(db, campaignId, agenda, day)) resolveOrHold(agenda);
    }

    const factions = listFactions(db, campaignId);
    for (const agenda of active) {
      // The list was read at dawn, so a brood wiped out by an earlier win today must not act on it.
      if (!stillInPlay(db, campaignId, agenda.id)) continue;
      const faction = factions.find((entry) => entry.id === agenda.faction_id);
      if (!faction) continue;

      let current = agenda;

      // Overdue warnings fire first and spend the turn, so the roll waits for another day.
      const overdue = duePortents(current);
      if (overdue.length > 0) {
        for (const index of overdue) {
          if (full() && portentSeen(current)) break;
          record(firePortent(db, campaignId, current, index, day));
          current = listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!;
        }
        continue;
      }

      // A full clock whose warnings have all fired resolves or holds without another roll.
      if (current.clock_filled >= current.clock_size) {
        resolveOrHold(current);
        continue;
      }

      // On a full day an agenda whose next news the party would hear loses its turn, as under the old cap.
      const unfired = current.portents.some((portent) => portent.fired_day === null);
      if (full() && (unfired ? portentSeen(current) : winSeen(current))) continue;

      const rng = seededRng(mixSeed(state.seed, day, agenda.faction_id, agenda.started_day));
      const p = Math.min(0.5, (0.04 + 0.015 * faction.resources) * caps.threat_scale);
      if (rng() >= p) continue;

      current = updateAgenda(db, campaignId, agenda.id, { clock_filled: current.clock_filled + 1 });
      for (const index of duePortents(current)) {
        if (full() && portentSeen(current)) break;
        record(firePortent(db, campaignId, current, index, day));
        current = listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!;
      }

      const allPortentsFired = current.portents.every((portent) => portent.fired_day !== null);
      if (current.clock_filled >= current.clock_size && allPortentsFired) resolveOrHold(current);
    }

    pickForIdle(db, campaignId, day, state.seed);

    saveWorldState(db, campaignId, { seed: state.seed, last_tick_day: day, quiet_until_day: quietUntil });
  }

  return { from_day: from, to_day: last, events };
}
