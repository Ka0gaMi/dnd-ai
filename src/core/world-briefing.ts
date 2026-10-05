// The briefing's world block: what the living world is doing near the party and how it remembers them,
// must-act items first and trimmed to its token budget. Empty without a world; the player's window never reads it.
import type { Db } from '../db/connection.js';
import { attitudeBand } from './attitude-bands.js';
import { getPolitics } from './politics-store.js';
import { matchPlace } from './place-match.js';
import { findPlace, type WorldPlace } from './region.js';
import { placeDistance } from './region-graph.js';
import { estimateTokens, WORLD_BRIEFING } from './token-budget.js';
import { attitudeOf, knownFor, lastVisit, recordVisit } from './world-memory.js';
import { realmChurch } from './world-faith.js';
import { agendaPlaceId, deliverWorldNews, HOLD_TIMEOUT_DAYS, heardCount } from './world-resolve.js';
import { ensureWorld } from './world-seed.js';
import { excommunicatedUntil, factionFaith, getFaith } from './world-faith-store.js';
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
const STATE_LIMIT = 5;
const TRANSFER_DAYS = 60;
const TRANSFER_LIMIT = 5;

const HEADER = 'World (DM only; weave these in, never read them out):';

/** A titled run of items, one per line or joined on one line; must-act sections are never trimmed. */
interface Section {
  heading: string;
  items: string[];
  label: string;
  inline?: boolean;
  mustAct?: boolean;
}

function renderSection(section: Section): string[] {
  if (section.items.length === 0) return [];
  if (section.inline) return [`${section.heading} ${section.items.join('; ')}`];
  return [section.heading, ...section.items.map((item) => `- ${item}`)];
}

const signed = (n: number): string => `${n > 0 ? '+' : ''}${n}`;

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

/** Full clocks held until the party hears two of their signs, soonest to land first, with the next sign to weave in. */
function heldLines(db: Db, campaignId: number, factions: Map<number, string>): string[] {
  const entries = listAgendas(db, campaignId, { status: 'held' }).map((agenda) => {
    const fired = agenda.portents.map((portent) => portent.fired_day).filter((day): day is number => day !== null);
    const lands = (fired.length > 0 ? Math.max(...fired) : agenda.started_day) + HOLD_TIMEOUT_DAYS;
    const next =
      agenda.portents.find((portent) => !portent.heard && portent.fired_day !== null) ??
      agenda.portents.find((portent) => !portent.heard);
    return { agenda, lands, next };
  });
  entries.sort((a, b) => a.lands - b.lands || a.agenda.id - b.agenda.id);
  return entries.map(
    ({ agenda, lands, next }) =>
      `${factions.get(agenda.faction_id) ?? 'unknown faction'}: ${agenda.template} -> ${agenda.target_name} [${
        agenda.clock_filled
      }/${agenda.clock_size}], agenda ${agenda.id}; ${heardCount(agenda)}/2 signs heard, lands by day ${lands}${
        next ? `; next sign: ${next.text}` : ''
      }`,
  );
}

