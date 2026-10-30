import type { McpServer } from '@modelcontextprotocol/server';
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
import { CAMPAIGN_ID } from './fields.js';
import { openKind, registerOpTool } from './op.js';
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
function ref(args: { id?: number; name?: string }, op: string): EntityRef {
  if (args.id !== undefined) return args.id;
  if (args.name !== undefined) return args.name;
  throw new Error(
    `Missing id or name for op=${op}. Re-call with id (from get_codex or the briefing) or name (as the player hears it).`,
  );
}

export function registerCodexTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'entity', {
    title: 'Codex entities',
    description:
      "The codex: someone or something the story has named - an NPC, faction, place, item, deity or event. op=upsert it the moment you expect to mention it again, and again whenever you learn more; the name is its identity, so the same name merges: notes are appended, summary and status replaced. hidden_notes stay yours unless the player turns secrets on. op=link records a relationship as it is revealed; both entries must exist first. Symmetric ties (spouse, sibling, ally, enemy, rival, lover, knows) are stored once, so link them one way; for the rest, from is the parent, the member, the owner, the ruler or the servant. op=get returns the full entry with every relationship by name: read it before writing dialogue for an NPC the player has met. op=voice pins how a recurring NPC sounds and what drives them; given fields merge, an empty string clears one, and the card is in every briefing while they are in the scene. The briefing shows who is present with their voice cards and indexes every known name, so check it before inventing one. The window shows an entity's tree; op=get returns its links.",
    fields: {
      campaign_id: CAMPAIGN_ID,
      kind: kindSchema.optional().describe('(op=upsert) What the entry is: an NPC, faction, place, item, deity or event.'),
      name: z
        .string()
        .min(1)
        .optional()
        .describe('(op=upsert, op=get, op=voice) The name as the player hears it: the identity, matched case-insensitively. An id wins over it.'),
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
      distinct: z.boolean().optional().describe('(op=upsert) Add a new entry even though its name is close to an existing one.'),
      from: refSchema
        .optional()
        .describe('(op=link) The link source: the parent, the member, the owner, the ruler or the servant.'),
      to: refSchema.optional().describe('(op=link) The other end; symmetric ties read the same from either end.'),
      type: openKind('relationship type', [
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
        .describe('(op=link) How they relate: family, ties or belonging (member_of, owns, rules, serves); read_guide codex lists all.'),
      id: z.number().int().optional().describe('(op=upsert, op=get, op=voice) The entity id; id or name identifies it, and id wins.'),
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
        uses: ['id', 'summary', 'notes', 'hidden_notes', 'status', 'voice', 'distinct'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(
            db,
            input.campaign_id,
            upsertEntity(db, { ...input, kind: input.kind!, name: input.name!, checkNear: true }) as unknown as Record<
              string,
              unknown
            >,
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
            getEntity(db, input.campaign_id, ref(input, 'get'), { include_hidden: true }) as unknown as Record<string, unknown>,
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
          return reply(db, campaign_id, setVoiceCard(db, campaign_id, ref({ id, name }, 'voice'), card) as unknown as Record<
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
        'The compact index of the codex: id, kind, name, one-line summary, status. Check it before inventing a name, or to find an entry id; filter by kind or search names and summaries with query.',
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        kind: kindSchema.optional(),
        query: z.string().optional().describe('Substring matched against names and summaries.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, getCodex(db, args.campaign_id, args)),
  );
}
