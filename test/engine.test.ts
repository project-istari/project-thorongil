import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDataset, factionById, unitsFor, mapById } from '../src/data/index.js';
import { AXES, PRESSURE_CEILING, enemyThreatProfile, rankedAxes } from '../src/engine/threat.js';
import { recommendCounters, coverage } from '../src/engine/counters.js';
import { rankLineups, calibrate } from '../src/engine/lineup.js';
import { generatePlan } from '../src/index.js';
import type { Difficulty, RoleTag } from '../src/types.js';

const ds = loadDataset();
const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard', 'brutal'];

test('threat profiles stay inside the pressure ceiling for every army and difficulty', () => {
  for (const f of ds.factions) {
    for (const d of DIFFICULTIES) {
      for (const m of [undefined, ...ds.maps]) {
        const p = enemyThreatProfile(f, d, m);
        for (const axis of AXES) {
          assert.ok(p[axis] >= 0 && p[axis] <= PRESSURE_CEILING, `${f.id}/${d}/${m?.id}: ${axis}=${p[axis]}`);
        }
      }
    }
  }
});

test('harder difficulty means more early pressure', () => {
  const tank = factionById('china_tank')!;
  const easy = enemyThreatProfile(tank, 'easy').early_rush;
  const medium = enemyThreatProfile(tank, 'medium').early_rush;
  const hard = enemyThreatProfile(tank, 'hard').early_rush;
  assert.ok(easy < medium, `easy ${easy} should be below medium ${medium}`);
  assert.ok(medium < hard, `medium ${medium} should be below hard ${hard}`);
});

test('choked maps raise siege pressure, open maps raise armour pressure', () => {
  const china = factionById('china')!;
  const choked = mapById('alpine_assault')!;   // chokepoints 3, openness 1
  const open = mapById('tournament_desert')!;  // chokepoints 1, openness 3

  const chokedProfile = enemyThreatProfile(china, 'medium', choked);
  const openProfile = enemyThreatProfile(china, 'medium', open);

  assert.ok(chokedProfile.artillery > openProfile.artillery, 'artillery should matter more on a choked map');
  assert.ok(openProfile.armor > chokedProfile.armor, 'armour should matter more on open ground');
});

test('the GLA never projects air pressure', () => {
  for (const id of ['gla', 'gla_toxin', 'gla_stealth', 'gla_demo'] as const) {
    const f = factionById(id)!;
    for (const d of DIFFICULTIES) {
      assert.equal(enemyThreatProfile(f, d).air, 0, `${id} should have no aircraft`);
    }
  }
});

test('reported counter pressure is normalised back to the 0-3 scale', () => {
  // Profiles keep headroom above 3 so difficulty ordering survives; anything
  // user-facing has to come back down to the scale the labels claim.
  for (const enemy of ds.factions) {
    for (const d of DIFFICULTIES) {
      const plan = generatePlan({ you: 'usa', enemy: enemy.id, difficulty: d });
      for (const c of plan.counters) {
        assert.ok(c.pressure >= 0 && c.pressure <= 3, `${enemy.id}/${d}: pressure ${c.pressure}`);
      }
    }
  }
});

test('counters answer the axes the enemy actually presses', () => {
  const you = factionById('gla')!;
  const enemy = factionById('usa_air')!;
  const profile = enemyThreatProfile(enemy, 'hard');
  const counters = recommendCounters(you, unitsFor(you.id), profile);

  const air = counters.find((c) => c.axis === 'air');
  assert.ok(air, 'air should be a top axis against the Air Force General');
  assert.ok(air.units.length > 0, 'GLA should have an answer to aircraft');
  assert.ok(
    air.units.some((u) => /Quad Cannon|Stinger/.test(u.name)),
    `expected GLA AA, got ${air.units.map((u) => u.name).join(', ')}`,
  );
});

test('stealth armies produce a detector recommendation', () => {
  for (const [youId, detector] of [
    ['usa', /Sentry Drone/],
    ['china', /Listening Outpost/],
    ['gla', /Radar Van/],
  ] as const) {
    const you = factionById(youId)!;
    const profile = enemyThreatProfile(factionById('gla_stealth')!, 'hard');
    const counters = recommendCounters(you, unitsFor(you.id), profile);
    const stealth = counters.find((c) => c.axis === 'stealth');
    assert.ok(stealth, `${youId}: stealth should rank against Kassad`);
    assert.ok(
      stealth.units.some((u) => detector.test(u.name)),
      `${youId}: expected ${detector}, got ${stealth.units.map((u) => u.name).join(', ')}`,
    );
  }
});

