// The codex: named people, factions, places, items, deities and events, the relationships between
// them, and the voice cards that keep a recurring NPC sounding like themselves. Writes are merges,
// never overwrites, and the consistency guard warns about restatements and contradictions instead of
// refusing anything.
import type { Db } from '../db/connection.js';
import { scheduleEntityEmblem } from './auto-portraits.js';
import { getCampaign, logEvent, snippet } from './campaign.js';
import { generatePortrait, individualPortraitPath, portraitsEnabled } from './portraits.js';
import { getSettings } from './settings.js';

export type EntityKind = 'npc' | 'faction' | 'place' | 'item' | 'deity' | 'event';
export type EntityStatus = 'alive' | 'dead' | 'unknown';
export type RelationshipType =
  | 'parent'
  | 'child'
  | 'spouse'
  | 'sibling'
  | 'ally'
  | 'enemy'
  | 'member_of'
  | 'owns'
  | 'rules'
  | 'serves'
  | 'knows'
  | 'rival'
  | 'lover';

export const ENTITY_KINDS: EntityKind[] = ['npc', 'faction', 'place', 'item', 'deity', 'event'];
export const RELATIONSHIP_TYPES: RelationshipType[] = [
  'parent',
  'child',
  'spouse',
  'sibling',
  'ally',
  'enemy',
  'member_of',
  'owns',
  'rules',
  'serves',
  'knows',
  'rival',
  'lover',
];

/** How an edge reads from the other end, so one stored row serves both entities. */
const INVERSE: Record<RelationshipType, string> = {
  parent: 'child',
  child: 'parent',
  spouse: 'spouse',
  sibling: 'sibling',
  ally: 'ally',
  enemy: 'enemy',
  member_of: 'has_member',
  owns: 'owned_by',
  rules: 'ruled_by',
  serves: 'served_by',
  knows: 'knows',
  rival: 'rival',
  lover: 'lover',
};

const SYMMETRIC = new Set<RelationshipType>(['spouse', 'sibling', 'ally', 'enemy', 'knows', 'rival', 'lover']);
/** Pairs of types that are the same edge read the other way round; only these two exist as types. */
const INVERSE_TYPE: Partial<Record<RelationshipType, RelationshipType>> = { parent: 'child', child: 'parent' };
/** The edges a family or faction tree is drawn from. */
const TREE_TYPES = new Set<RelationshipType>(['parent', 'child', 'spouse', 'sibling', 'member_of']);
const TREE_DEPTH = 3;

/** Wording this much shared with something already written is a restatement, not a new note. */
const DUPLICATE_OVERLAP = 0.6;
const STOPWORDS = new Set(
  'a an the and or of to in into on at by for with from is was are were be been has have had it its their his her he she they that this these those as but not now no yet still who which when while'.split(
    ' ',
  ),
);
const ALIVE_WORDS = /\b(alive|living|lives|survives|survived)\b/i;
const DEAD_WORDS = /\b(dead|died|dies|killed|slain|deceased|murdered)\b/i;
/** How much of a summary reaches the portrait prompt. */
const DESCRIPTION_LIMIT = 240;
const SUMMARY_LINE = 120;

export interface VoiceCard {
  speech_pattern?: string;
  catchphrase?: string;
  goal?: string;
  fear?: string;
  attitude?: string;
}

export interface EntityRow {
  id: number;
  campaign_id: number;
  kind: EntityKind;
  name: string;
  summary: string;
  notes: string;
  hidden_notes: string;
  voice_json: string | null;
  portrait_path: string | null;
  status: EntityStatus;
  first_seen_chapter_id: number | null;
  character_id: number | null;
  created_at: string;
  updated_at: string;
}

/** One edge as it reads from the entity that was asked for. */
export interface EntityRelation {
  id: number;
  /** The type as stored, from `from` to `to`. */
  type: RelationshipType;
  /** How it reads from this entity: a stored 'parent' shows as 'child' on the other end. */
  as: string;
  direction: 'out' | 'in';
  entity: { id: number; name: string; kind: EntityKind };
  notes: string;
}

export interface EntityView {
  id: number;
  campaign_id: number;
  kind: EntityKind;
  name: string;
  summary: string;
  notes: string;
  /** Present only when the caller is allowed the DM's own notes. */
  hidden_notes?: string;
  voice: VoiceCard | null;
  portrait_path: string | null;
  status: EntityStatus;
  first_seen_chapter_id: number | null;
  character_id: number | null;
  created_at: string;
  updated_at: string;
  relations: EntityRelation[];
}

