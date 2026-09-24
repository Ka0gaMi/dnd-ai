// The resolution side of the living world: firing an agenda's portents, deciding whether a finished
// agenda may resolve, resolving it into a ledger event, and delivering its news to the party.
import type { Db } from '../db/connection.js';
import { AGENDA_TEMPLATES, fillText } from './agenda-templates.js';
import { getPolitics } from './politics-store.js';
import { findPlace, getRegion } from './region.js';
import { ensureFactionEntity, linkKnownFactions } from './world-codex.js';
import { deliverNews, emitPacket } from './world-news.js';
import { pickAgenda, publicText } from './world-seed.js';
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

/** How long a known, unheard irreversible agenda is held before it goes ahead without the party. */
export const HOLD_TIMEOUT_DAYS = 30;

const clampResources = (value: number): number => Math.max(0, Math.min(10, value));

function factionOf(db: Db, campaignId: number, id: number): WorldFaction | undefined {
  return listFactions(db, campaignId).find((faction) => faction.id === id);
}

/** A faction's secrecy decides who may see an event it caused. */
function visibilityFor(secrecy: WorldFaction['secrecy']): WorldEvent['visibility'] {
  if (secrecy === 'open') return 'public';
  return secrecy === 'discreet' ? 'discreet' : 'secret';
}

/** Where an agenda's consequences land: its target for most rules, its own seat when it has none. */
export function agendaPlaceId(db: Db, campaignId: number, agenda: WorldAgenda): number | null {
  const target = agenda.target_id;
  if (target !== null) {
    switch (agenda.target_kind) {
      case 'settlement':
      case 'own_seat':
      case 'danger':
        return target;
      case 'neighbour_county': {
        const county = getPolitics(db, campaignId)?.counties.find((entry) => entry.id === target);
        if (county) return county.seat_place_id;
        break;
      }
      case 'rival_faction': {
        const rival = factionOf(db, campaignId, target);
        if (rival?.place_id != null) return rival.place_id;
        break;
      }
    }
  }
  return factionOf(db, campaignId, agenda.faction_id)?.place_id ?? null;
}

/** Writes a portent as a public, discreet or secret event and sends its news on the road. */
export function firePortent(
  db: Db,
  campaignId: number,
  agenda: WorldAgenda,
  index: number,
  day: number,
): WorldEvent {
  const faction = factionOf(db, campaignId, agenda.faction_id);
  return db.transaction(() => {
    const event = insertEvent(db, campaignId, {
      day,
      kind: 'portent',
      text: agenda.portents[index]!.text,
      severity: 2,
      place_id: agendaPlaceId(db, campaignId, agenda),
      faction_id: agenda.faction_id,
      agenda_id: agenda.id,
      causes: [],
      effects: { portent: index },
      visibility: faction ? visibilityFor(faction.secrecy) : 'public',
    });
    updateAgenda(db, campaignId, agenda.id, {
      portents: agenda.portents.map((portent, i) => (i === index ? { ...portent, fired_day: day } : portent)),
    });
    emitPacket(db, campaignId, event);
    return event;
  })();
}

/** How many of an agenda's portents the party has already heard. */
export function heardCount(agenda: WorldAgenda): number {
  return agenda.portents.filter((portent) => portent.heard).length;
}

/**
 * A known irreversible agenda is held until the party has heard two of its portents, but goes ahead
 * anyway once HOLD_TIMEOUT_DAYS have passed since its last portent; every other finished agenda resolves.
 */
export function canResolve(db: Db, campaignId: number, agenda: WorldAgenda, today: number): boolean {
  const template = AGENDA_TEMPLATES.find((entry) => entry.id === agenda.template);
  if (!template?.on_win.irreversible) return true;
  const placeId = agendaPlaceId(db, campaignId, agenda);
  if (placeId === null) return true;
  const place = findPlace(db, campaignId, placeId);
  if (!place?.known_to_party) return true;
  if (heardCount(agenda) >= 2) return true;
  const fired = agenda.portents
    .map((portent) => portent.fired_day)
    .filter((day): day is number => day !== null);
  const lastFired = fired.length > 0 ? Math.max(...fired) : agenda.started_day;
  return today >= lastFired + HOLD_TIMEOUT_DAYS;
}

/** The faction an agenda's outcome costs when its target is one (a rival, or a danger's brood). */
function targetFactionOf(db: Db, campaignId: number, agenda: WorldAgenda): WorldFaction | undefined {
  if (agenda.target_id === null) return undefined;
  if (agenda.target_kind === 'rival_faction') return factionOf(db, campaignId, agenda.target_id);
  if (agenda.target_kind === 'danger') {
    return listFactions(db, campaignId).find(
      (faction) => faction.type === 'monsters' && faction.place_id === agenda.target_id,
    );
  }
  return undefined;
}

