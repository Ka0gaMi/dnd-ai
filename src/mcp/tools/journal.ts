import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { addCanonFact, addGlossaryEntry, logEvent } from '../../core/campaign.js';
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

  server.registerTool(
    'add_canon_fact',
    {
      title: 'Add canon fact',
      description:
        'Records one durable world fact a future session must not contradict: a name, a place, a relationship, a death, an oath, a secret revealed, a piece of established lore. It is not a diary: what happened in a scene belongs in log_event or the checkpoint summary, so do not record moves, rolls, plans or anything that was only true for a moment. One or two facts per scene is plenty. When something you already recorded changes, pass supersedes_id with the old fact\'s id instead of adding a near-duplicate; the old one is deactivated, not deleted. The server refuses a restatement of an active fact on the same subject and answers with duplicate_of instead. Active facts are included in every load_campaign briefing.',
      inputSchema: {
        campaign_id: z.number().int(),
        subject: z.string().min(1).describe('Who or what the fact is about, e.g. "Mira", "Ashfall Keep".'),
        fact: z.string().min(1).describe('The durable fact itself, one sentence, still true next session.'),
        supersedes_id: z.number().int().optional().describe('Id of the canon fact this one replaces.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, addCanonFact(db, args) as Record<string, unknown>),
  );

  server.registerTool(
    'add_glossary_entry',
    {
      title: 'Add glossary entry',
      description:
        'Adds or updates a campaign glossary entry - an invented term, place, faction, deity or piece of slang - so the player can look it up and you stay consistent. Use it when you introduce a proper noun that will come back. Re-sending an existing term overwrites its definition. Rules terms from the SRD do not belong here.',
      inputSchema: {
        campaign_id: z.number().int(),
        term: z.string().min(1),
        definition: z.string().min(1).describe('One or two sentences.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, addGlossaryEntry(db, args)),
  );
}
