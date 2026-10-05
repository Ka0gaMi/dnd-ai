// The DM's `world {op: get}`: a party-centred digest of the living world with filters, trimmed to the
// WORLD_GET budget. Whatever it leaves out it counts, so the DM knows which filter brings it back.
import type { Db } from '../db/connection.js';
import { attitudeBand, type AttitudeBand } from './attitude-bands.js';
import { getPolitics } from './politics-store.js';
import { getRegion, type RegionView, type WorldPlace } from './region.js';
import { MILES_PER_HEX, placeDistance } from './region-graph.js';
import { estimateTokens, WORLD_GET } from './token-budget.js';
import { factionFaith, listFaiths } from './world-faith-store.js';
import { attitudeOf, type AttitudeReason } from './world-memory.js';
import { MILES_PER_DAY, travelDays } from './world-news.js';
import { agendaPlaceId } from './world-resolve.js';
import {
  currentGameDay,
  listAgendas,
  listEvents,
  listFactions,
  type Portent,
  type WorldAgenda,
  type WorldEvent,
  type WorldFaction,
} from './world-store.js';

/** Days of travel within which a seat or an agenda's target counts as near a place. */
export const NEAR_DAYS = 2;
export const PAGE_SIZE = 10;
const EVENT_DAYS = 30;
const TRANSFER_DAYS = 60;
const ENDED_DAYS = 90;
// reply() may append a checkpoint reminder to the text, so the digest leaves room for it.
const REMINDER_TOKENS = 12;

const HEADER = 'DM only - the party never sees any of this, except deed reasons, which the World tab shows.';

export interface DigestQuery {
  /** The party's place; without one the default view has no centre and lists the first factions by id. */
  party?: WorldPlace;
  faction?: WorldFaction;
  type?: string;
  near?: WorldPlace;
  page?: number;
}

export interface WorldDigest {
  text: string;
  data: Record<string, unknown>;
}

interface FactionEntry {
  id: number;
  name: string;
  type: string;
  secrecy: string;
  resources: number;
  seat: string | null;
  days?: number;
  ended_day: number | null;
  attitude?: { total: number; band: AttitudeBand; reasons: Array<{ reason: string; current: number }> };
}

interface AgendaEntry {
  id: number;
  faction: string;
  template: string;
  target_name: string;
  clock: string;
  status: WorldAgenda['status'];
  known_to_party: boolean;
  fired: number;
  heard: number;
  days?: number;
  latest?: string;
}

interface Facts {
  db: Db;
  campaignId: number;
  today: number;
  view: RegionView | null;
  factions: WorldFaction[];
  living: WorldFaction[];
  names: Map<number, string>;
  agendas: WorldAgenda[];
  attitude: (factionId: number) => { total: number; reasons: AttitudeReason[] };
}

type Near = (placeId: number | null) => number | undefined;

interface Placed<T> {
  item: T;
  days?: number;
  /** An agenda listed for itself (known, or landing near) rather than for its listed owner. */
  pinned?: boolean;
}

const signed = (n: number): string => `${n > 0 ? '+' : ''}${n}`;
const dayCount = (n: number): string => (n === 0 ? 'here' : n === 1 ? '1 day off' : `${n} days off`);
const plural = (type: string): string => (type.endsWith('s') ? type : /(ch|sh|x)$/.test(type) ? `${type}es` : `${type}s`);

function gather(db: Db, campaignId: number): Facts {
  const factions = listFactions(db, campaignId, { includeEnded: true });
  const today = currentGameDay(db, campaignId);
  const cache = new Map<number, { total: number; reasons: AttitudeReason[] }>();
  return {
    db,
    campaignId,
    today,
    view: getRegion(db, campaignId),
    factions,
    living: factions.filter((faction) => faction.ended_day == null),
    names: new Map(factions.map((faction) => [faction.id, faction.name])),
    agendas: listAgendas(db, campaignId).filter((agenda) => agenda.status === 'active' || agenda.status === 'held'),
    attitude: (id) => {
      if (!cache.has(id)) cache.set(id, attitudeOf(db, campaignId, { kind: 'faction', id }, today));
      return cache.get(id)!;
    },
  };
}

