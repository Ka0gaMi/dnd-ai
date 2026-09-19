import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { addLanguage, grantLanguage } from '../../core/character.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';
import { CHARACTER_ID, WRITES } from './character-shared.js';

export function registerLanguageTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'language', {
    title: 'Languages',
    description:
      'Two ways a language enters play. define invents a tongue for this world: who speaks it and what it is written in; it joins the SRD languages wherever one is chosen or granted, and appears in the glossary so the rest of the story can use it. teach adds a language to a character sheet - a season with a tutor, a year in a foreign city, a spell or a boon - and is for when the story earns it, not to paper over a failed conversation: a character who does not know a language gets no roll at all.',
    fields: {
      campaign_id: z.number().int(),
      name: z.string().describe("The language's name."),
      character_id: CHARACTER_ID,
      speakers: z.string().optional().describe('(op=define) Who speaks it, e.g. "the drowned court and its servants".'),
      script: z.string().optional().describe('(op=define) What it is written in, if anything.'),
    },
    ops: {
      define: {
        summary: 'Invent a language for this world',
        requires: ['speakers'],
        uses: ['script'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, addLanguage(db, { ...input, speakers: input.speakers! }));
        },
      },
      teach: {
        summary: 'Teach a character a language',
        requires: [],
        uses: ['character_id'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, grantLanguage(db, input));
        },
      },
    },
    annotations: { ...WRITES },
  });
}
