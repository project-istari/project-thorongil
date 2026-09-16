/**
 * Strategic approaches — the "how", where the rest of the engine answers "what".
 *
 * The planner used to emit exactly one plan per matchup: every selection was a
 * sort followed by `[0]`, so a matchup was a single deterministic point and the
 * seed changed nothing unless it happened to pick the enemy. Real skirmish play
 * is not like that. Most matchups have several defensible approaches, and which
 * one you take is a choice, not a lookup.
 *
 * A doctrine scores its own fit for a matchup and contributes its own build
 * steps, phase objectives and failure mode. The planner ranks them, keeps the
 * ones that are actually defensible here, and lets the seed choose among those
 * — so a reroll produces a genuinely different plan that is still correct, and
 * the alternatives it did not take are reported rather than hidden.
 */
import type { Difficulty, Faction, GameMap, RoleTag, ThreatProfile, Unit } from '../types.js';

export type DoctrineId =
  | 'early_pressure'
  | 'hold_and_tech'
  | 'expand_economy'
  | 'raid_economy'
  | 'air_superiority'
  | 'siege_line'
  | 'combined_arms';

export interface DoctrineContext {
  you: Faction;
  enemy: Faction;
  roster: Unit[];
  /** Enemy pressure, already scaled for difficulty and map. */
  profile: ThreatProfile;
  difficulty: Difficulty;
  map?: GameMap;
}

export interface PhaseAdvice {
  early: string[];
  mid: string[];
  late: string[];
}

export interface Doctrine {
  id: DoctrineId;
  name: string;
  /** Lowercase noun phrase, for use mid-sentence in a headline. */
  tag: string;
  /** What this approach is, in one line. */
  premise: string;
  /**
   * How well the approach fits this matchup. Anything at or below VIABLE_FLOOR
   * is withheld entirely: a plan should never offer an approach that loses on
   * the merits just to have something to say.
   */
  fit(ctx: DoctrineContext): number;
  /** Build steps this approach adds, with the position they belong at. */
  build(ctx: DoctrineContext): Array<{ at: number; text: string }>;
  phases(ctx: DoctrineContext): Partial<PhaseAdvice>;
  /** The thing that makes this approach lose. Always stated. */
  risk(ctx: DoctrineContext): string;
}

export const VIABLE_FLOOR = 1.5;

/* ------------------------------------------------------------ helpers --- */

const has = (roster: Unit[], role: RoleTag): boolean => roster.some((u) => u.roles.includes(role));

const countRole = (roster: Unit[], role: RoleTag): number =>
  roster.filter((u) => u.roles.includes(role)).length;

/** Units that answer an axis at strength >= 2, cheapest first. */
export function answering(roster: Unit[], axis: keyof ThreatProfile): Unit[] {
  return roster
    .filter((u) => (u.answers[axis] ?? 0) >= 2)
    .sort((a, b) => (b.answers[axis] ?? 0) - (a.answers[axis] ?? 0) || a.cost - b.cost);
}

/** Cheap early bodies — what any aggressive opening is actually made of. */
function earlyPunch(roster: Unit[]): Unit[] {
  return roster
    .filter((u) => u.tier === 'early' && u.cost <= 900 && !u.roles.includes('economy'))
    .sort((a, b) => a.cost - b.cost);
}

const named = (u: Unit | undefined, fallback: string): string => (u ? u.name : fallback);

/** Map traits, normalised to -1..+1, with a neutral 0 when no map is chosen. */
function terrain(map: GameMap | undefined) {
  if (!map) return { open: 0, choke: 0, supply: 0, known: false };
  return {
    open: (map.openness - 1.5) / 1.5,
    choke: (map.chokepoints - 1.5) / 1.5,
    supply: (map.supplyDensity - 1.5) / 1.5,
    known: true,
  };
}

/* ---------------------------------------------------------- doctrines --- */

