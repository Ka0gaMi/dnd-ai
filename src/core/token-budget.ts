// DM token budgets, estimated as characters over four, so a briefing block cannot crowd a session out
// of the model's context. Each block trims itself toward its ceiling rather than refusing to answer.

/** Rough token count of `text`, the same characters-over-four estimate every budget uses. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const WORLD_BRIEFING = 1500;
export const REGION_BRIEFING = 1200;
export const QUARTER_COUNCIL = 800;
export const NPC_DIGEST = 250;
export const WORLD_GET = 2500;
