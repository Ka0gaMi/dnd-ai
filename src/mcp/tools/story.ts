import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
  updatePlotThread,
} from '../../core/story.js';
import { TABLE_NAMES, rollTable, tableKeys, type TableName } from '../../core/tables.js';
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
      "Outline writes the story's shape: the premise in one paragraph, the ending you steer towards, and DM-only secret notes the player must not see. Call it at the start, after create_campaign and the premise, and when the story changes direction; secret_notes never reaches the player unless their spoiler toggle is on. Follow it with act and open_chapter. Act adds the next large movement a run of chapters belongs to, with its goal. Call it when you write the outline (two to four acts is plenty) and when a sandbox grows a movement; acts are numbered as you add them, and an act becomes active when a chapter opens inside it. open_chapter opens a chapter, the unit of play between recaps. Call it at the start and whenever no chapter is open; everything recorded afterwards is stamped with it. It refuses while one is open: closing it needs a summary, so use advance_chapter. Pass act_id to place it, or leave it out to continue the current act. advance_chapter closes the open chapter with a recap and opens the next in one call. Call it when a chapter is over, after the scene's save_checkpoint, not instead of it. The summary is 3-6 sentences and becomes the chapter recap every later briefing carries; write what changed and what hangs. Pass act_id when the new chapter starts a new act. It needs a chapter to close; with none open it refuses and saves nothing, so call open_chapter first.",
    fields: {
      campaign_id: z.number().int(),
      premise: z.string().optional().describe('(op=outline) The whole story in a paragraph: setting, hook, stakes.'),
      ending: z.string().optional().describe('(op=outline) Where this is heading if nothing derails it.'),
      secret_notes: z.string().optional().describe('(op=outline) DM only: the twist, the real villain, what is really going on.'),
      title: z
        .string()
        .min(1)
        .optional()
        .describe(
          '(op=act, op=open_chapter, op=advance_chapter) Short name: for act e.g. "The Road South"; open_chapter defaults to "Chapter N"; advance_chapter names the chapter being opened.',
        ),
      goal: z
        .string()
        .optional()
        .describe(
          '(op=act, op=open_chapter, op=advance_chapter) For act, what it is about and what would end it; for open_chapter, what the chapter is meant to resolve; for advance_chapter, what the new chapter is meant to resolve.',
        ),
      act_id: z
        .number()
        .int()
        .optional()
        .describe(
          '(op=open_chapter, op=advance_chapter) Act from story {op: act}; open_chapter defaults to the act in play, advance_chapter places the new chapter when the story turns.',
        ),
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
      "Threads are the unanswered questions the story carries. add opens one; call it the moment you dangle something you intend to pay off, so no later chat forgets it, and the open threads with their ids are in every briefing. Set hidden true for a thread the player does not know exists; it stays out of their window until their spoiler toggle is on. update moves it on: resolved when answered in play, dropped when the story leaves it behind, or a new summary as it develops. Call it as the payoff lands and clear hidden once the player learns it exists. Resolving or dropping retires its rumours, so the briefing stops repeating them; the closed thread stays in the player's window for a few chapters, then falls away, while the DM's list stays open only. plant_clue records a clue placed in the world for a thread, noticed or not, so a later chat can bring it back rather than invent a contradiction; pass thread_id for the thread it answers. A hidden clue is DM-only in their window. find_clue marks a planted clue found and ties it to the scene it turned up in: it stops being hidden and appears in the player's own window. Call it as soon as they get hold of it and narrate it after. Pass the clue id from the briefing, or enough of its text to match it; pass rumour_id when the player followed a rumour here so it moves under the clue's thread and shows as followed in their Heard list.",
    fields: {
      campaign_id: z.number().int(),
      title: z.string().min(1).optional().describe('(op=add) The question in a few words.'),
      summary: z
        .string()
        .optional()
        .describe('(op=add, op=update) What is really going on, or where it could go as it develops.'),
      hidden: z
        .boolean()
        .optional()
        .describe(
          "(op=add, op=update, op=plant_clue) add and plant_clue default to visible; true keeps a thread out of the player's window until their spoiler toggle, or a clue DM-only, and update clears it once the player knows.",
        ),
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
        summary: 'Mark a planted clue found and tie it to its scene and rumour',
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
      "Stores something the world is saying, with how far it travels (world, region, location) and whether it is true, false or twisted in the telling; an unresolved rumour's truth never reaches the player, so only you know it. Call add when you invent tavern talk, a warning on the road or a lie a faction is spreading - especially the false ones, so you stay consistent about what the player was told. source_kind records who says it (\"tavern\", \"guard\", \"child\", \"broadsheet\"), and thread_id ties the rumour to a plot thread it points at. get returns unresolved rumours to deliver, newest last, reaching for ones the player has not heard before repeating the rest, and marks the ones it returns as heard by the player. Every heard rumour already sits in the briefing, so call get when the party reaches a tavern, a market or anywhere talk happens to seed the ones they have not heard, and never contradict what the player was told. Filter by scope: location for local gossip, region for road news, world for what everyone knows. Have an NPC say the returned rumours in their own voice rather than improvising fresh ones each time, and roll_table with table \"rumours\" invents a new one when the pile runs dry.",
    fields: {
      campaign_id: z.number().int(),
      text: z.string().min(1).optional().describe('(op=add) The rumour as someone would say it.'),
      scope: z
        .enum(['world', 'region', 'location'])
        .optional()
        .describe('(op=add, op=get) add: how far it has travelled, default location; get: filter to this scope.'),
      truth: z.enum(['true', 'false', 'twisted']).optional().describe('(op=add) What is actually the case. Default true.'),
      source_kind: z.string().optional().describe('(op=add) Who says it: "tavern", "guard", "child", "broadsheet".'),
      thread_id: z.number().int().optional().describe('(op=add) Thread this rumour points at.'),
      limit: z.number().int().min(1).max(20).optional().describe('(op=get) How many to hand over. Default 3.'),
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
        summary: 'Hand unresolved rumours to the player and mark them heard',
        requires: [],
        uses: ['scope', 'limit'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, {
            rumours: getRumours(db, input.campaign_id, { scope: input.scope, limit: input.limit ?? 3, mark_heard: true }),
          });
        },
      },
    },
    annotations: { ...WRITES },
  });

  registerOpTool(server, 'time', {
    title: 'Time and the calendar',
    description:
      "advance moves the in-world clock by minutes, hours or days and returns the new date, time of day, season and weather; call it whenever time passes on screen - travel, a long wait, a rest, a night in an inn - because the calendar is what makes a season or a deadline mean anything. A rest moves the same clock, and advancing it is what recharges a dawn or dusk magic item and wakes a stabilised character once their 1d4 hours are up. The weather is rolled from the season and is the same for the whole day, so ask once and narrate it consistently, and the clock sits in the briefing's Now block. Nothing else moves the clock, so a story where you never call advance happens on one endless morning. set_calendar sets the in-world date and clock outright, instead of moving it forward with advance - use it once at the start of a campaign to place it in the world and give it an era, or to jump to a known date; the new-story prompt calls it just after the outline. The calendar defines the era and the names of its twelve months, and any field you omit keeps its current value. month_names renames the twelve months in place (handy for a setting with its own calendar); era_name is the name attached to the year (\"the year 1042 of the Third Age\"). season_override pins the season regardless of month, until you call this again with season_override: null to let it follow the month; hemisphere: \"south\" flips which months count as which season. It rolls a fresh weather for the new date and logs that the calendar was set.",
    fields: {
      campaign_id: z.number().int(),
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
        'Rolls on a bundled random table so the world decides instead of you: names by culture, a rumour with its blanks filled, loot by challenge rating, weather by season, an encounter by terrain. Use it when you need a detail you have no reason to choose - an innkeeper\'s name, what is in the strongbox, who is on the road - and treat the answer as a prompt, not as prose to read out. Pass key for the culture, CR, season or terrain, and seed to get the same answer again. It writes nothing: record what you keep with rumour {op: add}, add_canon_fact or the loot tools.',
      inputSchema: {
        campaign_id: z.number().int().optional(),
        table: z.enum(TABLE_NAMES as [TableName, ...TableName[]]),
        key: z.string().optional().describe(tableKeyHelp()),
        seed: z.number().int().optional().describe('Same seed and key, same result.'),
      },
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
        'Returns what the player has written in their own journal in the companion window, oldest first. Read it when you load a campaign and whenever they mention having written something down: it is their account of the story, and it tells you what they believe, remember and care about. It is read-only - the journal is theirs, and nothing you do writes to it. The last few entries are also in every briefing.',
      inputSchema: {
        campaign_id: z.number().int(),
        limit: z.number().int().min(1).max(100).optional().describe('How many entries. Default 20.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ campaign_id, limit }) =>
      reply(db, campaign_id, { journal: readJournal(db, campaign_id, limit ?? 20) }),
  );
}
