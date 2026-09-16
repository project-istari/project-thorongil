import type {
  BattlePlan, Dataset, Difficulty, Faction, GameMap, MatchupNote,
  RoleTag, ThreatAxis, ThreatProfile, TimelinePhase, Unit,
} from '../types.js';
import { AXIS_LABEL, DIFFICULTY_NOTE, enemyThreatProfile, rankedAxes } from './threat.js';
import { recommendCounters } from './counters.js';
import { rankLineups } from './lineup.js';
import { mulberry32 } from './rng.js';

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

/** Cheapest, earliest unit in the roster that satisfies a predicate. */
function pickUnit(roster: Unit[], pred: (u: Unit) => boolean): Unit | undefined {
  const tierRank = { early: 0, mid: 1, late: 2 } as const;
  return roster
    .filter(pred)
    .sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || a.cost - b.cost)[0];
}

function bestAgainst(roster: Unit[], axis: ThreatAxis): Unit | undefined {
  return roster
    .filter((u) => (u.answers[axis] ?? 0) >= 2)
    .sort((a, b) => (b.answers[axis] ?? 0) - (a.answers[axis] ?? 0) || a.cost - b.cost)[0];
}

/**
 * Start from the faction's stock opening, then splice in the things this
 * particular enemy forces you to build.
 */
function buildOrder(you: Faction, roster: Unit[], profile: ThreatProfile, enemy: Faction): string[] {
  const steps = [...you.opening];
  const insertions: Array<{ at: number; text: string }> = [];

  if (profile.early_rush >= 2.2) {
    const def = pickUnit(roster, (u) => hasRole(u, 'defense'));
    insertions.push({
      at: 1,
      text: `PRIORITY — ${enemy.name} attacks early: get ${def ? `a ${def.name}` : 'a defensive structure'} and a few cheap units up before anything else`,
    });
  }
  if (profile.air >= 2.2) {
    const aa = bestAgainst(roster, 'air');
    insertions.push({
      at: 2,
      text: `Anti-air early — ${aa ? aa.name : 'your best AA'} before their first air wave, and keep it moving with the army`,
    });
  }
  if (profile.stealth >= 2.2) {
    const det = pickUnit(roster, (u) => hasRole(u, 'detector'));
    insertions.push({
      at: 3,
      text: `Detection is mandatory here — build ${det ? `a ${det.name}` : 'a detector'} and attach it to every push`,
    });
  }
  if (profile.infantry_swarm >= 2.2) {
    const clear = bestAgainst(roster, 'infantry_swarm');
    insertions.push({
      at: 4,
      text: `Area damage for their hordes — ${clear ? clear.name : 'your best area-damage unit'} rather than more single-target fire`,
    });
  }
  if (profile.armor >= 2.5) {
    const at = bestAgainst(roster, 'armor');
    insertions.push({
      at: 4,
      text: `Anti-armour core — ${at ? at.name : 'your best anti-tank unit'}, in numbers, before their tank ball arrives`,
    });
  }

  for (const ins of insertions.sort((a, b) => b.at - a.at)) {
    steps.splice(Math.min(ins.at, steps.length), 0, ins.text);
  }

  if (profile.base_defense >= 2.2) {
    const arty = pickUnit(roster, (u) => hasRole(u, 'artillery'));
    steps.push(`Tech toward ${arty ? arty.name : 'siege units'} — their defensive line has to be out-ranged, not charged`);
  }
  if (profile.superweapon >= 2.2) {
    steps.push('Spread your production buildings apart now, and plan a raid on the superweapon rather than racing its timer');
  }

  return steps;
}

function timeline(you: Faction, profile: ThreatProfile, difficulty: Difficulty, enemy: Faction, map?: GameMap): TimelinePhase[] {
  const [w1, w2, w3] = PHASE_WINDOWS[difficulty];
  const top = rankedAxes(profile).slice(0, 2);

  const early: string[] = [
    'Get every worker or supply unit mining before you build anything else',
    'Scout with your first cheap unit — you need to see their opening, not guess it',
  ];
  if (profile.early_rush >= 2.2) early.push(`Expect contact inside this window — ${enemy.name} does not wait`);
  else early.push('No early pressure expected: take the greedy expansion while it is free');
  if (map && map.supplyDensity <= 1) early.push('Supply is thin on this map — claim a second pile before they do');

  const mid: string[] = [
    `Build the counter core: ${top.map((a) => AXIS_LABEL[a].toLowerCase()).join(' and ')} are what they will actually apply`,
    'Raid their supply line at least once — economy damage compounds, army damage does not',
  ];
  if (map && map.chokepoints >= 2) mid.push('Hold the chokepoint rather than the map; it is worth more than territory here');
  else mid.push('There is no chokepoint to hold — keep the army mobile and pick your engagements');

  const late: string[] = [];
  if (profile.superweapon >= 2) late.push('Their superweapon comes online in this window — kill the launcher or be somewhere else');
  late.push(`Commit with ${you.name}'s late-game units once you have map control, not before`);
  late.push('Push when their army is dead, not when yours is full — the window is after a won engagement');

  return [
    { label: 'Opening', window: w1, objectives: early },
    { label: 'Midgame', window: w2, objectives: mid },
    { label: 'Late game', window: w3, objectives: late },
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

  const headline =
    `${you.name} vs ${enemy.name}` +
    (map ? ` on ${map.name}` : '') +
    ` — ${input.difficulty.toUpperCase()}. ` +
    (top[0]
      ? `Their game is ${AXIS_LABEL[top[0]].toLowerCase()}; answer that first and the rest follows.`
      : 'A soft matchup — play your standard opening and take the map.');

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
    buildOrder: buildOrder(you, roster, profile, enemy),
    counters,
    timeline: timeline(you, profile, input.difficulty, enemy, map),
    watchFor,
    doNot: doNotList(you, profile),
    mapNotes,
    matchupNotes: collectMatchupNotes(ds.matchups, you, enemy),
  };
}

export { enemyThreatProfile };
