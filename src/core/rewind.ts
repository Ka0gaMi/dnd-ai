import type { Db } from '../db/connection.js';
import { campaignSnapshot, getCampaign, logEvent, type Briefing } from './campaign.js';
import { cancelPendingRolls } from './rolls.js';

type Row = Record<string, unknown>;

/** Parent rows first: restoring in this order means a child never points at a missing parent. */
const TABLES = [
  'session',
  'scene',
  'character',
  'quest',
  'quest_step',
  'canon_fact',
  'glossary_entry',
  'encounter',
  'combatant',
  'effect',
  'combat_log',
] as const;

export interface CheckpointSnapshot {
  last_event_id: number;
  tables: Record<string, Row[]>;
  /** Where the story stood; absent in checkpoints written before scenes were captured. */
  campaign?: { current_session_id: number | null; current_scene_id: number | null };
}

export interface CheckpointRow {
  id: number;
  campaign_id: number;
  scene_id: number | null;
  created_at: string;
  snapshot_json: string;
}

const nowIso = (): string => new Date().toISOString();

/**
 * Everything a rewind puts back: the sessions and scenes, the party, the quests, the canon, the
 * glossary and any live fight.
 */
export function captureCheckpoint(db: Db, campaignId: number, sceneId: number | null): number {
  const campaign = getCampaign(db, campaignId);
  const encounters = db
    .prepare("SELECT * FROM encounter WHERE campaign_id = ? AND status = 'active'")
    .all(campaignId) as Row[];
  const encounterIds = encounters.map((e) => e.id as number);
  const snapshot: CheckpointSnapshot = {
    last_event_id: (db.prepare('SELECT MAX(id) AS id FROM event WHERE campaign_id = ?').get(campaignId) as {
      id: number | null;
    }).id ?? 0,
    campaign: { current_session_id: campaign.current_session_id, current_scene_id: campaign.current_scene_id },
    tables: {
      session: db.prepare('SELECT * FROM session WHERE campaign_id = ?').all(campaignId) as Row[],
      scene: db.prepare('SELECT * FROM scene WHERE campaign_id = ?').all(campaignId) as Row[],
      character: db.prepare('SELECT * FROM character WHERE campaign_id = ?').all(campaignId) as Row[],
      quest: db.prepare('SELECT * FROM quest WHERE campaign_id = ?').all(campaignId) as Row[],
      quest_step: db
        .prepare('SELECT * FROM quest_step WHERE quest_id IN (SELECT id FROM quest WHERE campaign_id = ?)')
        .all(campaignId) as Row[],
      canon_fact: db.prepare('SELECT * FROM canon_fact WHERE campaign_id = ?').all(campaignId) as Row[],
      glossary_entry: db.prepare('SELECT * FROM glossary_entry WHERE campaign_id = ?').all(campaignId) as Row[],
      encounter: encounters,
      combatant: childRows(db, 'combatant', encounterIds),
      effect: childRows(db, 'effect', encounterIds),
      combat_log: childRows(db, 'combat_log', encounterIds),
    },
  };
  return Number(
    db
      .prepare('INSERT INTO checkpoint (campaign_id, scene_id, created_at, snapshot_json) VALUES (?, ?, ?, ?)')
      .run(campaignId, sceneId, nowIso(), JSON.stringify(snapshot)).lastInsertRowid,
  );
}

export function latestCheckpoint(db: Db, campaignId: number): CheckpointRow | undefined {
  return db.prepare('SELECT * FROM checkpoint WHERE campaign_id = ? ORDER BY id DESC LIMIT 1').get(campaignId) as
    | CheckpointRow
    | undefined;
}

export interface RewindResult {
  checkpoint_id: number;
  checkpoint_at: string;
  scene_id: number | null;
  reverted_events: number;
  cancelled_rolls: number;
  briefing: Briefing;
}

/** Carries the HTTP status the rewind route answers with; anything else is a failed restore. */
export class RewindError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Puts the campaign back to its last checkpoint. Everything that happened since stays in the event
 * ledger, marked reverted, so the ledger is still a true record of the session.
 */
