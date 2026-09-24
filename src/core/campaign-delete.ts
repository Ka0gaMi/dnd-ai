// Permanent removal of a campaign: every row scoped to it, the child rows that carry no campaign_id,
// and its portrait directory. Portraits for library creatures (campaign_id NULL) are left alone.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/connection.js';
import { portraitsDir } from './portraits.js';

/** Child tables without a campaign_id, reached through the campaign-scoped parent that owns them. */
const CHILD_DELETES: readonly string[] = [
  'DELETE FROM quest_step WHERE quest_id IN (SELECT id FROM quest WHERE campaign_id = ?)',
  'DELETE FROM effect WHERE encounter_id IN (SELECT id FROM encounter WHERE campaign_id = ?)',
  'DELETE FROM combat_log WHERE encounter_id IN (SELECT id FROM encounter WHERE campaign_id = ?)',
  'DELETE FROM combat_undo WHERE encounter_id IN (SELECT id FROM encounter WHERE campaign_id = ?)',
  'DELETE FROM combatant WHERE encounter_id IN (SELECT id FROM encounter WHERE campaign_id = ?)',
  'DELETE FROM world_packet_arrival WHERE packet_id IN (SELECT id FROM world_packet WHERE campaign_id = ?)',
];

/** Every table that scopes rows by campaign_id, found in the schema so a later table is covered too. */
function campaignScopedTables(db: Db): string[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return tables
    .filter(({ name }) =>
      db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(name, 'campaign_id'),
    )
    .map(({ name }) => name);
}

/** Deletes the campaign in one transaction, then its portrait folder; unknown ids throw and change nothing. */
export function deleteCampaign(db: Db, campaignId: number): { deleted_rows: number } {
  const result = db.transaction(() => {
    const campaign = db.prepare('SELECT id FROM campaign WHERE id = ?').get(campaignId);
    if (!campaign) throw new Error(`No campaign with id ${campaignId}.`);
    // Deferred FKs let a parent go before the children that still point at it; the check below is the net.
    db.pragma('defer_foreign_keys = ON');
    let deleted = 0;
    for (const sql of CHILD_DELETES) deleted += db.prepare(sql).run(campaignId).changes;
    for (const table of campaignScopedTables(db)) {
      deleted += db.prepare(`DELETE FROM "${table}" WHERE campaign_id = ?`).run(campaignId).changes;
    }
    deleted += db.prepare('DELETE FROM campaign WHERE id = ?').run(campaignId).changes;
    const dangling = db.pragma('foreign_key_check') as unknown[];
    if (dangling.length > 0) throw new Error(`Delete left ${dangling.length} dangling foreign key reference(s).`);
    return { deleted_rows: deleted };
  })();
  // The transaction committed, so the files that belong to the campaign can go too.
  rmSync(join(portraitsDir(), String(campaignId)), { recursive: true, force: true });
  return result;
}
