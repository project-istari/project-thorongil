import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDataset, unitsFor, factionById, mapById, overlay, ADMIT } from '../src/data/index.js';
import { AXES } from '../src/engine/threat.js';
import type { FactionId } from '../src/types.js';

const ds = loadDataset();

test('all twelve playable armies are present', () => {
  const expected: FactionId[] = [
    'usa', 'usa_air', 'usa_laser', 'usa_super',
    'china', 'china_tank', 'china_infantry', 'china_nuke',
    'gla', 'gla_toxin', 'gla_stealth', 'gla_demo',
  ];
  for (const id of expected) {
    assert.ok(factionById(id), `missing faction ${id}`);
  }
  assert.equal(ds.factions.filter((f) => expected.includes(f.id)).length, 12);
});

test('every faction scores on every threat axis', () => {
  for (const f of ds.factions) {
    for (const axis of AXES) {
      const v = f.threat[axis];
      assert.equal(typeof v, 'number', `${f.id} missing threat.${axis}`);
      assert.ok(v >= 0 && v <= 3, `${f.id}.${axis} out of range: ${v}`);
    }
  }
});

test('faction ids and unit ids are unique', () => {
  const fids = ds.factions.map((f) => f.id);
  assert.equal(new Set(fids).size, fids.length, 'duplicate faction id');
  const uids = ds.units.map((u) => u.id);
  assert.equal(new Set(uids).size, uids.length, 'duplicate unit id');
});

test('every unit belongs to at least one real faction', () => {
  const known = new Set(ds.factions.map((f) => f.id));
  for (const u of ds.units) {
    assert.ok(u.factions.length > 0, `${u.id} has no faction`);
    for (const f of u.factions) {
      assert.ok(known.has(f), `${u.id} references unknown faction ${f}`);
    }
  }
});

test('every army has a usable roster', () => {
  for (const f of ds.factions) {
    const roster = unitsFor(f.id);
    assert.ok(roster.length >= 10, `${f.id} only has ${roster.length} units`);
    assert.ok(roster.some((u) => u.tier === 'early'), `${f.id} has no early-game units`);
  }
});

test('unit answers reference real axes and sane weights', () => {
  const axes = new Set<string>(AXES);
  for (const u of ds.units) {
    assert.ok(u.cost > 0, `${u.id} has no cost`);
    assert.ok(u.note.length > 10, `${u.id} has no useful note`);
    for (const [axis, weight] of Object.entries(u.answers)) {
      assert.ok(axes.has(axis), `${u.id} answers unknown axis ${axis}`);
      assert.ok(weight >= 1 && weight <= 3, `${u.id}.${axis} weight ${weight} out of range`);
    }
  }
});

test('every army can answer air and armour somehow', () => {
  // A faction with literally no answer to the two most common threats would
  // produce an empty counter list, which is a dataset bug rather than a
  // strategic statement.
  for (const f of ds.factions) {
    const roster = unitsFor(f.id);
    for (const axis of ['air', 'armor'] as const) {
      assert.ok(
        roster.some((u) => (u.answers[axis] ?? 0) >= 2),
        `${f.id} has no real answer to ${axis}`,
      );
    }
  }
});

test('maps carry the ratings the engine reads', () => {
  assert.ok(ds.maps.length > 0);
  for (const m of ds.maps) {
    for (const key of ['chokepoints', 'supplyDensity', 'openness'] as const) {
      assert.ok(m[key] >= 0 && m[key] <= 3, `${m.id}.${key} out of range`);
    }
    assert.ok(m.players >= 2, `${m.id} has ${m.players} players`);
  }
});

test('maps are findable by id and by name', () => {
  const first = ds.maps[0]!;
  assert.equal(mapById(first.id)?.id, first.id);
  assert.equal(mapById(first.name)?.id, first.id);
  assert.equal(mapById('no-such-map'), undefined);
});

