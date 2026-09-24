// The living world's first day: governments, the factions the map implies and one agenda each.
// randomSeed is stubbed so the same world seed can be replayed across two databases.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db/connection.js';

vi.mock('../src/core/dice.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/dice.js')>();
  return { ...actual, randomSeed: () => 12345 };
});

const safe = JSON.parse(readFileSync(new URL('./fixtures/realm-safe.json', import.meta.url), 'utf8')) as unknown;
const dangerous = JSON.parse(
  readFileSync(new URL('./fixtures/realm-dangerous.json', import.meta.url), 'utf8'),
) as unknown;

let db: Db;
let ensureWorld: (typeof import('../src/core/world-seed.js'))['ensureWorld'];
let createCampaign: (typeof import('../src/core/campaign.js'))['createCampaign'];
let importRegion: (typeof import('../src/core/region.js'))['importRegion'];
let upsertEntity: (typeof import('../src/core/codex.js'))['upsertEntity'];
let listFactions: (typeof import('../src/core/world-store.js'))['listFactions'];
let listAgendas: (typeof import('../src/core/world-store.js'))['listAgendas'];
let insertAgenda: (typeof import('../src/core/world-store.js'))['insertAgenda'];
let updateAgenda: (typeof import('../src/core/world-store.js'))['updateAgenda'];
let pickAgenda: (typeof import('../src/core/world-seed.js'))['pickAgenda'];
let getRegion: (typeof import('../src/core/region.js'))['getRegion'];
let findPlace: (typeof import('../src/core/region.js'))['findPlace'];
let insertFaction: (typeof import('../src/core/world-store.js'))['insertFaction'];
let insertFaith: (typeof import('../src/core/world-faith-store.js'))['insertFaith'];
let listFaiths: (typeof import('../src/core/world-faith-store.js'))['listFaiths'];
let setFactionFaith: (typeof import('../src/core/world-faith-store.js'))['setFactionFaith'];
let factionFaith: (typeof import('../src/core/world-faith-store.js'))['factionFaith'];

beforeAll(async () => {
  // With isolate: false an earlier file in this worker may have cached dice.ts without the stub, so
  // drop the module cache and import the world seed fresh under the mock.
  vi.resetModules();
  ({ ensureWorld, pickAgenda } = await import('../src/core/world-seed.js'));
  ({ createCampaign } = await import('../src/core/campaign.js'));
  ({ importRegion, getRegion, findPlace } = await import('../src/core/region.js'));
  ({ upsertEntity } = await import('../src/core/codex.js'));
  ({ listFactions, listAgendas, insertAgenda, insertFaction, updateAgenda } = await import(
    '../src/core/world-store.js'
  ));
  ({ insertFaith, listFaiths, setFactionFaith, factionFaith } = await import(
    '../src/core/world-faith-store.js'
  ));
});

beforeEach(() => {
  db = openDb(':memory:');
});

function newCampaign(target: Db = db, name = 'The Ashfall Road'): number {
  return createCampaign(target, { name, story_shape: 'structured' }).campaign_id;
}

function withRegion(realm: unknown, target: Db = db): number {
  const campaignId = newCampaign(target);
  importRegion(target, campaignId, realm, { source: 'generated' });
  return campaignId;
}

function realmRow(campaignId: number): { name: string; government: string | null; ruler_title: string | null } {
  return db
    .prepare('SELECT name, government, ruler_title FROM world_realm WHERE campaign_id = ?')
    .get(campaignId) as { name: string; government: string | null; ruler_title: string | null };
}

describe('ensureWorld without a region', () => {
  it('returns null', () => {
    expect(ensureWorld(db, newCampaign())).toBeNull();
  });
});

describe('ensureWorld on the safe realm', () => {
  it('seeds governments, factions and one filled agenda each', () => {
    const campaignId = withRegion(safe);
    const summary = ensureWorld(db, campaignId)!;
    expect(summary).toEqual({ seed: 12345, factions: 7, agendas: 7, created: true });

    const factions = listFactions(db, campaignId);
    expect(factions.map((faction) => faction.name)).toEqual([
      'Theocracy of Ficengwind',
      'Bishopric of Redham',
      'Bishopric of Ficengwind',
      "Redham Merchants' Guild",
      "Ficengwind Merchants' Guild",
      'The Redham Knives',
      'The Ficengwind Knives',
    ]);
    expect(factions.filter((faction) => faction.type === 'church')).toEqual([]);
    for (const name of ['The Redham Knives', 'The Ficengwind Knives']) {
      expect(factions.find((faction) => faction.name === name)?.secrecy).toBe('discreet');
    }

    expect(realmRow(campaignId)).toMatchObject({
      name: 'Theocracy of Ficengwind',
      government: 'theocracy',
      ruler_title: 'Pontiff',
    });

    const agendas = listAgendas(db, campaignId);
    expect(agendas).toHaveLength(factions.length);
    for (const faction of factions) {
      const own = agendas.filter((agenda) => agenda.faction_id === faction.id);
      expect(own).toHaveLength(1);
      expect(own[0]!.status).toBe('active');
      expect(own[0]!.portents.length).toBeGreaterThan(0);
      for (const portent of own[0]!.portents) expect(portent.text).not.toContain('{');
    }
  });

  it('reports the existing world on a second call without adding rows', () => {
    const campaignId = withRegion(safe);
    ensureWorld(db, campaignId);

    const again = ensureWorld(db, campaignId)!;
    expect(again).toEqual({ seed: 12345, factions: 7, agendas: 7, created: false });
    expect(listFactions(db, campaignId)).toHaveLength(7);
    expect(listAgendas(db, campaignId)).toHaveLength(7);
  });
});

