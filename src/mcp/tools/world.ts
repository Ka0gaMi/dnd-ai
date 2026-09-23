import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { addAttitude, attitudeOf, type AttitudeSubject } from '../../core/world-memory.js';
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
  const factions = listFactions(db, campaignId);
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

/** Half the magnitude away from zero, opposite sign: +3 -> -2, +1 -> -1, -4 -> +2. */
function oppositeHalf(value: number): number {
  return -Math.sign(value) * Math.ceil(Math.abs(value) / 2);
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
        .describe('(op=deed) A faction id or name, or a codex entity id or name.'),
      value: z
        .number()
        .int()
        .optional()
        .describe('(op=deed) How much the party helped (positive) or harmed (negative), from -5 to 5, never 0.'),
      reason: z.string().optional().describe('(op=deed) Why, in a few words; it becomes the remembered reason.'),
      agenda: z.number().int().optional().describe('(op=reveal) The agenda id to mark known to the party.'),
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
          const factions = listFactions(db, campaignId);
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

          const lines = ['DM only - the party never sees any of this.', 'Factions:'];
          if (factionData.length === 0) lines.push('- none');
          for (const faction of factionData) {
            const reasons =
              faction.attitude.reasons.length > 0
                ? ` (${faction.attitude.reasons
                    .map((r) => `${r.current >= 0 ? '+' : ''}${r.current} ${r.reason}`)
                    .join('; ')})`
                : '';
            lines.push(
              `- ${faction.name} (${faction.type}, ${faction.secrecy}, resources ${faction.resources}): regards the party ${faction.attitude.total}${reasons}`,
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

          return reply(
            db,
            campaignId,
            { factions: factionData, agendas: agendaData, recent_events: eventData },
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
          requireWorld(db, campaignId);

          const value = input.value!;
          if (!Number.isInteger(value) || value === 0 || value < -5 || value > 5) {
            throw new Error(`A deed value must be a non-zero integer from -5 to 5, got ${value}.`);
          }
          const reason = input.reason!.trim();
          if (reason === '') throw new Error('A deed needs a reason; say what the party did.');

          const faction = findFaction(db, campaignId, input.target!);
          const entity = faction ? undefined : findEntity(db, campaignId, input.target!);
          if (!faction && !entity) {
            throw new Error(
              `No faction or codex entity "${String(input.target)}" in this campaign. world {op: get} lists the factions; get_codex lists the entities.`,
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
        },
      },
      reveal: {
        summary: 'Mark an agenda known to the party, so its clock and portents can reach the player',
        requires: ['agenda'],
        uses: [],
        run: (args) => {
          const { op, ...input } = args;
          const campaignId = input.campaign_id;
          requireWorld(db, campaignId);
          const agenda = listAgendas(db, campaignId).find((entry) => entry.id === input.agenda!);
          if (!agenda) {
            throw new Error(`No agenda ${input.agenda} in this campaign. world {op: get} lists the agendas.`);
          }
          const updated = updateAgenda(db, campaignId, agenda.id, { known_to_party: true });
          const faction = listFactions(db, campaignId).find((entry) => entry.id === updated.faction_id);
          const summary = agendaSummary(updated, faction?.name ?? `faction ${updated.faction_id}`);
          return reply(
            db,
            campaignId,
            { agenda: summary },
            `${String(summary.faction)}'s ${String(summary.template)} against ${String(summary.target_name)} is now known to the party (clock ${String(summary.clock)}).`,
          );
        },
      },
    },
    annotations: { ...ANNOTATIONS },
  });
}
