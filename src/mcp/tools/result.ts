import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Db } from '../../db/connection.js';
import { eventsSinceCheckpoint } from '../../core/campaign.js';
import { stripHandSet } from '../../core/overrides.js';
import { dmVisibleSettings } from '../../core/settings.js';
import { activeEncounter } from '../../combat/state.js';

const NAG_AFTER_EVENTS = 25;

/** Every combat call writes an event, so the nag waits until the fight is over rather than interrupting it. */
const inCombat = (db: Db, campaignId: number): boolean => activeEncounter(db, campaignId) !== null;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The battle state carries the player's own fog of war on the encounter; the DM never sees it. */
const withoutVisibility = (encounter: Record<string, unknown>): Record<string, unknown> => {
  const { visibility, ...rest } = encounter;
  void visibility;
  return stripPlayerSettings(rest);
};

/** The player's dials belong to their window alone, wherever a settings object turns up in a reply. */
function stripPlayerSettings<T>(data: T): T {
  if (Array.isArray(data)) return data.map((item) => stripPlayerSettings(item)) as unknown as T;
  if (data && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      out[key] =
        key === 'settings' && isObject(value)
          ? dmVisibleSettings(value)
          : key === 'encounter' && isObject(value)
            ? withoutVisibility(value)
            : stripPlayerSettings(value);
    }
    return out as T;
  }
  return data;
}

/**
 * Every tool answers with compact JSON text plus structuredContent, and nags about stale checkpoints.
 * The hand-set marker and the player's own settings are stripped on the way out.
 */
export function reply(
  db: Db,
  campaignId: number | null,
  data: Record<string, unknown>,
  text?: string,
): CallToolResult {
  const shown = stripPlayerSettings(stripHandSet(data));
  let body = text ?? JSON.stringify(shown);
  if (campaignId !== null && !inCombat(db, campaignId) && eventsSinceCheckpoint(db, campaignId) > NAG_AFTER_EVENTS) {
    body += '\n\nReminder: call save_checkpoint.';
  }
  return { content: [{ type: 'text', text: body }], structuredContent: shown };
}
