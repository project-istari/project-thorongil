import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInfobox, stripMarkup, parseCost, leadSentence, classify, parsePage, slugify, isDisambiguation, disambiguationLinks } from '../src/ingest/parse.js';
import type { WikiPage } from '../src/ingest/wiki.js';

const SAMPLE: WikiPage = {
  pageid: 1,
  title: 'Overlord Tank',
  categories: ['China vehicles', 'Zero Hour units'],
  wikitext: `{{Infobox unit
| name = Overlord Tank
| faction = [[China (Generals)|China]]
| cost = 2,000
| armor = Heavy
| weapon = {{Tooltip|120mm cannon|dual barrel}}
| role = Heavy assault
}}
The '''Overlord Tank''' is the heaviest armoured vehicle fielded by the [[People's Liberation Army]].<ref>manual</ref> It can mount additional weaponry.`,
};

test('stripMarkup removes links, templates, refs and bold markers', () => {
  assert.equal(stripMarkup("[[China (Generals)|China]]"), 'China');
  assert.equal(stripMarkup("[[Overlord]]"), 'Overlord');
  assert.equal(stripMarkup("'''bold'''"), 'bold');
  assert.equal(stripMarkup('text<ref>a source</ref> more'), 'text more');
  assert.equal(stripMarkup('a {{template|x}} b'), 'a b');
  assert.equal(stripMarkup('<!-- hidden -->visible'), 'visible');
});

test('parseInfobox reads key/value pairs', () => {
  const fields = parseInfobox(SAMPLE.wikitext);
  assert.equal(fields['name'], 'Overlord Tank');
  assert.equal(fields['faction'], 'China');
  assert.equal(fields['cost'], '2,000');
  assert.equal(fields['role'], 'Heavy assault');
});

test('parseInfobox is not confused by nested templates in a value', () => {
  const fields = parseInfobox(SAMPLE.wikitext);
  // The nested {{Tooltip|...}} must not terminate the scan or leak into later keys.
  assert.ok('role' in fields, 'keys after a nested template were lost');
  assert.ok(!(fields['weapon'] ?? '').includes('}}'));
});

test('parseInfobox returns nothing when there is no infobox', () => {
  assert.deepEqual(parseInfobox('Just prose, no template here.'), {});
});

test('parseCost handles thousands separators and alternate keys', () => {
  assert.equal(parseCost({ cost: '2,000' }), 2000);
  assert.equal(parseCost({ build_cost: '$1500' }), 1500);
  assert.equal(parseCost({ price: '900 credits' }), 900);
  assert.equal(parseCost({ unrelated: '5' }), undefined);
  assert.equal(parseCost({}), undefined);
});

test('leadSentence extracts the opening sentence without markup', () => {
  const lead = leadSentence(SAMPLE.wikitext);
  assert.ok(lead, 'expected a lead sentence');
  assert.ok(lead.startsWith('The Overlord Tank is the heaviest'), lead);
  assert.ok(!lead.includes('['), 'markup leaked into the description');
  assert.ok(!lead.includes('manual'), 'reference text leaked into the description');
});

test('classify separates units, maps and factions', () => {
  assert.equal(classify(SAMPLE, parseInfobox(SAMPLE.wikitext)), 'unit');

  const map: WikiPage = { pageid: 2, title: 'Tournament Desert', categories: ['Generals maps'], wikitext: '' };
  assert.equal(classify(map, { players: '2' }), 'map');

  const faction: WikiPage = { pageid: 3, title: 'Prince Kassad', categories: ['Generals characters', 'GLA generals'], wikitext: '' };
  assert.equal(classify(faction, {}), 'faction');

  const other: WikiPage = { pageid: 4, title: 'Some Lore Page', categories: ['Lore'], wikitext: '' };
  assert.equal(classify(other, {}), 'unknown');
});

test('parsePage produces a mergeable unit record', () => {
  const parsed = parsePage(SAMPLE);
  assert.equal(parsed.kind, 'unit');
  assert.equal(parsed.unit?.name, 'Overlord Tank');
  assert.equal(parsed.unit?.id, 'overlord_tank');
  assert.equal(parsed.unit?.cost, 2000);
  assert.equal(parsed.unit?.wikiPage, 'Overlord_Tank');
  assert.ok(parsed.unit?.description);
  // Strategy judgement is never scraped.
  assert.equal(parsed.unit?.answers, undefined);
  assert.equal(parsed.unit?.roles, undefined);
});

