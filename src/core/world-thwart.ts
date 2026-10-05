// The party's hand in the living world: an agenda set back or thwarted, a faction destroyed, a lair cleared.
// Each act validates before it writes, runs in one transaction and sends its news on the road.
import type { Db } from '../db/connection.js';
import { getRegion, type RegionView } from './region.js';
import { emitPacket } from './world-news.js';
import { agendaPlaceId } from './world-resolve.js';
import { publicText } from './world-seed.js';
import {
  insertEvent,
  listAgendas,
  listFactions,
  updateAgenda,
  updateFaction,
  type WorldAgenda,
  type WorldEvent,
  type WorldFaction,
} from './world-store.js';

/** How long a faction whose agenda was thwarted waits before it takes up a new one. */
export const THWART_COOLDOWN_DAYS = 30;

/** The same bounds as world-resolve's clamp on faction resources, which that module keeps private. */
const clampResources = (value: number): number => Math.max(0, Math.min(10, value));

const NO_TARGET = { kind: 'none', id: null, name: '' };

/** A faction's secrecy decides who may see an event it caused, as in world-resolve. */
function visibilityFor(secrecy: WorldFaction['secrecy']): WorldEvent['visibility'] {
  if (secrecy === 'open') return 'public';
  return secrecy === 'discreet' ? 'discreet' : 'secret';
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === '') throw new Error('A reason is required.');
  return trimmed;
}

function requireRegion(db: Db, campaignId: number): RegionView {
  const view = getRegion(db, campaignId);
  if (!view) throw new Error('This campaign has no region map, so it has no living world.');
  return view;
}

/** An agenda still in play and the living faction running it, or a refusal. */
function openAgenda(db: Db, campaignId: number, agendaId: number): { agenda: WorldAgenda; faction: WorldFaction } {
  const agenda = listAgendas(db, campaignId).find((entry) => entry.id === agendaId);
  if (!agenda) throw new Error(`No agenda ${agendaId} in this campaign.`);
  if (agenda.status !== 'active' && agenda.status !== 'held') {
    throw new Error(`Agenda ${agendaId} is already ${agenda.status}.`);
  }
  const faction = listFactions(db, campaignId).find((entry) => entry.id === agenda.faction_id);
  if (!faction) throw new Error(`Agenda ${agendaId} belongs to a faction that has ended.`);
  return { agenda, faction };
}

/** A player-safe sentence about an agenda: danger sites by their surroundings, a secret rival unnamed. */
function agendaText(
  db: Db,
  campaignId: number,
  view: RegionView,
  agenda: WorldAgenda,
  faction: WorldFaction,
  text: string,
): string {
  const rival =
    agenda.target_kind === 'rival_faction' && agenda.target_id !== null
      ? listFactions(db, campaignId, { includeEnded: true }).find((entry) => entry.id === agenda.target_id)
      : undefined;
  const target = {
    kind: agenda.target_kind,
    id: agenda.target_id,
    name: rival?.secrecy === 'secret' ? 'a hidden rival' : agenda.target_name,
  };
  const place = view.places.find((entry) => entry.id === faction.place_id) ?? null;
  return publicText(view, faction, target, place, text);
}

/** Lowers an agenda's clock by 1 to 3 (never below 0); a held agenda goes back to active. */
export function setbackAgenda(
  db: Db,
  campaignId: number,
  agendaId: number,
  amount: number,
  reason: string,
  day: number,
): { agenda: WorldAgenda; event: WorldEvent } {
  if (!Number.isInteger(amount) || amount < 1 || amount > 3) {
    throw new Error('A setback lowers the clock by 1, 2 or 3.');
  }
  const why = requireReason(reason);
  const { agenda, faction } = openAgenda(db, campaignId, agendaId);
  const view = requireRegion(db, campaignId);
  const filled = Math.max(0, agenda.clock_filled - amount);
  const text = agendaText(db, campaignId, view, agenda, faction, "{faction}'s designs on {target} suffer a setback.");

  return db.transaction(() => {
    const updated = updateAgenda(db, campaignId, agenda.id, { clock_filled: filled, status: 'active' });
    const event = insertEvent(db, campaignId, {
      day,
      kind: 'agenda_setback',
      text,
      severity: 2,
      place_id: agendaPlaceId(db, campaignId, agenda),
      faction_id: faction.id,
      agenda_id: agenda.id,
      causes: [],
      effects: { reason: why, clock_from: agenda.clock_filled, clock_to: filled },
      visibility: visibilityFor(faction.secrecy),
    });
    emitPacket(db, campaignId, event);
    return { agenda: updated, event };
  })();
}

