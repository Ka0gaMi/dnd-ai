import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { advanceTurn, startEncounter } from '../src/combat/engine.js';
import { createCampaign, getCampaign, rollAndRecord } from '../src/core/campaign.js';
import { createCharacter } from '../src/core/character.js';
import { saveHomebrew, validateBackground } from '../src/core/progression.js';
import { openDb, type Db } from '../src/db/connection.js';
import { HOST, startHttpServer } from '../src/transport/http.js';

const SECRET = 'testsecret0123456789abcdef012345';

let base: string;
let db: Db;
let campaignId: number;
let characterId: number;
let encounterId: number;
let portraitsRoot: string;
let stop: () => Promise<void>;

beforeAll(async () => {
  portraitsRoot = mkdtempSync(join(tmpdir(), 'dnd-portraits-http-'));
  process.env.DND_AI_PORTRAITS_DIR = portraitsRoot;
  db = openDb(':memory:');
  campaignId = createCampaign(db, {
    name: 'Api Test',
    story_shape: 'sandbox',
    settings: { player_rolls: 'none' },
  }).campaign_id;
  const otherId = createCampaign(db, { name: 'Other', story_shape: 'sandbox' }).campaign_id;
  const insertTerm = db.prepare(
    'INSERT INTO glossary_entry (campaign_id, term, definition, source, chapter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insertTerm.run(null, 'Zzz Bundled', 'A bundled SRD term.', 'srd', null, '2026-01-01');
  insertTerm.run(campaignId, 'Ashfall', 'The grey rain.', 'campaign', 3, '2026-01-01');
  insertTerm.run(otherId, 'Not Mine', 'Another campaign.', 'campaign', null, '2026-01-01');
  rollAndRecord(db, { expr: '1d20+3', purpose: 'Stealth check', dc: 12, campaign_id: campaignId });
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
  encounterId = (
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 7,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior' }],
    })
  ).encounter_id;
  const started = await startHttpServer(db, { port: 0, secret: SECRET });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
  delete process.env.DND_AI_PORTRAITS_DIR;
  rmSync(portraitsRoot, { recursive: true, force: true });
});

function initializeRequest(path: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'curl-test', version: '0.0.0' },
      },
    }),
  });
}

