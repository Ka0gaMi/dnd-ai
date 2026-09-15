import type { Db } from '../db/connection.js';
import { getCharacterSheet, logEvent, type CharacterSummary } from './campaign.js';

/** Derived numbers the player may hand-set; they are layered over the computed value on read. */
export const OVERRIDE_FIELDS = ['ac', 'initiative_bonus', 'proficiency_bonus', 'passive_perception'] as const;
/** Stored numbers the player may edit outright - no override layer, the column is written. */
export const DIRECT_FIELDS = ['speed', 'gold', 'exhaustion'] as const;

export type OverrideField = (typeof OVERRIDE_FIELDS)[number];
export type DirectField = (typeof DIRECT_FIELDS)[number];
export type OverridePatch = Partial<Record<OverrideField | DirectField, number | null>>;

export type Overrides = Partial<Record<OverrideField, number>>;

const isOverrideField = (key: string): key is OverrideField => (OVERRIDE_FIELDS as readonly string[]).includes(key);
const isDirectField = (key: string): key is DirectField => (DIRECT_FIELDS as readonly string[]).includes(key);

/** The hand-set values stored on a character row, ignoring anything unknown or malformed. */
export function parseOverrides(json: string | null): Overrides {
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Overrides = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isOverrideField(key) && typeof value === 'number') out[key] = value;
  }
  return out;
}

export function getOverrides(db: Db, characterId: number): Overrides {
  const row = db.prepare('SELECT overrides_json FROM character WHERE id = ?').get(characterId) as
    | { overrides_json: string | null }
    | undefined;
  return parseOverrides(row?.overrides_json ?? null);
}

/**
 * Cheat-mode sheet edits. Derived numbers become overrides on the character row, speed, gold and
 * exhaustion are written to their column, and every single change is logged with its old and new value.
 */
export function setOverrides(
  db: Db,
  characterId: number,
  patch: OverridePatch,
): { character_id: number; overrides: Overrides; character: CharacterSummary | null } {
  const row = db
    .prepare('SELECT id, campaign_id, name, speed, gold, exhaustion FROM character WHERE id = ?')
    .get(characterId) as
    | { id: number; campaign_id: number; name: string; speed: number | null; gold: number; exhaustion: number }
    | undefined;
  if (!row) throw new Error(`No character with id ${characterId}.`);

  const before = getCharacterSheet(db, row.campaign_id, characterId);
  const overrides = getOverrides(db, characterId);

  db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== null && typeof value !== 'number') throw new Error(`Field "${key}" must be a number or null.`);
      if (isDirectField(key)) {
        if (value === null) throw new Error(`"${key}": speed, gold and exhaustion are stored values; set a number.`);
        if (key === 'exhaustion' && (value < 0 || value > 6)) {
          throw new Error('"exhaustion" must be an integer from 0 to 6.');
        }
        const old = key === 'speed' ? row.speed : key === 'gold' ? row.gold : row.exhaustion;
        db.prepare(`UPDATE character SET ${key} = ? WHERE id = ?`).run(value, characterId);
        logChange(db, row, key, old, value);
      } else if (isOverrideField(key)) {
        const old = before ? (before[key] as number) : null;
        if (value === null) delete overrides[key];
        else overrides[key] = value;
        logChange(db, row, key, old, value);
      } else {
        throw new Error(`"${key}" cannot be hand-set.`);
      }
    }
    db.prepare('UPDATE character SET overrides_json = ? WHERE id = ?').run(
      Object.keys(overrides).length ? JSON.stringify(overrides) : null,
      characterId,
    );
  })();

  return {
    character_id: characterId,
    overrides,
    character: getCharacterSheet(db, row.campaign_id, characterId),
  };
}

function logChange(
  db: Db,
  character: { id: number; campaign_id: number; name: string },
  field: string,
  old: number | null,
  value: number | null,
): void {
  logEvent(db, {
    campaign_id: character.campaign_id,
    kind: 'override',
    text:
      value === null
        ? `${character.name}: ${field} hand-set value cleared (was ${old ?? '-'}).`
        : `${character.name}: ${field} hand-set to ${value} (was ${old ?? '-'}).`,
    payload: { character_id: character.id, field, old, new: value },
  });
}

/** The hand-set marker is for the player's window only: no tool reply may carry it. */
export function stripHandSet<T>(data: T): T {
  if (Array.isArray(data)) return data.map((item) => stripHandSet(item)) as unknown as T;
  if (data && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (key !== 'hand_set') out[key] = stripHandSet(value);
    }
    return out as T;
  }
  return data;
}
