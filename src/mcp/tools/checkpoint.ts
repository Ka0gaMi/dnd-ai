import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import {
  addCanonFact,
  endSession,
  getCampaign,
  logEvent,
  saveCheckpoint,
  upsertQuests,
  type EventKind,
  type QuestInput,
} from '../../core/campaign.js';
import { factContradiction, lifeClaim } from '../../core/canon-guards.js';
import { addPlayNote, PLAY_TAGS } from '../../core/progression.js';
import { captureCheckpoint } from '../../core/rewind.js';
import { tagSceneChapter } from '../../core/story.js';
import { CAMPAIGN_ID, CHARACTER_ID } from './fields.js';
import { questInputSchema } from './objectives.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';

/** The kinds log_event takes. */
const EVENT_KINDS = ['narration', 'action', 'travel', 'loot', 'xp', 'system'] as const satisfies readonly EventKind[];

const NEXT_STEP = 'Play on in the new scene; call load_campaign only if you need the full state.';
const NEXT_STEP_SKIPPED =
  'A fact restated a known one and was skipped; to change that fact, pass its id as supersedes_id.';
const RENAMED =
  'canon_facts was renamed to facts and quest_updates to objectives - the dnd-ai tools changed; reconnect the dnd-ai server (new chat, or /mcp then Reconnect) and send the save again. Nothing was saved.';

/** The refusal for a stale host's pre-rename fields, whichever op they came with. */
const renamedFields = (input: { canon_facts?: unknown; quest_updates?: unknown }): CallToolResult | undefined =>
  input.canon_facts !== undefined || input.quest_updates !== undefined
    ? { isError: true, content: [{ type: 'text', text: RENAMED }] }
    : undefined;

interface SaveParts {
  facts?: Array<{ subject: string; fact: string; supersedes_id?: number }>;
  objectives?: QuestInput[];
  note?: { character_id?: number };
}

/** Every id the parts name must exist in this campaign, so a refused save is found before anything is written. */
function unknownIds(db: Db, campaignId: number, parts: SaveParts): string[] {
  const problems: string[] = [];
  const has = (sql: string, ...params: number[]): boolean => db.prepare(sql).get(...params) !== undefined;
  const superseding = new Map<number, number>();
  (parts.facts ?? []).forEach((fact, i) => {
    const id = fact.supersedes_id;
    if (id === undefined) return;
    const first = superseding.get(id);
    if (first !== undefined) {
      problems.push(`facts[${i}].supersedes_id ${id} is already replaced by facts[${first}] (merge the two into one fact)`);
      return;
    }
    superseding.set(id, i);
    if (!has('SELECT 1 FROM canon_fact WHERE id = ? AND campaign_id = ? AND active = 1', id, campaignId)) {
      problems.push(`facts[${i}].supersedes_id ${id} is not an active canon fact here (use an id from load_campaign)`);
    }
  });
  (parts.objectives ?? []).forEach((quest, i) => {
    if (quest.id !== undefined && !has('SELECT 1 FROM quest WHERE id = ? AND campaign_id = ?', quest.id, campaignId)) {
      problems.push(
        `objectives[${i}].id ${quest.id} is not a quest here (use an id from load_campaign, or leave id out to create one)`,
      );
      return;
    }
    (quest.steps ?? []).forEach((step, j) => {
      if (step.id === undefined) return;
      if (quest.id === undefined || !has('SELECT 1 FROM quest_step WHERE id = ? AND quest_id = ?', step.id, quest.id)) {
        problems.push(
          `objectives[${i}].steps[${j}].id ${step.id} is not a step of that quest (leave id out to add a step)`,
        );
      }
    });
  });
  const characterId = parts.note?.character_id;
  if (characterId === undefined) return problems;
  if (!has('SELECT 1 FROM character WHERE id = ? AND campaign_id = ?', characterId, campaignId)) {
    problems.push(`note.character_id ${characterId} is not a character here (leave it out for the player character)`);
  }
  return problems;
}

/** Facts that say the opposite of an active fact or of an earlier fact in the save, found before anything is written. */
function contradictions(db: Db, campaignId: number, facts: NonNullable<SaveParts['facts']>): string[] {
  const problems: string[] = [];
  const claims = facts.map((fact) => lifeClaim(fact.fact));
  const retired = new Set<number>();
  facts.forEach((fact, i) => {
    const subject = fact.subject.toLowerCase();
    const earlier =
      fact.supersedes_id === undefined && claims[i] !== null
        ? facts.findIndex(
            (other, j) => j < i && other.subject.toLowerCase() === subject && claims[j] !== null && claims[j] !== claims[i],
          )
        : -1;
    const clash = factContradiction(db, campaignId, fact, retired);
    if (earlier >= 0) problems.push(`facts[${i}] contradicts facts[${earlier}] on ${fact.subject} (merge the two into one fact)`);
    else if (clash) problems.push(`facts[${i}] ${clash}`);
    if (fact.supersedes_id !== undefined) retired.add(fact.supersedes_id);
  });
  return problems;
}

