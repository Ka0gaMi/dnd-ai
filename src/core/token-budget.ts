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

// Tool-surface budgets (playability review 2026-10-06), checked against tools/list by test/tool-surface-budget.test.ts.
// A ratchet holds a cap that does not hold yet at today's size; the diets lower it until the target applies.

/** tools/list in tokens: the target after A0, and the ceiling for the end of the plan. */
export const TOOLS_LIST_TARGET = 40_000;
export const TOOLS_LIST_PLAN_MAX = 50_000;
/** Ratchet: at the target, measured at 37,595 after the description diet (46,253 before it, 63,748 on 971ec85). */
export const TOOLS_LIST_RATCHET = 40_000;

/** Tokens for one tool's whole tools/list entry: the core combat tools, and every other tool. */
export const TOOL_TOKENS_COMBAT = 2_500;
export const TOOL_TOKENS = 1_250;
/** The turn-loop tools that get the combat budget. */
export const CORE_COMBAT_TOOLS: readonly string[] = [
  'start_encounter',
  'add_combatant',
  'get_battle_state',
  'find_position',
  'move_token',
  'attack',
  'use_action',
  'effect',
  'advance_turn',
  'undo_last_combat_action',
  'end_encounter',
];

/** Characters: a tool description, one generated `op=` line, and one field description at any depth. */
export const TOOL_DESCRIPTION_CHARS = 1_800;
export const OP_LINE_CHARS = 200;
export const FIELD_DESCRIPTION_CHARS = 160;

export const OPS_PER_TOOL = 8;
export const TOOL_COUNT = 56;

/** No sub-schema longer than this may appear twice across tools/list. */
export const REPEATED_SUBSCHEMA_CHARS = 1_024;
/** Ratchet: characters of such sub-schemas repeating one already listed; 0 since the description diet (74,225 on 971ec85). */
export const REPEATED_SUBSCHEMA_RATCHET = 0;

export type SurfaceMetric = 'tokens' | 'description' | 'op_line' | 'field';

/** Named exceptions to the per-tool token cap, meant to stay, unlike a ratchet. */
export const TOOL_TOKEN_EXCEPTIONS: Readonly<Record<string, { tokens: number; reason: string }>> = {
  check_mechanics: {
    tokens: 3_500,
    reason: 'It alone publishes the full clause grammar, so every other homebrew tool can take clauses as plain objects.',
  },
};

/** Ratchets for the tools still over a per-tool cap after the description diet, just above their size; their schemas alone fill most of the cap. */
export const TOOL_RATCHETS: Readonly<Record<string, Partial<Record<SurfaceMetric, number>>>> = {
  propose: { tokens: 1_975 },
  inventory: { tokens: 1_800 },
};

// Claude host caps (Claude as DM host research, 2026-10-29).

/** Claude Code cuts a tool description (and the server instructions) at this many characters. */
export const CLAUDE_DESCRIPTION_CHARS = 4_096;
/** A tool reply's text over this many characters goes to a file in Claude Code instead of the model. */
export const CLAUDE_REPLY_CHARS = 50_000;
/** Documented only: one model hop's whole prompt should stay under this many tokens. */
export const CLAUDE_PROMPT_PER_HOP_TOKENS = 100_000;
