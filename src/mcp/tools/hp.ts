import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { pcRow } from '../../core/campaign.js';
import { applyDamage, checkModifier, concentrationOf, concentrationSaveDc, endConcentration, heal, inActiveEncounter, setTempHp } from '../../core/character.js';
import { playerRollsStep, rollForTool } from '../../core/rolls.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';
import { WRITES, heldHolderId } from './character-shared.js';
import { CAMPAIGN_ID, CHARACTER_ID } from './fields.js';

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
  registerOpTool(server, 'hp', {
    title: 'Hit points',
    description:
      'Hit points of the player character or a companion. Call it whenever something hurts them, and never describe a total you did not get back. Damage eats temporary HP first; at 0 HP the target falls unconscious, a hit at 0 costs a death save failure (two on a critical), and a big enough hit kills outright. Outside a fight, typed damage applies resistances and immunities, and concentration calls a CON save (DC 10 or half the damage) the reply reports. A death lists death_options to read out exactly and let the player choose. Healing wakes a character at 0 HP and clears death saves; the dead cannot be healed. Temporary HP never stack: the larger pool wins, and 0 clears it.',
    fields: {
      campaign_id: CAMPAIGN_ID,
      character_id: CHARACTER_ID,
      amount: z
        .number()
        .int()
        .min(0)
        .describe('Damage dealt, hit points restored, or the new temporary pool (0 clears it).'),
      type: z.string().optional().describe('(op=damage) e.g. "slashing", "fire"'),
      source: z.string().optional().describe('(op=damage, op=temp) What dealt it or granted them, e.g. "goblin scimitar", "Second Wind".'),
      critical: z.boolean().optional().describe('(op=damage) The hit on a downed character was a critical.'),
    },
    shared: ['character_id'],
    ops: {
      damage: {
        summary: 'Subtract damage, temporary hit points first',
        requires: [],
        uses: ['type', 'source', 'critical'],
        run: async (args) => {
          const { op, ...input } = args;
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
              ? `${result.name} is at 0 HP and unconscious: call condition{op: death_save} at the start of each of their turns until they are stabilised or healed; condition{op: stabilize} or hp{op: heal} ends it.`
              : undefined;
          return reply(db, input.campaign_id, {
            ...result,
            ...(save ? { concentration_save: save } : {}),
            ...(next_step ? { next_step } : {}),
          });
        },
      },
      heal: {
        summary: 'Restore hit points, wake a character at 0 HP and clear death saves',
        requires: [],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, heal(db, input));
        },
      },
      temp: {
        summary: 'Set the temporary hit point pool',
        requires: [],
        uses: ['source'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, setTempHp(db, input));
        },
      },
    },
    annotations: { ...WRITES },
  });
}
