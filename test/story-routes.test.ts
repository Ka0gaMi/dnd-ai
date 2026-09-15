import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import {
  addPlotThread,
  addRumour,
  getRumours,
  openChapter,
  plantClue,
  setStoryOutline,
  updatePlotThread,
  type PlotThread,
} from '../src/core/story.js';
import { openDb, type Db } from '../src/db/connection.js';
import { HOST, startHttpServer } from '../src/transport/http.js';

let base: string;
let db: Db;
let campaignId: number;
let stop: () => Promise<void>;

beforeAll(async () => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Journal Test', story_shape: 'sandbox' }).campaign_id;
  openChapter(db, { campaign_id: campaignId, title: 'Cinders' });
  setStoryOutline(db, { campaign_id: campaignId, ending: 'The forge is put out.', secret_notes: 'The smith is dead.' });
  addPlotThread(db, { campaign_id: campaignId, title: 'Who set the fire?' });
  addPlotThread(db, { campaign_id: campaignId, title: 'The smith is dead', hidden: true });
  plantClue(db, { campaign_id: campaignId, text: 'A boot print in the ash.', hidden: true });
  addRumour(db, { campaign_id: campaignId, text: 'The mill is haunted.', scope: 'region' });
  addRumour(db, { campaign_id: campaignId, text: 'Nobody has said this one out loud.' });
  getRumours(db, campaignId, { scope: 'region', mark_heard: true });

  const started = await startHttpServer(db, { port: 0, secret: 'storyroutes0123456789abcdef01234' });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

const json = async (path: string): Promise<any> => (await fetch(`${base}${path}`)).json();

describe('the journal route', () => {
  it('takes an entry from the player and reads the journal back', async () => {
    const posted = await fetch(`${base}/api/campaigns/${campaignId}/journal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '  We left before the roof fell in.  ' }),
    });
    expect(posted.status).toBe(201);
    expect(await posted.json()).toMatchObject({ text: 'We left before the roof fell in.' });

    const entries = (await json(`/api/campaigns/${campaignId}/journal`)) as Array<{ text: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe('We left before the roof fell in.');
  });

  it('refuses an empty entry and a bad campaign id', async () => {
    const empty = await fetch(`${base}/api/campaigns/${campaignId}/journal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(empty.status).toBe(400);
    const missing = await fetch(`${base}/api/campaigns/9999/journal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'nowhere' }),
    });
    expect(missing.status).toBe(404);
  });
});

describe('the story and rumour routes', () => {
  it('leaves the DM secrets out of the story the player window reads', async () => {
    const story = await json(`/api/campaigns/${campaignId}/story`);
    expect(story.chapter.title).toBe('Cinders');
    expect(story.acts).toEqual([]);
    expect(story.now.season).toBe('winter');
    expect(story.outline.ending).toBe('The forge is put out.');
    expect(story.outline.secret_notes).toBeNull();
    expect(story.threads.map((t: { title: string }) => t.title)).toEqual(['Who set the fire?']);
    expect(story.clues).toEqual([]);
    expect((await fetch(`${base}/api/campaigns/abc/story`)).status).toBe(400);
    expect((await fetch(`${base}/api/campaigns/9999/story`)).status).toBe(404);
  });

  it('shows the player only the rumours they have heard', async () => {
    const heard = (await json(`/api/campaigns/${campaignId}/rumours`)) as Array<{ text: string }>;
    expect(heard.map((r) => r.text)).toEqual(['The mill is haunted.']);
    expect(await json(`/api/campaigns/${campaignId}/rumours?scope=location`)).toEqual([]);
    expect((await fetch(`${base}/api/campaigns/${campaignId}/rumours?scope=moon`)).status).toBe(400);
  });

  it('mutes a heard rumour, resolved: true, once its thread is retired', async () => {
    const thread = addPlotThread(db, { campaign_id: campaignId, title: 'Who set the fire?', hidden: false }) as PlotThread;
    addRumour(db, { campaign_id: campaignId, text: 'The reeve was seen buying lamp oil.', thread_id: thread.id });
    getRumours(db, campaignId, { mark_heard: true, limit: 10 });
    updatePlotThread(db, { campaign_id: campaignId, id: thread.id, status: 'resolved' });

    const rumours = (await json(`/api/campaigns/${campaignId}/rumours?limit=10`)) as Array<{
      text: string;
      resolved: boolean;
    }>;
    const muted = rumours.find((r) => r.text === 'The reeve was seen buying lamp oil.');
    expect(muted?.resolved).toBe(true);
  });
});
