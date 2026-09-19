// Story structure: the outline, its acts and chapters, the threads and clues under them, the
// rumours in the air and the journal the player keeps. Hidden rows are the DM's until revealed.
import type { Db } from '../db/connection.js';
import { getCampaign, logEvent, snippet } from './campaign.js';
import { getSettings } from './settings.js';

export type ActStatus = 'planned' | 'active' | 'done';
export type ChapterStatus = 'open' | 'closed';
export type ThreadStatus = 'open' | 'resolved' | 'dropped';
export type ClueStatus = 'planted' | 'found';
export type RumourScope = 'world' | 'region' | 'location';
export type RumourTruth = 'true' | 'false' | 'twisted';

export interface StoryOutline {
  premise: string | null;
  ending: string | null;
  secret_notes: string | null;
}

export interface Act {
  id: number;
  number: number;
  title: string;
  goal: string | null;
  status: ActStatus;
}

export interface Chapter {
  id: number;
  act_id: number | null;
  number: number;
  title: string;
  goal: string | null;
  summary: string | null;
  status: ChapterStatus;
  started_at: string;
  closed_at: string | null;
}

export interface PlotThread {
  id: number;
  title: string;
  status: ThreadStatus;
  hidden: boolean;
  summary: string | null;
  chapter_id: number | null;
}

export interface Clue {
  id: number;
  thread_id: number | null;
  text: string;
  hidden: boolean;
  status: ClueStatus;
  found_at_scene_id: number | null;
  planted_at: string;
}

export interface Rumour {
  id: number;
  scope: RumourScope;
  text: string;
  /** Absent in the player's payload until the rumour is resolved; always present for the DM. */
  truth?: RumourTruth;
  source_kind: string | null;
  thread_id: number | null;
  heard_at: string | null;
  resolved: boolean;
  chapter_id: number | null;
}

/** A rumour as getRumours returns it, with whether a clue on its thread has been found. */
export interface RumourWithFollowed extends Rumour {
  followed: boolean;
}

export interface JournalEntry {
  id: number;
  chapter_id: number | null;
  text: string;
  created_at: string;
}

export interface StoryArc {
  outline: StoryOutline;
  act: Act | null;
  chapter: Chapter | null;
  recaps: Array<Pick<Chapter, 'id' | 'number' | 'title' | 'summary'> & { chapter_id: number }>;
  threads: PlotThread[];
  clues: Clue[];
}

/** The DM briefing prints a line per recap, so this keeps that prompt from growing with the campaign. */
const CHAPTER_RECAP_LIMIT = 6;
export const JOURNAL_BRIEFING_LIMIT = 3;

const nowIso = (): string => new Date().toISOString();

/** The player's spoiler toggle, added by the progression package; off until it exists. */
export function showSecrets(db: Db, campaignId: number): boolean {
  return (getSettings(db, campaignId) as { show_secrets?: boolean }).show_secrets === true;
}

/** Hidden rows go to the DM always, and to the player only with the spoiler toggle on. */
function keepHidden(db: Db, campaignId: number, forPlayer: boolean): boolean {
  return !forPlayer || showSecrets(db, campaignId);
}

export function getStoryOutline(db: Db, campaignId: number): StoryOutline {
  const row = db
    .prepare('SELECT premise, ending, secret_notes FROM story_outline WHERE campaign_id = ?')
    .get(campaignId) as StoryOutline | undefined;
  return row ?? { premise: null, ending: null, secret_notes: null };
}

export function setStoryOutline(
  db: Db,
  input: { campaign_id: number; premise?: string; ending?: string; secret_notes?: string },
): StoryOutline {
  getCampaign(db, input.campaign_id);
  db.prepare(
    `INSERT INTO story_outline (campaign_id, premise, ending, secret_notes, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (campaign_id) DO UPDATE SET premise = COALESCE(excluded.premise, premise),
       ending = COALESCE(excluded.ending, ending), secret_notes = COALESCE(excluded.secret_notes, secret_notes),
       updated_at = excluded.updated_at`,
  ).run(
    input.campaign_id,
    input.premise ?? null,
    input.ending ?? null,
    input.secret_notes ?? null,
    nowIso(),
  );
  return getStoryOutline(db, input.campaign_id);
}

