// Storage for faiths in the living world: the faiths themselves, a temple faction's influence in
// one, the church-versus-crown contest clock and a realm's excommunication.
import type { Db } from '../db/connection.js';

export type FaithInfluence = 'minor' | 'strong' | 'dominant';

export interface WorldFaith {
  id: number;
  name: string;
  aspect: string;
  symbol: string;
  head_place_id: number | null;
  fervor: number;
  heresy_of: number | null;
  last_heresy_day: number | null;
  created_day: number;
}

export interface FactionFaith {
  faith_id: number | null;
  influence: FaithInfluence | null;
}

export interface ContestClock {
  filled: number;
  size: number;
}

interface FaithRow {
  id: number;
  name: string;
  aspect: string;
  symbol: string;
  head_place_id: number | null;
  fervor: number;
  heresy_of: number | null;
  last_heresy_day: number | null;
  created_day: number;
}

const FAITH_COLUMNS =
  'id, name, aspect, symbol, head_place_id, fervor, heresy_of, last_heresy_day, created_day';

function faithFromRow(row: FaithRow): WorldFaith {
  return {
    id: row.id,
    name: row.name,
    aspect: row.aspect,
    symbol: row.symbol,
    head_place_id: row.head_place_id,
    fervor: row.fervor,
    heresy_of: row.heresy_of,
    last_heresy_day: row.last_heresy_day,
    created_day: row.created_day,
  };
}

function getFaithById(db: Db, campaignId: number, id: number): WorldFaith | undefined {
  const row = db
    .prepare(`SELECT ${FAITH_COLUMNS} FROM world_faith WHERE campaign_id = ? AND id = ?`)
    .get(campaignId, id) as FaithRow | undefined;
  return row ? faithFromRow(row) : undefined;
}

function clampFervor(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function insertFaith(db: Db, campaignId: number, f: Omit<WorldFaith, 'id'>): WorldFaith {
  const info = db
    .prepare(
      `INSERT INTO world_faith
         (campaign_id, name, aspect, symbol, head_place_id, fervor, heresy_of, last_heresy_day, created_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      campaignId,
      f.name,
      f.aspect,
      f.symbol,
      f.head_place_id,
      f.fervor,
      f.heresy_of,
      f.last_heresy_day,
      f.created_day,
    );
  return getFaithById(db, campaignId, Number(info.lastInsertRowid))!;
}

export function listFaiths(db: Db, campaignId: number): WorldFaith[] {
  const rows = db
    .prepare(`SELECT ${FAITH_COLUMNS} FROM world_faith WHERE campaign_id = ? ORDER BY id`)
    .all(campaignId) as FaithRow[];
  return rows.map(faithFromRow);
}

export function getFaith(db: Db, campaignId: number, id: number): WorldFaith | undefined {
  return getFaithById(db, campaignId, id);
}

export function updateFaith(
  db: Db,
  campaignId: number,
  id: number,
  patch: Partial<Pick<WorldFaith, 'fervor' | 'head_place_id' | 'last_heresy_day'>>,
): WorldFaith {
  if (!getFaithById(db, campaignId, id)) throw new Error(`No faith ${id} in this campaign.`);

  const sets: string[] = [];
  const values: Array<number | null> = [];
  if (patch.fervor !== undefined) {
    sets.push('fervor = ?');
    values.push(clampFervor(patch.fervor));
  }
  if (patch.head_place_id !== undefined) {
    sets.push('head_place_id = ?');
    values.push(patch.head_place_id);
  }
  if (patch.last_heresy_day !== undefined) {
    sets.push('last_heresy_day = ?');
    values.push(patch.last_heresy_day);
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE world_faith SET ${sets.join(', ')} WHERE id = ? AND campaign_id = ?`).run(
      ...values,
      id,
      campaignId,
    );
  }
  return getFaithById(db, campaignId, id)!;
}

export function setFactionFaith(
  db: Db,
  campaignId: number,
  factionId: number,
  faithId: number | null,
  influence: FaithInfluence | null,
): void {
  db.prepare('UPDATE world_faction SET faith_id = ?, influence = ? WHERE id = ? AND campaign_id = ?').run(
    faithId,
    influence,
    factionId,
    campaignId,
  );
}

export function factionFaith(db: Db, campaignId: number, factionId: number): FactionFaith {
  const row = db
    .prepare('SELECT faith_id, influence FROM world_faction WHERE campaign_id = ? AND id = ?')
    .get(campaignId, factionId) as { faith_id: number | null; influence: FaithInfluence | null } | undefined;
  return row ? { faith_id: row.faith_id, influence: row.influence } : { faith_id: null, influence: null };
}

export function getContest(db: Db, campaignId: number, realmId: number, faithId: number): ContestClock {
  const row = db
    .prepare('SELECT filled, size FROM world_contest WHERE campaign_id = ? AND realm_id = ? AND faith_id = ?')
    .get(campaignId, realmId, faithId) as ContestClock | undefined;
  return row ? { filled: row.filled, size: row.size } : { filled: 0, size: 6 };
}

export function addContest(
  db: Db,
  campaignId: number,
  realmId: number,
  faithId: number,
  amount: number,
): number {
  const current = getContest(db, campaignId, realmId, faithId);
  const filled = Math.max(0, Math.min(current.size, current.filled + amount));
  db.prepare(
    `INSERT INTO world_contest (campaign_id, realm_id, faith_id, filled, size) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(campaign_id, realm_id, faith_id) DO UPDATE SET filled = excluded.filled`,
  ).run(campaignId, realmId, faithId, filled, current.size);
  return filled;
}

export function resetContest(db: Db, campaignId: number, realmId: number, faithId: number): void {
  db.prepare('UPDATE world_contest SET filled = 0 WHERE campaign_id = ? AND realm_id = ? AND faith_id = ?').run(
    campaignId,
    realmId,
    faithId,
  );
}

export function setExcommunicated(
  db: Db,
  campaignId: number,
  realmId: number,
  untilDay: number | null,
): void {
  db.prepare('UPDATE world_realm SET excommunicated_until = ? WHERE id = ? AND campaign_id = ?').run(
    untilDay,
    realmId,
    campaignId,
  );
}

export function excommunicatedUntil(db: Db, campaignId: number, realmId: number): number | null {
  const row = db
    .prepare('SELECT excommunicated_until FROM world_realm WHERE campaign_id = ? AND id = ?')
    .get(campaignId, realmId) as { excommunicated_until: number | null } | undefined;
  return row ? row.excommunicated_until : null;
}
