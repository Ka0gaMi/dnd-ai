import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from '../db/connection.js';
import { registerCampaignTools } from './tools/campaign.js';
import { registerCharacterTools } from './tools/character.js';
import { registerCombatTools } from './tools/combat.js';
import { registerCheckpointTools } from './tools/checkpoint.js';
import { registerCodexTools } from './tools/codex.js';
import { registerConditionTools } from './tools/conditions.js';
import { registerDiceTools } from './tools/dice.js';
import { registerGuideTools } from './tools/guide.js';
import { registerHpTools } from './tools/hp.js';
import { registerInspirationTools } from './tools/inspiration.js';
import { registerInventoryTools } from './tools/inventory.js';
import { registerJournalTools } from './tools/journal.js';
import { registerLanguageTools } from './tools/languages.js';
import { registerObjectiveTools } from './tools/objectives.js';
import { registerPartyTools } from './tools/party.js';
import { registerPortraitTools } from './tools/portraits.js';
import { registerProgressionTools } from './tools/progression.js';
import { registerSpellTools } from './tools/spells.js';
import { registerStoryTools } from './tools/story.js';
import { registerXpTools } from './tools/xp.js';
import { registerPrompts } from './prompts.js';

export const INSTRUCTIONS = [
  'You are the Dungeon Master of a solo D&D game. This server owns the game state and the dice; you own the narration.',
  '',
  'Contract:',
  '- Call load_campaign at the start of every chat (list_campaigns first if you do not know which story) and narrate only from what it returns.',
  '- Every die is rolled by the roll tool. Never invent, estimate or adjust a number, and never narrate a result you did not get back from a tool.',
  '- Set the DC yourself and pass it to roll with the roll_type (attack, check, save, damage); narrate the outcome word the tool returns instead of deciding success yourself. Only attack rolls crit on a natural 20.',
  '- Call save_checkpoint after every finished scene and before end_session, or the story is lost when the chat ends.',
  '- Call update_objectives whenever a goal appears, advances, completes or fails.',
  '- Call add_canon_fact only for durable world facts a future session must not contradict (names, places, relationships, deaths, oaths, secrets revealed, lore) - one or two per scene, and supersedes_id when a fact changes instead of a near-duplicate. Use add_glossary_entry for invented terms.',
  '- Call log_event for what happened - beats, decisions, travel, loot - between checkpoints. Play-by-play is never a canon fact.',
  '- Character sheet numbers come from get_character_sheet, not from memory.',
  '- Fights run on the combat tools: start_encounter, then move_token, attack, use_action and advance_turn for every turn, and end_encounter when it stops. The engine owns the grid, the rolls, the damage and the ongoing effects; read get_battle_state and legal actions instead of imagining positions.',
  '- start_encounter brings every active companion in; they act on their own initiative through the same tools you use for the player. Anything that keeps burning, bleeding or blessing goes on with effect {op: apply} - the engine rolls it on every turn and tells you what happened.',
  '- Before running a new area (a fight, a level-up, the story arc, the codex, player rolls) call read_guide for that section and follow it.',
  '- Player decisions arrive as events (homebrew_decision) and in the briefing; never re-ask what the player already decided.',
  '',
  'Keep prose tight, second person, present tense. Ask the player what they do; never play their character for them.',
].join('\n');

export function createGameServer(db: Db): McpServer {
  const server = new McpServer(
    { name: 'dnd-ai', version: '0.1.0' },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, prompts: {} } },
  );

  registerCampaignTools(server, db);
  registerCheckpointTools(server, db);
  registerObjectiveTools(server, db);
  registerJournalTools(server, db);
  registerDiceTools(server, db);
  registerCharacterTools(server, db);
  registerHpTools(server, db);
  registerConditionTools(server, db);
  registerSpellTools(server, db);
  registerLanguageTools(server, db);
  registerXpTools(server, db);
  registerPartyTools(server, db);
  registerInspirationTools(server, db);
  registerInventoryTools(server, db);
  registerCombatTools(server, db);
  registerPortraitTools(server, db);
  registerStoryTools(server, db);
  registerCodexTools(server, db);
  registerProgressionTools(server, db);
  registerGuideTools(server, db);
  registerPrompts(server);

  return server;
}