export function listActs(db: Db, campaignId: number): Act[] {
  return db
    .prepare('SELECT id, number, title, goal, status FROM act WHERE campaign_id = ? ORDER BY number')
    .all(campaignId) as Act[];
}

export function addAct(db: Db, input: { campaign_id: number; title: string; goal?: string }): Act {
  getCampaign(db, input.campaign_id);
  const next = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM act WHERE campaign_id = ?').get(
    input.campaign_id,
  ) as { n: number };
  const id = Number(
    db
      .prepare('INSERT INTO act (campaign_id, number, title, goal) VALUES (?, ?, ?, ?)')
      .run(input.campaign_id, next.n, input.title, input.goal ?? null).lastInsertRowid,
  );
  return db.prepare('SELECT id, number, title, goal, status FROM act WHERE id = ?').get(id) as Act;
}

export function currentAct(db: Db, campaignId: number): Act | null {
  return (
    (db
      .prepare("SELECT id, number, title, goal, status FROM act WHERE campaign_id = ? AND status = 'active' ORDER BY number DESC LIMIT 1")
      .get(campaignId) as Act | undefined) ?? null
  );
}

export function currentChapter(db: Db, campaignId: number): Chapter | null {
  return (
    (db
      .prepare("SELECT * FROM chapter WHERE campaign_id = ? AND status = 'open' ORDER BY number DESC LIMIT 1")
      .get(campaignId) as Chapter | undefined) ?? null
  );
}

/** What remember, update_objectives and checkpoint stamp their rows with. */
export function currentChapterId(db: Db, campaignId: number): number | null {
  return currentChapter(db, campaignId)?.id ?? null;
}

/** Puts the scene the checkpoint just closed in the chapter that was open. */
export function tagSceneChapter(db: Db, campaignId: number, sceneId: number): number | null {
  const chapterId = currentChapterId(db, campaignId);
  if (chapterId !== null) {
    db.prepare('UPDATE scene SET chapter_id = ? WHERE id = ? AND campaign_id = ?').run(chapterId, sceneId, campaignId);
  }
  return chapterId;
}

function activateAct(db: Db, campaignId: number, actId: number): void {
  db.prepare("UPDATE act SET status = 'done' WHERE campaign_id = ? AND status = 'active' AND id != ?").run(
    campaignId,
    actId,
  );
  db.prepare("UPDATE act SET status = 'active' WHERE id = ?").run(actId);
}

export function openChapter(
  db: Db,
  input: { campaign_id: number; title?: string; goal?: string; act_id?: number },
): Chapter {
  getCampaign(db, input.campaign_id);
  const open = currentChapter(db, input.campaign_id);
  if (open) {
    throw new Error(
      `Chapter ${open.number} ("${open.title}") is still open. Call story {op: advance_chapter} with a summary to close it and open the next one.`,
    );
  }
  if (input.act_id !== undefined) {
    const act = db.prepare('SELECT id FROM act WHERE id = ? AND campaign_id = ?').get(input.act_id, input.campaign_id);
    if (!act) throw new Error(`No act with id ${input.act_id} in campaign ${input.campaign_id}.`);
  }
  // Without an act the chapter joins the one being played, or the last one written down.
  const actId =
    input.act_id ??
    currentAct(db, input.campaign_id)?.id ??
    (listActs(db, input.campaign_id).at(-1)?.id ?? null);
  const next = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM chapter WHERE campaign_id = ?').get(
    input.campaign_id,
  ) as { n: number };
  const title = input.title ?? `Chapter ${next.n}`;
  const id = Number(
    db
      .prepare(
        'INSERT INTO chapter (campaign_id, act_id, number, title, goal, started_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(input.campaign_id, actId, next.n, title, input.goal ?? null, nowIso()).lastInsertRowid,
  );
  if (actId !== null) activateAct(db, input.campaign_id, actId);
  logEvent(db, {
    campaign_id: input.campaign_id,
    kind: 'story',
    text: `Chapter ${next.n} opened: ${title}${input.goal ? ` - ${input.goal}` : ''}`,
    payload: { chapter_id: id, act_id: actId },
  });
  return db.prepare('SELECT * FROM chapter WHERE id = ?').get(id) as Chapter;
}

