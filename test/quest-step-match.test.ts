import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, upsertQuests } from '../src/core/campaign.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let cid: number;

beforeEach(() => {
  db = openDb(':memory:');
  cid = createCampaign(db, { name: 'Steps', story_shape: 'sandbox' }).campaign_id;
});

function steps(quests: ReturnType<typeof upsertQuests>, id: number) {
  return quests.find((q) => q.id === id)!.steps;
}

describe('upsertQuests step matching', () => {
  it('ticks an existing step by text ignoring case and spacing, adding none', () => {
    const [q] = upsertQuests(db, cid, [{ title: 'Q', steps: [{ text: 'See the Guildmaster answer' }] }]);
    const out = upsertQuests(db, cid, [
      { id: q.id, title: 'Q', steps: [{ text: '  see  the GUILDMASTER   answer ', done: true }] },
    ]);
    const s = steps(out, q.id);
    expect(s).toHaveLength(1);
    expect(s[0].text).toBe('See the Guildmaster answer');
    expect(s[0].done).toBeTruthy();
  });

  it('leaves a done step done when re-sent without done', () => {
    const [q] = upsertQuests(db, cid, [{ title: 'Q', steps: [{ text: 'Step', done: true }] }]);
    const s = steps(upsertQuests(db, cid, [{ id: q.id, title: 'Q', steps: [{ text: 'step' }] }]), q.id);
    expect(s).toHaveLength(1);
    expect(s[0].done).toBeTruthy();
  });

  it('adds a step for new text', () => {
    const [q] = upsertQuests(db, cid, [{ title: 'Q', steps: [{ text: 'One' }] }]);
    const s = steps(upsertQuests(db, cid, [{ id: q.id, title: 'Q', steps: [{ text: 'Two' }] }]), q.id);
    expect(s.map((x) => x.text)).toEqual(['One', 'Two']);
  });

  it('does not match the same text in another quest', () => {
    const [a] = upsertQuests(db, cid, [{ title: 'A', steps: [{ text: 'Shared' }] }]);
    const out = upsertQuests(db, cid, [{ title: 'B', steps: [{ text: 'Shared', done: true }] }]);
    const b = out.find((q) => q.id !== a.id)!;
    expect(steps(out, a.id)[0].done).toBeFalsy();
    expect(steps(out, b.id)).toHaveLength(1);
  });

  it('still updates by id', () => {
    const [q] = upsertQuests(db, cid, [{ title: 'Q', steps: [{ text: 'Old' }] }]);
    const id = steps([q], q.id)[0].id;
    const s = steps(upsertQuests(db, cid, [{ id: q.id, title: 'Q', steps: [{ id, text: 'New', done: true }] }]), q.id);
    expect(s).toHaveLength(1);
    expect(s[0].text).toBe('New');
    expect(s[0].done).toBeTruthy();
  });
});
