// The deed funnel over MCP: deeds carried on checkpoint {op: save} write what world {op: deed} writes, keep their
// witnesses, refuse the whole save when one is wrong, and a fallen codex NPC nudges the DM until a deed is recorded.
import { readFileSync } from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, type GameEvent } from '../src/core/bus.js';
import { shownCounts } from '../src/core/duties.js';
import { importRegion } from '../src/core/region.js';
import { ensureFactionEntity } from '../src/core/world-codex.js';
import { currentGameDay, insertAgenda, insertFaction, listFactions, type WorldFaction } from '../src/core/world-store.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { replyData } from './helpers/reply.js';

type Row = Record<string, unknown>;

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as unknown;

let db: Db;
let client: Client;
let campaignId: number;

beforeEach(async () => {
  db = openDb(':memory:');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'deed-funnel', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), client.connect(clientTransport)]);
  campaignId = (await call<{ campaign_id: number }>('create_campaign', { name: 'Deeds', story_shape: 'sandbox' })).campaign_id;
});

/** The whole reply text of a call that must succeed, Next line included. */
async function text(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const body = (result.content as Array<{ text: string }>).map((c) => c.text).join('');
  if (result.isError) throw new Error(body);
  return body;
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  return replyData<T>({ content: [{ type: 'text', text: await text(name, args) }] });
}

async function refusal(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return (result.content as Array<{ text: string }>)[0]!.text;
}

/** Everything the window would be sent while `run` goes. */
async function published(run: () => Promise<unknown>): Promise<GameEvent[]> {
  const seen: GameEvent[] = [];
  const stop = bus.subscribe((event) => seen.push(event));
  try {
    await run();
  } finally {
    stop();
  }
  return seen;
}

/** A region map and its seeded world, as world {op: get} leaves them. */
async function seedWorld(map = 'realm-safe.json'): Promise<WorldFaction[]> {
  importRegion(db, campaignId, fixture(map), { source: 'generated' });
  await text('world', { campaign_id: campaignId, op: 'get' });
  return listFactions(db, campaignId);
}

/** `faction` pursues an active rivalry against `rival`, so a deed toward one may reach the other. */
function rivalry(faction: WorldFaction, rival: WorldFaction): void {
  insertAgenda(db, campaignId, {
    faction_id: faction.id,
    template: 'trade_monopoly',
    target_kind: 'rival_faction',
    target_id: rival.id,
    target_name: rival.name,
    clock_size: 8,
    clock_filled: 0,
    portents: [],
    status: 'active',
    started_day: currentGameDay(db, campaignId),
  });
}

/** The attitude rows after `afterId`, without their ids, so two paths can be compared. */
function attitudesAfter(afterId: number): Row[] {
  return (
    db
      .prepare('SELECT * FROM world_attitude WHERE campaign_id = ? AND id > ? ORDER BY id')
      .all(campaignId, afterId) as Row[]
  ).map(({ id, ...row }) => row);
}

