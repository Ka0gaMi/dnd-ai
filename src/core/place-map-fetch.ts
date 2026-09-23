// Downloads the JSON export of a Watabou city, village or dungeon by driving the machine's
// installed Chrome or Edge headless through playwright-core.
import { readFileSync } from 'node:fs';

export type PlaceMapKind = 'city' | 'village' | 'dungeon';

/** A failed place-map fetch the caller can turn into a readable message. */
export class PlaceMapFetchError extends Error {}

export interface FetchPlaceMapOptions {
  timeoutMs?: number;
  channels?: Array<'chrome' | 'msedge'>;
}

const NO_BROWSER_MESSAGE = 'No Chrome or Edge browser was found to fetch this map.';
const NO_FILE_MESSAGE =
  'The map generator did not produce a map file (its page may have changed).';

// Menu coordinates verified on the live pages; they assume the 1400x900 viewport and a right-click at (20,20).
const MENU_COORDS: Record<PlaceMapKind, { exportY: number; jsonX: number; jsonY: number }> = {
  village: { exportY: 252, jsonX: 205, jsonY: 312 },
  city: { exportY: 158, jsonX: 190, jsonY: 218 },
  dungeon: { exportY: 312, jsonX: 190, jsonY: 372 },
};

/** Returns which Watabou generator a link points at, or null for anything else. */
export function placeMapKind(link: string): PlaceMapKind | null {
  if (!URL.canParse(link)) return null;
  const url = new URL(link);
  if (url.host !== 'watabou.github.io') return null;
  if (url.pathname.startsWith('/city-generator/')) return 'city';
  if (url.pathname.startsWith('/village-generator/')) return 'village';
  if (url.pathname.startsWith('/one-page-dungeon/')) return 'dungeon';
  return null;
}

function hasFeatureCollection(raw: unknown): boolean {
  const value = raw as { type?: unknown; features?: unknown };
  return value?.type === 'FeatureCollection' && Array.isArray(value.features);
}

function hasDungeonRects(raw: unknown): boolean {
  const value = raw as { title?: unknown; rects?: unknown };
  return typeof value?.title === 'string' && Array.isArray(value.rects);
}

export async function fetchPlaceMap(
  link: string,
  options: FetchPlaceMapOptions = {},
): Promise<{ kind: PlaceMapKind; raw: unknown; url: string }> {
  const kind = placeMapKind(link);
  if (!kind) throw new PlaceMapFetchError('Not a Watabou city, village or dungeon link.');

  const timeout = options.timeoutMs ?? 60000;
  const channels = options.channels ?? ['chrome', 'msedge'];
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
  if (!browser) throw new PlaceMapFetchError(NO_BROWSER_MESSAGE);

  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    await page.goto(link, { waitUntil: 'networkidle', timeout });
    await page.waitForTimeout(4000);
    const url = page.url();

    // The page margin outside the map never carries a map label, so the context menu has a fixed layout.
    await page.mouse.click(20, 20, { button: 'right' });
    await page.waitForTimeout(600);

    const { exportY, jsonX, jsonY } = MENU_COORDS[kind];
    await page.mouse.move(73, exportY);
    await page.waitForTimeout(600);

    const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
    await page.mouse.move(jsonX, exportY);
    await page.mouse.move(jsonX, jsonY);
    await page.mouse.click(jsonX, jsonY);
    const download = await downloadPromise;

    const raw: unknown = JSON.parse(readFileSync(await download.path(), 'utf8'));
    const valid = kind === 'dungeon' ? hasDungeonRects(raw) : hasFeatureCollection(raw);
    if (!valid) throw new Error('The downloaded map file has an unexpected shape.');

    return { kind, raw, url };
  } catch (err) {
    if (err instanceof PlaceMapFetchError) throw err;
    throw new PlaceMapFetchError(NO_FILE_MESSAGE, { cause: err });
  } finally {
    await browser.close();
  }
}