/** Ends an agenda as lost and costs its faction one resource; a new agenda waits THWART_COOLDOWN_DAYS. */
export function thwartAgenda(
  db: Db,
  campaignId: number,
  agendaId: number,
  reason: string,
  day: number,
): { agenda: WorldAgenda; faction: WorldFaction; event: WorldEvent; cooldown_until: number } {
  const why = requireReason(reason);
  const { agenda, faction } = openAgenda(db, campaignId, agendaId);
  const view = requireRegion(db, campaignId);
  const resources = clampResources(faction.resources - 1);
  const text = agendaText(db, campaignId, view, agenda, faction, "{faction}'s designs on {target} come to nothing.");

  return db.transaction(() => {
    const lost = updateAgenda(db, campaignId, agenda.id, { status: 'lost', resolved_day: day });
    const weakened = updateFaction(db, campaignId, faction.id, { resources });
    const event = insertEvent(db, campaignId, {
      day,
      kind: 'agenda_lost',
      text,
      severity: 3,
      place_id: agendaPlaceId(db, campaignId, agenda),
      faction_id: faction.id,
      agenda_id: agenda.id,
      causes: [],
      effects: { reason: why, resources: resources - faction.resources },
      visibility: visibilityFor(faction.secrecy),
    });
    emitPacket(db, campaignId, event);
    return { agenda: lost, faction: weakened, event, cooldown_until: day + THWART_COOLDOWN_DAYS };
  })();
}

/**
 * The first day a faction may take up a new agenda after its latest thwarted one, or null when none was
 * ever thwarted. An agenda picker skips the faction while this is greater than the day.
 */
export function agendaCooldownUntil(db: Db, campaignId: number, factionId: number): number | null {
  const days = listAgendas(db, campaignId, { status: 'lost', factionId })
    .map((agenda) => agenda.resolved_day)
    .filter((day): day is number => day !== null);
  return days.length > 0 ? Math.max(...days) + THWART_COOLDOWN_DAYS : null;
}

/** Ends a faction on `day` and abandons every agenda it still had in play. */
export function destroyFaction(
  db: Db,
  campaignId: number,
  factionId: number,
  reason: string,
  day: number,
): { faction: WorldFaction; abandoned: WorldAgenda[]; event: WorldEvent } {
  const why = requireReason(reason);
  const faction = listFactions(db, campaignId, { includeEnded: true }).find((entry) => entry.id === factionId);
  if (!faction) throw new Error(`No faction ${factionId} in this campaign.`);
  if (faction.ended_day != null) throw new Error(`${faction.name} already ended on day ${faction.ended_day}.`);
  const view = requireRegion(db, campaignId);
  const place = view.places.find((entry) => entry.id === faction.place_id) ?? null;
  const brood = faction.type === 'monsters';
  const sentence = brood && place ? '{faction} near {place} is wiped out.' : '{faction} is no more.';
  const text = publicText(view, faction, NO_TARGET, place, sentence);
  const inPlay = listAgendas(db, campaignId, { factionId }).filter(
    (agenda) => agenda.status === 'active' || agenda.status === 'held',
  );

  return db.transaction(() => {
    const ended = updateFaction(db, campaignId, faction.id, { ended_day: day });
    const abandoned = inPlay.map((agenda) =>
      updateAgenda(db, campaignId, agenda.id, { status: 'abandoned', resolved_day: day }),
    );
    const event = insertEvent(db, campaignId, {
      day,
      kind: 'faction_destroyed',
      text,
      // A cleared lair is regional news; a fallen power travels further.
      severity: brood ? 3 : 4,
      place_id: faction.place_id,
      faction_id: faction.id,
      agenda_id: null,
      causes: [],
      effects: { reason: why, abandoned: abandoned.map((agenda) => agenda.id) },
      visibility: visibilityFor(faction.secrecy),
    });
    emitPacket(db, campaignId, event);
    return { faction: ended, abandoned, event };
  })();
}

/** Destroys every living brood lairing at a danger site the party has cleared. */
export function clearDanger(
  db: Db,
  campaignId: number,
  placeId: number,
  day: number,
): Array<ReturnType<typeof destroyFaction>> {
  const view = requireRegion(db, campaignId);
  const place = view.places.find((entry) => entry.id === placeId);
  if (!place || place.kind !== 'danger') throw new Error(`No danger site ${placeId} in this campaign.`);
  const broods = listFactions(db, campaignId).filter(
    (faction) => faction.type === 'monsters' && faction.place_id === placeId,
  );
  return db.transaction(() =>
    broods.map((brood) => destroyFaction(db, campaignId, brood.id, 'its lair was cleared', day)),
  )();
}
