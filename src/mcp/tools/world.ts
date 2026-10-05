import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { attitudeBand } from '../../core/attitude-bands.js';
import { ensureFactionEntity } from '../../core/world-codex.js';
import { addAttitude, attitudeOf, DEED_KNOWN_DAYS, deedKnownAt } from '../../core/world-memory.js';
import { matchPlace } from '../../core/place-match.js';
import { placePolitics } from '../../core/politics-service.js';
import { findPlace, getRegion, type RegionView, type WorldPlace } from '../../core/region.js';
import { ensureWorld } from '../../core/world-seed.js';
import { worldDigest } from '../../core/world-digest.js';
import {
  currentGameDay,
  listAgendas,
  listFactions,
  updateAgenda,
  type WorldAgenda,
  type WorldFaction,
} from '../../core/world-store.js';
import { clearDanger, destroyFaction, setbackAgenda, thwartAgenda } from '../../core/world-thwart.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';

const ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const NO_REGION = 'This campaign has no region map yet. The player adds one in the companion window (Settings, Region).';

/** Creates the living world on first use; without a region map there is nothing to create. */
function requireWorld(db: Db, campaignId: number): void {
  if (ensureWorld(db, campaignId) === null) throw new Error(NO_REGION);
}

interface EntityRefRow {
  id: number;
  name: string;
}

function findFaction(db: Db, campaignId: number, ref: number | string): WorldFaction | undefined {
  const factions = listFactions(db, campaignId, { includeEnded: true });
  if (typeof ref === 'number') return factions.find((faction) => faction.id === ref);
  const name = ref.trim().toLowerCase();
  return factions.find((faction) => faction.name.toLowerCase() === name);
}

/** Codex entity lookup by id or case-insensitive name; codex.ts's finder is not exported. */
function findEntity(db: Db, campaignId: number, ref: number | string): EntityRefRow | undefined {
  const sql =
    typeof ref === 'number'
      ? 'SELECT id, name FROM entity WHERE campaign_id = ? AND id = ?'
      : 'SELECT id, name FROM entity WHERE campaign_id = ? AND lower(name) = lower(?)';
  return db.prepare(sql).get(campaignId, ref) as EntityRefRow | undefined;
}

function agendaSummary(agenda: WorldAgenda, factionName: string): Record<string, unknown> {
  return {
    id: agenda.id,
    faction: factionName,
    template: agenda.template,
    target_name: agenda.target_name,
    clock: `${agenda.clock_filled}/${agenda.clock_size}`,
    status: agenda.status,
    known_to_party: agenda.known_to_party,
    portents: agenda.portents
      .filter((portent) => portent.fired_day !== null)
      .map((portent) => ({ text: portent.text, fired_day: portent.fired_day, heard: portent.heard })),
  };
}

/** Half the magnitude toward zero, opposite sign: +3 -> -1, +1 -> none, -4 -> +2; small favours go unnoticed. */
function oppositeHalf(value: number): number {
  return -Math.sign(value) * Math.floor(Math.abs(value) / 2);
}

/** Factions one hop from this one: it targets them, or they target it, on an active rivalry. */
function rivalFactionIds(db: Db, campaignId: number, factionId: number): number[] {
  const ids = new Set<number>();
  for (const agenda of listAgendas(db, campaignId, { status: 'active' })) {
    if (agenda.target_kind !== 'rival_faction') continue;
    if (agenda.target_id === factionId) ids.add(agenda.faction_id);
    if (agenda.faction_id === factionId && agenda.target_id !== null) ids.add(agenda.target_id);
  }
  ids.delete(factionId);
  return [...ids];
}

/** The place the party stands at: the latest scene location matched to the region map. */
function partyPlace(db: Db, campaignId: number): WorldPlace | undefined {
  const scene = db
    .prepare(
      'SELECT location_name FROM scene WHERE campaign_id = ? AND location_name IS NOT NULL ORDER BY id DESC LIMIT 1',
    )
    .get(campaignId) as { location_name: string } | undefined;
  return scene ? matchPlace(db, campaignId, scene.location_name) : undefined;
}

