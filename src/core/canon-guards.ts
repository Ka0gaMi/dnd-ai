// Canon checked where it is written: a fact that contradicts an active one, and a new tie for a dead NPC or a
// destroyed faction, are refused with the canon they would break quoted.
import type { Db } from '../db/connection.js';
import { snippet } from './campaign.js';
import type { EntityKind, EntityRow, RelationshipType } from './codex.js';

export type LifeClaim = 'dead' | 'alive';

const LIFE_WORDS = /\b(died|dies|perished|deceased|dead|slain|killed|murdered|destroyed|alive|survives?|survived|still lives|still living)\b/gi;
const DEATH = new Set(['died', 'dies', 'perished', 'deceased', 'dead', 'slain', 'killed', 'murdered', 'destroyed']);
/** Words that only say the subject died after a be-verb, so "Mira killed Grask" is no death of Mira's. */
const AFTER_BE = new Set(['deceased', 'dead', 'slain', 'killed', 'murdered', 'destroyed']);
const BE = /^(?:is|was|are|were|be|been|being|lies|lay|lying|found|left|isn't|wasn't|aren't|weren't)$/;
const BE_ADVERB = /^(?:now|long|already|not|never)$/;
const NEGATION = /^(?:not|never|isn't|wasn't|aren't|weren't|didn't|doesn't|hasn't|hadn't|won't)$/;
const HEDGE = /^(?:nearly|almost|barely)$/;

/** Ties that need both ends alive to take up now; family and acquaintance stay true after a death. */
const ACTING_TIES = new Set<RelationshipType>(['ally', 'enemy', 'rival', 'lover', 'member_of', 'serves', 'rules']);
/** Words left out when names are compared word by word, so "The Ash Court" is "Ash Court". */
const NAME_FILLER = new Set(['the', 'a', 'an', 'of']);

/** Whether a fact says its subject is dead or alive; null when it says neither, or both. */
export function lifeClaim(text: string): LifeClaim | null {
  const flat = text.replace(/\u2019/g, "'");
  const claims = new Set<LifeClaim>();
  for (const match of flat.matchAll(LIFE_WORDS)) {
    const word = match[1]!.toLowerCase();
    const prev = flat
      .slice(0, match.index)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .slice(-2);
    const [before, last] = prev.length === 2 ? prev : ['', prev[0] ?? ''];
    if (HEDGE.test(before) || HEDGE.test(last)) continue;
    if (AFTER_BE.has(word) && !BE.test(last) && !(BE_ADVERB.test(last) && BE.test(before))) continue;
    const negated = NEGATION.test(before) || NEGATION.test(last) || `${before} ${last}` === 'no longer';
    claims.add(DEATH.has(word) !== negated ? 'dead' : 'alive');
  }
  return claims.size === 1 ? [...claims][0]! : null;
}

function activeFacts(db: Db, campaignId: number, subject: string): Array<{ id: number; fact: string }> {
  return db
    .prepare('SELECT id, fact FROM canon_fact WHERE campaign_id = ? AND active = 1 AND lower(subject) = lower(?) ORDER BY id DESC')
    .all(campaignId, subject) as Array<{ id: number; fact: string }>;
}

/**
 * Why a fact that says its subject is dead (or alive) clashes with an active fact saying the opposite, as a clause.
 * `retired` names facts a save supersedes before this one lands, which no longer count.
 */
export function factContradiction(
  db: Db,
  campaignId: number,
  input: { subject: string; fact: string; supersedes_id?: number },
  retired: ReadonlySet<number> = new Set(),
): string | null {
  if (input.supersedes_id !== undefined) return null;
  const claim = lifeClaim(input.fact);
  if (claim === null) return null;
  const clash = activeFacts(db, campaignId, input.subject).find((row) => {
    if (retired.has(row.id)) return false;
    const old = lifeClaim(row.fact);
    return old !== null && old !== claim;
  });
  if (!clash) return null;
  return `contradicts active fact ${clash.id} on ${input.subject} ("${snippet(clash.fact, 160)}"); if it replaces that fact, pass supersedes_id ${clash.id}, and if it is about someone else, file it under their name`;
}

/** Why a dead NPC or destroyed faction cannot take this end of a new tie, or null when it can. */
function goneRefusal(db: Db, entity: EntityRow): string | null {
  if (entity.kind !== 'npc' && entity.kind !== 'faction') return null;
  const ended =
    entity.kind === 'faction'
      ? (db
          .prepare('SELECT ended_day FROM world_faction WHERE campaign_id = ? AND entity_id = ? AND ended_day IS NOT NULL')
          .get(entity.campaign_id, entity.id) as { ended_day: number } | undefined)
      : undefined;
  if (entity.status !== 'dead' && !ended) return null;

  const fact = activeFacts(db, entity.campaign_id, entity.name).find((row) => lifeClaim(row.fact) === 'dead');
  const why = fact
    ? `: "${snippet(fact.fact, 160)}" (fact id ${fact.id})`
    : ended
      ? ` (it ended on day ${ended.ended_day})`
      : ` (codex entry ${entity.id} has status dead)`;
  const next = ended
    ? 'Keep a tie from before the end in the notes instead.'
    : `Revive ${entity.kind === 'faction' ? 'it' : 'them'} first with entity {op: upsert, kind: ${entity.kind}, name: "${entity.name}", status: alive}${
        fact ? ` and remember {op: fact, supersedes_id: ${fact.id}}` : ''
      }, or keep a tie from before the end in the notes.`;
  return `${entity.name} ${entity.kind === 'faction' ? 'is destroyed' : 'is dead'}${why}. ${next}`;
}

/** The refusal for a new acting tie with a dead NPC or destroyed faction at either end; a place end is never checked. */
export function deadTieRefusal(db: Db, type: RelationshipType, from: EntityRow, to: EntityRow): string | null {
  if (!ACTING_TIES.has(type) || from.kind === 'place' || to.kind === 'place') return null;
  return goneRefusal(db, from) ?? goneRefusal(db, to);
}

/** Case, accents and punctuation folded away, so "Míra-Vell" reads as "mira vell". */
function foldName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
}