/** Closes the open chapter with its recap and opens the next one; the recaps are the story's spine. */
export function advanceChapter(
  db: Db,
  input: { campaign_id: number; summary: string; title?: string; goal?: string; act_id?: number },
): { closed: Chapter; opened: Chapter } {
  return db.transaction(() => {
    const open = currentChapter(db, input.campaign_id);
    if (!open) {
      throw new Error('No chapter is open. Call story {op: open_chapter} first; your summary was not saved.');
    }
    db.prepare("UPDATE chapter SET summary = ?, status = 'closed', closed_at = ? WHERE id = ?").run(
      input.summary,
      nowIso(),
      open.id,
    );
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'story',
      text: `Chapter ${open.number} closed: ${open.title} - ${snippet(input.summary, 200)}`,
      payload: { chapter_id: open.id },
    });
    const opened = openChapter(db, {
      campaign_id: input.campaign_id,
      title: input.title,
      goal: input.goal,
      act_id: input.act_id,
    });
    return {
      closed: db.prepare('SELECT * FROM chapter WHERE id = ?').get(open.id) as Chapter,
      opened,
    };
  })();
}

/** Pass null for the whole timeline: the player's window wants every chapter, the DM's briefing does not. */
export function chapterRecaps(
  db: Db,
  campaignId: number,
  limit: number | null = CHAPTER_RECAP_LIMIT,
): StoryArc['recaps'] {
  const capped = limit === null ? '' : ' LIMIT ?';
  const params = limit === null ? [campaignId] : [campaignId, limit];
  return (
    db
      .prepare(
        `SELECT id, number, title, summary FROM chapter WHERE campaign_id = ? AND status = 'closed' AND summary IS NOT NULL ORDER BY number DESC${capped}`,
      )
      .all(...params) as Array<Pick<Chapter, 'id' | 'number' | 'title' | 'summary'>>
  )
    .reverse()
    .map((row) => ({ ...row, chapter_id: row.id }));
}

interface ThreadRow extends Omit<PlotThread, 'hidden'> {
  hidden: number;
}

const toThread = (row: ThreadRow): PlotThread => ({ ...row, hidden: row.hidden === 1 });

/** How many chapters back a resolved thread or rumour may still show in the player's window. */
const RESOLVED_STORY_CHAPTER_WINDOW = 3;

export function openThreads(db: Db, campaignId: number, opts: { forPlayer?: boolean } = {}): PlotThread[] {
  const hidden = keepHidden(db, campaignId, opts.forPlayer === true);
  const rows = db
    .prepare(
      "SELECT id, title, status, hidden, summary, chapter_id FROM plot_thread WHERE campaign_id = ? AND status = 'open' ORDER BY id",
    )
    .all(campaignId) as ThreadRow[];
  const open = rows.filter((r) => hidden || r.hidden === 0).map(toThread);
  if (opts.forPlayer !== true) return open;

  // The player keeps recently closed threads the way getRumours keeps resolved rumours; the DM's list
  // stays open-only. A thread counts as recent when it was opened in one of the last few chapters or
  // was last touched since the oldest of them began - closing it is the touch that matters, and a
  // thread opened long ago but resolved this chapter must not vanish the moment it pays off.
  const recent = db
    .prepare('SELECT id, started_at FROM chapter WHERE campaign_id = ? ORDER BY number DESC LIMIT ?')
    .all(campaignId, RESOLVED_STORY_CHAPTER_WINDOW) as Array<{ id: number; started_at: string }>;
  if (recent.length === 0) return open;
  const chapterClause = `chapter_id IN (${recent.map(() => '?').join(',')})`;
  const closed = db
    .prepare(
      `SELECT id, title, status, hidden, summary, chapter_id FROM plot_thread WHERE campaign_id = ? AND status IN ('resolved', 'dropped') AND (${chapterClause} OR updated_at >= ?) ORDER BY id`,
    )
    .all(campaignId, ...recent.map((c) => c.id), recent[recent.length - 1]!.started_at) as ThreadRow[];
  return [...open, ...closed.filter((r) => hidden || r.hidden === 0).map(toThread)];
}

