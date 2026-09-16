# The wiki connector

`src/ingest/` pulls faction, unit and map pages off a MediaWiki install and writes a
cache that the dataset loader overlays onto the curated records.

## Running it

```bash
npm run ingest
```

Options:

| Flag | Meaning |
|---|---|
| `--endpoint <url>` | `api.php` endpoint. Defaults to `https://cnc.fandom.com/api.php`. |
| `--category <name>` | Category to crawl. Repeatable. Replaces the defaults entirely. |
| `--search <term>` | Extra full-text search. Repeatable. Added to the defaults. |
| `--discover <prefix>` | List the wiki's real category names under a prefix, then exit. |
| `--limit <n>` | Cap on pages fetched. Default 600. |
| `--delay <ms>` | Delay between API calls. Default 250. |
| `--dry-run` | Fetch and parse, report counts, write nothing. |
| `--soft-fail` | Exit 0 when the wiki is unreachable (for CI and deploys). |
| `--game <regex>` | Keep only pages about this game. Default `generals\|zero hour`. |

## How the crawl works

1. **Collect titles.** Members of each seed category, plus the results of a few
   full-text searches that catch pages the categories miss. Titles are de-duplicated.
2. **Fetch.** Wikitext and categories, 50 titles per API call — the MediaWiki limit —
   with continuation followed automatically.
3. **Parse.** Each page becomes at most one dataset record. See below.
4. **Write.** `data/wiki-cache/<timestamp>.json`. The loader reads the newest file.

The client sends a descriptive `User-Agent`, honours `maxlag`, waits between requests,
and backs off exponentially on 429 and 5xx.

## When the category names are wrong

Wiki category names drift, and the seed list in `src/ingest/run.ts` is a starting
point rather than a contract. If the crawl reports zero pages, find the real names:

```bash
npm run ingest -- --discover "Zero Hour"
npm run ingest -- --discover "Generals"
```

That prints the matching categories and suggests a `--category` command line to use.

## The parser

`src/ingest/parse.ts` does four things:

- **`parseInfobox`** pulls `| key = value` pairs out of the first infobox on a page.
  It tracks brace depth, so a `{{Tooltip|...}}` nested inside a value does not end the
  scan early and swallow every key after it.
- **`stripMarkup`** removes links, templates, refs, comments and bold markers.
- **`leadSentence`** skips the leading templates — again brace-depth aware, because a
  lazy regex stops at the first `}}`, which is usually a nested template rather than
  the end of the infobox — and returns the article's first real sentence.
- **`classify`** decides whether a page is a unit, a faction, a map or none of those,
  from its categories and the shape of its infobox. The hint patterns match plurals,
  because wiki categories are almost always plural (`China vehicles`, `GLA generals`).

## Why `--game` exists

`cnc.fandom.com` documents every Command & Conquer title, not just Generals. The
first real crawl proved it: the Generals seed categories returned nothing, category
discovery fell back to crawling every category matching `unit|vehicle|...` across
the whole wiki, and the result was 214 "units" of which **9** matched anything in
the curated dataset. The rest were Tiberium and Red Alert pages.

Two filters now apply, and both matter:

- discovery only considers categories that match `--game`, and
- fetched pages are kept only if the game appears in the title, the categories, or
  the opening prose.

If the reconciliation report still shows a low match count, widen or correct the
category names rather than the game filter — a low count means the crawl is looking
in the wrong place, not that the filter is too tight.

## What the overlay may and may not change

The merge in `src/data/index.ts` is one-directional by design.

**The wiki may contribute:** `cost`, `description`, `wikiPage`, `players`, and whole
entities that were never curated (those arrive tagged `source: 'wiki'`).

**The wiki may never overwrite:**

| Record | Protected fields |
|---|---|
| Faction | `threat`, `vulnerability`, `opening`, `signatureTactics`, `id`, `side` |
| Unit | `answers`, `roles`, `factions`, `id`, `tier` |
| Map | `chokepoints`, `supplyDensity`, `openness`, `id` |

Those fields are the strategy judgement the engine reasons over. Scraped prose cannot
produce them, and letting a wiki edit change them would silently change the advice.

**A wiki record that matches nothing curated is rejected**, unless it happens to
carry every field the engine needs — which scraped pages do not. The faction list is
a closed set of twelve, so nothing is ever admitted there at all. This is not
fussiness: admitting unmatched pages as armies is exactly what put factions with no
threat profile in front of the planner and blanked the deployed page. The count of
rejected records is reported in the footer, so a mis-scoped crawl is visible.
A record touched by the overlay is re-tagged `source: 'merged'` so the provenance line
in the CLI and the web page stays accurate.

## When the wiki is unreachable

The client raises `WikiBlockedError` on a proxy denial, a DNS failure or a refused
connection, with the three things worth trying:

- run the ingest from a network that allows the host,
- point `--endpoint` at a mirror or a self-hosted MediaWiki copy,
- skip it — the curated dataset in `data/curated/` is complete enough to plan with on
  its own, which is the whole reason it is authored rather than generated.

`data/wiki-cache/` is gitignored rather than committed, so a fresh clone always starts
from the curated dataset and a crawl is an explicit step — locally via `npm run ingest`,
or automatically on Vercel, where `vercel-build` runs it with `--soft-fail` so an
unreachable wiki still ships the curated dataset instead of breaking the deploy.