describe('http transport', () => {
  it('answers initialize as JSON on the secret path', async () => {
    const res = await initializeRequest(`/mcp/${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { result: { serverInfo: { name: string }; instructions: string } };
    expect(body.result.serverInfo.name).toBe('dnd-ai');
    expect(body.result.instructions).toContain('Dungeon Master');
  });

  it('lists the tools over http', async () => {
    const res = await fetch(`${base}/mcp/${SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.length).toBeGreaterThanOrEqual(50);
    expect(body.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'start_encounter',
        'get_battle_state',
        'move_token',
        'attack',
        'advance_turn',
        'end_encounter',
        'story',
        'get_codex',
        'note_play',
        'read_guide',
      ]),
    );
  });

  it('logs every tools/call with its outcome', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      lines.push(parts.map(String).join(' '));
    });
    try {
      const call = (id: number, name: string, args: Record<string, unknown>) =>
        fetch(`${base}/mcp/${SECRET}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
        });
      await call(11, 'load_campaign', {});
      await call(12, 'roll', { campaign_id: campaignId, expression: '1d20' });
    } finally {
      spy.mockRestore();
    }
    expect(lines.some((l) => /tools\/call load_campaign \{\}/.test(l))).toBe(true);
    expect(lines.some((l) => /tools\/result load_campaign ok \d+ms [1-9]\d*B /.test(l))).toBe(true);
    // A schema rejection never reaches the tool, so it must be visible in the log as an error.
    expect(lines.some((l) => /tools\/result roll error \d+ms [1-9]\d*B /.test(l))).toBe(true);
  });

  it('404s on the wrong path', async () => {
    const res = await initializeRequest('/mcp/wrong-secret');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('Not found');

    // The companion UI is optional at test time: index.html when web/dist exists, 404 when it does not.
    // Read here rather than at import time, so a web build landing mid-run cannot flip it.
    const webBuilt = existsSync(fileURLToPath(new URL('../web/dist/index.html', import.meta.url)));
    const root = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
    expect(root.status).toBe(webBuilt ? 200 : 404);
    if (webBuilt) expect(root.headers.get('content-type')).toContain('text/html');
  });

  it('404s an unknown non-html path even when the UI is built', async () => {
    const res = await fetch(`${base}/nope.png`, { headers: { accept: 'image/png' } });
    expect(res.status).toBe(404);
  });

  it('404s an unknown api path asking for html, instead of the companion UI', async () => {
    const res = await fetch(`${base}/api/does-not-exist`, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(404);
  });

  it('accepts the server origin and refuses a foreign one', async () => {
    const same = await fetch(`${base}/api/campaigns`, { headers: { origin: base } });
    expect(same.status).toBe(200);
    const foreign = await fetch(`${base}/api/campaigns`, { headers: { origin: 'http://evil.example' } });
    expect(foreign.status).toBe(403);
  });

  it('lists campaigns as JSON', async () => {
    const res = await fetch(`${base}/api/campaigns`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: number; name: string }>;
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ id: campaignId, name: 'Api Test' });
  });

  it('serves srd and campaign glossary entries together', async () => {
    const res = await fetch(`${base}/api/campaigns/${campaignId}/glossary`);
    const body = (await res.json()) as Array<{ term: string; source: string; chapter_id: number | null }>;
    const terms = body.map((e) => e.term);
    expect(terms).toContain('Zzz Bundled');
    expect(terms).toContain('Ashfall');
    expect(terms).not.toContain('Not Mine');
    expect(body.find((e) => e.term === 'Ashfall')?.source).toBe('campaign');
    expect(body.find((e) => e.term === 'Ashfall')?.chapter_id).toBe(3);
  });

  it('serves the roll log newest first', async () => {
    const res = await fetch(`${base}/api/campaigns/${campaignId}/rolls?limit=10`);
    const body = (await res.json()) as Array<{
      purpose: string;
      total: number;
      dc: number;
      overridden: number;
      groups: unknown;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.purpose).toBe('Stealth check');
    expect(body[0]?.dc).toBe(12);
    expect(body[0]?.overridden).toBe(0);
    expect(Array.isArray(body[0]?.groups)).toBe(true);
  });

  it('serves the combat log of the active encounter oldest first', async () => {
    const res = await fetch(`${base}/api/campaigns/${campaignId}/combat-log?limit=500`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      id: number;
      round: number;
      actor_id: number | null;
      target_id: number | null;
      kind: string;
      payload: unknown;
      text: string;
      ts: string;
    }>;
    expect(body.length).toBeGreaterThan(1);
    expect(body[0]?.kind).toBe('encounter_start');
    expect(body[0]?.round).toBe(1);
    expect(body[0]?.payload).toMatchObject({ seed: 7 });
    expect(body.map((e) => e.id)).toEqual([...body.map((e) => e.id)].sort((a, b) => a - b));

    const byId = await fetch(`${base}/api/campaigns/${campaignId}/combat-log?encounter=${encounterId}`);
    expect(((await byId.json()) as unknown[]).length).toBe(body.length);

    const current = await fetch(`${base}/api/campaigns/${campaignId}/combat-log?encounter=current`);
    expect(((await current.json()) as unknown[]).length).toBe(body.length);
  });

  it('404s a combat log for an encounter in another campaign and serves none when no fight is running', async () => {
    const other = createCampaign(db, { name: 'No Fight', story_shape: 'sandbox' }).campaign_id;
    const foreign = await fetch(`${base}/api/campaigns/${other}/combat-log?encounter=${encounterId}`);
    expect(foreign.status).toBe(404);

    const empty = await fetch(`${base}/api/campaigns/${other}/combat-log`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
  });

  it('permanently deletes a campaign and everything that belongs to it', async () => {
    const doomed = createCampaign(db, { name: 'Doomed', story_shape: 'sandbox' }).campaign_id;

    const deleted = await fetch(`${base}/api/campaigns/${doomed}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    const body = (await deleted.json()) as { deleted: boolean; deleted_rows: number };
    expect(body).toMatchObject({ deleted: true });
    expect(body.deleted_rows).toBeGreaterThan(0);

    const live = (await (await fetch(`${base}/api/campaigns`)).json()) as Array<{ id: number }>;
    expect(live.map((c) => c.id)).not.toContain(doomed);

    const all = (await (await fetch(`${base}/api/campaigns?include_deleted=1`)).json()) as Array<{ id: number }>;
    expect(all.map((c) => c.id)).not.toContain(doomed);

    const restored = await fetch(`${base}/api/campaigns/${doomed}/restore`, { method: 'POST' });
    expect(restored.status).toBe(404);
  });

  it('404s deleting a campaign that does not exist', async () => {
    const res = await fetch(`${base}/api/campaigns/9999`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('serves the health check', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  // Also proves that route modules under src/transport/routes load: this endpoint only exists via that loader.
  it('gets and patches campaign settings through the auto-loaded settings route', async () => {
    const got = await fetch(`${base}/api/campaigns/${campaignId}/settings`);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ visibility: 'bars', roll_mode: 'player' });

    const patched = await fetch(`${base}/api/campaigns/${campaignId}/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'full' }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ visibility: 'full' });

    const invalid = await fetch(`${base}/api/campaigns/${campaignId}/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'nonsense' }),
    });
    expect(invalid.status).toBe(400);
  });

  it('serves the tactics between two combatants of the active encounter', async () => {
    const combatants = db.prepare('SELECT id, kind FROM combatant WHERE encounter_id = ? ORDER BY id').all(
      encounterId,
    ) as Array<{ id: number; kind: string }>;
    const pc = combatants.find((c) => c.kind === 'pc')!.id;
    const goblin = combatants.find((c) => c.kind === 'monster')!.id;

    const res = await fetch(`${base}/api/campaigns/${campaignId}/tactics?from=${pc}&to=${goblin}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      distance_ft: number;
      line_of_sight: boolean;
      cover: string;
      in_reach: boolean;
      in_range: { normal: boolean; long: boolean } | null;
      path_cost_ft: number | null;
    };
    expect(typeof body.distance_ft).toBe('number');
    expect(typeof body.line_of_sight).toBe('boolean');
    expect(['none', 'half', 'three-quarters', 'total']).toContain(body.cover);
    expect(typeof body.in_reach).toBe('boolean');
    expect(body.in_range === null || typeof body.in_range.normal === 'boolean').toBe(true);
    expect(body.path_cost_ft === null || typeof body.path_cost_ft === 'number').toBe(true);

    const missing = await fetch(`${base}/api/campaigns/${campaignId}/tactics?from=${pc}&to=9999`);
    expect(missing.status).toBe(404);

    const noFight = createCampaign(db, { name: 'No Tactics', story_shape: 'sandbox' }).campaign_id;
    const quiet = await fetch(`${base}/api/campaigns/${noFight}/tactics?from=1&to=2`);
    expect(quiet.status).toBe(404);
    expect((await quiet.json()) as { error: string }).toEqual({ error: 'no active encounter' });

    const bad = await fetch(`${base}/api/campaigns/${campaignId}/tactics?from=${pc}`);
    expect(bad.status).toBe(400);
  });

  it('takes back the last combat action and 404s when there is nothing to undo', async () => {
    const fightId = createCampaign(db, {
      name: 'Undo Fight',
      story_shape: 'sandbox',
      settings: { player_rolls: 'none' },
    }).campaign_id;
    const quiet = await fetch(`${base}/api/campaigns/${fightId}/combat/undo`, { method: 'POST' });
    expect(quiet.status).toBe(404);

    createCharacter(db, {
      campaign_id: fightId,
      name: 'Nell',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    });
    await startEncounter(db, {
      campaign_id: fightId,
      seed: 11,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior' }, { creature: 'Goblin Warrior' }],
    });
    const before = (await advanceTurn(db, fightId)).state;
    await advanceTurn(db, fightId);

    const res = await fetch(`${base}/api/campaigns/${fightId}/combat/undo`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: { turn_index: number; round: number };
      log: Array<{ kind: string; text: string }>;
    };
    expect(body.state).toMatchObject({ round: before.round, turn_index: before.turn_index });
    expect(body.log[0]?.kind).toBe('undo');
  });

  it('respects the same-origin guard on the settings route', async () => {
    const res = await fetch(`${base}/api/campaigns/${campaignId}/settings`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('reports whether portrait generation is configured', async () => {
    const res = await fetch(`${base}/api/portraits/status`);
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as { enabled: boolean }).enabled).toBe('boolean');
  });

  it('stores an uploaded character portrait and serves it back', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const upload = await fetch(`${base}/api/characters/${characterId}/portrait`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: png,
    });
    expect(upload.status).toBe(200);
    const { path } = (await upload.json()) as { path: string };
    expect(path).toBe(
      (db.prepare('SELECT portrait_path FROM character WHERE id = ?').get(characterId) as { portrait_path: string })
        .portrait_path,
    );

    const served = await fetch(`${base}${path}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);
  });

  it('stores and looks up a creature portrait by name', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const missingCampaign = await fetch(`${base}/api/portraits/creature/Goblin%20Boss`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: png,
    });
    expect(missingCampaign.status).toBe(400);

    const upload = await fetch(`${base}/api/portraits/creature/Goblin%20Boss?campaign_id=${campaignId}`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: png,
    });
    expect(upload.status).toBe(200);
    const { path } = (await upload.json()) as { path: string };

    const found = await fetch(`${base}/api/portraits/creature/goblin%20boss?campaign_id=${campaignId}`);
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ path });

    const missing = await fetch(`${base}/api/portraits/creature/Bugbear?campaign_id=${campaignId}`);
    expect(missing.status).toBe(404);
  });

  it('refuses a portrait upload that is not an image, or for a character that does not exist', async () => {
    const wrongType = await fetch(`${base}/api/characters/${characterId}/portrait`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'not an image',
    });
    expect(wrongType.status).toBe(415);

    const unknown = await fetch(`${base}/api/characters/9999/portrait`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: Buffer.from('x'),
    });
    expect(unknown.status).toBe(404);
  });

  // --- the "New story" wizard routes ---------------------------------------

  it('serves the setting presets', async () => {
    const res = await fetch(`${base}/api/presets`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      presets: Array<{ id: string; name: string }>;
      tone_dials: Array<{ id: string }>;
    };
    expect(body.presets).toHaveLength(14);
    expect(body.tone_dials).toHaveLength(6);
    expect(body.presets.map((p) => p.id)).toContain('gothic-horror');
  });

  it('creates a campaign shell from the wizard and keeps the setting on the chooser row', async () => {
    const res = await fetch(`${base}/api/campaigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'The Mistward',
        story_shape: 'structured',
        setting_preset: 'gothic-horror',
        tone_dials: { lethality: 2, horror: 3 },
        lines: 'harm to children',
        veils: 'torture',
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: number; name: string; premise: string | null };
    expect(created.name).toBe('The Mistward');
    expect(created.premise).toBeNull();
    expect(JSON.parse(getCampaign(db, created.id).settings_json!)).toMatchObject({
      setting_preset: 'gothic-horror',
      tone_dials: { lethality: 2, horror: 3 },
      lines: 'harm to children',
      veils: 'torture',
      needs_ai_fill: { premise: true },
    });

    const rows = (await (await fetch(`${base}/api/campaigns`)).json()) as Array<{
      id: number;
      setting_preset: string | null;
      setting_name: string | null;
      needs_ai_fill: boolean;
    }>;
    expect(rows.find((c) => c.id === created.id)).toMatchObject({
      setting_preset: 'gothic-horror',
      setting_name: 'Gothic Horror',
      needs_ai_fill: true,
    });
  });

  it('does not flag a wizard campaign that already has a premise', async () => {
    const res = await fetch(`${base}/api/campaigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'The Salt Crown',
        story_shape: 'sandbox',
        setting_preset: 'swashbuckling-pirates',
        premise: 'A pirate queen hires you to steal back her own flagship.',
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: number };
    expect(JSON.parse(getCampaign(db, created.id).settings_json!)).toMatchObject({ needs_ai_fill: false });
  });

  it('rejects an unknown setting preset and names an unnamed story for the DM', async () => {
    const badPreset = await fetch(`${base}/api/campaigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nope', story_shape: 'sandbox', setting_preset: 'space-opera' }),
    });
    expect(badPreset.status).toBe(400);
    expect((await badPreset.json()) as { error: string }).toMatchObject({ error: expect.stringContaining('space-opera') });

    const unnamed = await fetch(`${base}/api/campaigns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '', story_shape: 'sandbox' }),
    });
    expect(unnamed.status).toBe(201);
    const shell = (await unnamed.json()) as { id: number; name: string };
    expect(shell.name).toMatch(/^Untitled story \(/);
    expect(JSON.parse(getCampaign(db, shell.id).settings_json!)).toMatchObject({
      needs_ai_fill: { name: true, premise: true },
    });
  });

  it('serves the SRD character options, filtered by the wizard step', async () => {
    const all = (await (await fetch(`${base}/api/srd/options`)).json()) as {
      classes: Array<{ name: string }>;
      species: Array<{ name: string }>;
      class_detail?: unknown;
    };
    expect(all.classes.length).toBeGreaterThan(0);
    expect(all.class_detail).toBeUndefined();

    const rogue = (await (await fetch(`${base}/api/srd/options?class=Rogue&background=Sage`)).json()) as {
      class_detail: { name: string };
      background_detail: { name: string };
    };
    expect(rogue.class_detail.name).toBe('Rogue');
    expect(rogue.background_detail.name).toBe('Sage');
  });

  it('adds the custom backgrounds of a campaign to the options when campaign_id is given', async () => {
    saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'background',
      name: 'Trapwright',
      schema: validateBackground({
        name: 'Trapwright',
        abilities: ['dex', 'int', 'wis'],
        origin_feat: 'Alert',
        skills: ['stealth', 'investigation'],
        tool: "Thieves' Tools",
        equipment: { items: [{ name: 'Dagger', qty: 1 }], gold: 15 },
        text: 'You grew up rigging snares in the tunnels under the city.',
      }) as unknown as Record<string, unknown>,
    });
    type Options = { backgrounds: Array<{ name: string; custom: boolean }> };
    const withCampaign = (await (
      await fetch(`${base}/api/srd/options?campaign_id=${campaignId}`)
    ).json()) as Options;
    expect(withCampaign.backgrounds.find((b) => b.name === 'Trapwright')?.custom).toBe(true);

    const without = (await (await fetch(`${base}/api/srd/options`)).json()) as Options;
    expect(without.backgrounds.some((b) => b.name === 'Trapwright')).toBe(false);
  });

  it('creates the wizard character and reports engine errors as 400', async () => {
    const shell = (await (
      await fetch(`${base}/api/campaigns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Wizard Step Two', story_shape: 'sandbox' }),
      })
    ).json()) as { id: number };

    const character = {
      name: 'Sable',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array' as const,
      abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    };
    const ok = await fetch(`${base}/api/campaigns/${shell.id}/character`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(character),
    });
    expect(ok.status).toBe(201);
    expect((await ok.json()) as { character: { name: string } }).toMatchObject({
      character: { name: 'Sable', class: 'Fighter', hp_max: 13 },
    });

    const rejected = await fetch(`${base}/api/campaigns/${shell.id}/character`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...character, species: 'Goblinoid' }),
    });
    expect(rejected.status).toBe(400);
    expect(((await rejected.json()) as { error: string }).error).toMatch(/Goblinoid/);
  });
});
