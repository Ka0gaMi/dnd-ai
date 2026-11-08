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

/** The separator before a DM's phrase for the number, cut with it so "(total 3, needs 12)" reads "(total 3)". */
const LEAD = String.raw`(?:[,;:]? | [-–—] )?`;
/** The words a DM writes before the number a roll must reach: "needs a", "to beat", "target number". */
const NEEDED = String.raw`(?:need(?:s|ed|ing)?|require[sd]?)(?: to (?:beat|roll|hit|get|meet))?|(?:(?:to|must) )?(?:meets? or )?beat(?:s|ing)?|target number:?`;
const NUMBER = String.raw`(?:at least )?(?:an? |[AD]C )?\d+(?:\+| or (?:better|higher|above))?(?: to (?:succeed|pass|hit|save)| on (?:the|a) (?:die|d20))?`;
/** After the number: the end, a mark that is not inside a number ("1,000"), or a spaced dash; never "=" or a word it counts. */
const CLAUSE_END = String.raw`$|[.,;:!?)\]](?!\d)|\s+[-–—](?:\s|$)`;
/** A number a crit range, a die face or a spell level names, which no DC is. */
const NOT_A_TARGET = String.raw`(?<!\b(?:level|natural|hits? on|crits? on)(?: an?)? )`;

/** A roll purpose's ways of naming the number, the DM's own phrasings first and then the engine's. */
const PURPOSE_TEXT: RegExp[] = [
  new RegExp(String.raw`${LEAD}\b(?:${NEEDED}) ${NUMBER}(?=${CLAUSE_END}|\s+(?:on|to|vs|against|and|but|if|when|then)\b)`, 'gi'),
  new RegExp(String.raw`${LEAD}\b(?:an? )?${NOT_A_TARGET}\d+ or (?:better|higher)(?=${CLAUSE_END})`, 'gi'),
  ...TARGET_TEXT,
];

/** Punctuation a cut can leave: an emptied bracket, a separator against a bracket or the start, a doubled space. */
const TIDY: Array<[RegExp, string]> = [
  [/ ?\(\s*[,;:]?\s*\)/g, ''],
  [/\(\s*[,;:]\s*/g, '('],
  [/\s*[,;:]\s*\)/g, ')'],
  [/^\s*[,;:]\s*/, ''],
  [/ {2,}/g, ' '],
];

/** A roll purpose the DM wrote, with the AC or DC and its "needs 12" phrasings cut out of it. */
export const scrubPurpose = (text: string): string => {
  const cut = PURPOSE_TEXT.reduce((out, pattern) => out.replace(pattern, ''), text);
  return cut === text ? text : TIDY.reduce((out, [pattern, tidy]) => out.replace(pattern, tidy), cut);
};

/** Whether a roll purpose still names the number it must reach, by the phrases scrubPurpose cuts. */
export const namesTarget = (text: string): boolean => PURPOSE_TEXT.some((pattern) => text.search(pattern) !== -1);

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

/** What a line stores for the player in place of its own words, so an unidentified item's +N reads "+?". */
interface PlayerCopy {
  text?: string;
  payload?: Record<string, unknown>;
}

/** The line in the player's words where it carries a player_copy, which goes with it. */
function withPlayerCopy(entry: CombatLogEntry): CombatLogEntry {
  const payload = entry.payload;
  if (!payload || typeof payload !== 'object' || !('player_copy' in payload)) return entry;
  const { player_copy, ...rest } = payload as Record<string, unknown>;
  const copy = player_copy as PlayerCopy;
  return { ...entry, text: copy.text ?? entry.text, payload: { ...rest, ...copy.payload } };
}

/** An attack on someone whose unidentified gear adds AC the player's window leaves out. */
const targetAcUnknown = (payload: unknown): boolean =>
  !!payload && typeof payload === 'object' && (payload as { target_ac_unknown?: unknown }).target_ac_unknown === true;

/**
 * One fight-log entry as the player may read it: in their own words, no dm_note, and no AC or DC while
 * the table hides DCs or the AC carries unidentified gear.
 */
export function playerLogEntry(entry: CombatLogEntry, dcShown: boolean): CombatLogEntry {
  const own = withPlayerCopy(entry);
  const payload = withoutDmNote(own.payload);
  if (dcShown && !targetAcUnknown(payload)) return payload === own.payload ? own : { ...own, payload };
  return { ...own, payload: strip(payload), text: scrub(own.text) };
}

/** Log entries for one audience: the DM's whole, the player's through playerLogEntry. */
export function logFor(db: Db, campaignId: number, entries: CombatLogEntry[], forPlayer = true): CombatLogEntry[] {
  if (!forPlayer) return entries;
  const dcShown = getSettings(db, campaignId).dc_disclosure === 'shown';
  return entries.map((entry) => playerLogEntry(entry, dcShown));
}
