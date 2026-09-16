#!/usr/bin/env node
/**
 * Pull faction, unit and map pages from the Command & Conquer wiki into
 * data/wiki-cache/, where the dataset loader overlays them onto the curated
 * records.
 *
 *   npm run ingest
 *   npm run ingest -- --endpoint https://mirror.example/api.php
 *   npm run ingest -- --discover "Zero Hour"
 *   npm run ingest -- --category "Zero Hour units" --category "Generals maps"
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { WikiClient, WikiBlockedError, DEFAULT_ENDPOINT, type WikiPage } from './wiki.js';
import { parsePage, isDisambiguation, disambiguationLinks, type ParsedPage } from './parse.js';
import { WIKI_CACHE, CURATED, INGEST_STATUS } from '../data/index.js';
import type { WikiCache } from '../data/index.js';
import type { IngestStatus, Unit } from '../types.js';

/**
 * Seed categories, verified against cnc.fandom.com's own category list.
 *
 * These were previously guesses ("USA arsenal", "Zero Hour units") and every
 * one of them returned zero pages — the wiki files Zero Hour arsenals under the
 * in-fiction nationality, not the faction label the game uses. Wiki category
 * names still drift, so run with --discover to list what the wiki actually has
 * and override with --category.
 */
const DEFAULT_CATEGORIES = [
  'Zero Hour American arsenal',
  'Zero Hour Chinese arsenal',
  'Zero Hour GLA arsenal',
  'Zero Hour Leang Arsenal',
  'Zero Hour characters',
  'Generals 1 American arsenal',
  'Generals 1 Chinese arsenal',
  'Generals 1 GLA arsenal',
  'Generals 1 characters',
  'Generals 1 skirmish maps',
];

/** Searches that surface pages the categories miss. */
const DEFAULT_SEARCHES = [
  'Zero Hour general',
  'Zero Hour unit',
  'Generals Zero Hour skirmish map',
];

