// The fight log as the player's window reads it: the AC or DC a roll was made against follows dc_disclosure.
import { getSettings } from '../core/settings.js';
import type { Db } from '../db/connection.js';
import type { CombatLogEntry } from './state.js';

/** Payload keys, at any depth, that hold the AC or DC a roll was made against. */
const TARGET_KEYS = new Set(['dc', 'save_dc', 'escape_dc', 'next_dc', 'target_ac', 'effective_ac']);

/** The ways the engine's sentences name such a number, cut in this order so what is left still reads. */
const TARGET_TEXT: RegExp[] = [
  / (?:vs|against) (?:AC|DC) \d+/g,
  / The next one is DC \d+\./g,
  / \(DC \d+\)/g,
  /\bDC \d+ ?/g,
];

/** A sentence with every AC or DC a roll was made against cut out of it. */
export const scrub = (text: string): string => TARGET_TEXT.reduce((out, pattern) => out.replace(pattern, ''), text);

function strip(value: unknown): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !TARGET_KEYS.has(key))
        .map(([key, inner]) => [key, strip(inner)]),
    );
  }
  return value;
}

/** One fight-log entry as the player may read it: while the table hides DCs, no AC or DC in its payload or text. */
export function playerLogEntry(entry: CombatLogEntry, dcShown: boolean): CombatLogEntry {
  if (dcShown) return entry;
  return { ...entry, payload: strip(entry.payload), text: scrub(entry.text) };
}

/** Log entries for one audience: the DM's whole, the player's through playerLogEntry. */
export function logFor(db: Db, campaignId: number, entries: CombatLogEntry[], forPlayer = true): CombatLogEntry[] {
  if (!forPlayer) return entries;
  const dcShown = getSettings(db, campaignId).dc_disclosure === 'shown';
  return entries.map((entry) => playerLogEntry(entry, dcShown));
}
