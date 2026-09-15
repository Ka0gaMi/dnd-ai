import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { endSession, saveCheckpoint } from '../../core/campaign.js';
import { captureCheckpoint } from '../../core/rewind.js';
import { tagSceneChapter } from '../../core/story.js';
import { questInputSchema } from './objectives.js';
import { reply } from './result.js';

export function registerCheckpointTools(server: McpServer, db: Db): void {
  server.registerTool(
    'save_checkpoint',
    {
      title: 'Save checkpoint',
      description:
        'Closes the current scene with a summary and writes any new canon facts, quest updates and glossary entries in one call, then regenerates the session recap. Call it after every finished scene, before the player takes a break, and before end_session - this is what lets a later chat resume the story. The summary should be 2-5 sentences covering what happened, what changed and where the party is now. A new scene is opened automatically for what comes next.',
      inputSchema: {
        campaign_id: z.number().int(),
        scene_title: z.string().optional().describe('Short name for the scene being closed.'),
        scene_summary: z.string().min(1).describe('What happened in this scene, 2-5 sentences.'),
        canon_facts: z
          .array(z.object({ subject: z.string().min(1), fact: z.string().min(1) }))
          .optional()
          .describe(
            'Durable world facts this scene established that a future session must not contradict - names, places, relationships, deaths, oaths, secrets revealed, lore. Not what happened: the beats belong in scene_summary. One or two at most; when a known fact changed, use add_canon_fact with supersedes_id instead of restating it here.',
          ),
        quest_updates: z.array(questInputSchema).optional(),
        glossary: z
          .array(z.object({ term: z.string().min(1), definition: z.string().min(1) }))
          .optional()
          .describe('New campaign terms, places or factions worth remembering.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => {
      const result = saveCheckpoint(db, args);
      // The scene belongs to the chapter that was open while it was played.
      const chapterId = tagSceneChapter(db, args.campaign_id, result.scene.id);
      // The snapshot is taken after the scene closed, so a rewind lands on the state just saved.
      captureCheckpoint(db, args.campaign_id, result.scene.id);
      return reply(db, args.campaign_id, { ...result, chapter_id: chapterId });
    },
  );

  server.registerTool(
    'end_session',
    {
      title: 'End session',
      description:
        'Closes the current play session, writing the final recap that the next chat will read first. Call it when the player says they are stopping for now, after a last save_checkpoint. Pass recap_override only if the player asks for a specific wording; otherwise the recap is built from the session scene summaries. The next load_campaign starts a fresh session automatically.',
      inputSchema: {
        campaign_id: z.number().int(),
        recap_override: z.string().optional().describe('Replaces the generated recap when supplied.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, endSession(db, args)),
  );
}
