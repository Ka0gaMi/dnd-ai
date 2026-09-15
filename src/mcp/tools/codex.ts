import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import {
  entityTree,
  getCodex,
  getEntity,
  linkEntities,
  setVoiceCard,
  upsertEntity,
  type EntityRef,
} from '../../core/codex.js';
import { reply } from './result.js';

const kindSchema = z.enum(['npc', 'faction', 'place', 'item', 'deity', 'event']);
const statusSchema = z.enum(['alive', 'dead', 'unknown']);
const refSchema = z.union([z.number().int(), z.string().min(1)]).describe('The entity id, or its name.');
const voiceSchema = {
  speech_pattern: z.string().optional().describe('How they talk: rhythm, vocabulary, accent in words not spelling.'),
  catchphrase: z.string().optional().describe('A line they actually say.'),
  goal: z.string().optional().describe('What they want in this story.'),
  fear: z.string().optional().describe('What they will not risk.'),
  attitude: z.string().optional().describe('How they treat the party right now.'),
};

/** `id` wins when both are given, so a tool call is never ambiguous. */
function ref(args: { id?: number; name?: string }): EntityRef {
  if (args.id !== undefined) return args.id;
  if (args.name !== undefined) return args.name;
  throw new Error('Pass id or name.');
}

export function registerCodexTools(server: McpServer, db: Db): void {
  server.registerTool(
    'upsert_entity',
    {
      title: 'Add or update a codex entry',
      description:
        'Records someone or something the story has named: an NPC, a faction, a place, an item, a deity or an event. Call it the first time a named NPC, faction or place matters - the moment you expect to mention it again - and again whenever you learn more about it. Matching is by name, so sending the same name merges: notes are appended, summary and status replaced. hidden_notes are yours alone and never reach the player unless they turn secrets on. The consistency guard answers with warnings when the text restates what is already written or the status fights an active canon fact; nothing is ever blocked.',
      inputSchema: {
        campaign_id: z.number().int(),
        kind: kindSchema,
        name: z.string().min(1).describe('The name as the player hears it; it is the identity of the entry.'),
        summary: z.string().optional().describe('One line: who or what this is.'),
        notes: z.string().optional().describe('What is known about them, appended to what is already there.'),
        hidden_notes: z.string().optional().describe('DM-only truth: secrets, plans, what they are really after.'),
        status: statusSchema.optional(),
        voice: z.object(voiceSchema).optional().describe('The voice card; set it for any recurring NPC.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, upsertEntity(db, args) as unknown as Record<string, unknown>),
  );

  server.registerTool(
    'link_entities',
    {
      title: 'Link two codex entries',
      description:
        'Records a relationship between two entries as it is revealed: family (parent, child, spouse, sibling), standing (ally, enemy, rival, lover, knows) or belonging (member_of, owns, rules, serves). Both entries must exist already - call upsert_entity first. Symmetric ties are stored once and read from both ends, so link spouses or allies one way only. Direction matters for the rest: from is the parent, the member, the owner, the ruler, the servant.',
      inputSchema: {
        campaign_id: z.number().int(),
        from: refSchema,
        to: refSchema,
        type: z.enum([
          'parent',
          'child',
          'spouse',
          'sibling',
          'ally',
          'enemy',
          'member_of',
          'owns',
          'rules',
          'serves',
          'knows',
          'rival',
          'lover',
        ]),
        notes: z.string().optional().describe('How it stands, e.g. "estranged since the fire".'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, linkEntities(db, args) as unknown as Record<string, unknown>),
  );

  server.registerTool(
    'get_codex',
    {
      title: 'List codex entries',
      description:
        'The compact index of everything the codex holds: id, kind, name, one-line summary, status. Use it before inventing a name to check whether it already exists, or to find the id of an entry. Filter by kind or search names and summaries with query.',
      inputSchema: {
        campaign_id: z.number().int(),
        kind: kindSchema.optional(),
        query: z.string().optional().describe('Substring matched against names and summaries.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, getCodex(db, args.campaign_id, args)),
  );

  server.registerTool(
    'get_entity',
    {
      title: 'Read a codex entry',
      description:
        'The full entry: summary, notes, your hidden notes, voice card, portrait, status and every relationship resolved to names. Call it before writing dialogue for an NPC the player has met, so they sound like themselves and remember what they know.',
      inputSchema: {
        campaign_id: z.number().int(),
        id: z.number().int().optional(),
        name: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      reply(db, args.campaign_id, getEntity(db, args.campaign_id, ref(args), {
        include_hidden: true,
      }) as unknown as Record<string, unknown>),
  );

  server.registerTool(
    'set_voice_card',
    {
      title: 'Set an NPC voice card',
      description:
        'Pins down how a recurring NPC sounds and what drives them: speech pattern, catchphrase, goal, fear, attitude. Set one for anyone the player will speak to twice; the card comes back in every briefing while they are in the scene. Fields given are merged into the card, an empty string clears one.',
      inputSchema: {
        campaign_id: z.number().int(),
        id: z.number().int().optional(),
        name: z.string().optional(),
        ...voiceSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ campaign_id, id, name, ...card }) =>
      reply(db, campaign_id, setVoiceCard(db, campaign_id, ref({ id, name }), card) as unknown as Record<
        string,
        unknown
      >),
  );

  server.registerTool(
    'entity_tree',
    {
      title: 'Entity tree',
      description:
        'The family or faction tree around one entry, three links deep: parents, children, spouses, siblings and membership. Use it when a bloodline, a household or a faction hierarchy is about to matter in a scene.',
      inputSchema: {
        campaign_id: z.number().int(),
        id: z.number().int().optional(),
        name: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      reply(db, args.campaign_id, {
        tree: entityTree(db, args.campaign_id, ref(args)),
      } as unknown as Record<string, unknown>),
  );
}
