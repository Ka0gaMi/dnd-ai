// The companion sheet overlay: which companion is open, and the masked sheet the route returned.
import { getCompanionSheet } from './api';
import type { Pc, Snapshot } from './types';

const state = $state<{
  id: number | null;
  sheet: Pc | null;
  error: string | null;
}>({ id: null, sheet: null, error: null });

export const companionSheet = state;

/** The last snapshot the connection sent: a replace is the cheapest sign a character moved. */
let lastSnapshot: Snapshot | null = null;

/** Opens a companion's sheet, dropping whatever the previous one showed. */
export function openCompanionSheet(id: number): void {
  state.id = id;
  state.sheet = null;
  state.error = null;
}

export function closeCompanionSheet(): void {
  state.id = null;
  state.sheet = null;
  state.error = null;
  lastSnapshot = null;
}

/** Fetches the open companion's sheet; a response for a since-replaced id is dropped. */
export async function loadCompanionSheet(): Promise<void> {
  const id = state.id;
  if (id === null) return;
  try {
    const sheet = await getCompanionSheet(id);
    if (state.id === id) {
      state.sheet = sheet;
      state.error = null;
    }
  } catch (failure) {
    if (state.id === id) state.error = failure instanceof Error ? failure.message : String(failure);
  }
}

/** Refetches an open sheet when the connection replaces the snapshot, never on a timer. */
export function syncCompanionSheet(snapshot: Snapshot | null): Promise<void> {
  if (snapshot === lastSnapshot) return Promise.resolve();
  lastSnapshot = snapshot;
  return loadCompanionSheet();
}
