// Decisions only the player can make - today: whether a piece of homebrew goes on their sheet.
// The shape follows the pending-roll pattern: a row, a pushed card, a tool that waits for it.
import { EventEmitter } from 'node:events';
import type { Db } from '../db/connection.js';
import { bus } from './bus.js';
import { getCampaign, logEvent } from './campaign.js';
import { grantFeature, grantSpell } from './character.js';
import type { Clause } from './mechanics.js';
import {
  powerReport,
  saveHomebrew,
  type HomebrewClauseStatus,
  type Mechanics,
  type PowerReport,
  type SpellSchema,
} from './progression.js';

export type DecisionChoice = 'accept' | 'reject' | 'edit';

export interface PendingDecisionRow {
  id: number;
  campaign_id: number;
  kind: string;
  payload_json: string;
  created_at: string;
  resolved_at: string | null;
  decision_json: string | null;
}

/** What the dialog in the player's window shows, and what accepting it applies. */
export interface HomebrewDecisionPayload {
  name: string;
  text: string;
  mechanics: Mechanics;
  /** What it does as clauses, which is what the engine runs; stored beside the mechanics. */
  clauses?: Clause[];
  /** Per clause, the same line the Library shows; a spell carries no clauses and sends none. */
  clause_status?: HomebrewClauseStatus[];
  justification?: string;
  report: PowerReport;
  character_id: number | null;
  /** Which kind of homebrew is being decided; a feature when the field is absent. */
  homebrew_kind?: 'feature' | 'subclass' | 'spell';
  /** The whole subclass or spell schema, which is what the dialog renders and accepting stores. */
  schema?: Record<string, unknown>;
  /** A subclass written as a recreation of an official one: the label it is stored under. */
  recreated_from?: string | null;
}

export interface DecisionResult {
  decision: DecisionChoice;
  summary: string;
  applied: boolean;
  name: string;
  power_label: 'within' | 'over_budget';
  homebrew_id?: number;
  /** For a spell the player accepted: whether it went on their sheet, and where. */
  spell?: { added: boolean; where: 'cantrips' | 'prepared' | null; reason?: string };
}

/** Carries the HTTP status the resolve route answers with. */
export class DecisionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const waiters = new EventEmitter();
const nowIso = (): string => new Date().toISOString();

function parse<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function getDecision(db: Db, id: number): PendingDecisionRow | undefined {
  return db.prepare('SELECT * FROM pending_decision WHERE id = ?').get(id) as PendingDecisionRow | undefined;
}

export function openDecisions(db: Db, campaignId: number): PendingDecisionRow[] {
  return db
    .prepare('SELECT * FROM pending_decision WHERE campaign_id = ? AND resolved_at IS NULL ORDER BY id')
    .all(campaignId) as PendingDecisionRow[];
}

/** Writes the question and pushes it to the companion window, which answers it as a dialog. */
export function createDecision(
  db: Db,
  input: { campaign_id: number; kind: string; payload: HomebrewDecisionPayload },
): PendingDecisionRow {
  getCampaign(db, input.campaign_id);
  const ts = nowIso();
  const id = Number(
    db
      .prepare('INSERT INTO pending_decision (campaign_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)')
      .run(input.campaign_id, input.kind, JSON.stringify(input.payload), ts).lastInsertRowid,
  );
  const row = getDecision(db, id)!;
  bus.publish({
    campaign_id: row.campaign_id,
    event_id: null,
    kind: 'pending_decision',
    text: `${input.payload.name}: ${input.payload.report.verdict === 'within' ? 'within the power budget' : 'over the power budget'}.`,
    ts,
    payload: { ...row, payload: input.payload },
  });
  return row;
}

/** Puts the feature on the sheet and keeps its schema as campaign homebrew. */
export function applyHomebrewFeature(
  db: Db,
  campaignId: number,
  payload: HomebrewDecisionPayload,
  createdBy: 'dm' | 'player' = 'dm',
): { homebrew_id: number; power_label: 'within' | 'over_budget' } {
  const overBudget = payload.mechanics.over_budget === true || payload.report.verdict === 'over_budget';
  const powerLabel = overBudget ? 'over_budget' : 'within';
  const entry = saveHomebrew(db, {
    campaign_id: campaignId,
    kind: 'feature',
    name: payload.name,
    schema: {
      text: payload.text,
      mechanics: payload.mechanics,
      ...(payload.clauses ? { clauses: payload.clauses } : {}),
      justification: payload.justification ?? null,
    },
    report: payload.report,
    power_label: powerLabel,
    created_by: createdBy,
  });
  grantFeature(db, {
    campaign_id: campaignId,
    character_id: payload.character_id ?? undefined,
    name: payload.name,
    text: payload.text,
    source: 'homebrew',
    mechanics: { homebrew_id: entry.id, ...(overBudget ? { over_budget: true } : {}) },
    // Both propose_feature paths land here, and this is the event the boon cadence counts.
    boon: true,
  });
  return { homebrew_id: entry.id, power_label: powerLabel };
}

const overBudgetOf = (payload: HomebrewDecisionPayload): boolean =>
  payload.mechanics.over_budget === true || payload.report.verdict === 'over_budget';

