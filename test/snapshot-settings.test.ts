// The briefing and the window's snapshot carry the stored settings as getSettings reads them: a campaign saved
// with the retired strict rules_mode reads flexible there too, and nothing else in the payload changes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { campaignSnapshot, createCampaign } from '../src/core/campaign.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

/** Writes settings_json as an old campaign saved it, past the validation a write goes through now. */
function storeRaw(settings: Record<string, unknown>): void {
  db.prepare('UPDATE campaign SET settings_json = ? WHERE id = ?').run(JSON.stringify(settings), campaignId);
}

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Old Save', story_shape: 'sandbox' }).campaign_id;
});

afterEach(() => db.close());

describe('settings in the campaign snapshot', () => {
  it('reads a stored strict as flexible for the DM and the player, keeping exactly the stored keys', () => {
    storeRaw({ rules_mode: 'strict', lines: 'no spiders', legacy_dial: 3 });
    for (const forPlayer of [false, true]) {
      expect(campaignSnapshot(db, campaignId, { forPlayer }).campaign.settings).toEqual({
        rules_mode: 'flexible',
        lines: 'no spiders',
        legacy_dial: 3,
      });
    }
  });

  it('leaves settings that need no mapping as they were stored', () => {
    storeRaw({ rules_mode: 'freeform', dc_disclosure: 'shown' });
    expect(campaignSnapshot(db, campaignId).campaign.settings).toEqual({ rules_mode: 'freeform', dc_disclosure: 'shown' });
  });
});
