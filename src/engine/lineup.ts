import type { Faction, ThreatProfile, Unit } from '../types.js';
import { AXES, AXIS_LABEL } from './threat.js';
import { coverage } from './counters.js';

/**
 * Map a raw score onto 0-100.
 *
 * The bounds come from sampling every army against every army at every
 * difficulty: raw scores land between roughly 16 and 63, so this stretches
 * that band across the full range instead of saturating at the top.
 * See test/lineup.test.ts, which fails if the spread collapses again.
 */
const RAW_FLOOR = 14;
const RAW_CEILING = 66;

export function calibrate(raw: number): number {
  const pct = ((raw - RAW_FLOOR) / (RAW_CEILING - RAW_FLOOR)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

export interface LineupScore {
  faction: Faction;
  /** 0-100, calibrated so a typical matchup lands near the middle. */
  score: number;
  /** Unscaled score, for calibration and testing. */
  raw: number;
  why: string;
  detail: { defense: number; offense: number; risk: number };
}

/**
 * Score one army against an enemy on three counts:
 *
 *  - defense: can you answer what they actually throw at you
 *  - offense: does what you throw land on something they are soft against
 *  - risk:    do they pressure the axes you are structurally exposed on
 */
export function scoreFaction(
  you: Faction,
  roster: Unit[],
  enemy: Faction,
  profile: ThreatProfile,
): LineupScore {
  let defense = 0;
  let offense = 0;
  let risk = 0;

  let bestCounterAxis = AXES[0]!;
  let bestCounterValue = -Infinity;
  let worstRiskAxis = AXES[0]!;
  let worstRiskValue = -Infinity;

  for (const axis of AXES) {
    const pressure = profile[axis];
    const cover = coverage(roster, axis);
    const d = pressure * cover;
    defense += d;
    if (pressure >= 1 && d > bestCounterValue) {
      bestCounterValue = d;
      bestCounterAxis = axis;
    }

    offense += (you.threat[axis] ?? 0) * (enemy.vulnerability[axis] ?? 0);

    const r = pressure * (you.vulnerability[axis] ?? 0);
    risk += r;
    if (r > worstRiskValue) {
      worstRiskValue = r;
      worstRiskAxis = axis;
    }
  }

  // Weighted so that "can I survive them" counts for more than "can I hurt them".
  const raw = defense * 1.0 + offense * 0.8 - risk * 1.1;
  const score = calibrate(raw);

  const why =
    bestCounterValue > 0
      ? `Answers their ${AXIS_LABEL[bestCounterAxis].toLowerCase()} well; most exposed to ${AXIS_LABEL[worstRiskAxis].toLowerCase()}.`
      : `Little overlap with their strengths; most exposed to ${AXIS_LABEL[worstRiskAxis].toLowerCase()}.`;

  return { faction: you, score, raw, why, detail: { defense, offense, risk } };
}

export function rankLineups(
  candidates: Faction[],
  rosterFor: (id: string) => Unit[],
  enemy: Faction,
  profile: ThreatProfile,
): LineupScore[] {
  return candidates
    .map((f) => scoreFaction(f, rosterFor(f.id), enemy, profile))
    .sort((a, b) => b.score - a.score);
}
