// Reveals the settlement or area the party arrives at, and reminds the DM of unknown places a write names where the
// player reads it. Prose never reveals: the DM decides when a place is heard of, and dangers are only ever flagged.
import type { Db } from '../db/connection.js';
import type { PlaceKind } from './region.js';
import { revealPlace, type RevealResult } from './region-reveal.js';
import { visibleTexts } from './spoiler-guard.js';

/** A name shorter than this is too likely to be part of an ordinary word or phrase. */
const MIN_NAME = 4;

/** Generated names capitalise these too ("Palace Of Sorrows"), but English prose does not. */
const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'the', 'to']);

/** The arrival each campaign's last move revealed, per database, until the MCP wrapper reports it. */
const arrivals = new WeakMap<Db, Map<number, RevealResult>>();

/** Whether the campaign has its player character yet; nothing reveals or nudges before it does. */
function hasHero(db: Db, campaignId: number): boolean {
  return db.prepare('SELECT 1 FROM character WHERE campaign_id = ? AND is_pc = 1').get(campaignId) !== undefined;
}

/** A capitalised word joined to the match by whitespace alone makes it part of a longer name; a "the" before it is looked through. */
function flanked(text: string, start: number, end: number): boolean {
  const before = text.slice(0, start).replace(/(?<![\p{L}\p{N}])[Tt]he\s+$/u, '');
  return /(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}]*\s+$/u.test(before) || /^\s+\p{Lu}/u.test(text.slice(end));
}

/** Whether the text holds the whole name with each of its capitalised words capitalised, so "a dark gate" is not Dark Gate. */
function names(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
  const capitals = [...name.matchAll(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}]*/gu)]
    .filter((word) => !SMALL_WORDS.has(word[0].toLowerCase()))
    .map((word) => word.index);
  return [...text.matchAll(pattern)].some(
    (match) =>
      capitals.every((at) => /^\p{Lu}/u.test(match[0].slice(at))) &&
      !flanked(text, match.index, match.index + match[0].length),
  );
}

/** A place name as an arrival compares it: trimmed, any case, a leading "the" ignored. */
const arrivalKey = (name: string): string => name.trim().toLowerCase().replace(/^the\s+/, '');

/** Reveals the unknown settlement or area whose name the party's new location is exactly; a danger never. */
export function revealOnArrival(db: Db, campaignId: number, to: string): void {
  if (!hasHero(db, campaignId)) return;
  const key = arrivalKey(to);
  const place = (
    db
      .prepare("SELECT id, name, known_to_party FROM world_place WHERE campaign_id = ? AND kind != 'danger' ORDER BY kind = 'area', id")
      .all(campaignId) as Array<{ id: number; name: string; known_to_party: number }>
  ).find((row) => arrivalKey(row.name) === key);
  if (!place || place.known_to_party === 1) return;
  const pending = arrivals.get(db) ?? new Map<number, RevealResult>();
  arrivals.set(db, pending);
  pending.set(campaignId, revealPlace(db, campaignId, place.id));
}

/** The DM-only lines for the arrival a call revealed, or null, forgetting it either way. */
export function takeArrival(db: Db, campaignId: number): string | null {
  const result = arrivals.get(db)?.get(campaignId);
  if (!result) return null;
  arrivals.get(db)!.delete(campaignId);
  const line = `Revealed on the player's map (the party arrived): ${result.place.name}.`;
  return result.warning ? `${line}\n${result.warning}` : line;
}

/** The DM-only reminders for unknown places a successful write names where the player reads it, or null; it reveals nothing. */
export function placeNudges(db: Db, tool: string, args: unknown): string | null {
  const input = (args ?? {}) as Record<string, unknown>;
  const campaignId = input.campaign_id;
  if (typeof campaignId !== 'number') return null;
  try {
    const texts = visibleTexts(db, tool, input);
    // The party's location shows in the player's window too; a place it names exactly was revealed on arrival.
    if (tool === 'checkpoint' && typeof input.scene_location === 'string') texts.push(input.scene_location);
    if (texts.length === 0 || !hasHero(db, campaignId)) return null;
    const named = (
      db
        .prepare('SELECT kind, name FROM world_place WHERE campaign_id = ? AND known_to_party = 0 ORDER BY id')
        .all(campaignId) as Array<{ kind: PlaceKind; name: string }>
    ).filter((place) => place.name.length >= MIN_NAME && texts.some((text) => names(text, place.name)));
    const places = named.filter((place) => place.kind !== 'danger').map((place) => place.name);
    const dangers = named.filter((place) => place.kind === 'danger');
    const lines = [
      ...(places.length > 0
        ? [
            `Named in visible text but not on the player's map: ${places.join(', ')} — region {op: reveal, place: "${
              places.length === 1 ? places[0] : '<name>'
            }"} once the party has heard of it.`,
          ]
        : []),
      ...dangers.map(
        (place) =>
          `Danger ${place.name} is named in player-visible text: region {op: reveal, place: "${place.name}"} if the party has heard of it, or reword it.`,
      ),
    ];
    return lines.length > 0 ? lines.join('\n') : null;
  } catch {
    // A failure only drops the reminder; the call itself already succeeded.
    return null;
  }
}
