// Canon checked where it is written, through the MCP client: a new name close to an existing one, a fact
// contradicting an active one, and a new tie for the dead are refused with the canon quoted.
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { bus, type GameEvent } from '../src/core/bus.js';
import { lifeClaim } from '../src/core/canon-guards.js';
import { upsertEntity } from '../src/core/codex.js';
import { insertFaction } from '../src/core/world-store.js';
import { openDb, type Db } from '../src/db/connection.js';
import { createGameServer } from '../src/mcp/server.js';
import { replyData } from './helpers/reply.js';

type Row = Record<string, unknown>;

let db: Db;
let client: Client;
let campaignId: number;

async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const next = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([createGameServer(db).connect(serverTransport), next.connect(clientTransport)]);
  return next;
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as Array<{ text: string }>)[0]!.text);
  return replyData<T>(result);
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

/** The refusal text of a call that must fail. */
async function refusal(name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  return (result.content as Array<{ text: string }>)[0]!.text;
}

/** Every row a fact, a link or a scene end can write, so a refusal can be shown to have written nothing. */
function dump(): Record<string, Row[]> {
  const all = (sql: string): Row[] => db.prepare(sql).all(campaignId) as Row[];
  return {
    canon_fact: all('SELECT * FROM canon_fact WHERE campaign_id = ? ORDER BY id'),
    event: all('SELECT * FROM event WHERE campaign_id = ? ORDER BY id'),
    entity: all('SELECT * FROM entity WHERE campaign_id = ? ORDER BY id'),
    relationship: all('SELECT * FROM relationship WHERE campaign_id = ? ORDER BY id'),
    quest: all('SELECT * FROM quest WHERE campaign_id = ? ORDER BY id'),
    glossary_entry: all('SELECT * FROM glossary_entry WHERE campaign_id = ? ORDER BY id'),
    checkpoint: all('SELECT * FROM checkpoint WHERE campaign_id = ? ORDER BY id'),
    scene: all('SELECT * FROM scene WHERE campaign_id = ? ORDER BY id'),
    campaign: all('SELECT current_session_id, current_scene_id FROM campaign WHERE id = ?'),
  };
}

const remember = (subject: string, fact: string, extra: Record<string, unknown> = {}) =>
  call<{ id: number }>('remember', { op: 'fact', campaign_id: campaignId, subject, fact, ...extra });

const upsert = (kind: string, name: string, extra: Record<string, unknown> = {}) =>
  call<{ entity: { id: number } }>('entity', { op: 'upsert', campaign_id: campaignId, kind, name, ...extra });

const link = (from: string, to: string, type: string) => ({ op: 'link', campaign_id: campaignId, from, to, type });

beforeEach(async () => {
  db = openDb(':memory:');
  client = await connect();
  campaignId = (await call<{ campaign_id: number }>('create_campaign', { name: 'Canon', story_shape: 'sandbox' }))
    .campaign_id;
});