function parseCli() {
  const { values } = parseArgs({
    options: {
      endpoint: { type: 'string', default: DEFAULT_ENDPOINT },
      category: { type: 'string', multiple: true },
      search: { type: 'string', multiple: true },
      discover: { type: 'string' },
      limit: { type: 'string', default: '600' },
      delay: { type: 'string', default: '250' },
      'dry-run': { type: 'boolean', default: false },
      'soft-fail': { type: 'boolean', default: false },
      game: { type: 'string', default: 'generals|zero hour' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  return values;
}

const HELP = `
battle-lineup wiki ingest

  --endpoint <url>     MediaWiki api.php endpoint (default: ${DEFAULT_ENDPOINT})
  --category <name>    Category to crawl (repeatable; replaces the defaults)
  --search <term>      Extra full-text search to include (repeatable)
  --discover <prefix>  List wiki categories starting with <prefix>, then exit
  --limit <n>          Maximum pages to fetch (default 600)
  --delay <ms>         Delay between API requests (default 250)
  --dry-run            Fetch and parse, but do not write the cache
  --soft-fail          Exit 0 when the wiki is unreachable (for CI and deploys)
  --game <regex>       Keep only pages about this game (default: "generals|zero hour").
                       cnc.fandom.com covers every C&C title, so without this a
                       crawl returns mostly Tiberium and Red Alert pages.
  --help               This message
`;

async function listCategories(client: WikiClient, prefix: string): Promise<string[]> {
  const res = await client.query<{ query?: { allcategories: Array<{ category: string }> } }>({
    action: 'query',
    list: 'allcategories',
    acprefix: prefix,
    aclimit: '200',
  });
  return (res.query?.allcategories ?? []).map((c) => c.category);
}

/**
 * The wiki pages the curated dataset already names.
 *
 * Every curated unit, faction and map records the page it corresponds to. Those
 * are exactly the pages worth fetching — crawling categories finds *more*
 * entities, but only these can reconcile against what we ship. Seeding the
 * crawl with them is what lifts the match rate off the floor.
 */
function curatedTitles(): string[] {
  const out = new Set<string>();
  for (const file of ['units.json', 'factions.json', 'maps.json']) {
    try {
      const records = JSON.parse(readFileSync(join(CURATED, file), 'utf8')) as Array<{ wikiPage?: string }>;
      for (const r of records) {
        if (r.wikiPage) out.add(r.wikiPage.replace(/_/g, ' '));
      }
    } catch {
      // A missing or malformed curated file is the dataset tests' problem, not
      // the crawler's; carry on with whatever the other files gave us.
    }
  }
  return [...out];
}

/**
 * Compare what the wiki says against what we curated.
 *
 * This is the point of the crawl: the curated costs are approximations, and
 * this report is how you see which ones the wiki disagrees with.
 */
function reconcile(units: WikiCache['units']): { matched: number; curatedTotal: number; costCorrections: number } {
  const curatedAll = JSON.parse(readFileSync(join(CURATED, 'units.json'), 'utf8')) as Unit[];
  if (!units?.length) return { matched: 0, curatedTotal: curatedAll.length, costCorrections: 0 };
  const curated = curatedAll;
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const byName = new Map(curated.map((u) => [norm(u.name), u]));
  const byPage = new Map(curated.flatMap((u) => (u.wikiPage ? [[norm(u.wikiPage), u] as const] : [])));

  let matched = 0;
  let withImages = 0;
  const costDiffs: string[] = [];
  for (const w of units) {
    const c = (w.wikiPage ? byPage.get(norm(w.wikiPage)) : undefined) ?? byName.get(norm(w.name));
    if (!c) continue;
    matched++;
    if (w.image) withImages++;
    if (typeof w.cost === 'number' && w.cost !== c.cost) {
      costDiffs.push(`    ${c.name}: curated ${c.cost} -> wiki ${w.cost}`);
    }
  }

  console.log(`\nReconciliation: ${matched}/${curated.length} curated units matched a wiki page`);
  console.log(`  ${withImages}/${matched} matched units carry a wiki image`);
  if (costDiffs.length) {
    console.log(`  ${costDiffs.length} cost corrections (applied by the overlay):`);
    for (const line of costDiffs.slice(0, 25)) console.log(line);
    if (costDiffs.length > 25) console.log(`    ... and ${costDiffs.length - 25} more`);
  } else if (matched) {
    console.log('  no cost disagreements');
  }
  return { matched, curatedTotal: curated.length, costCorrections: costDiffs.length };
}

/**
 * Swap disambiguation pages for the article they point at for this game.
 *
 * The curated dataset records plain titles, and on a wiki covering every C&C
 * release a plain title is usually a disambiguation stub: "Ranger" lists the
 * Red Alert vehicle and the Generals infantryman without being either. Those
 * stubs carry no cost, no image and no prose, so left unresolved they match a
 * curated record and enrich it with nothing.
 */
async function resolveDisambiguations(
  client: WikiClient,
  pages: WikiPage[],
  gameFilter: RegExp,
): Promise<WikiPage[]> {
  const stubs = pages.filter(isDisambiguation);
  if (!stubs.length) return pages;

  // Candidate title -> the title the curated record actually asked for, which
  // has to survive onto the replacement or the join it exists for is lost.
  const wanted = new Map<string, string>();
  for (const stub of stubs) {
    const origin = stub.requestedTitle ?? stub.title;
    const candidate = disambiguationLinks(stub)
      .filter((l) => gameFilter.test(l))
      // "Generals 2" is a different game that still matches /generals/. Rank it
      // last rather than excluding it, so it is a fallback and never a default.
      .sort((a, b) => Number(/generals\s*(2|ii)\b/i.test(a)) - Number(/generals\s*(2|ii)\b/i.test(b)))[0];
    if (candidate && !wanted.has(candidate)) wanted.set(candidate, origin);
  }
  if (!wanted.size) return pages;

  console.log(`  resolving ${stubs.length} disambiguation pages -> ${wanted.size} articles`);
  const resolved = await client.fetchPages([...wanted.keys()]);

  const replacements: WikiPage[] = [];
  for (const page of resolved) {
    // fetchPages reports the candidate it was asked for; we want the curated
    // title behind it instead.
    const origin = wanted.get(page.requestedTitle ?? page.title);
    if (!origin) continue;
    replacements.push({ ...page, requestedTitle: origin });
  }

  const dropped = new Set(stubs.map((s) => s.title));
  const kept = pages.filter((p) => !dropped.has(p.title));
  // A replacement can collide with a page the crawl already had. Keep the copy
  // that carries a curated title, since that is the only one that can join to a
  // curated record; a plain crawl hit enriches nothing on its own.
  const byTitle = new Map(kept.map((p) => [p.title, p] as const));
  for (const r of replacements) {
    const seen = byTitle.get(r.title);
    if (!seen?.requestedTitle) byTitle.set(r.title, r);
  }
  return [...byTitle.values()];
}

/**
 * Record what this run did, succeed or fail.
 *
 * The page and the CLI read this so "no wiki data" can say whether the crawl
 * was refused, came back empty, or was never attempted at all.
 */
function writeStatus(status: IngestStatus): void {
  try {
    mkdirSync(dirname(INGEST_STATUS), { recursive: true });
    writeFileSync(INGEST_STATUS, JSON.stringify(status, null, 2));
  } catch {
    // Never fail a build over the status file.
  }
}

async function discover(client: WikiClient, prefix: string): Promise<void> {
  const cats = await listCategories(client, prefix);
  if (!cats.length) {
    console.log(`No categories found starting with "${prefix}".`);
    return;
  }
  console.log(`Categories starting with "${prefix}":\n`);
  for (const c of cats) console.log(`  ${c}`);
  console.log(`\nRe-run with: npm run ingest -- ${cats.slice(0, 3).map((c) => `--category "${c}"`).join(' ')}`);
}

async function main(): Promise<number> {
  const args = parseCli();
  if (args.help) { console.log(HELP); return 0; }

  const client = new WikiClient({
    endpoint: args.endpoint!,
    delayMs: Number(args.delay),
  });

  console.log(`Wiki ingest → ${client.host}`);

  if (args.discover) {
    await discover(client, args.discover);
    return 0;
  }

  const gameFilter = new RegExp(args.game ?? 'generals|zero hour', 'i');
  const categories = args.category?.length ? args.category : DEFAULT_CATEGORIES;
  const searches = [...DEFAULT_SEARCHES, ...(args.search ?? [])];
  const limit = Number(args.limit);

  // 1. Collect candidate titles.
  const titles = new Map<string, string>();

  // The pages our own dataset names come first: they are the only ones that can
  // reconcile, so they must never be crowded out by the --limit cap.
  const seeded = curatedTitles();
  for (const t of seeded) titles.set(t, t);
  console.log(`  curated dataset: ${seeded.length} pages`);

  let categoryHits = 0;
  for (const cat of categories) {
    const members = await client.categoryMembers(cat, limit);
    console.log(`  category "${cat}": ${members.length} pages`);
    categoryHits += members.length;
    for (const m of members) titles.set(m.title, m.title);
  }
  for (const term of searches) {
    const hits = await client.search(term, 50);
    console.log(`  search "${term}": ${hits.length} pages`);
    for (const h of hits) titles.set(h.title, h.title);
  }

  // Seed names drift. If the *categories* came back empty and the caller did not
  // pin them explicitly, find the real ones and crawl those instead — this is
  // what lets an unattended deploy build succeed without hand-tuning.
  //
  // Gated on the category yield, not on the total title count: the searches and
  // the curated seed always return something, so a total-count test could never
  // fire and the drifted names failed silently for as long as it was written
  // that way.
  if (categoryHits === 0 && !args.category?.length) {
    console.log('\n  seed categories returned nothing; discovering real category names...');
    const found = new Set<string>();
    for (const prefix of ['Generals', 'Zero Hour']) {
      for (const c of await listCategories(client, prefix)) found.add(c);
    }
    // Both filters matter: the category has to be about this game AND about a
    // kind of page we model. Dropping the first one is what pulled in 200-odd
    // Tiberium and Red Alert units on the first real crawl.
    const relevant = [...found]
      .filter((c) => gameFilter.test(c))
      .filter((c) => /unit|vehicle|infantry|aircraft|arsenal|map|general|faction|structure/i.test(c));
    console.log(`  discovered ${found.size} categories, ${relevant.length} relevant`);
    for (const cat of relevant.slice(0, 20)) {
      const members = await client.categoryMembers(cat, limit);
      if (members.length) console.log(`  category "${cat}": ${members.length} pages`);
      for (const m of members) titles.set(m.title, m.title);
    }
  }

  const wanted = [...titles.values()].slice(0, limit);
  if (!wanted.length) {
    console.error('\nNo pages found, and category discovery turned up nothing usable.');
    console.error('Run:  npm run ingest -- --discover "Zero Hour"   to inspect the wiki by hand.');
    writeStatus({
      attemptedAt: new Date().toISOString(),
      ok: false,
      source: client.host,
      error: 'crawl reached the wiki but no pages matched any category or search',
    });
    return args['soft-fail'] ? 0 : 1;
  }

  // 2. Fetch and parse.
  console.log(`\nFetching ${wanted.length} pages...`);
  const fetched = await resolveDisambiguations(client, await client.fetchPages(wanted), gameFilter);

  // Keep only pages that are actually about this game. A Generals page names
  // the game in its categories or its prose; a Tiberian Sun page does not.
  const pages = fetched.filter((pg) =>
    gameFilter.test(pg.title) ||
    gameFilter.test(pg.categories.join(' ')) ||
    gameFilter.test(pg.wikitext.slice(0, 4000)),
  );
  const dropped = fetched.length - pages.length;
  if (dropped) console.log(`  filtered out ${dropped} pages from other C&C games (--game "${gameFilter.source}")`);

  const parsed: ParsedPage[] = pages.map(parsePage);

  const cache: WikiCache & { raw: ParsedPage['raw'][] } = {
    fetchedAt: new Date().toISOString(),
    source: client.host,
    pageCount: pages.length,
    factions: parsed.flatMap((p) => (p.faction ? [p.faction] : [])),
    units: parsed.flatMap((p) => (p.unit ? [p.unit] : [])),
    maps: parsed.flatMap((p) => (p.map ? [p.map] : [])),
    raw: parsed.map((p) => p.raw),
  };

  const counts = {
    factions: cache.factions?.length ?? 0,
    units: cache.units?.length ?? 0,
    maps: cache.maps?.length ?? 0,
    unknown: parsed.filter((p) => p.kind === 'unknown').length,
  };
  console.log(`\nParsed: ${counts.units} units, ${counts.factions} factions, ${counts.maps} maps, ${counts.unknown} unclassified`);
  console.log(`API requests: ${client.requestCount}`);
  const recon = reconcile(cache.units);

  if (args['dry-run']) {
    console.log('\n--dry-run: nothing written.');
    return 0;
  }

  writeStatus({
    attemptedAt: new Date().toISOString(),
    ok: true,
    source: client.host,
    pages: pages.length,
    matched: recon.matched,
    curatedTotal: recon.curatedTotal,
    costCorrections: recon.costCorrections,
  });

  mkdirSync(WIKI_CACHE, { recursive: true });
  const out = join(WIKI_CACHE, `${cache.fetchedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(out, JSON.stringify(cache, null, 2));
  console.log(`\nWrote ${out}`);
  console.log('The planner now overlays this onto the curated dataset automatically.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof WikiBlockedError) {
      console.error(`\n${err.message}\n`);
      writeStatus({
        attemptedAt: new Date().toISOString(),
        ok: false,
        source: err.host,
        error: err.detail,
      });
      // A deploy should still ship the curated dataset when the wiki is out of reach.
      process.exit(process.argv.includes('--soft-fail') ? 0 : 2);
    }
    console.error(err);
    process.exit(1);
  });