export function addPlotThread(
  db: Db,
  input: { campaign_id: number; title: string; summary?: string; hidden?: boolean },
): PlotThread {
  getCampaign(db, input.campaign_id);
  const ts = nowIso();
  const id = Number(
    db
      .prepare(
        'INSERT INTO plot_thread (campaign_id, title, summary, hidden, chapter_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.campaign_id,
        input.title,
        input.summary ?? null,
        input.hidden === true ? 1 : 0,
        currentChapterId(db, input.campaign_id),
        ts,
        ts,
      ).lastInsertRowid,
  );
  const thread = toThread(
    db.prepare('SELECT id, title, status, hidden, summary, chapter_id FROM plot_thread WHERE id = ?').get(id) as ThreadRow,
  );
  logEvent(db, {
    campaign_id: input.campaign_id,
    kind: 'story',
    text: thread.hidden ? 'A thread was opened.' : `Thread opened: ${snippet(thread.title, 160)}`,
    payload: { thread_id: thread.id },
  });
  return thread;
}

export function updatePlotThread(
  db: Db,
  input: { campaign_id: number; id: number; status?: ThreadStatus; summary?: string; hidden?: boolean },
): PlotThread {
  const row = db
    .prepare('SELECT id FROM plot_thread WHERE id = ? AND campaign_id = ?')
    .get(input.id, input.campaign_id);
  if (!row) throw new Error(`No plot thread with id ${input.id} in campaign ${input.campaign_id}.`);
  db.prepare(
    'UPDATE plot_thread SET status = COALESCE(?, status), summary = COALESCE(?, summary), hidden = COALESCE(?, hidden), updated_at = ? WHERE id = ?',
  ).run(
    input.status ?? null,
    input.summary ?? null,
    input.hidden === undefined ? null : input.hidden ? 1 : 0,
    nowIso(),
    input.id,
  );
  // A thread that is over takes its rumours with it, so the briefing stops repeating them.
  if (input.status === 'resolved' || input.status === 'dropped') {
    db.prepare('UPDATE rumour SET resolved = 1 WHERE thread_id = ?').run(input.id);
  }
  return toThread(
    db
      .prepare('SELECT id, title, status, hidden, summary, chapter_id FROM plot_thread WHERE id = ?')
      .get(input.id) as ThreadRow,
  );
}

interface ClueRow extends Omit<Clue, 'hidden'> {
  hidden: number;
}

const toClue = (row: ClueRow): Clue => ({ ...row, hidden: row.hidden === 1 });

export function listClues(db: Db, campaignId: number, opts: { forPlayer?: boolean } = {}): Clue[] {
  const rows = db
    .prepare(
      'SELECT id, thread_id, text, hidden, status, found_at_scene_id, planted_at FROM clue WHERE campaign_id = ? ORDER BY id',
    )
    .all(campaignId) as ClueRow[];
  const hidden = keepHidden(db, campaignId, opts.forPlayer === true);
  return rows.filter((r) => hidden || r.hidden === 0).map(toClue);
}

