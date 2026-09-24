// Generates a Perilous Shores region by driving the machine's installed Chrome or Edge headless
// through playwright-core, then returns the region JSON the app saves.
import { readFileSync } from 'node:fs';

export const REALM_BASE_URL = 'https://watabou.github.io/perilous-shores/';

/** The map side lengths the generator accepts through its hidden w/h parameters. */
export const REGION_SIZES = { small: 1200, medium: 2400, large: 3600 } as const;
export type RegionSize = keyof typeof REGION_SIZES;

/** A failed region fetch the caller can turn into a readable message. */
export class RealmFetchError extends Error {}

export interface FetchRealmOptions {
  timeoutMs?: number;
  channels?: Array<'chrome' | 'msedge'>;
  size?: RegionSize;
}

const NO_BROWSER_MESSAGE =
  'No Chrome or Edge browser was found to generate the region; upload a saved region JSON instead.';
const NO_FILE_MESSAGE =
  'Perilous Shores did not produce a region file (its page may have changed); upload a saved region JSON instead.';

/** Builds the generator URL for a seed, its tags and its map size; the seed must be a non-negative integer. */
export function realmUrl(seed: number, tags: string[], size: RegionSize = 'medium'): string {
  if (!Number.isInteger(seed) || seed < 0) {
    throw new RealmFetchError('The region seed must be a non-negative integer.');
  }
  const side = REGION_SIZES[size];
  const base = `${REALM_BASE_URL}?seed=${seed}`;
  const tagged = tags.length === 0 ? base : `${base}&tags=${tags.map((tag) => encodeURIComponent(tag)).join(',')}`;
  return `${tagged}&w=${side}&h=${side}`;
}

export async function fetchRealm(
  seed: number,
  tags: string[],
  options: FetchRealmOptions = {},
): Promise<{ raw: unknown; url: string }> {
  const timeout = options.timeoutMs ?? 60000;
  const channels = options.channels ?? ['chrome', 'msedge'];
  const size = options.size ?? 'medium';
  const { chromium } = await import('playwright-core');
  type Browser = Awaited<ReturnType<typeof chromium.launch>>;

  let browser: Browser | undefined;
  for (const channel of channels) {
    try {
      browser = await chromium.launch({ channel, headless: true });
      break;
    } catch {
      // This browser is not installed; try the next channel.
    }
  }
  if (!browser) throw new RealmFetchError(NO_BROWSER_MESSAGE);

  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    await page.goto(realmUrl(seed, tags, size), { waitUntil: 'networkidle', timeout });
    // A large map takes longer to settle than a medium or small one.
    await page.waitForTimeout(size === 'large' ? 6000 : 4000);
    const url = page.url();

    // The page margin outside the map never carries a region label, so the context menu has a fixed layout.
    await page.mouse.click(20, 20, { button: 'right' });
    await page.waitForTimeout(600);

    const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
    await page.mouse.move(73, 342);
    await page.mouse.click(73, 342);
    const download = await downloadPromise;

    const raw: unknown = JSON.parse(readFileSync(await download.path(), 'utf8'));
    if ((raw as { bp?: { seed?: unknown } }).bp?.seed !== seed) {
      throw new RealmFetchError('Perilous Shores returned a region file for a different seed than the one requested.');
    }
    return { raw, url };
  } catch (err) {
    if (err instanceof RealmFetchError) throw err;
    throw new RealmFetchError(NO_FILE_MESSAGE, { cause: err });
  } finally {
    await browser.close();
  }
}