describe('lifeClaim', () => {
  it.each([
    // Existing cases, now read against the subject they are filed under.
    ['Grask is alive and hiding in the marsh.', 'Grask', 'alive'],
    ['Mira Vell was slain by Grask at the ford.', 'Mira Vell', 'dead'],
    ['Mira died at the ford.', 'Mira Vell', 'dead'],
    ['Mira perished in the fire.', 'Mira', 'dead'],
    ['Mira lies dead in the crypt.', 'Mira', 'dead'],
    ['Mira is long dead.', 'Mira', 'dead'],
    ['The Ash Court was destroyed by fire.', 'Ash Court', 'dead'],
    ['Mira is no longer alive.', 'Mira', 'dead'],
    ['Mira did not survive the fire.', 'Mira', 'dead'],
    ["Mira isn't dead.", 'Mira', 'alive'],
    ['Mira is not dead.', 'Mira', 'alive'],
    ['Mira never died; the body was a double.', 'Mira', 'alive'],
    ['Mira killed the bandit chief.', 'Mira', null],
    ['Mira has slain the dragon.', 'Mira', null],
    ['Mira speaks with the dead.', 'Mira', null],
    ['Mira nearly died in the fire.', 'Mira', null],
    ['Mira survived, but her father died.', 'Mira', 'alive'],
    ['Mira keeps the ferry at Redham.', 'Mira', null],
    // Someone else's death: a possessive, "the X of", a pronoun's kin, a passive's agent, a later "he".
    ["Mira's brother died in the war.", 'Mira', null],
    ["Mira's parents are dead.", 'Mira', null],
    ["Mira's husband was murdered last spring.", 'Mira', null],
    ['The brother of Mira died in the war.', 'Mira', null],
    ['Her brother died at the ford.', 'Mira', null],
    ['Grask was killed by Mira.', 'Mira', null],
    ["Mira's husband was murdered, and he died slowly.", 'Mira', null],
    ["Grask's men were slain, but Mira survived.", 'Mira', 'alive'],
    ['Mira is dead and Grask is alive.', 'Mira', 'dead'],
    // The subject by pronoun, contraction, accent or a longer form of the name.
    ['She died at the ford.', 'Mira', 'dead'],
    ['It was destroyed by the Ash Court.', 'Iron Guild', 'dead'],
    ["Mira's dead.", 'Mira', 'dead'],
    ["Mira's been slain.", 'Mira', 'dead'],
    ["Mira's slain the dragon.", 'Mira', null],
    ['Míra-Vell died.', 'Mira Vell', 'dead'],
    ['Queen Mira died at the ford.', 'Mira', 'dead'],
    ['Mira survived the ambush.', 'Mira', 'alive'],
    ['Mira still lives.', 'Mira', 'alive'],
    ['Mira was found dead in the well.', 'Mira', 'dead'],
    // Idioms that are no life claim.
    ['Mira is wanted dead or alive.', 'Mira', null],
    ['Mira is dead tired after the march.', 'Mira', null],
    ['Mira crossed the river in the dead of night.', 'Mira', null],
    ['Mira died in the dead of night.', 'Mira', 'dead'],
    ["The road to Mira's camp is a dead end.", 'Mira', null],
    ['Mira is dead certain Grask lied.', 'Mira', null],
    ['Mira missed the deadline.', 'Mira', null],
    ['Mira was survived by her husband.', 'Mira', null],
    // Hedges, suppositions, reports and facts that say both.
    ['Mira is both dead and alive.', 'Mira', null],
    ['Mira survived the fire but died of her wounds.', 'Mira', null],
    ['Perhaps Mira died.', 'Mira', null],
    ['Mira may be dead.', 'Mira', null],
    ['When Mira dies, the Court falls.', 'Mira', null],
    ['Grask claims that Mira is dead.', 'Mira', null],
    ["Mira hasn't died.", 'Mira', 'alive'],
  ])('reads "%s" filed under %s as %s', (fact, subject, expected) => {
    expect(lifeClaim(fact, subject)).toBe(expected);
  });

  // With no subject, as a save compares its own facts, any name counts as the subject.
  it.each([
    ['Grask is alive and hiding in the marsh.', 'alive'],
    ['Mira Vell was slain by Grask at the ford.', 'dead'],
    ['Mira died at the ford.', 'dead'],
    ['Mira perished in the fire.', 'dead'],
    ['Mira lies dead in the crypt.', 'dead'],
    ['Mira is long dead.', 'dead'],
    ['The Ash Court was destroyed by fire.', 'dead'],
    ['Mira is no longer alive.', 'dead'],
    ['Mira did not survive the fire.', 'dead'],
    ["Mira isn't dead.", 'alive'],
    ['Mira is not dead.', 'alive'],
    ['Mira never died; the body was a double.', 'alive'],
    ['Mira killed the bandit chief.', null],
    ['Mira has slain the dragon.', null],
    ['Mira speaks with the dead.', null],
    ['Mira nearly died in the fire.', null],
    ['Mira survived, but her father died.', 'alive'],
    ['Mira keeps the ferry at Redham.', null],
    ["Mira's brother died in the war.", null],
    ['Mira is wanted dead or alive.', null],
  ])('reads "%s" as %s', (fact, expected) => {
    expect(lifeClaim(fact)).toBe(expected);
  });
});

