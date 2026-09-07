import { unwrap, type MutationResult } from './api';
import { authedClient } from './amplify';

/**
 * Administrative API.
 *
 * Mutations go through custom operations, because each one has a rule to enforce
 * or an audit entry to write. Reads go straight to the models, because the
 * `ADMIN` group genuinely has read access and putting a Lambda in front of a
 * list query would buy nothing.
 *
 * Every one of these is authorized by AppSync against the `ADMIN` group before
 * it reaches the Lambda, and re-checked inside it.
 */

function unwrapList<T>(result: { data: T[]; errors?: { message: string }[] | null }): T[] {
  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join('; '));
  }
  return result.data;
}

/** Mutations return `{ ok: false, reason }` rather than throwing; surface both. */
function assertOk(result: MutationResult): MutationResult {
  if (!result.ok) throw new Error(result.message ?? result.reason ?? 'The operation failed.');
  return result;
}

// --------------------------------------------------------------------- reads

export const adminReads = {
  seasons: () => authedClient.models.Season.list({ limit: 50 }).then(unwrapList),

  teams: (seasonId: string) =>
    authedClient.models.Team.listTeamsBySeason({ seasonId }, { limit: 200 }).then(unwrapList),

  players: () => authedClient.models.Player.list({ limit: 200 }).then(unwrapList),

  rounds: () => authedClient.models.KillerRound.list({ limit: 200 }).then(unwrapList),

  entries: (killerRoundId: string) =>
    authedClient.models.RoundEntry.listEntriesByRound({ killerRoundId }, { limit: 200 }).then(
      unwrapList,
    ),

  weeks: (killerRoundId: string) =>
    authedClient.models.RoundWeek.listWeeksByRound({ killerRoundId }, { limit: 100 }).then(
      unwrapList,
    ),

  selections: (roundWeekId: string) =>
    authedClient.models.Selection.listSelectionsByWeek({ roundWeekId }, { limit: 200 }).then(
      unwrapList,
    ),

  fixtures: (seasonId: string, matchday?: number) =>
    authedClient.models.Fixture.listFixturesBySeasonAndMatchday(
      matchday === undefined ? { seasonId } : { seasonId, matchday: { eq: matchday } },
      { limit: 400 },
    ).then(unwrapList),

  syncs: () => authedClient.models.FootballDataSync.list({ limit: 40 }).then(unwrapList),

  audit: () => authedClient.models.AdminAuditEvent.list({ limit: 100 }).then(unwrapList),

  snapshots: (seasonId: string) =>
    authedClient.models.StandingsSnapshot.listSnapshotsBySeason(
      { seasonId },
      { limit: 10, sortDirection: 'DESC' },
    ).then(unwrapList),
};

// ----------------------------------------------------------- direct creation
//
// Seasons and rounds are plain records with no business rule beyond "an admin
// asked for it", so they are created directly rather than through a mutation.

export async function createSeason(input: {
  name: string;
  startYear: number;
  active: boolean;
}) {
  return unwrap(
    await authedClient.models.Season.create({
      ...input,
      providerCompetitionCode: 'PL',
      isLegacy: false,
    }),
  );
}

export async function setActiveSeason(seasonId: string, seasons: { id: string }[]) {
  // Only one season is active at a time, so clear the others.
  for (const season of seasons) {
    if (season.id !== seasonId) {
      await authedClient.models.Season.update({ id: season.id, active: false });
    }
  }
  return unwrap(await authedClient.models.Season.update({ id: seasonId, active: true }));
}

export async function createRound(input: {
  seasonId: string;
  number: number;
  entryFeePence: number;
  rolloverInPence: number;
  previousRoundId?: string | null;
}) {
  return unwrap(
    await authedClient.models.KillerRound.create({
      ...input,
      previousRoundId: input.previousRoundId ?? null,
      status: 'DRAFT',
      rolloverOutPence: 0,
      dataSource: 'LIVE',
    }),
  );
}

export async function updateRound(input: {
  id: string;
  entryFeePence?: number;
  rolloverInPence?: number;
  previousRoundId?: string | null;
  notes?: string | null;
}) {
  return unwrap(await authedClient.models.KillerRound.update(input));
}

/** Notification preference: a display setting, so no mutation or audit needed. */
export async function setPlayerNotify(playerId: string, notifyByEmail: boolean) {
  return unwrap(await authedClient.models.Player.update({ id: playerId, notifyByEmail }));
}

