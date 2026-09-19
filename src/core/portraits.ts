// Portraits for the party and for named enemies: generated for free through Cloudflare Workers AI,
// or dropped in by the player. Files live under data/portraits/, served at /portraits/.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/connection.js';
import { logEvent } from './campaign.js';

export type PortraitStyle = 'painterly' | 'ink' | 'realistic';
/** A portrait shared by every creature of a type, or one belonging to a single named individual. */
export type CreaturePortraitKind = 'type' | 'individual';
export type PortraitSubject =
  | { character_id: number }
  /** variant adds another portrait for the type instead of replacing the ones already stored. */
  | { creature: string; kind?: CreaturePortraitKind; variant?: boolean };
export type PortraitSource = 'generated' | 'upload';

/** How many portraits one creature type may hold in a campaign; combatants are dealt them in turn. */
export const MAX_VARIANTS = 4;

const MODEL = '@cf/black-forest-labs/flux-1-schnell';
const STEPS = 4;
const RATE_LIMIT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

const STYLE_WORDS: Record<PortraitStyle, string> = {
  painterly: 'painterly digital art, soft brush strokes, warm light',
  ink: 'black and white ink illustration, cross-hatching, high contrast',
  realistic: 'photorealistic, cinematic lighting, fine detail',
};

export const PORTRAITS_DISABLED_MESSAGE =
  'Portrait generation is not configured on this machine (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are not set). Say so once and carry on; the player can drop an image onto the character in the companion window instead.';

/** Where portrait files are written; DND_AI_PORTRAITS_DIR overrides it for tests. */
export function portraitsDir(): string {
  return process.env.DND_AI_PORTRAITS_DIR ?? fileURLToPath(new URL('../../data/portraits/', import.meta.url));
}

export function portraitsEnabled(): boolean {
  return Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
}

interface SubjectInfo {
  kind: 'character' | 'creature';
  key: string;
  name: string;
  /** Species and class for a character, "monster" for a creature: what the model should draw. */
  descriptor: string;
  creatureKind: CreaturePortraitKind;
  variant: boolean;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unnamed';
}

function resolveSubject(db: Db, campaignId: number, subject: PortraitSubject): SubjectInfo {
  if ('creature' in subject) {
    const creature = subject.creature.trim();
    if (!creature) throw new Error('creature must be a name, for example "Goblin Warrior".');
    const variant = subject.variant === true;
    if (variant && creaturePortraitPaths(db, campaignId, creature).length >= MAX_VARIANTS) {
      throw new Error(`${creature} already has ${MAX_VARIANTS} portraits in this campaign; that is the cap.`);
    }
    return {
      kind: 'creature',
      key: slug(creature),
      name: creature,
      descriptor: 'monster',
      creatureKind: subject.kind ?? 'type',
      variant,
    };
  }
  const row = db
    .prepare('SELECT name, species, class FROM character WHERE id = ? AND campaign_id = ?')
    .get(subject.character_id, campaignId) as { name: string; species: string; class: string | null } | undefined;
  if (!row) {
    throw new Error(
      `Campaign ${campaignId} has no character with id ${subject.character_id}. The briefing lists who is in it.`,
    );
  }
  return {
    kind: 'character',
    key: String(subject.character_id),
    name: row.name,
    descriptor: row.class ? `${row.species} ${row.class}` : row.species,
    creatureKind: 'type',
    variant: false,
  };
}

export function buildPortraitPrompt(subject: { name: string; descriptor: string }, description: string, style: PortraitStyle): string {
  return [
    `head-and-shoulders fantasy portrait of ${subject.name}`,
    subject.descriptor,
    description.trim(),
    STYLE_WORDS[style],
    'neutral background',
    'no text',
  ]
    .filter((part) => part.length > 0)
    .join(', ');
}

/** At most one generated portrait per subject per minute, so a retry loop cannot burn the free tier. */
const lastGenerated = new Map<string, number>();

/** Test hook: the rate limiter is module state and every test starts from a fresh database. */
export function clearPortraitRateLimit(): void {
  lastGenerated.clear();
}

function checkRateLimit(campaignId: number, subject: SubjectInfo): void {
  const key = `${campaignId}:${subject.kind}:${subject.key}`;
  const previous = lastGenerated.get(key);
  const now = Date.now();
  if (previous !== undefined && now - previous < RATE_LIMIT_MS) {
    const wait = Math.ceil((RATE_LIMIT_MS - (now - previous)) / 1000);
    throw new Error(`A portrait for ${subject.name} was just generated; wait ${wait}s before generating another.`);
  }
  lastGenerated.set(key, now);
}

function extensionOf(bytes: Buffer): 'png' | 'jpg' {
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return jpeg ? 'jpg' : 'png';
}

