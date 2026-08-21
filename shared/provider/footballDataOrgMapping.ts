import type { FixtureStatus, FixtureWinner } from '../domain/types.js';
import type {
  ProviderCompetition,
  ProviderFixture,
  ProviderStandings,
  ProviderTeam,
} from './FootballDataProvider.js';

/**
 * Mapping from football-data.org v4 responses into our domain shapes.
 *
 * Kept separate from the HTTP client so it can be tested against captured
 * payloads without a network call, and so the next provider only needs a new
 * mapping file.
 *
 * Everything here is defensive: the input is JSON from someone else's server,
 * so fields are read as `unknown` and coerced, and anything unrecognised
 * degrades to `null` or `UNKNOWN` rather than throwing. A malformed payload
 * must not be able to eliminate a player.
 */

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// Enum mapping
// ---------------------------------------------------------------------------

/**
 * football-data.org's documented status vocabulary. Anything outside this set
 * maps to `UNKNOWN`, which our outcome rules treat as unresolved.
 */
const STATUS_MAP: Record<string, FixtureStatus> = {
  SCHEDULED: 'SCHEDULED',
  TIMED: 'TIMED',
  IN_PLAY: 'IN_PLAY',
  PAUSED: 'PAUSED',
  FINISHED: 'FINISHED',
  AWARDED: 'AWARDED',
  POSTPONED: 'POSTPONED',
  SUSPENDED: 'SUSPENDED',
  CANCELLED: 'CANCELLED',
  // Seen historically; treated as cancelled since it will not be played.
  CANCELED: 'CANCELLED',
};

export function mapFixtureStatus(value: unknown): FixtureStatus {
  const key = asString(value)?.toUpperCase();
  if (!key) return 'UNKNOWN';
  return STATUS_MAP[key] ?? 'UNKNOWN';
}

const WINNER_MAP: Record<string, FixtureWinner> = {
  HOME_TEAM: 'HOME',
  AWAY_TEAM: 'AWAY',
  DRAW: 'DRAW',
};

export function mapWinner(value: unknown): FixtureWinner | null {
  const key = asString(value)?.toUpperCase();
  if (!key) return null;
  return WINNER_MAP[key] ?? null;
}

// ---------------------------------------------------------------------------
// Entity mapping
// ---------------------------------------------------------------------------

export function mapCompetition(payload: unknown): ProviderCompetition {
  const root = asRecord(payload);
  const currentSeason = asRecord(root['currentSeason']);
  const startDate = asString(currentSeason['startDate']);

  return {
    code: asString(root['code']) ?? 'PL',
    name: asString(root['name']) ?? 'Premier League',
    seasonId: asNumber(currentSeason['id']),
    // football-data.org has no explicit start year; derive it from the season
    // start date, which is what its own `?season=` parameter expects.
    startYear: startDate ? Number(startDate.slice(0, 4)) : null,
    startDate,
    endDate: asString(currentSeason['endDate']),
    currentMatchday: asNumber(currentSeason['currentMatchday']),
  };
}

export function mapTeams(payload: unknown): ProviderTeam[] {
  return asArray(asRecord(payload)['teams']).flatMap((raw) => {
    const team = asRecord(raw);
    const providerId = asNumber(team['id']);
    const name = asString(team['name']);
    if (providerId === null || name === null) return [];

    const shortName = asString(team['shortName']) ?? name;
    // `tla` is football-data.org's three-letter abbreviation.
    const code = asString(team['tla']) ?? shortName.slice(0, 3).toUpperCase();

    return [
      {
        providerId,
        name,
        shortName,
        code: code.toUpperCase(),
        badgeUrl: asString(team['crest']),
      },
    ];
  });
}

export function mapFixture(raw: unknown): ProviderFixture | null {
  const match = asRecord(raw);
  const providerMatchId = asNumber(match['id']);
  const utcKickoff = asString(match['utcDate']);
  const homeProviderTeamId = asNumber(asRecord(match['homeTeam'])['id']);
  const awayProviderTeamId = asNumber(asRecord(match['awayTeam'])['id']);

  // Without these four a fixture is useless to us. A cup tie against a team
  // outside the competition, for instance, has a null team id.
  if (
    providerMatchId === null ||
    utcKickoff === null ||
    homeProviderTeamId === null ||
    awayProviderTeamId === null
  ) {
    return null;
  }

  const score = asRecord(match['score']);
  const fullTime = asRecord(score['fullTime']);

  return {
    providerMatchId,
    // A null matchday (cup rounds, play-offs) is not a league gameweek; `-1`
    // keeps the record importable while never matching a Round Week.
    matchday: asNumber(match['matchday']) ?? -1,
    utcKickoff: new Date(utcKickoff).toISOString(),
    status: mapFixtureStatus(match['status']),
    homeProviderTeamId,
    awayProviderTeamId,
    homeGoals: asNumber(fullTime['home']),
    awayGoals: asNumber(fullTime['away']),
    winner: mapWinner(score['winner']),
    providerLastUpdated: asString(match['lastUpdated']),
  };
}

export function mapFixtures(payload: unknown): ProviderFixture[] {
  return asArray(asRecord(payload)['matches']).flatMap((raw) => {
    const fixture = mapFixture(raw);
    return fixture ? [fixture] : [];
  });
}

export function mapStandings(payload: unknown): ProviderStandings {
  const root = asRecord(payload);

  // The endpoint returns several tables (TOTAL, HOME, AWAY). We want the
  // overall one, which is the `TOTAL` type in the `REGULAR_SEASON` stage.
  const tables = asArray(root['standings']);
  const total =
    tables.find((table) => asString(asRecord(table)['type'])?.toUpperCase() === 'TOTAL') ??
    tables[0];

  const rows = asArray(asRecord(total)['table']).flatMap((raw) => {
    const entry = asRecord(raw);
    const providerTeamId = asNumber(asRecord(entry['team'])['id']);
    const position = asNumber(entry['position']);
    if (providerTeamId === null || position === null) return [];

    return [
      {
        providerTeamId,
        position,
        playedGames: asNumber(entry['playedGames']) ?? 0,
        points: asNumber(entry['points']) ?? 0,
        goalDifference: asNumber(entry['goalDifference']) ?? 0,
      },
    ];
  });

  return {
    matchday: asNumber(asRecord(root['season'])['currentMatchday']),
    rows,
  };
}
