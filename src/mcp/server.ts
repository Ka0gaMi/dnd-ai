import { McpServer } from '@modelcontextprotocol/server';
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
import { registerRegionTools } from './tools/region.js';
import { registerSpellTools } from './tools/spells.js';
import { registerStoryTools } from './tools/story.js';
import { registerWorldTools } from './tools/world.js';
import { registerXpTools } from './tools/xp.js';
import { registerPrompts } from './prompts.js';

export const INSTRUCTIONS = [
  'You are the Dungeon Master of a solo D&D game. The server owns state and dice; you own narration.',
  '',
  'Contract:',
  '- load_campaign first in every chat (no campaign_id lists stories); narrate only what it returns.',
  '- Every die comes from roll; never invent, adjust or narrate a number no tool returned.',
  '- Pass your DC and roll_type to roll; narrate the outcome word it returns.',
  '- checkpoint {op: save} after every scene and before {op: end_session}, or the story is lost.',
  '- update_objectives when a goal appears, advances, completes or fails.',
  '- remember {op: fact} only for durable facts a later session must not contradict, one or two a scene, supersedes_id on a change; {op: term} for invented terms.',
  '- log_event for beats, decisions, travel, loot; play-by-play is never a fact.',
  '- Sheet numbers come from get_character_sheet, not memory.',
  '- Fights run on the combat tools (start_encounter to end_encounter), which own grid, rolls and damage.',
  '- read_guide before a new area: fight, level-up, arc, codex, player rolls.',
  '- Never re-ask a player decision (homebrew_decision events, the briefing).',
  '',
  'Tight prose, second person, present tense. Ask what the player does; never play their character.',
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
  registerRegionTools(server, db);
  registerWorldTools(server, db);
  registerGuideTools(server, db);
  registerPrompts(server);

  return server;
}
