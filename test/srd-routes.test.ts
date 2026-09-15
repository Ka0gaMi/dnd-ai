import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { saveHomebrew, type OptionDetail } from '../src/core/progression.js';
import { openDb, type Db } from '../src/db/connection.js';
import registerSrdRoutes from '../src/transport/routes/srd.js';

let db: Db;
let base: string;
let campaignId: number;
let close: () => Promise<void>;

const get = async <T>(path: string): Promise<T> => (await fetch(`${base}${path}`)).json() as Promise<T>;

const EMBER_LANCE = {
  name: 'Ember Lance',
  level: 1,
  school: 'evocation',
  casting_time: 'action',
  range: '60 feet',
  components: 'V, S',
  duration: 'instantaneous',
  concentration: false,
  ritual: false,
  effect: { kind: 'auto', damage: { dice: '2d6', type: 'fire' } },
  text: 'A lance of embers spears one creature you can see.',
};

beforeEach(async () => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Spells', story_shape: 'sandbox' }).campaign_id;
  const app = express();
  app.use(express.json());
  registerSrdRoutes(app, db);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  await close();
  db.close();
});

describe('spell tooltips', () => {
  it('answers with the SRD details of the spells it knows and leaves out the rest', async () => {
    const body = await get<{ details: Record<string, OptionDetail> }>('/api/srd/spells?names=Fireball,%20Not%20A%20Spell');
    expect(Object.keys(body.details)).toEqual(['Fireball']);
    expect(body.details.Fireball).toMatchObject({ level: 3, school: 'evocation' });
    expect(body.details.Fireball!.short_text.length).toBeGreaterThan(0);
  });

  it('resolves a campaign spell when the campaign is named', async () => {
    const entry = saveHomebrew(db, {
      campaign_id: campaignId,
      kind: 'spell',
      name: 'Ember Lance',
      schema: EMBER_LANCE,
    });
    const without = await get<{ details: Record<string, OptionDetail> }>('/api/srd/spells?names=Ember%20Lance');
    expect(without.details).toEqual({});

    const body = await get<{ details: Record<string, OptionDetail> }>(
      `/api/srd/spells?names=Ember%20Lance,Fireball&campaign_id=${campaignId}`,
    );
    expect(body.details['Ember Lance']).toMatchObject({ homebrew: true, homebrew_id: entry.id, level: 1 });
    expect(body.details.Fireball).toBeDefined();
  });

  it('answers an empty list with no details and caps a long one', async () => {
    expect(await get<{ details: Record<string, OptionDetail> }>('/api/srd/spells')).toEqual({ details: {} });
    const names = [...Array.from({ length: 60 }, () => 'Not A Spell'), 'Fireball'].join(',');
    const body = await get<{ details: Record<string, OptionDetail> }>(`/api/srd/spells?names=${encodeURIComponent(names)}`);
    expect(body.details.Fireball).toBeUndefined();
  });
});
