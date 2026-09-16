import type {
  BattlePlan, Dataset, Difficulty, Faction, GameMap, MatchupNote,
  RoleTag, ThreatAxis, ThreatProfile, TimelinePhase, Unit,
} from '../types.js';
import { AXIS_LABEL, DIFFICULTY_NOTE, enemyThreatProfile, rankedAxes } from './threat.js';
import { recommendCounters } from './counters.js';
import { rankLineups } from './lineup.js';
import { mulberry32 } from './rng.js';
import {
  chooseDoctrine, rankDoctrines,
  type Doctrine, type DoctrineContext, type RankedDoctrine,
} from './doctrine.js';

const DO_NOT: Record<ThreatAxis, string> = {
  air: 'Do not move your army without anti-air inside it. Their aircraft will take it apart one unit at a time.',
  armor: 'Do not meet their armour head-on in open ground. Fight from garrisons, chokepoints or out of range.',
  infantry_swarm: 'Do not trade expensive units one-for-one against cheap infantry. You will run out of credits first.',
  artillery: 'Do not let your army sit still inside artillery range. Spread out, or close the distance and kill the guns.',
  stealth: 'Do not advance through unscouted ground. Without a detector attached to the army you are walking into whatever is already there.',
  superweapon: 'Do not cluster your production. One superweapon shot should never be able to cost you two buildings.',
  economy: 'Do not settle into a long game while they out-mine you. Contest a supply pile or raid the one they are on.',
  base_defense: 'Do not push into their defensive envelope without out-ranging it first. That is how whole armies vanish.',
  early_rush: 'Do not tech greedily. One defensive structure and a few cheap units first, every time.',
  chemical: 'Do not lean on infantry or garrisoned buildings. Both evaporate against toxins and fire.',
};

const PHASE_WINDOWS: Record<Difficulty, [string, string, string]> = {
  easy:   ['0–7 min', '7–16 min', '16 min+'],
  medium: ['0–6 min', '6–14 min', '14 min+'],
  hard:   ['0–4 min', '4–11 min', '11 min+'],
  brutal: ['0–3 min', '3–9 min', '9 min+'],
};

function hasRole(u: Unit, role: RoleTag): boolean {
  return u.roles.includes(role);
}

/**
 * Choose among options that are genuinely close, rather than always the single
 * best one.
 *
 * Every selection in this file used to be a sort followed by `[0]`, which is
 * why one matchup produced exactly one plan. Where two units are near enough in
 * merit that a good player would take either, the seed decides — so a reroll
 * changes the advice without ever degrading it. `band` is how much worse than
 * the leader a candidate may be and still be offered.
 */
function amongBest<T>(
  items: readonly T[],
  score: (item: T) => number,
  rand: () => number,
  band: number,
): T | undefined {
  if (!items.length) return undefined;
  const scored = items.map((item) => ({ item, s: score(item) })).sort((a, b) => b.s - a.s);
  const top = scored[0]!.s;
  const close = scored.filter((x) => x.s >= top - band);
  return close[Math.floor(rand() * close.length)]!.item;
}

/** One of several equivalent phrasings, so two plans never read identically. */
function variant(rand: () => number, options: readonly string[]): string {
  return options[Math.floor(rand() * options.length)]!;
}

const TIER_RANK = { early: 0, mid: 1, late: 2 } as const;

/** An early, cheap unit satisfying a predicate — no longer always the same one. */
function pickUnit(roster: Unit[], pred: (u: Unit) => boolean, rand: () => number): Unit | undefined {
  // Negated so higher is better: earlier tier and lower cost win.
  return amongBest(
    roster.filter(pred),
    (u) => -TIER_RANK[u.tier] * 1000 - u.cost,
    rand,
    250,
  );
}

function bestAgainst(roster: Unit[], axis: ThreatAxis, rand: () => number): Unit | undefined {
  return amongBest(
    roster.filter((u) => (u.answers[axis] ?? 0) >= 2),
    (u) => (u.answers[axis] ?? 0) * 1000 - u.cost,
    rand,
    300,
  );
}

/**
 * Start from the faction's stock opening, splice in what this enemy forces, and
 * let the chosen approach add the steps that make it that approach.
 */
