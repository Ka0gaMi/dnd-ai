import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startEncounter, type EnemySpec } from '../src/combat/engine.js';
import { getBattleState, type CombatantView } from '../src/combat/state.js';
import { flushPortraitQueue } from '../src/core/auto-portraits.js';
import { bus, type GameEvent } from '../src/core/bus.js';
import { createCampaign } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import {
  buildEmblemPrompt,
  buildPortraitPrompt,
  clearPortraitRateLimit,
  creaturePortraitPath,
  generatePortrait,
  portraitsEnabled,
  savePortraitUpload,
} from '../src/core/portraits.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';

// A 1x1 transparent PNG, small enough to keep in the test and still a real image file.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let db: Db;
let campaignId: number;
let characterId: number;
let portraitsRoot: string;

function portraitFile(path: string): string {
  return join(portraitsRoot, path.replace('/portraits/', ''));
}

function mockFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ result: { image: PNG_BASE64 }, success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

beforeEach(() => {
  db = openDb(':memory:');
  portraitsRoot = mkdtempSync(join(tmpdir(), 'dnd-portraits-'));
  process.env.DND_AI_PORTRAITS_DIR = portraitsRoot;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  clearPortraitRateLimit();
  campaignId = createCampaign(db, { name: 'Portrait Test', story_shape: 'sandbox' }).campaign_id;
  characterId = createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  }).character!.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DND_AI_PORTRAITS_DIR;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  rmSync(portraitsRoot, { recursive: true, force: true });
});

function enable(): void {
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acc123';
  process.env.CLOUDFLARE_API_TOKEN = 'tok456';
}

