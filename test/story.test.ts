import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { bus } from '../src/core/bus.js';
import { addCanonFact, campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import {
  addJournalEntry,
  addPlotThread,
  addRumour,
  advanceChapter,
  currentChapterId,
  findClue,
  getRumours,
  openChapter,
  plantClue,
  storyArc,
  updatePlotThread,
  type Chapter,
  type Clue,
  type PlotThread,
  type Rumour,
} from '../src/core/story.js';
import { openDb, type Db } from '../src/db/connection.js';
import { renderBriefing } from '../src/mcp/tools/campaign.js';
import { registerCheckpointTools } from '../src/mcp/tools/checkpoint.js';
import { GUIDE_SECTIONS, registerGuideTools } from '../src/mcp/tools/guide.js';
import { registerStoryTools } from '../src/mcp/tools/story.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, {
    name: 'The Ashfall Road',
    story_shape: 'structured',
    premise: 'A road of cinders.',
  }).campaign_id;
});

/** Only the story, guide and checkpoint tools: the rest of the server is not what is under test. */
async function connect(): Promise<Client> {
  const server = new McpServer({ name: 'story-test', version: '0.0.0' });
  registerStoryTools(server, db);
  registerGuideTools(server, db);
  registerCheckpointTools(server, db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return result.structuredContent as T;
}

/** The player's spoiler toggle belongs to the progression package; the flag is all this needs. */
function setShowSecrets(value: boolean): void {
  db.prepare('UPDATE campaign SET settings_json = ? WHERE id = ?').run(
    JSON.stringify({ show_secrets: value }),
    campaignId,
  );
}

const dmBriefing = (): string => renderBriefing(campaignSnapshot(db, campaignId));

/** The most recent event for this campaign, with its payload parsed for assertions. */
function lastEvent(): { kind: string; text: string; payload: Record<string, unknown> | null } {
  const row = db
    .prepare('SELECT kind, text, payload_json FROM event WHERE campaign_id = ? ORDER BY id DESC LIMIT 1')
    .get(campaignId) as { kind: string; text: string; payload_json: string | null };
  return {
    kind: row.kind,
    text: row.text,
    payload: row.payload_json === null ? null : (JSON.parse(row.payload_json) as Record<string, unknown>),
  };
}

describe('outline, acts and chapters', () => {
  it('writes the outline, numbers the acts and chapters and chains the chapter recaps', async () => {
    const client = await connect();
    await call(client, 'story', {
      op: 'outline',
      campaign_id: campaignId,
      premise: 'Ash falls on the old road.',
      ending: 'The forge is put out.',
      secret_notes: 'The smith is already dead.',
    });
    const firstAct = await call<{ act: { id: number; number: number } }>(client, 'story', {
      op: 'act',
      campaign_id: campaignId,
      title: 'The Road South',
      goal: 'Reach the forge.',
    });
    const secondAct = await call<{ act: { id: number; number: number } }>(client, 'story', {
      op: 'act',
      campaign_id: campaignId,
      title: 'The Forge',
    });
    expect([firstAct.act.number, secondAct.act.number]).toEqual([1, 2]);

    const opened = await call<{ chapter: Chapter }>(client, 'story', {
      op: 'open_chapter',
      campaign_id: campaignId,
      title: 'Cinders',
      goal: 'Leave the village.',
      act_id: firstAct.act.id,
    });
    expect(opened.chapter).toMatchObject({ number: 1, status: 'open', act_id: firstAct.act.id });

    const advanced = await call<{ closed: Chapter; opened: Chapter }>(client, 'story', {
      op: 'advance_chapter',
      campaign_id: campaignId,
      summary: 'The village burned and the party took the south road.',
      title: 'The Long Walk',
    });
    expect(advanced.closed).toMatchObject({ number: 1, status: 'closed' });
    expect(advanced.opened).toMatchObject({ number: 2, title: 'The Long Walk', act_id: firstAct.act.id });

    await call(client, 'story', {
      op: 'advance_chapter',
      campaign_id: campaignId,
      summary: 'They walked for three days and met the toll keeper.',
      title: 'The Forge Gate',
      act_id: secondAct.act.id,
    });

    const briefing = dmBriefing();
    expect(briefing).toContain('## Story arc');
    expect(briefing).toContain('Act 2: The Forge');
    expect(briefing).toContain('Chapter 3: The Forge Gate');
    expect(briefing).toContain('1. Cinders: The village burned');
    expect(briefing).toContain('2. The Long Walk: They walked for three days');
    expect(briefing).toContain('Planned ending: The forge is put out.');
    expect(briefing).toContain('[secret] DM notes: The smith is already dead.');

    const acts = db.prepare('SELECT status FROM act WHERE campaign_id = ? ORDER BY number').all(campaignId);
    expect(acts).toEqual([{ status: 'done' }, { status: 'active' }]);
  });

  it('refuses to advance when no chapter is open, rather than dropping the summary', async () => {
    const client = await connect();
    await expect(
      call(client, 'story', { op: 'advance_chapter', campaign_id: campaignId, summary: 'A recap with nowhere to go.' }),
    ).rejects.toThrow(/open_chapter/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM chapter WHERE campaign_id = ?').get(campaignId)).toEqual({ n: 0 });
  });

  it('refuses to open a second chapter while one is open', async () => {
    const client = await connect();
    await call(client, 'story', { op: 'open_chapter', campaign_id: campaignId, title: 'Cinders' });
    await expect(call(client, 'story', { op: 'open_chapter', campaign_id: campaignId, title: 'Too soon' })).rejects.toThrow(
      /advance_chapter/,
    );
  });

  it('tags the scene a checkpoint closes with the open chapter', async () => {
    const client = await connect();
    const { chapter } = await call<{ chapter: Chapter }>(client, 'story', {
      op: 'open_chapter',
      campaign_id: campaignId,
      title: 'Cinders',
    });
    const saved = await call<{ scene: { id: number }; chapter_id: number }>(client, 'save_checkpoint', {
      campaign_id: campaignId,
      scene_title: 'The burning barn',
      scene_summary: 'They pulled the horses out before the roof went.',
    });
    expect(saved.chapter_id).toBe(chapter.id);
    const scene = db.prepare('SELECT chapter_id FROM scene WHERE id = ?').get(saved.scene.id);
    expect(scene).toEqual({ chapter_id: chapter.id });
    expect(currentChapterId(db, campaignId)).toBe(chapter.id);
  });
});

describe('threads, clues and secrets', () => {
  it('keeps hidden threads and clues for the DM until the player turns spoilers on', async () => {
    const client = await connect();
    await call(client, 'story', { op: 'open_chapter', campaign_id: campaignId, title: 'Cinders' });
    const open = await call<{ thread: PlotThread }>(client, 'add_plot_thread', {
      campaign_id: campaignId,
      title: 'Who set the fire?',
    });
    await call(client, 'add_plot_thread', {
      campaign_id: campaignId,
      title: 'The smith is already dead',
      hidden: true,
    });
    await call(client, 'plant_clue', {
      campaign_id: campaignId,
      text: 'A boot print in the ash, too small for a man.',
      thread_id: open.thread.id,
      hidden: true,
    });

    const briefing = dmBriefing();
    expect(briefing).toContain('[secret] The smith is already dead');
    expect(briefing).toContain('[secret] A boot print in the ash');

    const player = campaignSnapshot(db, campaignId, { forPlayer: true });
    expect(player.story.threads.map((t) => t.title)).toEqual(['Who set the fire?']);
    expect(player.story.clues).toEqual([]);
    expect(player.story.outline.secret_notes).toBeNull();

    setShowSecrets(true);
    const spoiled = campaignSnapshot(db, campaignId, { forPlayer: true });
    expect(spoiled.story.threads).toHaveLength(2);
    expect(spoiled.story.clues).toHaveLength(1);
  });

  it('reveals a clue to the player when it is found, and stamps the scene', async () => {
    const client = await connect();
    await call(client, 'story', { op: 'open_chapter', campaign_id: campaignId, title: 'Cinders' });
    await call(client, 'plant_clue', { campaign_id: campaignId, text: 'A signet ring in the ashes.', hidden: true });
    const found = await call<{ clue: Clue }>(client, 'find_clue', { campaign_id: campaignId, text: 'signet' });
    expect(found.clue).toMatchObject({ status: 'found', hidden: false });
    expect(campaignSnapshot(db, campaignId, { forPlayer: true }).story.clues).toHaveLength(1);
    await expect(call(client, 'find_clue', { campaign_id: campaignId, text: 'nothing like this' })).rejects.toThrow(
      /planted clue/,
    );
  });

  it('retires the rumours of a thread that is resolved', async () => {
    const client = await connect();
    const { thread } = await call<{ thread: PlotThread }>(client, 'add_plot_thread', {
      campaign_id: campaignId,
      title: 'Who set the fire?',
    });
    await call(client, 'add_rumour', {
      campaign_id: campaignId,
      text: 'The reeve was seen buying lamp oil.',
      thread_id: thread.id,
    });
    await call(client, 'get_rumours', { campaign_id: campaignId });
    expect(campaignSnapshot(db, campaignId).rumours).toHaveLength(1);

    await call(client, 'update_plot_thread', { campaign_id: campaignId, id: thread.id, status: 'resolved' });
    expect(campaignSnapshot(db, campaignId).rumours).toEqual([]);
    expect(campaignSnapshot(db, campaignId).story.threads).toEqual([]);
  });
});

describe('rumours', () => {
  it('hands out unheard rumours, marks them heard and keeps them in the briefing', async () => {
    const client = await connect();
    for (const text of ['The mill is haunted.', 'The road is closed.', 'The baron is dead.']) {
      await call(client, 'add_rumour', { campaign_id: campaignId, text, scope: 'region', truth: 'twisted' });
    }
    expect(campaignSnapshot(db, campaignId).rumours).toEqual([]);

    const handed = await call<{ rumours: Rumour[] }>(client, 'get_rumours', {
      campaign_id: campaignId,
      scope: 'region',
      limit: 2,
    });
    expect(handed.rumours).toHaveLength(2);
    for (const rumour of handed.rumours) expect(rumour.heard_at).not.toBeNull();

    const heard = campaignSnapshot(db, campaignId).rumours;
    expect(heard).toHaveLength(2);
    expect(dmBriefing()).toContain('## Heard');
    expect(dmBriefing()).toContain('[region] The baron is dead. (twisted');

    const again = await call<{ rumours: Rumour[] }>(client, 'get_rumours', { campaign_id: campaignId, limit: 5 });
    expect(again.rumours).toHaveLength(3);
    expect(campaignSnapshot(db, campaignId).rumours).toHaveLength(3);
  });

  it('hands the DM what the player has not heard before repeating the newest', async () => {
    const client = await connect();
    for (const text of ['The mill is haunted.', 'The road is closed.', 'The baron is dead.']) {
      await call(client, 'add_rumour', { campaign_id: campaignId, text, scope: 'region' });
    }
    // The two newest go out first; the oldest is then the only one still unheard.
    await call(client, 'get_rumours', { campaign_id: campaignId, limit: 2 });
    const next = await call<{ rumours: Rumour[] }>(client, 'get_rumours', { campaign_id: campaignId, limit: 1 });
    expect(next.rumours.map((r) => r.text)).toEqual(['The mill is haunted.']);
  });
});

describe('following a rumour to a clue', () => {
  it('links a threadless rumour to the thread of the clue that was found', async () => {
    const client = await connect();
    const { thread } = await call<{ thread: PlotThread }>(client, 'add_plot_thread', {
      campaign_id: campaignId,
      title: 'Who set the fire?',
    });
    const { rumour } = await call<{ rumour: Rumour }>(client, 'add_rumour', {
      campaign_id: campaignId,
      text: 'The reeve was seen buying lamp oil.',
    });
    expect(rumour.thread_id).toBeNull();
    const planted = await call<{ clue: Clue }>(client, 'plant_clue', {
      campaign_id: campaignId,
      text: 'A lamp-oil receipt.',
      thread_id: thread.id,
      hidden: true,
    });

    const found = await call<{ clue: Clue; rumour: Rumour | null; note: string | null }>(client, 'find_clue', {
      campaign_id: campaignId,
      id: planted.clue.id,
      rumour_id: rumour.id,
    });

    expect(found.note).toBeNull();
    expect(found.rumour?.thread_id).toBe(thread.id);
    expect(db.prepare('SELECT thread_id FROM rumour WHERE id = ?').get(rumour.id)).toEqual({ thread_id: thread.id });
  });

  it('leaves a rumour already on another thread alone and says so in the reply', async () => {
    const client = await connect();
    const { thread: first } = await call<{ thread: PlotThread }>(client, 'add_plot_thread', {
      campaign_id: campaignId,
      title: 'Who set the fire?',
    });
    const { thread: second } = await call<{ thread: PlotThread }>(client, 'add_plot_thread', {
      campaign_id: campaignId,
      title: 'Where did the reeve go?',
    });
    const { rumour } = await call<{ rumour: Rumour }>(client, 'add_rumour', {
      campaign_id: campaignId,
      text: 'The reeve was seen buying lamp oil.',
      thread_id: first.id,
    });
    const planted = await call<{ clue: Clue }>(client, 'plant_clue', {
      campaign_id: campaignId,
      text: 'A lamp-oil receipt.',
      thread_id: second.id,
      hidden: true,
    });

    const found = await call<{ clue: Clue; rumour: Rumour | null; note: string | null }>(client, 'find_clue', {
      campaign_id: campaignId,
      id: planted.clue.id,
      rumour_id: rumour.id,
    });

    expect(found.rumour?.thread_id).toBe(first.id);
    expect(found.note).toMatch(/thread/);
    expect(db.prepare('SELECT thread_id FROM rumour WHERE id = ?').get(rumour.id)).toEqual({ thread_id: first.id });
  });

  it('refuses an unknown rumour id before writing anything', async () => {
    const client = await connect();
    const planted = await call<{ clue: Clue }>(client, 'plant_clue', {
      campaign_id: campaignId,
      text: 'A lamp-oil receipt.',
      hidden: true,
    });

    await expect(
      call(client, 'find_clue', { campaign_id: campaignId, id: planted.clue.id, rumour_id: 9999 }),
    ).rejects.toThrow(/rumour/);
    expect(db.prepare('SELECT status FROM clue WHERE id = ?').get(planted.clue.id)).toEqual({ status: 'planted' });
  });
});

describe('a rumour is followed once a clue on its thread is found', () => {
  it('marks followed only after the clue is found, and never for a loose rumour', async () => {
    const thread = addPlotThread(db, { campaign_id: campaignId, title: 'Who set the fire?' });
    const onThread = addRumour(db, { campaign_id: campaignId, text: 'Oil was bought.', thread_id: thread.id });
    const loose = addRumour(db, { campaign_id: campaignId, text: 'Nothing follows this.' });

    const followedIds = (): number[] =>
      getRumours(db, campaignId, { for_player: true })
        .filter((rumour) => rumour.followed)
        .map((rumour) => rumour.id);

    expect(followedIds()).toEqual([]);

    const planted = plantClue(db, { campaign_id: campaignId, text: 'A lamp-oil receipt.', thread_id: thread.id });
    expect(followedIds()).toEqual([]);

    findClue(db, { campaign_id: campaignId, id: planted.id });
    expect(followedIds()).toEqual([onThread.id]);
    expect(loose.thread_id).toBeNull();
  });
});

describe('rumour truth in the player payload', () => {
  it('strips truth for an unresolved rumour and restores it once the rumour is resolved', async () => {
    const client = await connect();
    await call(client, 'story', { op: 'open_chapter', campaign_id: campaignId, title: 'Cinders' });
    const { thread } = await call<{ thread: PlotThread }>(client, 'add_plot_thread', {
      campaign_id: campaignId,
      title: 'Who set the fire?',
    });
    const { rumour } = await call<{ rumour: Rumour }>(client, 'add_rumour', {
      campaign_id: campaignId,
      text: 'The mill is haunted.',
      truth: 'false',
      thread_id: thread.id,
    });
    getRumours(db, campaignId, { mark_heard: true });

    const player = getRumours(db, campaignId, { heard_only: true, for_player: true }).find(
      (row) => row.id === rumour.id,
    );
    expect(player).toBeDefined();
    expect(player).not.toHaveProperty('truth');

    const snapshot = campaignSnapshot(db, campaignId, { forPlayer: true }).rumours.find((row) => row.id === rumour.id);
    expect(snapshot).toBeDefined();
    expect(snapshot).not.toHaveProperty('truth');

    expect(getRumours(db, campaignId).find((row) => row.id === rumour.id)?.truth).toBe('false');

    await call(client, 'update_plot_thread', { campaign_id: campaignId, id: thread.id, status: 'resolved' });
    const resolved = getRumours(db, campaignId, { heard_only: true, for_player: true }).find(
      (row) => row.id === rumour.id,
    );
    expect(resolved?.resolved).toBe(true);
    expect(resolved?.truth).toBe('false');
  });
});

describe('time and tables through the tools', () => {
  it('advances the clock and reports the new day', async () => {
    const client = await connect();
    const moved = await call<{ date_text: string; time_of_day: string; season: string; weather: string }>(
      client,
      'advance_time',
      { campaign_id: campaignId, days: 1, hours: 6 },
    );
    expect(moved.date_text).toBe('2 Deepfrost, year 1, 14:00');
    expect(moved.time_of_day).toBe('afternoon');
    expect(moved.season).toBe('winter');
    expect(dmBriefing()).toContain(`## Now`);
    expect(dmBriefing()).toContain(moved.weather);
  });

  it('sets the calendar outright, in the same shape advance_time returns plus the era', async () => {
    const client = await connect();
    const set = await call<{
      year: number;
      month: number;
      day: number;
      hour: number;
      minute: number;
      date_text: string;
      time_of_day: string;
      season: string;
      weather: string;
      era_name: string | null;
    }>(client, 'set_calendar', {
      campaign_id: campaignId,
      year: 1042,
      month: 9,
      day: 14,
      hour: 16,
      minute: 30,
      era_name: 'Third Age',
    });
    expect(set).toMatchObject({
      year: 1042,
      month: 9,
      day: 14,
      hour: 16,
      minute: 30,
      season: 'autumn',
      time_of_day: 'afternoon',
      era_name: 'Third Age',
    });
    expect(set.date_text).toBe('14 Harvestmoon, year 1042 (Third Age), 16:30');
    expect(dmBriefing()).toContain('14 Harvestmoon');

    const events = db
      .prepare("SELECT text FROM event WHERE campaign_id = ? AND kind = 'time'")
      .all(campaignId) as Array<{ text: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.text).toContain('The calendar is set to');

    await expect(call(client, 'set_calendar', { campaign_id: campaignId, day: 31 })).rejects.toThrow(/day/);
  });

  it('rolls a table deterministically from the tool', async () => {
    const client = await connect();
    const first = await call<{ result: string; seed: number }>(client, 'roll_table', {
      campaign_id: campaignId,
      table: 'names',
      key: 'eastern',
      seed: 42,
    });
    const second = await call<{ result: string }>(client, 'roll_table', { table: 'names', key: 'eastern', seed: 42 });
    expect(second.result).toBe(first.result);
    await expect(call(client, 'roll_table', { table: 'loot', key: 'wishes' })).rejects.toThrow(/CR number/);
  });
});

describe('the player journal', () => {
  it('reads back what the player wrote, and shows the last three in the briefing', async () => {
    const client = await connect();
    const { chapter } = await call<{ chapter: Chapter }>(client, 'story', {
      op: 'open_chapter',
      campaign_id: campaignId,
      title: 'Cinders',
    });
    for (const text of ['Day one: ash.', 'Day two: the road.', 'Day three: the gate.', 'Day four: the forge.']) {
      addJournalEntry(db, { campaign_id: campaignId, text });
    }
    const read = await call<{ journal: Array<{ text: string; chapter_id: number }> }>(client, 'read_journal', {
      campaign_id: campaignId,
    });
    expect(read.journal.map((j) => j.text)).toEqual([
      'Day one: ash.',
      'Day two: the road.',
      'Day three: the gate.',
      'Day four: the forge.',
    ]);
    expect(read.journal[0]!.chapter_id).toBe(chapter.id);

    const briefing = dmBriefing();
    expect(campaignSnapshot(db, campaignId).journal).toHaveLength(3);
    expect(briefing).toContain('## Journal');
    expect(briefing).toContain('Day four: the forge.');
    expect(briefing.split('## Journal')[1]).not.toContain('Day one: ash.');
  });
});

describe('the DM guide', () => {
  it('serves a bundled section and says so plainly when one is missing', async () => {
    const client = await connect();
    const story = await call<{ text: string; found: boolean }>(client, 'read_guide', { section: 'story' });
    expect(story.found).toBe(true);
    expect(story.text).toContain('# Running the story');
    for (const section of GUIDE_SECTIONS) {
      const page = await call<{ text: string; found: boolean }>(client, 'read_guide', { section });
      const bundled = existsSync(fileURLToPath(new URL(`../docs/guide/${section}.md`, import.meta.url)));
      expect(page.found).toBe(bundled);
      if (!bundled) expect(page.text).toContain('No guide page');
    }
  });
});

describe('story events for the player window', () => {
  it('logs a visible plot thread with its title and id', () => {
    const thread = addPlotThread(db, { campaign_id: campaignId, title: 'Who set the fire?' });
    const event = lastEvent();
    expect(event.kind).toBe('story');
    expect(event.text.startsWith('Thread opened:')).toBe(true);
    expect(event.text).toContain('Who set the fire?');
    expect(event.payload).toEqual({ thread_id: thread.id });
  });

  it("keeps a hidden plot thread's words out of the event", () => {
    const thread = addPlotThread(db, {
      campaign_id: campaignId,
      title: 'The smith is already dead',
      hidden: true,
    });
    const event = lastEvent();
    expect(event.kind).toBe('story');
    expect(event.text).toBe('A thread was opened.');
    for (const word of ['smith', 'already', 'dead']) expect(event.text.toLowerCase()).not.toContain(word);
    expect(event.payload).toEqual({ thread_id: thread.id });
  });

  it('logs a rumour as it would be heard, and never its truth', () => {
    const rumour = addRumour(db, { campaign_id: campaignId, text: 'The baron is dead.', truth: 'false' });
    const event = lastEvent();
    expect(event.kind).toBe('story');
    expect(event.text).toBe('Rumour heard: The baron is dead.');
    expect(event.payload).toEqual({ rumour_id: rumour.id, thread_id: null });
    expect(event.payload).not.toHaveProperty('truth');
  });

  it('keeps a planted clue a DM-only event the player window never receives', () => {
    const seen: string[] = [];
    const off = bus.subscribe((event) => seen.push(event.kind));
    try {
      const clue = plantClue(db, { campaign_id: campaignId, text: 'A boot print in the ash.', hidden: true });
      const event = lastEvent();
      expect(event.kind).toBe('clue_planted');
      expect(event.text).toBe('A clue was planted.');
      expect(event.payload).toEqual({ clue_id: clue.id });
      expect(seen).not.toContain('clue_planted');
    } finally {
      off();
    }
  });

  it('lets a visible planted clue refresh the window with a content-free story event', () => {
    const seen: string[] = [];
    const off = bus.subscribe((event) => seen.push(event.kind));
    try {
      const clue = plantClue(db, { campaign_id: campaignId, text: 'Scorch marks up the well shaft.' });
      const event = lastEvent();
      expect(event.kind).toBe('story');
      expect(event.text).toBe('A clue was planted.');
      expect(event.text).not.toContain('well');
      expect(event.payload).toEqual({ clue_id: clue.id });
      expect(seen).toContain('story');
    } finally {
      off();
    }
  });

  it('keeps the found-clue event unchanged', async () => {
    const client = await connect();
    await call(client, 'plant_clue', { campaign_id: campaignId, text: 'A signet ring in the ashes.', hidden: true });
    const found = await call<{ clue: Clue }>(client, 'find_clue', { campaign_id: campaignId, text: 'signet' });
    const event = lastEvent();
    expect(event.kind).toBe('story');
    expect(event.text).toBe('Clue found: A signet ring in the ashes.');
    expect(event.payload).toEqual({ clue_id: found.clue.id, thread_id: null });
  });

  it('logs a canon fact so the window refetches', () => {
    const fact = addCanonFact(db, { campaign_id: campaignId, subject: 'Mira', fact: 'Mira runs the inn.' });
    const event = lastEvent();
    expect(event.kind).toBe('story');
    expect(event.text).toBe('Canon: Mira runs the inn.');
    expect(event.payload).toEqual({ canon_fact_id: fact.id });
  });
});

describe('resolved threads reach the player window', () => {
  it('keeps a thread resolved in the current chapter, with its resolved status', () => {
    openChapter(db, { campaign_id: campaignId, title: 'Cinders' });
    const thread = addPlotThread(db, { campaign_id: campaignId, title: 'Who set the fire?' });
    updatePlotThread(db, { campaign_id: campaignId, id: thread.id, status: 'resolved' });

    const arc = storyArc(db, campaignId, { forPlayer: true });
    expect(arc.threads).toEqual([
      expect.objectContaining({ id: thread.id, status: 'resolved', chapter_id: expect.any(Number) }),
    ]);
  });

  it('drops a thread resolved outside the last few chapters', () => {
    openChapter(db, { campaign_id: campaignId, title: 'Cinders' });
    const thread = addPlotThread(db, { campaign_id: campaignId, title: 'Who set the fire?' });
    updatePlotThread(db, { campaign_id: campaignId, id: thread.id, status: 'resolved' });
    for (let i = 0; i < 4; i += 1) advanceChapter(db, { campaign_id: campaignId, summary: `Chapter ${i + 2}.` });
    // The chapters above open within the same instant as the resolution; in play the window is months.
    db.prepare("UPDATE plot_thread SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(thread.id);

    const arc = storyArc(db, campaignId, { forPlayer: true });
    expect(arc.threads.map((t) => t.id)).not.toContain(thread.id);
  });

  it('keeps a hidden resolved thread for the DM and the spoiler toggle only', () => {
    openChapter(db, { campaign_id: campaignId, title: 'Cinders' });
    const thread = addPlotThread(db, { campaign_id: campaignId, title: 'The smith is already dead', hidden: true });
    updatePlotThread(db, { campaign_id: campaignId, id: thread.id, status: 'dropped' });

    expect(storyArc(db, campaignId, { forPlayer: true }).threads).toEqual([]);
    setShowSecrets(true);
    expect(storyArc(db, campaignId, { forPlayer: true }).threads).toEqual([
      expect.objectContaining({ id: thread.id, status: 'dropped' }),
    ]);
  });

  it('leaves the DM-side arc open-threads-only', () => {
    openChapter(db, { campaign_id: campaignId, title: 'Cinders' });
    const open = addPlotThread(db, { campaign_id: campaignId, title: 'Who set the fire?' });
    const closed = addPlotThread(db, { campaign_id: campaignId, title: 'The gate' });
    updatePlotThread(db, { campaign_id: campaignId, id: closed.id, status: 'resolved' });

    const arc = storyArc(db, campaignId);
    expect(arc.threads.map((t) => t.id)).toEqual([open.id]);
  });

  it('admits a thread closed since the window began even when it was opened long before, and drops a stale one', () => {
    const stale = addPlotThread(db, { campaign_id: campaignId, title: 'The old road' });
    updatePlotThread(db, { campaign_id: campaignId, id: stale.id, status: 'resolved' });
    db.prepare("UPDATE plot_thread SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(stale.id);
    const fresh = addPlotThread(db, { campaign_id: campaignId, title: 'The well' });
    openChapter(db, { campaign_id: campaignId, title: 'Cinders' });
    updatePlotThread(db, { campaign_id: campaignId, id: fresh.id, status: 'resolved' });

    const ids = storyArc(db, campaignId, { forPlayer: true }).threads.map((t) => t.id);
    expect(ids).not.toContain(stale.id);
    expect(ids).toContain(fresh.id);
  });
});
