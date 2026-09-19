import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { pcRow } from '../../core/campaign.js';
import { applyDamage, checkModifier, concentrationOf, concentrationSaveDc, endConcentration, heal, inActiveEncounter, setTempHp } from '../../core/character.js';
import { playerRollsStep, rollForTool } from '../../core/rolls.js';
import { reply } from './result.js';
import { CHARACTER_ID, WRITES, heldHolderId } from './character-shared.js';

/**
 * Damage taken outside a fight while concentrating: a Constitution save against half the damage,
 * never below DC 10, rolled the way the player's settings say. A failure ends the spell.
 */
async function concentrationSave(
  db: Db,
  input: { campaign_id: number; character_id?: number },
  spell: string,
  damage: number,
): Promise<Record<string, unknown>> {
  const holderId = heldHolderId(db, input);
  const dc = concentrationSaveDc(damage);
  const modifier = checkModifier(db, input.campaign_id, holderId, { save: 'con' });
  const pc = pcRow(db, input.campaign_id);
  const isPlayerCharacter = Boolean(pc) && holderId === (pc!.id as number);
  const roll = await rollForTool(db, {
    expr: modifier.total_modifier === 0 ? '1d20' : `1d20${modifier.total_modifier < 0 ? '' : '+'}${modifier.total_modifier}`,
    purpose: `Concentration save (${spell})`,
    dc,
    roll_type: 'save',
    campaign_id: input.campaign_id,
    roller: playerRollsStep(db, input.campaign_id, isPlayerCharacter, 'save') ? 'player' : 'dm',
  });
  const held = roll.total >= dc;
  if (!held) endConcentration(db, input.campaign_id, holderId, `they failed the DC ${dc} Constitution save`);
  return {
    spell,
    dc,
    total: roll.total,
    modifier: modifier.total_modifier,
    outcome: held ? 'success' : 'failure',
    concentration: held ? 'held' : 'ended',
    rule: 'Damage while concentrating calls for a Constitution save at DC 10 or half the damage, whichever is higher.',
  };
}

export function registerHpTools(server: McpServer, db: Db): void {
  server.registerTool(
    'apply_damage',
    {
      title: 'Apply damage',
      description:
        'Subtracts damage from the character: temporary hit points first, then real ones. Call it every single time something hurts the player or a companion (pass character_id for a companion), and never describe a hit point total you did not get back from this tool. At 0 HP it adds the unconscious condition; a hit while already at 0 costs a death save failure (two on a critical); damage that big enough kills outright is handled here too, from above 0 or already down. Outside a fight, typed damage goes through the character\'s own Resistances, Vulnerabilities and Immunities. Outside a fight, a concentrating character rolls the Constitution save against half the damage (DC 10 at least) here and the reply says whether the spell held. When the player character dies the result carries death_options - a new character with create_character, promote_companion when a companion is in the party, or end_session. Read out exactly the options the tool returned and let the player choose.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        amount: z.number().int().min(0),
        type: z.string().optional().describe('e.g. "slashing", "fire"'),
        source: z.string().optional().describe('What dealt it, e.g. "goblin scimitar".'),
        critical: z.boolean().optional().describe('True if the hit that struck a downed character was a critical.'),
      },
      annotations: { ...WRITES },
    },
    async (input) => {
      const held = concentrationOf(db, input.campaign_id, input.character_id);
      const outsideFight = held !== null && !inActiveEncounter(db, input.campaign_id, heldHolderId(db, input));
      const result = applyDamage(db, input);
      const save =
        held && outsideFight && result.status !== 'dead' && result.hp_current > 0 && result.damage_taken > 0
          ? await concentrationSave(db, input, held.spell, result.damage_taken)
          : null;
      // Down but neither dead nor stabilised: the next call is the death save.
      const next_step =
        result.hp_current === 0 && result.status !== 'dead' && !result.stable
          ? `${result.name} is at 0 HP and unconscious: call death_save at the start of each of their turns until they are stabilised or healed; stabilize or heal ends it.`
          : undefined;
      return reply(db, input.campaign_id, {
        ...result,
        ...(save ? { concentration_save: save } : {}),
        ...(next_step ? { next_step } : {}),
      });
    },
  );

  server.registerTool(
    'heal',
    {
      title: 'Heal the character',
      description:
        'Restores hit points up to the maximum, wakes a character who was unconscious at 0 HP and clears any death save progress. Use it for healing spells, potions and any other effect that gives hit points back, so the sheet stays correct. A dead character cannot be healed this way and the tool says so.',
      inputSchema: { campaign_id: z.number().int(), character_id: CHARACTER_ID, amount: z.number().int().min(0) },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, heal(db, input)),
  );

  server.registerTool(
    'set_temp_hp',
    {
      title: 'Set temporary hit points',
      description:
        'Gives the character temporary hit points, the buffer that damage eats before real hit points. Use it for effects that grant them, such as a Fighter\'s Second Wind or a False Life spell, and pass 0 when something removes them. Temporary hit points never stack: the tool keeps whichever pool is larger and says so, which is the rule players most often get wrong.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        amount: z.number().int().min(0).describe('The new pool; 0 clears the temporary hit points.'),
        source: z.string().optional().describe('What granted them, e.g. "Second Wind".'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, setTempHp(db, input)),
  );
}
