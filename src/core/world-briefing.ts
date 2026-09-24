// The briefing's world block: what the living world is doing near the party and how it remembers
// them. Empty without a world, and the player's window never reads it.
import type { Db } from '../db/connection.js';
import { findPlace, type WorldPlace } from './region.js';
import { placeDistance } from './region-graph.js';
import { attitudeOf, lastVisit, recordVisit } from './world-memory.js';
import { agendaPlaceId, deliverWorldNews } from './world-resolve.js';
import { ensureWorld } from './world-seed.js';
import {
  currentGameDay,
  getWorldState,
  listAgendas,
  listEvents,
  listFactions,
  type Portent,
  type WorldAgenda,
} from './world-store.js';

const PORTENT_RANGE_HEXES = 8;
const PORTENT_LIMIT = 5;
const CLOCK_LIMIT = 6;
const NEWS_LIMIT = 5;
const ATTITUDE_LIMIT = 6;
const AWAY_LIMIT = 6;

const HEADER = 'World (DM only; weave these in, never read them out):';

/** The portent an agenda fired most recently, or null when none has fired yet. */
function latestFiredPortent(agenda: WorldAgenda): Portent | null {
  let best: Portent | null = null;
  let bestDay = -Infinity;
  for (const portent of agenda.portents) {
    if (portent.fired_day === null) continue;
    if (portent.fired_day >= bestDay) {
      best = portent;
      bestDay = portent.fired_day;
    }
  }
  return best;
}

/** Fired portents whose agenda lands within range of the party, nearest first. */
function portentLines(
  db: Db,
  campaignId: number,
  party: WorldPlace,
  factions: Map<number, string>,
): string[] {
  const entries: Array<{ hexes: number; text: string; faction: string }> = [];
  for (const agenda of listAgendas(db, campaignId)) {
    if (agenda.status !== 'active' && agenda.status !== 'held') continue;
    const portent = latestFiredPortent(agenda);
    if (!portent) continue;
    const placeId = agendaPlaceId(db, campaignId, agenda);
    if (placeId === null) continue;
    const place = findPlace(db, campaignId, placeId);
    if (!place) continue;
    const hexes = placeDistance(party, place);
    if (hexes > PORTENT_RANGE_HEXES) continue;
    entries.push({ hexes, text: portent.text, faction: factions.get(agenda.faction_id) ?? 'unknown faction' });
  }
  entries.sort((a, b) => a.hexes - b.hexes);
  return entries
    .slice(0, PORTENT_LIMIT)
    .map((entry) => `- ${entry.text} (${entry.faction}, ${entry.hexes} hexes away)`);
}

/** The clocks the party already knows about. */
function clockLines(db: Db, campaignId: number, factions: Map<number, string>): string[] {
  const lines: string[] = [];
  for (const agenda of listAgendas(db, campaignId)) {
    if (!agenda.known_to_party || (agenda.status !== 'active' && agenda.status !== 'held')) continue;
    lines.push(
      `- ${factions.get(agenda.faction_id) ?? 'unknown faction'}: ${agenda.template} -> ${agenda.target_name} [${agenda.clock_filled}/${agenda.clock_size}]`,
    );
    if (lines.length >= CLOCK_LIMIT) break;
  }
  return lines;
}

/** The latest news the world's packets delivered; other heard rumours already sit in the briefing. */
function newsLines(db: Db, campaignId: number): string[] {
  const rows = db
    .prepare(
      "SELECT text FROM rumour WHERE campaign_id = ? AND source_kind = 'world' AND heard_at IS NOT NULL ORDER BY id DESC LIMIT ?",
    )
    .all(campaignId, NEWS_LIMIT) as Array<{ text: string }>;
  return rows.map((row) => `- ${row.text}`);
}

/** Factions whose faded attitude toward the party is not zero today, strongest feeling first. */
function attitudeLines(db: Db, campaignId: number, today: number): string[] {
  const entries: Array<{ name: string; total: number; reason: string }> = [];
  for (const faction of listFactions(db, campaignId)) {
    const { total, reasons } = attitudeOf(db, campaignId, { kind: 'faction', id: faction.id }, today);
    if (total === 0 || reasons.length === 0) continue;
    entries.push({ name: faction.name, total, reason: reasons[0]!.reason });
  }
  entries.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  return entries.slice(0, ATTITUDE_LIMIT).map((entry) => `- ${entry.name}: ${entry.total} (${entry.reason})`);
}

/** Events at the party's settlement since their last recorded visit, oldest first. */
function awayLines(db: Db, campaignId: number, place: WorldPlace, today: number): string[] {
  const since = lastVisit(db, campaignId, place.id);
  if (since === null || since >= today) return [];
  return listEvents(db, campaignId, { placeId: place.id, fromDay: since + 1 })
    .slice(0, AWAY_LIMIT)
    .map((event) => `- day +${event.day - since}: ${event.text}`);
}

export function worldBriefing(db: Db, campaignId: number, location: string | null): string {
  if (getWorldState(db, campaignId) === null) return '';

  const today = currentGameDay(db, campaignId);
  const factions = new Map(listFactions(db, campaignId).map((faction) => [faction.id, faction.name]));
  const party = location !== null && location.trim() !== '' ? findPlace(db, campaignId, location) : undefined;

  const lines = [HEADER];

  if (party) {
    const portents = portentLines(db, campaignId, party, factions);
    if (portents.length > 0) lines.push('Portents near the party:', ...portents);
  }

  const clocks = clockLines(db, campaignId, factions);
  if (clocks.length > 0) lines.push('Known clocks:', ...clocks);

  const news = newsLines(db, campaignId);
  if (news.length > 0) lines.push('Heard news:', ...news);

  const attitudes = attitudeLines(db, campaignId, today);
  if (attitudes.length > 0) lines.push('How they regard the party:', ...attitudes);

  if (party?.kind === 'settlement') {
    const away = awayLines(db, campaignId, party, today);
    if (away.length > 0) lines.push(`While you were away from ${party.name}:`, ...away);
  }

  return lines.join('\n');
}

/** Records the party leaving and arriving, so world memory follows them between settlements. */
export function onPartyMoved(db: Db, campaignId: number, from: string | null, to: string): void {
  // A campaign's opening scenes come before any day passes, so the world is seeded here too.
  if (ensureWorld(db, campaignId) === null) return;
  const today = currentGameDay(db, campaignId);

  const previous = from ? findPlace(db, campaignId, from) : undefined;
  if (previous?.kind === 'settlement') recordVisit(db, campaignId, previous.id, today);

  const next = findPlace(db, campaignId, to);
  if (next?.kind === 'settlement') deliverWorldNews(db, campaignId, next.id, today);
}
