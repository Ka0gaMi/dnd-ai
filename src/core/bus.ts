import { EventEmitter } from 'node:events';

export interface GameEvent {
  campaign_id: number;
  event_id: number | null;
  kind: string;
  text: string;
  ts: string;
  payload?: unknown;
}

/** In-process fan-out of game events; the /ws transport (and WP3's UI) is the only consumer. */
class GameBus extends EventEmitter {
  publish(event: GameEvent): void {
    this.emit('game', event);
  }

  subscribe(listener: (event: GameEvent) => void): () => void {
    this.on('game', listener);
    return () => void this.off('game', listener);
  }
}

export const bus = new GameBus();
