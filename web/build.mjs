#!/usr/bin/env node
/**
 * Bake web/index.html: the compiled strategy engine plus the dataset, inlined
 * into a single self-contained page.
 *
 * The browser runs the same engine the CLI does — the modules in
 * dist/src/engine are free of Node imports precisely so this can concatenate
 * them instead of maintaining a second implementation.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from '../dist/src/data/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ENGINE_DIR = join(ROOT, 'dist', 'src', 'engine');

/** Dependency order matters: each file may only use names defined above it. */
const ENGINE_FILES = ['rng.js', 'threat.js', 'counters.js', 'lineup.js', 'plan.js'];

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

// Smoke check: the flattened bundle must still define the entry points the page calls.
for (const symbol of ['function planFrom', 'const AXIS_LABEL', 'function mulberry32']) {
  if (!engine.includes(symbol)) {
    throw new Error(`Engine bundle is missing "${symbol}" — the flatten step needs updating.`);
  }
}
if (html.includes('__ENGINE__') || html.includes('__DATASET__')) {
  throw new Error('Template placeholders were not substituted.');
}

const out = join(HERE, 'index.html');
writeFileSync(out, html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`Wrote ${out} (${kb} KB)`);
console.log(`  ${dataset.factions.length} armies, ${dataset.units.length} units, ${dataset.maps.length} maps`);
console.log(dataset.provenance.wikiCache
  ? `  wiki overlay: ${dataset.provenance.wikiCache.pages} pages from ${dataset.provenance.wikiCache.source}`
  : '  no wiki overlay baked in (run `npm run ingest` first to include one)');