export interface CodexListItem {
  id: number;
  kind: EntityKind;
  name: string;
  summary: string;
  status: EntityStatus;
  portrait_path: string | null;
  has_voice: boolean;
}

export interface TreeNode {
  id: number;
  name: string;
  kind: EntityKind;
  /** How this node relates to the one above it; null at the root. */
  relation: string | null;
  links: TreeNode[];
}

/** A name (case-insensitive) or an id. */
export type EntityRef = number | string;

const nowIso = (): string => new Date().toISOString();

/** The player's spoiler toggle; the setting arrives with the progression package. */
export function showSecrets(db: Db, campaignId: number): boolean {
  return (getSettings(db, campaignId) as { show_secrets?: boolean }).show_secrets === true;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOPWORDS.has(word));
}

function overlaps(incoming: string[], existing: string): boolean {
  if (incoming.length === 0) return false;
  const set = new Set(tokens(existing));
  return incoming.filter((word) => set.has(word)).length / incoming.length >= DUPLICATE_OVERLAP;
}

function parseVoice(json: string | null): VoiceCard | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as VoiceCard) : null;
  } catch {
    return null;
  }
}

function appendNote(existing: string, addition: string): string {
  const add = addition.trim();
  if (add.length === 0) return existing;
  return existing.trim().length === 0 ? add : `${existing.trim()}\n${add}`;
}

