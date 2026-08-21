import type {
  Fixture,
  KillerRound,
  RoundEntry,
  RoundWeek,
  Selection,
  StandingRow,
  StandingsSnapshot,
  Team,
} from '../types.js';
import { selectionId } from '../types.js';

/**
 * Test builders. Each takes a partial override so a test states only what it
 * cares about, which keeps the rule under test visible instead of buried in
 * twenty lines of setup.
 */

export const SEASON_ID = 'season-2026';

/**
 * Twenty teams, positions 1..20 in the order given. Deliberately a real-looking
 * table so the "lowest position" tests read naturally.
 */
export const TEAM_NAMES = [
  'Liverpool',
  'Arsenal',
  'Manchester City',
  'Chelsea',
  'Newcastle United',
  'Aston Villa',
  'Tottenham Hotspur',
  'Brighton & Hove Albion',
  'Manchester United',
  'Brentford',
  'Fulham',
  'Crystal Palace',
  'Everton',
  'Bournemouth',
  'West Ham United',
  'Nottingham Forest',
  'Wolverhampton Wanderers',
  'Leeds United',
  'Sunderland',
  'Burnley',
] as const;

export function team(overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-1',
    seasonId: SEASON_ID,
    providerId: 1,
    name: 'Arsenal',
    shortName: 'Arsenal',
    code: 'ARS',
    badgeUrl: null,
    active: true,
    ...overrides,
  };
}

/** The twenty teams, ids `team-01`..`team-20`, in table order. */
export function teams(): Team[] {
  return TEAM_NAMES.map((name, index) =>
    team({
      id: teamId(index + 1),
      providerId: index + 1,
      name,
      shortName: name,
      code: name.slice(0, 3).toUpperCase(),
    }),
  );
}

export function teamId(position: number): string {
  return `team-${String(position).padStart(2, '0')}`;
}

/** A full 20-team table where `team-01` is 1st and `team-20` is 20th. */
export function standingsRows(): StandingRow[] {
  return TEAM_NAMES.map((_, index) => ({
    teamId: teamId(index + 1),
    providerTeamId: index + 1,
    position: index + 1,
    playedGames: 10,
    points: 40 - index * 2,
    goalDifference: 20 - index * 2,
  }));
}

export function standingsSnapshot(
  overrides: Partial<StandingsSnapshot> = {},
): StandingsSnapshot {
  return {
    id: 'snapshot-1',
    seasonId: SEASON_ID,
    matchday: 5,
    capturedAt: '2026-08-22T13:00:00.000Z',
    rows: standingsRows(),
    ...overrides,
  };
}

/**
 * Ten fixtures pairing the 20 teams: 1v20, 2v19, ... so every team plays.
 * Kick-offs are spread across the Saturday.
 */
export function fixtures(overrides: { matchday?: number } = {}): Fixture[] {
  const matchday = overrides.matchday ?? 5;
  return Array.from({ length: 10 }, (_, index) => {
    const home = index + 1;
    const away = 20 - index;
    return fixture({
      id: `fixture-${matchday}-${index + 1}`,
      providerMatchId: matchday * 100 + index + 1,
      matchday,
      homeTeamId: teamId(home),
      awayTeamId: teamId(away),
      utcKickoff: `2026-08-22T${String(14 + (index % 4)).padStart(2, '0')}:00:00.000Z`,
    });
  });
}

export function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    id: 'fixture-1',
    seasonId: SEASON_ID,
    providerMatchId: 1,
    matchday: 5,
    utcKickoff: '2026-08-22T14:00:00.000Z',
    status: 'SCHEDULED',
    homeTeamId: teamId(1),
    awayTeamId: teamId(20),
    homeGoals: null,
    awayGoals: null,
    winner: null,
    ...overrides,
  };
}

export function killerRound(overrides: Partial<KillerRound> = {}): KillerRound {
  return {
    id: 'round-4',
    seasonId: SEASON_ID,
    number: 4,
    status: 'ACTIVE',
    entryFeePence: 500,
    rolloverInPence: 0,
    rolloverOutPence: 0,
    winnerPlayerId: null,
    previousRoundId: null,
    ...overrides,
  };
}

export function roundWeek(overrides: Partial<RoundWeek> = {}): RoundWeek {
  return {
    id: 'week-1',
    killerRoundId: 'round-4',
    sequenceNumber: 1,
    matchday: 5,
    deadline: '2026-08-22T14:00:00.000Z',
    status: 'OPEN',
    standingsSnapshotId: null,
    ...overrides,
  };
}

export function roundEntry(overrides: Partial<RoundEntry> = {}): RoundEntry {
  return {
    id: 'entry-mat',
    killerRoundId: 'round-4',
    playerId: 'player-mat',
    status: 'ALIVE',
    paid: false,
    entryFeePence: 500,
    eliminatedRoundWeekId: null,
    ...overrides,
  };
}

export function selection(overrides: Partial<Selection> = {}): Selection {
  const roundWeekId = overrides.roundWeekId ?? 'week-1';
  const roundEntryId = overrides.roundEntryId ?? 'entry-mat';
  return {
    id: selectionId(roundWeekId, roundEntryId),
    roundWeekId,
    roundEntryId,
    playerId: 'player-mat',
    killerRoundId: 'round-4',
    teamId: teamId(1),
    teamName: 'Liverpool',
    teamCode: 'LIV',
    selectionType: 'MANUAL',
    selectedAt: '2026-08-20T10:00:00.000Z',
    lockedAt: null,
    outcome: 'PENDING',
    overridden: false,
    fixtureId: null,
    standingsSnapshotId: null,
    autoReason: null,
    ...overrides,
  };
}
