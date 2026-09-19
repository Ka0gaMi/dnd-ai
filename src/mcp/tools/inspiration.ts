import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { grantInspiration, spendInspiration } from '../../core/character.js';
import { reply } from './result.js';
import { CHARACTER_ID, WRITES } from './character-shared.js';

export function registerInspirationTools(server: McpServer, db: Db): void {
  server.registerTool(
    'grant_inspiration',
    {
      title: 'Grant Heroic Inspiration',
      description:
        'Gives the character Heroic Inspiration. Award it when the player does something clever, brave or true to who their character is, and tell them they have it: they can spend it to reroll any one d20 test and must take the new roll. It does not stack - you either have it or you do not - so granting it twice changes nothing.',
      inputSchema: { campaign_id: z.number().int(), character_id: CHARACTER_ID },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, grantInspiration(db, input)),
  );

  server.registerTool(
    'spend_inspiration',
    {
      title: 'Spend Heroic Inspiration',
      description:
        'Spends the character\'s Heroic Inspiration on a reroll. Call it when the player says they want to use it, then roll again with the roll tool and use the new result. The tool refuses when they have none, which means the reroll simply does not happen.',
      inputSchema: { campaign_id: z.number().int(), character_id: CHARACTER_ID },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, spendInspiration(db, input)),
  );
}