describe('ensureWorld on the dangerous realm', () => {
  it('seeds a confederation, clans, a temple and two broods', () => {
    const campaignId = withRegion(dangerous);
    expect(ensureWorld(db, campaignId)!.created).toBe(true);

    const factions = listFactions(db, campaignId);
    expect(factions.map((faction) => faction.name)).toEqual([
      'Ta Isle Confederation',
      'Clan of Frostcot',
      'Clan of Crimson Wharf',
      'Temple of Ta Isle',
      'The Brood of Ziggurat Of The Vampire Queen',
      'The Brood of Hidden Keep',
    ]);

    const monsterAgendas = listAgendas(db, campaignId).filter((agenda) =>
      factions.some((faction) => faction.id === agenda.faction_id && faction.type === 'monsters'),
    );
    expect(monsterAgendas).toHaveLength(2);
    for (const agenda of monsterAgendas) {
      expect(['Frostcot', 'Crimson Wharf']).toContain(agenda.target_name);
    }
  });
});

describe('ensureWorld determinism', () => {
  it('replays identical factions and agendas for the same world seed', () => {
    const first = openDb(':memory:');
    const second = openDb(':memory:');
    const a = withRegion(safe, first);
    const b = withRegion(safe, second);
    ensureWorld(first, a);
    ensureWorld(second, b);

    const names = (target: Db, campaignId: number): string[] =>
      listFactions(target, campaignId).map((faction) => faction.name);
    const agendaOf = (target: Db, campaignId: number): Array<{ template: string; target_name: string }> =>
      listAgendas(target, campaignId).map((agenda) => ({
        template: agenda.template,
        target_name: agenda.target_name,
      }));

    expect(names(first, a)).toEqual(names(second, b));
    expect(agendaOf(first, a)).toEqual(agendaOf(second, b));
  });
});

describe('ensureWorld and the codex', () => {
  it('keeps a realm name the codex already uses', () => {
    const campaignId = withRegion(safe);
    upsertEntity(db, { campaign_id: campaignId, kind: 'faction', name: 'Kingdom of Ficengwind' });

    ensureWorld(db, campaignId);

    expect(realmRow(campaignId)).toMatchObject({
      name: 'Kingdom of Ficengwind',
      government: 'theocracy',
      ruler_title: 'Pontiff',
    });
  });
});

describe('pickAgenda after a settling win', () => {
  it('never sends a faction back after a town it already converted', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const temple = listFactions(db, campaignId).find((faction) => faction.type === 'church')!;
    const first = listAgendas(db, campaignId).find((agenda) => agenda.faction_id === temple.id)!;
    expect(first.template).toBe('conversion');
    updateAgenda(db, campaignId, first.id, { status: 'won', resolved_day: first.started_day });

    const day = first.started_day + 365;
    for (let salt = 1; salt <= 20; salt += 1) {
      const next = pickAgenda(db, campaignId, temple, day, 7, salt)!;
      expect(`${next.template}:${next.target_id}`).not.toBe(`conversion:${first.target_id}`);
      updateAgenda(db, campaignId, next.id, { status: 'abandoned' });
    }
  });
});

describe('pickAgenda public portents', () => {
  it('names a settlement, not the danger, in a monsters_grow portent', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const brood = listFactions(db, campaignId).find((faction) => faction.type === 'monsters')!;
    const view = getRegion(db, campaignId)!;
    const settlements = view.places.filter((place) => place.kind === 'settlement').map((place) => place.name);
    const dangers = view.places.filter((place) => place.kind === 'danger').map((place) => place.name);

    let grow: ReturnType<typeof pickAgenda> = null;
    for (let salt = 1; salt <= 60 && grow === null; salt += 1) {
      const next = pickAgenda(db, campaignId, brood, 100, 7, salt);
      if (next === null) continue;
      if (next.template === 'monsters_grow') grow = next;
      updateAgenda(db, campaignId, next.id, { status: 'abandoned' });
    }
    expect(grow).not.toBeNull();

    const portent = grow!.portents[0]!.text;
    expect(settlements.some((name) => portent.includes(name))).toBe(true);
    for (const danger of dangers) expect(portent).not.toContain(danger);
    expect(portent).not.toContain('The Brood of');
  });
});

