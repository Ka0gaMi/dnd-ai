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
import { reply } from './result.js';

const tableKeyHelp = (): string =>
  `names: ${tableKeys('names').join(', ')}; loot: ${tableKeys('loot').join(', ')} (or a CR number); weather: ${tableKeys(
    'weather',
  ).join(', ')}; encounters: ${tableKeys('encounters').join(', ')}; rumours takes no key`;

export function registerStoryTools(server: McpServer, db: Db): void {
  server.registerTool(
    'set_story_outline',
    {
      title: 'Set story outline',
      description:
        'Writes the shape of the whole story: the premise in one paragraph, the ending you are steering towards, and DM-only notes the player must not see (the twist, who is really behind it). Call it once at the start of a campaign, right after create_campaign and the premise, and again when the story genuinely changes direction. secret_notes never reaches the player unless they turn their spoiler toggle on. Follow it with add_act and open_chapter so play has a chapter to hang on.',
      inputSchema: {
        campaign_id: z.number().int(),
        premise: z.string().optional().describe('The whole story in a paragraph: setting, hook, stakes.'),
        ending: z.string().optional().describe('Where this is heading if nothing derails it.'),
        secret_notes: z.string().optional().describe('DM only: the twist, the real villain, what is really going on.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, setStoryOutline(db, args) as unknown as Record<string, unknown>),
  );

  server.registerTool(
    'add_act',
    {
      title: 'Add act',
      description:
        'Adds the next act of the story - the large movement a run of chapters belongs to, with the goal it turns on. Call it when you write the outline (two to four acts is plenty) and when a sandbox grows a new movement of its own. Acts are numbered for you in the order you add them. An act becomes the active one as soon as a chapter opens inside it.',
      inputSchema: {
        campaign_id: z.number().int(),
        title: z.string().min(1).describe('Short name, e.g. "The Road South".'),
        goal: z.string().optional().describe('What the act is about and what would end it.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, { act: addAct(db, args), acts: listActs(db, args.campaign_id) }),
  );

  server.registerTool(
    'open_chapter',
    {
      title: 'Open chapter',
      description:
        'Opens a chapter - the unit of play between one recap and the next, a few scenes long. Call it at the very start of a campaign and whenever no chapter is open; everything recorded afterwards (facts, rumours, journal entries, checkpoints) is stamped with it. It refuses while a chapter is still open, because closing one needs a summary: use advance_chapter for that. Pass act_id to place it, or leave it out to continue the act being played.',
      inputSchema: {
        campaign_id: z.number().int(),
        title: z.string().optional().describe('Short name for the chapter; defaults to "Chapter N".'),
        goal: z.string().optional().describe('What this chapter is meant to resolve.'),
        act_id: z.number().int().optional().describe('Act from add_act; defaults to the act in play.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, { chapter: openChapter(db, args) }),
  );

  server.registerTool(
    'advance_chapter',
    {
      title: 'Advance chapter',
      description:
        'Closes the open chapter with a recap of what it came to and opens the next one in a single call. Call it when a chapter of the story is genuinely over - the job is done, the town is left behind, the act turns - after the scene\'s save_checkpoint, not instead of it. The summary is 3-6 sentences and becomes the chapter recap that every later briefing carries, so write what changed and what is still hanging. Pass act_id when the new chapter starts a new act. It needs a chapter to close: with none open it refuses and saves nothing, so call open_chapter first.',
      inputSchema: {
        campaign_id: z.number().int(),
        summary: z.string().min(1).describe('Recap of the chapter being closed, 3-6 sentences.'),
        title: z.string().optional().describe('Name of the chapter being opened.'),
        goal: z.string().optional().describe('What the new chapter is meant to resolve.'),
        act_id: z.number().int().optional().describe('Act for the new chapter when the story turns.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, advanceChapter(db, args) as unknown as Record<string, unknown>),
  );

  server.registerTool(
    'add_plot_thread',
    {
      title: 'Add plot thread',
      description:
        'Tracks one unanswered question the story is carrying: who poisoned the well, what the cult wants, where the sister went. Call it the moment you dangle something you intend to pay off, so no later chat forgets it - the open threads are in every briefing. Set hidden true for a thread the player does not know exists yet; hidden threads stay out of their window until their spoiler toggle is on. Close it with update_plot_thread when it is answered or abandoned.',
      inputSchema: {
        campaign_id: z.number().int(),
        title: z.string().min(1).describe('The question in a few words.'),
        summary: z.string().optional().describe('What is really going on, or where it could go.'),
        hidden: z.boolean().optional().describe('True while the player does not know this thread exists.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, { thread: addPlotThread(db, args) }),
  );

  server.registerTool(
    'update_plot_thread',
    {
      title: 'Update plot thread',
      description:
        'Moves a thread on: resolved when the question is answered in play, dropped when the story left it behind, or a new summary as it develops. Call it in the same beat the payoff lands, and clear hidden once the player learns the thread exists. Resolving or dropping a thread also retires the rumours attached to it, so the briefing stops repeating them. Thread ids come from the briefing.',
      inputSchema: {
        campaign_id: z.number().int(),
        id: z.number().int().describe('Thread id from the briefing.'),
        status: z.enum(['open', 'resolved', 'dropped']).optional(),
        summary: z.string().optional(),
        hidden: z.boolean().optional().describe('False once the player knows about it.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, { thread: updatePlotThread(db, args) }),
  );

  server.registerTool(
    'plant_clue',
    {
      title: 'Plant clue',
      description:
        'Records a clue you have put in the world for a thread - a ledger entry, a scar, a name dropped by a drunk. Call it when you place it, whether or not the player noticed, so a later chat can bring it back rather than invent a contradiction. Hidden clues (the default for anything the player has not seen) are DM-only in their window. Call find_clue when they actually find it.',
      inputSchema: {
        campaign_id: z.number().int(),
        text: z.string().min(1).describe('The clue itself, one sentence.'),
        thread_id: z.number().int().optional().describe('Thread it answers, from add_plot_thread.'),
        hidden: z.boolean().optional().describe('True while the player has not found it. Default false.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, { clue: plantClue(db, args) }),
  );

  server.registerTool(
    'find_clue',
    {
      title: 'Find clue',
      description:
        'Marks a planted clue as found by the player and ties it to the scene it turned up in. Call it as soon as they get hold of it - a successful search, an NPC who talks, a body looted - and narrate it afterwards. A found clue stops being hidden, so it appears in the player\'s own window. Pass the clue id from the briefing, or enough of its text to match it. When the player followed a rumour to this clue, pass rumour_id so the rumour moves under the thread its clue belongs to.',
      inputSchema: {
        campaign_id: z.number().int(),
        id: z.number().int().optional().describe('Clue id from the briefing.'),
        text: z.string().optional().describe('Part of the clue text, when you do not have the id.'),
        rumour_id: z
          .number()
          .int()
          .optional()
          .describe('The rumour the player followed to this clue; moves it under the clue\'s thread.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, findClue(db, args) as unknown as Record<string, unknown>),
  );

  server.registerTool(
    'add_rumour',
    {
      title: 'Add rumour',
      description:
        'Stores something the world is saying, with how far it travels (world, region, location) and whether it is true, false or twisted in the telling. Call it when you invent tavern talk, a warning on the road or a lie a faction is spreading - especially the false ones, so you stay consistent about what the player was told. Attach thread_id when the rumour points at a thread. Hand rumours out with get_rumours rather than improvising fresh ones each time.',
      inputSchema: {
        campaign_id: z.number().int(),
        text: z.string().min(1).describe('The rumour as someone would say it.'),
        scope: z.enum(['world', 'region', 'location']).optional().describe('How far it has travelled. Default location.'),
        truth: z.enum(['true', 'false', 'twisted']).optional().describe('What is actually the case. Default true.'),
        source_kind: z.string().optional().describe('Who says it: "tavern", "guard", "child", "broadsheet".'),
        thread_id: z.number().int().optional().describe('Thread this rumour points at.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => reply(db, args.campaign_id, { rumour: addRumour(db, args) }),
  );

  server.registerTool(
    'get_rumours',
    {
      title: 'Get rumours',
      description:
        'Returns unresolved rumours to deliver, newest last, and marks the ones it returns as heard by the player. Call it when the party reaches a tavern, a market or anywhere talk happens, then have an NPC say them in their own voice. Filter by scope: location for local gossip, region for road news, world for what everyone knows. Heard rumours stay in the briefing so you never contradict what the player was told; roll_table with table "rumours" invents a new one when the pile runs dry.',
      inputSchema: {
        campaign_id: z.number().int(),
        scope: z.enum(['world', 'region', 'location']).optional(),
        limit: z.number().int().min(1).max(20).optional().describe('How many to hand over. Default 3.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ campaign_id, scope, limit }) =>
      reply(db, campaign_id, {
        rumours: getRumours(db, campaign_id, { scope, limit: limit ?? 3, mark_heard: true }),
      }),
  );

  server.registerTool(
    'advance_time',
    {
      title: 'Advance time',
      description:
        'Moves the in-world clock by minutes, hours or days and returns the new date, time of day, season and weather. Call it whenever time passes on screen: travel, a long wait, a rest, a night in an inn - the calendar is what makes a season or a deadline mean anything. The weather is rolled from the season and is the same for the whole day, so ask once and narrate it consistently. Nothing else moves the clock, so a story where you never call this happens on one endless morning.',
      inputSchema: {
        campaign_id: z.number().int(),
        minutes: z.number().int().min(0).optional(),
        hours: z.number().int().min(0).optional(),
        days: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ campaign_id, ...delta }) =>
      reply(db, campaign_id, advanceTime(db, campaign_id, delta) as unknown as Record<string, unknown>),
  );

  server.registerTool(
    'set_calendar',
    {
      title: 'Set the calendar',
      description:
        'Sets the in-world date and clock outright, instead of moving it forward with advance_time - use it once at the start of a campaign to place it in the world, or to jump to a known date. Any field you omit keeps its current value. month_names renames the twelve months in place (handy for a setting with its own calendar); era_name is the name attached to the year ("the year 1042 of the Third Age"). season_override pins the season regardless of month, until you call this again with season_override: null to let it follow the month; hemisphere: "south" flips which months count as which season. Rolls a fresh weather for the new date and logs that the calendar was set.',
      inputSchema: {
        campaign_id: z.number().int(),
        year: z.number().int().optional(),
        month: z.number().int().min(1).max(12).optional().describe('1-12.'),
        day: z.number().int().min(1).max(30).optional().describe('1-30.'),
        hour: z.number().int().min(0).max(23).optional(),
        minute: z.number().int().min(0).max(59).optional(),
        month_names: z.array(z.string()).length(12).optional().describe('Renames the twelve months, in order.'),
        era_name: z.string().optional().describe('Name for the year, e.g. "Third Age".'),
        season_override: z
          .enum(['spring', 'summer', 'autumn', 'winter'])
          .nullable()
          .optional()
          .describe('Pins the season until cleared with null.'),
        hemisphere: z.enum(['north', 'south']).optional().describe('South flips the month-to-season mapping.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ campaign_id, ...input }) =>
      reply(db, campaign_id, setCalendar(db, campaign_id, input as Parameters<typeof setCalendar>[2]) as unknown as Record<string, unknown>),
  );

  server.registerTool(
    'roll_table',
    {
      title: 'Roll on a random table',
      description:
        'Rolls on a bundled random table so the world decides instead of you: names by culture, a rumour with its blanks filled, loot by challenge rating, weather by season, an encounter by terrain. Use it when you need a detail you have no reason to choose - an innkeeper\'s name, what is in the strongbox, who is on the road - and treat the answer as a prompt, not as prose to read out. Pass key for the culture, CR, season or terrain, and seed to get the same answer again. It writes nothing: record what you keep with add_rumour, add_canon_fact or the loot tools.',
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
