import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '../../db/connection.js';
import { addItem, adjustGold, equipItem, listInventory, removeItem, sellItem, useItem } from '../../core/character.js';
import { reply } from './result.js';
import { CHARACTER_ID, COIN_PURSE, ITEM_MAGIC, ITEM_REF, READS, WRITES } from './character-shared.js';

export function registerInventoryTools(server: McpServer, db: Db): void {
  server.registerTool(
    'adjust_gold',
    {
      title: 'Add or spend gold',
      description:
        'Moves money on the sheet: a negative delta for what the character pays in gold, a positive one for what they earn or loot, or coins for exact denominations ({cp, sp, ep, gp, pp}, negative to spend). The purse is kept by denomination and change is made automatically - paying 1 gp out of a purse of silver breaks the silver, paying out of platinum breaks the platinum - so it only refuses when the whole purse is worth less than the price. Use it for a sale, a reward, a bribe or a tavern bill - a purchase of an actual item goes through add_item with cost_gp instead, so the item lands on the sheet too. Pass either delta or coins, never both - a call with both is refused. It refuses to take the purse below zero and says how much is there; pass allow_debt true only when the story means them to owe it. Never narrate a price the player paid without calling this.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        delta: z.number().int().optional().describe('Gold pieces: negative to spend, positive to gain. Pass this or coins.'),
        coins: COIN_PURSE.optional().describe('Exact coins instead of delta, e.g. {sp: -5} for five silver.'),
        reason: z.string().describe('What it was for, e.g. "a night at the Gilded Eel".'),
        allow_debt: z.boolean().optional().describe('True to let the purse go below zero.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, adjustGold(db, input)),
  );

  server.registerTool(
    'add_item',
    {
      title: 'Add an item to the inventory',
      description:
        'Puts an item on the character sheet - loot, a gift, a crafted thing, or a shop purchase when you pass cost_gp, which is deducted in the same step and refuses to overdraw the purse unless allow_debt is true. Use the SRD name where one exists ("Chain Mail", "Longsword", "Potion of Healing") and the tool copies the category, damage or armour value, properties and weight into the item note, so the player can see what it is. Magic items are recognised too: an SRD name ("Bag of Holding", "Wand of Magic Missiles", "Potion of Greater Healing") or a +N on any weapon, armour or shield ("+1 Longsword", "+2 Chain Mail") brings its own rarity, attunement requirement, charges and bonus. For an item you invented, pass magic with at least a rarity (common, uncommon, rare, very_rare, legendary, artifact) - without one the call is refused; a bonus also needs base to name the SRD weapon, armour or shield it is a version of ("Longsword"), though an item already named for SRD equipment ("Shield") needs no base. Pass unidentified true for something the party has not worked out yet: the player\'s window sees only its kind ("Unidentified longsword") until a short rest studying it or the Identify spell. into puts it inside a container they already carry. A name already carried merges into that stack rather than making a second line; pass equipped true to wear or wield it at once, which recomputes AC for armour and shields. Carrying capacity is STR x 15 lb, and going over it comes back as a warning and drops the effective speed to 5 ft until something is dropped.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        name: z.string().describe('The SRD name where there is one, e.g. "Potion of Healing".'),
        qty: z.number().int().min(1).optional().describe('How many; 1 by default.'),
        notes: z.string().optional().describe('Your own description; replaces the SRD one.'),
        equipped: z.boolean().optional().describe('True to wear or wield it straight away.'),
        cost_gp: z.number().int().min(0).optional().describe('What the character pays for it, deducted here.'),
        weight_lb: z.number().min(0).optional().describe('Weight of one, for an item the SRD does not list.'),
        allow_debt: z.boolean().optional().describe('True to let the purchase take the purse below zero.'),
        magic: ITEM_MAGIC.optional(),
        unidentified: z
          .boolean()
          .optional()
          .describe('True when nobody knows what it is yet: the player\'s own sheet shows only its kind until a short rest or Identify.'),
        into: z.string().optional().describe('A container already carried, by name or id, to put it in, e.g. "Backpack".'),
        container: z
          .object({
            capacity_lb: z.number().min(0).optional().describe('What it holds, in pounds; leave it out for no limit.'),
            weightless_contents: z.boolean().optional().describe('True when what is inside weighs its carrier nothing.'),
          })
          .optional()
          .describe('Declares the item a container, for a chest, a saddlebag or anything the SRD does not list as one.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, addItem(db, input)),
  );

  server.registerTool(
    'remove_item',
    {
      title: 'Remove an item from the inventory',
      description:
        'Takes an item off the sheet: consumed, given away, stolen or destroyed. Pass qty to take part of a stack; leave it out to remove the whole line. Selling has its own tool, sell_item, which pays for it too. It finds items inside containers as well as loose in the pack, and errors when the character is not carrying that name and lists what they do have, so read that back rather than inventing the contents of their pack. Removing a container that still holds something is refused and names the contents: empty it first, or pass force true to lose them with it.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        name: z.string().describe(ITEM_REF),
        qty: z.number().int().min(1).optional().describe('How many to remove; the whole stack by default.'),
        force: z.boolean().optional().describe('True to remove a container and lose what is inside it with it.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, removeItem(db, input)),
  );

  server.registerTool(
    'equip_item',
    {
      title: 'Equip or unequip an item',
      description:
        'Wears, wields or puts away something the character already carries, and recomputes AC when it is armour or a shield: armour base plus its capped DEX, +2 for a shield, 10 + DEX with nothing on, the Barbarian or Monk Unarmored Defense where it applies, and the +N of magical armour once it is attuned (the reply says so when it is not). The reply carries ac_breakdown, which names every part of the number. Use it whenever the player changes armour, straps on a shield or takes it off; only one suit of body armour is worn at a time, so equipping a new one takes the old one off. Equipping something stowed in a container takes it out of the container first, which the event says; taking it off leaves it where it is. Read the AC it returns back to the player instead of computing one yourself. It does not add or remove anything - add_item and remove_item do that.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        name: z.string().describe('An item already in the inventory, e.g. "Shield", by name or id.'),
        equipped: z.boolean().describe('True to put it on, false to take it off.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, equipItem(db, input)),
  );

  server.registerTool(
    'list_inventory',
    {
      title: 'List the inventory and gold',
      description:
        'Returns what the character carries - every item with its quantity, id, note, weight, magic block and, for a container, what is nested inside it - plus their purse by denomination (cp, sp, ep, gp, pp) and its total in gold, their three attunement slots, the weight they carry, their carrying capacity (STR x 15 lb) and whether they are over it. An unidentified item is listed under the name the player sees, with true_name beside it for you. Use it before a shopping scene, when the player asks what they have, and when you need to know whether they can afford or carry something. Pass character_id for a companion. It changes nothing.',
      inputSchema: { campaign_id: z.number().int(), character_id: CHARACTER_ID },
      annotations: { ...READS },
    },
    (input) => reply(db, input.campaign_id, listInventory(db, input)),
  );

  server.registerTool(
    'use_item',
    {
      title: 'Spend the charges of a magic item',
      description:
        'Spends charges off a wand, staff or ring and says how many are left and when they come back (at dawn, at dusk, on a long rest, or never). It refuses at zero and names the recharge, so the item simply cannot be used again until then. Where the bundled SRD text carries charges but no recharge rule the recharge is "unknown": that one is yours to rule on, and restore hands charges back on your say-so (logged as a DM ruling), while add_item magic.charges.recharge sets the schedule for good. It does not cast anything: the spell is yours to narrate, and if the player casts it themselves it still goes through use_spell_slot or use_action. The reply carries the item\'s own rules text so you know what it does. Dawn and dusk items fill up again on their own the moment the campaign clock passes that hour.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        item: z.string().describe(ITEM_REF),
        charges: z.number().int().min(1).optional().describe('How many charges this use costs; 1 by default, and 0 when restore is passed.'),
        restore: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Charges you are handing back as a DM ruling, for an item whose recharge the SRD text does not carry.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, useItem(db, input)),
  );

  server.registerTool(
    'sell_item',
    {
      title: 'Sell an item',
      description:
        'Sells something off the sheet and puts the coins in the purse in one step. Without price_gp the price is half the SRD list price, the 2024 rule of thumb, and the reply names the rule it used; a magic item needs a price_gp from you, because the SRD prices the mundane item behind it and not the magic one. It refuses an item that is still equipped or still attuned - take it off or end the attunement first, or pass force true when the story means them to hand it over anyway. Use it for shops, fences and pawn-brokers; a gift or a theft is remove_item instead.',
      inputSchema: {
        campaign_id: z.number().int(),
        character_id: CHARACTER_ID,
        item: z.string().describe(ITEM_REF),
        qty: z.number().int().min(1).optional().describe('How many to sell; 1 by default.'),
        price_gp: z.number().min(0).optional().describe('What the buyer pays for one, in gold, instead of half the SRD price.'),
        force: z.boolean().optional().describe('True to sell something still equipped or still attuned, or a container with its contents inside.'),
      },
      annotations: { ...WRITES },
    },
    (input) => reply(db, input.campaign_id, sellItem(db, input)),
  );
}