const lastAttitudeId = (): number =>
  (db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM world_attitude').get() as { id: number }).id;

/** The deed events: how each arrived and what it kept. */
function deedEvents(): Array<{ text: string; payload: Record<string, unknown> }> {
  return (
    db.prepare("SELECT text, payload_json FROM event WHERE campaign_id = ? AND kind = 'deed' ORDER BY id").all(campaignId) as Array<{
      text: string;
      payload_json: string;
    }>
  ).map((row) => ({ text: row.text, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
}

/** The fired counter for each deed path, read the way a harness would. */
const viaCounts = (): Row[] =>
  db
    .prepare(
      "SELECT json_extract(payload_json, '$.via') AS via, COUNT(*) AS n FROM event WHERE campaign_id = ? AND kind = 'deed' GROUP BY via ORDER BY via",
    )
    .all(campaignId) as Row[];

/** Every row a scene end or a deed can write, so a refusal can be shown to have written nothing. */
function dump(): Record<string, Row[]> {
  const all = (sql: string): Row[] => db.prepare(sql).all(campaignId) as Row[];
  return {
    event: all('SELECT * FROM event WHERE campaign_id = ? ORDER BY id'),
    world_attitude: all('SELECT * FROM world_attitude WHERE campaign_id = ? ORDER BY id'),
    world_state: all('SELECT * FROM world_state WHERE campaign_id = ?'),
    entity: all('SELECT * FROM entity WHERE campaign_id = ? ORDER BY id'),
    canon_fact: all('SELECT * FROM canon_fact WHERE campaign_id = ? ORDER BY id'),
    quest: all('SELECT * FROM quest WHERE campaign_id = ? ORDER BY id'),
    checkpoint: all('SELECT * FROM checkpoint WHERE campaign_id = ? ORDER BY id'),
    scene: all('SELECT * FROM scene WHERE campaign_id = ? ORDER BY id'),
  };
}

const upsertNpc = async (name: string): Promise<number> =>
  (await call<{ entity: { id: number } }>('entity', { op: 'upsert', campaign_id: campaignId, kind: 'npc', name })).entity.id;

const save = (extra: Record<string, unknown>) => ({
  op: 'save',
  campaign_id: campaignId,
  scene_summary: 'The party did something people will remember.',
  ...extra,
});

/** A finished fight in which a combatant of this name died. */
function fallenInFight(name: string): void {
  const now = new Date().toISOString();
  const fight = Number(
    db
      .prepare("INSERT INTO encounter (campaign_id, seed, map_json, started_at, status, ended_at) VALUES (?, 1, '{}', ?, 'ended', ?)")
      .run(campaignId, now, now).lastInsertRowid,
  );
  db.prepare("INSERT INTO combatant (encounter_id, kind, name, team, alive) VALUES (?, 'monster', ?, 'enemy', 0)").run(fight, name);
}

/** Lets the clock move on, so a later timestamp is strictly later. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const beat = (): Promise<string> => text('log_event', { campaign_id: campaignId, kind: 'narration', text: 'A beat.' });

describe('deeds on checkpoint {op: save}', () => {
  it('writes the same attitudes, rival backlash included, as world {op: deed} does', async () => {
    const [target, rival] = await seedWorld();
    rivalry(target!, rival!);
    await upsertNpc('Sera Vane');
    const deeds = [
      { target: target!.name, value: 3, reason: 'saved their caravan' },
      { target: 'Sera Vane', value: -2, reason: 'shamed her at the fair' },
    ];

    const start = lastAttitudeId();
    for (const deed of deeds) await text('world', { campaign_id: campaignId, op: 'deed', ...deed });
    const viaWorld = attitudesAfter(start);
    expect(viaWorld.length).toBeGreaterThanOrEqual(2);

    const middle = lastAttitudeId();
    const saved = await call<{ deeds: string[]; applied: Row }>('checkpoint', save({ deeds }));
    expect(attitudesAfter(middle)).toEqual(viaWorld);
    expect(saved.deeds).toHaveLength(2);
    expect(saved.deeds[0]!.startsWith(`${target!.name}: +3 saved their caravan; now `)).toBe(true);
    expect(saved.deeds[0]).toContain('(+6)');
    expect(saved.deeds[1]).toMatch(/^Sera Vane: -2 shamed her at the fair; now .+ \(-4\)/);
    expect(saved.applied).toEqual({ facts: 0, events: 0, objectives: 0, glossary: 0, note: 0 });

    // Both paths leave a deed event whose text is the player-safe reason alone.
    expect(deedEvents().map((event) => [event.text, event.payload.via])).toEqual([
      ['saved their caravan', 'world'],
      ['shamed her at the fair', 'world'],
      ['saved their caravan', 'checkpoint'],
      ['shamed her at the fair', 'checkpoint'],
    ]);
    expect(viaCounts()).toEqual([
      { via: 'checkpoint', n: 2 },
      { via: 'world', n: 2 },
    ]);
  });

  it('gives a faction one codex entry when two deeds of one save name it, a brood included', async () => {
    const [house] = await seedWorld();
    // A brood's codex entry is named by a search that skips linked entries, so a stale plan would mint a second.
    const brood = insertFaction(db, campaignId, {
      name: 'Gnoll pack',
      type: 'monsters',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'open',
      resources: 0,
      capacities: {},
      created_day: 1,
    });
    for (const target of [house!, brood]) {
      expect(target.entity_id).toBeNull();
      await call('checkpoint', save({
        deeds: [
          { target: target.name, value: 1, reason: 'carried their letters' },
          { target: target.id, value: 2, reason: 'guarded their hall' },
        ],
      }));
    }
    const linked = listFactions(db, campaignId)
      .filter((faction) => faction.id === house!.id || faction.id === brood.id)
      .map((faction) => ({ id: faction.entity_id }));
    expect(db.prepare("SELECT id FROM entity WHERE campaign_id = ? AND kind = 'faction' ORDER BY id").all(campaignId)).toEqual(linked);
    for (const target of [house!, brood]) {
      expect(attitudesAfter(0).filter((row) => row.subject_id === target.id && row.rival_of === null)).toHaveLength(2);
    }
  });

  it('keeps the witnesses on the deed, and a rival a witness belongs to hears of it from afar', async () => {
    const factions = await seedWorld('realm-medium.json');
    const target = factions.find((faction) => faction.secrecy === 'open' && faction.realm_id !== null)!;
    const rival = factions.find((faction) => faction.secrecy === 'open' && faction.realm_id !== target.realm_id)!;
    rivalry(target, rival);
    const rivalEntry = ensureFactionEntity(db, campaignId, rival)!;
    const hamm = await upsertNpc('Old Hamm');
    await text('entity', { op: 'link', campaign_id: campaignId, from: hamm, to: rivalEntry, type: 'member_of' });
    const backlash = (): Row[] =>
      db.prepare('SELECT value, rival_of FROM world_attitude WHERE campaign_id = ? AND subject_id = ? AND subject_kind = ?').all(
        campaignId,
        rival.id,
        'faction',
      ) as Row[];

    // No place and another realm: unwitnessed, the rival never hears.
    await call('checkpoint', save({ deeds: [{ target: target.id, value: 3, reason: 'broke the toll chain' }] }));
    expect(backlash()).toEqual([]);

    const saved = await call<{ deeds: string[] }>(
      'checkpoint',
      save({ deeds: [{ target: target.id, value: 3, reason: 'broke the toll chain again', witnesses: ['old hamm', hamm] }] }),
    );
    expect(backlash()).toEqual([{ value: -1, rival_of: target.id }]);
    expect(saved.deeds[0]).toContain('Seen by Old Hamm.');
    expect(deedEvents().map((event) => event.payload)).toEqual([
      { via: 'checkpoint', subject: { kind: 'faction', id: target.id }, value: 3, place_id: null, witnesses: [] },
      { via: 'checkpoint', subject: { kind: 'faction', id: target.id }, value: 3, place_id: null, witnesses: [hamm] },
    ]);
  });

  it('refuses the whole save when one deed is wrong, writing and sending nothing', async () => {
    const [target] = await seedWorld();
    const before = dump();
    let refused = '';
    const sent = await published(async () => {
      refused = await refusal(
        'checkpoint',
        save({
          events: [{ kind: 'narration', text: 'They crossed the ford.' }],
          facts: [{ subject: 'The ford', fact: 'The ford floods every spring.' }],
          objectives: [{ title: 'Cross the river', kind: 'side' }],
          deeds: [
            { target: target!.name, value: 2, reason: 'paid the ferryman' },
            { target: 'Nobody Here', value: 2, reason: 'a test' },
            { target: target!.name, value: 'big', reason: 'a test' },
            { target: target!.name, value: 1, reason: 'a test', witnesses: ['No Such Witness'] },
            { target: target!.name, value: 0, reason: 'a test', faction: 'extra' },
          ],
        }),
      );
    });
    expect(refused).toMatch(/^Refused, nothing was saved: /);
    expect(refused).toContain('deeds[1]: No faction or codex entity "Nobody Here" in this campaign. world {op: get} lists the factions');
    expect(refused).toContain('deeds[2].value: ');
    expect(refused).toContain('deeds[3]: No codex entity "No Such Witness" to name as a witness. get_codex lists the entities');
    expect(refused).toContain('deeds[4]: ');
    expect(refused).not.toContain('deeds[0]');
    expect(refused).toMatch(/Fix them and re-call checkpoint \{op: save\}\.$/);
    expect(sent).toEqual([]);
    expect(dump()).toEqual(before);
  });

  it('refuses deeds without a region map, and does not seed a world for a refused one', async () => {
    const before = dump();
    expect(await refusal('checkpoint', save({ deeds: [{ target: 'Anyone', value: 1, reason: 'a test' }] }))).toContain(
      'deeds need a region map',
    );
    expect(dump()).toEqual(before);

    importRegion(db, campaignId, fixture('realm-safe.json'), { source: 'generated' });
    const unseeded = dump();
    expect(await refusal('checkpoint', save({ deeds: [{ target: 'Nobody Here', value: 1, reason: 'a test' }] }))).toContain(
      'deeds[0]: No faction or codex entity',
    );
    expect(dump()).toEqual(unseeded);
    expect(unseeded.world_state).toEqual([]);
  });
});

describe('the deed nudge', () => {
  const NUDGE = /\n\nNext: checkpoint \{op: save\} with deeds - codex #(\d+) died in the fight; record who will remember it\.$/;

  it('rides the Next line once a codex NPC dies in a fight, until a deed is recorded by either path', async () => {
    const [target] = await seedWorld();
    const grask = await upsertNpc('Grask');
    // The counter lives in the process and every test's campaign is id 1, so count from here.
    const shownBefore = shownCounts(campaignId).deed_unrecorded ?? 0;
    const replies: string[] = [];
    const record = async (reply: Promise<string>): Promise<string> => {
      replies.push(await reply);
      return replies.at(-1)!;
    };

    // A fallen stranger nobody wrote into the codex is no signal.
    fallenInFight('Goblin Warrior 2');
    expect(await record(beat())).not.toContain('Next:');

    await tick();
    fallenInFight('grask');
    expect(NUDGE.exec(await record(beat()))?.[1]).toBe(String(grask));
    await tick();
    const deed = await record(text('world', { campaign_id: campaignId, op: 'deed', target: target!.name, value: -2, reason: 'killed Grask' }));
    expect(deed).not.toMatch(NUDGE);
    expect(await record(beat())).not.toMatch(NUDGE);

    await tick();
    fallenInFight('Grask');
    expect(await record(beat())).toMatch(NUDGE);
    await tick();
    expect(await record(text('checkpoint', save({ deeds: [{ target: grask, value: -1, reason: 'left Grask unburied' }] })))).not.toMatch(
      NUDGE,
    );
    expect(await record(beat())).not.toMatch(NUDGE);

    // The counters a harness reads: deeds by path, and how often the nudge was shown.
    expect(viaCounts()).toEqual([
      { via: 'checkpoint', n: 1 },
      { via: 'world', n: 1 },
    ]);
    const shown = (shownCounts(campaignId).deed_unrecorded ?? 0) - shownBefore;
    expect(shown).toBe(replies.filter((reply) => NUDGE.test(reply)).length);
    expect(shown).toBe(2);
  });

  it('ends with the scene: a save without deeds stops it too', async () => {
    await seedWorld();
    await upsertNpc('Grask');
    await tick();
    fallenInFight('Grask');
    expect(await beat()).toMatch(NUDGE);
    await tick();
    await text('checkpoint', save({}));
    expect(await beat()).not.toMatch(NUDGE);
  });
});
