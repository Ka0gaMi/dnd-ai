import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { ensureFactionEntity } from '../../core/world-codex.js';
import { factionFaith, listFaiths } from '../../core/world-faith-store.js';
import { addAttitude, attitudeOf, type AttitudeSubject } from '../../core/world-memory.js';
import { matchPlace } from '../../core/place-match.js';
import { findPlace } from '../../core/region.js';
import { ensureWorld } from '../../core/world-seed.js';
import {
  currentGameDay,
  listAgendas,
  listEvents,
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

function attitudeFor(
  db: Db,
  campaignId: number,
  subject: AttitudeSubject,
  today: number,
): { total: number; reasons: Array<{ reason: string; value: number; current: number }> } {
  const { total, reasons } = attitudeOf(db, campaignId, subject, today);
  return { total, reasons: reasons.slice(0, 3).map((r) => ({ reason: r.reason, value: r.value, current: r.current })) };
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
    },
    ops: {
      get: {
        summary:
          'Every faction and how it regards the party, the agendas in motion with their clocks and portents, and the last ten things the world did; all of it DM-only',
        requires: [],
        uses: [],
        run: (args) => {
          const { op, ...input } = args;
          const campaignId = input.campaign_id;
          requireWorld(db, campaignId);
          const today = currentGameDay(db, campaignId);
          const factions = listFactions(db, campaignId, { includeEnded: true });
          const names = new Map(factions.map((faction) => [faction.id, faction.name]));
          const agendaList = listAgendas(db, campaignId).filter(
            (agenda) => agenda.status === 'active' || agenda.status === 'held',
          );
          const events = listEvents(db, campaignId).slice(-10);

          const factionData = factions.map((faction) => ({
            id: faction.id,
            name: faction.name,
            type: faction.type,
            secrecy: faction.secrecy,
            resources: faction.resources,
            ended_day: faction.ended_day ?? null,
            attitude: attitudeFor(db, campaignId, { kind: 'faction', id: faction.id }, today),
          }));
          const agendaData = agendaList.map((agenda) =>
            agendaSummary(agenda, names.get(agenda.faction_id) ?? `faction ${agenda.faction_id}`),
          );
          const eventData = events.map((event) => ({
            day: event.day,
            text: event.text,
            severity: event.severity,
            visibility: event.visibility,
          }));
          const placeStateData = (
            db
              .prepare(
                `SELECT place_id, state, until_day FROM world_place_state
                  WHERE campaign_id = ? AND state IS NOT NULL AND until_day > ?
                  ORDER BY until_day, place_id`,
              )
              .all(campaignId, today) as Array<{ place_id: number; state: string; until_day: number }>
          )
            .map((row) => {
              const place = findPlace(db, campaignId, row.place_id);
              return place ? { place: place.name, state: row.state, until_day: row.until_day } : null;
            })
            .filter((entry): entry is { place: string; state: string; until_day: number } => entry !== null);

          const faithList = listFaiths(db, campaignId);
          const faithNames = new Map(faithList.map((faith) => [faith.id, faith.name]));
          const realmNames = new Map(
            (
              db.prepare('SELECT id, name FROM world_realm WHERE campaign_id = ?').all(campaignId) as Array<{
                id: number;
                name: string;
              }>
            ).map((row) => [row.id, row.name]),
          );
          const faithLinks = new Map(factions.map((faction) => [faction.id, factionFaith(db, campaignId, faction.id)]));
          const faithData = faithList.map((faith) => {
            const branches: Array<{ faction: string; realm: string | null; influence: string | null }> = [];
            for (const faction of factions) {
              if (faithLinks.get(faction.id)?.faith_id !== faith.id) continue;
              branches.push({
                faction: faction.name,
                realm: faction.realm_id !== null ? realmNames.get(faction.realm_id) ?? null : null,
                influence: faithLinks.get(faction.id)?.influence ?? null,
              });
            }
            const head = faith.head_place_id !== null ? findPlace(db, campaignId, faith.head_place_id) : undefined;
            return {
              id: faith.id,
              name: faith.name,
              aspect: faith.aspect,
              head: head?.name ?? null,
              fervor: faith.fervor,
              heresy_of: faith.heresy_of !== null ? faithNames.get(faith.heresy_of) ?? null : null,
              branches,
            };
          });
          const contestData = (
            db
              .prepare(
                'SELECT realm_id, faith_id, filled, size FROM world_contest WHERE campaign_id = ? AND filled > 0 ORDER BY realm_id, faith_id',
              )
              .all(campaignId) as Array<{ realm_id: number; faith_id: number; filled: number; size: number }>
          ).map((row) => ({
            realm: realmNames.get(row.realm_id) ?? `realm ${row.realm_id}`,
            faith: faithNames.get(row.faith_id) ?? `faith ${row.faith_id}`,
            filled: row.filled,
            size: row.size,
          }));
          const excommunicatedData = (
            db
              .prepare(
                'SELECT id, excommunicated_until FROM world_realm WHERE campaign_id = ? AND excommunicated_until IS NOT NULL ORDER BY id',
              )
              .all(campaignId) as Array<{ id: number; excommunicated_until: number }>
          ).map((row) => ({
            realm: realmNames.get(row.id) ?? `realm ${row.id}`,
            until_day: row.excommunicated_until,
          }));

          const lines = ['DM only - the party never sees any of this, except deed reasons, which the World tab shows.', 'Factions:'];
          if (factionData.length === 0) lines.push('- none');
          for (const faction of factionData) {
            const reasons =
              faction.attitude.reasons.length > 0
                ? ` (${faction.attitude.reasons
                    .map((r) => `${r.current >= 0 ? '+' : ''}${r.current} ${r.reason}`)
                    .join('; ')})`
                : '';
            const ended = faction.ended_day !== null ? ` [ended day ${faction.ended_day}]` : '';
            lines.push(
              `- ${faction.name} (${faction.type}, ${faction.secrecy}, resources ${faction.resources}): regards the party ${faction.attitude.total}${reasons}${ended}`,
            );
          }
          lines.push('Agendas:');
          if (agendaData.length === 0) lines.push('- none');
          for (const agenda of agendaData) {
            const known = agenda.known_to_party === true ? ' [known to the party]' : '';
            lines.push(
              `- ${String(agenda.faction)}: ${String(agenda.template)} -> ${String(agenda.target_name)} (clock ${String(agenda.clock)}, ${String(agenda.status)})${known}`,
            );
            for (const portent of agenda.portents as Array<{ heard: boolean; text: string }>) {
              lines.push(`  portent (${portent.heard ? 'heard' : 'unheard'}): ${portent.text}`);
            }
          }
          lines.push('Recent world events:');
          if (eventData.length === 0) lines.push('- none');
          for (const event of eventData) {
            lines.push(`- day ${event.day} (${event.visibility}, severity ${event.severity}): ${event.text}`);
          }

          if (placeStateData.length > 0) {
            lines.push('Place states:');
            for (const row of placeStateData) {
              lines.push(`- ${row.place}: ${row.state} until day ${row.until_day}`);
            }
          }

          lines.push('Faiths:');
          if (faithData.length === 0) lines.push('- none');
          for (const faith of faithData) {
            const heresy = faith.heresy_of !== null ? `, heresy of ${faith.heresy_of}` : '';
            const branches =
              faith.branches.length > 0
                ? faith.branches
                    .map(
                      (branch) =>
                        `${branch.faction} holds ${branch.influence ?? 'no'} sway${branch.realm !== null ? ` in ${branch.realm}` : ''}`,
                    )
                    .join('; ')
                : 'no branches';
            lines.push(`- ${faith.name} (fervor ${faith.fervor}, head ${faith.head ?? 'none'}${heresy}): ${branches}`);
          }
          if (contestData.length > 0) {
            lines.push('Church contests:');
            for (const contest of contestData) {
              lines.push(`- ${contest.realm}: ${contest.faith} at ${contest.filled}/${contest.size}`);
            }
          }
          if (excommunicatedData.length > 0) {
            lines.push('Excommunicated:');
            for (const row of excommunicatedData) {
              lines.push(`- ${row.realm} until day ${row.until_day}`);
            }
          }

          return reply(
            db,
            campaignId,
            {
              factions: factionData,
              agendas: agendaData,
              recent_events: eventData,
              place_states: placeStateData,
              faiths: faithData,
              contests: contestData,
              excommunicated: excommunicatedData,
            },
            lines.join('\n'),
          );
        },
      },
      deed: {
        summary:
          "Record how the party helped or harmed a faction or notable NPC, value -5..5 (negative harms); a faction's rivals feel the opposite at half strength",
        requires: ['target', 'value', 'reason'],
        uses: [],
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

            const today = currentGameDay(db, campaignId);
            const recorded: Array<{
              subject_kind: string;
              subject_id: number;
              subject_name: string;
              value: number;
              reason: string;
            }> = [];

            if (faction) {
              const stored = addAttitude(db, campaignId, { kind: 'faction', id: faction.id }, { value, reason, day: today });
              ensureFactionEntity(db, campaignId, faction);
              recorded.push({
                subject_kind: 'faction',
                subject_id: faction.id,
                subject_name: faction.name,
                value: stored.value,
                reason: stored.reason,
              });
              const factions = listFactions(db, campaignId);
              for (const rivalId of rivalFactionIds(db, campaignId, faction.id)) {
                const rival = factions.find((entry) => entry.id === rivalId);
                if (!rival) continue;
                const rivalValue = oppositeHalf(value);
                if (rivalValue === 0) continue;
                const rivalReason = `${reason} (rival of ${faction.name})`;
                const rivalStored = addAttitude(
                  db,
                  campaignId,
                  { kind: 'faction', id: rival.id },
                  { value: rivalValue, reason: rivalReason, day: today },
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
              const stored = addAttitude(db, campaignId, { kind: 'entity', id: entity!.id }, { value, reason, day: today });
              recorded.push({
                subject_kind: 'entity',
                subject_id: entity!.id,
                subject_name: entity!.name,
                value: stored.value,
                reason: stored.reason,
              });
            }

            const lines = recorded.map(
              (entry) => `${entry.subject_name} now regards the party ${entry.value >= 0 ? '+' : ''}${entry.value}: ${entry.reason}`,
            );
            return reply(
              db,
              campaignId,
              {
                target: { kind: faction ? 'faction' : 'entity', id: faction?.id ?? entity!.id, name: faction?.name ?? entity!.name },
                recorded,
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
