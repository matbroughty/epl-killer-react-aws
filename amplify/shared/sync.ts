import type { Clock } from '../../shared/domain/clock.js';
import type { FootballDataProvider } from '../../shared/provider/FootballDataProvider.js';
import { teamCode as fallbackTeamCode } from '../../shared/domain/teamNames.js';
import type { SyncKind } from '../../shared/domain/types.js';
import type { Repository } from './repository.js';

/**
 * Synchronising with the football data provider.
 *
 * Two rules shape this file:
 *
 * 1. **Imported data is stored locally.** Page loads never call
 *    football-data.org; they read DynamoDB. So a provider outage, a rate limit
 *    or an expired token degrades the application to "results are a bit stale",
 *    not "the site is down".
 * 2. **Every attempt is recorded.** Success or failure, a `FootballDataSync` row
 *    is written, so the admin screen can show the last good sync and the last
 *    failure without anyone reading CloudWatch.
 */

export interface SyncOutcome {
  kind: SyncKind;
  status: 'SUCCESS' | 'FAILURE' | 'PARTIAL';
  itemsWritten: number;
  requestCount: number;
  message: string | null;
  startedAt: string;
  finishedAt: string;
  seasonId?: string | null;
  matchday?: number | null;
}

interface SyncContext {
  repository: Repository;
  provider: FootballDataProvider;
  clock: Clock;
  trigger: 'SCHEDULE' | 'ADMIN';
}

/**
 * Run one sync operation, recording the attempt whatever happens.
 *
 * The provider error is swallowed into a `FAILURE` row rather than thrown,
 * because a failed sync is a normal operating condition for a free API tier —
 * the caller carries on with whatever else it was doing.
 */
async function withSyncRecord(
  context: SyncContext,
  kind: SyncKind,
  details: { seasonId?: string | null; matchday?: number | null },
  work: () => Promise<{ itemsWritten: number; message?: string | null }>,
): Promise<SyncOutcome> {
  const startedAt = context.clock.nowIso();
  const before = context.provider.requestCount();

  let outcome: SyncOutcome;
  try {
    const { itemsWritten, message } = await work();
    outcome = {
      kind,
      status: 'SUCCESS',
      itemsWritten,
      requestCount: context.provider.requestCount() - before,
      message: message ?? null,
      startedAt,
      finishedAt: context.clock.nowIso(),
      ...details,
    };
  } catch (error) {
    outcome = {
      kind,
      status: 'FAILURE',
      itemsWritten: 0,
      requestCount: context.provider.requestCount() - before,
      message: error instanceof Error ? error.message : String(error),
      startedAt,
      finishedAt: context.clock.nowIso(),
      ...details,
    };
    console.error(`Sync ${kind} failed`, error);
  }

  await context.repository.models.FootballDataSync.create({
    kind: outcome.kind,
    trigger: context.trigger,
    status: outcome.status,
    startedAt: outcome.startedAt,
    finishedAt: outcome.finishedAt,
    message: outcome.message,
    itemsWritten: outcome.itemsWritten,
    requestCount: outcome.requestCount,
    seasonId: details.seasonId ?? null,
    matchday: details.matchday ?? null,
  });

  return outcome;
}

// ---------------------------------------------------------------------------
// Competition metadata
// ---------------------------------------------------------------------------

