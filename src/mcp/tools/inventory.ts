import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { addItem, adjustGold, equipItem, listInventory, removeItem, sellItem, useItem } from '../../core/character.js';
import { registerOpTool } from './op.js';
import { reply } from './result.js';
import { CHARACTER_ID, COIN_PURSE, ITEM_MAGIC, ITEM_REF, WRITES } from './character-shared.js';

export function registerInventoryTools(server: McpServer, db: Db): void {
  registerOpTool(server, 'inventory', {
    title: 'Gold, items and equipment',
    description:
      'Gold and items change only here; never narrate a price paid or an item found without calling it. gold: delta (gold pieces, negative to spend) or coins {cp,sp,ep,gp,pp}, never both. Change is made automatically across denominations, so it refuses only when the whole purse is worth less than the price; pass allow_debt only when the story means them to owe it. Buying an actual item is add with cost_gp, so the item lands on the sheet too. add: an SRD name copies its stats and weight into the note; an SRD magic name or a +N brings its own rarity, attunement, charges and bonus; an item you invented needs magic.rarity, and a bonus needs base unless the name is already SRD gear. unidentified shows the player only its kind until a short rest studying it or Identify. into stows it in a container, a name already carried merges into that stack, cost_gp will not overdraw without allow_debt, and over STR x 15 lb warns and drops speed to 5 ft. remove: a sale is sell, which pays for it. qty takes part of a stack, otherwise the whole line goes. It reaches inside containers, and when no such name is carried it lists what is: read that back rather than inventing their pack. A container still holding something needs force. equip: recomputes AC (armour plus capped DEX, +2 a shield, 10 + DEX unarmoured, Unarmored Defense, a magic +N once attuned) with ac_breakdown: read that AC back, never compute one. One suit of body armour at a time, so a new one takes the old off; equipping something stowed takes it out of its container, taking it off leaves it there; it warns when they are not proficient. list: every item with qty, id, note, weight, magic and nested contents, the purse and its total, three attunement slots, weight against capacity, and an unidentified item under the name the player sees with true_name beside it for you. Call it before a shopping scene, when they ask what they carry, or to check what they can afford or lift; it changes nothing. use: spends charges off a wand, staff or ring and says what is left and when it comes back (dawn, dusk, long rest, never); at zero it refuses. Dawn and dusk items refill themselves as the clock passes the hour. A recharge the SRD text never gave is unknown and yours to rule on: restore hands charges back as a logged ruling, add with magic.charges.recharge settles it for good. It casts nothing - narrate the spell, or spells {op: spend_slot} and use_action when the player casts it. sell: shops, fences and pawn-brokers; a gift or a theft is remove. Coins land in the purse at once; without price_gp the price is half the SRD list price, and a magic item needs a price_gp from you. Something still equipped or attuned is refused: take it off, end the attunement, or pass force.',
    fields: {
      campaign_id: z.number().int(),
      character_id: CHARACTER_ID,
      delta: z.number().int().optional().describe('(op=gold) Gold pieces: negative to spend, positive to gain. Pass this or coins.'),
      coins: COIN_PURSE.optional().describe('(op=gold) Exact coins instead of delta, e.g. {sp: -5} for five silver.'),
      reason: z.string().optional().describe('(op=gold) What it was for, e.g. "a night at the Gilded Eel".'),
      allow_debt: z.boolean().optional().describe('(op=gold, op=add) True to let the purse go below zero.'),
      name: z
        .string()
        .optional()
        .describe('(op=add) The SRD name where there is one, e.g. "Potion of Healing"; (op=remove, op=equip) an item already carried, by name or id; items inside a container count.'),
      item: z.string().optional().describe(`(op=use, op=sell) ${ITEM_REF}`),
      qty: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('(op=add, op=remove, op=sell) How many: 1 by default for add and sell, the whole stack by default for remove.'),
      notes: z.string().optional().describe('(op=add) Your own description; replaces the SRD one.'),
      equipped: z.boolean().optional().describe('(op=add, op=equip) True to wear or wield it; for equip, false takes it off.'),
      cost_gp: z.number().int().min(0).optional().describe('(op=add) What the character pays for it, deducted here.'),
      weight_lb: z.number().min(0).optional().describe('(op=add) Weight of one, for an item the SRD does not list.'),
      magic: ITEM_MAGIC.optional().describe('(op=add) What makes the item magical. An item the SRD does not know must at least name its rarity.'),
      unidentified: z
        .boolean()
        .optional()
        .describe('(op=add) True when nobody knows what it is yet: the player\'s own sheet shows only its kind until a short rest or Identify.'),
      into: z.string().optional().describe('(op=add) A container already carried, by name or id, to put it in, e.g. "Backpack".'),
      container: z
        .object({
          capacity_lb: z.number().min(0).optional().describe('What it holds, in pounds; leave it out for no limit.'),
          weightless_contents: z.boolean().optional().describe('True when what is inside weighs its carrier nothing.'),
        })
        .optional()
        .describe('(op=add) Declares the item a container, for a chest, a saddlebag or anything the SRD does not list as one.'),
      charges: z.number().int().min(1).optional().describe('(op=use) How many charges this use costs; 1 by default, and 0 when restore is passed.'),
      restore: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('(op=use) Charges you are handing back as a DM ruling, for an item whose recharge the SRD text does not carry.'),
      price_gp: z.number().min(0).optional().describe('(op=sell) What the buyer pays for one, in gold, instead of half the SRD price.'),
      force: z
        .boolean()
        .optional()
        .describe('(op=remove, op=sell) True to remove a container and lose what is inside, or to sell something still equipped or attuned, or a container with its contents inside.'),
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
          return reply(db, input.campaign_id, addItem(db, { ...input, name: input.name! }));
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
