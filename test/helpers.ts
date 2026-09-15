// Answers every pending roll the moment the server asks for it, the way a player who clicks at once
// would, so a tool call that waits for the player still runs at test speed.
import { bus } from '../src/core/bus.js';
import { resolvePendingRoll, type PendingRollRow } from '../src/core/rolls.js';
import type { Db } from '../src/db/connection.js';

/** Returns the unsubscribe function; call it when the test is done. */
export function resolvePendingRollsImmediately(db: Db): () => void {
  return bus.subscribe((event) => {
    if (event.kind !== 'pending_roll') return;
    resolvePendingRoll(db, (event.payload as PendingRollRow).id);
  });
}