describe('portrait prompts and configuration', () => {
  it('builds a prompt from the subject, the description and the style', () => {
    expect(buildPortraitPrompt({ name: 'Borg', descriptor: 'Dwarf Fighter' }, 'braided red beard, dented helm', 'painterly')).toBe(
      'head-and-shoulders fantasy portrait of Borg, Dwarf Fighter, braided red beard, dented helm, painterly digital art, soft brush strokes, warm light, neutral background, no text',
    );
    expect(buildPortraitPrompt({ name: 'Goblin Boss', descriptor: 'monster' }, 'scarred', 'ink')).toContain(
      'head-and-shoulders fantasy portrait of Goblin Boss, monster, scarred, black and white ink illustration',
    );
  });

  it('builds an emblem prompt from the description and the style', () => {
    const emblem = buildEmblemPrompt('a silver hammer over a flaming anvil', 'painterly');
    expect(emblem).toContain('a silver hammer over a flaming anvil');
    expect(emblem).toContain('painterly digital art, soft brush strokes, warm light');
    expect(emblem).toContain('centered emblem, plain parchment background');
    expect(emblem).toContain('no text');
    expect(emblem).not.toContain('portrait');
    expect(emblem).not.toContain('head-and-shoulders');
    expect(buildEmblemPrompt('   ', 'ink')).toBe(
      'black and white ink illustration, cross-hatching, high contrast, centered emblem, plain parchment background, no text, no letters, no people',
    );
  });

  it('is enabled only when both Cloudflare variables are set', () => {
    expect(portraitsEnabled()).toBe(false);
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acc123';
    expect(portraitsEnabled()).toBe(false);
    process.env.CLOUDFLARE_API_TOKEN = 'tok456';
    expect(portraitsEnabled()).toBe(true);
  });

  it('tells the DM it is unavailable without calling Cloudflare', async () => {
    const fetchMock = mockFetch();
    const client = await connect();
    const result = await client.callTool({
      name: 'generate_portrait',
      arguments: { campaign_id: campaignId, character_id: characterId, description: 'a dwarf' },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { generated: boolean; enabled: boolean; message: string };
    expect(structured).toMatchObject({ generated: false, enabled: false });
    expect(structured.message).toContain('CLOUDFLARE_ACCOUNT_ID');
    expect(fetchMock).not.toHaveBeenCalled();
    await client.close();
  });
});

describe('generating a portrait', () => {
  it('writes the file, stores the path on the character and emits a portrait event', async () => {
    enable();
    const fetchMock = mockFetch();
    const events: GameEvent[] = [];
    const unsubscribe = bus.subscribe((event) => events.push(event));

    const portrait = await generatePortrait({
      db,
      campaign_id: campaignId,
      subject: { character_id: characterId },
      description: 'braided red beard',
      style: 'realistic',
    });
    unsubscribe();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/black-forest-labs/flux-1-schnell');
    expect(JSON.parse(String(init.body))).toMatchObject({ prompt: portrait.prompt, steps: 4 });
    expect(portrait.prompt).toContain('Borg, Dwarf Fighter, braided red beard, photorealistic');

    expect(portrait.path).toMatch(new RegExp(`^/portraits/${campaignId}/character-${characterId}-[0-9a-f]{8}\\.png$`));
    expect(existsSync(portraitFile(portrait.path))).toBe(true);
    expect(readFileSync(portraitFile(portrait.path)).toString('base64')).toBe(PNG_BASE64);

    const row = db.prepare('SELECT portrait_path FROM character WHERE id = ?').get(characterId) as {
      portrait_path: string;
    };
    expect(row.portrait_path).toBe(portrait.path);
    expect(events.filter((e) => e.kind === 'portrait')).toHaveLength(1);
    expect(events.find((e) => e.kind === 'portrait')?.payload).toMatchObject({
      subject: 'character',
      character_id: characterId,
      path: portrait.path,
      source: 'generated',
    });
  });

  it('draws an emblem instead of a portrait when framing is emblem', async () => {
    enable();
    const fetchMock = mockFetch();
    const portrait = await generatePortrait({
      db,
      campaign_id: campaignId,
      subject: { character_id: characterId },
      description: 'a silver hammer over a flaming anvil',
      framing: 'emblem',
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body)).prompt as string;
    expect(sent).toBe(portrait.prompt);
    expect(sent).toContain('a silver hammer over a flaming anvil');
    expect(sent).toContain('centered emblem, plain parchment background');
    expect(sent).not.toContain('head-and-shoulders');
    expect(sent).not.toContain('portrait');
  });

  it('defaults to a head-and-shoulders portrait', async () => {
    enable();
    const fetchMock = mockFetch();
    const portrait = await generatePortrait({
      db,
      campaign_id: campaignId,
      subject: { character_id: characterId },
      description: 'braided red beard',
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body)).prompt as string;
    expect(sent).toBe(portrait.prompt);
    expect(sent).toContain('head-and-shoulders fantasy portrait of Borg');
  });

  it('keeps a creature portrait under its name and serves it back', async () => {
    enable();
    mockFetch();
    const portrait = await generatePortrait({
      db,
      campaign_id: campaignId,
      subject: { creature: 'Goblin Boss' },
      description: 'scarred, iron crown',
    });
    expect(portrait.path).toContain(`/portraits/${campaignId}/creature-goblin-boss-`);
    expect(creaturePortraitPath(db, campaignId, 'goblin boss')).toBe(portrait.path);
    expect(creaturePortraitPath(db, campaignId, 'Bugbear')).toBeNull();
  });

  it('refuses a second generation for the same subject within a minute', async () => {
    enable();
    mockFetch();
    await generatePortrait({ db, campaign_id: campaignId, subject: { character_id: characterId }, description: 'a dwarf' });
    await expect(
      generatePortrait({ db, campaign_id: campaignId, subject: { character_id: characterId }, description: 'a dwarf again' }),
    ).rejects.toThrow(/wait \d+s/);
    // Another subject is unaffected.
    await expect(
      generatePortrait({ db, campaign_id: campaignId, subject: { creature: 'Goblin Boss' }, description: 'scarred' }),
    ).resolves.toMatchObject({ name: 'Goblin Boss' });
  });

  it('turns a Cloudflare failure into a message the DM can read', async () => {
    enable();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ errors: [{ message: 'Authentication error' }] }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(
      generatePortrait({ db, campaign_id: campaignId, subject: { character_id: characterId }, description: 'a dwarf' }),
    ).rejects.toThrow(/HTTP 403: Authentication error.*Workers AI -> Read/s);
  });
});

describe('uploaded portraits', () => {
  it('stores an uploaded image for a character and for a creature', () => {
    const bytes = Buffer.from(PNG_BASE64, 'base64');
    const forCharacter = savePortraitUpload({ db, campaign_id: campaignId, subject: { character_id: characterId }, bytes });
    expect(existsSync(portraitFile(forCharacter.path))).toBe(true);

    const forCreature = savePortraitUpload({ db, campaign_id: campaignId, subject: { creature: 'Goblin Boss' }, bytes });
    expect(creaturePortraitPath(db, campaignId, 'Goblin Boss')).toBe(forCreature.path);
  });

  it('reports an unknown character clearly', () => {
    expect(() =>
      savePortraitUpload({ db, campaign_id: campaignId, subject: { character_id: 999 }, bytes: Buffer.from(PNG_BASE64, 'base64') }),
    ).toThrow(/no character with id 999/);
  });
});

describe('portraits that happen by themselves', () => {
  /** Every call answers with a different image, so two portraits never land on the same file. */
  function mockVariedFetch(): ReturnType<typeof vi.fn> {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      const image = Buffer.concat([Buffer.from(PNG_BASE64, 'base64'), Buffer.from([n])]).toString('base64');
      return new Response(JSON.stringify({ result: { image }, success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  /** A campaign whose player never clicks dice, so initiative does not wait for anyone. */
  function fightCampaign(): number {
    const id = createCampaign(db, {
      name: 'Fight',
      story_shape: 'sandbox',
      settings: { player_rolls: 'none' },
    }).campaign_id;
    createCharacter(db, {
      campaign_id: id,
      name: 'Vanna',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    });
    return id;
  }

  async function fight(id: number, enemies: EnemySpec[]): Promise<CombatantView[]> {
    await startEncounter(db, { campaign_id: id, seed: 7, terrain: 'road', size: 'small', enemies });
    await flushPortraitQueue();
    return getBattleState(db, id)!.combatants.filter((c) => c.kind === 'monster');
  }

  it('draws a new character without the DM asking', async () => {
    enable();
    const fetchMock = mockVariedFetch();
    const id = createCharacter(db, {
      campaign_id: campaignId,
      name: 'Nera',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
      backstory: 'A scarred veteran of the border wars.',
    }).character!.id;
    await flushPortraitQueue();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const prompt = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).prompt as string;
    expect(prompt).toContain('Nera, Dwarf Fighter, Soldier background, A scarred veteran');
    const row = db.prepare('SELECT portrait_path FROM character WHERE id = ?').get(id) as { portrait_path: string };
    expect(existsSync(portraitFile(row.portrait_path))).toBe(true);
  });

  it('gives a fight one portrait per creature type and one for anyone with a name', async () => {
    const id = fightCampaign();
    enable();
    const fetchMock = mockVariedFetch();
    const monsters = await fight(id, [
      { creature: 'Goblin Warrior', count: 3 },
      { creature: 'Goblin Warrior', name: 'Grask the Bloody' },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const goblins = monsters.filter((c) => c.name.startsWith('Goblin Warrior'));
    expect(goblins).toHaveLength(3);
    expect(new Set(goblins.map((c) => c.portrait_path))).toEqual(new Set([creaturePortraitPath(db, id, 'Goblin Warrior')]));
    const grask = monsters.find((c) => c.name === 'Grask the Bloody')!;
    expect(grask.portrait_path).toBeTruthy();
    expect(grask.portrait_path).not.toBe(goblins[0]!.portrait_path);
  });

  it('deals the variants of a creature type round-robin, stable for the fight', async () => {
    const id = fightCampaign();
    enable();
    const fetchMock = mockVariedFetch();
    const first = await generatePortrait({ db, campaign_id: id, subject: { creature: 'Goblin Warrior' }, description: 'squat' });
    clearPortraitRateLimit();
    const second = await generatePortrait({
      db,
      campaign_id: id,
      subject: { creature: 'Goblin Warrior', variant: true },
      description: 'lanky',
    });

    const monsters = await fight(id, [{ creature: 'Goblin Warrior', count: 4 }]);
    // Dealt in the order they were placed, whatever initiative later made of them.
    const dealt = [...monsters].sort((a, b) => a.id - b.id).map((c) => c.portrait_path);
    expect(dealt).toEqual([first.path, second.path, first.path, second.path]);
    // The two portraits it already had were enough; the fight generated nothing.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('draws nothing when auto_portraits is off', async () => {
    const id = fightCampaign();
    updateSettings(db, id, { auto_portraits: false });
    enable();
    const fetchMock = mockVariedFetch();
    const monsters = await fight(id, [{ creature: 'Goblin Warrior', count: 2 }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(monsters.every((c) => c.portrait_path === null)).toBe(true);
  });

  it('draws nothing at all while Cloudflare is not configured', async () => {
    const id = fightCampaign();
    const fetchMock = mockVariedFetch();
    const monsters = await fight(id, [{ creature: 'Goblin Warrior', count: 2 }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(monsters.every((c) => c.portrait_path === null)).toBe(true);
  });

  it('generates one portrait at a time', async () => {
    const id = fightCampaign();
    enable();
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return new Response(JSON.stringify({ result: { image: PNG_BASE64 }, success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await fight(id, [{ creature: 'Goblin Warrior' }, { creature: 'Wolf' }, { creature: 'Skeleton' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });

  it('redraws one fighter from the DM description through generate_portrait', async () => {
    const id = fightCampaign();
    enable();
    mockVariedFetch();
    const monsters = await fight(id, [{ creature: 'Ogre', unique: true }]);
    const ogre = monsters[0]!;

    const client = await connect();
    clearPortraitRateLimit();
    const result = await client.callTool({
      name: 'generate_portrait',
      arguments: { campaign_id: id, combatant_id: ogre.id, description: 'one eye, iron collar' },
    });
    await client.close();

    const structured = result.structuredContent as { generated: boolean; path: string; prompt: string };
    expect(structured.generated).toBe(true);
    expect(structured.prompt).toContain('one eye, iron collar');
    const after = getBattleState(db, id)!.combatants.find((c) => c.id === ogre.id)!;
    expect(after.portrait_path).toBe(structured.path);
    expect(after.portrait_path).not.toBe(ogre.portrait_path);
  });
});
