import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { advanceTime, setCalendar } from '../../core/calendar.js';
import {
  addAct,
  addPlotThread,
  addRumour,
  advanceChapter,
  findClue,
  getRumours,
  listActs,
  openChapter,
  plantClue,
  readJournal,
  setStoryOutline,
  tellRumours,
  updatePlotThread,
} from '../../core/story.js';
import { TABLE_NAMES, rollTable, tableKeys, type TableName } from '../../core/tables.js';
import { CAMPAIGN_ID } from './fields.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';

const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const tableKeyHelp = (): string =>
  `names: ${tableKeys('names').join(', ')}; loot: ${tableKeys('loot').join(', ')} (or a CR number); weather: ${tableKeys(
    'weather',
  ).join(', ')}; encounters: ${tableKeys('encounters').join(', ')}; rumours takes no key`;

export function registerStoryTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'story', {
    title: 'Acts and chapters',
    description:
      "The story's shape. op=outline writes the premise, the ending you steer towards and DM-only secret notes (shown only if the player's spoiler toggle is on); call it after create_campaign and whenever the story changes direction, then act and open_chapter. op=act adds the next large movement, with its goal (two to four acts is plenty); it becomes active when a chapter opens inside it. op=open_chapter opens the unit of play between recaps; everything recorded afterwards is stamped with it, and it refuses while one is open. op=advance_chapter closes the open chapter and opens the next in one call, after the scene's checkpoint {op: save}, not instead of it; with none open it refuses and saves nothing. Its summary (3-6 sentences on what changed and what hangs) becomes the recap every later briefing carries.",
    fields: {
      campaign_id: CAMPAIGN_ID,
      premise: z.string().optional().describe('(op=outline) The whole story in a paragraph: setting, hook, stakes.'),
      ending: z.string().optional().describe('(op=outline) Where this is heading if nothing derails it.'),
      secret_notes: z.string().optional().describe('(op=outline) DM only: the twist, the real villain, what is really going on.'),
      title: z
        .string()
        .min(1)
        .optional()
        .describe('(op=act, op=open_chapter, op=advance_chapter) Short name of the act or the chapter opened, e.g. "The Road South"; default "Chapter N".'),
      goal: z
        .string()
        .optional()
        .describe('(op=act, op=open_chapter, op=advance_chapter) What the act turns on, or what the new chapter is meant to resolve.'),
      act_id: z
        .number()
        .int()
        .optional()
        .describe('(op=open_chapter, op=advance_chapter) The act the chapter belongs to, from story {op: act}; defaults to the act in play.'),
      summary: z.string().min(1).optional().describe('(op=advance_chapter) Recap of the chapter being closed, 3-6 sentences.'),
    },
    ops: {
      outline: {
        summary: 'Write the story premise, planned ending and DM-only notes',
        requires: [],
        uses: ['premise', 'ending', 'secret_notes'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, setStoryOutline(db, input) as unknown as Record<string, unknown>);
        },
      },
      act: {
        summary: 'Add the next act, with the goal it turns on',
        requires: ['title'],
        uses: ['goal'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, {
            act: addAct(db, { ...input, title: input.title! }),
            acts: listActs(db, input.campaign_id),
          });
        },
      },
      open_chapter: {
        summary: 'Open the chapter the story is played in',
        requires: [],
        uses: ['title', 'goal', 'act_id'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, { chapter: openChapter(db, input) });
        },
      },
      advance_chapter: {
        summary: 'Close the open chapter with its recap and open the next',
        requires: ['summary'],
        uses: ['title', 'goal', 'act_id'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(
            db,
            input.campaign_id,
            advanceChapter(db, { ...input, summary: input.summary! }) as unknown as Record<string, unknown>,
          );
        },
      },
    },
    annotations: { ...WRITES },
  });

  registerOpTool(server, 'thread', {
    title: 'Plot threads and clues',
    description:
      "Threads are the questions the story carries; the open ones with ids are in every briefing. op=add opens one the moment you dangle something to pay off, so no later chat forgets it; hidden keeps it out of the player's window until their spoiler toggle is on. op=update moves it on as the payoff lands: resolved when answered in play, dropped when the story leaves it, or a revised summary; clear hidden once the player learns of it. Resolving or dropping retires its rumours; a closed thread stays in the player's window a few chapters. op=plant_clue records a clue placed in the world, noticed or not, so a later chat brings it back instead of contradicting it. op=find_clue marks a planted clue found as soon as they get hold of it - narrate it after: it ties to the scene, stops being hidden and shows in the player's window; pass rumour_id when they followed a rumour here, which moves it under that thread.",
    fields: {
      campaign_id: CAMPAIGN_ID,
      title: z.string().min(1).optional().describe('(op=add) The question in a few words.'),
      summary: z
        .string()
        .optional()
        .describe('(op=add, op=update) What is really going on, or where it could go as it develops.'),
      hidden: z
        .boolean()
        .optional()
        .describe("(op=add, op=update, op=plant_clue) True keeps a thread from the player until their spoiler toggle, or a clue DM-only; visible by default."),
      id: z
        .number()
        .int()
        .optional()
        .describe('(op=update, op=find_clue) Thread id from the briefing for update; clue id from the briefing for find_clue.'),
      status: z
        .enum(['open', 'resolved', 'dropped'])
        .optional()
        .describe('(op=update) Resolved when answered in play, dropped when the story leaves it behind.'),
      text: z
        .string()
        .min(1)
        .optional()
        .describe(
          '(op=plant_clue, op=find_clue) The clue itself, one sentence, for plant_clue; part of the clue text to match when find_clue has no id.',
        ),
      thread_id: z.number().int().optional().describe('(op=plant_clue) Thread it answers, from thread {op: add}.'),
      rumour_id: z
        .number()
        .int()
        .optional()
        .describe("(op=find_clue) The rumour the player followed to this clue; it then moves under the clue's thread."),
    },
    ops: {
      add: {
        summary: 'Open a plot thread, the moment you dangle something to pay off',
        requires: ['title'],
        uses: ['summary', 'hidden'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, { thread: addPlotThread(db, { ...input, title: input.title! }) });
        },
      },
      update: {
        summary: 'Move a thread on - resolve it, drop it, or revise its summary',
        requires: ['id'],
        uses: ['status', 'summary', 'hidden'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, { thread: updatePlotThread(db, { ...input, id: input.id! }) });
        },
      },
      plant_clue: {
        summary: 'Record a clue placed in the world, hidden from the player',
        requires: ['text'],
        uses: ['thread_id', 'hidden'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, { clue: plantClue(db, { ...input, text: input.text! }) });
        },
      },
      find_clue: {
        summary: 'Mark a planted clue found by its id or part of its text, and tie it to its scene and rumour',
        requires: [],
        uses: ['id', 'text', 'rumour_id'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, findClue(db, input) as unknown as Record<string, unknown>);
        },
      },
    },
    annotations: { ...WRITES },
  });

  registerOpTool(server, 'rumour', {
    title: 'Rumours',
    description:
      'What the world is saying, with its scope and its truth; an unresolved rumour\'s truth never reaches the player. op=add when you invent tavern talk, a road warning or a faction\'s lie - especially the false ones, so you stay consistent. op=get lists unresolved rumours, unheard first, and marks nothing: call it where talk happens (a tavern, a market) and have an NPC say them in their own voice rather than improvising fresh ones. Then op=tell the ids you actually narrated; only those reach the player\'s window and the briefing\'s Heard list, and get {heard: true} lists them again. Never contradict what the player was told. roll_table {table: "rumours"} invents a new one when the pile runs dry.',
    fields: {
      campaign_id: CAMPAIGN_ID,
      text: z.string().min(1).optional().describe('(op=add) The rumour as someone would say it.'),
      scope: z
        .enum(['world', 'region', 'location'])
        .optional()
        .describe('(op=add, op=get) add: how far it has travelled, default location; get: filter to this scope.'),
      truth: z.enum(['true', 'false', 'twisted']).optional().describe('(op=add) What is actually the case. Default true.'),
      source_kind: z.string().optional().describe('(op=add) Who says it: "tavern", "guard", "child", "broadsheet".'),
      thread_id: z.number().int().optional().describe('(op=add) Thread this rumour points at.'),
      limit: z.number().int().min(1).max(20).optional().describe('(op=get) How many to list. Default 3.'),
      heard: z.boolean().optional().describe('(op=get) True lists only rumours the player has heard; otherwise unheard ones come first.'),
      ids: z.array(z.number().int()).min(1).optional().describe('(op=tell) Ids of the rumours you just narrated, from op=get.'),
    },
    ops: {
      add: {
        summary: 'Store what the world is saying, with its scope and truth',
        requires: ['text'],
        uses: ['scope', 'truth', 'source_kind', 'thread_id'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, { rumour: addRumour(db, { ...input, text: input.text! }) });
        },
      },
      get: {
        summary: 'List unresolved rumours to narrate, unheard first; marks nothing',
        requires: [],
        uses: ['scope', 'limit', 'heard'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, {
            rumours: getRumours(db, input.campaign_id, { scope: input.scope, limit: input.limit ?? 3, heard_only: input.heard === true }),
          });
        },
      },
      tell: {
        summary: "Mark the rumours you just narrated heard, so the player's window and the briefing show them",
        requires: ['ids'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, { rumours: tellRumours(db, input.campaign_id, input.ids!) });
        },
      },
    },
    annotations: { ...WRITES },
  });

  registerOpTool(server, 'time', {
    title: 'Time and the calendar',
    description:
      'The in-world clock. op=advance moves it by minutes, hours or days whenever time passes on screen - travel, a wait, a night at an inn - and returns the date, time of day, season and weather; only rests move it otherwise, so a story without it happens on one endless morning. Advancing recharges dawn and dusk magic items and wakes a stabilised character after their 1d4 hours. Weather is rolled per day from the season, so narrate it consistently; the clock is in the briefing\'s Now block. op=set_calendar sets the date and clock outright - once at the start to place the campaign (the new-story prompt calls it after the outline), or to jump to a known date; omitted fields keep their values, and it rolls fresh weather. era_name names the year ("1042 of the Third Age").',
    fields: {
      campaign_id: CAMPAIGN_ID,
      minutes: z.number().int().min(0).optional().describe('(op=advance) How many minutes the clock moves.'),
      hours: z.number().int().min(0).optional().describe('(op=advance) How many hours the clock moves.'),
      days: z.number().int().min(0).optional().describe('(op=advance) How many days the clock moves.'),
      year: z.number().int().optional().describe('(op=set_calendar) The year.'),
      month: z.number().int().min(1).max(12).optional().describe('(op=set_calendar) 1-12.'),
      day: z.number().int().min(1).max(30).optional().describe('(op=set_calendar) 1-30.'),
      hour: z.number().int().min(0).max(23).optional().describe('(op=set_calendar) 0-23.'),
      minute: z.number().int().min(0).max(59).optional().describe('(op=set_calendar) 0-59.'),
      month_names: z
        .array(z.string())
        .length(12)
        .optional()
        .describe('(op=set_calendar) Renames the twelve months, in order.'),
      era_name: z.string().optional().describe('(op=set_calendar) Name for the year, e.g. "Third Age".'),
      season_override: z
        .enum(['spring', 'summer', 'autumn', 'winter'])
        .nullable()
        .optional()
        .describe('(op=set_calendar) Pins the season until cleared with null.'),
      hemisphere: z
        .enum(['north', 'south'])
        .optional()
        .describe('(op=set_calendar) South flips the month-to-season mapping.'),
    },
    ops: {
      advance: {
        summary: 'Move the in-world clock by minutes, hours or days',
        requires: [],
        uses: ['minutes', 'hours', 'days'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, advanceTime(db, input.campaign_id, input) as unknown as Record<string, unknown>);
        },
      },
      set_calendar: {
        summary: 'Set the in-world date, clock and calendar outright',
        requires: [],
        uses: ['year', 'month', 'day', 'hour', 'minute', 'month_names', 'era_name', 'season_override', 'hemisphere'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(
            db,
            input.campaign_id,
            setCalendar(db, input.campaign_id, input as Parameters<typeof setCalendar>[2]) as unknown as Record<string, unknown>,
          );
        },
      },
    },
    annotations: { ...WRITES },
  });

  server.registerTool(
    'roll_table',
    {
      title: 'Roll on a random table',
      description:
        `Rolls on a bundled random table so the world decides instead of you: a name by culture, a rumour, loot by CR, weather by season, an encounter by terrain. Use it for a detail you have no reason to choose and treat the answer as a prompt, not prose. It writes nothing: keep what you use with rumour {op: add}, remember {op: fact} or inventory. Keys - ${tableKeyHelp()}.`,
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID.optional(),
        table: z.enum(TABLE_NAMES as [TableName, ...TableName[]]),
        key: z.string().optional().describe('The culture, CR band, season or terrain; the description lists them.'),
        seed: z.number().int().optional().describe('Same seed and key, same result.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ campaign_id, table, key, seed }) =>
      reply(db, campaign_id ?? null, rollTable(table, { key, seed }) as unknown as Record<string, unknown>),
  );

  server.registerTool(
    'read_journal',
    {
      title: 'Read the player journal',
      description:
        'Returns what the player wrote in their journal in the companion window, oldest first: their account of what they believe, remember and care about. Read it when you load a campaign and whenever they mention writing something down. It is read-only - the journal is theirs; the last entries are also in every briefing.',
      inputSchema: z.object({
        campaign_id: CAMPAIGN_ID,
        limit: z.number().int().min(1).max(100).optional().describe('How many entries. Default 20.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ campaign_id, limit }) =>
      reply(db, campaign_id, { journal: readJournal(db, campaign_id, limit ?? 20) }),
  );
}