test('parsePage survives an empty page', () => {
  const empty: WikiPage = { pageid: 9, title: 'Blank', categories: [], wikitext: '' };
  const parsed = parsePage(empty);
  assert.equal(parsed.kind, 'unknown');
  assert.equal(parsed.raw.title, 'Blank');
});

test('slugify matches the ids used in the curated dataset', () => {
  assert.equal(slugify('Overlord Tank'), 'overlord_tank');
  assert.equal(slugify("Gen. Rodall \"Demo\" Juhziz"), 'gen_rodall_demo_juhziz');
  assert.equal(slugify('  Spaced  Out  '), 'spaced_out');
});

/* ---------------------------------------------------------------------------
 * The wiki this crawler actually targets does not use {{Infobox}}. Its unit
 * pages open with {{UnitBox}}, behind a couple of navigation templates, and its
 * plain-name pages are usually disambiguation stubs. These cases are all taken
 * from live cnc.fandom.com markup.
 * ------------------------------------------------------------------------ */

const UNITBOX: WikiPage = {
  pageid: 20,
  title: 'Ranger (Generals)',
  categories: ['Generals 1 American arsenal'],
  wikitext: `{{Games|Gen|ZH}}
{{For|the Red Alert 1 vehicle of the same name|Ranger (Red Alert)}}
{{UnitBox
|name         = Ranger
|image        = Generals_Ranger.jpg
|faction      =
* {{Subfaction|USA|G1}}
|role         = Basic infantry
|cost         = $225
|hp           = 180
}}
The '''Ranger''' is the USA's basic infantry unit.`,
};

test('parseInfobox reads {{UnitBox}}, not just {{Infobox}}', () => {
  const fields = parseInfobox(UNITBOX.wikitext);
  assert.equal(fields['cost'], '$225');
  assert.equal(fields['role'], 'Basic infantry');
  assert.equal(parseCost(fields), 225);
});

test('parseInfobox skips navigation templates ahead of the infobox', () => {
  // {{Games}} and {{For}} precede the real box; matching the first template
  // outright would read the wrong one and find no fields at all.
  const fields = parseInfobox(UNITBOX.wikitext);
  assert.ok(!('gen' in fields), 'read the {{Games}} navigation template');
  assert.equal(fields['name'], 'Ranger');
});

test('parseInfobox still ignores templates that are not infoboxes', () => {
  assert.deepEqual(parseInfobox('{{Games|Gen|ZH}}\nJust prose.'), {});
  assert.deepEqual(parseInfobox('{{For|something|Other page}}'), {});
});

test('parsePage carries the wiki image onto the record', () => {
  const withImage: WikiPage = { ...UNITBOX, image: 'https://static.example/Ranger.jpg' };
  assert.equal(parsePage(withImage).unit?.image, 'https://static.example/Ranger.jpg');
  // Absent on a page the wiki has no image for, rather than an empty string.
  assert.equal(parsePage(UNITBOX).unit?.image, undefined);
});

test('parsePage joins on the requested title, not the redirect target', () => {
  // The curated dataset asked for "Crusader_Tank"; the wiki redirected us to
  // "Crusader tank". Reporting the target would break the reconciliation join.
  const redirected: WikiPage = { ...UNITBOX, title: 'Crusader tank', requestedTitle: 'Crusader Tank' };
  assert.equal(parsePage(redirected).unit?.wikiPage, 'Crusader_Tank');
});

test('isDisambiguation spots stub pages by template and by category', () => {
  const byTemplate: WikiPage = {
    pageid: 21, title: 'Ranger', categories: [],
    wikitext: '{{Disambig}}\n\n* [[Ranger (Generals)]]',
  };
  const byCategory: WikiPage = {
    pageid: 22, title: 'Overlord', categories: ['Disambiguation pages'], wikitext: '',
  };
  assert.equal(isDisambiguation(byTemplate), true);
  assert.equal(isDisambiguation(byCategory), true);
  assert.equal(isDisambiguation(UNITBOX), false);
});

test('disambiguationLinks resolves {{PAGENAME}} and skips namespaced links', () => {
  const stub: WikiPage = {
    pageid: 23, title: 'Ranger', categories: [],
    wikitext: `{{Disambig}}
'''{{PAGENAME}}''' can refer to:
* [[{{PAGENAME}} (Red Alert)]] - an Allied vehicle.
* [[{{PAGENAME}} (Generals)]] - the USA's basic infantry.
[[Category:Disambiguation pages]]`,
  };
  const links = disambiguationLinks(stub);
  assert.deepEqual(links, ['Ranger (Red Alert)', 'Ranger (Generals)']);
  assert.ok(!links.some((l) => l.startsWith('Category:')), 'category link leaked in');
});
