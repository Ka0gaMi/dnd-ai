import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, luckWord, mergeSettings } from '../src/lib/settings';

describe('settings', () => {
  it('applies a patch over what is on screen', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { visibility: 'full', cheat_mode: true });
    expect(merged).toMatchObject({ visibility: 'full', cheat_mode: true, roll_timeout_s: 45 });
    expect(DEFAULT_SETTINGS.visibility).toBe('bars');
  });

  it('ignores unknown keys, wrong types and nonsense values', () => {
    const merged = mergeSettings(
      { ...DEFAULT_SETTINGS, luck_bias: 1 },
      { visibility: 'sideways', cheat_mode: 'yes', roll_mode: 'dm', roll_timeout_s: 0, setting_preset: 'grimdark' },
    );
    expect(merged).toEqual({ ...DEFAULT_SETTINGS, luck_bias: 1 });
    expect(mergeSettings(DEFAULT_SETTINGS, null)).toEqual(DEFAULT_SETTINGS);
  });

  it('takes the player_rolls dial and ignores a value the server would refuse', () => {
    expect(DEFAULT_SETTINGS.player_rolls).toBe('all');
    expect(mergeSettings(DEFAULT_SETTINGS, { player_rolls: 'd20_only' }).player_rolls).toBe('d20_only');
    expect(mergeSettings(DEFAULT_SETTINGS, { player_rolls: 'sometimes' }).player_rolls).toBe('all');
  });

  it('clamps the luck dial and names every notch', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, { luck_bias: 9 }).luck_bias).toBe(2);
    expect(mergeSettings(DEFAULT_SETTINGS, { luck_bias: -9 }).luck_bias).toBe(-2);
    expect([-2, -1, 0, 1, 2].map(luckWord)).toEqual(['Cursed', 'Unlucky', 'Fair', 'Lucky', 'Blessed']);
  });

  it('takes the encumbrance dial and ignores a value the server would refuse', () => {
    expect(DEFAULT_SETTINGS.encumbrance).toBe('rules');
    expect(mergeSettings(DEFAULT_SETTINGS, { encumbrance: 'off' }).encumbrance).toBe('off');
    expect(mergeSettings(DEFAULT_SETTINGS, { encumbrance: 'sometimes' }).encumbrance).toBe('rules');
  });

  it('takes the spoiler toggle, defaulting off', () => {
    expect(DEFAULT_SETTINGS.show_secrets).toBe(false);
    expect(mergeSettings(DEFAULT_SETTINGS, { show_secrets: true }).show_secrets).toBe(true);
    expect(mergeSettings(DEFAULT_SETTINGS, { show_secrets: 'yes' }).show_secrets).toBe(false);
  });

  it('takes the auto_portraits toggle, defaulting on', () => {
    expect(DEFAULT_SETTINGS.auto_portraits).toBe(true);
    expect(mergeSettings(DEFAULT_SETTINGS, { auto_portraits: false }).auto_portraits).toBe(false);
    expect(mergeSettings(DEFAULT_SETTINGS, { auto_portraits: 'yes' }).auto_portraits).toBe(true);
  });

  it('takes the difficulty dial, defaulting standard', () => {
    expect(DEFAULT_SETTINGS.difficulty).toBe('standard');
    expect(mergeSettings(DEFAULT_SETTINGS, { difficulty: 'deadly' }).difficulty).toBe('deadly');
    expect(mergeSettings(DEFAULT_SETTINGS, { difficulty: 'nightmare' }).difficulty).toBe('standard');
  });

  it('takes the treasure pacing dial, defaulting standard', () => {
    expect(DEFAULT_SETTINGS.treasure_pacing).toBe('standard');
    expect(mergeSettings(DEFAULT_SETTINGS, { treasure_pacing: 'generous' }).treasure_pacing).toBe('generous');
    expect(mergeSettings(DEFAULT_SETTINGS, { treasure_pacing: 'lots' }).treasure_pacing).toBe('standard');
  });

  it('takes the rules_coach toggle, defaulting on', () => {
    expect(DEFAULT_SETTINGS.rules_coach).toBe(true);
    expect(mergeSettings(DEFAULT_SETTINGS, { rules_coach: false }).rules_coach).toBe(false);
    expect(mergeSettings(DEFAULT_SETTINGS, { rules_coach: 'no' }).rules_coach).toBe(true);
  });

  it('takes the storyteller dial, defaulting steady', () => {
    expect(DEFAULT_SETTINGS.storyteller).toBe('steady');
    expect(mergeSettings(DEFAULT_SETTINGS, { storyteller: 'chaotic' }).storyteller).toBe('chaotic');
    expect(mergeSettings(DEFAULT_SETTINGS, { storyteller: 'sometimes' }).storyteller).toBe('steady');
    expect(mergeSettings(DEFAULT_SETTINGS, { storyteller: 'off' }).storyteller).toBe('off');
  });
});
