// Reveals the region places a write names in player-visible text, so the player's map and codex keep up with the
// story when the DM forgets region {op: reveal}. Dangers are only flagged: the DM decides when a dungeon is heard of.
import type { Db } from '../db/connection.js';
import type { PlaceKind } from './region.js';
import { revealPlace } from './region-reveal.js';
import { visibleTexts } from './spoiler-guard.js';

/** A name shorter than this is too likely to be part of an ordinary word or phrase. */
const MIN_NAME = 4;

/** Generated names capitalise these too ("Palace Of Sorrows"), but English prose does not. */
const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'the', 'to']);

/** Whether the text holds the whole name with each of its capitalised words capitalised, so "a dark gate" is not Dark Gate. */
function names(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
  const capitals = [...name.matchAll(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{N}]*/gu)]
    .filter((word) => !SMALL_WORDS.has(word[0].toLowerCase()))
    .map((word) => word.index);
  return [...text.matchAll(pattern)].some((match) => capitals.every((at) => /^\p{Lu}/u.test(match[0].slice(at))));
}

/** Reveals the unknown settlements and areas a successful write names where the player reads it; returns the DM-only reply lines, or null. */
export function autoReveal(db: Db, tool: string, args: unknown): string | null {
  const input = (args ?? {}) as Record<string, unknown>;
  const campaignId = input.campaign_id;
  if (typeof campaignId !== 'number') return null;
  try {
    const texts = visibleTexts(db, tool, input);
    // The party's location shows in the player's window too, whichever checkpoint op sets it.
    if (tool === 'checkpoint' && typeof input.scene_location === 'string') texts.push(input.scene_location);
    if (texts.length === 0) return null;
    const text = texts.join('\n');
    const named = (
      db
        .prepare('SELECT id, kind, name FROM world_place WHERE campaign_id = ? AND known_to_party = 0 ORDER BY id')
        .all(campaignId) as Array<{ id: number; kind: PlaceKind; name: string }>
    ).filter((place) => place.name.length >= MIN_NAME && names(text, place.name));
    if (named.length === 0) return null;
    const revealed = db.transaction(() =>
      named.filter((place) => place.kind !== 'danger').map((place) => revealPlace(db, campaignId, place.id)),
    )();
    const dangers = named.filter((place) => place.kind === 'danger');
    const shown = revealed.map((result) => result.place.name).join(', ');
    return [
      ...(revealed.length > 0 ? [`Revealed on the player's map (named in visible text): ${shown}.`] : []),
      ...revealed.flatMap((result) => (result.warning === undefined ? [] : [result.warning])),
      ...dangers.map(
        (place) =>
          `Danger ${place.name} is named in player-visible text: region {op: reveal, place: "${place.name}"} if the party has heard of it, or reword it.`,
      ),
    ].join('\n');
  } catch {
    // A failure only drops the reveal; the call itself already succeeded.
    return null;
  }
}
