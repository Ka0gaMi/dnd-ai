import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Db } from '../db/connection.js';
import { canonicalJson } from './tools/campaign.js';

const WINDOW_MS = 10_000;

/** Tools whose identical repeat is legitimate: combat turns and table moves, dice, and calls that are idempotent or must reply fresh. */
export const NEVER_DEDUPED = new Set([
  'attack', 'advance_turn', 'move_token', 'use_action', 'effect', 'condition', 'hp', 'undo_last_combat_action', 'find_position',
  'start_encounter', 'add_combatant', 'end_encounter', 'roll', 'roll_table', 'spells', 'load_campaign', 'region',
  'time', 'rumour',
]);

type Entry = { at: number; reply: Promise<CallToolResult>; changes?: number };
/** Per database, so it outlives the per-request servers HTTP builds. */
const recent = new WeakMap<Db, Map<string, Entry>>();

/** Rows this connection has written so far, so a repeat can tell whether anything else changed state since. */
const totalChanges = (db: Db): number => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

/** Returns the first reply to an identical state-changing call made within 10 s while nothing else has written to the database, plus a line saying so; errors are never kept. */
export async function dedupe(
  db: Db,
  name: string,
  args: unknown,
  run: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  const now = Date.now();
  const entries = recent.get(db) ?? new Map<string, Entry>();
  recent.set(db, entries);
  for (const [k, e] of entries) if (now - e.at > WINDOW_MS) entries.delete(k);

  const key = `${name}\n${canonicalJson(args)}`;
  const first = entries.get(key);
  if (first) {
    const reply = await first.reply;
    if (!reply.isError && first.changes === totalChanges(db)) {
      const last = reply.content?.at(-1);
      if (last?.type !== 'text') return reply;
      const seconds = Math.round((Date.now() - first.at) / 1000);
      const line = `Duplicate of the same call ${seconds} s ago - nothing was done twice.`;
      return { ...reply, content: [...reply.content.slice(0, -1), { ...last, text: `${last.text}\n\n${line}` }] };
    }
    if (entries.get(key) === first) entries.delete(key);
  }

  const entry: Entry = { at: now, reply: Promise.resolve(run()) };
  entries.set(key, entry);
  try {
    const reply = await entry.reply;
    entry.changes = totalChanges(db);
    if (reply.isError && entries.get(key) === entry) entries.delete(key);
    return reply;
  } catch (err) {
    if (entries.get(key) === entry) entries.delete(key);
    throw err;
  }
}
