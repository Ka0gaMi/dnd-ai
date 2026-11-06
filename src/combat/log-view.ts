// The fight log as the player's window reads it: the AC or DC a roll was made against follows dc_disclosure.
import { getSettings } from '../core/settings.js';
import type { Db } from '../db/connection.js';
import type { CombatLogEntry } from './state.js';

/** Payload keys, at any depth, that hold the AC or DC a roll was made against. */
const TARGET_KEYS = new Set(['dc', 'save_dc', 'escape_dc', 'next_dc', 'target_ac', 'effective_ac']);

/** The separator before a DM's phrase for the number, cut with it so "(total 3, needs 12)" reads "(total 3)". */
const LEAD = String.raw`(?:[,;:]? | [-–—] )?`;
/** The words a DM writes before the number a roll must reach: "needs a", "to beat", "target". */
const NEEDED = String.raw`(?:need(?:s|ed|ing)?|require[sd]?)(?: to (?:beat|roll|hit|get|meet))?|(?:(?:to|must) )?(?:meets? or )?beat(?:s|ing)?|target(?: number)?:?(?: of)?`;
const NUMBER = String.raw`(?:at least )?(?:an? |[AD]C )?\d+(?:\+| or (?:better|higher|above))?(?: to (?:succeed|pass|hit|save)| on (?:the|a) (?:die|d20))?`;
/** After the number: an end, punctuation or a joining word, never a noun it counts ("needs 2 more successes"). */
const LOOSE_END = String.raw`(?![\w+]|\s+(?!(?:on|to|vs|against|and|but|if|when|then)\b)[a-z])`;

/** The ways the engine's sentences, and a DM's purpose, name such a number, cut in this order so what is left still reads. */
const TARGET_TEXT: RegExp[] = [
  / (?:vs|against) (?:AC|DC) \d+/g,
  / The next one is DC \d+\./g,
  / \(DC \d+\)/g,
  new RegExp(String.raw`${LEAD}\b(?:${NEEDED}) ${NUMBER}${LOOSE_END}`, 'gi'),
  // Bare "12 or better" only at the end of a clause, and never a spell's "level 3 or higher".
  new RegExp(String.raw`${LEAD}\b(?:an? )?(?<!level )\d+ or (?:better|higher)(?![\w+]|\s+[a-z])`, 'gi'),
  /\bDC \d+ ?/g,
];

/** Punctuation a cut can leave: an emptied bracket, a separator against a bracket or the start, a doubled space. */
const TIDY: Array<[RegExp, string]> = [
  [/ ?\(\s*[,;:]?\s*\)/g, ''],
  [/\(\s*[,;:]\s*/g, '('],
  [/\s*[,;:]\s*\)/g, ')'],
  [/^\s*[,;:]\s*/, ''],
  [/ {2,}/g, ' '],
];

/** A sentence with every AC or DC a roll was made against cut out of it. */
export const scrub = (text: string): string => {
  const cut = TARGET_TEXT.reduce((out, pattern) => out.replace(pattern, ''), text);
  return cut === text ? text : TIDY.reduce((out, [pattern, tidy]) => out.replace(pattern, tidy), cut);
};

/** Whether a sentence still names an AC or DC a roll was made against, by the phrases scrub cuts. */
export const namesTarget = (text: string): boolean => TARGET_TEXT.some((pattern) => text.search(pattern) !== -1);

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

/** A payload without its dm_note: the exact call a line's plain words stand for, which only the DM's reply reads. */
function withoutDmNote(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || !('dm_note' in payload)) return payload;
  const { dm_note, ...rest } = payload as Record<string, unknown>;
  void dm_note;
  return rest;
}

/** One fight-log entry as the player may read it: no dm_note, and while the table hides DCs no AC or DC either. */
export function playerLogEntry(entry: CombatLogEntry, dcShown: boolean): CombatLogEntry {
  const payload = withoutDmNote(entry.payload);
  if (dcShown) return payload === entry.payload ? entry : { ...entry, payload };
  return { ...entry, payload: strip(payload), text: scrub(entry.text) };
}

/** Log entries for one audience: the DM's whole, the player's through playerLogEntry. */
export function logFor(db: Db, campaignId: number, entries: CombatLogEntry[], forPlayer = true): CombatLogEntry[] {
  if (!forPlayer) return entries;
  const dcShown = getSettings(db, campaignId).dc_disclosure === 'shown';
  return entries.map((entry) => playerLogEntry(entry, dcShown));
}