test('coverage rewards having an answer at all', () => {
  const gla = unitsFor('gla');
  assert.ok(coverage(gla, 'air') >= 2, 'GLA has Quad Cannons and Stinger Sites');
  const airForce = unitsFor('usa_air');
  assert.ok(coverage(airForce, 'armor') >= 2, 'Air Force answers armour from the air');
});

test('lineup scores spread out instead of saturating', () => {
  // A regression guard: an earlier calibration pushed every army to 100.
  for (const enemy of ds.factions) {
    const profile = enemyThreatProfile(enemy, 'medium');
    const ranked = rankLineups(ds.factions, unitsFor, enemy, profile);
    const scores = ranked.map((r) => r.score);
    const spread = Math.max(...scores) - Math.min(...scores);
    assert.ok(spread >= 10, `vs ${enemy.id}: scores only spread ${spread} points`);
    assert.ok(Math.max(...scores) < 100, `vs ${enemy.id}: top score saturated`);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'ranking is not sorted');
  }
});

test('calibrate clamps to 0-100', () => {
  assert.equal(calibrate(-500), 0);
  assert.equal(calibrate(5000), 100);
  assert.ok(calibrate(42) > 40 && calibrate(42) < 70);
});

test('rankedAxes returns axes strongest first', () => {
  const profile = enemyThreatProfile(factionById('china_tank')!, 'hard');
  const axes = rankedAxes(profile);
  for (let i = 1; i < axes.length; i++) {
    assert.ok(profile[axes[i - 1]!] >= profile[axes[i]!], 'axes out of order');
  }
});

test('a plan can be generated for every matchup, difficulty and map', () => {
  for (const you of ds.factions) {
    for (const enemy of ds.factions) {
      for (const d of DIFFICULTIES) {
        const plan = generatePlan({ you: you.id, enemy: enemy.id, difficulty: d });
        assert.ok(plan.buildOrder.length >= 4, `${you.id} vs ${enemy.id}: thin build order`);
        assert.ok(plan.counters.length > 0, `${you.id} vs ${enemy.id}: no counters`);
        assert.ok(plan.timeline.length === 3);
        assert.ok(plan.doNot.length > 0);
        assert.ok(plan.headline.includes(you.name));
      }
    }
  }
});

test('every counter recommendation names at least one unit or explains why not', () => {
  for (const you of ds.factions) {
    for (const enemy of ds.factions) {
      const plan = generatePlan({ you: you.id, enemy: enemy.id, difficulty: 'hard' });
      for (const c of plan.counters) {
        assert.ok(
          c.units.length > 0 || c.guidance.includes('no clean answer'),
          `${you.id} vs ${enemy.id}: empty counter for ${c.axis} without explanation`,
        );
      }
    }
  }
});

test('omitting your side makes the engine choose and explain', () => {
  const plan = generatePlan({ enemy: 'china_tank', difficulty: 'hard' });
  assert.ok(plan.lineupRationale?.length, 'should explain the pick');
  assert.equal(plan.lineupRanking?.length, ds.factions.length);
  assert.equal(plan.lineupRanking?.[0]?.faction.id, plan.you.id, 'should pick the top-ranked army');
});

test('the same seed always gives the same matchup', () => {
  const a = generatePlan({ difficulty: 'medium', seed: 99 });
  const b = generatePlan({ difficulty: 'medium', seed: 99 });
  const c = generatePlan({ difficulty: 'medium', seed: 100 });
  assert.equal(a.enemy.id, b.enemy.id);
  assert.equal(a.you.id, b.you.id);
  assert.ok([a.enemy.id, c.enemy.id].length === 2);
});

test('unknown inputs fail loudly', () => {
  assert.throws(() => generatePlan({ you: 'nope', difficulty: 'medium' }), /Unknown faction/);
  assert.throws(() => generatePlan({ enemy: 'nope', difficulty: 'medium' }), /Unknown faction/);
  assert.throws(() => generatePlan({ difficulty: 'medium', mapId: 'nope' }), /Unknown map/);
});

test('a chosen map contributes map-specific advice', () => {
  const withMap = generatePlan({ you: 'usa', enemy: 'gla', difficulty: 'medium', mapId: 'alpine_assault' });
  const withoutMap = generatePlan({ you: 'usa', enemy: 'gla', difficulty: 'medium' });
  assert.ok(withMap.map, 'map should be attached');
  assert.notDeepEqual(withMap.mapNotes, withoutMap.mapNotes);
  assert.ok(withoutMap.mapNotes.join(' ').includes('No map selected'));
});