describe('pickAgenda and held goals', () => {
  it('never picks a goal another faction is holding', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    for (const agenda of listAgendas(db, campaignId)) {
      updateAgenda(db, campaignId, agenda.id, { status: 'abandoned' });
    }
    const broods = listFactions(db, campaignId).filter((faction) => faction.type === 'monsters');
    const holder = broods[0]!;
    const picker = broods[1]!;

    // Both monster templates share one target: the settlement nearest the brood's danger.
    const sample = pickAgenda(db, campaignId, picker, 100, 7, 1)!;
    updateAgenda(db, campaignId, sample.id, { status: 'abandoned' });
    const heldTarget = sample.target_id!;

    insertAgenda(db, campaignId, {
      faction_id: holder.id,
      template: 'raid',
      target_kind: 'settlement',
      target_id: heldTarget,
      target_name: sample.target_name,
      clock_size: 4,
      clock_filled: 4,
      portents: [{ text: 'Held.', fired_day: null, heard: false }],
      status: 'held',
      started_day: 1,
    });

    let picked = 0;
    for (let salt = 1; salt <= 40; salt += 1) {
      const next = pickAgenda(db, campaignId, picker, 100, 7, salt);
      if (next === null) continue;
      picked += 1;
      expect(`${next.template}:${next.target_kind}:${next.target_id}`).not.toBe(`raid:settlement:${heldTarget}`);
      updateAgenda(db, campaignId, next.id, { status: 'abandoned' });
    }
    expect(picked).toBe(40);
  });
});

type PickedAgenda = NonNullable<ReturnType<typeof pickAgenda>>;

/** Abandons every seeded agenda so a faction under test starts with an empty field. */
function abandonAll(campaignId: number): void {
  for (const agenda of listAgendas(db, campaignId)) {
    updateAgenda(db, campaignId, agenda.id, { status: 'abandoned' });
  }
}

/** Picks for one faction over many salts, abandoning each pick so the next call starts fresh. */
function pickMany(campaignId: number, factionId: number, day: number, salts: number): PickedAgenda[] {
  const picks: PickedAgenda[] = [];
  for (let salt = 1; salt <= salts; salt += 1) {
    const faction = listFactions(db, campaignId).find((entry) => entry.id === factionId);
    if (!faction) break;
    const next = pickAgenda(db, campaignId, faction, day, 7, salt);
    if (next === null) continue;
    picks.push(next);
    updateAgenda(db, campaignId, next.id, { status: 'abandoned' });
  }
  return picks;
}

