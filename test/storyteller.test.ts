import { beforeEach, describe, expect, it } from 'vitest';
import { createCampaign } from '../src/core/campaign.js';
import { dmVisibleSettings, getSettings, updateSettings } from '../src/core/settings.js';
import { STORYTELLER_CAPS, storytellerCaps } from '../src/core/storyteller.js';
import { openDb, type Db } from '../src/db/connection.js';

let db: Db;
let campaignId: number;

beforeEach(() => {
  db = openDb(':memory:');
  campaignId = createCampaign(db, { name: 'Storyteller Test', story_shape: 'sandbox' }).campaign_id;
});

describe('the storyteller caps table', () => {
  it('freezes the world for off', () => {
    expect(storytellerCaps('off')).toBeNull();
  });

  it('gives steady the exact values', () => {
    expect(storytellerCaps('steady')).toEqual({
      events_per_day: 2,
      quiet_days_after_major: 4,
      major_severity: 4,
      threat_scale: 1,
    });
    expect(STORYTELLER_CAPS.steady).toEqual(storytellerCaps('steady'));
  });

  it('caps the other styles too', () => {
    expect(storytellerCaps('calm')).toEqual({
      events_per_day: 1,
      quiet_days_after_major: 7,
      major_severity: 4,
      threat_scale: 0.5,
    });
    expect(storytellerCaps('chaotic')).toEqual({
      events_per_day: 4,
      quiet_days_after_major: 1,
      major_severity: 5,
      threat_scale: 1.5,
    });
  });
});

describe('the storyteller campaign setting', () => {
  it('defaults to steady on a new campaign', () => {
    expect(getSettings(db, campaignId).storyteller).toBe('steady');
  });

  it('persists a patch and rejects an invalid value', () => {
    expect(updateSettings(db, campaignId, { storyteller: 'calm' }).storyteller).toBe('calm');
    expect(getSettings(db, campaignId).storyteller).toBe('calm');
    expect(() => updateSettings(db, campaignId, { storyteller: 'wild' as never })).toThrow();
  });

  it('stays visible to the DM', () => {
    expect(dmVisibleSettings({ storyteller: 'chaotic', cheat_mode: true })).toEqual({ storyteller: 'chaotic' });
  });
});
