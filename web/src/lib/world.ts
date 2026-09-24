// The player's view of the living world: news, threats as clocks, and how factions regard the party.

export interface WorldNews {
  id: number;
  text: string;
  /** Heard here rather than carried in from afar. */
  local: boolean;
}

export interface WorldClock {
  id: number;
  faction: string;
  emblem: string | null;
  goal: string;
  filled: number;
  size: number;
  signs: string[];
}

export interface WorldRegard {
  id: number;
  faction: string;
  emblem: string | null;
  value: number;
  reasons: Array<{ reason: string; value: number }>;
}

export interface PlayerWorld {
  /** Newest first. */
  news: WorldNews[];
  clocks: WorldClock[];
  regard: WorldRegard[];
}

/** How a faction reads the party, in words; the numbers are the thresholds. */
export function regardLabel(value: number): string {
  if (value <= -6) return 'hostile';
  if (value <= -2) return 'wary';
  if (value < 2) return 'neutral';
  if (value < 6) return 'friendly';
  return 'devoted';
}

/** The living world's player-safe view, or null before the DM has started one. */
export async function getWorld(campaignId: number): Promise<PlayerWorld | null> {
  const path = `/api/campaigns/${campaignId}/world`;
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return ((await res.json()) as { world: PlayerWorld | null }).world;
}
