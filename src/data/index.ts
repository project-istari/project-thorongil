import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Dataset, Faction, GameMap, IngestStatus, MatchupNote, Unit } from '../types.js';

/** Walk up from this module until we find the package root. */
function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate package root from ' + import.meta.url);
}

const ROOT = findRoot();
const DATA_DIR = join(ROOT, 'data');
const CURATED = join(DATA_DIR, 'curated');
const WIKI_CACHE = join(DATA_DIR, 'wiki-cache');
const INGEST_STATUS = join(DATA_DIR, 'ingest-status.json');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * Shape written by `npm run ingest`. Everything is optional because a partial
 * crawl is still useful — we overlay whatever arrived.
 */
export interface WikiCache {
  fetchedAt: string;
  source: string;
  pageCount: number;
  factions?: Array<Omit<Partial<Faction>, 'id'> & { id?: string; name: string }>;
  units?: Array<Partial<Unit> & { id?: string; name: string }>;
  maps?: Array<Partial<GameMap> & { id?: string; name: string }>;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Normalised wiki page key, so "Overlord_Tank" and "Overlord Tank" agree. */
function pageKey(page: string | undefined): string | undefined {
  return page ? slug(page) : undefined;
}

/**
 * Overlay wiki records onto curated ones.
 *
 * Two rules, both learned the hard way from a real crawl.
 *
 * 1. Curated strategy judgement (threat, answers, notes) always wins — it is
 *    authored, not scraped. The wiki fills descriptive gaps only.
 * 2. A wiki record that does not match a curated one is **rejected** unless it
 *    satisfies everything the engine needs. cnc.fandom.com covers every C&C
 *    game, so a crawl returns Tiberium and Red Alert pages; admitting those as
 *    armies gave the planner factions with no threat profile, which crashed it.
 *    Nothing the wiki can currently produce clears that bar, which is the point:
 *    enrichment is safe, injection is not.
 */
export function overlay<T extends { id: string; name: string; source: string; wikiPage?: string }>(
  curated: T[],
  fromWiki: Array<Omit<Partial<T>, 'id'> & { name: string; id?: string }> | undefined,
  protectedKeys: ReadonlyArray<keyof T>,
  admit: (candidate: Record<string, unknown>) => boolean,
): { records: T[]; enriched: number; rejected: number } {
  if (!fromWiki?.length) return { records: curated, enriched: 0, rejected: 0 };

  const byPage = new Map<string, T>();
  const byId = new Map(curated.map((c) => [c.id, c]));
  const byName = new Map(curated.map((c) => [slug(c.name), c]));
  for (const c of curated) {
    const key = pageKey(c.wikiPage);
    if (key) byPage.set(key, c);
  }

  const added: T[] = [];
  let enriched = 0;
  let rejected = 0;

  for (const w of fromWiki) {
    // Page title is the most reliable join: curated records carry the exact
    // page they correspond to, and the crawler reports the page it read.
    const existing =
      byPage.get(pageKey(w.wikiPage as string | undefined) ?? '\u0000') ??
      byId.get(w.id ?? slug(w.name)) ??
      byName.get(slug(w.name));

    if (!existing) {
      if (admit(w as Record<string, unknown>)) {
        added.push({ ...(w as unknown as T), id: w.id ?? slug(w.name), source: 'wiki' });
      } else {
        rejected++;
      }
      continue;
    }

    for (const [k, v] of Object.entries(w) as Array<[keyof T, T[keyof T]]>) {
      if (protectedKeys.includes(k)) continue;
      if (v === undefined || v === null || v === '') continue;
      existing[k] = v;
    }
    existing.source = 'merged' as T['source'];
    enriched++;
  }

  return { records: [...curated, ...added], enriched, rejected };
}

/**
 * Admission rules: what a wiki-only record must carry to be safe for the engine.
 * The faction list is a closed set of twelve, so nothing is ever admitted there.
 */
export const ADMIT = {
  faction: () => false,
  unit: (c: Record<string, unknown>) =>
    Array.isArray(c['factions']) && c['factions'].length > 0 &&
    Array.isArray(c['roles']) &&
    typeof c['answers'] === 'object' && c['answers'] !== null &&
    typeof c['tier'] === 'string' && typeof c['cost'] === 'number',
  map: (c: Record<string, unknown>) =>
    typeof c['players'] === 'number' &&
    typeof c['chokepoints'] === 'number' &&
    typeof c['supplyDensity'] === 'number' &&
    typeof c['openness'] === 'number',
} as const;

function latestWikiCache(): WikiCache | undefined {
  if (!existsSync(WIKI_CACHE)) return undefined;
  const files = readdirSync(WIKI_CACHE).filter((f) => f.endsWith('.json')).sort();
  const newest = files.at(-1);
  if (!newest) return undefined;
  try {
    return readJson<WikiCache>(join(WIKI_CACHE, newest));
  } catch {
    return undefined;
  }
}

function lastIngestStatus(): IngestStatus | undefined {
  if (!existsSync(INGEST_STATUS)) return undefined;
  try {
    return readJson<IngestStatus>(INGEST_STATUS);
  } catch {
    return undefined;   // a corrupt status file must never break a build
  }
}

let cached: Dataset | undefined;

export function loadDataset(): Dataset {
  if (cached) return cached;

  const factions = readJson<Faction[]>(join(CURATED, 'factions.json'));
  const units = readJson<Unit[]>(join(CURATED, 'units.json'));
  const maps = readJson<GameMap[]>(join(CURATED, 'maps.json'));
  const matchups = readJson<MatchupNote[]>(join(CURATED, 'matchups.json'));

  const wiki = latestWikiCache();
  const status = lastIngestStatus();

  // `name` is protected alongside the judgement fields. The wiki's title casing
  // differs from ours ("Sentry drone" vs "Sentry Drone"), and the curated name
  // is the vocabulary the authored build orders, matchup notes and counter
  // guidance all speak — letting a crawl rewrite it silently desynchronises the
  // advice from the units it names.
  const f = overlay(factions, wiki?.factions, ['threat', 'vulnerability', 'opening', 'signatureTactics', 'id', 'side', 'name'], ADMIT.faction);
  const u = overlay(units, wiki?.units, ['answers', 'roles', 'factions', 'id', 'tier', 'name'], ADMIT.unit);
  const m = overlay(maps, wiki?.maps, ['chokepoints', 'supplyDensity', 'openness', 'id', 'name'], ADMIT.map);

  const dataset: Dataset = {
    factions: f.records,
    units: u.records,
    maps: m.records,
    matchups,
    provenance: {
      curatedAt: '2026-09-16',
      ...(wiki ? { wikiCache: { fetchedAt: wiki.fetchedAt, pages: wiki.pageCount, source: wiki.source } } : {}),
      ...(status ? { lastIngest: status } : {}),
      ...(wiki
        ? {
            overlay: {
              enriched: f.enriched + u.enriched + m.enriched,
              rejected: f.rejected + u.rejected + m.rejected,
            },
          }
        : {}),
    },
  };

  cached = dataset;
  return dataset;
}

export function factionById(id: string): Faction | undefined {
  return loadDataset().factions.find((f) => f.id === id);
}

export function unitsFor(factionId: string): Unit[] {
  return loadDataset().units.filter((u) => u.factions?.includes(factionId as Faction["id"]));
}

export function mapById(id: string): GameMap | undefined {
  const ds = loadDataset();
  return ds.maps.find((m) => m.id === id) ?? ds.maps.find((m) => slug(m.name) === slug(id));
}

export { ROOT, DATA_DIR, CURATED, WIKI_CACHE, INGEST_STATUS, slug };
