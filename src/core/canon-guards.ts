// Canon checked where it is written: a fact that contradicts an active one, and a new tie for a dead NPC or a
// destroyed faction, are refused with the canon they would break quoted.
import type { Db } from '../db/connection.js';
import { snippet } from './campaign.js';
import type { EntityKind, EntityRow, RelationshipType } from './codex.js';

export type LifeClaim = 'dead' | 'alive';

const DEATH = new Set(['died', 'dies', 'perished', 'perishes', 'deceased', 'dead', 'slain', 'killed', 'murdered', 'destroyed']);
const LIFE = new Set(['alive', 'survive', 'survives', 'survived', 'lives', 'living']);
/** Words that only count after a be-verb, so "Mira killed Grask" is no death of Mira's. */
const AFTER_BE = new Set(['deceased', 'dead', 'slain', 'killed', 'murdered', 'destroyed', 'alive']);
/** What a contracted "'s" is the be-verb of ("Mira's dead"); before "slain" it is "has". */
const ADJECTIVE = new Set(['dead', 'deceased', 'alive']);
const BE = new Set([
  ...['is', 'was', 'are', 'were', 'be', 'been', 'being', "isn't", "wasn't", "aren't", "weren't"],
  ...['lies', 'lay', 'lying', 'remain', 'remains', 'remained', 'stays', 'stayed', 'got'],
]);
const NEGATION = new Set(['not', 'never', 'no', "isn't", "wasn't", "aren't", "weren't", "didn't", "doesn't", "don't", "hasn't", "hadn't", "haven't"]);
/** Words that may stand between the subject and its life word; anything else (a modal, a noun, "nearly") breaks the claim. */
const LINK = new Set([
  ...BE,
  ...NEGATION,
  ...["'s", 'has', 'have', 'had', 'did', 'does', 'found', 'left', 'longer', 'yet', 'now', 'long', 'already', 'still'],
  ...['also', 'just', 'since', 'then', 'finally', 'later', 'recently', 'truly', 'indeed', 'very', 'much'],
]);
const HEDGE = /^(?:nearly|almost|barely|perhaps|maybe|probably|possibly|apparently|reportedly|supposedly|allegedly|presumably|likely|seemingly|surely)$/;
const PRONOUN = new Set(['he', 'she', 'they', 'it']);
/** Capitalised words that are no part of a name, so "Her brother" or a later "He" never reads as the subject. */
const NOT_NAME = new Set([...PRONOUN, 'his', 'her', 'their', 'its', 'nobody', 'none', 'everyone', 'everybody', 'someone', 'all', 'both', 'each']);
/** Idioms that say nothing of a death, blanked before reading; "wanted dead or alive" is caught by SUPPOSING. */
const IDIOM =
  /\bdead\s+(?:tired|certain|sure|set|serious|wrong|right|last|broke|drunk|asleep|silent|still|end|ends|ringer|weight|heat|ahead|of\s+(?:night|winter)|to\s+the\s+world|on\s+\w+\s+feet|in\s+the\s+water)\b|\balive\s+(?:with|to)\b|\b(?:is|was|are|were)\s+survived\s+by\b/gi;
