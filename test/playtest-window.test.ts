import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { createDecision, getDecision } from '../src/core/decisions.js';
import { powerReport } from '../src/core/progression.js';
import { createPendingRoll, openPendingRolls } from '../src/core/rolls.js';
import { openDb, type Db } from '../src/db/connection.js';
import { startHttpServer } from '../src/transport/http.js';
import {
  APP_SELECTOR,
  assertRendered,
  BROWSER_CHANNELS,
  DECISION_ACCEPT,
  launchBrowser,
  pressButton,
  screenshotName,
  startWindow,
} from '../scripts/playtest/window.mjs';

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

  it('passes a page that rendered the app and names what a broken one shows instead', async () => {
    const waited: Array<[string, number | undefined]> = [];
    const page = (rendered: boolean) =>
      ({
        waitForSelector: async (selector: string, o?: { timeout?: number }) => {
          waited.push([selector, o?.timeout]);
          if (!rendered) throw new Error('Timeout 50ms exceeded.');
          return null;
        },
        innerText: async () => '  Not found\n',
      }) as never;
    await expect(assertRendered(page(true), 50)).resolves.toBeUndefined();
    expect(waited).toEqual([[APP_SELECTOR, 50]]);
    await expect(assertRendered(page(false), 50)).rejects.toThrow(/did not render .*the page shows "Not found"/);
  });

  it('clicks a showing button and returns its text, and leaves the page alone when none shows', async () => {
    const clicked: Array<{ selector: string; timeout?: number }> = [];
    const page = (visible: boolean) =>
      ({
        locator: (selector: string) => ({
          first: () => ({
            isVisible: async () => visible,
            textContent: async () => '  Accept \n',
            click: async (o?: { timeout?: number }) => {
              clicked.push({ selector, timeout: o?.timeout });
            },
          }),
        }),
      }) as never;
    expect(await pressButton(page(true), DECISION_ACCEPT)).toBe('Accept');
    expect(clicked).toEqual([{ selector: DECISION_ACCEPT, timeout: 2000 }]);
    expect(await pressButton(page(false), DECISION_ACCEPT)).toBeNull();
    expect(clicked).toHaveLength(1);
  });

  it("aims at the decision dialog's Accept, the only go button in its row of answers", () => {
    expect(DECISION_ACCEPT).toBe('section.decision .buttons button.go:not([disabled])');
    const dialog = readFileSync(new URL('../web/src/components/DecisionDialog.svelte', import.meta.url), 'utf8');
    expect(dialog).toContain('<section class="decision">');
    const answers = (dialog.match(/<div class="buttons">[\s\S]*?<\/div>/g) ?? []).find((row) => row.includes("answer('accept')"));
    expect(answers?.match(/class="go"/g)).toHaveLength(1);
    expect(answers).toMatch(/class="go"[^\n]*answer\('accept'\)/);
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

  it('accepts a homebrew decision in its dialog', async () => {
    const campaignId = createCampaign(db, { name: 'Decision', story_shape: 'sandbox' }).campaign_id;
    createCharacter(db, {
      campaign_id: campaignId,
      name: 'Bram',
      species: 'Human',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception', 'insight'],
    });
    const decision = createDecision(db, {
      campaign_id: campaignId,
      kind: 'homebrew_feature',
      payload: { name: 'Hammer Knock', text: 'Hammer Knock', mechanics: {}, report: powerReport({}), character_id: null },
    });
    const win = await startWindow({ port, campaignId, outDir, answerRolls: false, answerDecisions: true });
    try {
      for (let i = 0; i < 100 && getDecision(db, decision.id)?.resolved_at === null; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(JSON.parse(getDecision(db, decision.id)?.decision_json ?? 'null')).toMatchObject({ decision: 'accept', applied: true });
    } finally {
      await win.close();
    }
  }, 60_000);
});
