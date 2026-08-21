/**
 * Domain types for the Killer competition.
 *
 * These are OUR types. Nothing in this folder may import from AWS, from React,
 * or from a football data provider's response shapes. Everything here is pure
 * data plus pure functions, so the rules that decide who is eliminated and who
 * gets the money can be tested without deploying anything.
 */

// ---------------------------------------------------------------------------
// Identifiers and money
// ---------------------------------------------------------------------------

/** Amounts are always integer pence. Never floating-point pounds. */
export type Pence = number;

/** ISO-8601 instant in UTC, e.g. `2026-08-22T14:00:00.000Z`. */
export type IsoInstant = string;

// ---------------------------------------------------------------------------
// Enumerations (kept as string unions so they serialise cleanly to GraphQL)
// ---------------------------------------------------------------------------

export const KILLER_ROUND_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'WON',
  'ROLLOVER',
  'ABANDONED',
] as const;
export type KillerRoundStatus = (typeof KILLER_ROUND_STATUSES)[number];

export const ROUND_ENTRY_STATUSES = ['ALIVE', 'ELIMINATED', 'WINNER'] as const;
export type RoundEntryStatus = (typeof ROUND_ENTRY_STATUSES)[number];

export const ROUND_WEEK_STATUSES = [
  'DRAFT',
  'OPEN',
  'LOCKED',
  'RESULTS_PENDING',
  'COMPLETE',
] as const;
export type RoundWeekStatus = (typeof ROUND_WEEK_STATUSES)[number];

export const SELECTION_TYPES = [
  'MANUAL',
  'AUTO_LOWEST_POSITION',
  'ADMIN',
  'LEGACY',
] as const;
export type SelectionType = (typeof SELECTION_TYPES)[number];

/**
 * Note there is no `OVERRIDDEN` outcome. An override still has to say whether
 * the player lived or died, so "was this overridden" is a separate boolean on
 * the selection and the outcome stays unambiguous. `UNKNOWN` exists only for
 * legacy CSV rows whose fate could not be inferred.
 */
export const SELECTION_OUTCOMES = [
  'PENDING',
  'SURVIVED',
  'ELIMINATED',
  'UNKNOWN',
] as const;
export type SelectionOutcome = (typeof SELECTION_OUTCOMES)[number];

/**
 * Fixture states we understand. Mirrors football-data.org's vocabulary because
 * it is a reasonable superset, but it is our enum: providers are mapped into
 * it, never the other way round. `UNKNOWN` exists so an unrecognised provider
 * value degrades to "we cannot tell yet" instead of eliminating somebody.
 */
export const FIXTURE_STATUSES = [
  'SCHEDULED',
  'TIMED',
  'IN_PLAY',
  'PAUSED',
  'FINISHED',
  'AWARDED',
  'POSTPONED',
  'SUSPENDED',
  'CANCELLED',
  'UNKNOWN',
] as const;
export type FixtureStatus = (typeof FIXTURE_STATUSES)[number];

export type FixtureWinner = 'HOME' | 'AWAY' | 'DRAW';

export const DEADLINE_SOURCES = ['FIRST_FIXTURE', 'MANUAL'] as const;
export type DeadlineSource = (typeof DEADLINE_SOURCES)[number];

export const DATA_SOURCES = ['LIVE', 'LEGACY_CSV'] as const;
export type DataSource = (typeof DATA_SOURCES)[number];

export const SYNC_KINDS = [
  'TEAMS',
  'FIXTURES',
  'STANDINGS',
  'RESULTS',
  'COMPETITION',
] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

export const SYNC_STATUSES = ['SUCCESS', 'FAILURE', 'PARTIAL'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/**
 * Why an automatic selection ended up as it did. Persisted so a pick can be
 * audited years later without re-deriving it from a table that has moved on.
 */
export const AUTO_REASONS = [
  'AUTO_LOWEST_POSITION',
  'AUTO_NO_ELIGIBLE_TEAM',
] as const;
export type AutoReason = (typeof AUTO_REASONS)[number];

// ---------------------------------------------------------------------------
// Entities, as the domain layer sees them
// ---------------------------------------------------------------------------

export interface Team {
  id: string;
  seasonId: string;
  providerId: number | null;
  name: string;
  shortName: string;
  /** Three-letter code, e.g. `ARS`. */
  code: string;
  badgeUrl: string | null;
  active: boolean;
}

export interface Player {
  id: string;
  displayName: string;
  active: boolean;
}

export interface KillerRound {
  id: string;
  seasonId: string;
  number: number;
  status: KillerRoundStatus;
  entryFeePence: Pence;
  rolloverInPence: Pence;
  rolloverOutPence: Pence;
  winnerPlayerId: string | null;
  previousRoundId: string | null;
}

export interface RoundEntry {
  id: string;
  killerRoundId: string;
  playerId: string;
  status: RoundEntryStatus;
  paid: boolean;
  /**
   * The fee this entrant incurred, captured when they entered. The expected pot
   * is the sum of these, whether or not `paid` is true.
   */
  entryFeePence: Pence;
  eliminatedRoundWeekId: string | null;
}

export interface RoundWeek {
  id: string;
  killerRoundId: string;
  sequenceNumber: number;
  /** EPL matchday. Null only for legacy imported weeks. */
  matchday: number | null;
  /** Null only for legacy imported weeks, which are never open. */
  deadline: IsoInstant | null;
  status: RoundWeekStatus;
  standingsSnapshotId: string | null;
}

export interface Selection {
  id: string;
  roundWeekId: string;
  roundEntryId: string;
  playerId: string;
  killerRoundId: string;
  teamId: string | null;
  /** Denormalised so relegated and legacy teams still render in history. */
  teamName: string | null;
  teamCode: string | null;
  selectionType: SelectionType;
  selectedAt: IsoInstant;
  lockedAt: IsoInstant | null;
  outcome: SelectionOutcome;
  /** True once an administrator has set the team or outcome by hand. */
  overridden: boolean;
  fixtureId: string | null;
  standingsSnapshotId: string | null;
  autoReason: AutoReason | null;
}

export interface Fixture {
  id: string;
  seasonId: string;
  providerMatchId: number | null;
  matchday: number;
  utcKickoff: IsoInstant;
  status: FixtureStatus;
  homeTeamId: string;
  awayTeamId: string;
  homeGoals: number | null;
  awayGoals: number | null;
  winner: FixtureWinner | null;
}

export interface StandingRow {
  teamId: string;
  providerTeamId: number | null;
  /** 1 = top of the table, 20 = bottom. */
  position: number;
  playedGames: number;
  points: number;
  goalDifference: number;
}

export interface StandingsSnapshot {
  id: string;
  seasonId: string;
  matchday: number | null;
  capturedAt: IsoInstant;
  rows: StandingRow[];
}

/** Composite id used for `Selection.id`, making one-pick-per-week a DB constraint. */
export function selectionId(roundWeekId: string, roundEntryId: string): string {
  return `${roundWeekId}#${roundEntryId}`;
}
