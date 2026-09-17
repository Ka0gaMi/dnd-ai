// Pre-call snapshots of the rows a combat tool may change, so the last call can be taken back.
import type { Db } from '../db/connection.js';
import type { EncounterRow } from './state.js';

type Row = Record<string, unknown>;

export interface CombatSnapshot {
  round: number;
  turn_index: number;
  combatants: Row[];
  effects: Row[];
  /** Sheet columns of the PCs and companions in the fight; absent in snapshots taken before they were kept. */
  characters?: Row[];
  /** Every character row the campaign held before the call, so a familiar conjured during it can be removed. */
  campaign_characters?: number[];
  /** The first fight-log id the call could write; absent in snapshots taken before it was kept. */
  log_from?: number;
}

/** The sheet columns a combat call can change, so undoing one puts the character's own row back too. */
const RESTORED_CHARACTER_COLUMNS = [
  'hp_current',
  'temp_hp',
  'conditions_json',
  'death_saves_json',
  'status',
  'inspiration',
  'spell_slots_json',
  // Class-resource counters live here: a refused call must not leave a Metamagic or Channel Divinity spend behind.
  'features_json',
  'stable',
] as const;
/** Name and maximum hit points ride along so the undo can say what it put back. */
const CHARACTER_COLUMNS = ['id', 'name', 'hp_max', ...RESTORED_CHARACTER_COLUMNS].join(', ');

export interface RestoredCharacter {
  id: number;
  name: string;
  hp_current: number;
  hp_max: number;
  status: string;
}

export interface UndoEntry {
  id: number;
  tool: string;
  snapshot: CombatSnapshot;
}

/** How many snapshots an encounter keeps; older ones fall off. */
const KEEP = 10;

/** Called by every mutating engine tool before it touches anything. */
export function snapshotCombat(db: Db, encounter: EncounterRow, tool: string): UndoEntry {
  const turn = db.prepare('SELECT round, turn_index FROM encounter WHERE id = ?').get(encounter.id) as {
    round: number;
    turn_index: number;
  };
  const logFrom = (
    db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM combat_log WHERE encounter_id = ?').get(encounter.id) as {
      id: number;
    }
  ).id;
  const snapshot: CombatSnapshot = {
    round: turn.round,
    turn_index: turn.turn_index,
    combatants: db.prepare('SELECT * FROM combatant WHERE encounter_id = ?').all(encounter.id) as Row[],
    effects: db.prepare('SELECT * FROM effect WHERE encounter_id = ?').all(encounter.id) as Row[],
    characters: db
      .prepare(
        `SELECT ${CHARACTER_COLUMNS} FROM character WHERE id IN (
           SELECT character_id FROM combatant
            WHERE encounter_id = ? AND character_id IS NOT NULL AND kind IN ('pc', 'companion'))`,
      )
      .all(encounter.id) as Row[],
    campaign_characters: (
      db.prepare('SELECT id FROM character WHERE campaign_id = ?').all(encounter.campaign_id) as Array<{ id: number }>
    ).map((row) => row.id),
    log_from: logFrom,
  };
  const id = Number(
    db
      .prepare('INSERT INTO combat_undo (encounter_id, tool, snapshot_json, ts) VALUES (?, ?, ?, ?)')
      .run(encounter.id, tool, JSON.stringify(snapshot), new Date().toISOString()).lastInsertRowid,
  );
  return { id, tool, snapshot };
}

/** Drops the snapshots past KEEP. Only a call that went through trims, so a refused one costs no depth. */
function trimSnapshots(db: Db, encounterId: number): void {
  db.prepare(
    'DELETE FROM combat_undo WHERE encounter_id = ? AND id NOT IN (SELECT id FROM combat_undo WHERE encounter_id = ? ORDER BY id DESC LIMIT ?)',
  ).run(encounterId, encounterId, KEEP);
}

/** The encounter's newest fight-log row before a call, so a refused one can take its own lines back. */
function lastLogId(db: Db, encounterId: number): number {
  const row = db.prepare('SELECT MAX(id) AS id FROM combat_log WHERE encounter_id = ?').get(encounterId) as {
    id: number | null;
  };
  return row.id ?? 0;
}

/**
 * Runs one mutating combat call under its own snapshot: a call that throws - a refused move, a spell
 * out of range, an action the economy will not have - puts the fight back, takes back the log lines it
 * had already written and leaves no undo row, so the next undo takes back the last call that actually
 * happened, whether the body is sync or async.
 */
export function underSnapshot<T>(db: Db, encounter: EncounterRow, tool: string, body: () => T): T {
  const entry = snapshotCombat(db, encounter, tool);
  const logFrom = lastLogId(db, encounter.id);
  const rollBack = (err: unknown): never => {
    restoreSnapshot(db, encounter.id, entry.snapshot);
    dropSnapshot(db, entry.id);
    // A body that logged before it threw left lines describing an action the caller is told never happened.
    db.prepare('DELETE FROM combat_log WHERE encounter_id = ? AND id > ?').run(encounter.id, logFrom);
    throw err;
  };
  const kept = <V>(done: V): V => {
    trimSnapshots(db, encounter.id);
    return done;
  };
  try {
    const done = body();
    return done instanceof Promise ? (done.then(kept, rollBack) as T) : kept(done);
  } catch (err) {
    return rollBack(err);
  }
}