describe('pickAgenda and faith politics', () => {
  /** A faction acts from its seat, so one whose realm has no capital needs one for seat-bound goals. */
  function seatFaction(campaignId: number, factionId: number): void {
    db.prepare('UPDATE world_faction SET place_id = ? WHERE id = ? AND campaign_id = ?').run(
      findPlace(db, campaignId, 'Frostcot')!.id,
      factionId,
      campaignId,
    );
  }

  /** A breakaway faith and the discreet church faction that follows it. */
  function addHeresy(campaignId: number, parentFaithId: number): { heresyFactionId: number } {
    const heresy = insertFaith(db, campaignId, {
      name: 'The Sunless Path',
      aspect: 'sun',
      symbol: 'eclipsed sun',
      head_place_id: null,
      fervor: 70,
      heresy_of: parentFaithId,
      last_heresy_day: null,
      created_day: 361,
    });
    const faction = insertFaction(db, campaignId, {
      name: 'The Sunless Path',
      type: 'church',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'discreet',
      resources: 2,
      capacities: {},
      created_day: 361,
    });
    setFactionFaith(db, campaignId, faction.id, heresy.id, 'minor');
    return { heresyFactionId: faction.id };
  }

  function templeRealmAndFaith(campaignId: number): {
    temple: ReturnType<typeof listFactions>[number];
    realm: ReturnType<typeof listFactions>[number];
    faith: ReturnType<typeof listFaiths>[number];
  } {
    const factions = listFactions(db, campaignId);
    return {
      temple: factions.find((faction) => faction.type === 'church')!,
      realm: factions.find((faction) => faction.type === 'realm')!,
      faith: listFaiths(db, campaignId)[0]!,
    };
  }

  it('never lets a minor temple call a crusade or hunt heretics', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const { temple, faith } = templeRealmAndFaith(campaignId);
    seatFaction(campaignId, temple.id);
    addHeresy(campaignId, faith.id);
    setFactionFaith(db, campaignId, temple.id, faith.id, 'minor');
    abandonAll(campaignId);

    const templates = pickMany(campaignId, temple.id, 500, 60).map((agenda) => agenda.template);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates).not.toContain('crusade');
    expect(templates).not.toContain('persecute');
  });

  it('lets a strong temple call a crusade and raise a cathedral', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const { temple, faith } = templeRealmAndFaith(campaignId);
    seatFaction(campaignId, temple.id);
    setFactionFaith(db, campaignId, temple.id, faith.id, 'strong');
    abandonAll(campaignId);

    const templates = pickMany(campaignId, temple.id, 500, 80).map((agenda) => agenda.template);
    expect(templates).toContain('crusade');
    expect(templates).toContain('raise_cathedral');
  });

  it('lets a strong orthodox temple persecute a heresy', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const { temple, faith } = templeRealmAndFaith(campaignId);
    const { heresyFactionId } = addHeresy(campaignId, faith.id);
    setFactionFaith(db, campaignId, temple.id, faith.id, 'strong');
    abandonAll(campaignId);

    const persecutions = pickMany(campaignId, temple.id, 500, 80).filter(
      (agenda) => agenda.template === 'persecute',
    );
    expect(persecutions.length).toBeGreaterThan(0);
    for (const agenda of persecutions) {
      expect(agenda.target_kind).toBe('rival_faction');
      expect(agenda.target_id).toBe(heresyFactionId);
    }
  });

  it('lets a crown seize church lands only once its realm holds a strong temple', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const { temple, realm, faith } = templeRealmAndFaith(campaignId);
    setFactionFaith(db, campaignId, temple.id, faith.id, 'minor');
    abandonAll(campaignId);

    const minorPicks = pickMany(campaignId, realm.id, 500, 60).map((agenda) => agenda.template);
    expect(minorPicks.length).toBeGreaterThan(0);
    expect(minorPicks).not.toContain('seize_church_lands');

    setFactionFaith(db, campaignId, temple.id, faith.id, 'strong');
    const strongPicks = pickMany(campaignId, realm.id, 500, 60).map((agenda) => agenda.template);
    expect(strongPicks).toContain('seize_church_lands');
  });

  it('never lets a templeless theocracy seize church lands', () => {
    const campaignId = withRegion(safe);
    ensureWorld(db, campaignId);
    const factions = listFactions(db, campaignId);
    expect(factions.some((faction) => faction.type === 'church')).toBe(false);
    const realm = factions.find((faction) => faction.type === 'realm')!;
    abandonAll(campaignId);

    const templates = pickMany(campaignId, realm.id, 500, 60).map((agenda) => agenda.template);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates).not.toContain('seize_church_lands');
  });

  it("lets a theocracy's ruling realm raise a cathedral and persecute a heresy", () => {
    const campaignId = withRegion(safe);
    ensureWorld(db, campaignId);
    const realm = listFactions(db, campaignId).find((faction) => faction.type === 'realm')!;
    expect(factionFaith(db, campaignId, realm.id)).toEqual({
      faith_id: expect.any(Number),
      influence: 'dominant',
    });
    const faith = listFaiths(db, campaignId)[0]!;
    const { heresyFactionId } = addHeresy(campaignId, faith.id);
    abandonAll(campaignId);

    // The safe realm holds no danger, so a crusade has no target there.
    const picks = pickMany(campaignId, realm.id, 500, 120);
    const templates = picks.map((agenda) => agenda.template);
    expect(templates).toContain('raise_cathedral');
    const persecutions = picks.filter((agenda) => agenda.template === 'persecute');
    expect(persecutions.length).toBeGreaterThan(0);
    for (const agenda of persecutions) expect(agenda.target_id).toBe(heresyFactionId);
  });

  it('never lets a non-theocracy realm run the faith goals, even under a strong faith', () => {
    const campaignId = withRegion(dangerous);
    ensureWorld(db, campaignId);
    const { realm, faith } = templeRealmAndFaith(campaignId);
    // Seat the crown and give it a strong faith with a heresy in reach, so only the dominance gate blocks it.
    seatFaction(campaignId, realm.id);
    setFactionFaith(db, campaignId, realm.id, faith.id, 'strong');
    addHeresy(campaignId, faith.id);
    abandonAll(campaignId);

    const templates = pickMany(campaignId, realm.id, 500, 120).map((agenda) => agenda.template);
    expect(templates.length).toBeGreaterThan(0);
    expect(templates).not.toContain('crusade');
    expect(templates).not.toContain('persecute');
    expect(templates).not.toContain('raise_cathedral');
  });
});
