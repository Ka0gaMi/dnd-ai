import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { upsertQuests } from '../../core/campaign.js';
import { CAMPAIGN_ID } from './fields.js';
import { reply } from './result.js';

export const questInputSchema = z.object({
  id: z.number().int().optional().describe('Omit to create a quest; pass its id from load_campaign to update it.'),
  title: z.string().min(1),
  kind: z.enum(['main', 'side', 'personal']).optional(),
  status: z.enum(['open', 'done', 'failed']).optional(),
  summary: z.string().optional(),
  steps: z
    .array(
      z.object({
        id: z.number().int().optional().describe('Omit to add a step; pass its id to tick it.'),
        text: z.string().min(1),
        done: z.boolean().optional(),
      }),
    )
    .optional(),
});

export function registerObjectiveTools(server: McpServer, db: Db): void {
  server.registerTool(
    'update_objectives',
    {
      title: 'Update objectives',
      description:
        'Creates or updates quests and their steps - the objectives tracker the player sees. Call it whenever a goal appears, changes, completes or fails. A quest without an id is created, one with an id is updated in place. Returns the open quests.',
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        quests: z.array(questInputSchema).min(1),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ campaign_id, quests }) => reply(db, campaign_id, { open_quests: upsertQuests(db, campaign_id, quests) }),
  );
}
