import type { Fixture, FixtureStatus, FixtureWinner, Team } from '@shared/domain/types';
import type { CompetitionView } from '@shared/domain/visibility';
import { clientFor } from './amplify';

/**
 * The frontend's view of the API.
 *
 * Every call goes through a custom query or mutation, because that is where the
 * rules live. The one exception is admin screens, which read models directly —
 * the `ADMIN` group has genuine read access, so there is no reason to funnel
 * those through a Lambda.
 *
 * `a.json()` returns come back as `unknown`, so each wrapper states the shape it
 * expects in one place instead of casting at every call site.
 */

export interface HistoryViewShape {
  rounds: {
    id: string;
    number: number;
    status: string;
    seasonId: string;
    seasonName: string;
    weekCount: number;
    entrantCount: number;
    winnerPlayerId: string | null;
    winnerDisplayName: string | null;
    totalPotPence: number;
    rolloverInPence: number;
    rolloverOutPence: number;
    previousRoundId: string | null;
    dataSource: string;
    startedAt: string | null;
    completedAt: string | null;
    notes: string | null;
  }[];
  players: {
    playerId: string;
    displayName: string;
    roundsEntered: number;
    roundsWon: number;
    totalWinningsPence: number;
    eliminations: number;
    firstWeekEliminations: number;
    autoSelections: number;
    longestSurvivalStreak: number;
    favouriteTeamName: string | null;
    favouriteTeamCount: number;
  }[];
  teamPopularity: { teamName: string; teamCode: string | null; count: number }[];
}

export interface MutationResult {
  ok: boolean;
  reason?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * Unwrap a custom query or mutation result.
 *
 * The parsing step is not optional. Our custom operations declare
 * `.returns(a.json())`, which is AppSync's `AWSJSON` scalar, and AWSJSON
 * serialises the resolver's return value into a JSON **string** on the way out.
 * So the client receives `"{\"rounds\":[...]}"`, not an object, and anything
 * that reaches for a property gets `undefined` — or throws, if it expected an
 * array.
 *
 * Handling it here, once, is the price of returning `a.json()` rather than
 * hand-writing deep GraphQL types for every view. That trade is still worth it
 * — the shapes are defined once in `shared/domain/visibility.ts` and shared by
 * both sides — but it has to be paid exactly here or not at all.
 */
export function unwrap<T>(result: {
  data?: unknown;
  errors?: { message: string }[] | null;
}): T {
  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join('; '));
  }
  if (result.data === null || result.data === undefined) {
    throw new Error('The server returned no data.');
  }

  if (typeof result.data === 'string') {
    try {
      return JSON.parse(result.data) as T;
    } catch {
      // A non-JSON string means the server sent something we did not design
      // for. Fail loudly rather than handing a string to code expecting an
      // object.
      throw new Error('The server returned a malformed response.');
    }
  }

  return result.data as T;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function fetchCompetitionView(
  signedIn: boolean,
  killerRoundId?: string,
): Promise<CompetitionView> {
  const client = clientFor(signedIn);
  const result = await client.queries.getCompetitionView(
    killerRoundId ? { killerRoundId } : {},
  );
  return unwrap<CompetitionView>(result);
}

export async function fetchHistoryView(
  signedIn: boolean,
  seasonId?: string,
): Promise<HistoryViewShape> {
  const client = clientFor(signedIn);
  const result = await client.queries.getHistoryView(seasonId ? { seasonId } : {});
  return unwrap<HistoryViewShape>(result);
}

/**
 * The season's teams, for the pick grid.
 *
 * Read straight from the model: the team list is public reference data, and
 * routing it through a Lambda would buy nothing.
 *
 * Mapped into the domain `Team` rather than cast, because Amplify's generated
 * types make optional fields `T | null | undefined` while the domain uses
 * `T | null`. Normalising here means the shared rule functions never have to
 * think about the difference.
 */
export async function fetchTeams(signedIn: boolean, seasonId: string): Promise<Team[]> {
  const client = clientFor(signedIn);
  const result = await client.models.Team.listTeamsBySeason({ seasonId }, { limit: 200 });
  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join('; '));
  }
  return result.data
    .filter((team) => team.active)
    .map((team) => ({
      id: team.id,
      seasonId: team.seasonId,
      providerId: team.providerId ?? null,
      name: team.name,
      shortName: team.shortName,
      code: team.code,
      badgeUrl: team.badgeUrl ?? null,
      active: team.active,
    }));
}

/** Fixtures for a gameweek, so the grid can show kick-offs and blank weeks. */
export async function fetchFixtures(
  signedIn: boolean,
  seasonId: string,
  matchday: number,
): Promise<Fixture[]> {
  const client = clientFor(signedIn);
  const result = await client.models.Fixture.listFixturesBySeasonAndMatchday(
    { seasonId, matchday: { eq: matchday } },
    { limit: 100 },
  );
  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join('; '));
  }
  return result.data.map((fixture) => ({
    id: fixture.id,
    seasonId: fixture.seasonId,
    providerMatchId: fixture.providerMatchId ?? null,
    matchday: fixture.matchday,
    utcKickoff: fixture.utcKickoff,
    // Anything unrecognised becomes UNKNOWN, which the rules treat as
    // unresolved rather than as a result.
    status: (fixture.status ?? 'UNKNOWN') as FixtureStatus,
    homeTeamId: fixture.homeTeamId,
    awayTeamId: fixture.awayTeamId,
    homeGoals: fixture.homeGoals ?? null,
    awayGoals: fixture.awayGoals ?? null,
    winner: (fixture.winner ?? null) as FixtureWinner | null,
  }));
}

// ---------------------------------------------------------------------------
// Player writes
// ---------------------------------------------------------------------------

export async function submitSelection(
  roundWeekId: string,
  teamId: string,
): Promise<MutationResult> {
  const client = clientFor(true);
  return unwrap<MutationResult>(
    await client.mutations.submitSelection({ roundWeekId, teamId }),
  );
}

export async function markSelfPaid(killerRoundId: string): Promise<MutationResult> {
  const client = clientFor(true);
  return unwrap<MutationResult>(await client.mutations.markSelfPaid({ killerRoundId }));
}
