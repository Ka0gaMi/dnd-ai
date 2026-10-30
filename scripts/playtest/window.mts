import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserType, type Page } from 'playwright-core';

export const BROWSER_CHANNELS = ['msedge', 'chrome'] as const;

/** The roll card's own button (Roll, or Accept on a preview); the "Show the roll" strip button sits outside the section. */
const ROLL_BUTTON = 'section.prompt .buttons button.go:not([disabled])';

/** Only the built app renders this once a campaign is open; without web/dist the server answers a bare "Not found". */
export const APP_SELECTOR = 'main.triptych';

const VIEWPORT = { width: 1400, height: 900 };
/** Keeps one runaway column from making a giant image. */
const MAX_SHOT_HEIGHT = 5000;
// The wide layout scrolls inside each column rather than the page, so a shot needs the viewport as tall as the tallest column.
const TALLEST_COLUMN = `Math.ceil(Math.max(0, ...Array.from(document.querySelectorAll('.column'), (c) => c.getBoundingClientRect().top + c.scrollHeight)))`;

export const screenshotName = (n: number, label: string): string =>
  `${String(n).padStart(2, '0')}-${label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'shot'}.png`;

/** Launches the first installed browser channel, headless unless `headed`. */
export async function launchBrowser(
  launcher: Pick<BrowserType, 'launch'>,
  headed: boolean,
  channels: readonly string[] = BROWSER_CHANNELS,
): Promise<Browser> {
  const failures: string[] = [];
  for (const channel of channels) {
    try {
      return await launcher.launch({ channel, headless: !headed });
    } catch (error) {
      failures.push(`${channel}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  throw new Error(`No installed browser found (${failures.join('; ')})`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Throws, quoting what the page shows instead, unless the real app renders within `timeoutMs`. */
export async function assertRendered(page: Pick<Page, 'waitForSelector' | 'innerText'>, timeoutMs = 15_000): Promise<void> {
  try {
    await page.waitForSelector(APP_SELECTOR, { timeout: timeoutMs });
  } catch {
    const shown = (await page.innerText('body').catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error(`the companion app did not render (no ${APP_SELECTOR} within ${timeoutMs / 1000} s); the page shows "${shown}"`);
  }
}

async function waitHealthy(base: string): Promise<void> {
  for (let tries = 0; tries < 120; tries += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  throw new Error(`The window at ${base} never answered /healthz`);
}

export async function startWindow(opts: {
  port: number;
  campaignId: number | null;
  outDir: string;
  answerRolls: boolean;
}): Promise<{ setCampaign(id: number): Promise<void>; screenshot(label: string): Promise<string>; close(): Promise<void> }> {
  const base = `http://127.0.0.1:${opts.port}`;
  const urlFor = (id: number | null): string => (id === null ? `${base}/` : `${base}/?campaign=${id}`);
  mkdirSync(opts.outDir, { recursive: true });
  const browser = await launchBrowser(chromium, process.env.PLAYTEST_HEADED === '1');
  let closed = false;
  let shots = 0;
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page: Page = await context.newPage();
    const goto = async (id: number | null): Promise<void> => {
      await waitHealthy(base);
      await page.goto(urlFor(id), { waitUntil: 'domcontentloaded' });
    };
    await goto(opts.campaignId);
    if (opts.campaignId !== null) await assertRendered(page);

    const watcher = opts.answerRolls
      ? (async () => {
          while (!closed) {
            try {
              const button = page.locator(ROLL_BUTTON).first();
              if (await button.isVisible()) {
                const text = (await button.textContent())?.trim();
                await button.click({ timeout: 2000 });
                console.log(`[${new Date().toISOString()}] playtest window: clicked "${text}" on the roll card`);
              }
            } catch {
              /* the card moved on or the page is navigating; look again */
            }
            await sleep(300);
          }
        })()
      : Promise.resolve();

    return {
      async setCampaign(id) {
        await goto(id);
        await assertRendered(page);
      },
      async screenshot(label) {
        shots += 1;
        const path = join(opts.outDir, screenshotName(shots, label));
        const height = await page.evaluate<number>(TALLEST_COLUMN);
        await page.setViewportSize({ width: VIEWPORT.width, height: Math.min(Math.max(height, VIEWPORT.height), MAX_SHOT_HEIGHT) });
        try {
          await page.screenshot({ path, fullPage: true, timeout: 15_000 });
        } finally {
          await page.setViewportSize(VIEWPORT);
        }
        return path;
      },
      async close() {
        if (closed) return;
        closed = true;
        await watcher;
        await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 10_000).unref())]); // Edge can take a long time to exit; do not hang the run on it
      },
    };
  } catch (error) {
    closed = true;
    await browser.close();
    throw error;
  }
}
