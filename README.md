# Battle Lineup

A skirmish planner for **Command & Conquer: Generals — Zero Hour**.

Pick your army, the enemy army, or neither. Pick a difficulty. Optionally pick a map.
You get back a build order, the units that actually counter what the enemy does, a
timeline, and a short list of things not to do.

If you leave your own army unset, the planner scores all twelve armies against the
enemy and picks the one with the best answers.

## Quick start

```bash
npm install
npm test            # 52 tests
npm run plan        # interactive
```

Or drive it with flags:

```bash
npm run plan -- --enemy gla_stealth --difficulty hard
npm run plan -- --you usa_laser --enemy china_tank --map winding_river
npm run plan -- --you gla --enemy usa_air -d brutal --json
npm run plan -- --list-factions
npm run plan -- --list-maps
```

There is also a browser version — a command terminal that runs the same engine
entirely client-side, with commander portraits and unit photography from the wiki
and a drawn tactical diagram for every theatre:

```bash
npm run build:web   # bakes public/index.html
```

Open `public/index.html` in a browser. No server needed.

## Deploy

```bash
vercel --prod
```

Or import the repo at <https://vercel.com/new> and accept every default —
`vercel.json` supplies the build.

The deploy is also how the data stays current: Vercel's build network is
unrestricted, so `npm run vercel-build` runs the wiki crawl before baking the
page. If the wiki is unreachable the ingest exits cleanly and the build ships the
curated dataset instead, so a bad day at the wiki never breaks the site. Full
detail in [`docs/deploy.md`](docs/deploy.md).

## What it knows

| | |
|---|---|
| Armies | 12 — USA, China, GLA and all nine Generals Challenge sub-generals |
| Units | 61, tagged by role, tier, cost and what they answer |
| Maps | 16, rated for chokepoints, supply density and open ground |
| Matchup notes | 15 hand-authored groups, keyed by army or by side |

## How the engine decides things

Everything hangs off ten **threat axes**: `air`, `armor`, `infantry_swarm`,
`artillery`, `stealth`, `superweapon`, `economy`, `base_defense`, `early_rush`,
`chemical`.

1. **Threat profile.** Each army has a rating on every axis. That baseline is then
   scaled by difficulty (a harder AI attacks sooner, expands faster and reaches its
   tech earlier) and by the map (chokepoints favour siege, open ground favours
   armour and air, rich supply pushes the game long and makes superweapons matter).

2. **Counters.** Every unit declares which axes it answers and how strongly. For each
   axis the enemy actually presses, the engine ranks your roster by answer strength,
   then by how cheap and how early the unit is. If your army has no real answer, it
   says so rather than padding the list.

3. **Lineup scoring.** Each army is scored on three counts — can you answer what they
   throw (defense), does what you throw land on something they are soft against
   (offense), and do they press the axes you are structurally exposed on (risk).
   Scores are calibrated against the observed range across all 144 matchups at all
   four difficulties, so they spread out instead of saturating.

4. **Build order.** The army's stock opening, with matchup-driven steps spliced in:
   anti-air moves earlier against an air army, a detector becomes mandatory against
   Kassad, area damage replaces single-target fire against a horde.

The engine lives in `src/engine/` and imports nothing from Node, which is why the
browser build can run the identical code rather than a second implementation of it.

## The wiki connector

`src/ingest/` is a MediaWiki API client that crawls faction, unit and map pages and
writes them to `data/wiki-cache/`. The dataset loader overlays that cache on top of
the curated records automatically — no rebuild step, no code change.

```bash
npm run ingest                                            # crawl the default categories
npm run ingest -- --discover "Zero Hour"                  # list real category names first
npm run ingest -- --category "Zero Hour GLA arsenal"      # then crawl the ones you want
npm run ingest -- --endpoint https://mirror/api.php       # any MediaWiki install
npm run ingest -- --dry-run                               # parse without writing
```

The crawl seeds itself from the pages the curated dataset already names, then adds
whatever the categories and searches turn up. Three things about this wiki are worth
knowing, because each one silently produced an empty crawl before it was handled:

- **Category names are not the game's names.** Zero Hour arsenals are filed by
  nationality (`Zero Hour American arsenal`), and the original game is `Generals 1`,
  not `Generals`. `--discover` lists what actually exists.
- **It is not `{{Infobox}}`.** Unit pages open with `{{UnitBox}}`, behind a couple
  of navigation templates. That is where costs live.
- **Plain titles are disambiguation stubs.** `Ranger` lists the Red Alert vehicle
  and the Generals infantryman without being either; the crawler follows the stub
  to the article for this game.

The overlay is deliberately one-directional. The wiki contributes **facts** — costs,
descriptions, page links, and entities that were never curated. It never overwrites
**judgement**: threat ratings, role tags, counter weights and the authored strategy
notes are protected fields. That split is what keeps a wiki edit from silently
changing the advice.

See [`docs/wiki-ingest.md`](docs/wiki-ingest.md) for the crawl strategy, the parser,
and what to do when category names drift.

## Where the data comes from, honestly

The dataset in `data/curated/` is **authored**, not scraped, and it ships that way so
the planner works offline and out of the box.

- The twelve armies, their commanders, their specialisations, and the stealth
  detectors (Sentry Drone, Listening Outpost, Radar Van) were verified against
  published sources while building this.
- **Unit costs are approximate.** They are directionally right and good enough for
  the cost-efficiency ranking, but they are not authoritative. Running the ingest
  reconciles them against the wiki's own numbers and corrects 25 of them.
- **Unit and commander art comes from the wiki**, not from this repository: the
  crawl records each page's lead image and the page links to it. 54 of 61 units and
  all 12 commanders resolve to one.
- **The map list is partial.** Sixteen maps are included; the ratings on them
  (chokepoints, supply, openness) are authored for planning purposes, since the wiki
  does not publish those as data. Ingest adds maps it finds.
- **Maps have no wiki art, and the page does not pretend otherwise.** cnc.fandom.com
  has no per-map article — every map title redirects to one shared list page — and
  holds exactly three map previews in total. Rather than show a photo for one map and
  nothing for the other fifteen, the terminal draws each map its own generated
  tactical diagram from the authored ratings.

`data/wiki-cache/` is gitignored, so a fresh clone starts on the curated dataset
alone. Fill it either way:

1. **Deploy to Vercel** — `npm run vercel-build` runs the crawl before baking the
   page, and the reconciliation report lands in the build log.
2. **Run it locally** — `npm run ingest`.

After a crawl, `npm run ingest` prints a reconciliation report: how many curated
units matched a wiki page, how many carry art, and every cost the wiki disagrees
with. A current crawl reconciles **54 of 61 units** and applies **25 cost
corrections**, which is the concrete reason the curated costs above are described
as approximate.

Every record carries a `source` field of `curated`, `wiki` or `merged`, and both the
CLI and the web page print the provenance line so you always know which you are
looking at.

## Project layout

```
data/curated/       authored dataset: factions, units, maps, matchup notes
data/wiki-cache/    ingest output, overlaid automatically (gitignored)
src/types.ts        the domain model
src/data/           loader and the curated/wiki merge
src/engine/         threat profiling, counters, lineup scoring, plan assembly
src/ingest/         MediaWiki client, wikitext parser, crawl runner
src/cli/            terminal interface and renderer
web/                page template and the bundler that inlines engine + data
public/             the baked single-file site (Vercel's static root)
test/               52 tests
```

## Development

```bash
npm run typecheck
npm test
npm run build
```

Adding an army, unit or map means editing JSON in `data/curated/` — the engine picks
it up with no code change, and the dataset tests will tell you if a record is
inconsistent with the rest.