export function lastSnapshot(db: Db, encounterId: number): UndoEntry | null {
  const row = db
    .prepare('SELECT id, tool, snapshot_json FROM combat_undo WHERE encounter_id = ? ORDER BY id DESC LIMIT 1')
    .get(encounterId) as { id: number; tool: string; snapshot_json: string } | undefined;
  if (!row) return null;
  return { id: row.id, tool: row.tool, snapshot: JSON.parse(row.snapshot_json) as CombatSnapshot };
}

function writeRow(db: Db, table: 'combatant' | 'effect', row: Row): void {
  const columns = Object.keys(row);
  const exists = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(row.id as number);
  if (exists) {
    const rest = columns.filter((c) => c !== 'id');
    db.prepare(`UPDATE ${table} SET ${rest.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
      ...rest.map((c) => row[c]),
      row.id,
    );
    return;
  }
  db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...columns.map((c) => row[c]));
}

/** Rewrites one character's sheet columns, and says so only when the call had actually changed them. */
function restoreCharacter(db: Db, row: Row): RestoredCharacter[] {
  const current = db
    .prepare(`SELECT ${CHARACTER_COLUMNS} FROM character WHERE id = ?`)
    .get(row.id as number) as Row | undefined;
  if (!current) return [];
  if (RESTORED_CHARACTER_COLUMNS.every((c) => (current[c] ?? null) === (row[c] ?? null))) return [];
  db.prepare(
    `UPDATE character SET ${RESTORED_CHARACTER_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
  ).run(...RESTORED_CHARACTER_COLUMNS.map((c) => row[c] ?? null), row.id);
  return [
    {
      id: row.id as number,
      name: row.name as string,
      hp_current: row.hp_current as number,
      hp_max: row.hp_max as number,
      status: row.status as string,
    },
  ];
}

/**
 * The companions conjured during the call being taken back: a combatant row that was not there at the
 * snapshot, whose character row was not there either. Undoing a Find Familiar takes the familiar's sheet
 * with its token, rather than leaving an orphan in the party.
 */
function conjuredCompanions(db: Db, encounterId: number, snapshot: CombatSnapshot): number[] {
  const before = snapshot.campaign_characters;
  if (!before) return [];
  const keep = new Set(snapshot.combatants.map((c) => Number(c.id)));
  const rows = db
    .prepare("SELECT id, character_id FROM combatant WHERE encounter_id = ? AND kind = 'companion' AND character_id IS NOT NULL")
    .all(encounterId) as Array<{ id: number; character_id: number }>;
  return rows.filter((row) => !keep.has(row.id) && !before.includes(row.character_id)).map((row) => row.character_id);
}

/**
 * Puts the combatants, effects, character sheets and turn back as they were, and answers with the
 * characters whose own row it rewrote. Rows created since the snapshot go, and the fight log keeps its
 * entries: an undone reinforcement only loses its name off the rows that named it.
 */
export function restoreSnapshot(db: Db, encounterId: number, snapshot: CombatSnapshot): RestoredCharacter[] {
  return db.transaction(() => {
    const conjured = conjuredCompanions(db, encounterId, snapshot);
    const keep = snapshot.combatants.map((c) => Number(c.id));
    const list = keep.length > 0 ? `(${keep.join(', ')})` : '(-1)';
    db.prepare(`DELETE FROM effect WHERE encounter_id = ?`).run(encounterId);
    db.prepare(`UPDATE combat_log SET actor_id = NULL WHERE encounter_id = ? AND actor_id NOT IN ${list}`).run(
      encounterId,
    );
    db.prepare(`UPDATE combat_log SET target_id = NULL WHERE encounter_id = ? AND target_id NOT IN ${list}`).run(
      encounterId,
    );
    db.prepare(`DELETE FROM combatant WHERE encounter_id = ? AND id NOT IN ${list}`).run(encounterId);
    for (const row of snapshot.combatants) writeRow(db, 'combatant', row);
    for (const row of snapshot.effects) writeRow(db, 'effect', row);
    db.prepare('UPDATE encounter SET round = ?, turn_index = ? WHERE id = ?').run(
      snapshot.round,
      snapshot.turn_index,
      encounterId,
    );
    for (const id of conjured) {
      // A codex entry or a play note may already point at the familiar; the row goes, the reference does not.
      db.prepare('UPDATE entity SET character_id = NULL WHERE character_id = ?').run(id);
      db.prepare('UPDATE play_note SET character_id = NULL WHERE character_id = ?').run(id);
      db.prepare('DELETE FROM character WHERE id = ?').run(id);
    }
    return (snapshot.characters ?? []).flatMap((row) => restoreCharacter(db, row));
  })();
}

export function dropSnapshot(db: Db, id: number): void {
  db.prepare('DELETE FROM combat_undo WHERE id = ?').run(id);
}