test('matchup selectors resolve to something real', () => {
  const fids = new Set<string>(ds.factions.map((f) => f.id));
  const sides = new Set(['usa', 'china', 'gla']);
  for (const m of ds.matchups) {
    for (const sel of [m.you, m.enemy]) {
      assert.ok(sel === '*' || fids.has(sel) || sides.has(sel), `unknown selector ${sel}`);
    }
    assert.ok(m.advice.length > 0, 'matchup with no advice');
  }
});

test('provenance always states where the data came from', () => {
  const p = ds.provenance;
  assert.match(p.curatedAt, /^\d{4}-\d{2}-\d{2}$/);
  // A crawl record is optional, but if present it must be self-describing:
  // a failed attempt has to carry a reason, a successful one a page count.
  if (p.lastIngest) {
    assert.equal(typeof p.lastIngest.ok, 'boolean');
    assert.ok(p.lastIngest.source.length > 0);
    assert.match(p.lastIngest.attemptedAt, /^\d{4}-\d{2}-\d{2}T/);
    if (p.lastIngest.ok) assert.equal(typeof p.lastIngest.pages, 'number');
    else assert.ok((p.lastIngest.error ?? '').length > 0, 'a failed crawl must say why');
  }
  if (p.wikiCache) assert.ok(p.wikiCache.pages >= 0);
});

// --- overlay admission ---------------------------------------------------
// cnc.fandom.com covers every C&C game, so a crawl returns Tiberium and Red
// Alert pages. Admitting those as armies gave the planner factions with no
// threat profile, which crashed it and left the page blank.

type Rec = { id: string; name: string; source: string; wikiPage?: string; cost?: number };

test('overlay enriches a curated record matched by wiki page title', () => {
  const curated: Rec[] = [{ id: 'overlord', name: 'Overlord', source: 'curated', wikiPage: 'Overlord_Tank', cost: 2000 }];
  const result = overlay(
    curated,
    [{ name: 'Overlord Tank', wikiPage: 'Overlord_Tank', cost: 2200 }],
    ['id'],
    ADMIT.unit,
  );
  assert.equal(result.records.length, 1, 'must not duplicate the record');
  assert.equal(result.enriched, 1);
  assert.equal(result.rejected, 0);
  assert.equal(result.records[0]!.cost, 2200, 'wiki cost should win');
  assert.equal(result.records[0]!.source, 'merged');
});

test('overlay refuses foreign wiki entities instead of injecting them', () => {
  const curated: Rec[] = [{ id: 'overlord', name: 'Overlord', source: 'curated', wikiPage: 'Overlord_Tank' }];
  const foreign = [
    { name: 'Mammoth Tank', wikiPage: 'Mammoth_Tank', cost: 1500 },
    { name: 'Kirov Airship', wikiPage: 'Kirov_Airship' },
  ];

  const asFactions = overlay(curated, foreign, ['id'], ADMIT.faction);
  assert.equal(asFactions.records.length, 1, 'no wiki page may become a thirteenth army');
  assert.equal(asFactions.rejected, 2);

  // Units need the full engine contract, which scraped prose cannot supply.
  const asUnits = overlay(curated, foreign, ['id'], ADMIT.unit);
  assert.equal(asUnits.records.length, 1);
  assert.equal(asUnits.rejected, 2);
});

test('overlay admits a wiki record that does carry the engine contract', () => {
  const curated: Rec[] = [];
  const complete = [{
    name: 'Complete Unit', wikiPage: 'Complete_Unit', cost: 800, tier: 'early',
    factions: ['usa'], roles: ['anti_air'], answers: { air: 3 },
  }];
  const result = overlay(curated as never[], complete as never[], ['id'], ADMIT.unit);
  assert.equal(result.records.length, 1, 'a fully specified record is still welcome');
  assert.equal(result.rejected, 0);
  assert.equal((result.records[0] as unknown as { source: string }).source, 'wiki');
});

test('the loaded dataset can never grow a thirteenth army', () => {
  assert.equal(ds.factions.length, 12, `expected 12 armies, got ${ds.factions.length}`);
  for (const f of ds.factions) {
    assert.ok(f.threat, `${f.id} has no threat profile`);
    assert.ok(['usa', 'china', 'gla'].includes(f.side), `${f.id} has no valid side`);
  }
});
