# The living world

The world moves on its own between scenes. Factions pursue agendas, each a goal tracked as a **clock**
(filled out of its size) and a set of **portents** — the warning signs a traveller could notice. A
portent is your foreshadowing: weave its words into scenes as rumours, tracks, prices or late
watchfires, and never state the clock or the faction's plan outright. Call `world {op: get}` before a
scene to see every faction, how it regards the party, the agendas in motion and the last ten events.

## Clocks and the two signs

An agenda the party has not noticed is yours alone. It becomes a **known clock** — one the player may
hear about — only when the party has heard **two of its portents**, or when you call
`world {op: reveal, agenda}`. The party hears portents by being in a settlement the news has reached:
it is delivered when a day passes there and when a checkpoint's `scene_location` moves the party into
a town, and the briefing's World block lists what they heard. An irreversible outcome (a brood
overrunning a town, say) against a place the party knows waits until they have heard two of its
signs, so the warning always lands before the blow. Reveal an agenda when the party has put the pieces
together, and use its clock to decide how close the plan is to finishing.

## Recording deeds

Call `world {op: deed, target, value, reason}` whenever the party helps or harms a faction or a notable
NPC, and the world remembers it as a fading reason. `target` is a faction id or name, or a codex entity
id or name; `value` is an integer from **-5 to 5**, never 0; `reason` is a few words that become the
memory, and the player sees it in the World tab, so write it as the party would remember the deed and
never name a secret or a place they have not found. Scale the value: -1 a slight, -2 a real loss, -3 a serious injury to their interests, -5 an
existential blow, and the same upward for aid. `place` (optional) is where it happened, a place id or
name on the region map; leave it out and the deed happens where the latest scene's location puts the
party. Examples:

- `world {op: deed, target: "The Redham Knives", value: 2, reason: "cleared their rivals from the docks"}`
- `world {op: deed, target: "House of Ficengwind", value: -3, reason: "exposed their tax farmers", place: "Ficengwind"}`
- `world {op: deed, target: "Sera Vane", value: 1, reason: "escorted her caravan safely"}`

Bigger deeds are remembered longer: ±1–2 fades over **30 days** as gratitude and **90** as a grudge,
±3–4 over **180** and **720**, and ±5 **never fades**. A deed is known within days of travel from its
place by size: 1 day, 2, 5, 10, and the whole map for a 5.

A faction's rivals feel the opposite at half strength, rounded down (a ±1 favour goes unnoticed), but
only rivals whose seat lies within the deed's known range; with no place on the map, only rivals in the
target's realm, though a 5 still reaches every rival. The reply gives each new regard as a word and a
total, such as `wary (-3)`. A refused deed, including one at a place the map does not have, changes
nothing.

## Interfering with agendas

When the party acts directly against a plan, record it and let the engine roll the clock back:

- `world {op: setback, agenda, amount, reason}` lowers a clock by 1, 2 or 3.
- `world {op: thwart, agenda, reason}` ends the agenda as lost and costs the faction a resource; that
  faction takes no new agenda for **30 days**.
- `world {op: destroy, target, reason}` ends a faction, or — when `target` names a danger site — clears
  the lair and ends every brood lairing there. Only a faction destroy needs a reason.

Replies may name the faction and the danger site; the news the party hears will not. A refused call
changes nothing.

## Time passes

The world advances with the clock: every day that passes on the calendar (the `time` tool, rests) ticks it forward, and
agendas fill, portents fire and finished plans resolve on their own. You never roll for this; read the
resulting events in `world {op: get}` and narrate them through the news the party actually hears.

## Faiths

A faith spans realms, but its hold varies: each temple faction holds **minor**, **strong** or **dominant**
influence, and a theocracy's crown leads its faith outright. A faith's **fervor** rises with its churches'
wins and cools when it burns hot; when it falls low, a **heresy** breaks away in a distant town and preaches
against it. `world {op: get}` lists the faiths, their heads, branches and heresies.

The **church–crown contest** is a clock: a crown seizing church lands fills it, and at full the faith
**excommunicates** the realm — its temples refuse healing and raising the dead until the sentence lapses, so
narrate closed doors and unhealed wounds while it lasts. Goals the world may pursue: crusade, persecute
heretics, raise a cathedral, seize church lands.
