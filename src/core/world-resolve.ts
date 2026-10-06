// The resolution side of the living world: firing an agenda's portents, deciding whether a finished
// agenda may resolve, resolving it into a ledger event and the map state it leaves, and delivering its news.
import type { Db } from '../db/connection.js';
import { AGENDA_TEMPLATES, fillText, type AgendaTemplate } from './agenda-templates.js';
import { getPolitics } from './politics-store.js';
import { findPlace, getRegion } from './region.js';
import { ensureFactionEntity, linkKnownFactions } from './world-codex.js';
import { factionFaith } from './world-faith-store.js';
import { deliverNews, emitPacket } from './world-news.js';
import {
  getPlaceState,
  liftSiegesBy,
  setPlaceState,
  transferCounty,
  type CountyTransfer,
  type PlaceStateKind,
} from './world-place-state.js';
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
import { destroyFaction } from './world-thwart.js';

/** How long a known, unheard irreversible agenda is held before it goes ahead without the party. */
export const HOLD_TIMEOUT_DAYS = 30;

export const clampResources = (value: number): number => Math.max(0, Math.min(10, value));

function factionOf(db: Db, campaignId: number, id: number): WorldFaction | undefined {
  return listFactions(db, campaignId, { includeEnded: true }).find((faction) => faction.id === id);
}

