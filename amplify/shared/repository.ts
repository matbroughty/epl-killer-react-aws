import { collect, unwrap, type KillerClient } from './client.js';

/**
 * Every database read and write the backend performs, in one place.
 *
 * The point of gathering them here is that the planners in `shared/domain/` stay
 * pure: they receive plain objects and return plain intentions, and this file is
 * the only thing that knows about AppSync. It also means the access patterns are
 * visible in one screen, which is how the secondary indexes in
 * `data/resource.ts` were chosen.
 */
export function createRepository(client: KillerClient) {
  const models = client.models;

  return {
    // -----------------------------------------------------------------------
    // Seasons and teams
    // -----------------------------------------------------------------------

    async activeSeason() {
      const seasons = await collect((args) =>
        models.Season.list({ filter: { active: { eq: true } }, ...args }),
      );
      // Newest first, so a stray older active season cannot win.
      return seasons.sort((a, b) => (b.startYear ?? 0) - (a.startYear ?? 0))[0] ?? null;
    },

    async season(id: string) {
      return unwrap(await models.Season.get({ id }));
    },

    async seasons() {
      return collect((args) => models.Season.list(args));
    },

    async teams(seasonId: string) {
      return collect((args) => models.Team.listTeamsBySeason({ seasonId }, args));
    },

    // -----------------------------------------------------------------------
    // Players
    // -----------------------------------------------------------------------

    async players() {
      return collect((args) => models.Player.list(args));
    },

    async player(id: string) {
      return unwrap(await models.Player.get({ id }));
    },

    async playerByCognitoUserId(cognitoUserId: string) {
      const found = await collect((args) =>
        models.Player.listPlayersByCognitoUserId({ cognitoUserId }, args),
      );
      return found[0] ?? null;
    },

    async playerByEmail(email: string) {
      const found = await collect((args) =>
        models.Player.list({ filter: { email: { eq: email } }, ...args }),
      );
      return found[0] ?? null;
    },

    // -----------------------------------------------------------------------
    // Rounds
    // -----------------------------------------------------------------------

    async rounds(seasonId?: string) {
      if (seasonId) {
        return collect((args) => models.KillerRound.listRoundsBySeason({ seasonId }, args));
      }
      return collect((args) => models.KillerRound.list(args));
    },

    async round(id: string) {
      return unwrap(await models.KillerRound.get({ id }));
    },

    /**
     * The round the application should show by default: the active one, or
     * failing that the most recently numbered, so a finished season still has a
     * sensible landing page instead of an empty one.
     */
    async currentRound() {
      const active = await collect((args) =>
        models.KillerRound.listRoundsByStatus({ status: 'ACTIVE' }, args),
      );
      if (active.length > 0) {
        return active.sort((a, b) => b.number - a.number)[0]!;
      }
      const all = await collect((args) => models.KillerRound.list(args));
      const live = all.filter((round) => round.dataSource !== 'LEGACY_CSV');
      const pool = live.length > 0 ? live : all;
      return pool.sort((a, b) => b.number - a.number)[0] ?? null;
    },

    async entries(killerRoundId: string) {
      return collect((args) => models.RoundEntry.listEntriesByRound({ killerRoundId }, args));
    },

    async entriesForPlayer(playerId: string) {
      return collect((args) => models.RoundEntry.listEntriesByPlayer({ playerId }, args));
    },

    async entry(id: string) {
      return unwrap(await models.RoundEntry.get({ id }));
    },

    async weeks(killerRoundId: string) {
      return collect((args) => models.RoundWeek.listWeeksByRound({ killerRoundId }, args));
    },

    async week(id: string) {
      return unwrap(await models.RoundWeek.get({ id }));
    },

    /**
     * Weeks in a given status ordered by deadline. This is the scheduler's hot
     * path: one query per status tells it whether there is anything due.
     */
    async weeksByStatus(status: 'DRAFT' | 'OPEN' | 'LOCKED' | 'RESULTS_PENDING' | 'COMPLETE') {
      return collect((args) =>
        models.RoundWeek.listWeeksByStatusAndDeadline({ status }, args),
      );
    },

    // -----------------------------------------------------------------------
    // Selections
    // -----------------------------------------------------------------------

    async selectionsByWeek(roundWeekId: string) {
      return collect((args) => models.Selection.listSelectionsByWeek({ roundWeekId }, args));
    },

    async selectionsByRound(killerRoundId: string) {
      return collect((args) =>
        models.Selection.listSelectionsByRoundAndPlayer({ killerRoundId }, args),
      );
    },

    async selectionsByEntry(roundEntryId: string) {
      return collect((args) => models.Selection.listSelectionsByEntry({ roundEntryId }, args));
    },

    async selection(id: string) {
      return unwrap(await models.Selection.get({ id }));
    },

    // -----------------------------------------------------------------------
    // Football data
    // -----------------------------------------------------------------------

    async fixtures(seasonId: string, matchday?: number) {
      return collect((args) =>
        models.Fixture.listFixturesBySeasonAndMatchday(
          matchday === undefined ? { seasonId } : { seasonId, matchday: { eq: matchday } },
          args,
        ),
      );
    },

    async snapshot(id: string) {
      return unwrap(await models.StandingsSnapshot.get({ id }));
    },

    /** The most recent table for a season, used to decide whether to refetch. */
    async latestSnapshot(seasonId: string) {
      const page = await models.StandingsSnapshot.listSnapshotsBySeason(
        { seasonId },
        { sortDirection: 'DESC', limit: 1 },
      );
      return page.data[0] ?? null;
    },

    async lastSync(kind: 'TEAMS' | 'FIXTURES' | 'STANDINGS' | 'RESULTS' | 'COMPETITION') {
      const page = await models.FootballDataSync.listSyncsByKind(
        { kind },
        { sortDirection: 'DESC', limit: 1 },
      );
      return page.data[0] ?? null;
    },

    async recentSyncs(limit = 25) {
      const page = await models.FootballDataSync.list({ limit });
      return [...page.data].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },

    async recentAudit(limit = 100) {
      const page = await models.AdminAuditEvent.list({ limit });
      return [...page.data].sort((a, b) => b.at.localeCompare(a.at));
    },

    /** Direct access, for the handful of writes not worth wrapping. */
    models,
  };
}

export type Repository = ReturnType<typeof createRepository>;
