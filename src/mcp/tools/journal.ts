import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { addCanonFact, addGlossaryEntry, logEvent } from '../../core/campaign.js';
import { CAMPAIGN_ID } from './fields.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';

export function registerJournalTools(server: McpServer, db: Db): void {
  server.registerTool(
    'log_event',
    {
      title: 'Log event',
      description:
        "Appends one past-tense sentence to the event log, the story's append-only ground truth: a beat, a player decision, travel, loot, XP. Put numbers in payload. roll logs dice results itself; do not log them here.",
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        kind: z.enum(['narration', 'action', 'travel', 'loot', 'xp', 'system']),
        text: z.string().min(1).describe('One past-tense sentence.'),
        payload: z.record(z.string(), z.unknown()).optional().describe('Structured detail, e.g. {"xp": 150}.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, logEvent(db, args)),
  );

  registerOpTool(server, 'remember', {
    title: 'Canon facts and glossary terms',
    description:
      "Canon facts and glossary terms. op=fact records one durable world fact a later session must not contradict: a name, place, relationship, death, oath, revealed secret or lore. It is not a diary: play-by-play and what happened in a scene belong in log_event or the checkpoint summary, and one or two facts a scene is plenty. When a recorded fact changes, pass supersedes_id with the old fact's id instead of a near-duplicate; the old one is deactivated. A restatement of an active fact on the same subject is refused with duplicate_of. Active facts and glossary terms are in every briefing. op=term adds a glossary entry for a proper noun you invented that will come back, or overwrites its definition; SRD rules terms do not belong there.",
    fields: {
      campaign_id: CAMPAIGN_ID,
      subject: z
        .string()
        .min(1)
        .optional()
        .describe('(op=fact) Who or what it is about, e.g. "Mira", "Ashfall Keep".'),
      fact: z
        .string()
        .min(1)
        .optional()
        .describe('(op=fact) The fact, one sentence, still true next session.'),
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
