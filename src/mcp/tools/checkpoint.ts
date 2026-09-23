import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { endSession, saveCheckpoint } from '../../core/campaign.js';
import { captureCheckpoint } from '../../core/rewind.js';
import { tagSceneChapter } from '../../core/story.js';
import { questInputSchema } from './objectives.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';

export function registerCheckpointTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'checkpoint', {
    title: 'Checkpoints and the end of a session',
    description:
      'Closes the current scene with a summary and writes any new canon facts, quest updates and glossary entries in one call, then regenerates the session recap; op=end_session closes the play session itself, writing the final recap the next chat will read first. Call op=save after every finished scene, before the player takes a break, and before op=end_session - this is what lets a later chat resume the story, and once 25 events have passed since the last checkpoint the server appends a reminder to save. The summary should be 2-5 sentences covering what happened, what changed and where the party is now, and it becomes the recap line for the scene; the session recap is built from the scene summaries of the session just played, not the chapter, so write the scene and not the wider arc. A save bundles the durable world facts (canon_facts), the quest updates and the new glossary terms for that scene, and it is also the point the player\'s own rewind restores to. A new scene is opened automatically for what comes next. Call op=end_session when the player says they are stopping for now, after a last op=save: it closes the session and writes the recap, then the next load_campaign starts a fresh session automatically, so tell the player to open a fresh chat. Pass recap_override only if the player asks for a specific wording; otherwise the recap is built from the session scene summaries.',
    fields: {
      campaign_id: z.number().int(),
      scene_title: z.string().optional().describe('(op=save) Short name for the scene being closed.'),
      scene_location: z
        .string()
        .optional()
        .describe(
          '(op=save) Where the party is when this scene ends: use a place name from the region map when the campaign has one. The next scene starts there.',
        ),
      scene_summary: z.string().min(1).optional().describe('(op=save) What happened in this scene, 2-5 sentences.'),
      canon_facts: z
        .array(z.object({ subject: z.string().min(1), fact: z.string().min(1) }))
        .optional()
        .describe(
          '(op=save) Durable world facts this scene established that a future session must not contradict - names, places, relationships, deaths, oaths, secrets revealed, lore. Not what happened: the beats belong in scene_summary. One or two at most; when a known fact changed, use remember {op: fact} with supersedes_id instead of restating it here.',
        ),
      quest_updates: z.array(questInputSchema).optional().describe('(op=save) Quests this scene opened, advanced or closed.'),
      glossary: z
        .array(z.object({ term: z.string().min(1), definition: z.string().min(1) }))
        .optional()
        .describe('(op=save) New campaign terms, places or factions worth remembering.'),
      recap_override: z
        .string()
        .optional()
        .describe('(op=end_session) Replaces the generated recap when supplied.'),
    },
    ops: {
      save: {
        summary: 'Close the current scene and write its facts, quest updates and glossary',
        requires: ['scene_summary'],
        uses: ['scene_title', 'scene_location', 'canon_facts', 'quest_updates', 'glossary'],
        run: (args) => {
          const { op, ...input } = args;
          const result = saveCheckpoint(db, {
            campaign_id: input.campaign_id,
            scene_title: input.scene_title,
            scene_location: input.scene_location,
            scene_summary: input.scene_summary!,
            canon_facts: input.canon_facts,
            quest_updates: input.quest_updates,
            glossary: input.glossary,
          });
          // The scene belongs to the chapter that was open while it was played.
          const chapterId = tagSceneChapter(db, input.campaign_id, result.scene.id);
          // The snapshot is taken after the scene closed, so a rewind lands on the state just saved.
          captureCheckpoint(db, input.campaign_id, result.scene.id);
          return reply(db, input.campaign_id, { ...result, chapter_id: chapterId });
        },
      },
      end_session: {
        summary: 'Close the play session and write the final recap',
        requires: [],
        uses: ['recap_override'],
        run: (args) => {
          const { op, ...input } = args;
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
