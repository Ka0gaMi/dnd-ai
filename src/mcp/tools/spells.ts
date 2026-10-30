import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { grantSpellRuling, inActiveEncounter, learnSpell, prepareSpells, useSpellSlot } from '../../core/character.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';
import { WRITES, heldHolderId } from './character-shared.js';
import { CAMPAIGN_ID, CHARACTER_ID } from './fields.js';

export function registerSpellTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'spells', {
    title: 'Spells known, prepared and slots',
    description:
      'Cleric, Druid, Paladin and Wizard prepare their list on a long rest (op=prepare): the class table count, nothing above a castable level, a Wizard only from the spellbook; errors give the count and pool. Bards, Rangers, Sorcerers and Warlocks swap a spell on level_up instead. op=learn copies a found spell into a Wizard\'s spellbook (narrate the cost). op=grant adds a class-list spell outside a level-up as a ruling, no higher than their top slot, cantrips too. op=spend_slot spends a slot for every out-of-combat level 1+ spell and records Concentration (a second one ends the first); an empty level is refused until a rest, and in a fight use_action spends the slot so this refuses. Pass spell "Identify" with target_item to identify an item.',
    fields: {
      campaign_id: CAMPAIGN_ID,
      character_id: CHARACTER_ID,
      spells: z.array(z.string()).optional().describe('(op=prepare) The complete new prepared list, not the changes to it.'),
      spell: z
        .string()
        .optional()
        .describe(
          '(op=learn, op=grant, op=spend_slot) SRD name, on their class list and castable (cantrips count); always pass it to spend_slot so Concentration is recorded.',
        ),
      reason: z
        .string()
        .optional()
        .describe('(op=grant) What the player is owed, or why; logged with the spell.'),
      level: z.number().int().min(1).max(9).optional().describe('(op=spend_slot) The slot level to spend.'),
      target_item: z
        .string()
        .optional()
        .describe('(op=spend_slot) Identify only: the unidentified item, by name or id.'),
    },
    shared: ['character_id'],
    ops: {
      prepare: {
        summary: 'Set the prepared list of a preparing caster after a long rest',
        requires: ['spells'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, prepareSpells(db, { ...input, spells: input.spells! }));
        },
      },
      learn: {
        summary: "Copy a found spell into a Wizard's spellbook",
        requires: ['spell'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, learnSpell(db, { ...input, spell: input.spell! }));
        },
      },
      grant: {
        summary: 'Grant a class-list spell outside a level-up, as a ruling',
        requires: ['spell', 'reason'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, grantSpellRuling(db, { ...input, spell: input.spell!, reason: input.reason! }));
        },
      },
      spend_slot: {
        summary: 'Spend a spell slot outside a fight (use_action spends it inside one)',
        requires: ['level'],
        uses: ['spell', 'target_item'],
        run: (args) => {
          const { op, ...input } = args;
          // use_action spends the slot on the caster's own sheet, so a second call here would spend two.
          const characterId = heldHolderId(db, input);
          if (inActiveEncounter(db, input.campaign_id, characterId)) {
            const { name } = db.prepare('SELECT name FROM character WHERE id = ?').get(characterId) as { name: string };
            throw new Error(`${name} is in a fight: use_action {spell, slot_level} spends the slot itself. Call that instead.`);
          }
          return reply(db, input.campaign_id, useSpellSlot(db, { ...input, level: input.level! }));
        },
      },
    },
    annotations: { ...WRITES },
  });
}
