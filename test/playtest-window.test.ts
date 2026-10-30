import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createPendingRoll, openPendingRolls } from '../src/core/rolls.js';
import { openDb, type Db } from '../src/db/connection.js';
import { startHttpServer } from '../src/transport/http.js';
import { BROWSER_CHANNELS, launchBrowser, screenshotName, startWindow } from '../scripts/playtest/window.mjs';

describe('playtest window helpers', () => {
  it('names screenshots with a zero-padded index and a safe label', () => {
    expect(screenshotName(3, 'after roll')).toBe('03-after-roll.png');
    expect(screenshotName(12, '../x/y')).toBe('12-x-y.png');
    expect(screenshotName(1, '///')).toBe('01-shot.png');
  });

  it('tries Edge, then Chrome, and reports when neither exists', async () => {
    expect(BROWSER_CHANNELS).toEqual(['msedge', 'chrome']);
    const tried: string[] = [];
    const fake = (okChannel: string | null) => ({
      launch: async (o: { channel?: string }) => {
        tried.push(o.channel!);
        if (o.channel !== okChannel) throw new Error('not installed\nlong');
        return { fake: true } as never;
      },
    });
    await launchBrowser(fake('chrome'), false);
    expect(tried).toEqual(['msedge', 'chrome']);
    await expect(launchBrowser(fake(null), false)).rejects.toThrow(/msedge: not installed.*chrome: not installed/);
  });
});

describe.skipIf(process.env.PLAYTEST_BROWSER !== '1')('playtest window in a real browser', () => {
  let db: Db;
  let stop: () => Promise<void>;
  let port: number;
  let outDir: string;

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'dnd-playtest-shots-'));
    db = openDb(':memory:');
    const started = await startHttpServer(db, { port: 0, secret: 'testsecret0123456789abcdef012345' });
    port = started.port;
    stop = started.close;
  });

  afterAll(async () => {
    await stop();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('answers a roll card and takes a screenshot', async () => {
    const campaignId = createCampaign(db, { name: 'Window', story_shape: 'sandbox', settings: { player_rolls: 'all' } }).campaign_id;
    createPendingRoll(db, { campaign_id: campaignId, expr: '1d20+2', purpose: 'Stealth check', dc: 10 });
    const win = await startWindow({ port, campaignId, outDir, answerRolls: true });
    try {
      for (let i = 0; i < 100 && openPendingRolls(db, campaignId).length > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(openPendingRolls(db, campaignId)).toHaveLength(0);
      const shot = await win.screenshot('after-roll');
      expect(shot).toBe(join(outDir, '01-after-roll.png'));
      expect(existsSync(shot)).toBe(true);
    } finally {
      await win.close();
    }
  }, 60_000);
});
