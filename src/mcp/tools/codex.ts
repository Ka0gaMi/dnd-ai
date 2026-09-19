import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import {
  getCodex,
  getEntity,
  linkEntities,
  setVoiceCard,
  upsertEntity,
  type EntityRef,
} from '../../core/codex.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';

const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

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
  registerOpTool(server, 'entity', {
    title: 'Codex entities',
    description:
      "Records and reads someone or something the story has named: an NPC, a faction, a place, an item, a deity or an event. upsert it the first time a named NPC, faction or place matters - the moment you expect to mention it again - and again whenever you learn more about it; matching is by name, so sending the same name merges, notes are appended, and summary and status replaced. hidden_notes are yours alone and never reach the player unless they turn secrets on. The consistency guard answers with warnings when the text restates what is already written or the status fights an active canon fact; nothing is ever blocked. link records a relationship between two entries as it is revealed: family (parent, child, spouse, sibling), standing (ally, enemy, rival, lover, knows) or belonging (member_of, owns, rules, serves). Both entries must exist already - upsert them first. Symmetric ties are stored once and read from both ends, so link spouses or allies one way only, and direction matters for the rest: from is the parent, the member, the owner, the ruler, the servant, so a link's notes carry how it stands. get returns the full entry: summary, notes, your hidden notes, voice card, portrait, status and every relationship resolved to names; call it before writing dialogue for an NPC the player has met, so they sound like themselves and remember what they know. voice pins down how a recurring NPC sounds and what drives them: speech pattern, catchphrase, goal, fear, attitude; set one for anyone the player will speak to twice, fields given are merged into the card and an empty string clears one, and the card comes back in every briefing while they are in the scene. The codex briefing shows whoever is present - the entities named in the current scene or recent events - with their voice cards, then indexes every known name by kind, so the DM knows what already exists before inventing it. The window shows an entity's tree; op=get returns its links.",
    fields: {
      campaign_id: z.number().int(),
      kind: kindSchema.optional().describe('(op=upsert) What the entry is: an NPC, faction, place, item, deity or event.'),
      name: z
        .string()
        .min(1)
        .optional()
        .describe(
          '(op=upsert, op=get, op=voice) The name as the player hears it; it is the identity of the entry and matches case-insensitively. get and voice also accept an id instead.',
        ),
      summary: z.string().optional().describe('(op=upsert) One line: who or what this is.'),
      notes: z
        .string()
        .optional()
        .describe(
          '(op=upsert, op=link) upsert: what is known about them, appended to what is already there; link: how the tie stands, e.g. "estranged since the fire".',
        ),
      hidden_notes: z.string().optional().describe('(op=upsert) DM-only truth: secrets, plans, what they are really after.'),
      status: statusSchema.optional().describe('(op=upsert) alive, dead or unknown; new NPCs start alive.'),
      voice: z.object(voiceSchema).optional().describe('(op=upsert) The voice card; set it for any recurring NPC.'),
      from: refSchema
        .optional()
        .describe('(op=link) The link source: the parent, the member, the owner, the ruler or the servant.'),
      to: refSchema.optional().describe('(op=link) The other end; symmetric ties read the same from either end.'),
      type: z
        .enum([
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
        ])
        .optional()
        .describe('(op=link) How they relate: family, standing or belonging.'),
      id: z.number().int().optional().describe('(op=get, op=voice) The entity id; id or name identifies it.'),
      speech_pattern: z
        .string()
        .optional()
        .describe('(op=voice) How they talk: rhythm, vocabulary, accent in words not spelling.'),
      catchphrase: z.string().optional().describe('(op=voice) A line they actually say.'),
      goal: z.string().optional().describe('(op=voice) What they want in this story.'),
      fear: z.string().optional().describe('(op=voice) What they will not risk.'),
      attitude: z.string().optional().describe('(op=voice) How they treat the party right now.'),
    },
    ops: {
      upsert: {
        summary: 'Add a named entity to the codex, or merge new detail into it',
        requires: ['kind', 'name'],
        uses: ['summary', 'notes', 'hidden_notes', 'status', 'voice'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(
            db,
            input.campaign_id,
            upsertEntity(db, { ...input, kind: input.kind!, name: input.name! }) as unknown as Record<string, unknown>,
          );
        },
      },
      link: {
        summary: 'Record a relationship between two entries as it is revealed',
        requires: ['from', 'to', 'type'],
        uses: ['notes'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(
            db,
            input.campaign_id,
            linkEntities(db, { ...input, from: input.from!, to: input.to!, type: input.type! }) as unknown as Record<
              string,
              unknown
            >,
          );
        },
      },
      get: {
        summary: 'Read one entity with its voice card, notes and links',
        requires: [],
        uses: ['id', 'name'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(
            db,
            input.campaign_id,
            getEntity(db, input.campaign_id, ref(input), { include_hidden: true }) as unknown as Record<string, unknown>,
          );
        },
      },
      voice: {
        summary: 'Pin how a recurring NPC sounds and what drives them',
        requires: [],
        uses: ['id', 'name', 'speech_pattern', 'catchphrase', 'goal', 'fear', 'attitude'],
        run: (args) => {
          const { op, ...input } = args;
          const { campaign_id, id, name, ...card } = input;
          return reply(db, campaign_id, setVoiceCard(db, campaign_id, ref({ id, name }), card) as unknown as Record<
            string,
            unknown
          >);
        },
      },
    },
    annotations: { ...WRITES },
  });

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
}
