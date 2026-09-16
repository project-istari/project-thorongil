/**
 * Domain model for Command & Conquer: Generals - Zero Hour skirmish planning.
 *
 * The vocabulary here is deliberately small: everything the engine reasons about
 * is expressed as `RoleTag`s on units and `ThreatAxis` pressure on armies. That
 * keeps matchup logic derivable from the dataset instead of hand-written per pair.
 */

/** The twelve playable armies: three base factions plus nine sub-generals. */
export type FactionId =
  | 'usa'
  | 'usa_air'
  | 'usa_laser'
  | 'usa_super'
  | 'china'
  | 'china_tank'
  | 'china_infantry'
  | 'china_nuke'
  | 'gla'
  | 'gla_toxin'
  | 'gla_stealth'
  | 'gla_demo';

/** The parent side a general belongs to. Base factions are their own parent. */
export type SideId = 'usa' | 'china' | 'gla';

export type Difficulty = 'easy' | 'medium' | 'hard' | 'brutal';

/**
 * What a unit *is for*. A unit may carry several. These drive both the "what do
 * they hit me with" and the "what answers it" halves of the engine.
 */
export type RoleTag =
  | 'anti_infantry'
  | 'anti_vehicle'
  | 'anti_air'
  | 'anti_structure'
  | 'artillery'
  | 'aircraft'
  | 'scout'
  | 'detector'
  | 'stealth'
  | 'transport'
  | 'support'
  | 'hero'
  | 'suicide'
  | 'garrison_clear'
  | 'repair'
  | 'capture'
  | 'economy'
  | 'defense'
  | 'superweapon';

/** How a unit moves, which decides what can shoot it. */
export type Domain = 'ground' | 'air' | 'infantry';

/**
 * The axes along which an army applies pressure. An enemy's profile on these
 * axes is what a counter-plan has to answer.
 */
export type ThreatAxis =
  | 'air'
  | 'armor'
  | 'infantry_swarm'
  | 'artillery'
  | 'stealth'
  | 'superweapon'
  | 'economy'
  | 'base_defense'
  | 'early_rush'
  | 'chemical';

export type ThreatProfile = Record<ThreatAxis, number>;

export type Tier = 'early' | 'mid' | 'late';

export interface Unit {
  id: string;
  name: string;
  /** Every army that can field this unit. Shared units are listed once. */
  factions: FactionId[];
  domain: Domain;
  roles: RoleTag[];
  /** Approximate build cost in credits; used for cost-efficiency ranking. */
  cost: number;
  tier: Tier;
  /** Which enemy threat axes this unit answers, and how strongly (0-3). */
  answers: Partial<Record<ThreatAxis, number>>;
  /** One-line description of why you build it. Authored, not scraped. */
  note: string;
  /** Encyclopaedic description, filled in by the wiki ingest step. */
  description?: string;
  /** Lead image URL from the wiki, when the crawl found one. Presentation only. */
  image?: string;
  /** Where this record came from. `wiki` entries are overlaid by the ingest step. */
  source: 'curated' | 'wiki' | 'merged';
  /** Wiki page title, when known, so the ingest step can reconcile it. */
  wikiPage?: string;
}

export interface Faction {
  id: FactionId;
  name: string;
  /** In-fiction commander, for generals. */
  general?: string;
  side: SideId;
  /** Short flavour line shown at the top of a plan. */
  tagline: string;
  /** How much pressure this army applies on each axis (0-3). */
  threat: ThreatProfile;
  /** Axes this army is structurally soft against (0-3, higher = more exposed). */
  vulnerability: Partial<Record<ThreatAxis, number>>;
  strengths: string[];
  weaknesses: string[];
  /** Ordered opening build, before matchup adjustments. */
  opening: string[];
  /** Signature things to do that are specific to this army. */
  signatureTactics: string[];
  /** Army-wide quirks worth knowing (power dependency, salvage, horde bonus...). */
  quirks: string[];
  /** Encyclopaedic description, filled in by the wiki ingest step. */
  description?: string;
  /** Lead image URL from the wiki, when the crawl found one. Presentation only. */
  image?: string;
  wikiPage?: string;
  source: 'curated' | 'wiki' | 'merged';
}

export type MapSize = '2p' | '3p' | '4p' | '6p' | '8p';

export interface GameMap {
  id: string;
  name: string;
  players: number;
  size: MapSize;
  terrain: 'desert' | 'snow' | 'urban' | 'temperate' | 'jungle' | 'mixed';
  /** 0-3: how boxed-in the approaches are. High = defensible chokepoints. */
  chokepoints: number;
  /** 0-3: how much supply is within safe reach of a starting position. */
  supplyDensity: number;
  /** 0-3: how much of the fight is decided by open-field manoeuvring. */
  openness: number;
  /** Notable features: oil derricks, garrisonable buildings, water, cliffs. */
  features: string[];
  notes: string[];
  /** Encyclopaedic description, filled in by the wiki ingest step. */
  description?: string;
  /** Lead image URL from the wiki, when the crawl found one. Presentation only. */
  image?: string;
  wikiPage?: string;
  source: 'curated' | 'wiki' | 'merged';
}

/** A hand-authored note that fires for a specific pairing. */
export interface MatchupNote {
  you: FactionId | SideId | '*';
  enemy: FactionId | SideId | '*';
  advice: string[];
}

export interface Dataset {
  factions: Faction[];
  units: Unit[];
  maps: GameMap[];
  matchups: MatchupNote[];
  /** Provenance summary, surfaced in the CLI so data origin is never implicit. */
  provenance: {
    curatedAt: string;
    wikiCache?: { fetchedAt: string; pages: number; source: string };
    /**
     * What the last crawl attempt did. Recorded even when it failed, so a
     * build that shipped without wiki data can say why rather than leaving
     * "no overlay" to mean both "never ran" and "ran and was refused".
     */
    lastIngest?: IngestStatus;
    /** How the wiki overlay landed: records enriched, and records refused. */
    overlay?: { enriched: number; rejected: number };
  };
}

export interface IngestStatus {
  attemptedAt: string;
  ok: boolean;
  source: string;
  pages?: number;
  /** Failure reason, one line, when ok is false. */
  error?: string;
  /** Curated units that matched a wiki page. */
  matched?: number;
  curatedTotal?: number;
  costCorrections?: number;
}

export interface PlanRequest {
  you?: FactionId;
  enemy?: FactionId;
  difficulty: Difficulty;
  mapId?: string;
  /** Deterministic variety: same seed gives the same suggestion. */
  seed?: number;
}

export interface CounterRecommendation {
  axis: ThreatAxis;
  pressure: number;
  units: Array<{ name: string; cost: number; tier: Tier; why: string }>;
  guidance: string;
}

export interface TimelinePhase {
  label: string;
  window: string;
  objectives: string[];
}

export interface BattlePlan {
  you: Faction;
  enemy: Faction;
  difficulty: Difficulty;
  map?: GameMap;
  /** Populated when the engine, not the user, chose a side. */
  lineupRationale?: string[];
  /** All twelve armies scored against the enemy, best first. */
  lineupRanking?: Array<{ faction: Faction; score: number; why: string }>;
  headline: string;
  buildOrder: string[];
  counters: CounterRecommendation[];
  timeline: TimelinePhase[];
  watchFor: string[];
  doNot: string[];
  mapNotes: string[];
  matchupNotes: string[];
}
