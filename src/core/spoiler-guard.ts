// The spoiler guard: warns the DM when text a call puts in the player's window restates one of the campaign's
// secrets. It never refuses and never changes what the call did.
import type { Db } from '../db/connection.js';
import { DM_ONLY_KINDS } from './campaign.js';
import { getStoryOutline } from './story.js';

type Args = Record<string, unknown>;

/** Words too common to tie a sentence to a secret; words under four letters are dropped as well. */
const STOPWORDS = new Set(
  `about above across after again against almost alone along already also although always among another anyone anything
  around away back because been before behind being below beneath besides between beyond both came cannot come comes coming
  could does doing done down during each either else enough even ever every everyone everything find finds found from gave
  give gives going gone good great have having here hers herself himself into itself just keep keeps kept know known knows
  last least leave leaves left less like little long look looks looked made make makes many might more most much must myself
  near need needs never next nothing nobody none often once only onto other others over perhaps quite rather really said same
  says seem seems seemed seen several shall should since some someone something soon still such sure take takes taken than
  that their theirs them themselves then there these they thing things think this those though through told tell tells
  toward towards under until upon very want wants well went were what when where whether which while whom whose will with
  within without would your yours party player players character characters secret secretly truly actually`.split(/\s+/),
);
/** A shared word shorter than this is too ordinary to be the secret's own ("paid", "small", "proof"). */
const DISTINCT_LENGTH = 7;
/** How many words a sentence must share with a secret sentence before it counts as restating it. */
const MIN_SHARED = 3;
/** How many words either side of the match a quote keeps. */
const QUOTE_SPAN = 8;

interface Word {
  length: number;
  capital: boolean;
}

interface Secret {
  label: string;
  text: string;
  /** Named in every sentence of the text, as an entity's hidden notes are about that entity. */
  subject?: string;
}

const pluck = (list: unknown, key: string): unknown[] =>
  Array.isArray(list) ? list.map((item) => (item as Args | null)?.[key]) : [];

const quests = (list: unknown): unknown[] =>
  Array.isArray(list) ? list.flatMap((quest: Args) => [quest?.title, quest?.summary, ...pluck(quest?.steps, 'text')]) : [];

/** The text each write puts in the player's window; hidden-by-design fields (secret notes, ending, hidden notes, hidden threads and clues, unheard rumours) are left out. */
const VISIBLE: Record<string, (args: Args, db: Db) => unknown[]> = {
  story: (a) => [a.premise, a.title, a.goal, a.summary],
  thread: (a, db) => {
    const stored = a.op === 'update' && a.hidden == null ? threadHidden(db, a.campaign_id, a.id) : false;
    return a.op === 'find_clue' || a.hidden === true || stored ? [] : [a.title, a.summary, a.text];
  },
  entity: (a) => [
    a.summary,
    a.notes,
    a.speech_pattern,
    a.catchphrase,
    a.goal,
    a.fear,
    a.attitude,
    ...Object.values((a.voice as Args) ?? {}),
    // Only an upsert writes the name; get and voice merely point at an existing entry.
    a.op === 'upsert' ? a.name : undefined,
  ],
  remember: (a) => [a.fact, a.definition, a.subject, a.term],
  log_event: (a) => [a.text],
  update_objectives: (a) => quests(a.quests),
  checkpoint: (a) => [
    a.scene_title,
    a.scene_summary,
    a.recap_override,
    ...pluck(a.facts, 'fact'),
    ...pluck(a.facts, 'subject'),
    ...pluck(a.events, 'text'),
    ...quests(a.objectives),
    ...pluck(a.glossary, 'definition'),
    ...pluck(a.glossary, 'term'),
    ...pluck(a.deeds, 'reason'),
  ],
  world: (a) => (a.op === 'deed' ? [a.reason] : []),
};

function threadHidden(db: Db, campaignId: unknown, id: unknown): boolean {
  const row = db.prepare('SELECT hidden FROM plot_thread WHERE id = ? AND campaign_id = ?').get(id, campaignId) as
    | { hidden: number }
    | undefined;
  return row?.hidden === 1;
}

/** A crude stem, so "smuggling", "smugglers" and "smuggled" meet. */
function stemOf(word: string): string {
  const stem = word.replace(/(?<!s)s$/, '').replace(/(?:ing|ed|er)$/, (suffix, at: number) => (at >= 3 ? '' : suffix));
  return stem.length > 3 ? stem.replace(/e$/, '') : stem;
}

