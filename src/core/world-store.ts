// Storage for the living world: per-campaign world state, factions, their agendas, the causal event
// ledger and the news packets that carry events between places.
import type { Db } from '../db/connection.js';
import { DAYS_PER_MONTH, MONTHS_PER_YEAR, getCalendar, type Calendar } from './calendar.js';

/**
 * A campaign's world day number. Month and day are 1-based (calendar.ts), so day 1 of month 1 of
 * year 1 is 361 and consecutive calendar days differ by one.
 */
export function gameDay(cal: Pick<Calendar, 'year' | 'month' | 'day'>): number {
  return (cal.year * MONTHS_PER_YEAR + (cal.month - 1)) * DAYS_PER_MONTH + cal.day;
}

export function currentGameDay(db: Db, campaignId: number): number {
  return gameDay(getCalendar(db, campaignId));
}

export interface WorldState {
  seed: number;
  last_tick_day: number;
  quiet_until_day: number;
}

export interface Portent {
  text: string;
  fired_day: number | null;
  heard: boolean;
}

export interface WorldFaction {
  id: number;
  name: string;
  type: string;
  realm_id: number | null;
  county_id: number | null;
  place_id: number | null;
  secrecy: 'open' | 'discreet' | 'secret';
  resources: number;
  capacities: Record<string, number>;
  entity_id: number | null;
  created_day: number;
}

export interface WorldAgenda {
  id: number;
  faction_id: number;
  template: string;
  target_kind: string;
  target_id: number | null;
  target_name: string;
  clock_size: number;
  clock_filled: number;
  portents: Portent[];
  status: 'active' | 'won' | 'lost' | 'held' | 'abandoned';
  known_to_party: boolean;
  started_day: number;
  resolved_day: number | null;
}

export interface WorldEvent {
  id: number;
  day: number;
  kind: string;
  text: string;
  severity: number;
  place_id: number | null;
  faction_id: number | null;
  agenda_id: number | null;
  causes: number[];
  effects: Record<string, unknown>;
  visibility: 'public' | 'discreet' | 'secret';
}

interface WorldStateRow {
  seed: number;
  last_tick_day: number;
  quiet_until_day: number;
}

interface FactionRow {
  id: number;
  name: string;
  type: string;
  realm_id: number | null;
  county_id: number | null;
  place_id: number | null;
  secrecy: WorldFaction['secrecy'];
  resources: number;
  capacities_json: string;
  entity_id: number | null;
  created_day: number;
}

interface AgendaRow {
  id: number;
  faction_id: number;
  template: string;
  target_kind: string;
  target_id: number | null;
  target_name: string;
  clock_size: number;
  clock_filled: number;
  portents_json: string;
  status: WorldAgenda['status'];
  known_to_party: number;
  started_day: number;
  resolved_day: number | null;
}

interface EventRow {
  id: number;
  day: number;
  kind: string;
  text: string;
  severity: number;
  place_id: number | null;
  faction_id: number | null;
  agenda_id: number | null;
  causes_json: string;
  effects_json: string;
  visibility: WorldEvent['visibility'];
}

const FACTION_COLUMNS =
  'id, name, type, realm_id, county_id, place_id, secrecy, resources, capacities_json, entity_id, created_day';
const AGENDA_COLUMNS =
  'id, faction_id, template, target_kind, target_id, target_name, clock_size, clock_filled, portents_json, status, known_to_party, started_day, resolved_day';
const EVENT_COLUMNS =
  'id, day, kind, text, severity, place_id, faction_id, agenda_id, causes_json, effects_json, visibility';

function factionFromRow(row: FactionRow): WorldFaction {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    realm_id: row.realm_id,
    county_id: row.county_id,
    place_id: row.place_id,
    secrecy: row.secrecy,
    resources: row.resources,
    capacities: JSON.parse(row.capacities_json) as Record<string, number>,
    entity_id: row.entity_id,
    created_day: row.created_day,
  };
}

function agendaFromRow(row: AgendaRow): WorldAgenda {
  return {
    id: row.id,
    faction_id: row.faction_id,
    template: row.template,
    target_kind: row.target_kind,
    target_id: row.target_id,
    target_name: row.target_name,
    clock_size: row.clock_size,
    clock_filled: row.clock_filled,
    portents: JSON.parse(row.portents_json) as Portent[],
    status: row.status,
    known_to_party: row.known_to_party === 1,
    started_day: row.started_day,
    resolved_day: row.resolved_day,
  };
}