/** Folded alike, a typo or two apart (none under five letters), or, for the same kind, one name's words all in the other. */
function nearName(a: string, b: string, sameKind: boolean): boolean {
  const [fa, fb] = [foldName(a), foldName(b)];
  if (fa === fb) return true;
  const shorter = Math.min(fa.length, fb.length);
  const allowed = shorter < 5 ? 0 : shorter < 9 ? 1 : 2;
  if (allowed > 0 && editDistance(fa, fb) <= allowed) return true;
  if (!sameKind) return false;
  const [wa, wb] = [fa, fb].map((folded) => folded.split(' ').filter((word) => word && !NAME_FILLER.has(word))) as [
    string[],
    string[],
  ];
  const [few, many] = wa.length <= wb.length ? [wa, new Set(wb)] : [wb, new Set(wa)];
  return few.length > 0 && few.every((word) => many.has(word));
}

/** The refusal for a new entry whose name is close to existing ones, naming each with its id; null when none is. */
export function nearNameRefusal(db: Db, campaignId: number, name: string, kind: EntityKind): string | null {
  const rows = db
    .prepare('SELECT id, kind, name, status FROM entity WHERE campaign_id = ? ORDER BY id')
    .all(campaignId) as Array<Pick<EntityRow, 'id' | 'kind' | 'name' | 'status'>>;
  const near = rows.filter((row) => nearName(name, row.name, row.kind === kind)).slice(0, 3);
  if (near.length === 0) return null;
  const listed = near.map((row) => `${row.name} (${row.kind}${row.status === 'dead' ? ', dead' : ''}, id ${row.id})`);
  const id = near.length === 1 ? `id: ${near[0]!.id}` : 'the id you mean';
  return `Refused, nothing was written: did you mean ${listed.join(' or ')}? Re-call with ${id} to update it, or with distinct: true if "${name}" is a different entry.`;
}
