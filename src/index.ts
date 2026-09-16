/**
 * Node-facing entry point: the pure engine plus the on-disk dataset.
 *
 * The browser build imports src/engine/* directly and supplies its own
 * dataset, so everything below this line is the filesystem half only.
 */
import type { BattlePlan } from './types.js';
import { loadDataset } from './data/index.js';
import { planFrom, type PlanInput } from './engine/plan.js';

export function generatePlan(input: PlanInput): BattlePlan {
  return planFrom(loadDataset(), input);
}

export { loadDataset, factionById, unitsFor, mapById } from './data/index.js';
export { planFrom, type PlanInput } from './engine/plan.js';
export { enemyThreatProfile, rankedAxes, AXES, AXIS_LABEL, displayPressure } from './engine/threat.js';
export { recommendCounters, coverage, AXIS_GUIDANCE } from './engine/counters.js';
export { rankLineups, scoreFaction, calibrate } from './engine/lineup.js';
export * from './types.js';
