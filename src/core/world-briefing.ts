// The briefing's world block: what the living world is doing near the party and how it remembers
// them. Empty without a world, and the player's window never reads it.
import type { Db } from '../db/connection.js';
import { getPolitics } from './politics-store.js';
import { findPlace, type WorldPlace } from './region.js';
import { placeDistance } from './region-graph.js';
import { attitudeOf, lastVisit, recordVisit } from './world-memory.js';
import { agendaPlaceId, deliverWorldNews } from './world-resolve.js';
import { ensureWorld } from './world-seed.js';
import {
  excommunicatedUntil,
  factionFaith,
  getFaith,
  listFaiths,
} from './world-faith-store.js';
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
const HERESY_RANGE_HEXES = 8;

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

/** The realm holding a place, through the county whose hexes or seat contain it. */
function realmFor(db: Db, campaignId: number, place: WorldPlace): { id: number; name: string } | null {
  const politics = getPolitics(db, campaignId);
  if (!politics) return null;
  const county =
    politics.counties.find((entry) => entry.hexes.includes(place.hexes[0])) ??
    (place.kind === 'settlement' ? politics.counties.find((entry) => entry.seat_place_id === place.id) : undefined);
  const realm = county ? politics.realms.find((entry) => entry.id === county.realm_id) : undefined;
  return realm ? { id: realm.id, name: realm.name } : null;
}

/** The faith holding the party's realm, and the realm's excommunication while it lasts. */
function faithHereLines(db: Db, campaignId: number, place: WorldPlace, today: number): string[] {
  const realm = realmFor(db, campaignId, place);
  if (!realm) return [];
  const factions = listFactions(db, campaignId);
  const source =
    factions.find((faction) => faction.type === 'church' && faction.realm_id === realm.id) ??
    factions.find((faction) => faction.type === 'realm' && faction.realm_id === realm.id);
  const lines: string[] = [];
  if (source) {
    const { faith_id, influence } = factionFaith(db, campaignId, source.id);
    const faith = faith_id !== null ? getFaith(db, campaignId, faith_id) : undefined;
    if (faith && influence !== null) {
      lines.push(`- ${faith.name} holds ${influence} sway (fervor ${faith.fervor})`);
    }
  }
  const until = excommunicatedUntil(db, campaignId, realm.id);
  if (until !== null && until > today) {
    lines.push(`- ${realm.name} is excommunicated until day ${until}: its temples refuse healing and raising the dead.`);
  }
  return lines;
}

/** Church factions whose faith broke from a parent and whose seat lies near the party, nearest first. */
function heresyLines(db: Db, campaignId: number, party: WorldPlace): string[] {
  const entries: Array<{ hexes: number; faction: string; parent: string; seat: string }> = [];
  for (const faction of listFactions(db, campaignId)) {
    if (faction.type !== 'church') continue;
    const { faith_id } = factionFaith(db, campaignId, faction.id);
    if (faith_id === null) continue;
    const faith = getFaith(db, campaignId, faith_id);
    if (!faith || faith.heresy_of === null) continue;
    const seat = faction.place_id !== null ? findPlace(db, campaignId, faction.place_id) : undefined;
    if (!seat) continue;
    const hexes = placeDistance(party, seat);
    if (hexes > HERESY_RANGE_HEXES) continue;
    const parent = getFaith(db, campaignId, faith.heresy_of);
    entries.push({ hexes, faction: faction.name, parent: parent?.name ?? 'the old faith', seat: seat.name });
  }
  entries.sort((a, b) => a.hexes - b.hexes);
  return entries.map((entry) => `- ${entry.faction} preaches against ${entry.parent} in ${entry.seat}`);
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

  if (party) {
    const faiths = [...faithHereLines(db, campaignId, party, today), ...heresyLines(db, campaignId, party)];
    if (faiths.length > 0) lines.push('Faith here:', ...faiths);
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