function eventFromRow(row: EventRow): WorldEvent {
  return {
    id: row.id,
    day: row.day,
    kind: row.kind,
    text: row.text,
    severity: row.severity,
    place_id: row.place_id,
    faction_id: row.faction_id,
    agenda_id: row.agenda_id,
    causes: JSON.parse(row.causes_json) as number[],
    effects: JSON.parse(row.effects_json) as Record<string, unknown>,
    visibility: row.visibility,
  };
}

function getFactionById(db: Db, campaignId: number, id: number): WorldFaction | undefined {
  const row = db
    .prepare(`SELECT ${FACTION_COLUMNS} FROM world_faction WHERE campaign_id = ? AND id = ?`)
    .get(campaignId, id) as FactionRow | undefined;
  return row ? factionFromRow(row) : undefined;
}

function getAgendaById(db: Db, campaignId: number, id: number): WorldAgenda | undefined {
  const row = db
    .prepare(`SELECT ${AGENDA_COLUMNS} FROM world_agenda WHERE campaign_id = ? AND id = ?`)
    .get(campaignId, id) as AgendaRow | undefined;
  return row ? agendaFromRow(row) : undefined;
}

export function getWorldState(db: Db, campaignId: number): WorldState | null {
  const row = db
    .prepare('SELECT seed, last_tick_day, quiet_until_day FROM world_state WHERE campaign_id = ?')
    .get(campaignId) as WorldStateRow | undefined;
  return row ? { seed: row.seed, last_tick_day: row.last_tick_day, quiet_until_day: row.quiet_until_day } : null;
}

export function saveWorldState(db: Db, campaignId: number, state: WorldState): void {
  db.prepare(
    `INSERT INTO world_state (campaign_id, seed, last_tick_day, quiet_until_day) VALUES (?, ?, ?, ?)
     ON CONFLICT(campaign_id) DO UPDATE SET
       seed = excluded.seed,
       last_tick_day = excluded.last_tick_day,
       quiet_until_day = excluded.quiet_until_day`,
  ).run(campaignId, state.seed, state.last_tick_day, state.quiet_until_day);
}

export function insertFaction(
  db: Db,
  campaignId: number,
  f: Omit<WorldFaction, 'id' | 'entity_id'> & { entity_id?: number | null },
): WorldFaction {
  const info = db
    .prepare(
      `INSERT INTO world_faction
         (campaign_id, name, type, realm_id, county_id, place_id, secrecy, resources, capacities_json, entity_id, created_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      campaignId,
      f.name,
      f.type,
      f.realm_id,
      f.county_id,
      f.place_id,
      f.secrecy,
      f.resources,
      JSON.stringify(f.capacities),
      f.entity_id ?? null,
      f.created_day,
    );
  return getFactionById(db, campaignId, Number(info.lastInsertRowid))!;
}

export function listFactions(db: Db, campaignId: number): WorldFaction[] {
  const rows = db
    .prepare(`SELECT ${FACTION_COLUMNS} FROM world_faction WHERE campaign_id = ? ORDER BY id`)
    .all(campaignId) as FactionRow[];
  return rows.map(factionFromRow);
}

export function updateFaction(
  db: Db,
  campaignId: number,
  id: number,
  patch: Partial<Pick<WorldFaction, 'resources' | 'entity_id' | 'secrecy'>>,
): WorldFaction {
  if (!getFactionById(db, campaignId, id)) throw new Error(`No faction ${id} in this campaign.`);

  const sets: string[] = [];
  const values: Array<number | string | null> = [];
  if (patch.resources !== undefined) {
    sets.push('resources = ?');
    values.push(patch.resources);
  }
  if (patch.entity_id !== undefined) {
    sets.push('entity_id = ?');
    values.push(patch.entity_id);
  }
  if (patch.secrecy !== undefined) {
    sets.push('secrecy = ?');
    values.push(patch.secrecy);
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE world_faction SET ${sets.join(', ')} WHERE id = ? AND campaign_id = ?`).run(
      ...values,
      id,
      campaignId,
    );
  }
  return getFactionById(db, campaignId, id)!;
}

