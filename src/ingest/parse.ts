import type { GameMap, Unit, Faction } from '../types.js';
import type { WikiPage } from './wiki.js';

/** Turn wiki markup into something readable. */
export function stripMarkup(input: string): string {
  return input
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]|]+)\]\]/g, '$1')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/'''?/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull `| key = value` pairs out of the first infobox template on a page.
 * Brace-depth aware, so nested templates in a value do not end the scan early.
 */
export function parseInfobox(wikitext: string): Record<string, string> {
  const start = wikitext.search(/\{\{\s*[Ii]nfobox/);
  if (start === -1) return {};

  let depth = 0;
  let end = start;
  for (let i = start; i < wikitext.length - 1; i++) {
    if (wikitext.startsWith('{{', i)) { depth++; i++; continue; }
    if (wikitext.startsWith('}}', i)) {
      depth--;
      i++;
      if (depth === 0) { end = i + 1; break; }
    }
  }

  const body = wikitext.slice(start + 2, end - 2);
  const fields: Record<string, string> = {};

  // Split on pipes that are at depth zero relative to the infobox body.
  let buf = '';
  let d = 0;
  const parts: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (body.startsWith('{{', i) || body.startsWith('[[', i)) { d++; buf += body.slice(i, i + 2); i++; continue; }
    if (body.startsWith('}}', i) || body.startsWith(']]', i)) { d--; buf += body.slice(i, i + 2); i++; continue; }
    if (ch === '|' && d === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);

  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase().replace(/\s+/g, '_');
    const value = stripMarkup(part.slice(eq + 1));
    if (key && value) fields[key] = value;
  }
  return fields;
}

/**
 * Drop the templates at the top of an article.
 *
 * Brace-depth aware: a lazy regex stops at the first `}}`, which is usually a
 * template nested inside the infobox rather than the end of it.
 */
function stripLeadingTemplates(wikitext: string): string {
  let i = 0;
  for (;;) {
    while (i < wikitext.length && /\s/.test(wikitext[i]!)) i++;
    if (!wikitext.startsWith('{{', i)) break;
    let depth = 0;
    let j = i;
    for (; j < wikitext.length - 1; j++) {
      if (wikitext.startsWith('{{', j)) { depth++; j++; continue; }
      if (wikitext.startsWith('}}', j)) {
        depth--;
        j++;
        if (depth === 0) { j++; break; }
      }
    }
    if (depth !== 0) break;   // unbalanced: leave the rest alone
    i = j;
  }
  return wikitext.slice(i);
}

/** First real sentence of the article, for a description. */
export function leadSentence(wikitext: string): string | undefined {
  const withoutTemplates = stripLeadingTemplates(wikitext);
  const text = stripMarkup(withoutTemplates);
  const match = text.match(/^(.{20,400}?[.!?])(\s|$)/);
  return match?.[1] ?? (text.length > 20 ? text.slice(0, 300) : undefined);
}

const COST_KEYS = ['cost', 'price', 'build_cost', 'buildcost', 'cost_(zh)', 'cost_zh'];

export function parseCost(fields: Record<string, string>): number | undefined {
  for (const key of COST_KEYS) {
    const raw = fields[key];
    if (!raw) continue;
    const digits = raw.replace(/[,\s]/g, '').match(/\d{2,6}/);
    if (digits) return Number(digits[0]);
  }
  return undefined;
}

export type PageKind = 'unit' | 'faction' | 'map' | 'unknown';

// Wiki categories are almost always plural ("China vehicles", "GLA generals"),
// so these have to match plurals or nothing classifies by category at all.
const MAP_HINT = /\b(maps?|skirmish|multiplayer)\b/i;
const FACTION_HINT = /\b(factions?|generals?|army|armies|characters?)\b/i;
const UNIT_HINT = /\b(units?|vehicles?|infantry|aircrafts?|structures?|buildings?|tanks?|arsenal)\b/i;

/** Decide what a page is from its categories and infobox shape. */
export function classify(page: WikiPage, fields: Record<string, string>): PageKind {
  const cats = page.categories.join(' | ');
  if (MAP_HINT.test(cats) || fields['players'] || fields['max_players']) return 'map';
  if (FACTION_HINT.test(cats) && !UNIT_HINT.test(cats)) return 'faction';
  if (UNIT_HINT.test(cats) || fields['cost'] || fields['armor'] || fields['weapon']) return 'unit';
  return 'unknown';
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Wiki-derived faction records use a free-form id: the wiki knows pages, not our enum. */
export type WikiFaction = Omit<Partial<Faction>, 'id'> & { name: string; id?: string };

export interface ParsedPage {
  kind: PageKind;
  unit?: Partial<Unit> & { name: string };
  faction?: WikiFaction;
  map?: Partial<GameMap> & { name: string };
  raw: { title: string; fields: Record<string, string> };
}

/**
 * Convert one wiki page into whatever dataset records it can support.
 *
 * Deliberately conservative: it contributes facts (cost, prose, page link) and
 * never invents the strategy judgement that the curated dataset carries.
 */
export function parsePage(page: WikiPage): ParsedPage {
  const fields = parseInfobox(page.wikitext);
  const kind = classify(page, fields);
  const name = page.title;
  const description = leadSentence(page.wikitext);
  const wikiPage = page.title.replace(/ /g, '_');
  const raw = { title: page.title, fields };

  if (kind === 'unit') {
    const cost = parseCost(fields);
    return {
      kind, raw,
      unit: {
        id: slugify(name), name, wikiPage,
        ...(cost !== undefined ? { cost } : {}),
        ...(description ? { description } : {}),
      },
    };
  }

  if (kind === 'map') {
    const players = Number(fields['players'] ?? fields['max_players'] ?? '') || undefined;
    return {
      kind, raw,
      map: {
        id: slugify(name), name, wikiPage,
        ...(players ? { players } : {}),
        ...(description ? { description } : {}),
      },
    };
  }

  if (kind === 'faction') {
    return {
      kind, raw,
      faction: { id: slugify(name), name, wikiPage, ...(description ? { description } : {}) },
    };
  }

  return { kind, raw };
}
