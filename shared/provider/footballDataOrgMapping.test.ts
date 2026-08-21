import { describe, expect, it } from 'vitest';
import {
  mapCompetition,
  mapFixture,
  mapFixtureStatus,
  mapFixtures,
  mapStandings,
  mapTeams,
  mapWinner,
} from './footballDataOrgMapping.js';

/**
 * Payloads shaped as football-data.org v4 documents them. The point of these
 * tests is that the rest of the application never sees `homeTeam.tla` or
 * `score.winner === 'HOME_TEAM'` — swapping provider means rewriting only this
 * mapping and its fixtures.
 */

const MATCH_PAYLOAD = {
  id: 497_853,
  utcDate: '2026-08-22T14:00:00Z',
  status: 'FINISHED',
  matchday: 5,
  stage: 'REGULAR_SEASON',
  homeTeam: { id: 57, name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS', crest: 'https://crests.football-data.org/57.png' },
  awayTeam: { id: 61, name: 'Chelsea FC', shortName: 'Chelsea', tla: 'CHE', crest: 'https://crests.football-data.org/61.png' },
  score: {
    winner: 'HOME_TEAM',
    duration: 'REGULAR',
    fullTime: { home: 2, away: 1 },
    halfTime: { home: 1, away: 0 },
  },
  season: { id: 2_411, startDate: '2026-08-14', endDate: '2027-05-23' },
  lastUpdated: '2026-08-22T16:05:11Z',
};

describe('mapFixtureStatus', () => {
  it.each([
    ['SCHEDULED', 'SCHEDULED'],
    ['TIMED', 'TIMED'],
    ['IN_PLAY', 'IN_PLAY'],
    ['PAUSED', 'PAUSED'],
    ['FINISHED', 'FINISHED'],
    ['AWARDED', 'AWARDED'],
    ['POSTPONED', 'POSTPONED'],
    ['SUSPENDED', 'SUSPENDED'],
    ['CANCELLED', 'CANCELLED'],
  ] as const)('maps %s to %s', (input, expected) => {
    expect(mapFixtureStatus(input)).toBe(expected);
  });

  it('accepts the American spelling as cancelled', () => {
    expect(mapFixtureStatus('CANCELED')).toBe('CANCELLED');
  });

  it('maps anything unrecognised to UNKNOWN rather than guessing', () => {
    // The consequence, tested in outcomes.test.ts, is that nobody is eliminated
    // because the provider invented a new status.
    expect(mapFixtureStatus('EXTRA_TIME')).toBe('UNKNOWN');
    expect(mapFixtureStatus(null)).toBe('UNKNOWN');
    expect(mapFixtureStatus(42)).toBe('UNKNOWN');
    expect(mapFixtureStatus(undefined)).toBe('UNKNOWN');
  });

  it('is case-insensitive', () => {
    expect(mapFixtureStatus('finished')).toBe('FINISHED');
  });
});

describe('mapWinner', () => {
  it('maps the provider vocabulary to ours', () => {
    expect(mapWinner('HOME_TEAM')).toBe('HOME');
    expect(mapWinner('AWAY_TEAM')).toBe('AWAY');
    expect(mapWinner('DRAW')).toBe('DRAW');
  });

  it('returns null for an unplayed match or an unknown value', () => {
    expect(mapWinner(null)).toBeNull();
    expect(mapWinner('PENALTIES')).toBeNull();
  });
});

describe('mapFixture', () => {
  it('maps a finished match into our shape', () => {
    expect(mapFixture(MATCH_PAYLOAD)).toEqual({
      providerMatchId: 497_853,
      matchday: 5,
      utcKickoff: '2026-08-22T14:00:00.000Z',
      status: 'FINISHED',
      homeProviderTeamId: 57,
      awayProviderTeamId: 61,
      homeGoals: 2,
      awayGoals: 1,
      winner: 'HOME',
      providerLastUpdated: '2026-08-22T16:05:11Z',
    });
  });

  it('normalises the kick-off to an ISO instant with milliseconds', () => {
    expect(mapFixture(MATCH_PAYLOAD)!.utcKickoff).toBe('2026-08-22T14:00:00.000Z');
  });

  it('keeps a scheduled match with no score', () => {
    const scheduled = {
      ...MATCH_PAYLOAD,
      status: 'TIMED',
      score: { winner: null, fullTime: { home: null, away: null } },
    };
    expect(mapFixture(scheduled)).toMatchObject({
      status: 'TIMED',
      homeGoals: null,
      awayGoals: null,
      winner: null,
    });
  });

  it('marks a match with no matchday as -1 so it can never match a Round Week', () => {
    const cupTie = { ...MATCH_PAYLOAD, matchday: null };
    expect(mapFixture(cupTie)!.matchday).toBe(-1);
  });

  it('rejects a match missing its id, date or a team', () => {
    expect(mapFixture({ ...MATCH_PAYLOAD, id: null })).toBeNull();
    expect(mapFixture({ ...MATCH_PAYLOAD, utcDate: null })).toBeNull();
    expect(mapFixture({ ...MATCH_PAYLOAD, homeTeam: {} })).toBeNull();
    expect(mapFixture({ ...MATCH_PAYLOAD, awayTeam: null })).toBeNull();
  });

  it('survives complete rubbish without throwing', () => {
    for (const junk of [null, undefined, 'nope', 42, [], {}]) {
      expect(mapFixture(junk)).toBeNull();
    }
  });
});

describe('mapFixtures', () => {
  it('maps the matches envelope and drops unusable entries', () => {
    const payload = {
      filters: { season: '2026' },
      resultSet: { count: 2 },
      matches: [MATCH_PAYLOAD, { ...MATCH_PAYLOAD, id: null }],
    };
    const fixtures = mapFixtures(payload);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]!.providerMatchId).toBe(497_853);
  });

  it('returns an empty array for a missing or malformed envelope', () => {
    expect(mapFixtures({})).toEqual([]);
    expect(mapFixtures({ matches: 'not an array' })).toEqual([]);
    expect(mapFixtures(null)).toEqual([]);
  });
});

