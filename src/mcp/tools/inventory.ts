import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { addItem, adjustGold, equipItem, listInventory, removeItem, sellItem, useItem } from '../../core/character.js';
import { clausesSchema } from '../../core/mechanics.js';
import { registerOpTool } from './op.js';
import { parseHomebrew } from './progression.js';
import { reply } from './result.js';
import { COIN_PURSE, ITEM_MAGIC, ITEM_REF, WRITES } from './character-shared.js';
import { CAMPAIGN_ID, CHARACTER_ID } from './fields.js';

/** ITEM_MAGIC with its clauses admitted as any objects: check_mechanics publishes the grammar, and op=add parses it. */
const MAGIC = ITEM_MAGIC.extend({
  mechanics: ITEM_MAGIC.shape.mechanics
    .unwrap()
    .extend({
      clauses: z
        .array(z.looseObject({}))
        .optional()
        .describe('What it does while worn (and attuned if asked), as clauses, at most four. check_mechanics publishes the grammar.'),
    })
    .optional()
    .describe('What the item does in numbers.'),
});

export function registerInventoryTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'inventory', {
    title: 'Gold, items and equipment',
    description:
      "Gold and items change only here: never narrate a price paid or an item found without calling it. gold takes delta or coins, never both; change is made across denominations, and it refuses only when the whole purse is worth less, unless allow_debt. Buying an item is add with cost_gp. add copies an SRD item's stats and weight, and an SRD magic name or +N its magic; an invented item needs magic.rarity, and a bonus needs base. Over STR x 15 lb it warns and drops speed to 5 ft. remove reaches into containers, and when no such name is carried it lists what is: read that back, never invent their pack. equip recomputes AC with ac_breakdown: read that AC back, never compute one. list changes nothing. use spends charges, refuses at zero and casts nothing. sell pays half the SRD price unless you pass price_gp, which a magic item needs; a gift or a theft is remove. Something equipped or attuned, or a container still holding something, needs force.",
    fields: {
      campaign_id: CAMPAIGN_ID,
      character_id: CHARACTER_ID,
      delta: z.number().int().optional().describe('(op=gold) Gold pieces, negative to spend; this or coins.'),
      coins: COIN_PURSE.optional().describe('(op=gold) Exact coins instead of delta, e.g. {sp: -5}.'),
      reason: z.string().optional().describe('(op=gold) What it was for.'),
      allow_debt: z.boolean().optional().describe('(op=gold, op=add) Let the purse go below zero.'),
      name: z
        .string()
        .optional()
        .describe('(op=add) The SRD name where there is one; (op=remove, op=equip) an item carried, by name or id.'),
      item: z.string().optional().describe(`(op=use, op=sell) ${ITEM_REF}`),
      qty: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('(op=add, op=remove, op=sell) How many: 1 by default, the whole stack for remove.'),
      notes: z.string().optional().describe('(op=add) Your own description, replacing the SRD one.'),
      equipped: z.boolean().optional().describe('(op=add, op=equip) True to wear or wield it; false takes it off.'),
      cost_gp: z.number().int().min(0).optional().describe('(op=add) What they pay, deducted here.'),
      weight_lb: z.number().min(0).optional().describe('(op=add) Weight of one, for an item the SRD does not list.'),
      magic: MAGIC.optional().describe('(op=add) What makes it magical; an item the SRD does not know must name its rarity.'),
      unidentified: z
        .boolean()
        .optional()
        .describe("(op=add) Nobody knows what it is yet: the player's sheet shows only its kind until a short rest or Identify."),
      into: z.string().optional().describe('(op=add) A container carried, by name or id, to stow it in.'),
      container: z
        .object({
          capacity_lb: z.number().min(0).optional().describe('Pounds it holds; leave out for no limit.'),
          weightless_contents: z.boolean().optional().describe('What is inside weighs nothing.'),
        })
        .optional()
        .describe('(op=add) Makes the item a container.'),
      charges: z.number().int().min(1).optional().describe('(op=use) Charges this use costs; 1 by default, 0 with restore.'),
      restore: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('(op=use) Charges handed back as a DM ruling, when the SRD text gives no recharge.'),
      price_gp: z.number().min(0).optional().describe('(op=sell) Price for one, instead of half the SRD price.'),
      force: z
        .boolean()
        .optional()
        .describe('(op=remove, op=sell) Remove a container with its contents, or sell something equipped or attuned.'),
    },
    shared: ['character_id'],
    ops: {
      gold: {
        summary: 'Add or spend coins',
        requires: ['reason'],
        uses: ['delta', 'coins', 'allow_debt'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, adjustGold(db, { ...input, reason: input.reason! }));
        },
      },
      add: {
        summary: 'Put an item on the sheet',
        requires: ['name'],
        uses: ['qty', 'notes', 'equipped', 'cost_gp', 'weight_lb', 'allow_debt', 'magic', 'unidentified', 'into', 'container'],
        run: (args) => {
          const { op, ...input } = args;
          const clauses = input.magic?.mechanics?.clauses;
          const magic =
            clauses === undefined
              ? (input.magic as z.infer<typeof ITEM_MAGIC> | undefined)
              : {
                  ...input.magic,
                  mechanics: {
                    ...input.magic!.mechanics,
                    clauses: parseHomebrew(clausesSchema, clauses, 'magic.mechanics.clauses'),
                  },
                };
          return reply(db, input.campaign_id, addItem(db, { ...input, name: input.name!, magic }));
        },
      },
      remove: {
        summary: 'Take an item off the sheet',
        requires: ['name'],
        uses: ['qty', 'force'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, removeItem(db, { ...input, name: input.name! }));
        },
      },
      equip: {
        summary: 'Wear, wield or put away armour and shields',
        requires: ['name', 'equipped'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, equipItem(db, { ...input, name: input.name!, equipped: input.equipped! }));
        },
      },
      list: {
        summary: 'List the inventory, purse and equipment',
        requires: [],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, listInventory(db, input));
        },
      },
      use: {
        summary: 'Spend the charges of a magic item',
        requires: ['item'],
        uses: ['charges', 'restore'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, useItem(db, { ...input, item: input.item! }));
        },
      },
      sell: {
        summary: 'Sell an item and put the coins in the purse',
        requires: ['item'],
        uses: ['qty', 'price_gp', 'force'],
        run: (args) => {
          const { op, ...input } = args;
          return reply(db, input.campaign_id, sellItem(db, { ...input, item: input.item! }));
        },
      },
    },
    annotations: { ...WRITES },
  });
}