const EARLY_PRESSURE: Doctrine = {
  id: 'early_pressure',
  name: 'Early pressure',
  tag: 'early pressure',
  premise: 'Arrive before their tech does, and make the first five minutes their problem instead of yours.',
  fit(ctx) {
    const t = terrain(ctx.map);
    const punch = earlyPunch(ctx.roster).length;
    if (!punch) return 0;
    let score = 2;
    score += (ctx.enemy.vulnerability.early_rush ?? 0) * 1.8;
    score += Math.min(1.5, punch * 0.35);
    // A boxed map blunts a rush; open ground and thin supply feed it.
    score -= t.choke * 1.2;
    score -= t.supply * 0.8;
    // Racing an AI that also comes early is a coin flip, not a plan.
    score -= Math.max(0, ctx.profile.early_rush - 2.2) * 1.1;
    // Their base defences are what an early attack actually runs into.
    score -= Math.max(0, ctx.profile.base_defense - 2) * 0.9;
    return score;
  },
  build(ctx) {
    const punch = earlyPunch(ctx.roster);
    const first = punch[0];
    const second = punch[1];
    return [{
      at: 1,
      text: `Open aggressive — ${named(first, 'your cheapest early unit')}${second ? ` backed by ${second.name}` : ''} out of the first production building, before any tech`,
    }];
  },
  phases(ctx) {
    const t = terrain(ctx.map);
    return {
      early: [
        'Send the first squad the moment it exists — a rush that waits for a second batch is not a rush',
        t.known && t.choke > 0.3
          ? 'Take the long way round the chokepoint; the direct path is where their defences already are'
          : 'Go straight at the shortest path and force them to answer on your timing',
      ],
      mid: [
        'Convert the pressure into economy: if they held, expand while they are still rebuilding',
        `Do not over-commit past the point ${ctx.enemy.name} stabilises — a failed rush that keeps feeding units loses twice`,
      ],
    };
  },
  risk: (ctx) =>
    `If ${ctx.enemy.name} holds the first attack you are behind on economy, so set a hard cut-off: stop reinforcing the moment it stalls and expand instead.`,
};

const HOLD_AND_TECH: Doctrine = {
  id: 'hold_and_tech',
  name: 'Hold and tech',
  tag: 'a defensive line and a tech lead',
  premise: 'Give up the early map, survive the pressure intact, and win on the strength of what you reach first.',
  fit(ctx) {
    const t = terrain(ctx.map);
    let score = 2;
    score += Math.max(0, ctx.profile.early_rush - 1.5) * 1.4;
    score += t.choke * 1.3;
    score += has(ctx.roster, 'defense') ? 1.0 : -0.5;
    score += ctx.roster.some((u) => u.tier === 'late') ? 0.8 : -1.0;
    // Teching while they out-mine you is how you lose slowly.
    score -= Math.max(0, ctx.profile.economy - 2.2) * 1.0;
    return score;
  },
  build(ctx) {
    const def = ctx.roster.filter((u) => u.roles.includes('defense')).sort((a, b) => a.cost - b.cost)[0];
    return [{
      at: 1,
      text: `Defensive line first — ${named(def, 'a defensive structure')} covering the main approach, then tech behind it`,
    }];
  },
  phases(ctx) {
    const late = ctx.roster.filter((u) => u.tier === 'late').sort((a, b) => b.cost - a.cost)[0];
    return {
      early: ['Hold the shortest approach only — do not try to cover the whole perimeter with structures'],
      mid: [
        `Tech while the line holds; the plan is to reach ${named(late, 'your late-tier units')} with your base intact`,
        'Trade structures for time, never units for pride — a lost defensive building is cheaper than a lost army',
      ],
      late: ['You are the one with the stronger army now — leave the base and take the map before they catch up on tech'],
    };
  },
  risk: () =>
    'Turtling against an economy that is allowed to grow just postpones the fight on worse terms. If they are unharassed by the midgame, you have to come out anyway.',
};