export function plantClue(
  db: Db,
  input: { campaign_id: number; text: string; thread_id?: number; hidden?: boolean },
): Clue {
  getCampaign(db, input.campaign_id);
  if (input.thread_id !== undefined) {
    const thread = db
      .prepare('SELECT id FROM plot_thread WHERE id = ? AND campaign_id = ?')
      .get(input.thread_id, input.campaign_id);
    if (!thread) throw new Error(`No plot thread with id ${input.thread_id} in campaign ${input.campaign_id}.`);
  }
  const id = Number(
    db
      .prepare('INSERT INTO clue (campaign_id, thread_id, text, hidden, planted_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.campaign_id, input.thread_id ?? null, input.text, input.hidden === true ? 1 : 0, nowIso())
      .lastInsertRowid,
  );
  const clue = toClue(
    db
      .prepare('SELECT id, thread_id, text, hidden, status, found_at_scene_id, planted_at FROM clue WHERE id = ?')
      .get(id) as ClueRow,
  );
  // A hidden clue is DM-side until find_clue reveals it, so its event is DM-only; a visible one already
  // shows in the player's list, so a content-free story event makes the window refetch it.
  logEvent(db, {
    campaign_id: input.campaign_id,
    kind: clue.hidden ? 'clue_planted' : 'story',
    text: 'A clue was planted.',
    payload: { clue_id: clue.id },
  });
  return clue;
}

export interface FindClueResult {
  clue: Clue;
  /** The rumour the clue was followed from, when a rumour_id was passed; null otherwise. */
  rumour: Rumour | null;
  /** Why a named rumour stayed where it was, when it already points at a different thread. */
  note: string | null;
}

/**
 * The player found it: the clue stops being hidden and remembers the scene it turned up in. A named
 * rumour follows the clue to its thread, unless the rumour is already on another one.
 */
export function findClue(
  db: Db,
  input: { campaign_id: number; id?: number; text?: string; rumour_id?: number },
): FindClueResult {
  // An unknown rumour is refused before any write, so a refused call costs nothing.
  let followed: RumourRow | undefined;
  if (input.rumour_id !== undefined) {
    followed = db
      .prepare('SELECT * FROM rumour WHERE id = ? AND campaign_id = ?')
      .get(input.rumour_id, input.campaign_id) as RumourRow | undefined;
    if (!followed) {
      throw new Error(
        `No rumour with id ${input.rumour_id} in campaign ${input.campaign_id}. Leave rumour_id out or pass one from the briefing.`,
      );
    }
  }
  const row = (
    input.id !== undefined
      ? db.prepare('SELECT id FROM clue WHERE id = ? AND campaign_id = ?').get(input.id, input.campaign_id)
      : db
          .prepare("SELECT id FROM clue WHERE campaign_id = ? AND status = 'planted' AND text LIKE ? ORDER BY id LIMIT 1")
          .get(input.campaign_id, `%${input.text ?? ''}%`)
  ) as { id: number } | undefined;
  if (!row) throw new Error('No matching planted clue. Pass the clue id from the briefing, or part of its text.');
  const campaign = getCampaign(db, input.campaign_id);
  db.prepare("UPDATE clue SET status = 'found', hidden = 0, found_at_scene_id = ? WHERE id = ?").run(
    campaign.current_scene_id,
    row.id,
  );
  const clue = toClue(
    db
      .prepare('SELECT id, thread_id, text, hidden, status, found_at_scene_id, planted_at FROM clue WHERE id = ?')
      .get(row.id) as ClueRow,
  );
  let note: string | null = null;
  if (followed) {
    if (clue.thread_id === null) {
      note = `Clue ${clue.id} hangs off no thread, so rumour ${followed.id} has nothing to move under; give the clue a thread first.`;
    } else if (followed.thread_id === null) {
      db.prepare('UPDATE rumour SET thread_id = ? WHERE id = ?').run(clue.thread_id, followed.id);
      followed.thread_id = clue.thread_id;
    } else if (followed.thread_id !== clue.thread_id) {
      note = `Rumour ${followed.id} already points at thread ${followed.thread_id}, so it was left there.`;
    }
  }
  logEvent(db, {
    campaign_id: input.campaign_id,
    kind: 'story',
    text: `Clue found: ${snippet(clue.text, 160)}`,
    payload: { clue_id: clue.id, thread_id: clue.thread_id },
  });
  return { clue, rumour: followed ? toRumour(followed) : null, note };
}

interface RumourRow extends Omit<Rumour, 'resolved'> {
  resolved: number;
}

const toRumour = (row: RumourRow): Rumour => ({ ...row, resolved: row.resolved === 1 });

/** The threads with at least one found clue: a rumour on one of them has been followed. */
function threadsWithFoundClues(db: Db, campaignId: number): Set<number> {
  const rows = db
    .prepare("SELECT DISTINCT thread_id FROM clue WHERE campaign_id = ? AND status = 'found' AND thread_id IS NOT NULL")
    .all(campaignId) as Array<{ thread_id: number }>;
  return new Set(rows.map((row) => row.thread_id));
}

/** The player's window keeps a rumour's truth only once the rumour is resolved. */
function withoutTruth(rumour: RumourWithFollowed): RumourWithFollowed {
  const copy = { ...rumour };
  delete copy.truth;
  return copy;
}

export function addRumour(
  db: Db,
  input: {
    campaign_id: number;
    text: string;
    scope?: RumourScope;
    truth?: RumourTruth;
    source_kind?: string;
    thread_id?: number;
  },
): Rumour {
  getCampaign(db, input.campaign_id);
  const id = Number(
    db
      .prepare(
        'INSERT INTO rumour (campaign_id, scope, text, truth, source_kind, thread_id, chapter_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.campaign_id,
        input.scope ?? 'location',
        input.text,
        input.truth ?? 'true',
        input.source_kind ?? null,
        input.thread_id ?? null,
        currentChapterId(db, input.campaign_id),
        nowIso(),
      ).lastInsertRowid,
  );
  const rumour = toRumour(db.prepare('SELECT * FROM rumour WHERE id = ?').get(id) as RumourRow);
  logEvent(db, {
    campaign_id: input.campaign_id,
    kind: 'story',
    text: `Rumour heard: ${snippet(rumour.text, 160)}`,
    payload: { rumour_id: rumour.id, thread_id: rumour.thread_id },
  });
  return rumour;
}

const RESOLVED_RUMOUR_CHAPTER_WINDOW = RESOLVED_STORY_CHAPTER_WINDOW;
const RESOLVED_RUMOUR_ROW_LIMIT = 20;

/**
 * The rumours in the air. mark_heard stamps the ones handed to the DM as heard, so the briefing can
 * show the player what they already know rather than the whole pile. for_player also brings back
 * rumours resolved in the last few chapters, marked resolved: true, so the window can mute them
 * instead of dropping them outright - the DM tool never asks for these.
 */
export function getRumours(
  db: Db,
  campaignId: number,
  opts: { scope?: RumourScope; limit?: number; mark_heard?: boolean; heard_only?: boolean; for_player?: boolean } = {},
): RumourWithFollowed[] {
  const scopeClause = opts.scope ? ' AND scope = ?' : '';
  const heardClause = opts.heard_only ? ' AND heard_at IS NOT NULL' : '';
  const scopeParams = opts.scope ? [opts.scope] : [];
  const forPlayer = opts.for_player === true;

  // The DM's hand-out reaches for what the player has not been told yet; the window keeps the plain newest pick.
  const unheardFirst = forPlayer ? '' : 'heard_at IS NULL DESC, ';
  const rows = db
    .prepare(
      `SELECT * FROM rumour WHERE campaign_id = ? AND resolved = 0${scopeClause}${heardClause} ORDER BY ${unheardFirst}id DESC LIMIT ?`,
    )
    .all(campaignId, ...scopeParams, opts.limit ?? 10) as RumourRow[];
  if (opts.mark_heard) {
    const ts = nowIso();
    const mark = db.prepare('UPDATE rumour SET heard_at = ? WHERE id = ? AND heard_at IS NULL');
    for (const row of rows) {
      if (row.heard_at === null) {
        mark.run(ts, row.id);
        row.heard_at = ts;
      }
    }
  }
  // A rumour is followed once a clue on its thread has been found; its truth is hidden from the
  // player until the rumour is resolved. Both are derived here so every player-facing read shares them.
  const followedThreads = threadsWithFoundClues(db, campaignId);
  const shape = (row: RumourRow): RumourWithFollowed => {
    const rumour = toRumour(row);
    const followed = rumour.thread_id !== null && followedThreads.has(rumour.thread_id);
    return forPlayer && !rumour.resolved ? withoutTruth({ ...rumour, followed }) : { ...rumour, followed };
  };
  const unresolved = rows.reverse().map(shape);
  if (!forPlayer) return unresolved;

  const recentChapterIds = (
    db
      .prepare('SELECT id FROM chapter WHERE campaign_id = ? ORDER BY number DESC LIMIT ?')
      .all(campaignId, RESOLVED_RUMOUR_CHAPTER_WINDOW) as Array<{ id: number }>
  ).map((c) => c.id);
  if (recentChapterIds.length === 0) return unresolved;

  const placeholders = recentChapterIds.map(() => '?').join(',');
  const resolvedRows = db
    .prepare(
      `SELECT * FROM rumour WHERE campaign_id = ? AND resolved = 1 AND chapter_id IN (${placeholders})${scopeClause}${heardClause} ORDER BY id DESC LIMIT ?`,
    )
    .all(campaignId, ...recentChapterIds, ...scopeParams, RESOLVED_RUMOUR_ROW_LIMIT) as RumourRow[];
  return [...unresolved, ...resolvedRows.reverse().map(shape)];
}

export function addJournalEntry(db: Db, input: { campaign_id: number; text: string }): JournalEntry {
  getCampaign(db, input.campaign_id);
  const id = Number(
    db
      .prepare('INSERT INTO journal_entry (campaign_id, chapter_id, text, created_at) VALUES (?, ?, ?, ?)')
      .run(input.campaign_id, currentChapterId(db, input.campaign_id), input.text, nowIso()).lastInsertRowid,
  );
  logEvent(db, {
    campaign_id: input.campaign_id,
    kind: 'journal',
    text: `The player wrote in their journal: ${snippet(input.text, 200)}`,
    payload: { journal_entry_id: id },
  });
  return db.prepare('SELECT id, chapter_id, text, created_at FROM journal_entry WHERE id = ?').get(id) as JournalEntry;
}

/** Newest last, the way it reads. */
export function readJournal(db: Db, campaignId: number, limit = 20): JournalEntry[] {
  return (
    db
      .prepare('SELECT id, chapter_id, text, created_at FROM journal_entry WHERE campaign_id = ? ORDER BY id DESC LIMIT ?')
      .all(campaignId, limit) as JournalEntry[]
  ).reverse();
}

/** Everything the briefing, the story panel and the story route need about the arc. */
export function storyArc(db: Db, campaignId: number, opts: { forPlayer?: boolean } = {}): StoryArc {
  const forPlayer = opts.forPlayer === true;
  const outline = getStoryOutline(db, campaignId);
  const chapter = currentChapter(db, campaignId);
  const act = chapter?.act_id
    ? ((db.prepare('SELECT id, number, title, goal, status FROM act WHERE id = ?').get(chapter.act_id) as Act) ?? null)
    : currentAct(db, campaignId);
  return {
    outline: keepHidden(db, campaignId, forPlayer) ? outline : { ...outline, secret_notes: null },
    act,
    chapter,
    recaps: chapterRecaps(db, campaignId, forPlayer ? null : CHAPTER_RECAP_LIMIT),
    threads: openThreads(db, campaignId, opts),
    clues: listClues(db, campaignId, opts),
  };
}