/** The distinctive words of a text by stem, remembering whether one was ever written capitalised. */
function words(text: string): Map<string, Word> {
  const out = new Map<string, Word>();
  for (const raw of text.replace(/['’]s\b/g, '').split(/[^\p{L}\p{N}]+/u)) {
    const lower = raw.toLowerCase();
    if (lower.length < 4 || STOPWORDS.has(lower)) continue;
    const stem = stemOf(lower);
    out.set(stem, { length: lower.length, capital: raw[0] !== lower[0] || (out.get(stem)?.capital ?? false) });
  }
  return out;
}

const sentences = (text: string): string[] =>
  text
    .split(/[.!?;\n]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

/** The sentence cut to a few words either side of the first one with this stem. */
function quote(sentence: string, stem: string): string {
  const all = sentence.split(/\s+/);
  const at = Math.max(0, all.findIndex((word) => words(word).has(stem)));
  const from = Math.max(0, at - QUOTE_SPAN);
  const to = Math.min(all.length, at + QUOTE_SPAN + 1);
  return `${from > 0 ? '...' : ''}${all.slice(from, to).join(' ')}${to < all.length ? '...' : ''}`;
}

function secrets(db: Db, campaignId: number): Secret[] {
  const outline = getStoryOutline(db, campaignId);
  const notes = db
    .prepare("SELECT name, hidden_notes FROM entity WHERE campaign_id = ? AND trim(hidden_notes) != ''")
    .all(campaignId) as Array<{ name: string; hidden_notes: string }>;
  const threads = db
    .prepare('SELECT title, summary FROM plot_thread WHERE campaign_id = ? AND hidden = 1 AND summary IS NOT NULL')
    .all(campaignId) as Array<{ title: string; summary: string }>;
  const clues = db
    .prepare("SELECT text FROM clue WHERE campaign_id = ? AND hidden = 1 AND status = 'planted'")
    .all(campaignId) as Array<{ text: string }>;
  return [
    { label: 'your secret note', text: outline.secret_notes ?? '' },
    { label: 'your planned ending', text: outline.ending ?? '' },
    ...notes.map((row) => ({ label: `${row.name}'s hidden notes`, text: row.hidden_notes, subject: row.name })),
    ...threads.map((row) => ({ label: `the hidden thread "${row.title}"`, text: row.summary })),
    ...clues.map((row) => ({ label: 'a hidden clue', text: row.text })),
  ].filter((secret) => secret.text.trim() !== '');
}

/** Every word the player's window already shows with the spoiler toggle off; DM-only rows stay out. */
function seenWords(db: Db, campaignId: number): Set<string> {
  const dmOnly = DM_ONLY_KINDS.map((kind) => `'${kind}'`).join(', ');
  const rows = db
    .prepare(
      `SELECT concat_ws(' ', name, premise) AS t FROM campaign WHERE id = @c
       UNION ALL SELECT premise FROM story_outline WHERE campaign_id = @c
       UNION ALL SELECT name FROM character WHERE campaign_id = @c
       UNION ALL SELECT concat_ws(' ', name, summary, notes, voice_json) FROM entity WHERE campaign_id = @c
       UNION ALL SELECT notes FROM relationship WHERE campaign_id = @c
       UNION ALL SELECT concat_ws(' ', subject, fact) FROM canon_fact WHERE campaign_id = @c AND active = 1
       UNION ALL SELECT concat_ws(' ', term, definition) FROM glossary_entry WHERE campaign_id = @c
       UNION ALL SELECT concat_ws(' ', title, summary) FROM quest WHERE campaign_id = @c
       UNION ALL SELECT s.text FROM quest_step s JOIN quest q ON q.id = s.quest_id WHERE q.campaign_id = @c
       UNION ALL SELECT concat_ws(' ', title, summary, location_name) FROM scene WHERE campaign_id = @c
       UNION ALL SELECT recap_text FROM session WHERE campaign_id = @c
       UNION ALL SELECT concat_ws(' ', title, goal) FROM act WHERE campaign_id = @c
       UNION ALL SELECT concat_ws(' ', title, goal, summary) FROM chapter WHERE campaign_id = @c
       UNION ALL SELECT concat_ws(' ', title, summary) FROM plot_thread WHERE campaign_id = @c AND hidden = 0
       UNION ALL SELECT text FROM clue WHERE campaign_id = @c AND hidden = 0
       UNION ALL SELECT text FROM rumour WHERE campaign_id = @c AND heard_at IS NOT NULL
       UNION ALL SELECT text FROM journal_entry WHERE campaign_id = @c
       UNION ALL SELECT text FROM event WHERE campaign_id = @c AND reverted = 0 AND kind NOT IN (${dmOnly})`,
    )
    .all({ c: campaignId }) as Array<{ t: string | null }>;
  const seen = new Set<string>();
  for (const row of rows) for (const stem of words(row.t ?? '').keys()) seen.add(stem);
  return seen;
}

/**
 * A sentence restates a secret sentence when they share three words, one of them distinctive: seven letters or more,
 * not yet in the player's window, and no name written capitalised in both.
 */
function firstMatch(texts: string[], all: Secret[], seen: (stem: string) => boolean): string | null {
  for (const sentence of texts.flatMap(sentences)) {
    const mine = words(sentence);
    for (const secret of all) {
      for (const line of sentences(secret.text)) {
        const theirs = words(`${secret.subject ?? ''} ${line}`);
        const shared = [...mine].filter(([stem]) => theirs.has(stem));
        if (shared.length < MIN_SHARED) continue;
        const fresh = shared.find(
          ([stem, word]) =>
            word.length >= DISTINCT_LENGTH && !(word.capital && theirs.get(stem)!.capital) && !seen(stem),
        );
        if (!fresh) continue;
        return `Spoiler check: '${quote(sentence, fresh[0])}' matches ${secret.label} '${quote(line, fresh[0])}' — the player sees this; reword it or mark it hidden.`;
      }
    }
  }
  return null;
}

/** The non-empty strings a write's arguments put in the player's window; none for a tool without such fields. */
export function visibleTexts(db: Db, tool: string, args: unknown): string[] {
  const visible = VISIBLE[tool];
  if (!visible) return [];
  return visible((args ?? {}) as Args, db).filter((text): text is string => typeof text === 'string' && text.trim() !== '');
}

/** The DM-only warning for a write whose player-visible text restates a secret, or null; call it before the write. */
export function spoilerWarning(db: Db, tool: string, args: unknown): string | null {
  const input = (args ?? {}) as Args;
  const campaignId = input.campaign_id;
  if (typeof campaignId !== 'number' || !VISIBLE[tool]) return null;
  try {
    const texts = visibleTexts(db, tool, input);
    if (texts.length === 0) return null;
    // The window's words are read only once a sentence comes close to a secret, which most writes never do.
    let seen: Set<string> | undefined;
    return firstMatch(texts, secrets(db, campaignId), (stem) => (seen ??= seenWords(db, campaignId)).has(stem));
  } catch {
    // A failure only drops the warning; the call itself goes ahead untouched.
    return null;
  }
}