/** Stores the subclass as campaign homebrew: usable at the next subclass choice, not yet chosen. */
export function applyHomebrewSubclass(
  db: Db,
  campaignId: number,
  payload: HomebrewDecisionPayload,
  createdBy: 'dm' | 'player' = 'dm',
): { homebrew_id: number; power_label: 'within' | 'over_budget' } {
  const powerLabel = overBudgetOf(payload) ? 'over_budget' : 'within';
  const entry = saveHomebrew(db, {
    campaign_id: campaignId,
    kind: 'subclass',
    name: payload.name,
    schema: { ...(payload.schema ?? {}), justification: payload.justification ?? null },
    report: payload.report,
    power_label: powerLabel,
    created_by: createdBy,
    recreated_from: payload.recreated_from ?? null,
  });
  return { homebrew_id: entry.id, power_label: powerLabel };
}

/** Stores the spell as campaign homebrew and, when a caster was named, puts it on their sheet. */
export function applyHomebrewSpell(
  db: Db,
  campaignId: number,
  payload: HomebrewDecisionPayload,
  createdBy: 'dm' | 'player' = 'dm',
): { homebrew_id: number; power_label: 'within' | 'over_budget'; spell: DecisionResult['spell'] } {
  const powerLabel = overBudgetOf(payload) ? 'over_budget' : 'within';
  const schema = (payload.schema ?? {}) as Partial<SpellSchema>;
  const entry = saveHomebrew(db, {
    campaign_id: campaignId,
    kind: 'spell',
    name: payload.name,
    schema: { ...(payload.schema ?? {}), justification: payload.justification ?? null },
    report: payload.report,
    power_label: powerLabel,
    created_by: createdBy,
  });
  // Only a named caster gets it on their sheet; otherwise the spell is the campaign's to hand out.
  const spell: DecisionResult['spell'] =
    payload.character_id === null
      ? { added: false, where: null, reason: 'No character was named, so the spell is stored for the campaign only.' }
      : grantSpell(db, {
          campaign_id: campaignId,
          character_id: payload.character_id,
          name: entry.name,
          level: schema.level ?? 0,
        });
  return { homebrew_id: entry.id, power_label: powerLabel, spell };
}

function summarize(decision: DecisionChoice, payload: HomebrewDecisionPayload): string {
  const over = payload.report.verdict === 'over_budget';
  if (decision === 'reject') return `Player rejected "${payload.name}".`;
  const verb = decision === 'edit' ? 'edited and accepted' : 'accepted';
  return `Player ${verb} "${payload.name}"${over ? ' despite the over-budget warning' : ''}.`;
}

/**
 * The player's answer: it stands whether or not the tool call is still waiting for it, so a decision
 * that arrives late still puts the feature on the sheet and turns up as an event and in the briefing.
 */
export function resolveDecision(
  db: Db,
  id: number,
  input: { decision: DecisionChoice; edits?: Partial<Pick<HomebrewDecisionPayload, 'name' | 'text' | 'mechanics'>> },
): DecisionResult {
  const row = getDecision(db, id);
  if (!row) throw new DecisionError(`No decision with id ${id}.`, 404);
  const claimed = db
    .prepare('UPDATE pending_decision SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL')
    .run(nowIso(), id);
  if (claimed.changes === 0) throw new DecisionError(`Decision ${id} was already answered.`, 409);

  const stored = parse<HomebrewDecisionPayload>(row.payload_json, {} as HomebrewDecisionPayload);
  const edited: HomebrewDecisionPayload = { ...stored, ...(input.decision === 'edit' ? (input.edits ?? {}) : {}) };
  const kind = edited.homebrew_kind ?? 'feature';
  // Only a feature is priced from its mechanics; a subclass and a spell are priced from their schema.
  if (kind === 'feature' && input.decision === 'edit' && input.edits?.mechanics) {
    edited.report = powerReport({ ...edited.mechanics, clauses: edited.clauses });
  }

  const applied = input.decision !== 'reject';
  const done = !applied
    ? null
    : kind === 'subclass'
      ? applyHomebrewSubclass(db, row.campaign_id, edited, 'player')
      : kind === 'spell'
        ? applyHomebrewSpell(db, row.campaign_id, edited, 'player')
        : applyHomebrewFeature(db, row.campaign_id, edited, 'player');
  const result: DecisionResult = {
    decision: input.decision,
    summary: summarize(input.decision, edited),
    applied,
    name: edited.name,
    power_label: done?.power_label ?? (edited.report.verdict === 'over_budget' ? 'over_budget' : 'within'),
    ...(done ? { homebrew_id: done.homebrew_id } : {}),
    ...(done && 'spell' in done ? { spell: done.spell as DecisionResult['spell'] } : {}),
  };
  db.prepare('UPDATE pending_decision SET decision_json = ? WHERE id = ?').run(JSON.stringify(result), id);
  logEvent(db, {
    campaign_id: row.campaign_id,
    kind: 'homebrew_decision',
    text: result.summary,
    payload: { decision_id: id, ...result },
  });
  waiters.emit(`decision:${id}`);
  return result;
}

/** Waits for the player's answer; null means they did not answer in time and the DM moves on. */
export async function awaitDecision(db: Db, id: number, timeoutMs: number): Promise<DecisionResult | null> {
  const key = `decision:${id}`;
  if (getDecision(db, id)?.resolved_at === null) {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        waiters.off(key, done);
        resolve();
      }, timeoutMs);
      waiters.once(key, done);
    });
  }
  return parse<DecisionResult | null>(getDecision(db, id)?.decision_json ?? null, null);
}
