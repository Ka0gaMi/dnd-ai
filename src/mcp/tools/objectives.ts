import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { upsertQuests } from '../../core/campaign.js';
import { reply } from './result.js';

export const questInputSchema = z.object({
  id: z.number().int().optional().describe('Omit to create a new quest; pass the id from load_campaign to update one.'),
  title: z.string().min(1),
  kind: z.enum(['main', 'side', 'personal']).optional(),
  status: z.enum(['open', 'done', 'failed']).optional(),
  summary: z.string().optional(),
  steps: z
    .array(
      z.object({
        id: z.number().int().optional().describe('Omit to add a step; pass the id to tick an existing one.'),
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
        'Creates or updates quests and their steps - the objectives tracker the player sees. Use it whenever a goal appears, changes, is completed or fails: a new job offered, a step ticked off, a quest abandoned. Quests without an id are created, quests with an id are updated in place. Returns the full list of open quests afterwards.',
      inputSchema: {
        campaign_id: z.number().int(),
        quests: z.array(questInputSchema).min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ campaign_id, quests }) => reply(db, campaign_id, { open_quests: upsertQuests(db, campaign_id, quests) }),
  );
}
