# Region

The region map is the campaign's ground: its settlements, the named areas, the roads and sea routes
between them, and the dangers only you can see. The player makes it in the companion window
(Settings, Region) from a Perilous Shores map, so there is one per campaign and it is there before
you need it.

## Set the story inside it

Open scenes in or between the places on the map. Say where the party is with `checkpoint {op: save,
scene_location}` at each scene break, using the map's place names; the briefing then reads 'Party is at
…' and measures what is near from there. Invent freely around the map - an inn, a farm, a shrine, a mill
- but invent only inside it, and never contradict what a place already is. A village stays a village,
walls stay up, and the coast stays where the map put it.

## Travel

The map is hexed and one hex is 6 miles. SRD 5.2.1 travel pace gives Fast 30, Normal 24 and Slow 18
miles a day, so a Normal day is 4 hexes. Call `region {op: get, place, to}` for the route between two
places: it returns the hex and mile count, whether the way is road or sea, and the settlements it
passes through. Advance the clock with `time {op: advance}` for the days a trip takes, and route a leg
at a time whenever the party stops somewhere along the way.

## Revealing places

Call `region {op: reveal, place}` when the party hears of a place or reaches it. That marks it known
and writes the codex entry the player sees, so their window fills in as they travel. Once a place is
revealed the map can no longer be replaced, so reveal late rather than early.

## Town and dungeon maps

`region {op: map, place}` gives a settlement's own city or village map, or a danger's own dungeon map,
as a short digest. The first call for a place opens a browser in the background and takes about a
minute; if your call times out, call again — the map is cached as soon as it lands, while later calls
are instant, so call it when the party is about to arrive or plans a visit rather than for every place
at once. Use the district names, walls, towers and wall corners, and water the digest gives you in
narration, and never contradict them. A revealed town's map is drawn for the player in its
codex entry, but a dungeon map never is, because it shows secret doors. Dungeon notes are flavour
only: run any item or effect as SRD content or a homebrew clause.

## Buildings

`region {op: building, place, building, kind}` creates a named building inside a settlement — a tavern,
inn, house, shop, workshop, warehouse, manor, temple, guildhall or keep — with a real floor plan of its
own. The first call fetches the plan and takes about a minute (call again if it times out); later calls
are instant, so name buildings as the story needs them rather than up front. Use the digest's rooms,
entrance and stairs when the party moves inside, and rename rooms freely in narration, because the names
come from the generator. Call `region {op: reveal, place, building}` when they learn of the building or
enter it, and the player sees its plan in the settlement's codex entry; secret rooms stay hidden from
that plan and are listed in the digest for you alone.

## Dangers

Dangers are the dungeons the generator planted, and they are yours: the player never sees their names
unless you reveal one, and the map link is in `region {op: get, place}` and, once the danger is
revealed, in its codex hidden notes. Introduce them through rumours, wreckage and encounters rather
than an announcement. The dungeon generator's own rooms, items and effects are flavour only - treat
them as prompts, and run anything with a mechanical effect either as SRD content or as a homebrew
clause.
