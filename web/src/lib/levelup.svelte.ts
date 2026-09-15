// The level-up dialog: one shared instance, holding the window the sheet header and the dialog both read.
import { getLevelUp } from './api';
import { pendingLevelUp, type LevelUpAnswer, type LevelUpWindow } from './progression';

const state = $state<{
  answer: LevelUpAnswer | null;
  open: boolean;
  /** The prepared_at stamp the dialog has already shown itself for. */
  announced: string | null;
}>({ answer: null, open: false, announced: null });

export const levelup = state;

/** The window the DM has prepared, or null while there is nothing to answer. */
export const preparedLevelUp = (): LevelUpWindow | null => pendingLevelUp(state.answer);

/** A level is waiting, but the DM has not prepared the options yet. */
export const awaitingDm = (): boolean => state.answer?.available === true && state.answer.level_up === null;

export function openLevelUp(): void {
  if (preparedLevelUp()) state.open = true;
}

/** Esc and Close only hide it: the level-up stays pending until the player confirms. */
export function closeLevelUp(): void {
  state.open = false;
}

/** A window prepared since the last look shows itself; one already seen stays as the player left it. */
export function applyAnswer(answer: LevelUpAnswer | null): void {
  state.answer = answer;
  const stamp = preparedLevelUp()?.prepared_at ?? null;
  if (stamp === state.announced) return;
  state.announced = stamp;
  state.open = stamp !== null;
}

/** The level is taken: the dialog goes, and the window it showed never shows itself again. */
export function spendLevelUp(): void {
  state.answer = null;
  state.open = false;
}

export async function refreshLevelUp(characterId: number | null): Promise<void> {
  if (characterId === null) {
    applyAnswer(null);
    return;
  }
  try {
    applyAnswer(await getLevelUp(characterId));
  } catch {
    applyAnswer(null);
  }
}