export function insertAgenda(
  db: Db,
  campaignId: number,
  a: Omit<WorldAgenda, 'id' | 'resolved_day' | 'known_to_party'> & { known_to_party?: boolean },
): WorldAgenda {
  const info = db
    .prepare(
      `INSERT INTO world_agenda
         (campaign_id, faction_id, template, target_kind, target_id, target_name, clock_size, clock_filled,
          portents_json, status, known_to_party, started_day, resolved_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      campaignId,
      a.faction_id,
      a.template,
      a.target_kind,
      a.target_id,
      a.target_name,
      a.clock_size,
      a.clock_filled,
      JSON.stringify(a.portents),
      a.status,
      a.known_to_party ? 1 : 0,
      a.started_day,
    );
  return getAgendaById(db, campaignId, Number(info.lastInsertRowid))!;
}

export function listAgendas(
  db: Db,
  campaignId: number,
  options: { status?: WorldAgenda['status']; factionId?: number } = {},
): WorldAgenda[] {
  const clauses: string[] = [];
  const values: Array<number | string> = [campaignId];
  if (options.status !== undefined) {
    clauses.push('status = ?');
    values.push(options.status);
  }
  if (options.factionId !== undefined) {
    clauses.push('faction_id = ?');
    values.push(options.factionId);
  }
  const where = clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT ${AGENDA_COLUMNS} FROM world_agenda WHERE campaign_id = ?${where} ORDER BY id`)
    .all(...values) as AgendaRow[];
  return rows.map(agendaFromRow);
}

export function updateAgenda(
  db: Db,
  campaignId: number,
  id: number,
  patch: Partial<Pick<WorldAgenda, 'clock_filled' | 'portents' | 'status' | 'known_to_party' | 'resolved_day'>>,
): WorldAgenda {
  if (!getAgendaById(db, campaignId, id)) throw new Error(`No agenda ${id} in this campaign.`);

  const sets: string[] = [];
  const values: Array<number | string | null> = [];
  if (patch.clock_filled !== undefined) {
    sets.push('clock_filled = ?');
    values.push(patch.clock_filled);
  }
  if (patch.portents !== undefined) {
    sets.push('portents_json = ?');
    values.push(JSON.stringify(patch.portents));
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.known_to_party !== undefined) {
    sets.push('known_to_party = ?');
    values.push(patch.known_to_party ? 1 : 0);
  }
  if (patch.resolved_day !== undefined) {
    sets.push('resolved_day = ?');
    values.push(patch.resolved_day);
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE world_agenda SET ${sets.join(', ')} WHERE id = ? AND campaign_id = ?`).run(
      ...values,
      id,
      campaignId,
    );
  }
  return getAgendaById(db, campaignId, id)!;
}

export function insertEvent(db: Db, campaignId: number, e: Omit<WorldEvent, 'id'>): WorldEvent {
  const info = db
    .prepare(
      `INSERT INTO world_event
         (campaign_id, day, kind, text, severity, place_id, faction_id, agenda_id, causes_json, effects_json, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      campaignId,
      e.day,
      e.kind,
      e.text,
      e.severity,
      e.place_id,
      e.faction_id,
      e.agenda_id,
      JSON.stringify(e.causes),
      JSON.stringify(e.effects),
      e.visibility,
    );
  const row = db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM world_event WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as EventRow;
  return eventFromRow(row);
}

export function listEvents(
  db: Db,
  campaignId: number,
  options: { fromDay?: number; toDay?: number; placeId?: number; minSeverity?: number } = {},
): WorldEvent[] {
  const clauses: string[] = [];
  const values: number[] = [campaignId];
  if (options.fromDay !== undefined) {
    clauses.push('day >= ?');
    values.push(options.fromDay);
  }
  if (options.toDay !== undefined) {
    clauses.push('day <= ?');
    values.push(options.toDay);
  }
  if (options.placeId !== undefined) {
    clauses.push('place_id = ?');
    values.push(options.placeId);
  }
  if (options.minSeverity !== undefined) {
    clauses.push('severity >= ?');
    values.push(options.minSeverity);
  }
  const where = clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM world_event WHERE campaign_id = ?${where} ORDER BY day, id`)
    .all(...values) as EventRow[];
  return rows.map(eventFromRow);
}
