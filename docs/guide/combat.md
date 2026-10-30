# Running a fight

The engine owns the grid, the initiative order, the rolls, the damage and everything ongoing. You
own the narration and the enemies' decisions. Read the lines the tools return and say them in your
own words; never imagine a position, a hit or a hit point total.

Start with `turn-loop`. Class features are in `read_guide {section: "class-features"}`; the
player's own rolls in a fight, conditions and ongoing effects, ending a fight and explaining it to a
novice are in `read_guide {section: "combat-effects"}`.

## When to start an encounter

Start one for anything with real stakes. A scuffle with a drunk, a single wolf driven off by a torch
or a chase can stay theatre of mind - resolve it with `roll` and narrate.

`start_encounter {campaign_id, terrain, size, seed, features, enemies, extra_party}`:

- `terrain` is `forest`, `cave`, `road`, `ruins` or `interior`; `features` place things like
  `["river", "pillars", "rubble"]`.
- Name enemies **exactly** as the SRD does ("Goblin Warrior", "Wolf") so the stat block loads. Look
  them up first with `srd_lookup {kind: "creature"}` - its actions carry the attack bonus, reach or
  range and damage dice. `unique: true` for somebody who matters; `name` renames one. Renaming alone
  changes nothing: a monster is its stat block. To change what it does, pass `actions` on the enemy
  (or on `add_combatant`) - an action replacing the stat block's action of the same name or adding a
  new one, e.g. an Ogre with `actions: [{name: "Poisoned Blade", kind: "melee_weapon_attack",
  attack_bonus: 6, reach_ft: 5, damage: [{dice: "2d8+4", type: "bludgeoning"}, {dice: "2d6", type:
  "poison"}], text: "..."}]`. An action's `text` is flavour the player may be shown, not a note to
  yourself; keep secrets out of it.
- It draws the map, brings the player character and active companions in, rolls initiative for
  everyone and returns the whole state with an ASCII grid.
- Surprise: `surprised_ids` names the party members the ambush caught, `surprised: true` on an enemy
  the party jumped. Surprised means initiative with disadvantage, nothing else.
- Only one encounter runs at a time per campaign. Reinforcements arrive with `add_combatant`.

## Turn loop

For every turn, in this order:

1. Read the turn brief that ends every combat reply (`attack`, `move_token`, `use_action`,
   `advance_turn`): the active creature with its `#id`, the foes in reach with id, distance, cover, AC
   and a wound word, and the monster's attacks. Call `get_battle_state` only for the full grid, effect
   ids (the `#n` lines `effect {op: end}` takes), the legal actions and the recent log.
