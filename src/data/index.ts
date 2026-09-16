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

/**
 * Overlay wiki records onto curated ones.
 *
 * Curated strategy judgement (threat, answers, notes) always wins — that is
 * authored, not scraped. Wiki data fills descriptive gaps and contributes
 * entities we never curated, which arrive tagged `source: 'wiki'`.
 */
function overlay<T extends { id: string; name: string; source: string }>(
  curated: T[],
  fromWiki: Array<Omit<Partial<T>, 'id'> & { name: string; id?: string }> | undefined,
  protectedKeys: ReadonlyArray<keyof T>,
): T[] {
  if (!fromWiki?.length) return curated;
  const byId = new Map(curated.map((c) => [c.id, c]));
  const byName = new Map(curated.map((c) => [slug(c.name), c]));

  for (const w of fromWiki) {
    const key = w.id ?? slug(w.name);
    const existing = byId.get(key) ?? byName.get(slug(w.name));
    if (!existing) {
      byId.set(key, { ...(w as T), id: key, source: 'wiki' });
      continue;
    }
    for (const [k, v] of Object.entries(w) as Array<[keyof T, T[keyof T]]>) {
      if (protectedKeys.includes(k)) continue;
      if (v === undefined || v === null || v === '') continue;
      existing[k] = v;
    }
    existing.source = 'merged' as T['source'];
  }
  return [...byId.values()];
}

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

  const dataset: Dataset = {
    factions: overlay(factions, wiki?.factions, ['threat', 'vulnerability', 'opening', 'signatureTactics', 'id', 'side']),
    units: overlay(units, wiki?.units, ['answers', 'roles', 'factions', 'id', 'tier']),
    maps: overlay(maps, wiki?.maps, ['chokepoints', 'supplyDensity', 'openness', 'id']),
    matchups,
    provenance: {
      curatedAt: '2026-09-16',
      ...(wiki ? { wikiCache: { fetchedAt: wiki.fetchedAt, pages: wiki.pageCount, source: wiki.source } } : {}),
      ...(status ? { lastIngest: status } : {}),
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