function buildOrder(
  you: Faction,
  roster: Unit[],
  profile: ThreatProfile,
  enemy: Faction,
  doctrine: Doctrine,
  ctx: DoctrineContext,
  rand: () => number,
): string[] {
  const steps = [...you.opening];
  const insertions: Array<{ at: number; text: string }> = [];

  // Forced by the matchup: these are answers to what the enemy actually does,
  // and hold whatever approach you take.
  if (profile.early_rush >= 2.2) {
    const def = pickUnit(roster, (u) => hasRole(u, 'defense'), rand);
    insertions.push({
      at: 1,
      text: `PRIORITY — ${enemy.name} attacks early: get ${def ? `a ${def.name}` : 'a defensive structure'} and a few cheap units up before anything else`,
    });
  }
  if (profile.air >= 2.2) {
    const aa = bestAgainst(roster, 'air', rand);
    insertions.push({
      at: 2,
      text: `Anti-air early — ${aa ? aa.name : 'your best AA'} before their first air wave, and keep it moving with the army`,
    });
  }
  if (profile.stealth >= 2.2) {
    const det = pickUnit(roster, (u) => hasRole(u, 'detector'), rand);
    insertions.push({
      at: 3,
      text: `Detection is mandatory here — build ${det ? `a ${det.name}` : 'a detector'} and attach it to every push`,
    });
  }
  if (profile.infantry_swarm >= 2.2) {
    const clear = bestAgainst(roster, 'infantry_swarm', rand);
    insertions.push({
      at: 4,
      text: `Area damage for their hordes — ${clear ? clear.name : 'your best area-damage unit'} rather than more single-target fire`,
    });
  }
  if (profile.armor >= 2.5) {
    const at = bestAgainst(roster, 'armor', rand);
    insertions.push({
      at: 4,
      text: `Anti-armour core — ${at ? at.name : 'your best anti-tank unit'}, in numbers, before their tank ball arrives`,
    });
  }

  // Chosen, not forced: what this approach does differently.
  insertions.push(...doctrine.build(ctx));

  for (const ins of insertions.sort((a, b) => b.at - a.at)) {
    steps.splice(Math.min(ins.at, steps.length), 0, ins.text);
  }

  if (profile.base_defense >= 2.2) {
    const arty = pickUnit(roster, (u) => hasRole(u, 'artillery'), rand);
    steps.push(`Tech toward ${arty ? arty.name : 'siege units'} — their defensive line has to be out-ranged, not charged`);
  }
  if (profile.superweapon >= 2.2) {
    steps.push(variant(rand, [
      'Spread your production buildings apart now, and plan a raid on the superweapon rather than racing its timer',
      'Superweapon is coming: separate your production, and put a raid on the launcher in the plan rather than hoping to out-build it',
    ]));
  }

  return steps;
}

function timeline(
  you: Faction,
  profile: ThreatProfile,
  difficulty: Difficulty,
  enemy: Faction,
  doctrine: Doctrine,
  ctx: DoctrineContext,
  rand: () => number,
  map?: GameMap,
): TimelinePhase[] {
  const [w1, w2, w3] = PHASE_WINDOWS[difficulty];
  const top = rankedAxes(profile).slice(0, 2);
  const fromDoctrine = doctrine.phases(ctx);

  const early: string[] = [
    variant(rand, [
      'Get every worker or supply unit mining before you build anything else',
      'Everything that can gather should be gathering before the first structure goes down',
      'Income first: no build decision matters until every worker is on supply',
    ]),
    variant(rand, [
      'Scout with your first cheap unit — you need to see their opening, not guess it',
      'Send the first cheap unit out to look; playing blind against a known army list is a choice, not bad luck',
    ]),
  ];
  if (profile.early_rush >= 2.2) early.push(`Expect contact inside this window — ${enemy.name} does not wait`);
  else early.push('No early pressure expected: take the greedy expansion while it is free');
  if (map && map.supplyDensity <= 1) early.push('Supply is thin on this map — claim a second pile before they do');

  const mid: string[] = [
    `Build the counter core: ${top.map((a) => AXIS_LABEL[a].toLowerCase()).join(' and ')} are what they will actually apply`,
  ];
  // Only assert something about the terrain when a theatre was actually chosen.
  // Without one the planner used to state "there is no chokepoint to hold",
  // which is a claim about a map the user never picked.
  if (map) {
    mid.push(map.chokepoints >= 2
      ? 'Hold the chokepoint rather than the map; it is worth more than territory here'
      : 'Nothing on this map funnels them — keep the army mobile and pick your engagements');
  } else {
    mid.push('Pick a theatre for terrain-specific timing; without one, assume open ground and stay mobile');
  }

  const late: string[] = [];
  if (profile.superweapon >= 2) late.push('Their superweapon comes online in this window — kill the launcher or be somewhere else');
  late.push(`Commit with ${you.name}'s late-game units once you have map control, not before`);

  return [
    { label: 'Opening', window: w1, objectives: [...early, ...(fromDoctrine.early ?? [])] },
    { label: 'Midgame', window: w2, objectives: [...mid, ...(fromDoctrine.mid ?? [])] },
    { label: 'Late game', window: w3, objectives: [...late, ...(fromDoctrine.late ?? [])] },
  ];
}

function matchesSelector(sel: string, f: Faction): boolean {
  return sel === '*' || sel === f.id || sel === f.side;
}

function collectMatchupNotes(notes: MatchupNote[], you: Faction, enemy: Faction): string[] {
  const out: string[] = [];
  for (const n of notes) {
    if (matchesSelector(n.you, you) && matchesSelector(n.enemy, enemy)) out.push(...n.advice);
  }
  return [...new Set(out)];
}

function doNotList(you: Faction, profile: ThreatProfile): string[] {
  const out: string[] = [];
  for (const axis of rankedAxes(profile, 1.5)) {
    const exposure = you.vulnerability[axis] ?? 0;
    if (exposure >= 2) out.push(DO_NOT[axis]);
  }
  if (!out.length) {
    const top = rankedAxes(profile)[0];
    if (top) out.push(DO_NOT[top]);
  }
  return out.slice(0, 4);
}