2. Let the player declare what they do (or decide the monster's move yourself).
3. Position: `find_position` turns intent into cells, then `move_token`; warn the player of any
   opportunity attack its reply lists before they move (topic `moving`).
4. Act: `attack {attacker_id, target_id, action_name}` for a weapon or natural attack,
   `use_action {actor_id, action_name, ...}` for everything else. One Action, one Bonus Action and
   one Reaction a turn, and the engine refuses the second one - Extra Attack and Multiattack
   included; the Actions line shows `×N` while more than one attack is left.
5. `advance_turn` - exactly once, at the end of every turn. It ticks ongoing effects and tells you
   what they did.

## Moving

`find_position {combatant_id, cover_from | line_of_sight_to | within_reach_of |
within_range_ft_of | adjacent_to_feature}` turns "I duck behind the pillar" into real cells with
their cost and cover. Then `move_token` with the cell, or pass the same intent fields straight to
`move_token`. Its reply lists anyone who could take an opportunity attack for leaving reach -
narrate that warning and let the player decide before they move. A search note under Offers means
the path search gave up on a big map, not that there is no way: move to a nearer waypoint and go on.
"No cell gives cover from X and Y" means those constraints together have no answer on this map:
drop one and ask again before telling the player the terrain is broken.

## What the player is told

Enemy hit points are yours, not the player's. The tool replies carry the exact numbers so you can run
the monsters; narrate them as wounds - untouched, scratched, bloodied at half or less, staggering at a
quarter or less, dead - never as a number or a fraction ("6/11", "5 HP left"). Their window already
shows what they chose to see, so a word is all they need. The same goes for enemy AC and saves: say "a
hit" or "a miss", not the target number.

## The standard actions

Pass the id as `action_name` to `use_action`; the legal action list carries the same ids.

- `dash` adds the speed to the movement left, `disengage` stops opportunity attacks for the turn,
  `dodge` gives attacks against you disadvantage and your DEX saves advantage until your next turn.
- `help {target_id, ally_target_id}`: the ally gets advantage on their next attack against that enemy
  (it must be within 5 ft of you), or on their next check when you leave `ally_target_id` out.
- `hide`: a DC 15 Stealth check, and only from cover or out of sight. Success leaves the hider
  Invisible until they attack, cast or make a noise.
- `ready {trigger, readied_action}` holds an action; release it with `out_of_turn: true`, which spends
  the reaction. `utilize` spends the action on an object. `stand` ends Prone for half the speed.
- `grapple {target_id}` and `shove {target_id}` are the Unarmed Strike options: the target saves with
  STR or DEX (the engine rolls its better one) against 8 + your STR modifier + your proficiency bonus.
  Grappled is speed 0, escaped with `escape_grapple` (Athletics or Acrobatics against the same DC);
  a grappler drags what it holds at half speed. Shove pushes 5 ft, or knocks the target down with
  `shove_prone: true`.
- `attack {knock_out: true}` pulls a melee blow: the target drops unconscious instead of dead.
- A versatile weapon is swung two-handed whenever no shield is equipped; `attack {grip: "one_hand"}`
  takes the smaller die instead.

## Weapon mastery

Barbarians, Fighters, Paladins, Rangers and Rogues name the weapons whose 2024 mastery property they
may use (`mastery_weapons` on the sheet, picked at creation and at the levels the count grows, swapped
with `rest{kind: "long", mastery_weapons: [...]}`). The engine applies the property itself whenever
such a character attacks with one of those weapons - a monster never has mastery - and the reply
carries it under `mastery`, with a line in the fight log. Narrate it; never apply it yourself.

- **Graze** (Greatsword, Glaive): a miss still deals the attacker's ability modifier in the weapon's
  damage type, with no roll.
- **Push** (Warhammer, Greatclub, Pike, Heavy Crossbow): a hit drives a Large or smaller target 10 ft
  straight back. Pass `attack{no_push: true}` to leave it where it stands.
- **Sap** (Longsword, Mace, Spear, Flail): the target has Disadvantage on its next attack roll, until
  the attacker's next turn starts.
- **Slow** (Club, Javelin, Longbow, Sling): a hit that deals damage takes 10 ft off the target's speed
  until the attacker's next turn - which comes round whether the attacker still lives or not.
- **Topple** (Quarterstaff, Battleaxe, Maul, Lance): the target makes a CON save against 8 + the
  attacker's ability modifier + its proficiency bonus or is knocked Prone.
- **Vex** (Rapier, Shortsword, Handaxe, Shortbow): a hit that deals damage gives the attacker Advantage
  on its next attack roll against that creature - a weapon swing or a spell - until the end of its next turn.

## Cleave and Nick

The last two mastery properties; `weapon-mastery` has who gets them and the other six.

- **Cleave** (Greataxe, Halberd): a melee hit's log names who it may carry into, by id. Call
  `attack{target_id: <one of them>, cleave_from: <the first target>}` to carry the swing into a
  creature within 5 ft of the first and in reach: it costs no attack of the Attack action, deals the
  weapon's damage without the ability modifier, and happens once a turn. It only follows a hit that
  landed on `cleave_from` with that weapon earlier in the same turn, and offers no cleave of its own.

**Nick** is the one the engine does not run: it rides on two-weapon fighting, which is not built yet.
A Dagger, Scimitar, Sickle or Light Hammer under mastery simply does nothing extra - narrate the
off-hand swing and resolve it as a bonus-action attack yourself.

## Casting a spell

`use_action {actor_id, action_name: "Fireball", spell: "Fireball", slot_level?, target_id | point}`.
With `spell` the engine reads the SRD entry: damage dice and type, the save and your DC, the area, the
range, concentration, the duration, spell attack rolls, cantrip scaling at levels 5, 11 and 17, and
upcasting from `slot_level`. It spends the slot and refuses when none is left, naming what remains;
cantrips spend nothing. Anything you pass yourself overrides the entry. A second concentration spell
ends the first. Homebrew spells still resolve by name without `spell`.

**The casting time is the action it costs**, read off the entry: an action spell spends the Action, a
bonus-action spell the Bonus Action - Divine Smite and Hunter's Mark are both bonus actions, so the
Attack action that set them up is no obstacle - and a reaction spell needs `out_of_turn: true` with the
trigger as `reason`, and spends the reaction. A spell that takes a minute or longer is refused inside an
encounter: package R8 will handle long casting times, so cast those between fights.

The caster's own features that shape a casting (Innate Sorcery, Sculpt Spells, Potent Cantrip
and the rest) are in `read_guide {section: "class-features", topic: "casting-features"}`.