/** A rival hears of a deed when its seat lies within the deed's known range, or, with no place, shares its realm. */
function rivalHears(
  view: RegionView,
  place: WorldPlace | undefined,
  realmId: number | null,
  value: number,
  rival: WorldFaction,
): boolean {
  if (DEED_KNOWN_DAYS[Math.abs(value)] === Number.POSITIVE_INFINITY) return true;
  if (!place) return realmId !== null && rival.realm_id === realmId;
  const seat = rival.place_id !== null ? view.places.find((entry) => entry.id === rival.place_id) : undefined;
  return seat !== undefined && deedKnownAt(view, place, value, seat);
}

const signed = (n: number): string => `${n > 0 ? '+' : ''}${n}`;

export function registerWorldTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'world', {
    title: 'The living world',
    description:
      'The living world: factions pursuing agendas with clocks and portents, the news they spread, and how they regard the party. Use op=deed whenever the party helps or harms a faction or notable NPC.',
    fields: {
      campaign_id: z.number().int(),
      target: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe(
          '(op=deed) A faction id or name, or a codex entity id or name. (op=destroy) A faction id or name, or a danger site id or name, which clears every brood lairing there.',
        ),
      value: z
        .number()
        .int()
        .optional()
        .describe('(op=deed) How much the party helped (positive) or harmed (negative), from -5 to 5, never 0.'),
      reason: z
        .string()
        .optional()
        .describe(
          '(op=deed, op=setback, op=thwart) Why, in a few words, as the party would remember it. (op=destroy) Needed only for a faction, not a danger site. The player sees deed reasons in the World tab, so never name a secret or an unrevealed place.',
        ),
      agenda: z
        .number()
        .int()
        .optional()
        .describe('(op=reveal, op=setback, op=thwart) The agenda id the op acts on.'),
      amount: z
        .number()
        .int()
        .optional()
        .describe('(op=setback) How far to lower the clock, an integer from 1 to 3.'),
      place: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe("(op=deed) Where it happened, a place id or name on the region map; defaults to the party's place."),
      faction: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe('(op=get) One faction by id or name, in full: attitude reasons, agendas with their fired portents, who targets it, recent events.'),
      type: z
        .string()
        .optional()
        .describe('(op=get) List only factions of this type, such as realm, house, guild, gang, church, bandits or monsters.'),
      near: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe('(op=get) A place id or name; list the factions seated within two days of it and the agendas landing there.'),
      page: z
        .number()
        .int()
        .optional()
        .describe('(op=get) Which page, from 1: alone it lists the factions the default view only counted; with type or near it pages that list.'),
    },
    ops: {
      get: {
        summary:
          "The world centred on the party: factions seated within two days of them, any with a non-zero attitude or a known agenda, those agendas with ids and clocks, and the map's state; the rest is counted. Narrow it with faction, type, near or page; all of it DM-only",
        requires: [],
        uses: ['faction', 'type', 'near', 'page'],
        run: (args) => {
          const { op, ...input } = args;
          const campaignId = input.campaign_id;
          if (input.faction !== undefined && (input.type !== undefined || input.near !== undefined || input.page !== undefined)) {
            throw new Error('faction shows one faction in full; call it without type, near or page.');
          }
          if (input.page !== undefined && input.page < 1) throw new Error(`page counts from 1, got ${input.page}.`);

          // Seeding and the read share one transaction, so a refused filter costs nothing, not even the world.
          return db.transaction(() => {
            requireWorld(db, campaignId);
            const faction = input.faction !== undefined ? findFaction(db, campaignId, input.faction) : undefined;
            if (input.faction !== undefined && !faction) {
              throw new Error(
                `No faction "${String(input.faction)}" in this campaign. world {op: get} counts them by type; add type or page to list them.`,
              );
            }
            const near =
              input.near === undefined
                ? undefined
                : typeof input.near === 'number'
                  ? findPlace(db, campaignId, input.near)
                  : matchPlace(db, campaignId, input.near);
            if (input.near !== undefined && !near) {
              throw new Error(`No place "${String(input.near)}" on the region map. Call region with op=get for the list.`);
            }
            const digest = worldDigest(db, campaignId, {
              party: partyPlace(db, campaignId),
              faction,
              type: input.type,
              near,
              page: input.page,
            });
            return reply(db, campaignId, digest.data, digest.text);
          })();
        },
      },
      deed: {
        summary:
          "Record how the party helped or harmed a faction or notable NPC, value -5..5 (negative harms), at a place (default the party's); a faction's rivals who hear of it feel the opposite at half strength",
        requires: ['target', 'value', 'reason'],
        uses: ['place'],
        run: (args) => {
          const { op, ...input } = args;
          const campaignId = input.campaign_id;

          const value = input.value!;
          if (!Number.isInteger(value) || value === 0 || value < -5 || value > 5) {
            throw new Error(`A deed value must be a non-zero integer from -5 to 5, got ${value}.`);
          }
          const reason = input.reason!.trim();
          if (reason === '') throw new Error('A deed needs a reason; say what the party did.');

          // Seeding and the writes share one transaction, so a refused target costs nothing, not even the world.
          return db.transaction(() => {
            requireWorld(db, campaignId);

            const faction = findFaction(db, campaignId, input.target!);
            const entity = faction ? undefined : findEntity(db, campaignId, input.target!);
            if (!faction && !entity) {
              throw new Error(
                `No faction or codex entity "${String(input.target)}" in this campaign. world {op: get} lists the factions; get_codex lists the entities.`,
              );
            }
            if (faction && faction.ended_day != null) {
              throw new Error(
                `${faction.name} ended on day ${faction.ended_day}; a deed can only change how a living faction regards the party. world {op: get} lists the living ones.`,
              );
            }

            const place =
              input.place === undefined
                ? partyPlace(db, campaignId)
                : typeof input.place === 'number'
                  ? findPlace(db, campaignId, input.place)
                  : matchPlace(db, campaignId, input.place);
            if (input.place !== undefined && !place) {
              throw new Error(`No place "${String(input.place)}" on the region map. Call region with op=get for the list.`);
            }
            // With no place the deed belongs to the target faction's realm, if it has one.
            const realmId = place ? (placePolitics(db, campaignId, place).realm?.id ?? null) : (faction?.realm_id ?? null);
            const knownDays = DEED_KNOWN_DAYS[Math.abs(value)]!;
            const scope = { place_id: place?.id ?? null, realm_id: realmId };

            const today = currentGameDay(db, campaignId);
            const recorded: Array<{
              subject_kind: 'faction' | 'entity';
              subject_id: number;
              subject_name: string;
              value: number;
              reason: string;
            }> = [];

            if (faction) {
              const stored = addAttitude(
                db,
                campaignId,
                { kind: 'faction', id: faction.id },
                { value, reason, day: today, ...scope },
              );
              ensureFactionEntity(db, campaignId, faction);
              recorded.push({
                subject_kind: 'faction',
                subject_id: faction.id,
                subject_name: faction.name,
                value: stored.value,
                reason: stored.reason,
              });
              const view = getRegion(db, campaignId)!;
              const factions = listFactions(db, campaignId);
              for (const rivalId of rivalFactionIds(db, campaignId, faction.id)) {
                const rival = factions.find((entry) => entry.id === rivalId);
                if (!rival) continue;
                const rivalValue = oppositeHalf(value);
                if (rivalValue === 0) continue;
                if (!rivalHears(view, place, realmId, value, rival)) continue;
                const rivalReason = `${reason} (rival of ${faction.name})`;
                const rivalStored = addAttitude(
                  db,
                  campaignId,
                  { kind: 'faction', id: rival.id },
                  { value: rivalValue, reason: rivalReason, day: today, ...scope, rival_of: faction.id },
                );
                recorded.push({
                  subject_kind: 'faction',
                  subject_id: rival.id,
                  subject_name: rival.name,
                  value: rivalStored.value,
                  reason: rivalStored.reason,
                });
              }
            } else {
              const stored = addAttitude(
                db,
                campaignId,
                { kind: 'entity', id: entity!.id },
                { value, reason, day: today, ...scope },
              );
              recorded.push({
                subject_kind: 'entity',
                subject_id: entity!.id,
                subject_name: entity!.name,
                value: stored.value,
                reason: stored.reason,
              });
            }

            const regarded = recorded.map((entry) => {
              const total = attitudeOf(db, campaignId, { kind: entry.subject_kind, id: entry.subject_id }, today).total;
              return { ...entry, total, band: attitudeBand(total) };
            });
            const wholeMap = knownDays === Number.POSITIVE_INFINITY;
            const lines = regarded.map(
              (entry) =>
                `${entry.subject_name}: ${signed(entry.value)} ${entry.reason}; now ${entry.band} (${signed(entry.total)})`,
            );
            if (wholeMap) lines.push(`Known across the whole map${place ? `; done at ${place.name}` : ''}.`);
            else if (place) lines.push(`Done at ${place.name}; known within ${knownDays} day(s) of travel.`);
            else if (faction) lines.push('No place on the map, so only rivals in its realm hear of it.');
            return reply(
              db,
              campaignId,
              {
                target: { kind: faction ? 'faction' : 'entity', id: faction?.id ?? entity!.id, name: faction?.name ?? entity!.name },
                place: place ? { id: place.id, name: place.name } : null,
                realm_id: realmId,
                known_within_days: wholeMap ? null : knownDays,
                recorded: regarded,
              },
              lines.join('\n'),
            );
          })();
        },
      },
      reveal: {
        summary: 'Mark an agenda known to the party, so its clock and portents can reach the player',
        requires: ['agenda'],
        uses: [],
        run: (args) => {
          const { op, ...input } = args;
          const campaignId = input.campaign_id;
          // Seeding and the update share one transaction, so an unknown agenda costs nothing, not even the world.
          return db.transaction(() => {
            requireWorld(db, campaignId);
            const agenda = listAgendas(db, campaignId).find((entry) => entry.id === input.agenda!);
            if (!agenda) {
              throw new Error(`No agenda ${input.agenda} in this campaign. world {op: get} lists the agendas.`);
            }
            const updated = updateAgenda(db, campaignId, agenda.id, { known_to_party: true });
            const faction = listFactions(db, campaignId, { includeEnded: true }).find((entry) => entry.id === updated.faction_id);
            if (faction) ensureFactionEntity(db, campaignId, faction);
            const summary = agendaSummary(updated, faction?.name ?? `faction ${updated.faction_id}`);
            return reply(
              db,
              campaignId,
              { agenda: summary },
              `${String(summary.faction)}'s ${String(summary.template)} against ${String(summary.target_name)} is now known to the party (clock ${String(summary.clock)}).`,
            );
          })();
        },
      },
      setback: {
        summary: "Lower an agenda's clock by 1 to 3 as the party interferes",
        requires: ['agenda', 'amount', 'reason'],
        uses: [],
        run: (args) => {
          const { op, ...input } = args;
          const campaignId = input.campaign_id;
          const amount = input.amount!;
          if (!Number.isInteger(amount) || amount < 1 || amount > 3) {
            throw new Error(`A setback amount must be an integer from 1 to 3, got ${amount}.`);
          }
          const reason = input.reason!.trim();
          if (reason === '') throw new Error('A setback needs a reason; say how the party interfered.');

          // Seeding and the write share one transaction, so a refused agenda costs nothing, not even the world.
          return db.transaction(() => {
            requireWorld(db, campaignId);
            const agenda = listAgendas(db, campaignId).find((entry) => entry.id === input.agenda!);
            if (!agenda) {
              throw new Error(`No agenda ${input.agenda} in this campaign. world {op: get} lists the agendas.`);
            }
            const today = currentGameDay(db, campaignId);
            const { agenda: updated, event } = setbackAgenda(db, campaignId, agenda.id, amount, reason, today);
            const faction = listFactions(db, campaignId, { includeEnded: true }).find(
              (entry) => entry.id === updated.faction_id,
            );
            const name = faction?.name ?? `faction ${updated.faction_id}`;
            return reply(
              db,
              campaignId,
              { agenda: agendaSummary(updated, name), event: { day: event.day, text: event.text } },
              `${name}'s ${updated.template} against ${updated.target_name} is set back (clock ${updated.clock_filled}/${updated.clock_size}).`,
            );
          })();
        },
      },
      thwart: {
        summary: "End a faction's agenda as lost and hold that faction back from a new one for 30 days",
        requires: ['agenda', 'reason'],
        uses: [],
        run: (args) => {
          const { op, ...input } = args;
          const campaignId = input.campaign_id;
          const reason = input.reason!.trim();
          if (reason === '') throw new Error('A thwart needs a reason; say how the party foiled the plan.');

          // Seeding and the write share one transaction, so a refused agenda costs nothing, not even the world.
          return db.transaction(() => {
            requireWorld(db, campaignId);
            const agenda = listAgendas(db, campaignId).find((entry) => entry.id === input.agenda!);
            if (!agenda) {
              throw new Error(`No agenda ${input.agenda} in this campaign. world {op: get} lists the agendas.`);
            }
            const today = currentGameDay(db, campaignId);
            const { agenda: lost, faction, event, cooldown_until } = thwartAgenda(
              db,
              campaignId,
              agenda.id,
              reason,
              today,
            );
            return reply(
              db,
              campaignId,
              {
                agenda: agendaSummary(lost, faction.name),
                faction: { id: faction.id, name: faction.name, resources: faction.resources },
                cooldown_until,
                event: { day: event.day, text: event.text },
              },
              `${faction.name}'s ${lost.template} against ${lost.target_name} is lost; it takes no new agenda before day ${cooldown_until}.`,
            );
          })();
        },
      },
      destroy: {
        summary: 'Destroy a faction, or clear a danger site and end every brood lairing there',
        requires: ['target'],
        uses: ['reason'],
        run: (args) => {
          const { op, ...input } = args;
          const campaignId = input.campaign_id;
          const target = input.target!;

          // Seeding and the write share one transaction, so a refused target costs nothing, not even the world.
          return db.transaction(() => {
            requireWorld(db, campaignId);
            const today = currentGameDay(db, campaignId);
            const faction = findFaction(db, campaignId, target);
            // A bare number can label both a faction and a danger site, so make the caller say which by name.
            if (typeof target === 'number' && faction && faction.ended_day == null) {
              const danger = findPlace(db, campaignId, target);
              if (danger?.kind === 'danger') {
                throw new Error(
                  `Target ${target} is both the faction "${faction.name}" and the danger site "${danger.name}"; destroy by name instead.`,
                );
              }
            }
            if (faction) {
              const reason = input.reason?.trim() ?? '';
              if (reason === '') throw new Error(`Destroying ${faction.name} needs a reason; say what happened to it.`);
              const { faction: ended, abandoned, event } = destroyFaction(db, campaignId, faction.id, reason, today);
              const tail =
                abandoned.length === 0 ? 'no agenda was in play' : `${abandoned.length} agenda(s) abandoned`;
              return reply(
                db,
                campaignId,
                {
                  faction: { id: ended.id, name: ended.name, ended_day: ended.ended_day },
                  abandoned: abandoned.map((entry) => entry.id),
                  event: { day: event.day, text: event.text },
                },
                `${ended.name} is destroyed; ${tail}.`,
              );
            }

            const place =
              typeof target === 'number' ? findPlace(db, campaignId, target) : matchPlace(db, campaignId, target);
            if (!place || place.kind !== 'danger') {
              throw new Error(
                `No faction or danger site "${String(target)}" in this campaign. world {op: get} lists the factions; the region lists the danger sites.`,
              );
            }
            const cleared = clearDanger(db, campaignId, place.id, today);
            const tail =
              cleared.length === 0 ? 'no brood laired there' : `${cleared.length} brood(s) ended`;
            return reply(
              db,
              campaignId,
              {
                danger: { id: place.id, name: place.name },
                destroyed: cleared.map((entry) => ({ id: entry.faction.id, name: entry.faction.name })),
              },
              `${place.name} is cleared; ${tail}.`,
            );
          })();
        },
      },
    },
    annotations: { ...ANNOTATIONS },
  });
}
