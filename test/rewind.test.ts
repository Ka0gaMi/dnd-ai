import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  addGlossaryEntry,
  createCampaign,
  getCharacterSheet,
  loadCampaign,
  logEvent,
  openQuests,
  pcRow,
  saveCheckpoint,
  upsertQuests,
} from '../src/core/campaign.js';
import { advanceTime } from '../src/core/calendar.js';
import { mixSeed, seededRng } from '../src/core/dice.js';
import { importRegion } from '../src/core/region.js';
import { ensureWorld } from '../src/core/world-seed.js';
import { tickTo } from '../src/core/world-tick.js';
import {
  getWorldState,
  insertFaction,
  listAgendas,
  listEvents,
  listFactions,
  saveWorldState,
} from '../src/core/world-store.js';
import {
  addContest,
  excommunicatedUntil,
  factionFaith,
  getContest,
  insertFaith,
  listFaiths,
  setFactionFaith,
  updateFaith,
} from '../src/core/world-faith-store.js';
import { renderBriefing } from '../src/mcp/tools/campaign.js';
import { applyDamage, createCharacter } from '../src/core/character.js';
import { endEncounter, startEncounter } from '../src/combat/engine.js';
import { captureCheckpoint, rewindToCheckpoint } from '../src/core/rewind.js';
import { openPendingRolls, rollForTool } from '../src/core/rolls.js';
import { updateSettings } from '../src/core/settings.js';
import { openDb, type Db } from '../src/db/connection.js';
import { HOST, startHttpServer } from '../src/transport/http.js';

const SECRET = 'rewindtestsecret0123456789abcdef0';
const safeRealm = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerousRealm = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

let db: Db;
let campaignId: number;
let base: string;
let stop: () => Promise<void>;

beforeAll(async () => {
  db = openDb(':memory:');
  const started = await startHttpServer(db, { port: 0, secret: SECRET });
  base = `http://${HOST}:${started.port}`;
  stop = started.close;
});

afterAll(async () => {
  await stop();
});

beforeEach(() => {
  campaignId = createCampaign(db, {
    name: 'Rewind',
    story_shape: 'sandbox',
    settings: { player_rolls: 'none' },
  }).campaign_id;
  createCharacter(db, {
    campaign_id: campaignId,
    name: 'Borg',
    species: 'Dwarf',
    class: 'Fighter',
    background: 'Soldier',
    ability_method: 'standard_array',
    abilities: { str: 15, dex: 10, con: 14, int: 8, wis: 12, cha: 13 },
    ability_bonuses: { str: 2, con: 1 },
    skill_choices: ['athletics', 'perception'],
  });
});

function checkpoint(): number {
  const saved = saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'The party camps by the ford.' });
  return captureCheckpoint(db, campaignId, saved.scene.id);
}