/** Fired portents of active agendas landing near the party, nearest first; held agendas have their own section. */
function portentLines(
  db: Db,
  campaignId: number,
  party: WorldPlace,
  factions: Map<number, string>,
): string[] {
  const entries: Array<{ hexes: number; text: string; faction: string }> = [];
  for (const agenda of listAgendas(db, campaignId)) {
    if (agenda.status !== 'active') continue;
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
    .map((entry) => `${entry.text} (${entry.faction}, ${entry.hexes} hexes away)`);
}

/** The clocks the party already knows about. */
function clockLines(db: Db, campaignId: number, factions: Map<number, string>): string[] {
  const lines: string[] = [];
  for (const agenda of listAgendas(db, campaignId)) {
    if (!agenda.known_to_party || (agenda.status !== 'active' && agenda.status !== 'held')) continue;
    lines.push(
      `${factions.get(agenda.faction_id) ?? 'unknown faction'}: ${agenda.template} -> ${agenda.target_name} [${agenda.clock_filled}/${agenda.clock_size}]`,
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
  return rows.map((row) => row.text);
}

/** Factions whose faded attitude toward the party is not zero today, as a band and its top reason, strongest first. */
function attitudeLines(db: Db, campaignId: number, today: number): string[] {
  const entries: Array<{ name: string; total: number; reason: string }> = [];
  for (const faction of listFactions(db, campaignId)) {
    const { total, reasons } = attitudeOf(db, campaignId, { kind: 'faction', id: faction.id }, today);
    if (total === 0 || reasons.length === 0) continue;
    entries.push({ name: faction.name, total, reason: reasons[0]!.reason });
  }
  entries.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  return entries
    .slice(0, ATTITUDE_LIMIT)
    .map((entry) => `${entry.name} — ${attitudeBand(entry.total)} (${signed(entry.total)}, ${entry.reason})`);
}

/** Events at the party's settlement since their last recorded visit, oldest first. */
function awayLines(db: Db, campaignId: number, place: WorldPlace, today: number): string[] {
  const since = lastVisit(db, campaignId, place.id);
  if (since === null || since >= today) return [];
  return listEvents(db, campaignId, { placeId: place.id, fromDay: since + 1 })
    .slice(0, AWAY_LIMIT)
    .map((event) => `day +${event.day - since}: ${event.text}`);
}

/** The realm holding a place, through the county whose legal claim or seat contains it. */
function realmFor(db: Db, campaignId: number, place: WorldPlace): { id: number; name: string } | null {
  const politics = getPolitics(db, campaignId);
  if (!politics) return null;
  const county =
    politics.counties.find((entry) => (entry.claim_hexes ?? entry.hexes).includes(place.hexes[0])) ??
    (place.kind === 'settlement' ? politics.counties.find((entry) => entry.seat_place_id === place.id) : undefined);
  const realm = county ? politics.realms.find((entry) => entry.id === county.realm_id) : undefined;
  return realm ? { id: realm.id, name: realm.name } : null;
}

/** Unexpired place states, the party's realm and nearest first, capped so the block stays small. */
function placeStateLines(db: Db, campaignId: number, party: WorldPlace | undefined, today: number): string[] {
  const rows = db
    .prepare(
      `SELECT place_id, state, until_day FROM world_place_state
        WHERE campaign_id = ? AND state IS NOT NULL AND until_day > ?`,
    )
    .all(campaignId, today) as Array<{ place_id: number; state: string; until_day: number }>;
  const partyRealm = party ? (realmFor(db, campaignId, party)?.id ?? null) : null;
  const entries = rows
    .map((row) => {
      const place = findPlace(db, campaignId, row.place_id);
      if (!place || place.kind !== 'settlement') return null;
      const realmId = realmFor(db, campaignId, place)?.id ?? null;
      return {
        place,
        state: row.state,
        until: row.until_day,
        hexes: party ? placeDistance(party, place) : 0,
        sameRealm: partyRealm !== null && realmId === partyRealm,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  entries.sort(
    (a, b) => Number(b.sameRealm) - Number(a.sameRealm) || a.hexes - b.hexes || a.place.id - b.place.id,
  );
  return entries
    .slice(0, STATE_LIMIT)
    .map((entry) => `${entry.place.name} — ${entry.state} until day ${entry.until}`);
}

/** The latest county transfers the ledger recorded in the recent window, newest first. */
function transferLines(db: Db, campaignId: number, today: number): string[] {
  const politics = getPolitics(db, campaignId);
  if (!politics) return [];
  const realmNames = new Map(politics.realms.map((realm) => [realm.id, realm.name]));
  const countyNames = new Map(politics.counties.map((county) => [county.id, county.name]));
  const lines: string[] = [];
  for (const event of listEvents(db, campaignId, { fromDay: today - TRANSFER_DAYS })) {
    if (event.kind !== 'agenda_won' || event.effects.outcome !== 'county_transferred') continue;
    const { county_id, from_realm_id, to_realm_id } = event.effects as {
      county_id?: number;
      from_realm_id?: number;
      to_realm_id?: number;
    };
    if (county_id === undefined || from_realm_id === undefined || to_realm_id === undefined) continue;
    lines.push(
      `${countyNames.get(county_id) ?? `county ${county_id}`} passes from ${
        realmNames.get(from_realm_id) ?? `realm ${from_realm_id}`
      } to ${realmNames.get(to_realm_id) ?? `realm ${to_realm_id}`} (day ${event.day})`,
    );
  }
  return lines.reverse().slice(0, TRANSFER_LIMIT);
}

/** The faith holding the party's realm, its liege's when it has no church of its own, and its interdict. */
function faithHereLines(db: Db, campaignId: number, place: WorldPlace, today: number): string[] {
  const realm = realmFor(db, campaignId, place);
  if (!realm) return [];
  const church = realmChurch(db, campaignId, realm.id);
  const lines: string[] = [];
  if (church && church.influence !== null) {
    lines.push(`${church.faith.name} holds ${church.influence} sway (fervor ${church.faith.fervor})`);
  }
  const until = excommunicatedUntil(db, campaignId, realm.id);
  if (until !== null && until > today) {
    lines.push(`${realm.name} is excommunicated until day ${until}: its temples refuse healing and raising the dead.`);
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
  return entries.map((entry) => `${entry.faction} preaches against ${entry.parent} in ${entry.seat}`);
}

/** Where to fetch what the block leaves out, and what the budget trimmed. */
function hintLines(party: WorldPlace | undefined, held: boolean, trimmed: Map<string, number>): string[] {
  const lines = ['Fetch more when a scene needs it:'];
  lines.push("- world {op: get, faction: <name>} for one faction's agendas, signs and regard");
  if (party) lines.push(`- world {op: get, near: "${party.name}"} for the factions and agendas around the party`);
  if (held) {
    lines.push('- world {op: setback, agenda: <id>} or {op: thwart, agenda: <id>} when the party acts against a held clock');
  }
  if (trimmed.size > 0) {
    lines.push(`- trimmed to fit: ${[...trimmed].map(([label, count]) => `${label} (${count})`).join(', ')}`);
  }
  return lines;
}

export function worldBriefing(db: Db, campaignId: number, location: string | null): string {
  if (getWorldState(db, campaignId) === null) return '';

  const today = currentGameDay(db, campaignId);
  const factions = new Map(
    listFactions(db, campaignId, { includeEnded: true }).map((faction) => [faction.id, faction.name]),
  );
  const party = location !== null && location.trim() !== '' ? matchPlace(db, campaignId, location) : undefined;
  const realm = party ? realmFor(db, campaignId, party) : null;

  // Most important first, since models miss facts buried mid-context; the budget trims from the end.
  const sections: Section[] = [
    {
      heading: 'Held clocks (full; each waits until the party hears two of its signs):',
      items: heldLines(db, campaignId, factions),
      label: 'held clocks',
      mustAct: true,
    },
    {
      heading: 'Portents near the party:',
      items: party ? portentLines(db, campaignId, party, factions) : [],
      label: 'portents',
      mustAct: true,
    },
    { heading: 'Attitudes toward the party:', items: attitudeLines(db, campaignId, today), label: 'attitudes' },
    {
      heading: `Known for in ${realm?.name ?? 'the realm'}:`,
      items: realm ? knownFor(db, campaignId, realm.id, today) : [],
      label: 'known for',
    },
    { heading: 'Known clocks:', items: clockLines(db, campaignId, factions), label: 'known clocks' },
    {
      heading: 'Troubled settlements:',
      items: placeStateLines(db, campaignId, party, today),
      label: 'troubled settlements',
      inline: true,
    },
    {
      heading: 'Recent county transfers:',
      items: transferLines(db, campaignId, today),
      label: 'county transfers',
      inline: true,
    },
    { heading: 'Heard news:', items: newsLines(db, campaignId), label: 'news' },
    {
      heading: 'Faith here:',
      items: party ? [...faithHereLines(db, campaignId, party, today), ...heresyLines(db, campaignId, party)] : [],
      label: 'faith',
    },
    {
      heading: `While you were away from ${party?.name ?? 'here'}:`,
      items: party?.kind === 'settlement' ? awayLines(db, campaignId, party, today) : [],
      label: 'while you were away',
    },
  ];

  const held = sections[0]!.items.length > 0;
  const trimmed = new Map<string, number>();
  const render = (): string =>
    [HEADER, ...sections.flatMap(renderSection), ...hintLines(party, held, trimmed)].join('\n');

  // Pop items off the least important section until the block fits; must-act sections are never touched.
  let text = render();
  for (let index = sections.length - 1; index >= 0 && estimateTokens(text) > WORLD_BRIEFING; ) {
    const section = sections[index]!;
    if (section.mustAct || section.items.length === 0) {
      index -= 1;
      continue;
    }
    section.items.pop();
    trimmed.set(section.label, (trimmed.get(section.label) ?? 0) + 1);
    text = render();
  }
  return text;
}

/** Records the party leaving and arriving, so world memory follows them between settlements. */
export function onPartyMoved(db: Db, campaignId: number, from: string | null, to: string): void {
  // A campaign's opening scenes come before any day passes, so the world is seeded here too.
  if (ensureWorld(db, campaignId) === null) return;
  const today = currentGameDay(db, campaignId);

  const previous = from ? matchPlace(db, campaignId, from) : undefined;
  if (previous?.kind === 'settlement') recordVisit(db, campaignId, previous.id, today);

  const next = matchPlace(db, campaignId, to);
  if (next?.kind === 'settlement') deliverWorldNews(db, campaignId, next.id, today);
}
