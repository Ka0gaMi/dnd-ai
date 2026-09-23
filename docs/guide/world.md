# The living world

The world moves on its own between scenes. Factions pursue agendas, each a goal tracked as a **clock**
(filled out of its size) and a set of **portents** — the warning signs a traveller could notice. A
portent is your foreshadowing: weave its words into scenes as rumours, tracks, prices or late
watchfires, and never state the clock or the faction's plan outright. Call `world {op: get}` before a
scene to see every faction, how it regards the party, the agendas in motion and the last ten events.

## Clocks and the two signs

An agenda the party has not noticed is yours alone. It becomes a **known clock** — one the player may
hear about — only when the party has heard **two of its portents**, or when you call
`world {op: reveal, agenda}`. Mark a portent heard by having an NPC speak it, or by calling
`rumour {op: get}` where the party is; news travels the region's roads on its own. Once a clock is
known, a clock that fills and an irreversible outcome will wait until the party has heard its two
signs, so the warning always lands before the blow. Reveal an agenda when the party has put the pieces
together, and use its clock to decide how close the plan is to finishing.

## Recording deeds

Call `world {op: deed, target, value, reason}` whenever the party helps or harms a faction or a notable
NPC, and the world remembers it as a fading reason. `target` is a faction id or name, or a codex entity
id or name; `value` is an integer from **-5 to 5**, never 0; `reason` is a few words that become the
memory. Scale the value: -1 a slight, -2 a real loss, -3 a serious injury to their interests, -5 an
existential blow, and the same upward for aid. Examples:

- `world {op: deed, target: "The Redham Knives", value: 2, reason: "cleared their rivals from the docks"}`
- `world {op: deed, target: "House of Ficengwind", value: -3, reason: "exposed their tax farmers"}`
- `world {op: deed, target: "Sera Vane", value: 1, reason: "escorted her caravan safely"}`

A faction's rivals feel the opposite at half strength, so helping one power turns another against the
party without you tracking it by hand. A refused deed changes nothing.

## Time passes

The world advances with the clock: `time {op: advance}`, rests and travel all tick it forward, and
agendas fill, portents fire and finished plans resolve on their own. You never roll for this; read the
resulting events in `world {op: get}` and narrate them through the news the party actually hears.