/** A faction's secrecy decides who may see an event it caused. */
export function visibilityFor(secrecy: WorldFaction['secrecy']): WorldEvent['visibility'] {
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

/** True when the agenda's target faction has ended, or no living brood lairs at its target danger. */
function targetEnded(db: Db, campaignId: number, agenda: WorldAgenda): boolean {
  if (agenda.target_id === null) return false;
  if (agenda.target_kind === 'rival_faction') return factionOf(db, campaignId, agenda.target_id)?.ended_day != null;
  return agenda.target_kind === 'danger' && targetFactionOf(db, campaignId, agenda) === undefined;
}

/** A player-safe sentence about an agenda: danger sites by their surroundings, a secret rival unnamed. */
function agendaText(db: Db, campaignId: number, agenda: WorldAgenda, faction: WorldFaction, text: string): string {
  const rival =
    agenda.target_kind === 'rival_faction' && agenda.target_id !== null
      ? factionOf(db, campaignId, agenda.target_id)
      : undefined;
  const target = rival?.secrecy === 'secret' ? 'a hidden rival' : agenda.target_name;
  const view = getRegion(db, campaignId);
  if (!view) {
    const placeId = agendaPlaceId(db, campaignId, agenda);
    const place = placeId !== null ? findPlace(db, campaignId, placeId) : undefined;
    return fillText(text, { faction: faction.name, target, place: place?.name });
  }
  const factionPlace =
    faction.place_id !== null ? view.places.find((entry) => entry.id === faction.place_id) ?? null : null;
  const targetRef = { kind: agenda.target_kind, id: agenda.target_id, name: target };
  return publicText(view, faction, targetRef, factionPlace, text);
}

/** What a win leaves: its outcome, which picks the win text, its ledger effects and the writes that cite its event. */
interface WinPlan {
  outcome: string;
  effects: Record<string, unknown>;
  /** Returns the follow-up event it wrote, if any. */
  apply?: (eventId: number) => WorldEvent | void;
}

/**
 * Takes the target county for the winning realm; a refusal from transferCounty becomes a border victory. A house
 * seated in the county now holds under the taker and drops its revolt against its former crown, and a duchy seated
 * there is left without a seat.
 */
function planExpansion(db: Db, campaignId: number, agenda: WorldAgenda, faction: WorldFaction, day: number): WinPlan {
  const politics = getPolitics(db, campaignId);
  const county = politics?.counties.find((entry) => entry.id === agenda.target_id);
  if (!politics || !county || faction.realm_id === null) {
    return { outcome: 'border_victory', effects: { refused: `${faction.name} has no county or realm to take.` } };
  }
  let transfer: CountyTransfer;
  try {
    transfer = transferCounty(db, campaignId, county.id, faction.realm_id);
  } catch (error) {
    return { outcome: 'border_victory', effects: { refused: (error as Error).message } };
  }

  const houses = (
    db
      .prepare(
        "SELECT id FROM world_faction WHERE campaign_id = ? AND type = 'house' AND county_id = ? AND ended_day IS NULL",
      )
      .all(campaignId, county.id) as Array<{ id: number }>
  ).map((row) => row.id);
  const moveHouse = db.prepare('UPDATE world_faction SET realm_id = ? WHERE id = ? AND campaign_id = ?');
  for (const id of houses) moveHouse.run(transfer.to_realm_id, id, campaignId);
  const formerCrowns = new Set(
    listFactions(db, campaignId)
      .filter((entry) => entry.type === 'realm' && entry.realm_id === transfer.from_realm_id)
      .map((entry) => entry.id),
  );
  const abandoned = listAgendas(db, campaignId)
    .filter(
      (entry) =>
        houses.includes(entry.faction_id) &&
        entry.template === 'revolt' &&
        (entry.status === 'active' || entry.status === 'held') &&
        entry.target_kind === 'rival_faction' &&
        formerCrowns.has(entry.target_id ?? -1),
    )
    .map((entry) => updateAgenda(db, campaignId, entry.id, { status: 'abandoned', resolved_day: day }).id);
  const duchy = politics.duchies.find((entry) => entry.id === county.duchy_id);
  const unseated = duchy !== undefined && duchy.seat_place_id === county.seat_place_id ? duchy.id : null;
  if (unseated !== null) {
    db.prepare('UPDATE world_duchy SET seat_place_id = NULL WHERE id = ? AND campaign_id = ?').run(
      unseated,
      campaignId,
    );
  }
  return { outcome: 'county_transferred', effects: { ...transfer, houses, duchy_unseated: unseated, abandoned } };
}

/** A vassal realm still sworn to the target goes free; anyone else, as a house, wrings concessions instead. */
function planRevolt(db: Db, campaignId: number, faction: WorldFaction, liege: WorldFaction | undefined): WinPlan {
  const realm = getPolitics(db, campaignId)?.realms.find((entry) => entry.id === faction.realm_id);
  const sworn = realm !== undefined && realm.liege_realm_id !== null && realm.liege_realm_id === liege?.realm_id;
  if (faction.type !== 'realm' || !sworn || !realm || !liege) return { outcome: 'concessions', effects: {} };
  db.prepare('UPDATE world_realm SET liege_realm_id = NULL WHERE id = ? AND campaign_id = ?').run(realm.id, campaignId);
  return { outcome: 'independence', effects: { realm_id: realm.id, former_liege_realm_id: liege.realm_id } };
}

/** Sets a place's state once the win event exists to be its cause. */
function placeStatePlan(db: Db, campaignId: number, placeId: number, state: PlaceStateKind, day: number): WinPlan {
  return {
    outcome: state,
    effects: { place_id: placeId, state },
    apply: (eventId) => {
      setPlaceState(db, campaignId, placeId, day, { state, cause_event_id: eventId });
    },
  };
}

/** Decides a win's lasting effect before its event is written; a template with no map state changes nothing. */
function planWin(
  db: Db,
  campaignId: number,
  agenda: WorldAgenda,
  faction: WorldFaction,
  target: WorldFaction | undefined,
  targetResources: number | null,
  day: number,
): WinPlan {
  const placeId = agenda.target_kind === 'settlement' ? agenda.target_id : null;
  const current = placeId !== null ? getPlaceState(db, campaignId, placeId, day)?.state : undefined;
  switch (agenda.template) {
    case 'expand_territory':
      return planExpansion(db, campaignId, agenda, faction, day);
    case 'revolt':
      return planRevolt(db, campaignId, faction, target);
    case 'raid':
      // A raid renews a raid but never eases a siege or a ruin into a lighter state.
      if (placeId === null || current === 'besieged' || current === 'ruined') break;
      return placeStatePlan(db, campaignId, placeId, 'raided', day);
    case 'monsters_grow':
      if (placeId === null) break;
      return placeStatePlan(db, campaignId, placeId, current ? 'ruined' : 'besieged', day);
    case 'conversion': {
      const faithId = factionFaith(db, campaignId, faction.id).faith_id;
      if (placeId === null || faithId === null) break;
      return {
        outcome: 'converted',
        effects: { place_id: placeId, faith_id: faithId },
        apply: () => {
          setPlaceState(db, campaignId, placeId, day, { faith_id: faithId });
        },
      };
    }
    case 'hunt_monster':
    case 'crusade':
      if (target?.type !== 'monsters' || targetResources !== 0) break;
      return {
        outcome: 'brood_destroyed',
        effects: { destroyed_faction_id: target.id },
        apply: () => {
          // A brood's sieges end with it.
          liftSiegesBy(db, campaignId, target.id, day);
          const deed = agenda.template === 'crusade' ? 'purged' : 'hunted down';
          return destroyFaction(db, campaignId, target.id, `${deed} by ${faction.name}`, day).event;
        },
      };
    case 'persecute':
      if (target && targetResources === 0) return { outcome: 'underground', effects: {} };
      break;
  }
  return { outcome: 'no_change', effects: {} };
}

/** The win text for an outcome: its own variant when the template has one, else the usual text. */
function winText(template: AgendaTemplate, outcome: string): string {
  return template.on_win.variants?.[outcome] ?? template.on_win.text;
}

/** A resolution's event, the faction's next agenda and any follow-up event, such as a brood the win destroyed. */
export interface Resolution {
  event: WorldEvent;
  next: WorldAgenda | null;
  consequences: WorldEvent[];
}

/**
 * Ends an agenda whose target is gone without a win: no resources move, and its faction is left idle for the
 * tick's re-pick. Its secret event keeps the ledger causal without sending news.
 */
function abandonAgenda(
  db: Db,
  campaignId: number,
  agenda: WorldAgenda,
  faction: WorldFaction,
  day: number,
  causes: number[],
): Resolution {
  updateAgenda(db, campaignId, agenda.id, { status: 'abandoned', resolved_day: day });
  const event = insertEvent(db, campaignId, {
    day,
    kind: 'agenda_abandoned',
    text: agendaText(db, campaignId, agenda, faction, '{faction} gives up its designs on {target}, which is no more'),
    severity: 1,
    place_id: agendaPlaceId(db, campaignId, agenda),
    faction_id: faction.id,
    agenda_id: agenda.id,
    causes,
    effects: { reason: 'target ended' },
    visibility: 'secret',
  });
  return { event, next: null, consequences: [] };
}

/**
 * Resolves a finished agenda: the won event, both sides' resources, the map state the win leaves and the faction's
 * next agenda. An agenda whose target has ended is abandoned instead, and one no longer active or held is refused.
 */
export function resolveAgenda(
  db: Db,
  campaignId: number,
  agenda: WorldAgenda,
  day: number,
  seed: number,
): Resolution {
  return db.transaction(() => {
    const stored = listAgendas(db, campaignId, { factionId: agenda.faction_id }).find((entry) => entry.id === agenda.id);
    if (!stored) throw new Error(`No agenda ${agenda.id} in this campaign.`);
    if (stored.status !== 'active' && stored.status !== 'held') {
      throw new Error(`Agenda ${agenda.id} is already ${stored.status}.`);
    }
    const template = AGENDA_TEMPLATES.find((entry) => entry.id === agenda.template);
    if (!template) throw new Error(`Unknown agenda template "${agenda.template}".`);
    const faction = factionOf(db, campaignId, agenda.faction_id);
    if (!faction) throw new Error(`No faction ${agenda.faction_id} for agenda ${agenda.id}.`);
    const causes = (
      db
        .prepare("SELECT id FROM world_event WHERE campaign_id = ? AND agenda_id = ? AND kind = 'portent' ORDER BY id")
        .all(campaignId, agenda.id) as Array<{ id: number }>
    ).map((row) => row.id);
    if (targetEnded(db, campaignId, agenda)) return abandonAgenda(db, campaignId, agenda, faction, day, causes);

    const placeId = agendaPlaceId(db, campaignId, agenda);
    const place = placeId !== null ? findPlace(db, campaignId, placeId) : undefined;
    // An unheard hold that reached its timeout goes ahead without the party, so its news must reach the whole map.
    const wentAheadOnTimeout =
      template.on_win.irreversible && place?.known_to_party === true && heardCount(agenda) < 2;
    const targetFaction = targetFactionOf(db, campaignId, agenda);
    const targetResources = targetFaction
      ? clampResources(targetFaction.resources + template.on_win.target_resources)
      : null;
    const plan = planWin(db, campaignId, agenda, faction, targetFaction, targetResources, day);

    const event = insertEvent(db, campaignId, {
      day,
      kind: 'agenda_won',
      text: agendaText(db, campaignId, agenda, faction, winText(template, plan.outcome)),
      severity: template.on_win.severity,
      place_id: placeId,
      faction_id: agenda.faction_id,
      agenda_id: agenda.id,
      causes,
      effects: {
        resources: template.on_win.resources,
        target_resources: template.on_win.target_resources,
        outcome: plan.outcome,
        ...plan.effects,
      },
      visibility: visibilityFor(faction.secrecy),
    });

    updateFaction(db, campaignId, faction.id, {
      resources: clampResources(faction.resources + template.on_win.resources),
    });
    if (targetFaction && targetResources !== null) {
      updateFaction(db, campaignId, targetFaction.id, { resources: targetResources });
    }

    updateAgenda(db, campaignId, agenda.id, {
      status: 'won',
      resolved_day: day,
      clock_filled: agenda.clock_size,
    });
    emitPacket(db, campaignId, event, wentAheadOnTimeout ? { radiusDays: Infinity } : {});
    const followUp = plan.apply?.(event.id);

    const next = pickAgenda(db, campaignId, faction, day, seed, agenda.started_day + 1);
    return { event, next, consequences: followUp ? [followUp] : [] };
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