/** The chapter the campaign is in, when the story package's table is installed. */
function openChapterId(db: Db, campaignId: number): number | null {
  try {
    const row = db
      .prepare("SELECT id FROM chapter WHERE campaign_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1")
      .get(campaignId) as { id: number } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/** An NPC entity sharing a name with the PC or a companion is that character. */
function matchingCharacterId(db: Db, campaignId: number, name: string): number | null {
  const row = db
    .prepare(
      "SELECT id FROM character WHERE campaign_id = ? AND lower(name) = lower(?) AND role IN ('pc', 'companion') ORDER BY id LIMIT 1",
    )
    .get(campaignId, name) as { id: number } | undefined;
  return row?.id ?? null;
}

function findEntity(db: Db, campaignId: number, ref: EntityRef): EntityRow | undefined {
  const sql =
    typeof ref === 'number'
      ? 'SELECT * FROM entity WHERE campaign_id = ? AND id = ?'
      : 'SELECT * FROM entity WHERE campaign_id = ? AND lower(name) = lower(?)';
  return db.prepare(sql).get(campaignId, ref) as EntityRow | undefined;
}

function requireEntity(db: Db, campaignId: number, ref: EntityRef): EntityRow {
  const row = findEntity(db, campaignId, ref);
  if (!row) throw new Error(`Campaign ${campaignId} has no codex entity "${ref}". Call get_codex for the list.`);
  return row;
}

export function entityRelations(db: Db, entity: EntityRow): EntityRelation[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.type, r.notes, r.from_id, e.id AS other_id, e.name AS other_name, e.kind AS other_kind
         FROM relationship r
         JOIN entity e ON e.id = CASE WHEN r.from_id = ? THEN r.to_id ELSE r.from_id END
        WHERE (r.from_id = ? OR r.to_id = ?) AND r.active = 1
        ORDER BY r.id`,
    )
    .all(entity.id, entity.id, entity.id) as Array<{
    id: number;
    type: RelationshipType;
    notes: string;
    from_id: number;
    other_id: number;
    other_name: string;
    other_kind: EntityKind;
  }>;
  return rows.map((row) => {
    const out = row.from_id === entity.id;
    return {
      id: row.id,
      type: row.type,
      as: out ? row.type : INVERSE[row.type],
      direction: out ? 'out' : 'in',
      entity: { id: row.other_id, name: row.other_name, kind: row.other_kind },
      notes: row.notes,
    };
  });
}

function view(db: Db, row: EntityRow, includeHidden: boolean): EntityView {
  const result: EntityView = {
    id: row.id,
    campaign_id: row.campaign_id,
    kind: row.kind,
    name: row.name,
    summary: row.summary,
    notes: row.notes,
    voice: parseVoice(row.voice_json),
    portrait_path: row.portrait_path,
    status: row.status,
    first_seen_chapter_id: row.first_seen_chapter_id,
    character_id: row.character_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    relations: entityRelations(db, row),
  };
  if (includeHidden) result.hidden_notes = row.hidden_notes;
  return result;
}

/** A named individual's portrait, reused when one already exists and drawn in the background when not. */
function scheduleEntityPortrait(db: Db, row: EntityRow): void {
  const existing = individualPortraitPath(db, row.campaign_id, row.name);
  if (existing) {
    db.prepare('UPDATE entity SET portrait_path = ? WHERE id = ?').run(existing, row.id);
    return;
  }
  if (!portraitsEnabled() || !getSettings(db, row.campaign_id).auto_portraits) return;
  void generatePortrait({
    db,
    campaign_id: row.campaign_id,
    subject: { creature: row.name, kind: 'individual' },
    description: row.summary.slice(0, DESCRIPTION_LIMIT),
  })
    .then((portrait) => {
      db.prepare('UPDATE entity SET portrait_path = ? WHERE id = ?').run(portrait.path, row.id);
    })
    .catch((err: Error) => {
      console.error(new Date().toISOString(), `portrait for entity ${row.name} failed: ${err.message}`);
    });
}

function activeFacts(db: Db, campaignId: number, subject: string): string[] {
  return (
    db
      .prepare('SELECT fact FROM canon_fact WHERE campaign_id = ? AND active = 1 AND lower(subject) = lower(?)')
      .all(campaignId, subject) as Array<{ fact: string }>
  ).map((row) => row.fact);
}

/**
 * Warnings, never refusals: text that restates what is already written, and a status that fights with
 * an active canon fact about the same subject. Each field is judged on its own, so a restated summary
 * never costs the notes their append.
 */
function guard(
  db: Db,
  input: UpsertEntityInput,
  existing: EntityRow | undefined,
): { warnings: string[]; duplicateNotes: boolean } {
  const warnings: string[] = [];
  const facts = activeFacts(db, input.campaign_id, input.name);
  const oldNotes = [existing?.notes ?? ''].filter((text) => text.trim().length > 0);
  const restates = (text: string | undefined, against: string[]): boolean =>
    !!text && text.trim().length > 0 && against.some((old) => overlaps(tokens(text), old));

  const duplicateNotes = restates(input.notes, [...oldNotes, ...facts]);
  if (duplicateNotes) warnings.push('near-duplicate of existing notes');
  if (restates(input.summary, facts)) warnings.push('summary restates an existing canon fact');
  else if (restates(input.summary, oldNotes)) warnings.push('summary restates the existing notes');
  if (input.status && existing && input.status !== existing.status) {
    const pattern = input.status === 'dead' ? ALIVE_WORDS : input.status === 'alive' ? DEAD_WORDS : null;
    const clash = pattern ? facts.find((fact) => pattern.test(fact)) : undefined;
    if (clash) {
      warnings.push(`status ${existing.status} -> ${input.status} contradicts a canon fact: "${snippet(clash, 100)}"`);
    }
  }
  return { warnings, duplicateNotes };
}

export interface UpsertEntityInput {
  campaign_id: number;
  kind: EntityKind;
  name: string;
  summary?: string;
  notes?: string;
  hidden_notes?: string;
  status?: EntityStatus;
  voice?: VoiceCard;
}

export interface UpsertEntityResult {
  entity: EntityView;
  created: boolean;
  /** Consistency guard remarks; the write happened either way. */
  warnings: string[];
}

/** Creates the entity or merges into the one with that name: notes append, the rest are replaced. */
export function upsertEntity(db: Db, input: UpsertEntityInput): UpsertEntityResult {
  getCampaign(db, input.campaign_id);
  const existing = findEntity(db, input.campaign_id, input.name);
  const { warnings, duplicateNotes } = guard(db, input, existing);
  const ts = nowIso();
  let id: number;

  if (existing) {
    const voice = input.voice ? { ...(parseVoice(existing.voice_json) ?? {}), ...input.voice } : parseVoice(existing.voice_json);
    db.prepare(
      `UPDATE entity SET kind = ?, summary = ?, notes = ?, hidden_notes = ?, voice_json = ?, status = ?,
         character_id = ?, updated_at = ? WHERE id = ?`,
    ).run(
      input.kind,
      input.summary?.trim() || existing.summary,
      duplicateNotes ? existing.notes : appendNote(existing.notes, input.notes ?? ''),
      appendNote(existing.hidden_notes, input.hidden_notes ?? ''),
      voice ? JSON.stringify(voice) : null,
      input.status ?? existing.status,
      existing.character_id ?? (input.kind === 'npc' ? matchingCharacterId(db, input.campaign_id, input.name) : null),
      ts,
      existing.id,
    );
    id = existing.id;
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'entity',
      text: `Codex: ${input.name} updated.`,
      payload: { entity_id: id, kind: input.kind, name: input.name },
    });
  } else {
    id = Number(
      db
        .prepare(
          `INSERT INTO entity (campaign_id, kind, name, summary, notes, hidden_notes, voice_json, status,
             first_seen_chapter_id, character_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.campaign_id,
          input.kind,
          input.name,
          input.summary?.trim() ?? '',
          input.notes?.trim() ?? '',
          input.hidden_notes?.trim() ?? '',
          input.voice ? JSON.stringify(input.voice) : null,
          input.status ?? (input.kind === 'npc' ? 'alive' : 'unknown'),
          openChapterId(db, input.campaign_id),
          input.kind === 'npc' ? matchingCharacterId(db, input.campaign_id, input.name) : null,
          ts,
          ts,
        ).lastInsertRowid,
    );
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'entity',
      text: `Codex: added ${input.kind} ${input.name}.`,
      payload: { entity_id: id, kind: input.kind, name: input.name },
    });
  }

  const row = db.prepare('SELECT * FROM entity WHERE id = ?').get(id) as EntityRow;
  if (row.kind === 'npc' && row.portrait_path === null) scheduleEntityPortrait(db, row);
  else if ((row.kind === 'faction' || row.kind === 'deity') && row.portrait_path === null) scheduleEntityEmblem(db, row);
  return {
    entity: view(db, db.prepare('SELECT * FROM entity WHERE id = ?').get(id) as EntityRow, true),
    created: !existing,
    warnings,
  };
}

