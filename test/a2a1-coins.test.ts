// A2a-1 coins: fifty coins of any kind weigh 1 lb and count toward carried weight.
import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign, getCharacterSheet } from '../src/core/campaign.js';
import { openDb, type Db } from '../src/db/connection.js';
import { carriedLoad } from '../src/core/rules.js';

describe('carriedLoad with coins', () => {
  it('weighs 500 gp at 10 lb', () => {
    expect(carriedLoad([], 10, { gp: 500 })).toMatchObject({ carried_lb: 10, coins_lb: 10 });
  });

  it('counts mixed coins together', () => {
    const load = carriedLoad([{ weight_lb: 5 }], 10, { cp: 20, sp: 20, ep: 10, gp: 30, pp: 20 });
    expect(load).toMatchObject({ carried_lb: 7, coins_lb: 2 });
  });

  it('adds nothing without coins', () => {
    expect(carriedLoad([{ weight_lb: 5 }], 10)).toMatchObject({ carried_lb: 5, coins_lb: 0 });
    expect(carriedLoad([{ weight_lb: 5 }], 10, {})).toMatchObject({ carried_lb: 5, coins_lb: 0 });
  });

  it('reads over: true when coins alone pass capacity', () => {
    expect(carriedLoad([], 10, { gp: 7500 }).over).toBe(false); // 150 lb = capacity
    expect(carriedLoad([], 10, { gp: 7550 }).over).toBe(true);
  });
});

describe('player sheet', () => {
  let db: Db;
  let campaignId: number;

  beforeEach(() => {
    db = openDb(':memory:');
    campaignId = createCampaign(db, { name: 'Purse', story_shape: 'sandbox' }).campaign_id;
  });

  const insert = (coinsJson: string | null, gold: number) =>
    db
      .prepare(
        "INSERT INTO character (campaign_id, name, is_pc, class, level, hp_current, hp_max, abilities_json, inventory_json, gold, coins_json, created_at, updated_at) VALUES (?, 'Zara', 1, 'Rogue', 1, 10, 10, '{\"str\":{\"score\":10}}', '[{\"name\":\"Rope\",\"weight_lb\":5}]', ?, ?, 't', 't')",
      )
      .run(campaignId, gold, coinsJson);

  it('includes coins in carried_lb', () => {
    insert(JSON.stringify({ gp: 100, sp: 50 }), 105);
    expect(getCharacterSheet(db, campaignId)).toMatchObject({ carried_lb: 8 }); // 5 + 150 / 50
  });

  it('falls back to the gold column for a row without coins_json', () => {
    insert(null, 500);
    expect(getCharacterSheet(db, campaignId)).toMatchObject({ carried_lb: 15 });
  });
});