test('matchup notes fire on both faction and side selectors', () => {
  const plan = generatePlan({ you: 'usa_laser', enemy: 'gla_stealth', difficulty: 'medium' });
  const text = plan.matchupNotes.join(' ');
  assert.ok(text.includes('no aircraft'), 'side-level GLA note should fire');
  assert.ok(/detector/i.test(text), 'faction-level Kassad note should fire');
});

/* ---------------------------------------------------------------------------
 * Strategic diversity.
 *
 * The planner used to emit exactly one plan per matchup: every selection was a
 * sort followed by [0], so the seed changed nothing unless it happened to pick
 * the enemy. Seven seeds on a pinned matchup produced one plan.
 * ------------------------------------------------------------------------ */

const SEEDS = [1, 2, 3, 42, 999, 123456, 7777777];

test('rerolling a pinned matchup produces materially different plans', () => {
  const plans = SEEDS.map((seed) =>
    generatePlan({ you: 'usa', enemy: 'china_tank', difficulty: 'hard', mapId: 'winding_river', seed }));
  const shapes = new Set(plans.map((p) => JSON.stringify([p.buildOrder, p.timeline, p.doctrine.id])));
  assert.ok(shapes.size >= 4, `seed barely moved the plan: ${shapes.size} distinct from ${SEEDS.length} seeds`);
});

test('the same seed still gives byte-identical plans', () => {
  // Diversity must not cost reproducibility — the seed is the whole contract.
  for (const seed of SEEDS) {
    const a = generatePlan({ you: 'gla', enemy: 'usa_air', difficulty: 'hard', mapId: 'tournament_desert', seed });
    const b = generatePlan({ you: 'gla', enemy: 'usa_air', difficulty: 'hard', mapId: 'tournament_desert', seed });
    assert.deepEqual(a, b, `seed ${seed} was not reproducible`);
  }
});

test('every plan commits to one approach and names the rest', () => {
  const p = generatePlan({ you: 'china', enemy: 'gla_stealth', difficulty: 'hard', seed: 5 });
  assert.ok(p.doctrine.name, 'plan has no doctrine');
  assert.ok(p.doctrine.premise.length > 20, 'doctrine has no premise');
  assert.ok(p.doctrine.risk.length > 20, 'doctrine does not state how it fails');
  assert.ok(!p.alternatives.some((a) => a.id === p.doctrine.id), 'chosen approach repeated as an alternative');
});

test('an approach is never offered to an army that cannot execute it', () => {
  // The GLA fields no aircraft; offering it an air plan would be nonsense.
  const ds = loadDataset();
  const canDo: Record<string, RoleTag | undefined> = {
    air_superiority: 'aircraft',
    siege_line: 'artillery',
  };
  for (const you of ds.factions.map((f) => f.id)) {
    for (const enemy of ds.factions.map((f) => f.id)) {
      for (let seed = 0; seed < 4; seed++) {
        const p = generatePlan({ you, enemy, difficulty: 'hard', seed });
        for (const d of [p.doctrine, ...p.alternatives]) {
          const needed = canDo[d.id];
          if (!needed) continue;
          assert.ok(
            unitsFor(you).some((u) => u.roles.includes(needed)),
            `${you} was offered ${d.id} without any ${needed} unit`,
          );
        }
      }
    }
  }
});

test('the build order carries the chosen approach, not just the matchup', () => {
  // Two plans for the same matchup that pick different approaches must differ
  // in their build order, or the approach is decoration.
  const byDoctrine = new Map<string, string>();
  for (let seed = 0; seed < 40; seed++) {
    const p = generatePlan({ you: 'usa', enemy: 'gla', difficulty: 'medium', seed });
    if (!byDoctrine.has(p.doctrine.id)) byDoctrine.set(p.doctrine.id, p.buildOrder.join('|'));
  }
  assert.ok(byDoctrine.size >= 2, '40 seeds never surfaced a second approach');
  assert.equal(new Set(byDoctrine.values()).size, byDoctrine.size, 'different approaches produced identical build orders');
});

test('no terrain is asserted when no theatre is chosen', () => {
  // The timeline used to state "there is no chokepoint to hold" on every
  // mapless plan — a claim about a map the user never picked.
  for (let seed = 0; seed < 12; seed++) {
    const lines = generatePlan({ you: 'china', enemy: 'usa', difficulty: 'hard', seed })
      .timeline.flatMap((ph) => ph.objectives);
    for (const line of lines) {
      assert.ok(!/there is no chokepoint/i.test(line), `asserted terrain with no map: "${line}"`);
    }
  }
});