export function registerCheckpointTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'checkpoint', {
    title: 'Checkpoints and the end of a session',
    description:
      "Ends a scene in one call. op=save closes the current scene with its summary, writes the scene's facts, events, objectives, glossary terms and play note under one snapshot, and opens the next scene. Put everything the scene still owes here rather than in separate remember, log_event, update_objectives and note_play calls: the parts are checked together, and if any is refused nothing is written. Call op=save after every finished scene, before a break and before op=end_session - a later chat resumes from it and the player's rewind restores to it. The summary (2-5 sentences: what happened, what changed, where the party is) becomes the scene's recap line. op=end_session closes the play session after a last op=save and writes the recap the next chat reads first; tell the player to open a fresh chat.",
    fields: {
      campaign_id: CAMPAIGN_ID,
      scene_title: z.string().optional().describe('(op=save) Short name for the scene being closed.'),
      scene_location: z
        .string()
        .optional()
        .describe("(op=save) Where the party is as the scene ends, a region-map place name when there is one; the next scene starts there."),
      scene_summary: z.string().min(1).optional().describe('(op=save) What happened in this scene, 2-5 sentences.'),
      facts: z
        .array(
          z.object({
            subject: z.string().min(1),
            fact: z.string().min(1),
            supersedes_id: z.number().int().optional().describe('Id of the active canon fact this one replaces.'),
          }),
        )
        .optional()
        .describe(
          '(op=save) Durable facts a later session must not contradict, as remember {op: fact}, not beats. One or two at most; a near-duplicate is skipped and reported.',
        ),
      events: z
        .array(
          z.object({
            kind: z.enum(EVENT_KINDS),
            text: z.string().min(1).describe('One past-tense sentence.'),
            payload: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .optional()
        .describe('(op=save) Beats not logged yet, as log_event, oldest first.'),
      objectives: z
        .array(questInputSchema)
        .optional()
        .describe('(op=save) Quests this scene opened, advanced or closed, as update_objectives.'),
      glossary: z
        .array(z.object({ term: z.string().min(1), definition: z.string().min(1) }))
        .optional()
        .describe('(op=save) New campaign terms, places or factions worth remembering.'),
      note: z
        .object({ character_id: CHARACTER_ID, tags: z.array(z.enum(PLAY_TAGS)).min(1), text: z.string() })
        .optional()
        .describe('(op=save) One line on how the player solved something this scene, as note_play.'),
      // Old names kept only so a host with a stale tool list is refused instead of having them stripped silently.
      canon_facts: z.unknown().optional().describe('Renamed to facts; refused.'),
      quest_updates: z.unknown().optional().describe('Renamed to objectives; refused.'),
      recap_override: z
        .string()
        .optional()
        .describe('(op=end_session) Replaces the generated recap; only for wording the player asked for.'),
    },
    // Retired rather than in an op's uses, so nothing advertises them; each op refuses them itself.
    retired: ['canon_facts', 'quest_updates'],
    ops: {
      save: {
        summary: 'Close the scene and write its parts under one snapshot',
        requires: ['scene_summary'],
        uses: ['scene_title', 'scene_location', 'facts', 'events', 'objectives', 'glossary', 'note'],
        run: (args) => {
          const { op, ...input } = args;
          const stale = renamedFields(input);
          if (stale) return stale;
          const campaignId = input.campaign_id;
          getCampaign(db, campaignId);
          const problems = [...unknownIds(db, campaignId, input), ...contradictions(db, campaignId, input.facts ?? [])];
          if (problems.length > 0) {
            const fix = problems.length === 1 ? 'it' : 'them';
            const text = `Refused, nothing was saved: ${problems.join('; ')}. Fix ${fix} and re-call checkpoint {op: save}.`;
            return { isError: true, content: [{ type: 'text', text }] };
          }
          const done = db.transaction(() => {
            // The parts land before the save so they belong to the scene being closed, as separate calls would.
            for (const event of input.events ?? []) logEvent(db, { campaign_id: campaignId, ...event });
            const facts = (input.facts ?? []).map((fact) => ({
              subject: fact.subject,
              result: addCanonFact(db, { campaign_id: campaignId, ...fact }),
            }));
            if (input.objectives?.length) upsertQuests(db, campaignId, input.objectives);
            if (input.note) addPlayNote(db, { campaign_id: campaignId, ...input.note });
            const saved = saveCheckpoint(db, {
              campaign_id: campaignId,
              scene_title: input.scene_title,
              scene_location: input.scene_location,
              scene_summary: input.scene_summary!,
              glossary: input.glossary,
            });
            // The scene belongs to the chapter that was open while it was played.
            const chapterId = tagSceneChapter(db, campaignId, saved.scene.id);
            // The snapshot is taken after the scene closed, so a rewind lands on the state just saved.
            const checkpointId = captureCheckpoint(db, campaignId, saved.scene.id);
            return { saved, facts, chapterId, checkpointId };
          })();
          const skipped = done.facts
            .filter(({ result }) => result.duplicate_of !== undefined)
            .map(({ subject, result }) => ({ subject, duplicate_of: result.duplicate_of }));
          const { scene, session } = done.saved;
          return reply(db, campaignId, {
            campaign_id: campaignId,
            checkpoint_id: done.checkpointId,
            scene: { id: scene.id, title: scene.title, location: scene.location },
            chapter_id: done.chapterId,
            session: { id: session.id, number: session.number },
            applied: {
              facts: done.facts.length - skipped.length,
              events: input.events?.length ?? 0,
              objectives: input.objectives?.length ?? 0,
              glossary: done.saved.glossary_added,
              note: input.note ? 1 : 0,
            },
            ...(skipped.length > 0 ? { facts_skipped: skipped } : {}),
            open_quests: done.saved.open_quests.length,
            next_step: skipped.length > 0 ? NEXT_STEP_SKIPPED : NEXT_STEP,
          });
        },
      },
      end_session: {
        summary: 'Close the play session and write the final recap',
        requires: [],
        uses: ['recap_override'],
        run: (args) => {
          const { op, ...input } = args;
          const stale = renamedFields(input);
          if (stale) return stale;
          return reply(
            db,
            input.campaign_id,
            endSession(db, { campaign_id: input.campaign_id, recap_override: input.recap_override }),
          );
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  });
}
