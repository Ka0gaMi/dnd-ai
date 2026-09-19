import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { grantInspiration, spendInspiration } from '../../core/character.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';
import { CHARACTER_ID, WRITES } from './character-shared.js';

export function registerInspirationTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'inspiration', {
    title: 'Heroic Inspiration',
    description:
      'Heroic Inspiration is one reroll of any one d20 test, and the new roll must be taken. grant gives it to the character when the player does something clever, brave or true to who their character is - tell them they have it; it does not stack, so granting it twice changes nothing. spend is for when the player says they want to use it: call it, then roll again with the roll tool and use the new result. It refuses when they have none, so the reroll simply does not happen.',
    fields: {
      campaign_id: z.number().int(),
      character_id: CHARACTER_ID,
    },
    shared: ['character_id'],
    ops: {
      grant: {
        summary: 'Grant Heroic Inspiration for something clever, brave or in character',
        requires: [],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, grantInspiration(db, input));
        },
      },
      spend: {
        summary: 'Spend it on a reroll the player asked for',
        requires: [],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, spendInspiration(db, input));
        },
      },
    },
    annotations: { ...WRITES },
  });
}
