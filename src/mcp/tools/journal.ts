import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { addCanonFact, addGlossaryEntry, logEvent } from '../../core/campaign.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';

export function registerJournalTools(server: McpServer, db: Db): void {
  server.registerTool(
    'log_event',
    {
      title: 'Log event',
      description:
        'Appends one line to the campaign event log, the append-only ground truth of the story. Use it for anything worth remembering between checkpoints: a beat you narrated, a decision the player made, travel, loot gained, XP awarded. Keep the text to a single sentence in past tense; put numbers in payload. Dice results are logged automatically by the roll tool, so do not log them here.',
      inputSchema: {
        campaign_id: z.number().int(),
        kind: z.enum(['narration', 'action', 'travel', 'loot', 'xp', 'system']),
        text: z.string().min(1).describe('One past-tense sentence.'),
        payload: z.record(z.string(), z.unknown()).optional().describe('Structured detail, e.g. {"xp": 150}.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, logEvent(db, args)),
  );

  registerOpTool(server, 'remember', {
    title: 'Canon facts and glossary terms',
    description:
      'Records one durable world fact a future session must not contradict - a name, a place, a relationship, a death, an oath, a secret revealed, a piece of established lore - and adds or updates a campaign glossary entry for an invented term, place, faction, deity or piece of slang. A fact is not a diary: play-by-play belongs in log_event, and what happened in a scene belongs in log_event or the checkpoint summary, so do not record moves, rolls, plans or anything that was only true for a moment, and one or two facts per scene is plenty. When something you already recorded changes, pass supersedes_id with the old fact\'s id instead of adding a near-duplicate; the old one is deactivated, not deleted. The server refuses a restatement of an active fact on the same subject and answers with duplicate_of instead. Active facts are included in every load_campaign briefing, and the briefing lists the glossary terms. Use op=term when you introduce a proper noun that will come back; re-sending an existing term overwrites its definition, and rules terms from the SRD do not belong there.',
    fields: {
      campaign_id: z.number().int(),
      subject: z
        .string()
        .min(1)
        .optional()
        .describe('(op=fact) Who or what the fact is about, e.g. "Mira", "Ashfall Keep".'),
      fact: z
        .string()
        .min(1)
        .optional()
        .describe('(op=fact) The durable fact itself, one sentence, still true next session.'),
      supersedes_id: z.number().int().optional().describe('(op=fact) Id of the canon fact this one replaces.'),
      term: z
        .string()
        .min(1)
        .optional()
        .describe('(op=term) The invented term, place, faction, deity or piece of slang.'),
      definition: z.string().min(1).optional().describe('(op=term) One or two sentences.'),
    },
    ops: {
      fact: {
        summary: 'Record one durable world fact a future session must not contradict',
        requires: ['subject', 'fact'],
        uses: ['supersedes_id'],
        run: (args) => {
          const { op, ...input } = args;
          const result = addCanonFact(db, {
            campaign_id: input.campaign_id,
            subject: input.subject!,
            fact: input.fact!,
            supersedes_id: input.supersedes_id,
          });
          return reply(db, input.campaign_id, result as Record<string, unknown>);
        },
      },
      term: {
        summary: 'Add or update a campaign glossary entry',
        requires: ['term', 'definition'],
        run: (args) => {
          const { op, ...input } = args;
          const result = addGlossaryEntry(db, {
            campaign_id: input.campaign_id,
            term: input.term!,
            definition: input.definition!,
          });
          return reply(db, input.campaign_id, result);
        },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  });
}