export function rewindToCheckpoint(db: Db, campaignId: number): RewindResult {
  const known = db.prepare('SELECT id FROM campaign WHERE id = ?').get(campaignId);
  if (!known) throw new RewindError(`No campaign with id ${campaignId}.`, 404);
  const checkpoint = latestCheckpoint(db, campaignId);
  if (!checkpoint) throw new RewindError(`Campaign ${campaignId} has no checkpoint to rewind to.`, 404);
  const snapshot = JSON.parse(checkpoint.snapshot_json) as CheckpointSnapshot;

  const reverted = db.transaction(() => {
    // Rows come back parent-first but are deleted child-first; deferring lets both orders be legal.
    db.pragma('defer_foreign_keys = ON');
    clearCombat(db, campaignId, snapshot.tables.encounter ?? []);
    db.prepare('DELETE FROM quest_step WHERE quest_id IN (SELECT id FROM quest WHERE campaign_id = ?)').run(campaignId);
    db.prepare('DELETE FROM quest WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM canon_fact WHERE campaign_id = ?').run(campaignId);
    db.prepare('DELETE FROM glossary_entry WHERE campaign_id = ?').run(campaignId);
    dropLaterRows(db, campaignId, snapshot);
    for (const table of TABLES) insertRows(db, table, snapshot.tables[table] ?? []);
    if (snapshot.campaign) {
      db.prepare('UPDATE campaign SET current_session_id = ?, current_scene_id = ? WHERE id = ?').run(
        snapshot.campaign.current_session_id,
        snapshot.campaign.current_scene_id,
        campaignId,
      );
    }
    return db
      .prepare('UPDATE event SET reverted = 1 WHERE campaign_id = ? AND id > ? AND reverted = 0')
      .run(campaignId, snapshot.last_event_id).changes;
  })();

  const cancelled = cancelPendingRolls(db, campaignId);
  logEvent(db, {
    campaign_id: campaignId,
    kind: 'rewind',
    text: `Rewound to the checkpoint of ${checkpoint.created_at}; ${reverted} later event(s) reverted.`,
    payload: { checkpoint_id: checkpoint.id, reverted_events: reverted, cancelled_rolls: cancelled },
  });

  return {
    checkpoint_id: checkpoint.id,
    checkpoint_at: checkpoint.created_at,
    scene_id: checkpoint.scene_id,
    reverted_events: reverted,
    cancelled_rolls: cancelled,
    briefing: campaignSnapshot(db, campaignId),
  };
}

/** The ids in a snapshot table as a SQL list; -1 stands in for none, so NOT IN stays valid SQL. */
const idList = (rows: Row[]): string => (rows.length ? rows.map((r) => Number(r.id)).join(',') : '-1');

/**
 * Characters, scenes and sessions created after the checkpoint are gone: a PC rolled up since must
 * not survive the rewind, and a later scene must not show up as the story so far. The reverted events
 * and any fight already over keep their text but lose the pointer to a row that no longer exists.
 */
function dropLaterRows(db: Db, campaignId: number, snapshot: CheckpointSnapshot): void {
  const characters = idList(snapshot.tables.character ?? []);
  db.prepare(
    `UPDATE combatant SET character_id = NULL
     WHERE character_id IN (SELECT id FROM character WHERE campaign_id = ?) AND character_id NOT IN (${characters})`,
  ).run(campaignId);
  db.prepare(`DELETE FROM character WHERE campaign_id = ? AND id NOT IN (${characters})`).run(campaignId);

  // A checkpoint written before scenes were captured has neither table; it can only restore what it holds.
  if (!snapshot.tables.scene || !snapshot.tables.session) return;
  const scenes = idList(snapshot.tables.scene);
  const sessions = idList(snapshot.tables.session);
  db.prepare(`UPDATE event SET scene_id = NULL WHERE campaign_id = ? AND scene_id NOT IN (${scenes})`).run(campaignId);
  db.prepare(`UPDATE event SET session_id = NULL WHERE campaign_id = ? AND session_id NOT IN (${sessions})`).run(
    campaignId,
  );
  db.prepare(`UPDATE encounter SET scene_id = NULL WHERE campaign_id = ? AND scene_id NOT IN (${scenes})`).run(
    campaignId,
  );
  db.prepare(`DELETE FROM scene WHERE campaign_id = ? AND id NOT IN (${scenes})`).run(campaignId);
  db.prepare(`DELETE FROM session WHERE campaign_id = ? AND id NOT IN (${sessions})`).run(campaignId);
}

function childRows(db: Db, table: string, encounterIds: number[]): Row[] {
  if (!encounterIds.length) return [];
  return db.prepare(`SELECT * FROM ${table} WHERE encounter_id IN (${encounterIds.join(',')})`).all() as Row[];
}

/** Only the fight that was running then and the one running now are touched; ended fights are history. */
function clearCombat(db: Db, campaignId: number, snapshotEncounters: Row[]): void {
  const active = (
    db.prepare("SELECT id FROM encounter WHERE campaign_id = ? AND status = 'active'").all(campaignId) as Array<{
      id: number;
    }>
  ).map((e) => e.id);
  const ids = [...new Set([...active, ...snapshotEncounters.map((e) => Number(e.id))])];
  if (!ids.length) return;
  const list = ids.join(',');
  for (const table of ['effect', 'combat_log', 'combatant']) {
    db.prepare(`DELETE FROM ${table} WHERE encounter_id IN (${list})`).run();
  }
  db.prepare(`DELETE FROM encounter WHERE id IN (${list})`).run();
}

function insertRows(db: Db, table: string, rows: Row[]): void {
  for (const row of rows) {
    const columns = Object.keys(row);
    const statement = db.prepare(
      `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    );
    statement.run(columns.map((c) => row[c] as never));
  }
}
