# Deploying to Vercel

The site is a single static HTML file. The interesting part is that **the build
step is also the wiki crawl** — Vercel's build network is unrestricted, so every
deploy refreshes the dataset from the wiki and bakes it into the page.

## What the build does

`vercel.json` points Vercel at `npm run vercel-build`, which is:

```
tsc                                  compile
node dist/src/ingest/run.js --soft-fail   crawl the wiki into data/wiki-cache/
node web/build.mjs                   bake public/index.html
```

`--soft-fail` is the important flag. If the wiki is unreachable — blocked,
rate-limited, down — the ingest exits 0 with a message and the build continues,
shipping the curated dataset instead of failing the deploy. You never get a
broken site because a third-party wiki had a bad day.

Output is `public/`, which Vercel serves as a static site. No serverless
functions, no runtime, no environment variables.

## Deploy it

**Option A — connect the repo (recommended).**

1. Go to <https://vercel.com/new>.
2. Import `project-istari/project-thorongil`.
3. Vercel reads `vercel.json`, so leave every field on its default. Do not set a
   framework preset — it is `null` on purpose.
4. Deploy. Every push to the branch redeploys and re-crawls.

**Option B — from your machine.**

```bash
npm i -g vercel
vercel login
vercel --prod
```

Run it from the repository root; `vercel.json` supplies the rest.

## Checking the wiki actually got crawled

The build log tells you. A successful crawl prints the category counts, then:

```
Parsed: 214 units, 18 factions, 63 maps, 91 unclassified

Reconciliation: 47/61 curated units matched a wiki page
  12 cost corrections (applied by the overlay):
    Overlord: curated 2000 -> wiki 2000
    ...
```

The live page also shows it. The footer reads either:

- `Wiki overlay · 214 pages from cnc.fandom.com · 2026-09-16` — the crawl ran, or
- `No wiki overlay — run npm run ingest to merge live wiki data` — it did not.

If the crawl comes back empty, the ingest automatically falls back to discovering
the wiki's real category names and crawling those, because category names drift
and a deploy has nobody to hand-tune them. See
[`wiki-ingest.md`](wiki-ingest.md).

## Custom domain

Add it in the Vercel project's Domains tab. Nothing in the build depends on the
hostname.

## A note on caching

`data/wiki-cache/` is gitignored, so each deploy starts from a clean crawl rather
than a stale cached file. The crawl is a few hundred API calls with a 250 ms delay
— under two minutes, and polite to the wiki. If you would rather pin the data,
commit a cache file and drop the ingest step from `vercel-build`.
