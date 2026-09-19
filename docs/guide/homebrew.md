# How to write a mechanic

Read this before you invent a feature, a boon or a subclass bundle. Everything you invent is prose
plus **clauses**: data the engine runs at its own hooks. Prose alone is remembered by nobody.

**Run `check_mechanics` first, every time.** It prices the clauses, says for each whether the engine
runs it, has it planned or only reminds you, and writes nothing. Then pass the same clauses to
`propose {op: feature}`, `propose {op: subclass}` or `revise_mechanics`.

A clause is five things: `when` it fires, `if` anything narrows it, what it does (`do`), how often
(`uses`) and who decides (`decide`).

```jsonc
{ "when": "spell_damage", "if": { "damage_type": ["force"] },
  "do": [{ "kind": "extra_damage", "dice": "1d6", "type": "force" }],
  "uses": "once_per_turn", "decide": "auto" }
```

## `when` — the trigger, one per clause

| when | fires |
| --- | --- |
| `always` | a passive on the sheet: scores, proficiencies, AC, speed, resistances, spells known |
| `roll` | a d20 or damage roll is coming; say which with `if.kind` |
| `hit` / `miss` | your attack resolved |
| `spell_damage` | a spell of yours dealt damage |
| `damage_dealt` | any damage of yours landed |
| `damage_taken` | something hurt you |
| `save_succeeded` | a target saved against something of yours |
| `kill` | you dropped a creature to 0 hit points |
| `cast` | you are casting a spell |
| `turn_start` / `turn_end` | your turn's edges |
| `initiative` | you rolled Initiative |
| `rest_short` / `rest_long` | you finished a rest |
| `dawn` | the sun came up (items only; on a feature it reminds) |
| `action` | something you take on your turn; the `do` carries its economy |

## `if` — what narrows it (all optional, all AND-ed)

| if | means |
| --- | --- |
| `self` | `bloodied`, `concentrating`, `raging`, `wearing: armor/no_armor/shield`, `condition` |
| `source` | `spell`, `weapon`, `unarmed`, `any` |
| `damage_type` | `["force"]`, `["fire", "cold"]` |
| `weapon` | `melee`, `ranged`, `property: ["heavy"]`, `mastery: "Topple"` |
| `spell` | `school`, `level_min`, `level_max`, `name` |
| `skill` / `ability` / `save` | the checks or saves it applies to |
| `kind` | for `when: "roll"`: `attack`, `check`, `save`, `initiative`, `damage`, `heal`, `death_save` |
| `target` | `type: ["goblinoid"]`, `name_contains`, `size`, `condition`, `bloodied`, `within_ft`, `is_only_target` |
| `range` | `"melee"`, `"ranged"`, or `{ "within_ft": 30 }` |
| `roll` | `natural_min`, `failed`, `succeeded`, `margin_at_least` |
| `light` | `bright`, `dim`, `dark` — **reminds**, light is not modelled yet |
| `terrain_tag` | a kind of ground — **reminds**, terrain is not modelled yet |

The narrower a clause is, the less it costs: one damage type or one source is ×0.75, one target type
or one skill ×0.5, stacked conditions multiply. `if.kind` names the roll it rides on rather than
narrowing it, so it changes nothing.

A `target` type is matched against the stat block's own type and against the SRD's creature tags, so
`["goblinoid"]` finds a Goblin Warrior (a Fey) and not a Wolf, and `["giant"]` does not find a Giant
Ape (a Beast).

## `do` — what it does (one or more; every entry carries a `kind`)