describe('remember {op: fact} against an active fact', () => {
  it('refuses a fact that contradicts one on the same subject, quoting it, and writes nothing', async () => {
    const alive = await remember('Mira Vell', 'Mira Vell is alive and hiding in the marsh.');
    const before = dump();

    const text = await refusal('remember', {
      op: 'fact',
      campaign_id: campaignId,
      subject: 'Mira Vell',
      fact: 'Mira Vell was slain by Grask at the ford.',
    });
    expect(text).toBe(
      `Refused, nothing was written: this fact contradicts active fact ${alive.id} on Mira Vell ("Mira Vell is alive and hiding in the marsh."); if it replaces that fact, pass supersedes_id ${alive.id}, and if it is about someone else, file it under their name.`,
    );
    expect(dump()).toEqual(before);
  });

  it('accepts the same fact with supersedes_id and retires the old one', async () => {
    const alive = await remember('Mira Vell', 'Mira Vell is alive and hiding in the marsh.');
    const slain = await remember('Mira Vell', 'Mira Vell was slain by Grask at the ford.', { supersedes_id: alive.id });

    const rows = db.prepare('SELECT id, active, superseded_by FROM canon_fact WHERE campaign_id = ? ORDER BY id').all(campaignId);
    expect(rows).toEqual([
      { id: alive.id, active: 0, superseded_by: slain.id },
      { id: slain.id, active: 1, superseded_by: null },
    ]);
  });

  it('lets through a fact where the subject does the killing, or another subject dies', async () => {
    await remember('Mira Vell', 'Mira Vell is alive and hiding in the marsh.');
    await remember('Mira Vell', 'Mira Vell killed the bandit chief with a crossbow.');
    await remember('Grask', 'Grask was slain by Mira Vell at the ford.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM canon_fact WHERE active = 1').get()).toEqual({ n: 3 });
  });

  it("accepts the subject surviving beside a fact about a kinsman's death, a victim or an idiom", async () => {
    await remember('Mira', "Mira's husband was murdered last spring.");
    await remember('Mira', 'Grask was killed by Mira at the ford.');
    await remember('Mira', 'Mira is wanted dead or alive in Redham.');
    const survived = await remember('Mira', 'Mira survived the ambush.');
    await remember('Mira', "Mira's brother died in the war.");

    expect(survived.id).toEqual(expect.any(Number));
    const rows = db.prepare('SELECT fact FROM canon_fact WHERE campaign_id = ? AND active = 1 ORDER BY id').all(campaignId);
    expect(rows).toHaveLength(5);
  });

  it('still refuses a death of the subject told by pronoun after the subject survived', async () => {
    await remember('Mira', "Mira's husband was murdered last spring.");
    const survived = await remember('Mira', 'Mira survived the ambush.');
    const text = await refusal('remember', {
      op: 'fact',
      campaign_id: campaignId,
      subject: 'Mira',
      fact: 'She was slain by Grask at the ford.',
    });
    expect(text).toContain(`contradicts active fact ${survived.id} on Mira ("Mira survived the ambush.")`);
  });
});

describe('checkpoint {op: save} carrying a contradicting fact', () => {
  const sceneEnd = (facts: Array<Record<string, unknown>>) => ({
    op: 'save',
    campaign_id: campaignId,
    scene_summary: 'They fought at the ford and Mira fell.',
    facts,
    events: [{ kind: 'narration', text: 'They crossed the ford.' }],
    objectives: [{ title: 'Avenge Mira', kind: 'personal' }],
    glossary: [{ term: 'Black heron', definition: 'The banner of Ashfall Keep.' }],
  });

  it('is refused before anything is written or sent to the window', async () => {
    await call('checkpoint', { op: 'save', campaign_id: campaignId, scene_summary: 'They met Mira at the ferry.' });
    const alive = await remember('Mira Vell', 'Mira Vell is alive and hiding in the marsh.');
    const before = dump();

    let text = '';
    const sent = await published(async () => {
      text = await refusal(
        'checkpoint',
        sceneEnd([
          { subject: 'Ashfall Keep', fact: 'Ashfall Keep flies the black heron banner.' },
          { subject: 'Mira Vell', fact: 'Mira Vell was slain by Grask at the ford.' },
        ]),
      );
    });
    expect(text).toBe(
      `Refused, nothing was saved: facts[1] contradicts active fact ${alive.id} on Mira Vell ("Mira Vell is alive and hiding in the marsh."); if it replaces that fact, pass supersedes_id ${alive.id}, and if it is about someone else, file it under their name. Fix it and re-call checkpoint {op: save}.`,
    );
    expect(sent).toEqual([]);
    expect(dump()).toEqual(before);
  });

  it('refuses two facts of one save that contradict each other, before anything is sent', async () => {
    const before = dump();
    let text = '';
    const sent = await published(async () => {
      text = await refusal(
        'checkpoint',
        sceneEnd([
          { subject: 'Mira Vell', fact: 'Mira Vell died at the ford.' },
          { subject: 'mira vell', fact: 'Mira Vell is alive and hiding in the marsh.' },
        ]),
      );
    });
    expect(text).toBe(
      'Refused, nothing was saved: facts[1] contradicts facts[0] on mira vell (merge the two into one fact). Fix it and re-call checkpoint {op: save}.',
    );
    expect(sent).toEqual([]);
    expect(dump()).toEqual(before);
  });

  it('lets a later fact agree with an earlier one of the same save that superseded the old fact', async () => {
    const alive = await remember('Mira Vell', 'Mira Vell is alive and hiding in the marsh.');
    const saved = await call<{ applied: { facts: number } }>(
      'checkpoint',
      sceneEnd([
        { subject: 'Mira Vell', fact: 'Mira Vell died at the ford.', supersedes_id: alive.id },
        { subject: 'Mira Vell', fact: 'Mira Vell was slain by Grask with a boar spear.' },
      ]),
    );
    expect(saved.applied.facts).toBe(2);
  });
});

