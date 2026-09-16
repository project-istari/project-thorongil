import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDataset, unitsFor, factionById, mapById } from '../src/data/index.js';
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