describe('mapTeams', () => {
  const payload = {
    count: 2,
    teams: [
      { id: 57, name: 'Arsenal FC', shortName: 'Arsenal', tla: 'ARS', crest: 'https://crests.football-data.org/57.png' },
      { id: 65, name: 'Manchester City FC', shortName: 'Man City', tla: 'MCI', crest: null },
    ],
  };

  it('maps id, names, three-letter code and badge', () => {
    expect(mapTeams(payload)).toEqual([
      { providerId: 57, name: 'Arsenal FC', shortName: 'Arsenal', code: 'ARS', badgeUrl: 'https://crests.football-data.org/57.png' },
      { providerId: 65, name: 'Manchester City FC', shortName: 'Man City', code: 'MCI', badgeUrl: null },
    ]);
  });

  it('derives a code when the provider omits the abbreviation', () => {
    const withoutTla = { teams: [{ id: 1, name: 'Brentford FC', shortName: 'Brentford' }] };
    expect(mapTeams(withoutTla)[0]!.code).toBe('BRE');
  });

  it('falls back to the full name when shortName is missing', () => {
    const withoutShortName = { teams: [{ id: 1, name: 'Fulham FC', tla: 'FUL' }] };
    expect(mapTeams(withoutShortName)[0]!.shortName).toBe('Fulham FC');
  });

  it('drops a team with no id or no name', () => {
    expect(mapTeams({ teams: [{ id: null, name: 'Ghost' }, { id: 9 }] })).toEqual([]);
  });
});

describe('mapCompetition', () => {
  it('maps the current season and matchday', () => {
    const payload = {
      id: 2_021,
      name: 'Premier League',
      code: 'PL',
      currentSeason: {
        id: 2_411,
        startDate: '2026-08-14',
        endDate: '2027-05-23',
        currentMatchday: 5,
      },
    };

    expect(mapCompetition(payload)).toEqual({
      code: 'PL',
      name: 'Premier League',
      seasonId: 2_411,
      startYear: 2026,
      startDate: '2026-08-14',
      endDate: '2027-05-23',
      currentMatchday: 5,
    });
  });

  it('defaults sensibly when the payload is thin', () => {
    expect(mapCompetition({})).toEqual({
      code: 'PL',
      name: 'Premier League',
      seasonId: null,
      startYear: null,
      startDate: null,
      endDate: null,
      currentMatchday: null,
    });
  });
});

describe('mapStandings', () => {
  const payload = {
    season: { id: 2_411, currentMatchday: 5 },
    standings: [
      {
        stage: 'REGULAR_SEASON',
        type: 'TOTAL',
        table: [
          { position: 1, team: { id: 64, name: 'Liverpool FC' }, playedGames: 5, points: 15, goalDifference: 9 },
          { position: 20, team: { id: 328, name: 'Burnley FC' }, playedGames: 5, points: 1, goalDifference: -10 },
        ],
      },
      { stage: 'REGULAR_SEASON', type: 'HOME', table: [{ position: 1, team: { id: 57 } }] },
    ],
  };

  it('takes the TOTAL table, not HOME or AWAY', () => {
    const standings = mapStandings(payload);
    expect(standings.rows).toEqual([
      { providerTeamId: 64, position: 1, playedGames: 5, points: 15, goalDifference: 9 },
      { providerTeamId: 328, position: 20, playedGames: 5, points: 1, goalDifference: -10 },
    ]);
  });

  it('records the matchday the table reflects', () => {
    expect(mapStandings(payload).matchday).toBe(5);
  });

  it('falls back to the first table when no type is marked TOTAL', () => {
    const untyped = { standings: [{ table: [{ position: 1, team: { id: 64 } }] }] };
    expect(mapStandings(untyped).rows).toHaveLength(1);
  });

  it('drops rows with no team id or position', () => {
    const partial = {
      standings: [{ type: 'TOTAL', table: [{ position: 1, team: {} }, { team: { id: 5 } }] }],
    };
    expect(mapStandings(partial).rows).toEqual([]);
  });

  it('returns an empty table rather than throwing on rubbish', () => {
    expect(mapStandings(null)).toEqual({ matchday: null, rows: [] });
    expect(mapStandings({ standings: 'nope' })).toEqual({ matchday: null, rows: [] });
  });

  it('defaults missing numeric columns to zero', () => {
    const sparse = { standings: [{ type: 'TOTAL', table: [{ position: 3, team: { id: 7 } }] }] };
    expect(mapStandings(sparse).rows[0]).toEqual({
      providerTeamId: 7,
      position: 3,
      playedGames: 0,
      points: 0,
      goalDifference: 0,
    });
  });
});