/** Refresh the season's provider ids and current matchday. */
export async function syncCompetition(
  context: SyncContext,
  seasonId: string,
): Promise<SyncOutcome> {
  return withSyncRecord(context, 'COMPETITION', { seasonId }, async () => {
    const competition = await context.provider.getCompetition();
    await context.repository.models.Season.update({
      id: seasonId,
      providerCompetitionCode: competition.code,
      providerSeasonId: competition.seasonId,
      currentMatchday: competition.currentMatchday,
    });
    return {
      itemsWritten: 1,
      message: `Current matchday ${competition.currentMatchday ?? 'unknown'}.`,
    };
  });
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/**
 * Import the season's teams.
 *
 * Matched on `providerId` so re-running updates rather than duplicating. Teams
 * that disappear from the provider's list are marked inactive rather than
 * deleted — a relegated club still appears in last season's selection history.
 */
export async function syncTeams(context: SyncContext, seasonId: string): Promise<SyncOutcome> {
  return withSyncRecord(context, 'TEAMS', { seasonId }, async () => {
    const season = await context.repository.season(seasonId);
    const providerTeams = await context.provider.getTeams(season?.startYear ?? undefined);
    const existing = await context.repository.teams(seasonId);
    const byProviderId = new Map(
      existing.flatMap((team) => (team.providerId ? [[team.providerId, team]] : [])),
    );

    let written = 0;

    for (const providerTeam of providerTeams) {
      const match = byProviderId.get(providerTeam.providerId);
      const fields = {
        seasonId,
        providerId: providerTeam.providerId,
        name: providerTeam.name,
        shortName: providerTeam.shortName,
        code: providerTeam.code || fallbackTeamCode(providerTeam.name),
        badgeUrl: providerTeam.badgeUrl,
        active: true,
      };

      if (match) {
        await context.repository.models.Team.update({ id: match.id, ...fields });
      } else {
        await context.repository.models.Team.create(fields);
      }
      written += 1;
    }

    const importedIds = new Set(providerTeams.map((team) => team.providerId));
    let deactivated = 0;
    for (const team of existing) {
      if (team.active && team.providerId && !importedIds.has(team.providerId)) {
        await context.repository.models.Team.update({ id: team.id, active: false });
        deactivated += 1;
      }
    }

    return {
      itemsWritten: written,
      message: `${written} team(s) imported${deactivated > 0 ? `, ${deactivated} deactivated` : ''}.`,
    };
  });
}

// ---------------------------------------------------------------------------
// Fixtures and results
// ---------------------------------------------------------------------------

/**
 * Import fixtures. With no `matchday` this pulls the whole season in one
 * request, which is the daily refresh; with one it pulls a single gameweek,
 * which is what result processing needs.
 */
export async function syncFixtures(
  context: SyncContext,
  seasonId: string,
  matchday?: number,
  kind: SyncKind = 'FIXTURES',
): Promise<SyncOutcome> {
  return withSyncRecord(context, kind, { seasonId, matchday: matchday ?? null }, async () => {
    const season = await context.repository.season(seasonId);
    const startYear = season?.startYear ?? undefined;

    const providerFixtures =
      matchday === undefined
        ? await context.provider.getFixtures(startYear)
        : await context.provider.getFixturesForMatchday(matchday, startYear);

    const teams = await context.repository.teams(seasonId);
    const teamByProviderId = new Map(
      teams.flatMap((team) => (team.providerId ? [[team.providerId, team.id]] : [])),
    );

    const existing = await context.repository.fixtures(seasonId, matchday);
    const byProviderMatchId = new Map(
      existing.flatMap((fixture) =>
        fixture.providerMatchId ? [[fixture.providerMatchId, fixture]] : [],
      ),
    );

    let written = 0;
    let skipped = 0;

    for (const providerFixture of providerFixtures) {
      const homeTeamId = teamByProviderId.get(providerFixture.homeProviderTeamId);
      const awayTeamId = teamByProviderId.get(providerFixture.awayProviderTeamId);

      // A fixture we cannot attribute to two known teams is useless and would
      // corrupt result processing. Skip it and say so, rather than guessing.
      if (!homeTeamId || !awayTeamId) {
        skipped += 1;
        continue;
      }

      const fields = {
        seasonId,
        providerMatchId: providerFixture.providerMatchId,
        matchday: providerFixture.matchday,
        utcKickoff: providerFixture.utcKickoff,
        status: providerFixture.status,
        homeTeamId,
        awayTeamId,
        homeGoals: providerFixture.homeGoals,
        awayGoals: providerFixture.awayGoals,
        winner: providerFixture.winner,
        providerLastUpdated: providerFixture.providerLastUpdated,
      };

      const match = byProviderMatchId.get(providerFixture.providerMatchId);
      if (match) {
        await context.repository.models.Fixture.update({ id: match.id, ...fields });
      } else {
        await context.repository.models.Fixture.create(fields);
      }
      written += 1;
    }

    const note = skipped > 0 ? ` ${skipped} skipped: team not in this season.` : '';
    return {
      itemsWritten: written,
      message: `${written} fixture(s) imported${matchday === undefined ? '' : ` for matchday ${matchday}`}.${note}`,
    };
  });
}

/** Results are fixtures again, recorded under their own sync kind. */
export async function syncResults(
  context: SyncContext,
  seasonId: string,
  matchday: number,
): Promise<SyncOutcome> {
  return syncFixtures(context, seasonId, matchday, 'RESULTS');
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

/**
 * Capture the league table.
 *
 * Always creates a new snapshot rather than updating the last one. Snapshots are
 * the evidence behind automatic picks, so they have to be immutable: overwriting
 * one would rewrite the justification for a decision already taken.
 */
export async function syncStandings(
  context: SyncContext,
  seasonId: string,
): Promise<SyncOutcome & { snapshotId: string | null }> {
  let snapshotId: string | null = null;

  const outcome = await withSyncRecord(context, 'STANDINGS', { seasonId }, async () => {
    const season = await context.repository.season(seasonId);
    const standings = await context.provider.getStandings(season?.startYear ?? undefined);

    const teams = await context.repository.teams(seasonId);
    const teamByProviderId = new Map(
      teams.flatMap((team) => (team.providerId ? [[team.providerId, team.id]] : [])),
    );

    const rows = standings.rows.flatMap((row) => {
      const teamId = teamByProviderId.get(row.providerTeamId);
      if (!teamId) return [];
      return [
        {
          teamId,
          providerTeamId: row.providerTeamId,
          position: row.position,
          playedGames: row.playedGames,
          points: row.points,
          goalDifference: row.goalDifference,
        },
      ];
    });

    if (rows.length === 0) {
      throw new Error(
        'Standings contained no rows that map to this season’s teams. Sync teams first.',
      );
    }

    const created = await context.repository.models.StandingsSnapshot.create({
      seasonId,
      matchday: standings.matchday ?? season?.currentMatchday ?? null,
      capturedAt: context.clock.nowIso(),
      source: 'PROVIDER',
      rows,
    });

    snapshotId = created.data?.id ?? null;

    const unmapped = standings.rows.length - rows.length;
    return {
      itemsWritten: rows.length,
      message: `Table captured with ${rows.length} row(s)${unmapped > 0 ? `, ${unmapped} unmapped` : ''}.`,
    };
  });

  return { ...outcome, snapshotId };
}

/**
 * Ensure a usable table exists for a week about to be processed, reusing a
 * recent one rather than spending a request on every tick.
 */
export async function ensureStandingsSnapshot(
  context: SyncContext,
  seasonId: string,
  isFresh: (capturedAt: string | null) => boolean,
): Promise<string | null> {
  const latest = await context.repository.latestSnapshot(seasonId);
  if (latest && isFresh(latest.capturedAt)) return latest.id;

  const outcome = await syncStandings(context, seasonId);
  // A provider failure here is not fatal: fall back to the stale snapshot so
  // automatic picks can still be made from the best table we have.
  return outcome.snapshotId ?? latest?.id ?? null;
}

export type { SyncContext };