export interface LinkEntitiesInput {
  campaign_id: number;
  from: EntityRef;
  to: EntityRef;
  type: RelationshipType;
  notes?: string;
}

/**
 * One row per edge; a symmetric type is not stored twice because both ends read the same row, and
 * neither is a tie sent as the inverse of one already there (child B->A is the stored parent A->B).
 */
export function linkEntities(db: Db, input: LinkEntitiesInput) {
  const campaign = getCampaign(db, input.campaign_id);
  const from = requireEntity(db, input.campaign_id, input.from);
  const to = requireEntity(db, input.campaign_id, input.to);
  if (from.id === to.id) throw new Error('An entity cannot be linked to itself.');

  const mirrored = SYMMETRIC.has(input.type);
  const inverse = INVERSE_TYPE[input.type] ?? null;
  const existing = db
    .prepare(
      `SELECT id FROM relationship
        WHERE campaign_id = ? AND active = 1
          AND ((type = ? AND from_id = ? AND to_id = ?)
            OR (? = 1 AND type = ? AND from_id = ? AND to_id = ?)
            OR (? IS NOT NULL AND type = ? AND from_id = ? AND to_id = ?))`,
    )
    .get(
      input.campaign_id,
      input.type,
      from.id,
      to.id,
      mirrored ? 1 : 0,
      input.type,
      to.id,
      from.id,
      inverse,
      inverse,
      to.id,
      from.id,
    ) as { id: number } | undefined;

  const id =
    existing?.id ??
    Number(
      db
        .prepare(
          `INSERT INTO relationship (campaign_id, from_id, to_id, type, notes, established_scene_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.campaign_id,
          from.id,
          to.id,
          input.type,
          input.notes?.trim() ?? '',
          campaign.current_scene_id,
          nowIso(),
        ).lastInsertRowid,
    );
  if (!existing) {
    logEvent(db, {
      campaign_id: input.campaign_id,
      kind: 'relationship',
      text: `Codex: ${from.name} ${input.type.replace('_', ' ')} ${to.name}.`,
      payload: { relationship_id: id, from: from.name, to: to.name, type: input.type },
    });
  }
  return {
    id,
    type: input.type,
    reads_back_as: INVERSE[input.type],
    from: { id: from.id, name: from.name },
    to: { id: to.id, name: to.name },
    created: !existing,
  };
}

/** The compact list: everything, or one kind, or a name/summary search. */
export function getCodex(
  db: Db,
  campaignId: number,
  opts: { kind?: EntityKind; query?: string } = {},
): { entities: CodexListItem[] } {
  getCampaign(db, campaignId);
  const where = ['campaign_id = ?'];
  const params: Array<string | number> = [campaignId];
  if (opts.kind) {
    where.push('kind = ?');
    params.push(opts.kind);
  }
  if (opts.query && opts.query.trim().length > 0) {
    where.push('(name LIKE ? OR summary LIKE ?)');
    params.push(`%${opts.query.trim()}%`, `%${opts.query.trim()}%`);
  }
  const rows = db
    .prepare(`SELECT * FROM entity WHERE ${where.join(' AND ')} ORDER BY kind, name COLLATE NOCASE`)
    .all(...params) as EntityRow[];
  return {
    entities: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      summary: row.summary,
      status: row.status,
      portrait_path: row.portrait_path,
      has_voice: parseVoice(row.voice_json) !== null,
    })),
  };
}

/** The full entry, relations resolved to names. Hidden notes only when the caller may see them. */
export function getEntity(
  db: Db,
  campaignId: number,
  ref: EntityRef,
  opts: { include_hidden?: boolean } = {},
): EntityView {
  return view(db, requireEntity(db, campaignId, ref), opts.include_hidden === true);
}

/** Merges the fields given into the voice card; an empty string clears one. */
export function setVoiceCard(db: Db, campaignId: number, ref: EntityRef, card: VoiceCard): EntityView {
  const row = requireEntity(db, campaignId, ref);
  const merged: Record<string, string> = { ...(parseVoice(row.voice_json) ?? {}) } as Record<string, string>;
  for (const [key, value] of Object.entries(card)) {
    if (value === undefined) continue;
    if (value.trim().length === 0) delete merged[key];
    else merged[key] = value.trim();
  }
  db.prepare('UPDATE entity SET voice_json = ?, updated_at = ? WHERE id = ?').run(
    Object.keys(merged).length > 0 ? JSON.stringify(merged) : null,
    nowIso(),
    row.id,
  );
  logEvent(db, {
    campaign_id: campaignId,
    kind: 'voice',
    text: `Codex: ${row.name} updated.`,
    payload: { entity_id: row.id, name: row.name },
  });
  return getEntity(db, campaignId, row.id, { include_hidden: true });
}

/** Family and faction ties around one entity, three edges deep, each entity visited once. */
export function entityTree(db: Db, campaignId: number, ref: EntityRef): TreeNode {
  const root = requireEntity(db, campaignId, ref);
  const seen = new Set<number>([root.id]);
  const expand = (row: EntityRow, relation: string | null, depth: number): TreeNode => {
    const node: TreeNode = { id: row.id, name: row.name, kind: row.kind, relation, links: [] };
    if (depth >= TREE_DEPTH) return node;
    for (const link of entityRelations(db, row)) {
      if (!TREE_TYPES.has(link.type) || seen.has(link.entity.id)) continue;
      seen.add(link.entity.id);
      const next = db.prepare('SELECT * FROM entity WHERE id = ?').get(link.entity.id) as EntityRow;
      node.links.push(expand(next, link.as, depth + 1));
    }
    return node;
  };
  return expand(root, null, 0);
}

function voiceLine(voice: VoiceCard): string {
  const parts = [
    voice.speech_pattern,
    voice.catchphrase ? `"${voice.catchphrase}"` : undefined,
    voice.goal ? `wants ${voice.goal}` : undefined,
    voice.fear ? `fears ${voice.fear}` : undefined,
    voice.attitude ? `attitude ${voice.attitude}` : undefined,
  ].filter((part): part is string => !!part && part.trim().length > 0);
  return parts.join(' | ');
}

/**
 * The briefing's codex block: whoever is in the scene with their voice cards, then an index of every
 * name by kind so the DM knows what already exists before inventing it again. Empty when the codex is.
 */
export function codexBriefing(db: Db, campaignId: number, opts: { present?: string[] } = {}): string {
  const rows = db
    .prepare('SELECT * FROM entity WHERE campaign_id = ? ORDER BY kind, name COLLATE NOCASE')
    .all(campaignId) as EntityRow[];
  if (rows.length === 0) return '';

  const wanted = new Set((opts.present ?? []).map((name) => name.trim().toLowerCase()));
  const present = rows.filter((row) => wanted.has(row.name.toLowerCase()));
  const lines = ['## Codex'];
  if (present.length > 0) {
    lines.push('Present:');
    for (const row of present) {
      const summary = row.summary.trim().length > 0 ? ` - ${snippet(row.summary, SUMMARY_LINE)}` : '';
      lines.push(`- ${row.name} (${row.kind}, ${row.status})${summary}`);
      const voice = parseVoice(row.voice_json);
      if (voice) {
        const line = voiceLine(voice);
        if (line) lines.push(`  voice: ${line}`);
      }
    }
  }
  for (const kind of ENTITY_KINDS) {
    const names = rows.filter((row) => row.kind === kind).map((row) => row.name);
    if (names.length > 0) lines.push(`Known ${kind}: ${names.join(', ')}`);
  }
  return lines.join('\n');
}
