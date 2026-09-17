import { beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import { advanceChapter, openChapter } from '../src/core/story.js';
import { openDb, type Db } from '../src/db/connection.js';
import { renderBriefing } from '../src/mcp/tools/campaign.js';

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

/** Closes `count` chapters, each with a recap, and leaves the next one open. */
function playChapters(count: number): void {
  openChapter(db, { campaign_id: campaignId, title: 'Chapter 1' });
  for (let n = 1; n <= count; n += 1) {
    advanceChapter(db, { campaign_id: campaignId, summary: `What happened in chapter ${n}.` });
  }
}

function closedInDb(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM chapter WHERE campaign_id = ? AND status = 'closed'").get(campaignId) as {
      n: number;
    }
  ).n;
}

describe('the chapter timeline', () => {
  it('hands the player every closed chapter, past the six the DM briefing carries', () => {
    playChapters(9);
    expect(closedInDb()).toBe(9);

    const recaps = campaignSnapshot(db, campaignId, { forPlayer: true }).story.recaps;
    expect(recaps).toHaveLength(9);
    expect(recaps.map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(recaps.at(-1)!.summary).toBe('What happened in chapter 9.');
  });

  it('keeps the DM briefing to the newest six, so its prompt does not grow with the campaign', () => {
    playChapters(9);

    const dm = campaignSnapshot(db, campaignId);
    expect(dm.story.recaps.map((r) => r.number)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(renderBriefing(dm).match(/^- \d+\. /gm)).toHaveLength(6);
  });

  it('leaves the panel a count it can deliver: the offer equals the chapters it can reveal', () => {
    playChapters(12);
    const recaps = campaignSnapshot(db, campaignId, { forPlayer: true }).story.recaps;
    // The panel reads recaps newest first and opens on the newest three; the offer is what is left.
    const newestFirst = [...recaps].reverse();
    const opened = newestFirst.slice(0, 3);
    const revealed = newestFirst.slice(3);

    expect(opened.map((r) => r.number)).toEqual([12, 11, 10]);
    expect(revealed.map((r) => r.number)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(revealed).toHaveLength(recaps.length - 3);
    expect(opened.length + revealed.length).toBe(closedInDb());
  });
});