export interface PlanInput {
  you?: string;
  enemy?: string;
  difficulty: Difficulty;
  mapId?: string;
  seed?: number;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/**
 * Build a battle plan from an explicit dataset.
 *
 * Deliberately free of any Node import so the browser build can run exactly
 * this engine rather than a re-implementation of it.
 */
export function planFrom(ds: Dataset, input: PlanInput): BattlePlan {
  const rand = mulberry32(input.seed ?? 0x5eed);

  const factionById = (id: string) => ds.factions.find((f) => f.id === id);
  const unitsFor = (id: string) => ds.units.filter((u) => u.factions?.includes(id as Faction['id']));
  const mapById = (id: string) =>
    ds.maps.find((m) => m.id === id) ?? ds.maps.find((m) => slug(m.name) === slug(id));

  const map = input.mapId ? mapById(input.mapId) : undefined;
  if (input.mapId && !map) throw new Error(`Unknown map: ${input.mapId}`);

  // Enemy: chosen, or picked at random so the plan is still a real matchup.
  const enemy = input.enemy
    ? factionById(input.enemy)
    : ds.factions[Math.floor(rand() * ds.factions.length)];
  if (!enemy) throw new Error(`Unknown faction: ${input.enemy}`);

  const profile = enemyThreatProfile(enemy, input.difficulty, map);

  // Your side: chosen, or the engine picks the best answer to that enemy.
  let you = input.you ? factionById(input.you) : undefined;
  if (input.you && !you) throw new Error(`Unknown faction: ${input.you}`);

  let ranking: BattlePlan['lineupRanking'];
  let rationale: string[] | undefined;

  if (!you) {
    const ranked = rankLineups(ds.factions, unitsFor, enemy, profile);
    ranking = ranked.map((r) => ({ faction: r.faction, score: r.score, why: r.why }));
    you = ranked[0]!.faction;
    rationale = [
      `Picked ${you.name} because it scores highest against ${enemy.name} on this difficulty${map ? ` and on ${map.name}` : ''}.`,
      ranked[0]!.why,
      ranked[1] ? `Next best: ${ranked[1].faction.name} (${ranked[1].score}/100).` : '',
    ].filter(Boolean);
  }

  const roster = unitsFor(you.id);
  const counters = recommendCounters(you, roster, profile);
  const top = rankedAxes(profile);

  // Which approaches hold up here, and which one this plan commits to. The
  // choice is weighted by fit and driven by the seed, so rerolling a pinned
  // matchup produces a different but equally defensible plan.
  const ctx: DoctrineContext = {
    you, enemy, roster, profile,
    difficulty: input.difficulty,
    ...(map ? { map } : {}),
  };
  const ranked = rankDoctrines(ctx);
  const chosen: RankedDoctrine = chooseDoctrine(ranked, rand);
  const alternatives = ranked
    .filter((d) => d.doctrine.id !== chosen.doctrine.id)
    .slice(0, 3)
    .map((d) => ({ id: d.doctrine.id, name: d.doctrine.name, premise: d.doctrine.premise, fit: d.fit }));

  const headline =
    `${you.name} vs ${enemy.name}` +
    (map ? ` on ${map.name}` : '') +
    ` — ${input.difficulty.toUpperCase()}. ` +
    (top[0]
      ? `Their game is ${AXIS_LABEL[top[0]].toLowerCase()}; this plan answers it with ${chosen.doctrine.tag}.`
      : `A soft matchup — this plan takes it with ${chosen.doctrine.tag}.`);

  const watchFor = [
    ...enemy.signatureTactics,
    ...enemy.quirks.slice(0, 1),
    DIFFICULTY_NOTE[input.difficulty],
  ];

  const mapNotes = map
    ? [...map.notes, `${map.players} players, ${map.terrain} terrain. Chokepoints ${map.chokepoints}/3, supply ${map.supplyDensity}/3, open ground ${map.openness}/3.`]
    : ['No map selected — pick one to get terrain-specific advice on chokepoints, supply and expansion timing.'];

  return {
    you,
    enemy,
    difficulty: input.difficulty,
    ...(map ? { map } : {}),
    ...(rationale ? { lineupRationale: rationale } : {}),
    ...(ranking ? { lineupRanking: ranking } : {}),
    headline,
    doctrine: {
      id: chosen.doctrine.id,
      name: chosen.doctrine.name,
      premise: chosen.doctrine.premise,
      fit: chosen.fit,
      risk: chosen.doctrine.risk(ctx),
    },
    alternatives,
    buildOrder: buildOrder(you, roster, profile, enemy, chosen.doctrine, ctx, rand),
    counters,
    timeline: timeline(you, profile, input.difficulty, enemy, chosen.doctrine, ctx, rand, map),
    watchFor,
    doNot: doNotList(you, profile),
    mapNotes,
    matchupNotes: collectMatchupNotes(ds.matchups, you, enemy),
  };
}

export { enemyThreatProfile };
