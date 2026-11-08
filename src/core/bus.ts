import { EventEmitter } from 'node:events';

export interface GameEvent {
  campaign_id: number;
  event_id: number | null;
  kind: string;
  text: string;
  ts: string;
  payload?: unknown;
}

/** The queues of the holds now running, innermost last; publish goes to the innermost while any is open. */
const held: GameEvent[][] = [];

/** In-process fan-out of game events; the /ws transport (and WP3's UI) is the only consumer. */
class GameBus extends EventEmitter {
  publish(event: GameEvent): void {
    const queue = held.at(-1);
    if (queue) queue.push(event);
    else this.emit('game', event);
  }

  subscribe(listener: (event: GameEvent) => void): () => void {
    this.on('game', listener);
    return () => void this.off('game', listener);
  }
}

export const bus = new GameBus();

/**
 * Runs a synchronous `fn` with its events held: they are published when it returns and dropped when it throws,
 * so a rolled-back transaction shows nothing; an inner hold hands its events to the outer one. Never await inside it.
 */
export function holdEvents<T>(fn: () => T): T {
  const queue: GameEvent[] = [];
  held.push(queue);
  let result: T;
  try {
    result = fn();
  } finally {
    held.pop();
  }
  for (const event of queue) bus.publish(event);
  return result;
}