/** A sentence holding one of these only supposes or offers a choice, so it claims nothing. */
const SUPPOSING = /\b(?:or|nor|either|whether|if|unless|lest|until)\b/i;
/** Clause breaks; a clause opened by when, whenever, once or before only sets a time and is skipped. */
const CLAUSE = /[,:()[\]"\u2013\u2014]|\s-\s|\b(and|but|while|whereas|although|though|because|after|as|when|whenever|once|before)\b/i;
const TIME_ONLY = /^(?:when|whenever|once|before)$/i;

/** Ties that need both ends alive to take up now; family and acquaintance stay true after a death. */
const ACTING_TIES = new Set<RelationshipType>(['ally', 'enemy', 'rival', 'lover', 'member_of', 'serves', 'rules']);
/** Words left out when names are compared word by word, so "The Ash Court" is "Ash Court". */
const NAME_FILLER = new Set(['the', 'a', 'an', 'of']);

/** A clause's words, with a possessive or contracted "'s" split off as a word of its own. */
function clauseWords(clause: string): string[] {
  return (clause.match(/[\p{L}\p{N}']+/gu) ?? []).flatMap((raw) => {
    const word = raw.replace(/^'+/, '').replace(/(?<![sS])'+$/, '');
    const owner = /^(.+)'s$/i.exec(word);
    return owner ? [owner[1]!, "'s"] : word ? [word] : [];
  });
}

function nameWords(text: string): string[] {
  return foldName(text)
    .split(' ')
    .filter((word) => word && !NAME_FILLER.has(word));
}

/**
 * Whose death the words before a life word tell: the subject's (its name, or a pronoun opening the fact), someone
 * else's ("Mira's brother", "the brother of Mira", "Grask" under Mira), or unknown when the subject is left out.
 */
function whose(before: string[], subject: string | undefined, opening: boolean): 'subject' | 'other' | 'unknown' {
  if (before.length === 0) return 'unknown';
  const lower = before.map((word) => word.toLowerCase());
  if (lower.length === 1 && PRONOUN.has(lower[0]!)) return opening ? 'subject' : 'unknown';
  const named = nameWords(before.join(' '));
  if (named.length === 0) return 'other';
  const proper = before.every((word, i) => NAME_FILLER.has(lower[i]!) || (/^\p{Lu}/u.test(word) && !NOT_NAME.has(lower[i]!)));
  if (subject === undefined) return proper ? 'subject' : 'other';
  const own = nameWords(subject);
  if (named.every((word) => own.includes(word))) return 'subject';
  const linked = lower.some((word) => word === "'s" || word.endsWith("'") || word === 'of');
  return proper && !linked && own.length > 0 && own.every((word) => named.includes(word)) ? 'subject' : 'other';
}

/**
 * Whether a fact says its subject is dead or alive; null when it says neither, both, or only of someone else.
 * Without `subject` any name counts as the subject; when unsure it claims nothing.
 */
export function lifeClaim(text: string, subject?: string): LifeClaim | null {
  const sure = new Set<LifeClaim>();
  const unsure = new Set<LifeClaim>();
  let clauses = 0;
  for (const sentence of text.replace(/\u2019/g, "'").replace(IDIOM, ' , ').split(/[.!?;]+/)) {
    const supposes = SUPPOSING.test(sentence);
    const parts = sentence.split(CLAUSE);
    for (let i = 0; i < parts.length; i += 2) {
      const words = clauseWords(parts[i] ?? '');
      if (words.length === 0) continue;
      const opening = clauses++ === 0;
      if (supposes || TIME_ONLY.test(parts[i - 1] ?? '')) continue;
      words.forEach((word, at) => {
        const lower = word.toLowerCase();
        if (!DEATH.has(lower) && !LIFE.has(lower)) return;
        if ((lower === 'lives' || lower === 'living') && words[at - 1]?.toLowerCase() !== 'still') return;
        let start = at;
        while (start > 0 && LINK.has(words[start - 1]!.toLowerCase())) start--;
        const links = words.slice(start, at).map((w) => w.toLowerCase());
        if (words.slice(0, at).some((w) => HEDGE.test(w.toLowerCase()))) return;
        if (AFTER_BE.has(lower) && !links.some((w) => BE.has(w) || (w === "'s" && ADJECTIVE.has(lower)))) return;
        const claim = DEATH.has(lower) !== links.some((w) => NEGATION.has(w)) ? 'dead' : 'alive';
        const who = whose(words.slice(0, start), subject, opening);
        if (who === 'subject') sure.add(claim);
        else if (who === 'unknown') unsure.add(claim);
      });
    }
  }
  if (sure.size !== 1) return null;
  const claim = [...sure][0]!;
  return unsure.has(claim === 'dead' ? 'alive' : 'dead') ? null : claim;
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
  const claim = lifeClaim(input.fact, input.subject);
  if (claim === null) return null;
  const clash = activeFacts(db, campaignId, input.subject).find((row) => {
    if (retired.has(row.id)) return false;
    const old = lifeClaim(row.fact, input.subject);
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

  const fact = activeFacts(db, entity.campaign_id, entity.name).find((row) => lifeClaim(row.fact, entity.name) === 'dead');
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
