// Downloads the JSON floor plan of a Watabou Dwellings building by driving the machine's
// installed Chrome or Edge headless through playwright-core.
import { readFileSync } from 'node:fs';

/** A failed building fetch the caller can turn into a readable message. */
export class BuildingFetchError extends Error {}

export interface FetchBuildingPlanOptions {
  timeoutMs?: number;
  channels?: Array<'chrome' | 'msedge'>;
}

const NO_BROWSER_MESSAGE = 'No Chrome or Edge browser was found to fetch this floor plan.';
const NO_FILE_MESSAGE =
  'Dwellings did not produce a floor plan file (its page may have changed).';

// Menu points verified on the live pages; they assume the 1400x900 viewport and a right-click in
// open space, because the top-left corner holds a toolbar button.
const POINTS = {
  openSpace: { x: 300, y: 120 },
  exportRow: { x: 343, y: 444 },
  jsonColumn: { x: 482, y: 444 },
  jsonRow: { x: 482, y: 504 },
} as const;

/** True when a link points at the Watabou Dwellings generator. */
export function isDwellingsUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.host === 'watabou.github.io' && parsed.pathname.startsWith('/dwellings/');
}

function hasFloors(raw: unknown): boolean {
  const value = raw as { floors?: unknown };
  if (!Array.isArray(value?.floors)) return false;
  return value.floors.every((floor) => {
    const item = floor as { level?: unknown; rooms?: unknown };
    return typeof item?.level === 'number' && Array.isArray(item.rooms);
  });
}

export async function fetchBuildingPlan(
  url: string,
  options: FetchBuildingPlanOptions = {},
): Promise<{ raw: unknown; url: string }> {
  if (!isDwellingsUrl(url)) throw new BuildingFetchError('Not a Watabou Dwellings link.');

  const timeout = options.timeoutMs ?? 35000;
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
  if (!browser) throw new BuildingFetchError(NO_BROWSER_MESSAGE);

  try {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 900 },
      acceptDownloads: true,
    });
    await page.goto(url, { waitUntil: 'networkidle', timeout });
    await page.waitForTimeout(3500);
    const finalUrl = page.url();

    await page.mouse.click(POINTS.openSpace.x, POINTS.openSpace.y, { button: 'right' });
    await page.waitForTimeout(500);

    await page.mouse.move(POINTS.exportRow.x, POINTS.exportRow.y);
    await page.waitForTimeout(600);

    const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
    await page.mouse.move(POINTS.jsonColumn.x, POINTS.jsonColumn.y);
    await page.mouse.move(POINTS.jsonRow.x, POINTS.jsonRow.y);
    await page.mouse.click(POINTS.jsonRow.x, POINTS.jsonRow.y);
    const download = await downloadPromise;

    const raw: unknown = JSON.parse(readFileSync(await download.path(), 'utf8'));
    if (!hasFloors(raw)) throw new Error('The downloaded floor plan file has an unexpected shape.');

    return { raw, url: finalUrl };
  } catch (err) {
    if (err instanceof BuildingFetchError) throw err;
    throw new BuildingFetchError(NO_FILE_MESSAGE, { cause: err });
  } finally {
    await browser.close();
  }
}