/** Resolves a finished agenda: the won event, both sides' resources, and the faction's next agenda. */
export function resolveAgenda(
  db: Db,
  campaignId: number,
  agenda: WorldAgenda,
  day: number,
  seed: number,
): { event: WorldEvent; next: WorldAgenda | null } {
  return db.transaction(() => {
    const template = AGENDA_TEMPLATES.find((entry) => entry.id === agenda.template);
    if (!template) throw new Error(`Unknown agenda template "${agenda.template}".`);
    const faction = factionOf(db, campaignId, agenda.faction_id);
    if (!faction) throw new Error(`No faction ${agenda.faction_id} for agenda ${agenda.id}.`);

    const placeId = agendaPlaceId(db, campaignId, agenda);
    const place = placeId !== null ? findPlace(db, campaignId, placeId) : undefined;
    // An unheard hold that reached its timeout goes ahead without the party, so its news must reach the whole map.
    const wentAheadOnTimeout =
      template.on_win.irreversible && place?.known_to_party === true && heardCount(agenda) < 2;
    const view = getRegion(db, campaignId);
    const factionPlace =
      view && faction.place_id !== null
        ? view.places.find((entry) => entry.id === faction.place_id) ?? null
        : null;
    const causes = (
      db
        .prepare("SELECT id FROM world_event WHERE campaign_id = ? AND agenda_id = ? AND kind = 'portent' ORDER BY id")
        .all(campaignId, agenda.id) as Array<{ id: number }>
    ).map((row) => row.id);

    const event = insertEvent(db, campaignId, {
      day,
      kind: 'agenda_won',
      text: view
        ? publicText(
            view,
            faction,
            { kind: agenda.target_kind, id: agenda.target_id, name: agenda.target_name },
            factionPlace,
            template.on_win.text,
          )
        : fillText(template.on_win.text, {
            faction: faction.name,
            target: agenda.target_name,
            place: place?.name,
          }),
      severity: template.on_win.severity,
      place_id: placeId,
      faction_id: agenda.faction_id,
      agenda_id: agenda.id,
      causes,
      effects: {
        resources: template.on_win.resources,
        target_resources: template.on_win.target_resources,
      },
      visibility: visibilityFor(faction.secrecy),
    });

    updateFaction(db, campaignId, faction.id, {
      resources: clampResources(faction.resources + template.on_win.resources),
    });
    const targetFaction = targetFactionOf(db, campaignId, agenda);
    if (targetFaction) {
      updateFaction(db, campaignId, targetFaction.id, {
        resources: clampResources(targetFaction.resources + template.on_win.target_resources),
      });
    }

    updateAgenda(db, campaignId, agenda.id, {
      status: 'won',
      resolved_day: day,
      clock_filled: agenda.clock_size,
    });
    emitPacket(db, campaignId, event, wentAheadOnTimeout ? { radiusDays: Infinity } : {});

    const next = pickAgenda(db, campaignId, faction, day, seed, agenda.started_day + 1);
    return { event, next };
  })();
}

/**
 * Delivers the news waiting at a place, then marks the portents the party heard; an agenda with two
 * heard portents becomes a clock they know.
 */
export function deliverWorldNews(
  db: Db,
  campaignId: number,
  placeId: number,
  today: number,
): { rumours: Array<{ rumour_id: number; text: string; truth: string }>; discovered: WorldAgenda[] } {
  const rows = db
    .prepare(
      `SELECT e.agenda_id AS agenda_id, e.effects_json AS effects_json
         FROM world_packet_arrival a
         JOIN world_packet p ON p.id = a.packet_id
         JOIN world_event e ON e.id = p.event_id
        WHERE p.campaign_id = ? AND a.place_id = ? AND a.day <= ? AND a.heard = 0
        ORDER BY a.day, a.packet_id`,
    )
    .all(campaignId, placeId, today) as Array<{ agenda_id: number | null; effects_json: string }>;

  const byAgenda = new Map<number, number[]>();
  for (const row of rows) {
    if (row.agenda_id === null) continue;
    const portent = (JSON.parse(row.effects_json) as Record<string, unknown>).portent;
    if (typeof portent !== 'number') continue;
    const indices = byAgenda.get(row.agenda_id) ?? [];
    if (!indices.includes(portent)) indices.push(portent);
    byAgenda.set(row.agenda_id, indices);
  }

  return db.transaction(() => {
    linkKnownFactions(db, campaignId);
    const rumours = deliverNews(db, campaignId, placeId, today);
    const discovered: WorldAgenda[] = [];
    for (const [agendaId, indices] of byAgenda) {
      const agenda = listAgendas(db, campaignId).find((entry) => entry.id === agendaId);
      if (!agenda) continue;
      const updated = updateAgenda(db, campaignId, agenda.id, {
        portents: agenda.portents.map((portent, i) =>
          indices.includes(i) ? { ...portent, heard: true } : portent,
        ),
      });
      if (!updated.known_to_party && heardCount(updated) >= 2) {
        discovered.push(updateAgenda(db, campaignId, agenda.id, { known_to_party: true }));
      }
    }
    for (const agenda of discovered) {
      const faction = factionOf(db, campaignId, agenda.faction_id);
      if (faction) ensureFactionEntity(db, campaignId, faction);
    }
    return { rumours, discovered };
  })();
}