export async function updateWeekDeadline(roundWeekId: string, deadline: string) {
  return unwrap(
    await authedClient.models.RoundWeek.update({
      id: roundWeekId,
      deadline,
      deadlineSource: 'MANUAL',
    }),
  );
}

// ----------------------------------------------------------------- mutations

export const adminMutations = {
  invitePlayer: (input: {
    displayName: string;
    email: string;
    makeAdmin?: boolean;
    sendInvite?: boolean;
  }) =>
    authedClient.mutations
      .adminInvitePlayer(input)
      .then((result) => assertOk(unwrap<MutationResult>(result))),

  setPassword: (playerId: string, password: string, permanent: boolean) =>
    authedClient.mutations
      .adminSetPassword({ playerId, password, permanent })
      .then((result) => assertOk(unwrap<MutationResult>(result))),

  setPlayerActive: (playerId: string, active: boolean) =>
    authedClient.mutations
      .adminSetPlayerActive({ playerId, active })
      .then((result) => assertOk(unwrap<MutationResult>(result))),

  setPaid: (roundEntryId: string, paid: boolean) =>
    authedClient.mutations
      .adminSetPaid({ roundEntryId, paid })
      .then((result) => assertOk(unwrap<MutationResult>(result))),

  submitSelectionFor: (input: {
    roundWeekId: string;
    playerId: string;
    teamId: string;
    allowAfterDeadline?: boolean;
  }) =>
    authedClient.mutations
      .adminSubmitSelectionFor(input)
      .then((result) => assertOk(unwrap<MutationResult>(result))),

  setEntrant: (killerRoundId: string, playerId: string, entered: boolean) =>
    authedClient.mutations
      .adminSetEntrant({ killerRoundId, playerId, entered })
      .then((result) => assertOk(unwrap<MutationResult>(result))),

  startRound: (killerRoundId: string, playerIds?: string[]) =>
    authedClient.mutations
      .adminStartRound({ killerRoundId, playerIds: playerIds ?? null })
      .then((result) => assertOk(unwrap<MutationResult>(result))),

  reopenRound: (killerRoundId: string, note?: string) =>
    authedClient.mutations
      .adminReopenRound({ killerRoundId, note: note ?? null })
      .then((result) => assertOk(unwrap<MutationResult>(result))),

  deleteRound: (killerRoundId: string, note?: string) =>
    authedClient.mutations
      .adminDeleteRound({ killerRoundId, note: note ?? null })
      .then((result) => assertOk(unwrap<MutationResult>(result))),

  completeRound: (input: {
    killerRoundId: string;
    resolution: 'WON' | 'ROLLOVER' | 'ABANDONED';
    winnerPlayerId?: string | null;
    note?: string | null;
  }) =>
    authedClient.mutations
      .adminCompleteRound(input)
      .then((result) => assertOk(unwrap<MutationResult>(result))),

  createRoundWeek: (input: {
    killerRoundId: string;
    matchday: number;
    deadline?: string | null;
    open?: boolean;
  }) =>
    authedClient.mutations
      .adminCreateRoundWeek(input)
      .then((result) => assertOk(unwrap<MutationResult>(result))),

  setWeekStatus: (roundWeekId: string, status: string) =>
    authedClient.mutations
      .adminSetWeekStatus({ roundWeekId, status })
      .then((result) => assertOk(unwrap<MutationResult>(result))),

  overrideSelection: (input: {
    roundWeekId: string;
    roundEntryId: string;
    teamId?: string | null;
    outcome?: string | null;
    note?: string | null;
  }) =>
    authedClient.mutations
      .adminOverrideSelection(input)
      .then((result) => assertOk(unwrap<MutationResult>(result))),

  sync: (kind: string, seasonId?: string, matchday?: number) =>
    authedClient.mutations
      .adminSyncFootballData({
        kind,
        seasonId: seasonId ?? null,
        matchday: matchday ?? null,
      })
      .then((result) => assertOk(unwrap<MutationResult>(result))),

  processDeadlines: (roundWeekId?: string, dryRun = false) =>
    authedClient.mutations
      .adminProcessDeadlines({ roundWeekId: roundWeekId ?? null, dryRun })
      .then((result) => assertOk(unwrap<MutationResult>(result))),

  processResults: (roundWeekId?: string, dryRun = false) =>
    authedClient.mutations
      .adminProcessResults({ roundWeekId: roundWeekId ?? null, dryRun })
      .then((result) => assertOk(unwrap<MutationResult>(result))),
};