/** Travel days from the centre to a place, or undefined past NEAR_DAYS; a straight-line bound skips routing the far ones. */
function nearness(view: RegionView, centre: WorldPlace): Near {
  const cache = new Map<number, number | undefined>();
  return (placeId) => {
    if (placeId === null) return undefined;
    if (!cache.has(placeId)) {
      const place = view.places.find((entry) => entry.id === placeId);
      const bound = place ? Math.ceil((placeDistance(centre, place) * MILES_PER_HEX) / MILES_PER_DAY) : Infinity;
      const days = bound <= NEAR_DAYS ? travelDays(view, centre, place!) : Infinity;
      cache.set(placeId, days <= NEAR_DAYS ? days : undefined);
    }
    return cache.get(placeId);
  };
}

function placeName(facts: Facts, placeId: number | null): string | null {
  if (placeId === null) return null;
  return facts.view?.places.find((place) => place.id === placeId)?.name ?? null;
}

function factionEntry(facts: Facts, faction: WorldFaction, reasons: number, days?: number): FactionEntry {
  const entry: FactionEntry = {
    id: faction.id,
    name: faction.name,
    type: faction.type,
    secrecy: faction.secrecy,
    resources: faction.resources,
    seat: placeName(facts, faction.place_id),
    ended_day: faction.ended_day ?? null,
  };
  if (days !== undefined) entry.days = days;
  const { total, reasons: all } = facts.attitude(faction.id);
  if (total !== 0) {
    entry.attitude = {
      total,
      band: attitudeBand(total),
      reasons: all.slice(0, reasons).map((r) => ({ reason: r.reason, current: r.current })),
    };
  }
  return entry;
}

/** The portent an agenda fired most recently, the later one on a tie. */
function latestPortent(agenda: WorldAgenda): Portent | undefined {
  let best: Portent | undefined;
  for (const portent of agenda.portents) {
    if (portent.fired_day !== null && (best === undefined || portent.fired_day >= best.fired_day!)) best = portent;
  }
  return best;
}

function agendaEntry(facts: Facts, agenda: WorldAgenda, latest: boolean, days?: number): AgendaEntry {
  const entry: AgendaEntry = {
    id: agenda.id,
    faction: facts.names.get(agenda.faction_id) ?? `faction ${agenda.faction_id}`,
    template: agenda.template,
    target_name: agenda.target_name,
    clock: `${agenda.clock_filled}/${agenda.clock_size}`,
    status: agenda.status,
    known_to_party: agenda.known_to_party,
    fired: agenda.portents.filter((portent) => portent.fired_day !== null).length,
    heard: agenda.portents.filter((portent) => portent.heard).length,
  };
  if (days !== undefined) entry.days = days;
  const last = latest ? latestPortent(agenda) : undefined;
  if (last) entry.latest = last.text;
  return entry;
}

function factionLine(entry: FactionEntry): string {
  const where = entry.seat !== null ? `, seat ${entry.seat}${entry.days !== undefined ? ` (${dayCount(entry.days)})` : ''}` : '';
  let regard = '';
  if (entry.attitude) {
    const reasons = entry.attitude.reasons.map((r) => `${signed(r.current)} ${r.reason}`).join('; ');
    regard = `: ${entry.attitude.band} (${signed(entry.attitude.total)})${reasons !== '' ? ` [${reasons}]` : ''}`;
  }
  const ended = entry.ended_day !== null ? ` [ended day ${entry.ended_day}]` : '';
  return `- #${entry.id} ${entry.name} (${entry.type}, ${entry.secrecy}, resources ${entry.resources}${where})${regard}${ended}`;
}

function agendaLine(entry: AgendaEntry): string {
  const flags = [
    entry.status === 'held' ? 'held' : '',
    entry.known_to_party ? 'known' : '',
    entry.days !== undefined ? `lands ${dayCount(entry.days)}` : '',
  ].filter((flag) => flag !== '');
  const latest = entry.latest !== undefined ? `; latest: ${entry.latest}` : '';
  return `- #${entry.id} ${entry.faction}: ${entry.template} -> ${entry.target_name} [${entry.clock}]${
    flags.length > 0 ? ` ${flags.join(', ')}` : ''
  }; signs ${entry.fired}, heard ${entry.heard}${latest}`;
}

