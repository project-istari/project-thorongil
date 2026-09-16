import type { CounterRecommendation, Faction, ThreatAxis, ThreatProfile, Unit } from '../types.js';
import { displayPressure, rankedAxes } from './threat.js';

export const AXIS_GUIDANCE: Record<ThreatAxis, string> = {
  air: 'Keep anti-air inside the army ball, not just in the base. Aircraft pick off stragglers first.',
  armor: 'Anti-tank infantry in garrisons and buildings trade far better than tank-for-tank.',
  infantry_swarm: 'Area damage beats target count. Flame, toxin, artillery and strafing runs all scale where single-target fire does not.',
  artillery: 'Artillery cannot defend itself. Anything fast that reaches it kills it — aircraft most reliably.',
  stealth: 'A detector must travel with the army, not sit in the base. Without one you are fighting blind.',
  superweapon: 'Spread your base so no single shot takes two buildings, and kill the launcher rather than racing it.',
  economy: 'Raid supply lines. Killing workers and dozers costs them more than killing their army does.',
  base_defense: 'Out-range it or go over it. Walking into a defensive envelope is how armies disappear.',
  early_rush: 'Get one defensive structure and a handful of cheap units up before you tech. Surviving is the whole plan.',
  chemical: 'Go mechanised. Toxins and fire do very little to vehicles and nothing to aircraft.',
};

/** Score how well a single unit answers an axis, favouring cheap and early. */
function unitScore(unit: Unit, axis: ThreatAxis): number {
  const answer = unit.answers[axis] ?? 0;
  if (answer <= 0) return 0;
  const tierBonus = unit.tier === 'early' ? 0.4 : unit.tier === 'mid' ? 0.2 : 0;
  const costPenalty = Math.min(0.6, unit.cost / 4000);
  return answer + tierBonus - costPenalty;
}

/**
 * For each axis the enemy actually pressures, the units in your roster that
 * answer it, best first.
 */
export function recommendCounters(
  you: Faction,
  roster: Unit[],
  profile: ThreatProfile,
  maxAxes = 5,
): CounterRecommendation[] {
  const axes = rankedAxes(profile).slice(0, maxAxes);

  return axes.map((axis) => {
    const units = roster
      .map((u) => ({ unit: u, score: unitScore(u, axis) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.unit.cost - b.unit.cost)
      .slice(0, 3)
      .map(({ unit }) => ({ name: unit.name, cost: unit.cost, tier: unit.tier, why: unit.note }));

    const guidance = units.length
      ? AXIS_GUIDANCE[axis]
      : `${you.name} has no clean answer to this in its roster — avoid the engagement, or deny it at the source by raiding their production.`;

    return { axis, pressure: displayPressure(profile[axis]), units, guidance };
  });
}

/** How well an army covers a given axis, 0-3. Used for lineup scoring. */
export function coverage(roster: Unit[], axis: ThreatAxis): number {
  let best = 0;
  let depth = 0;
  for (const u of roster) {
    const a = u.answers[axis] ?? 0;
    if (a > best) best = a;
    if (a >= 2) depth++;
  }
  // Having several real answers matters, but with diminishing returns.
  return Math.min(3, best + Math.min(0.75, depth * 0.25));
}
