// The living world's clock: advance day by day, fill each active agenda, fire its portents and
// resolve finished clocks, all deterministically from the stored world seed.
import type { Db } from '../db/connection.js';
import { mixSeed, seededRng } from './dice.js';
import { getSettings } from './settings.js';
import { storytellerCaps } from './storyteller.js';
import { canResolve, firePortent, resolveAgenda } from './world-resolve.js';
import {
  getWorldState,
  listAgendas,
  listFactions,
  saveWorldState,
  updateAgenda,
  type WorldEvent,
} from './world-store.js';

export interface TickResult {
  from_day: number;
  to_day: number;
  events: WorldEvent[];
}

export const MAX_DAYS_PER_TICK = 60;

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
    // Snapshot both groups so an agenda created by a resolution waits for tomorrow.
    const held = listAgendas(db, campaignId, { status: 'held' });
    const active = listAgendas(db, campaignId, { status: 'active' });

    for (const agenda of held) {
      if (!canResolve(db, campaignId, agenda)) continue;
      const { event } = resolveAgenda(db, campaignId, agenda, day, state.seed);
      events.push(event);
      eventsToday += 1;
      if (event.severity >= caps.major_severity) quietUntil = day + caps.quiet_days_after_major;
    }

    const factions = listFactions(db, campaignId);
    for (const agenda of active) {
      if (eventsToday >= caps.events_per_day) break;
      const faction = factions.find((entry) => entry.id === agenda.faction_id);
      if (!faction) continue;

      const rng = seededRng(mixSeed(state.seed, day, agenda.id));
      let p = Math.min(0.5, (0.06 + 0.02 * faction.resources) * caps.threat_scale);
      if (day < quietUntil) p *= 0.25;
      if (rng() >= p) continue;

      const filled = agenda.clock_filled + 1;
      let current = updateAgenda(db, campaignId, agenda.id, { clock_filled: filled });

      for (let index = 0; index < current.portents.length; index += 1) {
        const threshold = Math.ceil(((index + 1) * current.clock_size) / current.portents.length);
        if (filled !== threshold || current.portents[index]!.fired_day !== null) continue;
        events.push(firePortent(db, campaignId, current, index, day));
        eventsToday += 1;
        current = listAgendas(db, campaignId).find((entry) => entry.id === agenda.id)!;
      }

      if (filled >= current.clock_size) {
        if (canResolve(db, campaignId, current)) {
          const { event } = resolveAgenda(db, campaignId, current, day, state.seed);
          events.push(event);
          eventsToday += 1;
          if (event.severity >= caps.major_severity) quietUntil = day + caps.quiet_days_after_major;
        } else {
          updateAgenda(db, campaignId, current.id, { status: 'held' });
        }
      }
    }

    saveWorldState(db, campaignId, { seed: state.seed, last_tick_day: day, quiet_until_day: quietUntil });
  }

  return { from_day: from, to_day: last, events };
}
