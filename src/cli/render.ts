import type { BattlePlan, Dataset } from '../types.js';
import { AXIS_LABEL } from '../engine/threat.js';

const ESC = String.fromCharCode(27);
const useColor = process.env['NO_COLOR'] === undefined && process.stdout.isTTY !== false;

const c = (code: string) => (s: string) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s);
export const bold = c('1');
export const dim = c('2');
export const red = c('31');
export const green = c('32');
export const yellow = c('33');
export const blue = c('36');
export const magenta = c('35');

const WIDTH = 74;

function rule(label?: string): string {
  if (!label) return dim('-'.repeat(WIDTH));
  const text = ` ${label} `;
  const left = 3;
  const right = Math.max(0, WIDTH - left - text.length);
  return dim('-'.repeat(left)) + bold(text) + dim('-'.repeat(right));
}

/** Wrap prose to the panel width, indenting continuation lines. */
function wrap(text: string, indent = 4): string[] {
  const width = Math.max(20, WIDTH - indent);
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width && line) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => ' '.repeat(indent) + l);
}

function bullet(text: string, marker = '*'): string {
  const lines = wrap(text, 4);
  if (!lines.length) return '';
  return [`  ${dim(marker)} ${lines[0]!.trimStart()}`, ...lines.slice(1).map((l) => '    ' + l.trimStart())].join('\n');
}

function numbered(text: string, n: number): string {
  const label = String(n).padStart(2, ' ');
  const lines = wrap(text, 6);
  return [`  ${blue(label)}. ${lines[0]!.trimStart()}`, ...lines.slice(1).map((l) => '      ' + l.trimStart())].join('\n');
}

function pressureBar(value: number): string {
  const filled = Math.round((Math.min(3, value) / 3) * 10);
  const bar = '#'.repeat(filled) + dim('.'.repeat(10 - filled));
  return value >= 2.4 ? red(bar) : value >= 1.6 ? yellow(bar) : green(bar);
}

export function renderPlan(plan: BattlePlan, ds: Dataset): string {
  const out: string[] = [];
  const diffColor = plan.difficulty === 'easy' ? green : plan.difficulty === 'medium' ? yellow : red;

  out.push('');
  out.push(bold(magenta('  BATTLE LINEUP')) + dim('  ·  Generals: Zero Hour skirmish planner'));
  out.push('');
  out.push(`  ${bold(green(plan.you.name))}  ${dim('vs')}  ${bold(red(plan.enemy.name))}`);
  const sub = [plan.map?.name, diffColor(plan.difficulty.toUpperCase())].filter(Boolean).join(dim(' · '));
  out.push(`  ${sub}`);
  if (plan.you.general) out.push(dim(`  You:  ${plan.you.general}`));
  if (plan.enemy.general) out.push(dim(`  Them: ${plan.enemy.general}`));
  out.push('');
  out.push(wrap(plan.headline, 2).join('\n'));
  out.push('');

  if (plan.lineupRationale?.length) {
    out.push(rule('WHY THIS LINEUP'));
    for (const r of plan.lineupRationale) out.push(bullet(r));
    const top = plan.lineupRanking?.slice(0, 5) ?? [];
    if (top.length) {
      out.push('');
      for (const t of top) {
        const score = String(t.score).padStart(3, ' ');
        out.push(`    ${dim(score)}  ${t.faction.name}`);
      }
    }
    out.push('');
  }

  out.push(rule('BUILD ORDER'));
  plan.buildOrder.forEach((step, i) => out.push(numbered(step, i + 1)));
  out.push('');

  out.push(rule('COUNTER THEIR GAME'));
  for (const counter of plan.counters) {
    out.push('');
    out.push(`  ${bold(AXIS_LABEL[counter.axis])} ${pressureBar(counter.pressure)} ${dim(counter.pressure.toFixed(1) + '/3')}`);
    for (const u of counter.units) {
      out.push(`    ${green('>')} ${bold(u.name)} ${dim(`(${u.cost}cr, ${u.tier})`)}`);
      out.push(wrap(u.why, 8).join('\n'));
    }
    out.push(dim(wrap('-> ' + counter.guidance, 4).join('\n')));
  }
  out.push('');

  out.push(rule('TIMELINE'));
  for (const phase of plan.timeline) {
    out.push('');
    out.push(`  ${bold(blue(phase.label))} ${dim(phase.window)}`);
    for (const o of phase.objectives) out.push(bullet(o));
  }
  out.push('');

  out.push(rule('WATCH FOR'));
  for (const w of plan.watchFor) out.push(bullet(w, '!'));
  out.push('');

  out.push(rule('DO NOT'));
  for (const d of plan.doNot) out.push(red(bullet(d, 'x')));
  out.push('');

  if (plan.matchupNotes.length) {
    out.push(rule('MATCHUP NOTES'));
    for (const n of plan.matchupNotes) out.push(bullet(n));
    out.push('');
  }

  out.push(rule(plan.map ? `MAP · ${plan.map.name.toUpperCase()}` : 'MAP'));
  for (const n of plan.mapNotes) out.push(bullet(n));
  out.push('');

  const prov = ds.provenance;
  const ing = prov.lastIngest;
  const wiki = prov.wikiCache
    ? `wiki cache ${prov.wikiCache.pages} pages from ${prov.wikiCache.source} (${prov.wikiCache.fetchedAt.slice(0, 10)})`
    : ing && !ing.ok
      ? `wiki crawl ${ing.attemptedAt.slice(0, 10)} failed - ${ing.error}`
      : 'no wiki crawl recorded - run `npm run ingest` to overlay live wiki data';
  out.push(dim(`  data: curated ${prov.curatedAt} · ${wiki}`));
  out.push('');

  return out.join('\n');
}

export function renderFactionList(ds: Dataset): string {
  const lines = ['', bold('  Playable armies'), ''];
  for (const side of ['usa', 'china', 'gla'] as const) {
    lines.push(`  ${bold(blue(side.toUpperCase()))}`);
    for (const f of ds.factions.filter((x) => x.side === side)) {
      lines.push(`    ${green(f.id.padEnd(16))} ${f.name}${f.general ? dim(` - ${f.general}`) : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function renderMapList(ds: Dataset): string {
  const lines = ['', bold('  Maps'), ''];
  for (const m of [...ds.maps].sort((a, b) => a.players - b.players || a.name.localeCompare(b.name))) {
    lines.push(`    ${green(m.id.padEnd(20))} ${m.name.padEnd(22)} ${dim(`${m.players}p · ${m.terrain}`)}`);
  }
  lines.push('');
  return lines.join('\n');
}
