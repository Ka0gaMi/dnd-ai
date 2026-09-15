import { describe, expect, it } from 'vitest';
import {
  applyAnswer,
  awaitingDm,
  closeLevelUp,
  levelup,
  openLevelUp,
  preparedLevelUp,
  spendLevelUp,
} from '../src/lib/levelup.svelte';
import type { LevelUpAnswer } from '../src/lib/progression';

const answer = (prepared_at: string | null, available = true): LevelUpAnswer => ({
  character_id: 4,
  available,
  level_up: { to_level: 4, prepared_at, srd: {}, suggestions: [] },
});

describe('the level-up dialog store', () => {
  it('shows itself for a window the DM has just prepared', () => {
    applyAnswer(null);
    expect(levelup.open).toBe(false);

    applyAnswer(answer('2026-09-12T10:00:00.000Z'));
    expect(levelup.open).toBe(true);
    expect(preparedLevelUp()?.to_level).toBe(4);
  });

  it('stays hidden through a refetch of the window the player closed', () => {
    applyAnswer(null);
    applyAnswer(answer('2026-09-12T10:00:00.000Z'));
    closeLevelUp();

    applyAnswer(answer('2026-09-12T10:00:00.000Z'));
    expect(levelup.open).toBe(false);
    // Still pending, so the sheet header can ask for it again.
    openLevelUp();
    expect(levelup.open).toBe(true);
  });

  it('shows itself again when the DM prepares the window afresh', () => {
    applyAnswer(null);
    applyAnswer(answer('2026-09-12T10:00:00.000Z'));
    closeLevelUp();
    applyAnswer(answer('2026-09-12T11:30:00.000Z'));
    expect(levelup.open).toBe(true);
  });

  it('never reopens the window whose level was taken', () => {
    applyAnswer(null);
    applyAnswer(answer('2026-09-12T10:00:00.000Z'));
    spendLevelUp();
    expect(levelup.open).toBe(false);

    // A refetch that has not caught up yet still carries the spent window.
    applyAnswer(answer('2026-09-12T10:00:00.000Z'));
    expect(levelup.open).toBe(false);
  });

  it('opens for nothing while no window is prepared', () => {
    applyAnswer({ character_id: 4, available: true, level_up: null });
    expect(awaitingDm()).toBe(true);
    expect(preparedLevelUp()).toBeNull();
    openLevelUp();
    expect(levelup.open).toBe(false);
    applyAnswer(null);
  });
});
