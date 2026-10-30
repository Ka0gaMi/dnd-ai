import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { grantInspiration, spendInspiration } from '../../core/character.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';
import { WRITES } from './character-shared.js';
import { CAMPAIGN_ID, CHARACTER_ID } from './fields.js';

export function registerInspirationTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'inspiration', {
    title: 'Heroic Inspiration',
    description:
      'Heroic Inspiration: one reroll of a d20 test, and the new roll stands. op=grant when the player does something clever, brave or true to their character - tell them; it does not stack. op=spend when the player asks to use it, then roll again and use the new result; it refuses when they have none.',
    fields: {
      campaign_id: CAMPAIGN_ID,
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