describe('entity {op: upsert} with a name close to an existing one', () => {
  it('refuses a near spelling, naming the entry and its id, and writes nothing', async () => {
    const mira = await upsert('npc', 'Mira Vell');
    const before = dump();
    for (const near of ['Mira Vel', 'Míra Vell', 'Vell', 'Vell, Mira']) {
      const text = await refusal('entity', { op: 'upsert', campaign_id: campaignId, kind: 'npc', name: near });
      expect(text).toBe(
        `Refused, nothing was written: did you mean Mira Vell (npc, id ${mira.entity.id})? Re-call with id: ${mira.entity.id} to update it, or with distinct: true if "${near}" is a different entry.`,
      );
    }
    expect(dump()).toEqual(before);
  });

  it('updates by id without the check, keeping the stored name', async () => {
    const mira = await upsert('npc', 'Mira Vell');
    const updated = await call<{ entity: { id: number; name: string; notes: string }; created: boolean }>('entity', {
      op: 'upsert',
      campaign_id: campaignId,
      id: mira.entity.id,
      kind: 'npc',
      name: 'Mira Vel',
      notes: 'Keeps a crossbow under the bar.',
    });
    expect(updated.created).toBe(false);
    expect(updated.entity).toMatchObject({ id: mira.entity.id, name: 'Mira Vell', notes: 'Keeps a crossbow under the bar.' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity').get()).toEqual({ n: 1 });
  });

  it('creates a genuinely different entry with distinct: true, then names every near one', async () => {
    const mira = await upsert('npc', 'Mira Vell', { status: 'dead' });
    const vale = await upsert('npc', 'Mira Vale', { distinct: true });
    const text = await refusal('entity', { op: 'upsert', campaign_id: campaignId, kind: 'npc', name: 'Mira Vall' });
    expect(text).toBe(
      `Refused, nothing was written: did you mean Mira Vell (npc, dead, id ${mira.entity.id}) or Mira Vale (npc, id ${vale.entity.id})? Re-call with the id you mean to update it, or with distinct: true if "Mira Vall" is a different entry.`,
    );
  });

  it('lets through a shared surname, short names a letter apart and a place named after someone', async () => {
    await upsert('npc', 'Mira Vell');
    await upsert('npc', 'Tomas Vell');
    await upsert('npc', 'Nora');
    await upsert('npc', 'Mora');
    await upsert('place', 'Vell Manor');
    await upsert('faction', 'Ash Court');
    const text = await refusal('entity', { op: 'upsert', campaign_id: campaignId, kind: 'faction', name: 'The Ash Court' });
    expect(text).toContain('did you mean Ash Court (faction, id');
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity').get()).toEqual({ n: 6 });
  });

  it('leaves engine callers unchecked', () => {
    upsertEntity(db, { campaign_id: campaignId, kind: 'place', name: 'Ashfall' });
    expect(upsertEntity(db, { campaign_id: campaignId, kind: 'place', name: 'Ashfall Mines' }).created).toBe(true);
  });
});

describe('entity {op: link} with the dead', () => {
  it('refuses a new ally for a dead NPC, quoting the fact that killed them, and writes nothing', async () => {
    await upsert('npc', 'Mira Vell', { status: 'dead' });
    await upsert('npc', 'Grask');
    const slain = await remember('Mira Vell', 'Mira Vell was slain by Grask at the ford.');
    const before = dump();

    const text = await refusal('entity', link('Mira Vell', 'Grask', 'ally'));
    expect(text).toBe(
      `Mira Vell is dead: "Mira Vell was slain by Grask at the ford." (fact id ${slain.id}). Revive them first with entity {op: upsert, kind: npc, name: "Mira Vell", status: alive} and remember {op: fact, supersedes_id: ${slain.id}}, or keep a tie from before the end in the notes.`,
    );
    expect(dump()).toEqual(before);
  });

  it('refuses the dead at either end, and cites the codex status when no fact says so', async () => {
    const mira = await upsert('npc', 'Mira Vell', { status: 'dead' });
    await upsert('npc', 'Grask');

    const text = await refusal('entity', link('Grask', 'Mira Vell', 'serves'));
    expect(text).toBe(
      `Mira Vell is dead (codex entry ${mira.entity.id} has status dead). Revive them first with entity {op: upsert, kind: npc, name: "Mira Vell", status: alive}, or keep a tie from before the end in the notes.`,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM relationship').get()).toEqual({ n: 0 });
  });

  it("cites the codex status, not a fact about a kinsman's death, when no fact says the NPC died", async () => {
    const mira = await upsert('npc', 'Mira Vell', { status: 'dead' });
    await upsert('npc', 'Grask');
    await remember('Mira Vell', "Mira Vell's husband was murdered last spring.");

    const text = await refusal('entity', link('Mira Vell', 'Grask', 'ally'));
    expect(text).toBe(
      `Mira Vell is dead (codex entry ${mira.entity.id} has status dead). Revive them first with entity {op: upsert, kind: npc, name: "Mira Vell", status: alive}, or keep a tie from before the end in the notes.`,
    );
  });

  it('still records family, acquaintance and ties made before the death', async () => {
    await upsert('npc', 'Mira Vell');
    await upsert('npc', 'Grask');
    await upsert('npc', 'Tamsin');
    await call('entity', link('Mira Vell', 'Grask', 'ally'));
    await upsert('npc', 'Mira Vell', { status: 'dead' });

    expect((await call<{ created: boolean }>('entity', link('Mira Vell', 'Tamsin', 'parent'))).created).toBe(true);
    expect((await call<{ created: boolean }>('entity', link('Grask', 'Mira Vell', 'knows'))).created).toBe(true);
    expect((await call<{ created: boolean }>('entity', link('Grask', 'Mira Vell', 'ally'))).created).toBe(false);
  });

  it('lets a revived NPC take new ties again', async () => {
    await upsert('npc', 'Mira Vell', { status: 'dead' });
    await upsert('npc', 'Grask');
    await upsert('npc', 'Mira Vell', { status: 'alive' });
    expect((await call<{ created: boolean }>('entity', link('Mira Vell', 'Grask', 'ally'))).created).toBe(true);
  });

  it('refuses a member for a destroyed faction, but leaves the ties to places the region map writes', async () => {
    const court = await upsert('faction', 'Ash Court');
    await upsert('npc', 'Grask');
    await upsert('place', 'Ashfall');
    insertFaction(db, campaignId, {
      name: 'Ash Court',
      type: 'guild',
      realm_id: null,
      county_id: null,
      place_id: null,
      secrecy: 'open',
      resources: 0,
      capacities: {},
      created_day: 1,
      entity_id: court.entity.id,
      ended_day: 40,
    });

    const text = await refusal('entity', link('Grask', 'Ash Court', 'member_of'));
    expect(text).toBe('Ash Court is destroyed (it ended on day 40). Keep a tie from before the end in the notes instead.');
    expect((await call<{ created: boolean }>('entity', link('Ash Court', 'Ashfall', 'rules'))).created).toBe(true);
  });
});