| kind | what it does |
| --- | --- |
| `bonus` | `{to: attack/damage/ac/check/save/initiative/speed/hp_max/heal/spell_save_dc/spell_attack, amount}`; amount is a number, `"1d6"`, `"prof"`, `"half_prof"`, `"ability:cha"` or a scaling token (`"level"`, `"1d10+level"`). Every target runs but `hp_max`, which **reminds** |
| `advantage` / `disadvantage` | on the roll the clause rides on |
| `reroll` | `{keep: "higher"}` rolls twice and keeps the better; `{keep: "new"}` rerolls once |
| `min_die` | treat a die below N as N — **reminds** at the damage roll |
| `crit_range` | a Critical Hit on 19 or higher; with an `if` or `uses` it **reminds** instead |
| `max_damage_dice` | the dice count as their highest roll — **reminds** at the damage roll |
| `extra_damage` / `extra_heal` | `{dice, type?}`; `type: "same"` follows the attack, and the dice may scale |
| `temp_hp` | `{dice}` or `{amount}` |
| `push_ft` / `move_ft` | shove the target, or move yourself (`no_opportunity_attacks`) |
| `condition` | `{name, until: end_of_target_next_turn / end_of_your_next_turn / start_of_your_next_turn / rounds, rounds?}`; `save_ends` **reminds** — no clause names the save |
| `remove_condition` | ends one |
| `grant_inspiration` | Heroic Inspiration |
| `mark_target` | the generic `marked` flag other clauses can test |
| `proficiency` / `expertise` | `{skill}`, `{save}`, `{weapon}`, `{armor}`, `{tool}`, `{language}`; Expertise on a skill you were not proficient in grants the proficiency too |
| `asi` | `{ability, amount}`; the total is still capped at 20 |
| `resistance` / `immunity` / `vulnerability` | `{types: [...]}` |
| `speed_ft` | feet of walking speed |
| `sense` | `darkvision_ft` and its kin — **reminds**, senses are not modelled yet |
| `spell_known` / `cantrip_known` / `always_prepared` | `{name}` |
| `hp_per_level` | hit points per level — **reminds**: a maximum is stored, not read back |
| `effect` | **planned** (H3) — a whole spell-shaped effect: `{effect: {kind: attack/save/auto/heal/utility, damage, save_ability, half_on_save, shape, healing, condition, targets}, economy: action/bonus/reaction/free, reaction_trigger?, duration_rounds?, concentration?}` |
| `free_standard_action` | `dash`, `disengage`, `dodge`, `hide` for free |
| `extra_attack` | one more attack on the Attack action |
| `extra_action` | one more action on your turn, the way Action Surge gives one |
| `recover_slot` / `recover_resource` | a slot back, or `{key, amount}` of something else |
| `note` | one line the DM is reminded of at the hook — the manual fallback |

## `uses` — how often

`"unlimited"` (the default) · `"once_per_turn"` · `"once_per_round"` · `{ "per": "short"/"long",
"count": 2 }` or `"count": "prof"` · `{ "charges": { "max": 3, "recharge": "dawn" } }` ·
`"once_ever"`, which no rest gives back. Once a turn and per short rest halve the price, per long
rest quarters it.

A scaling token — `level`, `half_level`, `prof` — is read off the sheet when the clause fires and
**priced at level 4**, where the whole table is anchored.

## `decide` — who chooses

| decide | meaning |
| --- | --- |
| `auto` | the engine applies it and logs it. The default, and right for anything phrased "you gain / you deal / you have" |
| `ask_before` | the player chooses before the roll or the swing, and the card and the reply offer it |
| `ask_after` | the player chooses once they have seen the roll — a reroll or a raised die |
| `dm` | you get a reminder line at the hook and rule on it yourself |

At a `hit`, `miss`, `spell_damage`, `damage_dealt` or `kill` clause the choice is made **before the
swing** and costs nothing on a miss: nothing asks the player after a blow has landed, so the rider is
offered with the attack and the use is spent only when it actually lands.

## The five rules

1. **"You can" means they choose.** A gain is `auto` and pays for itself; prose saying the player
   *can* do something is `ask_before`, or `ask_after` when it rerolls a die after the roll.
2. **A companion's boost is yours to spend.** The reply lists what is on the table in
   `boosts_available`; pass the id back in `boosts` on `roll`, `attack` or `use_action`. The
   player's own rolls are theirs: their card offers the same boosts.
3. **Conditions are SRD only**, plus the generic `marked` flag; anything else is refused with the
   list of allowed names.
4. **Four clauses per feature, two per subclass-bundle level.** Over the cap, split it into two
   boons, and the one-boon-per-chapter cadence applies to the second.
5. **Re-pricing is not retroactive.** A revision prices that entry again and nothing else moves.

## Runs, planned or reminds

Every clause comes back in one of three states.

- `runs` — the engine applies it at the hook and writes it into the fight log.
- `planned` — the hook is there, the seam is not: an `effect` payload (H3), an `if.roll` condition,
  and the `damage_taken`, `save_succeeded`, `rest_short` and `rest_long` triggers.