/** Writes the image, points the subject at it and tells the companion window. Returns the served path. */
function storePortrait(
  db: Db,
  campaignId: number,
  subject: SubjectInfo,
  bytes: Buffer,
  source: PortraitSource,
): string {
  const dir = join(portraitsDir(), String(campaignId));
  mkdirSync(dir, { recursive: true });
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  const file = `${subject.kind}-${subject.key}-${hash}.${extensionOf(bytes)}`;
  writeFileSync(join(dir, file), bytes);
  const path = `/portraits/${campaignId}/${file}`;
  const ts = new Date().toISOString();

  db.transaction(() => {
    if (subject.kind === 'character') {
      db.prepare('UPDATE character SET portrait_path = ?, updated_at = ? WHERE id = ?').run(path, ts, Number(subject.key));
    } else {
      // A variant joins the ones already stored; anything else replaces them.
      if (!subject.variant) {
        db.prepare('DELETE FROM creature_portrait WHERE creature = ? AND campaign_id IS ? AND kind = ?').run(
          subject.name,
          campaignId,
          subject.creatureKind,
        );
      }
      db.prepare(
        'INSERT INTO creature_portrait (creature, campaign_id, path, kind, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(subject.name, campaignId, path, subject.creatureKind, ts);
    }
  })();

  logEvent(db, {
    campaign_id: campaignId,
    kind: 'portrait',
    text: `${subject.name} gets a portrait.`,
    payload: {
      subject: subject.kind,
      ...(subject.kind === 'character' ? { character_id: Number(subject.key) } : { creature: subject.name }),
      path,
      source,
    },
  });
  return path;
}

interface WorkersAiResponse {
  result?: { image?: string };
  errors?: Array<{ message?: string }>;
}

/** The one HTTP call to Workers AI. Never puts the token anywhere but the Authorization header. */
async function runFlux(prompt: string): Promise<Buffer> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID!;
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MODEL}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN!}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prompt, steps: STEPS }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Could not reach Cloudflare Workers AI: ${(err as Error).message}.`);
  }
  const body = (await response.json().catch(() => ({}))) as WorkersAiResponse;
  if (!response.ok) {
    const detail = body.errors?.map((e) => e.message).filter(Boolean).join('; ');
    const hint =
      response.status === 401 || response.status === 403
        ? ' Check that the API token has Account -> Workers AI -> Read and matches the account id.'
        : response.status === 429
          ? ' The free Workers AI allowance for today is used up; try again tomorrow.'
          : '';
    throw new Error(`Cloudflare Workers AI refused the portrait (HTTP ${response.status}${detail ? `: ${detail}` : ''}).${hint}`);
  }
  const image = body.result?.image;
  if (typeof image !== 'string' || image.length === 0) {
    throw new Error('Cloudflare Workers AI returned no image.');
  }
  return Buffer.from(image, 'base64');
}

export interface GeneratePortraitInput {
  db: Db;
  campaign_id: number;
  subject: PortraitSubject;
  description: string;
  style?: PortraitStyle;
}

export async function generatePortrait(
  input: GeneratePortraitInput,
): Promise<{ name: string; path: string; prompt: string; style: PortraitStyle }> {
  if (!portraitsEnabled()) throw new Error(PORTRAITS_DISABLED_MESSAGE);
  const subject = resolveSubject(input.db, input.campaign_id, input.subject);
  const style = input.style ?? 'painterly';
  const prompt = buildPortraitPrompt(subject, input.description, style);
  checkRateLimit(input.campaign_id, subject);
  const bytes = await runFlux(prompt);
  return { name: subject.name, path: storePortrait(input.db, input.campaign_id, subject, bytes, 'generated'), prompt, style };
}

/** The drag-and-drop fallback: the player supplies the image, everything else is the same. */
export function savePortraitUpload(input: {
  db: Db;
  campaign_id: number;
  subject: PortraitSubject;
  bytes: Buffer;
}): { name: string; path: string } {
  const subject = resolveSubject(input.db, input.campaign_id, input.subject);
  return { name: subject.name, path: storePortrait(input.db, input.campaign_id, subject, input.bytes, 'upload') };
}

/** The campaign's portrait for a creature, falling back to one shared by every campaign. */
export function creaturePortraitPath(db: Db, campaignId: number | null, creature: string): string | null {
  const row = db
    .prepare(
      `SELECT path FROM creature_portrait WHERE creature = ? AND (campaign_id IS ? OR campaign_id IS NULL)
         ORDER BY campaign_id IS NULL, id DESC LIMIT 1`,
    )
    .get(creature.trim(), campaignId) as { path: string } | undefined;
  return row?.path ?? null;
}

/** Every generic portrait a creature type holds here, oldest first: the variants a fight deals out. */
export function creaturePortraitPaths(db: Db, campaignId: number, creature: string): string[] {
  return (
    db
      .prepare(
        `SELECT path FROM creature_portrait WHERE creature = ? AND (campaign_id IS ? OR campaign_id IS NULL)
           AND kind = 'type' ORDER BY id`,
      )
      .all(creature.trim(), campaignId) as Array<{ path: string }>
  ).map((row) => row.path);
}

/** The portrait of one named individual in this campaign, e.g. "Grask the Bloody". */
export function individualPortraitPath(db: Db, campaignId: number, name: string): string | null {
  const row = db
    .prepare(
      `SELECT path FROM creature_portrait WHERE creature = ? AND campaign_id IS ? AND kind = 'individual'
         ORDER BY id DESC LIMIT 1`,
    )
    .get(name.trim(), campaignId) as { path: string } | undefined;
  return row?.path ?? null;
}