describe('rewind', () => {
  it('puts the sheet, the quests and the canon back and flags what came after', () => {
    upsertQuests(db, campaignId, [{ title: 'Find the ford', kind: 'main' }]);
    addGlossaryEntry(db, { campaign_id: campaignId, term: 'Ford', definition: 'The crossing.' });
    checkpoint();
    const before = getCharacterSheet(db, campaignId)!;
    const eventsBefore = db.prepare('SELECT MAX(id) AS id FROM event WHERE campaign_id = ?').get(campaignId) as {
      id: number;
    };

    applyDamage(db, { campaign_id: campaignId, amount: 7 });
    upsertQuests(db, campaignId, [{ title: 'Chase the thief' }]);
    addGlossaryEntry(db, { campaign_id: campaignId, term: 'Thief', definition: 'A fleeing figure.' });
    logEvent(db, { campaign_id: campaignId, kind: 'narration', text: 'The thief bolts into the dark.' });
    expect(getCharacterSheet(db, campaignId)!.hp_current).toBe(before.hp_current! - 7);

    const result = rewindToCheckpoint(db, campaignId);

    expect(getCharacterSheet(db, campaignId)!.hp_current).toBe(before.hp_current);
    expect(openQuests(db, campaignId).map((q) => q.title)).toEqual(['Find the ford']);
    expect(
      db.prepare('SELECT term FROM glossary_entry WHERE campaign_id = ? ORDER BY term').all(campaignId),
    ).toEqual([{ term: 'Ford' }]);
    expect(result.reverted_events).toBeGreaterThan(0);
    expect(result.briefing.pc?.hp_current).toBe(before.hp_current);

    const reverted = db
      .prepare('SELECT id, kind, reverted FROM event WHERE campaign_id = ? AND id > ? ORDER BY id')
      .all(campaignId, eventsBefore.id) as Array<{ kind: string; reverted: number }>;
    expect(reverted.filter((e) => e.kind !== 'rewind').every((e) => e.reverted === 1)).toBe(true);
    expect(reverted.at(-1)).toMatchObject({ kind: 'rewind', reverted: 0 });
  });

  it('leaves the reverted events out of the briefing', () => {
    checkpoint();
    logEvent(db, { campaign_id: campaignId, kind: 'narration', text: 'The thief bolts into the dark.' });
    expect(renderBriefing(loadCampaign(db, campaignId))).toContain('The thief bolts into the dark.');

    rewindToCheckpoint(db, campaignId);

    const briefing = loadCampaign(db, campaignId);
    expect(briefing.recent_events.map((e) => e.text)).not.toContain('The thief bolts into the dark.');
    expect(renderBriefing(briefing)).not.toContain('The thief bolts into the dark.');
  });

  it('drops the rolls nobody answered', async () => {
    checkpoint();
    updateSettings(db, campaignId, { roll_timeout_s: 30 });
    const waiting = rollForTool(db, {
      expr: '1d20+5',
      purpose: 'Perception check',
      campaign_id: campaignId,
      roller: 'player',
    });
    expect(openPendingRolls(db, campaignId)).toHaveLength(1);

    const result = rewindToCheckpoint(db, campaignId);
    expect(result.cancelled_rolls).toBe(1);
    expect(openPendingRolls(db, campaignId)).toHaveLength(0);
    // The tool call was already waiting on it, so it still gets a number back.
    expect((await waiting).total).toBeGreaterThan(0);
  });

  it('sends a character created after the checkpoint away again', () => {
    checkpoint();
    const before = pcRow(db, campaignId)!;

    // A second PC retires the first, so a surviving one would leave the party with two.
    createCharacter(db, {
      campaign_id: campaignId,
      name: 'Sella',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    });
    expect(pcRow(db, campaignId)!.name).toBe('Sella');

    rewindToCheckpoint(db, campaignId);

    const survivors = db
      .prepare("SELECT name, status FROM character WHERE campaign_id = ? AND is_pc = 1")
      .all(campaignId) as Array<{ name: string; status: string }>;
    expect(survivors).toEqual([{ name: 'Borg', status: 'active' }]);
    expect(pcRow(db, campaignId)).toMatchObject({ id: before.id, name: 'Borg', status: 'active' });
  });

  it('puts the scenes and the session recap back and drops the ones written since', () => {
    const sceneA = saveCheckpoint(db, {
      campaign_id: campaignId,
      scene_title: 'Scene A',
      scene_summary: 'They forded the river.',
    });
    captureCheckpoint(db, campaignId, sceneA.scene.id);
    const scenesBefore = db
      .prepare('SELECT id FROM scene WHERE campaign_id = ? ORDER BY id')
      .all(campaignId) as Array<{ id: number }>;

    saveCheckpoint(db, { campaign_id: campaignId, scene_title: 'Scene B', scene_summary: 'They met the toll keeper.' });
    const withB = loadCampaign(db, campaignId);
    expect(withB.previous_scene?.title).toBe('Scene B');
    expect(withB.last_recap).toContain('Scene B');

    rewindToCheckpoint(db, campaignId);

    const briefing = loadCampaign(db, campaignId);
    expect(briefing.previous_scene?.title).toBe('Scene A');
    expect(briefing.previous_scene?.summary).toBe('They forded the river.');
    expect(briefing.last_recap).toContain('Scene A');
    expect(briefing.last_recap).not.toContain('Scene B');
    expect(db.prepare('SELECT id FROM scene WHERE campaign_id = ? ORDER BY id').all(campaignId)).toEqual(scenesBefore);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM scene WHERE campaign_id = ? AND title = 'Scene B'").get(campaignId),
    ).toEqual({ n: 0 });
  });

  it('leaves no dangling row behind when a fight and a scene came after the checkpoint', async () => {
    checkpoint();
    createCharacter(db, {
      campaign_id: campaignId,
      name: 'Sella',
      species: 'Dwarf',
      class: 'Fighter',
      background: 'Soldier',
      ability_method: 'standard_array',
      abilities: { str: 15, dex: 14, con: 13, int: 8, wis: 12, cha: 10 },
      ability_bonuses: { str: 2, con: 1 },
      skill_choices: ['athletics', 'perception'],
    });
    await startEncounter(db, {
      campaign_id: campaignId,
      seed: 3,
      terrain: 'road',
      size: 'small',
      enemies: [{ creature: 'Goblin Warrior', count: 1 }],
    });
    endEncounter(db, { campaign_id: campaignId, outcome: 'victory' });
    saveCheckpoint(db, { campaign_id: campaignId, scene_title: 'Scene B', scene_summary: 'The goblin fell.' });

    rewindToCheckpoint(db, campaignId);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('refuses without a checkpoint and answers over HTTP with one', async () => {
    expect(() => rewindToCheckpoint(db, campaignId)).toThrow(/no checkpoint/);
    expect((await fetch(`${base}/api/campaigns/${campaignId}/rewind`, { method: 'POST' })).status).toBe(404);

    checkpoint();
    const res = await fetch(`${base}/api/campaigns/${campaignId}/rewind`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkpoint_id: number; briefing: { campaign: { id: number } } };
    expect(body.checkpoint_id).toBeGreaterThan(0);
    expect(body.briefing.campaign.id).toBe(campaignId);
  });

  it('answers 404 for an unknown campaign and 500 when the restore itself fails', async () => {
    expect((await fetch(`${base}/api/campaigns/999999/rewind`, { method: 'POST' })).status).toBe(404);

    checkpoint();
    db.prepare('UPDATE checkpoint SET snapshot_json = ? WHERE campaign_id = ?').run('not json', campaignId);
    const res = await fetch(`${base}/api/campaigns/${campaignId}/rewind`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  it('puts the living world back to the checkpoint', () => {
    importRegion(db, campaignId, safeRealm, { source: 'generated' });
    ensureWorld(db, campaignId);
    const before = getWorldState(db, campaignId)!;
    const agendasBefore = listAgendas(db, campaignId);
    checkpoint();

    advanceTime(db, campaignId, { days: 60 });
    expect(getWorldState(db, campaignId)!.last_tick_day).toBeGreaterThan(before.last_tick_day);

    rewindToCheckpoint(db, campaignId);

    expect(getWorldState(db, campaignId)).toEqual(before);
    expect(listAgendas(db, campaignId)).toEqual(agendasBefore);
  });

  it('replays the same world ledger after a rewind', () => {
    importRegion(db, campaignId, safeRealm, { source: 'generated' });
    ensureWorld(db, campaignId);
    checkpoint();
    const ledger = (): string[] =>
      (db.prepare('SELECT day, text FROM world_event WHERE campaign_id = ? ORDER BY day, id').all(campaignId) as Array<{
        day: number;
        text: string;
      }>).map((row) => `${row.day} ${row.text}`);

    advanceTime(db, campaignId, { days: 120 });
    const first = ledger();
    const today = getWorldState(db, campaignId)!.last_tick_day;

    // Rewind puts the world back but not the calendar, so tick the same days again directly.
    rewindToCheckpoint(db, campaignId);
    while (getWorldState(db, campaignId)!.last_tick_day < today) tickTo(db, campaignId, today);

    expect(first.length).toBeGreaterThan(0);
    expect(ledger()).toEqual(first);
  });

  it('leaves the living world untouched when the checkpoint predates it', () => {
    importRegion(db, campaignId, safeRealm, { source: 'generated' });
    ensureWorld(db, campaignId);
    const saved = saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'The party camps.' });
    const checkpointId = captureCheckpoint(db, campaignId, saved.scene.id);

    const snapshot = JSON.parse(
      (db.prepare('SELECT snapshot_json FROM checkpoint WHERE id = ?').get(checkpointId) as { snapshot_json: string })
        .snapshot_json,
    ) as { tables: Record<string, unknown> };
    for (const table of [
      'world_state',
      'world_faction',
      'world_agenda',
      'world_event',
      'world_packet',
      'world_attitude',
      'world_visit',
      'world_packet_arrival',
    ]) {
      delete snapshot.tables[table];
    }
    db.prepare('UPDATE checkpoint SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(snapshot), checkpointId);

    advanceTime(db, campaignId, { days: 60 });
    const after = getWorldState(db, campaignId)!;
    const agendasAfter = listAgendas(db, campaignId);

    rewindToCheckpoint(db, campaignId);

    expect(getWorldState(db, campaignId)).toEqual(after);
    expect(listAgendas(db, campaignId)).toEqual(agendasAfter);
  });

  it('puts the faiths, their contests and the temple links back to the checkpoint', () => {
    importRegion(db, campaignId, safeRealm, { source: 'generated' });
    ensureWorld(db, campaignId);
    const realmId = (
      db.prepare('SELECT id FROM world_realm WHERE campaign_id = ? ORDER BY id LIMIT 1').get(campaignId) as {
        id: number;
      }
    ).id;
    const faction = listFactions(db, campaignId)[0]!;

    const dawn = insertFaith(db, campaignId, {
      name: 'The Dawnmother',
      aspect: 'dawn',
      symbol: 'a rising sun',
      head_place_id: null,
      fervor: 60,
      heresy_of: null,
      last_heresy_day: null,
      created_day: 361,
    });
    setFactionFaith(db, campaignId, faction.id, dawn.id, 'strong');
    addContest(db, campaignId, realmId, dawn.id, 2);
    checkpoint();
    const faithsBefore = listFaiths(db, campaignId);

    insertFaith(db, campaignId, {
      name: 'The Dusk Sect',
      aspect: 'dusk',
      symbol: 'a setting sun',
      head_place_id: null,
      fervor: 40,
      heresy_of: dawn.id,
      last_heresy_day: 390,
      created_day: 390,
    });
    updateFaith(db, campaignId, dawn.id, { fervor: 90 });
    addContest(db, campaignId, realmId, dawn.id, 3);
    setFactionFaith(db, campaignId, faction.id, null, null);

    rewindToCheckpoint(db, campaignId);

    expect(listFaiths(db, campaignId)).toEqual(faithsBefore);
    expect(getContest(db, campaignId, realmId, dawn.id)).toEqual({ filled: 2, size: 6 });
    expect(factionFaith(db, campaignId, faction.id)).toEqual({ faith_id: dawn.id, influence: 'strong' });
  });

  it('leaves faiths alone when the checkpoint predates them', () => {
    importRegion(db, campaignId, safeRealm, { source: 'generated' });
    ensureWorld(db, campaignId);
    const realmId = (
      db.prepare('SELECT id FROM world_realm WHERE campaign_id = ? ORDER BY id LIMIT 1').get(campaignId) as {
        id: number;
      }
    ).id;
    const saved = saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'The party camps.' });
    const checkpointId = captureCheckpoint(db, campaignId, saved.scene.id);

    const snapshot = JSON.parse(
      (db.prepare('SELECT snapshot_json FROM checkpoint WHERE id = ?').get(checkpointId) as { snapshot_json: string })
        .snapshot_json,
    ) as { tables: Record<string, unknown> };
    delete snapshot.tables.world_faith;
    delete snapshot.tables.world_contest;
    db.prepare('UPDATE checkpoint SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(snapshot), checkpointId);

    const faith = insertFaith(db, campaignId, {
      name: 'The Dawnmother',
      aspect: 'dawn',
      symbol: 'a rising sun',
      head_place_id: null,
      fervor: 60,
      heresy_of: null,
      last_heresy_day: null,
      created_day: 361,
    });
    addContest(db, campaignId, realmId, faith.id, 1);
    const faithsAfter = listFaiths(db, campaignId);

    rewindToCheckpoint(db, campaignId);

    expect(listFaiths(db, campaignId)).toEqual(faithsAfter);
    expect(getContest(db, campaignId, realmId, faith.id)).toEqual({ filled: 1, size: 6 });
  });

  it('replays the same faith month and heresy ids after a rewind', () => {
    importRegion(db, campaignId, dangerousRealm, { source: 'generated' });
    ensureWorld(db, campaignId);
    const faith = listFaiths(db, campaignId)[0]!;
    updateFaith(db, campaignId, faith.id, { fervor: 30, last_heresy_day: null });

    // The heresy roll is a pure function of the world seed, so scan for one that succeeds on day 390.
    let seed = 0;
    for (let candidate = 1; candidate <= 1000 && seed === 0; candidate += 1) {
      if (seededRng(mixSeed(candidate, 390, faith.id, 4099))() < 0.35) seed = candidate;
    }
    expect(seed).toBeGreaterThan(0);
    saveWorldState(db, campaignId, { ...getWorldState(db, campaignId)!, seed });

    checkpoint();
    const ledger = (): Array<{ day: number; kind: string; text: string; faction_id: number | null }> =>
      listEvents(db, campaignId).map((event) => ({
        day: event.day,
        kind: event.kind,
        text: event.text,
        faction_id: event.faction_id,
      }));
    const heresyFactionId = (faithId: number): number =>
      (
        db
          .prepare('SELECT id FROM world_faction WHERE campaign_id = ? AND faith_id = ?')
          .get(campaignId, faithId) as { id: number }
      ).id;

    advanceTime(db, campaignId, { days: 120 });
    const first = ledger();
    const today = getWorldState(db, campaignId)!.last_tick_day;
    const heresyBefore = listFaiths(db, campaignId).find((entry) => entry.heresy_of === faith.id)!;
    const factionBefore = heresyFactionId(heresyBefore.id);

    // Rewind puts the world back but not the calendar, so tick the same days again directly.
    rewindToCheckpoint(db, campaignId);
    while (getWorldState(db, campaignId)!.last_tick_day < today) tickTo(db, campaignId, today);

    expect(ledger()).toEqual(first);
    const heresyAfter = listFaiths(db, campaignId).find((entry) => entry.heresy_of === faith.id)!;
    expect(heresyAfter.id).toBe(heresyBefore.id);
    expect(heresyFactionId(heresyAfter.id)).toBe(factionBefore);
  });

  it('puts the excommunication back and replays the same event after a rewind', () => {
    importRegion(db, campaignId, safeRealm, { source: 'generated' });
    ensureWorld(db, campaignId);
    const linked = listFactions(db, campaignId).find(
      (faction) => factionFaith(db, campaignId, faction.id).faith_id !== null,
    )!;
    const realmId = linked.realm_id!;
    const faithId = factionFaith(db, campaignId, linked.id).faith_id!;
    addContest(db, campaignId, realmId, faithId, 3);
    checkpoint();

    const excommunications = (): Array<{ day: number; text: string; faction_id: number | null }> =>
      listEvents(db, campaignId)
        .filter((event) => event.kind === 'excommunication')
        .map((event) => ({ day: event.day, text: event.text, faction_id: event.faction_id }));

    addContest(db, campaignId, realmId, faithId, 3);
    tickTo(db, campaignId, 390);
    const first = excommunications();
    expect(excommunicatedUntil(db, campaignId, realmId)).toBe(570);
    expect(first).toHaveLength(1);

    rewindToCheckpoint(db, campaignId);

    expect(excommunicatedUntil(db, campaignId, realmId)).toBeNull();
    expect(getContest(db, campaignId, realmId, faithId)).toEqual({ filled: 3, size: 6 });

    addContest(db, campaignId, realmId, faithId, 3);
    tickTo(db, campaignId, 390);

    expect(excommunicatedUntil(db, campaignId, realmId)).toBe(570);
    expect(excommunications()).toEqual(first);
  });

  it('keeps temple links and drops orphaned heresies when the checkpoint predates faiths', () => {
    importRegion(db, campaignId, safeRealm, { source: 'generated' });
    ensureWorld(db, campaignId);
    const linked = listFactions(db, campaignId)[0]!;
    const faith = insertFaith(db, campaignId, {
      name: 'The Dawnmother',
      aspect: 'dawn',
      symbol: 'a rising sun',
      head_place_id: null,
      fervor: 60,
      heresy_of: null,
      last_heresy_day: null,
      created_day: 361,
    });
    setFactionFaith(db, campaignId, linked.id, faith.id, 'strong');

    const saved = saveCheckpoint(db, { campaign_id: campaignId, scene_summary: 'The party camps.' });
    const checkpointId = captureCheckpoint(db, campaignId, saved.scene.id);

    // A checkpoint written before faiths has no faith table and no faith columns on its factions.
    const snapshot = JSON.parse(
      (db.prepare('SELECT snapshot_json FROM checkpoint WHERE id = ?').get(checkpointId) as { snapshot_json: string })
        .snapshot_json,
    ) as { tables: Record<string, Array<Record<string, unknown>>> };
    delete snapshot.tables.world_faith;
    delete snapshot.tables.world_contest;
    for (const row of snapshot.tables.world_faction ?? []) {
      delete row.faith_id;
      delete row.influence;
    }
    db.prepare('UPDATE checkpoint SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(snapshot), checkpointId);

    // A heresy and its church founded after the checkpoint go with the faction that carried them.
    const heresy = insertFaith(db, campaignId, {
      name: 'The Dusk Sect',
      aspect: 'dusk',
      symbol: 'a setting sun',
      head_place_id: null,
      fervor: 40,
      heresy_of: faith.id,
      last_heresy_day: 390,
      created_day: 390,
    });
    const heresyChurch = insertFaction(db, campaignId, {
      name: 'The Dusk Sect',
      type: 'church',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'discreet',
      resources: 2,
      capacities: {},
      created_day: 390,
    });
    setFactionFaith(db, campaignId, heresyChurch.id, heresy.id, 'minor');

    rewindToCheckpoint(db, campaignId);

    expect(factionFaith(db, campaignId, linked.id)).toEqual({ faith_id: faith.id, influence: 'strong' });
    expect(listFaiths(db, campaignId).some((entry) => entry.id === faith.id)).toBe(true);
    expect(listFaiths(db, campaignId).some((entry) => entry.id === heresy.id)).toBe(false);
    expect(listFactions(db, campaignId).some((entry) => entry.id === heresyChurch.id)).toBe(false);
  });
});
