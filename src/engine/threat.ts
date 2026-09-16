import type { Difficulty, Faction, GameMap, ThreatAxis, ThreatProfile } from '../types.js';

export const AXES: readonly ThreatAxis[] = [
  'air', 'armor', 'infantry_swarm', 'artillery', 'stealth',
  'superweapon', 'economy', 'base_defense', 'early_rush', 'chemical',
] as const;

export const AXIS_LABEL: Record<ThreatAxis, string> = {
  air: 'Air power',
  armor: 'Heavy armour',
  infantry_swarm: 'Infantry hordes',
  artillery: 'Artillery / siege',
  stealth: 'Stealth',
  superweapon: 'Superweapons',
  economy: 'Economy snowball',
  base_defense: 'Base defences',
  early_rush: 'Early aggression',
  chemical: 'Toxins / fire',
};

/**
 * How the skirmish AI's behaviour scales with difficulty.
 *
 * These are behavioural multipliers, not stat changes: a harder AI expands
 * sooner, attacks sooner and reaches its tech faster, so the axes that matter
 * in a plan shift even though the army list is identical.
 */
const DIFFICULTY_SCALE: Record<Difficulty, Partial<Record<ThreatAxis, number>> & { all: number }> = {
  easy:   { all: 0.75, early_rush: 0.4, economy: 0.7, superweapon: 0.6 },
  medium: { all: 1.0 },
  hard:   { all: 1.15, early_rush: 1.35, economy: 1.3, superweapon: 1.2 },
  brutal: { all: 1.3, early_rush: 1.6, economy: 1.5, superweapon: 1.35 },
};

export const DIFFICULTY_NOTE: Record<Difficulty, string> = {
  easy: 'The AI will not rush you and rarely expands. You can afford a greedy opening and tech straight to what you actually want to play with.',
  medium: 'The AI expands once and attacks in waves. Hold your first defensive line, then out-tech it.',
  hard: 'The AI attacks early, expands aggressively and keeps producing while it fights. You need a defensive structure up before you tech.',
  brutal: 'Assume constant pressure and a faster economy than yours. Deny expansions early or you will simply be out-produced.',
};

/**
 * Profiles keep headroom above 3 on purpose.
 *
 * An axis already at 3 still gets worse on a harder AI, and clamping it to 3
 * would silently erase that ordering. Consumers that display pressure
 * normalise back to the 0-3 scale themselves.
 */
export const PRESSURE_CEILING = 4.5;

function clamp(n: number, lo = 0, hi = PRESSURE_CEILING): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Squash a raw pressure value back onto the 0-3 scale used in the UI. */
export function displayPressure(value: number): number {
  return Math.round(Math.min(3, value) * 10) / 10;
}

/**
 * The pressure an enemy army will actually apply, given who they are, how hard
 * the AI is set, and what the map lets them do.
 */
export function enemyThreatProfile(enemy: Faction, difficulty: Difficulty, map?: GameMap): ThreatProfile {
  const scale = DIFFICULTY_SCALE[difficulty];
  const out = {} as ThreatProfile;

  for (const axis of AXES) {
    const base = enemy.threat[axis] ?? 0;
    const axisScale = scale[axis] ?? scale.all;
    out[axis] = base * axisScale;
  }

  if (map) {
    // Open ground rewards manoeuvre and long range; boxed-in maps reward siege.
    const open = (map.openness - 1.5) / 1.5;      // -1 .. +1
    const choke = (map.chokepoints - 1.5) / 1.5;
    const supply = (map.supplyDensity - 1.5) / 1.5;

    out.armor += open * 0.4 * (enemy.threat.armor > 0 ? 1 : 0);
    out.air += open * 0.3 * (enemy.threat.air > 0 ? 1 : 0);
    out.artillery += choke * 0.5 * (enemy.threat.artillery > 0 ? 1 : 0);
    out.base_defense += choke * 0.5;
    out.stealth += choke * 0.3 * (enemy.threat.stealth > 0 ? 1 : 0);
    out.early_rush -= supply * 0.4;          // rich supply means longer games
    out.superweapon += supply * 0.5 * (enemy.threat.superweapon > 0 ? 1 : 0);
    out.economy += supply * 0.3;
  }

  for (const axis of AXES) out[axis] = clamp(out[axis]);
  return out;
}

/** Axes sorted by how much they matter, strongest first. */
export function rankedAxes(profile: ThreatProfile, minimum = 1.2): ThreatAxis[] {
  return AXES.filter((a) => profile[a] >= minimum).sort((a, b) => profile[b] - profile[a]);
}