/** "9 houses, 9 gangs, 1 guild": the counted factions by type, most first. */
function byType(factions: WorldFaction[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const faction of factions) counts.set(faction.type, (counts.get(faction.type) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function dedupe<T>(items: Array<Placed<T>>, key: (item: T) => number): Array<Placed<T>> {
  const seen = new Set<number>();
  return items.filter((entry) => {
    const id = key(entry.item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

const tokensOf = (digest: WorldDigest): number =>
  estimateTokens(digest.text) + estimateTokens(JSON.stringify(digest.data)) + REMINDER_TOKENS;

/** Builds the digest, then lowers each cap in turn toward its floor until text and JSON fit WORLD_GET. */
function fit<C extends Record<string, number>>(
  caps: C,
  steps: ReadonlyArray<readonly [keyof C, number]>,
  build: (caps: C) => WorldDigest,
): WorldDigest {
  let current = { ...caps };
  let digest = build(current);
  for (const [key, floor] of steps) {
    while (tokensOf(digest) > WORLD_GET && current[key] > floor) {
      current = { ...current, [key]: current[key] - 1 } as C;
      digest = build(current);
    }
  }
  return digest;
}

interface Surface {
  events: Array<{ day: number; text: string; severity: number; visibility: WorldEvent['visibility'] }>;
  place_states: Array<{ place: string; state: string; until_day: number }>;
  transfers: Array<{ day: number; county: string; from: string; to: string }>;
  faiths: Array<{
    id: number;
    name: string;
    aspect: string;
    head: string | null;
    fervor: number;
    heresy_of: string | null;
    branches: Array<{ faction: string; realm: string | null; influence: string | null }>;
  }>;
  contests: Array<{ realm: string; faith: string; filled: number; size: number }>;
  excommunicated: Array<{ realm: string; until_day: number }>;
  ended: WorldFaction[];
}

interface ListSelection {
  data: Record<string, unknown>;
  intro: string;
  factions: Array<Placed<WorldFaction>>;
  agendas: Array<Placed<WorldAgenda>>;
  /** Living factions the view leaves unlisted, counted by type. */
  others: WorldFaction[];
  /** How many agendas the view could have listed; those not shown are counted. */
  agendaTotal: number;
  hint: string;
  page?: { page: number; pages: number; total: number };
  surface?: Surface;
}

interface ListCaps extends Record<string, number> {
  factions: number;
  agendas: number;
  latest: number;
  reasons: number;
  ended: number;
  events: number;
  faiths: number;
  states: number;
  transfers: number;
}

function realmNames(facts: Facts): Map<number, string> {
  const rows = facts.db.prepare('SELECT id, name FROM world_realm WHERE campaign_id = ?').all(facts.campaignId) as Array<{
    id: number;
    name: string;
  }>;
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** The map's state: place states, county transfers, ended factions, recent events and the faiths; nearest first with a party. */
function surface(facts: Facts, party: WorldPlace | undefined, near: Near | undefined): Surface {
  const { db, campaignId, today } = facts;
  const realms = realmNames(facts);
  const recent = listEvents(db, campaignId, { fromDay: today - TRANSFER_DAYS });

  // Portents show as each agenda's latest sign and transfers have their own list; with a party, only near or major events stay.
  const events = recent
    .filter((event) => event.day >= today - EVENT_DAYS && event.kind !== 'portent')
    .filter((event) => event.effects.outcome !== 'county_transferred')
    .filter((event) => !near || event.severity >= 3 || near(event.place_id) !== undefined)
    .reverse()
    .map((event) => ({ day: event.day, text: event.text, severity: event.severity, visibility: event.visibility }));

  const stateRows = db
    .prepare(
      `SELECT place_id, state, until_day FROM world_place_state
        WHERE campaign_id = ? AND state IS NOT NULL AND until_day > ?
        ORDER BY until_day, place_id`,
    )
    .all(campaignId, today) as Array<{ place_id: number; state: string; until_day: number }>;
  const placed = stateRows
    .map((row) => ({ row, place: facts.view?.places.find((place) => place.id === row.place_id) }))
    .filter((entry): entry is { row: (typeof stateRows)[number]; place: WorldPlace } => entry.place !== undefined);
  if (party) placed.sort((a, b) => placeDistance(party, a.place) - placeDistance(party, b.place));
  const place_states = placed.map(({ row, place }) => ({ place: place.name, state: row.state, until_day: row.until_day }));

  const politics = getPolitics(db, campaignId);
  const counties = new Map((politics?.counties ?? []).map((county) => [county.id, county.name]));
  const transfers: Surface['transfers'] = [];
  for (const event of [...recent].reverse()) {
    if (event.kind !== 'agenda_won' || event.effects.outcome !== 'county_transferred') continue;
    const { county_id, from_realm_id, to_realm_id } = event.effects as Record<string, number | undefined>;
    if (county_id === undefined || from_realm_id === undefined || to_realm_id === undefined) continue;
    transfers.push({
      day: event.day,
      county: counties.get(county_id) ?? `county ${county_id}`,
      from: realms.get(from_realm_id) ?? `realm ${from_realm_id}`,
      to: realms.get(to_realm_id) ?? `realm ${to_realm_id}`,
    });
  }

  const faithList = listFaiths(db, campaignId);
  const faithNames = new Map(faithList.map((faith) => [faith.id, faith.name]));
  const links = new Map(facts.factions.map((faction) => [faction.id, factionFaith(db, campaignId, faction.id)]));
  const faiths = faithList.map((faith) => ({
    id: faith.id,
    name: faith.name,
    aspect: faith.aspect,
    head: placeName(facts, faith.head_place_id),
    fervor: faith.fervor,
    heresy_of: faith.heresy_of !== null ? (faithNames.get(faith.heresy_of) ?? null) : null,
    branches: facts.factions
      .filter((faction) => links.get(faction.id)?.faith_id === faith.id)
      .map((faction) => ({
        faction: faction.name,
        realm: faction.realm_id !== null ? (realms.get(faction.realm_id) ?? null) : null,
        influence: links.get(faction.id)?.influence ?? null,
      })),
  }));
  const contests = (
    db
      .prepare(
        'SELECT realm_id, faith_id, filled, size FROM world_contest WHERE campaign_id = ? AND filled > 0 ORDER BY realm_id, faith_id',
      )
      .all(campaignId) as Array<{ realm_id: number; faith_id: number; filled: number; size: number }>
  ).map((row) => ({
    realm: realms.get(row.realm_id) ?? `realm ${row.realm_id}`,
    faith: faithNames.get(row.faith_id) ?? `faith ${row.faith_id}`,
    filled: row.filled,
    size: row.size,
  }));
  const excommunicated = (
    db
      .prepare(
        'SELECT id, excommunicated_until FROM world_realm WHERE campaign_id = ? AND excommunicated_until IS NOT NULL ORDER BY id',
      )
      .all(campaignId) as Array<{ id: number; excommunicated_until: number }>
  ).map((row) => ({ realm: realms.get(row.id) ?? `realm ${row.id}`, until_day: row.excommunicated_until }));

  const ended = facts.factions
    .filter((faction) => faction.ended_day != null && faction.ended_day >= today - ENDED_DAYS)
    .sort((a, b) => b.ended_day! - a.ended_day! || b.id - a.id);

  return { events, place_states, transfers, faiths, contests, excommunicated, ended };
}

/** The default view's picks: felt attitudes, known agendas' owners and seats near the party, plus their agendas. */
function defaultPicks(
  facts: Facts,
  party: WorldPlace | undefined,
  near: Near | undefined,
): { factions: Array<Placed<WorldFaction>>; agendas: Array<Placed<WorldAgenda>>; rest: WorldFaction[] } {
  const total = (faction: WorldFaction): number => facts.attitude(faction.id).total;
  const felt = facts.living
    .filter((faction) => total(faction) !== 0)
    .sort((a, b) => Math.abs(total(b)) - Math.abs(total(a)) || a.id - b.id);
  const known = facts.agendas.filter((agenda) => agenda.known_to_party);
  const owners = facts.living.filter((faction) => known.some((agenda) => agenda.faction_id === faction.id));
  const seated = near
    ? facts.living
        .map((faction) => ({ item: faction, days: near(faction.place_id) }))
        .filter((entry) => entry.days !== undefined)
        .sort((a, b) => a.days! - b.days! || a.item.id - b.item.id)
    : [];

  let factions = dedupe(
    [...felt, ...owners].map((faction) => ({ item: faction, days: near?.(faction.place_id) })).concat(seated),
    (faction) => faction.id,
  );
  if (!party) {
    // With no centre the view fills a page with the first factions by id.
    const fill = facts.living.map((faction) => ({ item: faction }));
    factions = dedupe([...factions, ...fill], (faction) => faction.id).slice(0, Math.max(PAGE_SIZE, factions.length));
  }
  const listed = new Set(factions.map((entry) => entry.item.id));

  const landing = near
    ? facts.agendas
        .map((agenda) => ({ item: agenda, days: near(agendaPlaceId(facts.db, facts.campaignId, agenda)) }))
        .filter((entry) => entry.days !== undefined)
        .sort((a, b) => a.days! - b.days! || a.item.id - b.item.id)
    : [];
  const landed = new Map(landing.map((entry) => [entry.item.id, entry.days]));
  const agendas = dedupe(
    [
      ...known.map((agenda) => ({ item: agenda, days: landed.get(agenda.id), pinned: true })),
      ...landing.map((entry) => ({ ...entry, pinned: true })),
      ...facts.agendas.filter((agenda) => listed.has(agenda.faction_id)).map((agenda) => ({ item: agenda })),
    ],
    (agenda) => agenda.id,
  );
  return { factions, agendas, rest: facts.living.filter((faction) => !listed.has(faction.id)) };
}

function renderList(facts: Facts, sel: ListSelection, caps: ListCaps): WorldDigest {
  const shown = sel.factions.slice(0, caps.factions);
  const cut = sel.factions.slice(caps.factions).map((entry) => entry.item);
  const ended = sel.surface?.ended.slice(0, caps.ended) ?? [];
  const endedLeft = (sel.surface?.ended.length ?? 0) - ended.length;
  const factions = [
    ...shown.map((entry) => factionEntry(facts, entry.item, caps.reasons, entry.days)),
    ...ended.map((faction) => factionEntry(facts, faction, caps.reasons)),
  ];
  const owners = new Set(shown.map((entry) => entry.item.id));
  const agendas = sel.agendas
    .filter((entry) => entry.pinned === true || owners.has(entry.item.faction_id))
    .slice(0, caps.agendas)
    .map((entry) => agendaEntry(facts, entry.item, caps.latest > 0, entry.days));
  const otherAgendas = sel.agendaTotal - agendas.length;
  const others = [...sel.others, ...cut];
  const counts = byType(others);

  const lines = [HEADER, sel.intro, 'Factions:'];
  if (factions.length === 0) lines.push('- none');
  lines.push(...factions.map(factionLine));
  if (others.length > 0) {
    const kinds = counts.map(([type, n]) => `${n} ${n === 1 ? type : plural(type)}`).join(', ');
    lines.push(`+ ${others.length} other faction${others.length === 1 ? '' : 's'}: ${kinds} (${sel.hint})`);
  }
  if (endedLeft > 0) lines.push(`+ ${endedLeft} more ended lately (faction: id or name)`);
  if (sel.page) {
    const next = sel.page.page < sel.page.pages ? `; page: ${sel.page.page + 1} for the next` : '';
    lines.push(`Page ${sel.page.page} of ${sel.page.pages} (${sel.page.total} factions)${next}.`);
  }
  lines.push('Agendas (ids for reveal, setback, thwart):');
  if (agendas.length === 0) lines.push('- none');
  lines.push(...agendas.map(agendaLine));
  if (otherAgendas > 0) lines.push(`+ ${otherAgendas} other agenda${otherAgendas === 1 ? '' : 's'} in motion`);

  const data: Record<string, unknown> = {
    ...sel.data,
    factions,
    agendas,
    others: { factions: others.length, by_type: Object.fromEntries(counts), agendas: otherAgendas, ended: endedLeft },
  };
  if (sel.page) data.page = sel.page;

  const s = sel.surface;
  if (s) {
    const section = <T>(title: string, items: T[], cap: number, line: (item: T) => string, oldestFirst = false): T[] => {
      const kept = items.slice(0, cap);
      if (kept.length > 0) {
        lines.push(title, ...(oldestFirst ? [...kept].reverse() : kept).map(line));
        if (items.length > kept.length) lines.push(`+ ${items.length - kept.length} more`);
      } else if (items.length > 0) {
        lines.push(`${title} ${items.length} left out for room`);
      }
      return oldestFirst ? [...kept].reverse() : kept;
    };
    data.place_states = section(
      'Place states:',
      s.place_states,
      caps.states,
      (r) => `- ${r.place}: ${r.state} until day ${r.until_day}`,
    );
    data.transfers = section(
      'County transfers:',
      s.transfers,
      caps.transfers,
      (t) => `- day ${t.day}: ${t.county} passes from ${t.from} to ${t.to}`,
      true,
    );
    data.recent_events = section(
      'Recent world events:',
      s.events,
      caps.events,
      (e) => `- day ${e.day} (${e.visibility}, severity ${e.severity}): ${e.text}`,
      true,
    );
    data.faiths = section('Faiths:', s.faiths, caps.faiths, (faith) => {
      const heresy = faith.heresy_of !== null ? `, heresy of ${faith.heresy_of}` : '';
      const branches =
        faith.branches.length > 0
          ? faith.branches
              .map((b) => `${b.faction} holds ${b.influence ?? 'no'} sway${b.realm !== null ? ` in ${b.realm}` : ''}`)
              .join('; ')
          : 'no branches';
      return `- ${faith.name} (fervor ${faith.fervor}, head ${faith.head ?? 'none'}${heresy}): ${branches}`;
    });
    data.contests = section(
      'Church contests:',
      s.contests,
      s.contests.length,
      (c) => `- ${c.realm}: ${c.faith} at ${c.filled}/${c.size}`,
    );
    data.excommunicated = section(
      'Excommunicated:',
      s.excommunicated,
      s.excommunicated.length,
      (r) => `- ${r.realm} until day ${r.until_day}`,
    );
  }
  return { text: lines.join('\n'), data };
}

const DEFAULT_CAPS: ListCaps = {
  factions: 12,
  agendas: 12,
  latest: 1,
  reasons: 2,
  ended: 5,
  events: 6,
  faiths: 6,
  states: 8,
  transfers: 4,
};

/** Least needed first: events and faiths, then the zero-attitude neighbours, then signs, reasons and the map's state. */
const DEFAULT_STEPS: ReadonlyArray<readonly [keyof ListCaps, number]> = [
  ['events', 2],
  ['faiths', 0],
  ['factions', 6],
  ['latest', 0],
  ['events', 0],
  ['reasons', 1],
  ['states', 3],
  ['transfers', 2],
  ['ended', 2],
  ['agendas', 6],
  ['factions', 0],
  ['agendas', 0],
];

const PAGE_CAPS: ListCaps = {
  ...DEFAULT_CAPS,
  factions: PAGE_SIZE,
  agendas: 2 * PAGE_SIZE,
  reasons: 1,
  ended: 0,
  events: 0,
  faiths: 0,
  states: 0,
  transfers: 0,
};
const PAGE_STEPS: ReadonlyArray<readonly [keyof ListCaps, number]> = [
  ['latest', 0],
  ['reasons', 0],
  ['agendas', 0],
];

function paged<T>(items: T[], page: number, what: string): { slice: T[]; page: { page: number; pages: number; total: number } } {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  if (page > pages) throw new Error(`page ${page} is past the last page of ${what}, ${pages}.`);
  return { slice: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), page: { page, pages, total: items.length } };
}

/** The faction type a filter names, singular or plural; undefined when no faction has it. */
function factionType(facts: Facts, input: string): string | undefined {
  const wanted = input.trim().toLowerCase();
  const types = [...new Set(facts.factions.map((faction) => faction.type))];
  return types.find((type) => type === wanted || plural(type) === wanted);
}

function listView(facts: Facts, query: DigestQuery): WorldDigest {
  const { party } = query;
  const near = party && facts.view ? nearness(facts.view, party) : undefined;
  const base = { day: facts.today, party: party?.name ?? null };

  if (query.type === undefined && query.near === undefined) {
    const picks = defaultPicks(facts, party, near);
    if (query.page === undefined) {
      const intro = party
        ? `Day ${facts.today}, party at ${party.name}: factions seated within ${NEAR_DAYS} days, any with a non-zero ` +
          `attitude or a known agenda, and agendas known or landing within ${NEAR_DAYS} days.`
        : `Day ${facts.today}; no scene places the party on the map, so the first factions by id are listed.`;
      const selection: ListSelection = {
        data: { view: 'default', ...base },
        intro,
        factions: picks.factions,
        agendas: picks.agendas,
        others: picks.rest,
        agendaTotal: facts.agendas.length,
        hint: 'page: 1 lists them; type, near or faction narrows',
        surface: surface(facts, party, near),
      };
      return fit(DEFAULT_CAPS, DEFAULT_STEPS, (caps) => renderList(facts, selection, caps));
    }
    if (picks.rest.length === 0) throw new Error('The default view already lists every faction; there is no page to read.');
    const rest = picks.rest.map((faction) => ({ item: faction, days: near?.(faction.place_id) }));
    const { slice, page } = paged(rest, query.page, 'the unlisted factions');
    const intro = `Day ${facts.today}: the factions the default view only counted.`;
    return pageView(facts, { view: 'rest', ...base }, intro, slice, [], page);
  }

  const type = query.type !== undefined ? factionType(facts, query.type) : undefined;
  if (query.type !== undefined && type === undefined) {
    const types = [...new Set(facts.living.map((faction) => faction.type))].sort().join(', ');
    throw new Error(`No faction of type "${query.type}". Types here: ${types}.`);
  }
  const centre = query.near;
  const from = centre && facts.view ? nearness(facts.view, centre) : near;
  let matches: Array<Placed<WorldFaction>> = facts.living
    .filter((faction) => type === undefined || faction.type === type)
    .map((faction) => ({ item: faction, days: from?.(faction.place_id) }));
  if (centre) {
    matches = matches.filter((entry) => entry.days !== undefined).sort((a, b) => a.days! - b.days! || a.item.id - b.item.id);
  }
  const what = type !== undefined ? plural(type) : 'factions';
  const { slice, page } = paged(matches, query.page ?? 1, what);
  const landing =
    centre && from && page.page === 1
      ? facts.agendas
          .filter((agenda) => type === undefined || facts.factions.find((f) => f.id === agenda.faction_id)?.type === type)
          .map((agenda) => ({ item: agenda, days: from(agendaPlaceId(facts.db, facts.campaignId, agenda)) }))
          .filter((entry) => entry.days !== undefined)
          .sort((a, b) => a.days! - b.days! || a.item.id - b.item.id)
      : [];
  const intro = centre
    ? `Day ${facts.today}: ${what} seated within ${NEAR_DAYS} days of ${centre.name}, and agendas landing there.`
    : `Day ${facts.today}: every living faction of type ${type}.`;
  const data: Record<string, unknown> = { view: centre ? 'near' : 'type', ...base };
  if (type !== undefined) data.type = type;
  if (centre) data.near = centre.name;
  return pageView(facts, data, intro, slice, landing, page);
}

function pageView(
  facts: Facts,
  data: Record<string, unknown>,
  intro: string,
  factions: Array<Placed<WorldFaction>>,
  landing: Array<Placed<WorldAgenda>>,
  page: { page: number; pages: number; total: number },
): WorldDigest {
  const ids = new Set(factions.map((entry) => entry.item.id));
  const landed = new Map(landing.map((entry) => [entry.item.id, entry.days]));
  const agendas = dedupe(
    [
      ...landing.map((entry) => ({ ...entry, pinned: true })),
      ...facts.agendas
        .filter((agenda) => ids.has(agenda.faction_id))
        .map((agenda) => ({ item: agenda, days: landed.get(agenda.id) })),
    ],
    (agenda) => agenda.id,
  );
  return fit(PAGE_CAPS, PAGE_STEPS, (caps) =>
    renderList(
      facts,
      { data, intro, factions, agendas, others: [], agendaTotal: agendas.length, hint: '', page },
      caps,
    ),
  );
}

interface FactionCaps extends Record<string, number> {
  reasons: number;
  portents: number;
  targeted: number;
  events: number;
}

function factionView(facts: Facts, faction: WorldFaction): WorldDigest {
  const { db, campaignId, today } = facts;
  const realm = faction.realm_id !== null ? (realmNames(facts).get(faction.realm_id) ?? null) : null;
  const link = factionFaith(db, campaignId, faction.id);
  const faith = link.faith_id !== null ? listFaiths(db, campaignId).find((entry) => entry.id === link.faith_id) : undefined;
  const attitude = facts.attitude(faction.id);
  const own = facts.agendas.filter((agenda) => agenda.faction_id === faction.id);
  const targeting = facts.agendas.filter(
    (agenda) => agenda.target_kind === 'rival_faction' && agenda.target_id === faction.id,
  );
  const events = listEvents(db, campaignId, { fromDay: today - EVENT_DAYS })
    .filter((event) => event.faction_id === faction.id && event.kind !== 'portent')
    .reverse();

  const build = (caps: FactionCaps): WorldDigest => {
    const entry = {
      id: faction.id,
      name: faction.name,
      type: faction.type,
      secrecy: faction.secrecy,
      resources: faction.resources,
      seat: placeName(facts, faction.place_id),
      realm,
      faith: faith ? { name: faith.name, influence: link.influence } : null,
      ended_day: faction.ended_day ?? null,
      ...(attitude.total !== 0
        ? {
            attitude: {
              total: attitude.total,
              band: attitudeBand(attitude.total),
              reasons: attitude.reasons
                .slice(0, caps.reasons)
                .map((r) => ({ reason: r.reason, value: r.value, current: r.current, day: r.day })),
            },
          }
        : {}),
    };
    const agendas = own.map((agenda) => {
      const fired = agenda.portents.filter((portent) => portent.fired_day !== null);
      return {
        id: agenda.id,
        template: agenda.template,
        target_name: agenda.target_name,
        clock: `${agenda.clock_filled}/${agenda.clock_size}`,
        status: agenda.status,
        known_to_party: agenda.known_to_party,
        portents: fired
          .slice(-caps.portents)
          .map((portent) => ({ text: portent.text, fired_day: portent.fired_day, heard: portent.heard })),
        earlier: Math.max(0, fired.length - caps.portents),
        unfired: agenda.portents.length - fired.length,
      };
    });
    const targeted = targeting.slice(0, caps.targeted).map((agenda) => ({
      id: agenda.id,
      faction: facts.names.get(agenda.faction_id) ?? `faction ${agenda.faction_id}`,
      template: agenda.template,
      clock: `${agenda.clock_filled}/${agenda.clock_size}`,
      status: agenda.status,
    }));
    const recent = events
      .slice(0, caps.events)
      .reverse()
      .map((event) => ({ day: event.day, text: event.text, severity: event.severity, visibility: event.visibility }));

    const where = [entry.seat !== null ? `seat ${entry.seat}` : '', realm !== null ? `realm ${realm}` : '']
      .filter((part) => part !== '')
      .join(', ');
    const lines = [
      HEADER,
      `#${entry.id} ${entry.name} (${entry.type}, ${entry.secrecy}, resources ${entry.resources})${where !== '' ? `, ${where}` : ''}${
        entry.ended_day !== null ? ` [ended day ${entry.ended_day}]` : ''
      }`,
    ];
    if (faith) lines.push(`Faith: ${faith.name} (${link.influence ?? 'no'} sway)`);
    if (entry.attitude) {
      lines.push(`Regards the party: ${entry.attitude.band} (${signed(entry.attitude.total)})`);
      for (const r of entry.attitude.reasons) lines.push(`- ${signed(r.current)} ${r.reason} (day ${r.day}, was ${signed(r.value)})`);
    }
    lines.push('Agendas (ids for reveal, setback, thwart):');
    if (agendas.length === 0) lines.push('- none');
    for (const agenda of agendas) {
      const flags = [agenda.status, agenda.known_to_party ? 'known to the party' : ''].filter((flag) => flag !== '');
      lines.push(`- #${agenda.id} ${agenda.template} -> ${agenda.target_name} [${agenda.clock}] ${flags.join(', ')}`);
      if (agenda.earlier > 0) lines.push(`  ${agenda.earlier} earlier portent(s) left out for room`);
      for (const portent of agenda.portents) {
        lines.push(`  portent (${portent.heard ? 'heard' : 'unheard'}, day ${portent.fired_day}): ${portent.text}`);
      }
      if (agenda.unfired > 0) lines.push(`  ${agenda.unfired} portent(s) still to come`);
    }
    if (targeted.length > 0) {
      lines.push('Targeted by:', ...targeted.map((t) => `- #${t.id} ${t.faction}: ${t.template} [${t.clock}] ${t.status}`));
      if (targeting.length > targeted.length) lines.push(`+ ${targeting.length - targeted.length} more`);
    }
    if (recent.length > 0) {
      lines.push('Recent world events:', ...recent.map((e) => `- day ${e.day} (${e.visibility}, severity ${e.severity}): ${e.text}`));
    }
    return {
      text: lines.join('\n'),
      data: { view: 'faction', day: today, faction: entry, agendas, targeted_by: targeted, recent_events: recent },
    };
  };

  return fit({ reasons: 5, portents: 8, targeted: 8, events: 8 } as FactionCaps, [
    ['events', 0],
    ['targeted', 3],
    ['portents', 1],
    ['reasons', 1],
  ], build);
}

/** The world as the DM reads it: one faction in full, a filtered list, or the party-centred default view. */
export function worldDigest(db: Db, campaignId: number, query: DigestQuery = {}): WorldDigest {
  const facts = gather(db, campaignId);
  if (query.faction) return factionView(facts, query.faction);
  return listView(facts, query);
}
