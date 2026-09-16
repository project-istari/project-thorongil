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
import { WikiClient, WikiBlockedError, DEFAULT_ENDPOINT } from './wiki.js';
import { parsePage, type ParsedPage } from './parse.js';
import { WIKI_CACHE, CURATED, INGEST_STATUS } from '../data/index.js';
import type { WikiCache } from '../data/index.js';
import type { IngestStatus, Unit } from '../types.js';

/**
 * Seed categories. Wiki category names drift, so these are a starting point,
 * not a contract — run with --discover to list what the wiki actually has and
 * override with --category.
 */
const DEFAULT_CATEGORIES = [
  'Generals units',
  'Zero Hour units',
  'USA arsenal',
  'China arsenal',
  'GLA arsenal',
  'Generals maps',
  'Zero Hour maps',
  'Generals factions',
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
  const costDiffs: string[] = [];
  for (const w of units) {
    const c = (w.wikiPage ? byPage.get(norm(w.wikiPage)) : undefined) ?? byName.get(norm(w.name));
    if (!c) continue;
    matched++;
    if (typeof w.cost === 'number' && w.cost !== c.cost) {
      costDiffs.push(`    ${c.name}: curated ${c.cost} -> wiki ${w.cost}`);
    }
  }

  console.log(`\nReconciliation: ${matched}/${curated.length} curated units matched a wiki page`);
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

  for (const cat of categories) {
    const members = await client.categoryMembers(cat, limit);
    console.log(`  category "${cat}": ${members.length} pages`);
    for (const m of members) titles.set(m.title, m.title);
  }
  for (const term of searches) {
    const hits = await client.search(term, 50);
    console.log(`  search "${term}": ${hits.length} pages`);
    for (const h of hits) titles.set(h.title, h.title);
  }

  // Seed names drift. If they all came back empty and the caller did not pin
  // categories explicitly, find the real ones and crawl those instead — this is
  // what lets an unattended deploy build succeed without hand-tuning.
  if (!titles.size && !args.category?.length) {
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
  const fetched = await client.fetchPages(wanted);

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
