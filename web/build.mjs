#!/usr/bin/env node
/**
 * Bake public/index.html: the compiled strategy engine plus the dataset, inlined
 * into a single self-contained page.
 *
 * The browser runs the same engine the CLI does — the modules in
 * dist/src/engine are free of Node imports precisely so this can concatenate
 * them instead of maintaining a second implementation.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from '../dist/src/data/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ENGINE_DIR = join(ROOT, 'dist', 'src', 'engine');

/** Dependency order matters: each file may only use names defined above it. */
const ENGINE_FILES = ['rng.js', 'threat.js', 'counters.js', 'doctrine.js', 'lineup.js', 'plan.js'];

/**
 * Flatten ES modules into one script scope.
 *
 * tsc's output is predictable here: every import is a single line at the top
 * of the file and every export is a leading keyword, so stripping them merges
 * the modules without a bundler. If that ever stops holding, the smoke check
 * at the bottom of this script fails loudly rather than shipping a broken page.
 */
function flatten(source) {
  return source
    .split('\n')
    .filter((line) => !/^import\s.*from\s+'.*';\s*$/.test(line))
    .filter((line) => !/^export\s*\{[^}]*\};\s*$/.test(line))
    .map((line) => line.replace(/^export\s+/, ''))
    .join('\n')
    .replace(/\/\/# sourceMappingURL=.*$/m, '')
    .trim();
}

const engine = ENGINE_FILES
  .map((file) => `/* --- engine/${file} --- */\n${flatten(readFileSync(join(ENGINE_DIR, file), 'utf8'))}`)
  .join('\n\n');

const dataset = loadDataset();

const template = readFileSync(join(HERE, 'template.html'), 'utf8');

// JSON inside a <script> must not be able to close the tag early.
const datasetLiteral = JSON.stringify(dataset).replace(/</g, '\\u003c');

const html = template
  .replace('/*__ENGINE__*/', () => engine)
  .replace('/*__DATASET__*/', () => datasetLiteral);

/*
 * Smoke check: actually run the bundle.
 *
 * This used to grep the bundle for three symbol names. That passed happily
 * while shipping a page whose first action threw `rankDoctrines is not
 * defined`, because a new engine module had been added to the source but not to
 * ENGINE_FILES — and no symbol on the list was the missing one. A name check
 * can only catch the breakage you already thought of, so instead we execute the
 * flattened engine against the real dataset and require a usable plan out of
 * it. A missing module, a broken flatten, or a runtime error in any engine file
 * now fails the build rather than the visitor's browser.
 */
function smokeTest(bundle, data) {
  const run = new Function(`${bundle}\nreturn { planFrom, AXIS_LABEL, mulberry32 };`);
  const api = run();
  for (const name of ['planFrom', 'AXIS_LABEL', 'mulberry32']) {
    if (!api[name]) throw new Error(`Engine bundle does not export ${name} — the flatten step needs updating.`);
  }

  // Exercise the paths the page actually takes: a pinned matchup, an
  // engine-chosen lineup, and a reroll of the same matchup.
  const cases = [
    { you: 'usa', enemy: 'china_tank', difficulty: 'hard', mapId: data.maps[0]?.id, seed: 1 },
    { enemy: 'gla_stealth', difficulty: 'brutal', seed: 2 },
    { difficulty: 'easy', seed: 3 },
  ];
  const seen = new Set();
  for (const input of cases) {
    const plan = api.planFrom(data, input);
    if (!plan?.buildOrder?.length) throw new Error(`Engine produced no build order for ${JSON.stringify(input)}`);
    if (!plan.counters?.length) throw new Error(`Engine produced no counters for ${JSON.stringify(input)}`);
    if (!plan.doctrine?.name) throw new Error(`Engine produced no approach for ${JSON.stringify(input)}`);
    seen.add(plan.doctrine.id);
  }

  // And that the seed still moves the plan, so a dead reroll cannot ship.
  const fixed = { you: 'china', enemy: 'usa_air', difficulty: 'hard' };
  const rolled = new Set();
  for (let seed = 0; seed < 24; seed++) {
    rolled.add(JSON.stringify(api.planFrom(data, { ...fixed, seed }).buildOrder));
  }
  if (rolled.size < 2) throw new Error('Reroll is inert: 24 seeds produced one build order.');

  return { approaches: seen.size, rerollVariants: rolled.size };
}

const smoke = smokeTest(engine, dataset);
if (html.includes('__ENGINE__') || html.includes('__DATASET__')) {
  throw new Error('Template placeholders were not substituted.');
}

// public/ is the static root Vercel serves, and the file the artifact publishes.
const outDir = join(ROOT, 'public');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'index.html');
writeFileSync(out, html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`Wrote ${out} (${kb} KB)`);
console.log(`  ${dataset.factions.length} armies, ${dataset.units.length} units, ${dataset.maps.length} maps`);
console.log(`  engine smoke: ${smoke.approaches} approaches across 3 plans, ${smoke.rerollVariants} build orders across 24 seeds`);
console.log(dataset.provenance.wikiCache
  ? `  wiki overlay: ${dataset.provenance.wikiCache.pages} pages from ${dataset.provenance.wikiCache.source}`
  : '  no wiki overlay baked in (run `npm run ingest` first to include one)');