const EXPAND_ECONOMY: Doctrine = {
  id: 'expand_economy',
  name: 'Expand and out-produce',
  tag: 'a second income',
  premise: 'Take a second income before they do and win the game in the supply lines rather than the first fight.',
  fit(ctx) {
    const t = terrain(ctx.map);
    let score = 1.8;
    score += t.supply * 1.6;
    score -= Math.max(0, ctx.profile.early_rush - 1.6) * 1.6;
    score += countRole(ctx.roster, 'economy') * 0.4;
    if (ctx.difficulty === 'easy') score += 1.2;
    if (ctx.difficulty === 'brutal') score -= 1.0;
    return score;
  },
  build: () => [{
    at: 2,
    text: 'Second supply source before the second production building — income first, army second',
  }],
  phases(ctx) {
    const t = terrain(ctx.map);
    return {
      early: [
        t.known && t.supply > 0.3
          ? 'Supply is rich here — claim the nearest uncontested pile immediately, it pays for everything after'
          : 'Take the safest expansion you can defend, not the richest one you cannot',
      ],
      mid: [
        'Keep both incomes running: a second pile you cannot defend is worse than the one you had',
        `Spend the surplus on width — ${ctx.you.name} wants more production buildings, not a bigger bank`,
      ],
    };
  },
  risk: () =>
    'An expansion is an undefended second base until you make it otherwise. If it dies you have paid for it and got nothing.',
};

const RAID_ECONOMY: Doctrine = {
  id: 'raid_economy',
  name: 'Raid their economy',
  tag: 'sustained raiding on their economy',
  premise: 'Refuse the straight fight and take their income apart instead, so their army arrives late and smaller.',
  fit(ctx) {
    let score = 1.6;
    score += Math.max(0, ctx.profile.economy - 1.4) * 1.5;
    score += (ctx.enemy.vulnerability.economy ?? 0) * 1.2;
    const raiders = countRole(ctx.roster, 'stealth') + countRole(ctx.roster, 'aircraft') + countRole(ctx.roster, 'scout');
    if (!raiders) return 0;
    score += Math.min(1.6, raiders * 0.4);
    // Heavy static defence makes a raider's life short.
    score -= Math.max(0, ctx.profile.base_defense - 2.2) * 0.8;
    return score;
  },
  build(ctx) {
    const raider =
      ctx.roster.filter((u) => u.roles.includes('stealth')).sort((a, b) => a.cost - b.cost)[0] ??
      ctx.roster.filter((u) => u.roles.includes('aircraft')).sort((a, b) => a.cost - b.cost)[0];
    return [{
      at: 2,
      text: `Raiding element — ${named(raider, 'your fastest harass unit')} kept separate from the main army and aimed at workers, never at their army`,
    }];
  },
  phases: () => ({
    mid: [
      'Raid on a timer, not on impulse: every time they push out, something of yours should be in their base',
      'Kill workers and dozers first. Killing the buildings just tells them where you are',
    ],
    late: ['Once their income is behind, the straight fight you were avoiding is the fight you now want'],
  }),
  risk: () =>
    'Harassment that never converts is just a slower loss. Raiding buys tempo — if you never spend it on a push or an expansion, you have bought nothing.',
};

const AIR_SUPERIORITY: Doctrine = {
  id: 'air_superiority',
  name: 'Take the air',
  tag: 'air superiority',
  premise: 'Own the sky, then use it to hit whatever the ground army cannot reach.',
  fit(ctx) {
    if (!has(ctx.roster, 'aircraft')) return 0;
    let score = 1.4;
    score += (ctx.you.threat.air ?? 0) * 0.9;
    score += (ctx.enemy.vulnerability.air ?? 0) * 1.4;
    // Their anti-air, not their aircraft, is what kills this approach.
    score -= Math.max(0, ctx.profile.air - 1.8) * 0.7;
    score -= Math.max(0, ctx.profile.base_defense - 1.8) * 0.8;
    return score;
  },
  build(ctx) {
    const air = ctx.roster.filter((u) => u.roles.includes('aircraft')).sort((a, b) => a.cost - b.cost)[0];
    return [{
      at: 3,
      text: `Air first — ${named(air, 'your first aircraft')} as the core of the army rather than a supplement to it`,
    }];
  },
  phases: (ctx) => ({
    mid: [
      'Pick off what the ground army cannot reach: artillery, workers, and anything caught out of anti-air cover',
      `Do not fly over ${ctx.enemy.name}'s base until you know where the anti-air is — one pass into it costs the whole squadron`,
    ],
    late: ['Aircraft are the map control here; keep them alive and their army cannot move freely'],
  }),
  risk: () =>
    'Aircraft are expensive and die instantly to massed anti-air. One careless pass can undo the entire investment.',
};

