// Region generation as one job per campaign, shared by campaign creation, the window's region route and the
// DM's region {op: generate}, so two browser runs never race to import a map for the same campaign.
import type { Db } from '../db/connection.js';
import { getCampaign, logEvent } from './campaign.js';
import { randomSeed } from './dice.js';
import { fetchRealm, type RegionSize } from './realm-fetch.js';
import { assertReplaceable, getRegion, importRegion, type RegionView } from './region.js';

/** How long the DM's call waits on a job before answering that it is still running; safe for Claude and ChatGPT. */
export const REGION_HOLD_MS = 45_000;

export type RegionGenerator = (seed: number, tags: string[], size: RegionSize) => Promise<unknown>;

export interface RegionRequest {
  seed?: number;
  tags?: string[];
  size?: RegionSize;
  replace?: boolean;
}

const browser: RegionGenerator = async (seed, tags, size) => (await fetchRealm(seed, tags, { size })).raw;

let stub: { generate: RegionGenerator; holdMs: number } | null = null;

/** Test hook: a generator in place of the browser and a shorter hold; no argument restores both. */
export function stubRegionJobs(next?: { generate: RegionGenerator; holdMs: number }): void {
  stub = next ?? null;
}

/** Per database, like dedupe, so test databases with the same campaign ids never share a job. */
const jobs = new WeakMap<Db, Map<number, Promise<RegionView>>>();

const jobsOf = (db: Db): Map<number, Promise<RegionView>> => {
  const map = jobs.get(db) ?? new Map<number, Promise<RegionView>>();
  jobs.set(db, map);
  return map;
};

export const regionJobRunning = (db: Db, campaignId: number): boolean => jobsOf(db).has(campaignId);

/** A failure goes to the server log and the campaign's event log, never to a caller that did not wait. */
function reportFailure(db: Db, campaignId: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(new Date().toISOString(), `region for campaign ${campaignId} failed: ${message}`);
  try {
    logEvent(db, { campaign_id: campaignId, kind: 'system', text: `Region map generation failed: ${message}` });
  } catch {
    // The campaign or its database is gone; the server log has it.
  }
}

/** Joins the campaign's running job, or validates and starts one; the promise is the imported region. */
export function startRegionJob(db: Db, campaignId: number, request: RegionRequest = {}): Promise<RegionView> {
  const running = jobsOf(db).get(campaignId);
  if (running) return running;
  getCampaign(db, campaignId);
  assertReplaceable(db, campaignId, request.replace);
  const generate = stub?.generate ?? browser;
  const job = Promise.resolve()
    .then(() => generate(request.seed ?? randomSeed(), request.tags ?? [], request.size ?? 'medium'))
    .then((raw) => {
      // A map uploaded while this one generated is kept rather than refused.
      const uploaded = request.replace ? null : getRegion(db, campaignId);
      return uploaded ?? importRegion(db, campaignId, raw, { source: 'generated', replace: request.replace });
    });
  jobsOf(db).set(campaignId, job);
  const settle = (): void => {
    if (jobsOf(db).get(campaignId) === job) jobsOf(db).delete(campaignId);
  };
  job.then(settle, (err: unknown) => {
    settle();
    reportFailure(db, campaignId, err);
  });
  return job;
}

let background = false;

/** Switched on by the server entry points, so a library user or a test never drives a real browser unasked. */
export function enableBackgroundRegions(): void {
  background = true;
}

/** Starts a new campaign's region behind the reply that created it; it is never awaited and a failure only logs. */
export function startBackgroundRegion(db: Db, campaignId: number): void {
  if (!background && stub === null) return;
  void startRegionJob(db, campaignId);
}

/** The job's region if it lands within the hold, else null; a failed job rejects. */
export async function holdRegionJob(job: Promise<RegionView>): Promise<RegionView | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hold = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), stub?.holdMs ?? REGION_HOLD_MS);
  });
  try {
    return await Promise.race([job, hold]);
  } finally {
    clearTimeout(timer);
  }
}
