import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { addLanguage, grantLanguage } from '../../core/character.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';
import { WRITES } from './character-shared.js';
import { CAMPAIGN_ID, CHARACTER_ID } from './fields.js';

export function registerLanguageTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'language', {
    title: 'Languages',
    description:
      'Languages. op=define invents a tongue for this world, with who speaks it and its script; it joins the SRD languages wherever one is chosen or granted, and the glossary. op=teach adds a language to a sheet when the story earns it (a tutor, a year abroad, a spell) - not to paper over a failed conversation: a character who does not know a language gets no roll at all.',
    fields: {
      campaign_id: CAMPAIGN_ID,
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