## What the conditions do

The engine applies them; you narrate them. `condition {op: set}` turns them on and off.

- Blinded: its attacks have disadvantage, attacks against it advantage. Invisible is the mirror.
- Prone: its attacks have disadvantage; attacks from within 5 ft have advantage, further ones
  disadvantage. Standing costs half the speed.
- Grappled: speed 0, and disadvantage on attacks against anyone but the grappler. Restrained: speed 0,
  its attacks spoiled, advantage against it and disadvantage on its DEX saves.
- Paralyzed, Petrified, Unconscious: no action, bonus action or reaction, speed 0, STR and
  DEX saves fail outright, attacks against them have advantage. A hit within 5 ft on the Paralyzed or
  the Unconscious is a critical hit. Stunned is the same, minus the speed 0 the 2024 rules removed.
- Poisoned: disadvantage on attacks and checks. Frightened: the same, while the source is in sight.
- Exhaustion takes 2 off every d20 and 5 ft of speed per level, and kills at level 6.
- Armour or a shield worn without proficiency: disadvantage on every STR or DEX d20 test and no
  spellcasting at all (`armor_penalty` on the combatant).

## Improvised actions

Anything the player invents is resolved with the rules that already exist.

1. Let them describe it, then pick the test: an ability check against DC 10 (easy), 15 (moderate) or
   20 (hard), or a contest against the creature's own skill. A clever setup earns advantage.
2. Roll it with `roll` - the player rolls their own - and never invent a number outside a tool.
3. Apply the outcome with the existing mechanics: `use_action` with `shove`, `grapple` or `stand`,
   `condition {op: set}` for Prone, `effect {op: apply}` for falling or collision damage, `move_token` for
   the ground gained. A failure costs something real: Prone, the movement, or an opportunity attack.

Worked example: "I slide under the charging ogre and kick its legs out." DC 15 Dexterity (Acrobatics)
for the slide. On a success, `move_token {ruling: {reason: "won a DC 15 Acrobatics check to slide
under the ogre"}}` lets the move cross the ogre's cell (never stop on it) and logs the ruling; then
resolve the kick as `use_action {action_name: "shove", target_id, shove_prone: true}`, and if the
ogre's own momentum carries it, `ruling: {reason: "...", push_ft: 15, advantage: true}` pushes it
further and makes it save with disadvantage. On a failure the slide ends in the open: Prone, the
movement spent, and the ogre gets its attack.

## Reactions and undo

`out_of_turn: true` with a `reason` is for reactions only, and spends the one reaction a round.
`undo_last_combat_action` takes back a mistake - a wrong target, a wrong tool call - not a result the
player dislikes. The class reactions (Uncanny Dodge, Deflect Attacks, Retaliation, Cutting Words) are
in `read_guide {section: "class-features", topic: "reactions"}`.