const SIEGE_LINE: Doctrine = {
  id: 'siege_line',
  name: 'Out-range the line',
  tag: 'siege that out-ranges them',
  premise: 'Never enter their defensive envelope — dismantle it from outside its reach and walk in afterwards.',
  fit(ctx) {
    if (!has(ctx.roster, 'artillery')) return 0;
    const t = terrain(ctx.map);
    let score = 1.5;
    score += Math.max(0, ctx.profile.base_defense - 1.4) * 1.5;
    score += t.choke * 1.1;
    score += countRole(ctx.roster, 'artillery') * 0.4;
    // Artillery is helpless against anything fast that reaches it.
    score -= Math.max(0, ctx.profile.air - 2.0) * 0.9;
    return score;
  },
  build(ctx) {
    const arty = ctx.roster.filter((u) => u.roles.includes('artillery')).sort((a, b) => a.cost - b.cost)[0];
    return [{
      at: 3,
      text: `Tech toward ${named(arty, 'siege units')} deliberately — this plan is built on out-ranging them, so the artillery is the army, not an extra`,
    }];
  },
  phases: () => ({
    mid: [
      'Escort the artillery with everything else you own — on its own it is free kills for anything that reaches it',
      'Grind the defensive line down from outside its range; there is no hurry and no reason to walk in',
    ],
    late: ['Move the siege line forward one position at a time, and never leave it without cover'],
  }),
  risk: () =>
    'Siege units are slow, fragile and useless in a surprise engagement. Caught unescorted in the open, they are simply lost.',
};

const COMBINED_ARMS: Doctrine = {
  id: 'combined_arms',
  name: 'Combined-arms push',
  tag: 'one massed combined-arms timing',
  premise: 'Build the counter core the matchup calls for, mass one decisive timing, and take the map with it.',
  // The dependable middle. Always defensible, rarely the sharpest answer, so it
  // scores modestly and wins when nothing more specific fits.
  fit: () => 3.2,
  build: () => [],
  phases: (ctx) => ({
    mid: [`Mass one army rather than trickling units — ${ctx.you.name} wins this on a single committed timing, not on attrition`],
    late: ['Push on a won engagement, then keep producing from the map control it buys you'],
  }),
  risk: () =>
    'A balanced army that never commits is just an expensive stalemate. This plan needs you to actually take the timing when it arrives.',
};

export const DOCTRINES: readonly Doctrine[] = [
  EARLY_PRESSURE, HOLD_AND_TECH, EXPAND_ECONOMY,
  RAID_ECONOMY, AIR_SUPERIORITY, SIEGE_LINE, COMBINED_ARMS,
];

export interface RankedDoctrine {
  doctrine: Doctrine;
  fit: number;
}

/** Every approach defensible in this matchup, best fit first. */
export function rankDoctrines(ctx: DoctrineContext): RankedDoctrine[] {
  return DOCTRINES
    .map((doctrine) => ({ doctrine, fit: Math.round(doctrine.fit(ctx) * 100) / 100 }))
    .filter((d) => d.fit > VIABLE_FLOOR)
    .sort((a, b) => b.fit - a.fit);
}

/**
 * Choose among the defensible approaches, weighted by fit.
 *
 * Weighted rather than top-scoring, because that is what makes a reroll worth
 * pressing: a clearly better approach still wins most of the time, but a close
 * second genuinely comes up. Squaring the margin above the floor keeps a weak
 * approach from being chosen at the same rate as a strong one.
 */
export function chooseDoctrine(ranked: RankedDoctrine[], rand: () => number): RankedDoctrine {
  if (!ranked.length) return { doctrine: COMBINED_ARMS, fit: COMBINED_ARMS.fit({} as DoctrineContext) };
  const weights = ranked.map((d) => (d.fit - VIABLE_FLOOR + 0.4) ** 2);
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rand() * total;
  for (let i = 0; i < ranked.length; i++) {
    roll -= weights[i]!;
    if (roll <= 0) return ranked[i]!;
  }
  return ranked[0]!;
}