- `reminds` — nothing will run it, and the reason says why: damage-die surgery (`min_die`,
  `max_damage_dice`, a `reroll` on `kind: damage`), a `crit_range` with an `if` or a counter, a
  `save_ends` duration, `bonus {to: hp_max}` and `hp_per_level`, `light`, `terrain_tag`, `sense`, or
  a `note`, which is a reminder by design.

The table is per verb and per hook. At `initiative`, the turn edges and `kill` that is all but temp
HP, healing, a condition, movement, Inspiration, a resource and one more action. Where a verb runs
at one hook and not another the engine **reminds at the hook it cannot run**: the reply carries a
`reminders` line naming the feature, what the clause says and why it is yours, and the fight log
gets a `reminder` line beside it, which never reaches the player's feed. Nothing is silently dropped, and a reminder still costs budget.

## Nine examples

```jsonc
// 1. Forceful Focus - a rider on one damage type, once a turn. 0.25
{ "when": "spell_damage", "if": { "damage_type": ["force"] },
  "do": [{ "kind": "extra_damage", "dice": "1d6", "type": "force" }], "uses": "once_per_turn" }

// 2. Goblin-Bane - a flat bonus against one kind of creature. 0.25
{ "when": "damage_dealt", "if": { "target": { "type": ["goblinoid"] } },
  "do": [{ "kind": "bonus", "to": "damage", "amount": 1 }] }

// 3. Mystic Investigator - a proficiency and a boost the player spends. 0.5 in all
[{ "when": "always", "do": [{ "kind": "proficiency", "skill": "investigation" }] },
 { "when": "roll", "if": { "kind": "check", "skill": ["arcana", "investigation"] },
   "do": [{ "kind": "advantage" }], "uses": { "per": "long", "count": 1 }, "decide": "ask_before" }]

// 4. Savage Attacker - reminds: nothing reaches between the damage dice and the total. ~1
{ "when": "roll", "if": { "kind": "damage", "source": "weapon" },
  "do": [{ "kind": "reroll", "keep": "higher" }], "uses": "once_per_turn", "decide": "ask_after" }

// 5. Magic Initiate - two cantrips, a prepared spell, one free casting a day. ~1
[{ "when": "always", "do": [{ "kind": "cantrip_known", "name": "Guidance" },
                            { "kind": "always_prepared", "name": "Cure Wounds" }] },
 { "when": "action", "do": [{ "kind": "effect", "effect": { "kind": "utility" }, "economy": "action" }],
   "uses": { "per": "long", "count": 1 } }]

// 6. Alert - the bonus lands on the Initiative roll, the swap reminds. 1
[{ "when": "initiative", "do": [{ "kind": "bonus", "to": "initiative", "amount": "prof" }] },
 { "when": "initiative", "decide": "ask_after",
   "do": [{ "kind": "note", "text": "You can swap your Initiative with a willing ally who is not Incapacitated." }] }]

// 7. A knockdown rider - a condition for exactly the rounds you name.
{ "when": "hit", "if": { "weapon": { "melee": true }, "target": { "size": "Large" } },
  "do": [{ "kind": "condition", "name": "prone", "until": "rounds", "rounds": 2 }], "uses": "once_per_turn" }

// 8. A dragon's affinity - a rider and a passive on one feature.
[{ "when": "spell_damage", "if": { "damage_type": ["fire"] },
   "do": [{ "kind": "bonus", "to": "damage", "amount": "ability:cha" }], "uses": "once_per_turn" },
 { "when": "always", "do": [{ "kind": "resistance", "types": ["fire"] }] }]

// 9. Something the engine cannot see yet - accepted, priced, handed back as a reminder.
{ "when": "roll", "if": { "light": "dim" },
  "do": [{ "kind": "note", "text": "In gloom they move like smoke: Advantage on Stealth." }],
  "decide": "dm" }
```

## Restating what is already on the sheet

`revise_mechanics {campaign_id, homebrew_id, clauses, reason}` restates a feature or a feat: it
replaces that entry's clauses, prices it again and works the sheets that hold it out again. Use it
for features invented before the engine could run them, and whenever you find prose on a sheet that
should have been a rule. Check it with `check_mechanics` first. A restatement above one feat's worth
is refused outside a freeform campaign: trim it, or offer the extra as a new boon with
`propose {op: feature}`, which is the call that asks the player.
