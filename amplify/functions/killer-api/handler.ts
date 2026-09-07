import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { env } from '$amplify/env/killer-api';

import { systemClock } from '../../../shared/domain/clock.js';
import {
  isStandingsSnapshotFresh,
  shouldPrefetchStandings,
} from '../../../shared/domain/deadlines.js';
import { FootballDataOrgProvider } from '../../../shared/provider/footballDataOrg.js';
import type { SyncKind } from '../../../shared/domain/types.js';
import type { Schema } from '../../data/resource.js';
import type { KillerClient } from '../../shared/client.js';
import {
  adminInvitePlayer,
  adminSetPassword,
  adminSetPlayerActive,
} from '../../shared/invite.js';
import {
  adminCompleteRound,
  adminCreateRoundWeek,
  adminDeleteRound,
  adminReopenRound,
  adminOverrideSelection,
  adminSetEntrant,
  adminSetPaid,
  adminSubmitSelectionFor,
  adminSetWeekStatus,
  adminStartRound,
  markSelfPaid,
  submitSelection,
} from '../../shared/operations.js';
import {
  executeDeadlineProcessing,
  executeResultProcessing,
  loadDeadlineState,
  loadResultState,
} from '../../shared/processing.js';
import { createRepository } from '../../shared/repository.js';
import {
  ensureStandingsSnapshot,
  syncCompetition,
  syncFixtures,
  syncResults,
  syncStandings,
  syncTeams,
  type SyncContext,
} from '../../shared/sync.js';
import { buildCompetitionView, buildHistoryView } from '../../shared/views.js';
import {
  OperationError,
  requireAdmin,
  resolveViewer,
  type AppSyncIdentity,
} from '../../shared/viewer.js';

/**
 * The single AppSync resolver.
 *
 * One Lambda serves every custom query and mutation, routed on
 * `event.info.fieldName`. AppSync has already applied the per-field
 * authorization rules from `data/resource.ts` before we are invoked — a player
 * cannot reach an `adminXxx` field at all — and `requireAdmin` re-checks
 * `cognito:groups` inside each admin branch as a second line of defence.
 *
 * The alternative, a function per operation, would mean a dozen Lambdas, a dozen
 * log groups and a dozen cold starts for an application a handful of people open
 * once a week.
 */

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);

const client = generateClient<Schema>() as KillerClient;
const repository = createRepository(client);
const clock = systemClock;

/** Built lazily: most requests are reads and never touch the provider. */
function providerFor(): FootballDataOrgProvider {
  return new FootballDataOrgProvider({ token: env.FOOTBALL_DATA_TOKEN });
}

interface ResolverEvent {
  info?: { fieldName?: string };
  fieldName?: string;
  arguments?: Record<string, unknown>;
  identity?: AppSyncIdentity;
}

export const handler = async (event: ResolverEvent): Promise<unknown> => {
  const field = event.info?.fieldName ?? event.fieldName ?? '';
  const args = event.arguments ?? {};

  try {
    const viewer = await resolveViewer(event.identity, repository);

    switch (field) {
      // --- Public and player reads ---------------------------------------
      case 'getCompetitionView':
        return await buildCompetitionView(
          repository,
          viewer,
          clock,
          asOptionalString(args['killerRoundId']),
        );

      case 'getHistoryView':
        return await buildHistoryView(repository, asOptionalString(args['seasonId']));

      // --- Player writes -------------------------------------------------
      case 'submitSelection':
        return await submitSelection(repository, viewer, clock, {
          roundWeekId: asString(args['roundWeekId'], 'roundWeekId'),
          teamId: asString(args['teamId'], 'teamId'),
        });

      case 'markSelfPaid':
        return await markSelfPaid(repository, viewer, clock, {
          killerRoundId: asString(args['killerRoundId'], 'killerRoundId'),
        });

      // --- Administration ------------------------------------------------
      case 'adminSetPaid':
        return await adminSetPaid(repository, viewer, clock, {
          roundEntryId: asString(args['roundEntryId'], 'roundEntryId'),
          paid: Boolean(args['paid']),
        });

      case 'adminOverrideSelection':
        return await adminOverrideSelection(repository, viewer, clock, {
          roundWeekId: asString(args['roundWeekId'], 'roundWeekId'),
          roundEntryId: asString(args['roundEntryId'], 'roundEntryId'),
          teamId: asOptionalString(args['teamId']),
          outcome: asOptionalString(args['outcome']),
          note: asOptionalString(args['note']),
        });

      case 'adminInvitePlayer':
        return await adminInvitePlayer(
          repository,
          viewer,
          clock,
          env.AMPLIFY_AUTH_USERPOOL_ID,
          {
            displayName: asString(args['displayName'], 'displayName'),
            email: asString(args['email'], 'email'),
            makeAdmin: args['makeAdmin'] === true,
            sendInvite: args['sendInvite'] !== false,
          },
        );

      case 'adminSubmitSelectionFor':
        return await adminSubmitSelectionFor(repository, viewer, clock, {
          roundWeekId: asString(args['roundWeekId'], 'roundWeekId'),
          playerId: asString(args['playerId'], 'playerId'),
          teamId: asString(args['teamId'], 'teamId'),
          allowAfterDeadline: args['allowAfterDeadline'] === true,
        });

      case 'adminSetEntrant':
        return await adminSetEntrant(repository, viewer, clock, {
          killerRoundId: asString(args['killerRoundId'], 'killerRoundId'),
          playerId: asString(args['playerId'], 'playerId'),
          entered: args['entered'] === true,
        });

      case 'adminSetPassword':
        return await adminSetPassword(
          repository,
          viewer,
          clock,
          env.AMPLIFY_AUTH_USERPOOL_ID,
          {
            playerId: asString(args['playerId'], 'playerId'),
            password: asString(args['password'], 'password'),
            permanent: args['permanent'] === true,
          },
        );

      case 'adminSetPlayerActive':
        return await adminSetPlayerActive(repository, viewer, clock, {
          playerId: asString(args['playerId'], 'playerId'),
          active: Boolean(args['active']),
        });

      case 'adminStartRound':
        return await adminStartRound(repository, viewer, clock, {
          killerRoundId: asString(args['killerRoundId'], 'killerRoundId'),
          playerIds: Array.isArray(args['playerIds'])
            ? (args['playerIds'] as (string | null)[])
            : null,
        });

      case 'adminCreateRoundWeek':
        return await adminCreateRoundWeek(repository, viewer, clock, {
          killerRoundId: asString(args['killerRoundId'], 'killerRoundId'),
          matchday: asNumber(args['matchday'], 'matchday'),
          deadline: asOptionalString(args['deadline']),
          open: args['open'] === true,
        });

      case 'adminSetWeekStatus':
        return await adminSetWeekStatus(repository, viewer, clock, {
          roundWeekId: asString(args['roundWeekId'], 'roundWeekId'),
          status: asString(args['status'], 'status'),
        });

      case 'adminReopenRound':
        return await adminReopenRound(repository, viewer, clock, {
          killerRoundId: asString(args['killerRoundId'], 'killerRoundId'),
          note: asOptionalString(args['note']),
        });

      case 'adminDeleteRound':
        return await adminDeleteRound(repository, viewer, clock, {
          killerRoundId: asString(args['killerRoundId'], 'killerRoundId'),
          note: asOptionalString(args['note']),
        });

      case 'adminCompleteRound':
        return await adminCompleteRound(repository, viewer, clock, {
          killerRoundId: asString(args['killerRoundId'], 'killerRoundId'),
          resolution: asString(args['resolution'], 'resolution'),
          winnerPlayerId: asOptionalString(args['winnerPlayerId']),
          note: asOptionalString(args['note']),
        });

      case 'adminSyncFootballData':
        return await handleSync(viewer, args);

      case 'adminProcessDeadlines':
        return await handleProcessDeadlines(viewer, args);

      case 'adminProcessResults':
        return await handleProcessResults(viewer, args);

      default:
        throw new OperationError(`Unknown operation "${field}".`, 'UNKNOWN_OPERATION');
    }
  } catch (error) {
    // Return a structured failure rather than letting a stack trace become the
    // user's error message. The full error still reaches CloudWatch.
    console.error(`${field} failed`, error);
    if (error instanceof OperationError) {
      return { ok: false, reason: error.code, message: error.message };
    }
    return {
      ok: false,
      reason: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
    };
  }
};

// ---------------------------------------------------------------------------
// Administrative handlers that need more than a straight delegation
// ---------------------------------------------------------------------------

type Viewer = Awaited<ReturnType<typeof resolveViewer>>;

async function syncContext(trigger: 'ADMIN' | 'SCHEDULE'): Promise<SyncContext> {
  return { repository, provider: providerFor(), clock, trigger };
}

const SYNC_KINDS: SyncKind[] = ['TEAMS', 'FIXTURES', 'STANDINGS', 'RESULTS', 'COMPETITION'];

async function handleSync(viewer: Viewer, args: Record<string, unknown>) {
  requireAdmin(viewer);

  const kind = asString(args['kind'], 'kind').toUpperCase() as SyncKind;
  if (!SYNC_KINDS.includes(kind)) {
    throw new OperationError(`Kind must be one of ${SYNC_KINDS.join(', ')}.`, 'BAD_KIND');
  }

  const seasonId =
    asOptionalString(args['seasonId']) ?? (await repository.activeSeason())?.id ?? null;
  if (!seasonId) {
    throw new OperationError(
      'No active season. Create one before syncing football data.',
      'NO_SEASON',
    );
  }

  const context = await syncContext('ADMIN');
  const matchday = asOptionalNumber(args['matchday'], 'matchday');

  // A Premier League season is 38 gameweeks. Rejecting anything outside that
  // here means a bad value fails with a clear message instead of becoming a 400
  // from the provider that only shows up in the sync log.
  if (matchday !== undefined && (matchday < 1 || matchday > 38)) {
    throw new OperationError('Matchday must be between 1 and 38.', 'BAD_MATCHDAY');
  }

  switch (kind) {
    case 'COMPETITION':
      return { ok: true, sync: await syncCompetition(context, seasonId) };
    case 'TEAMS':
      return { ok: true, sync: await syncTeams(context, seasonId) };
    case 'FIXTURES':
      return { ok: true, sync: await syncFixtures(context, seasonId, matchday) };
    case 'STANDINGS':
      return { ok: true, sync: await syncStandings(context, seasonId) };
    case 'RESULTS': {
      if (matchday === undefined) {
        throw new OperationError('A matchday is required to sync results.', 'NO_MATCHDAY');
      }
      return { ok: true, sync: await syncResults(context, seasonId, matchday) };
    }
  }
}

/**
 * Run deadline processing on demand.
 *
 * Identical to what the scheduler does, including capturing a fresh standings
 * snapshot first if the last one is stale — the admin button and the timer must
 * not produce different automatic picks.
 */
async function handleProcessDeadlines(viewer: Viewer, args: Record<string, unknown>) {
  requireAdmin(viewer);

  const dryRun = args['dryRun'] === true;
  const explicitWeekId = asOptionalString(args['roundWeekId']);

  const weekIds = explicitWeekId
    ? [explicitWeekId]
    : [
        ...(await repository.weeksByStatus('OPEN')),
        ...(await repository.weeksByStatus('DRAFT')),
      ]
        .filter((week) => week.deadline && Date.parse(week.deadline) <= clock.nowMillis())
        .map((week) => week.id);

  const results = [];
  for (const weekId of weekIds) {
    results.push(await processOneDeadline(weekId, viewer, dryRun));
  }

  return { ok: true, processed: results.length, results };
}

async function processOneDeadline(
  roundWeekId: string,
  actor: Viewer,
  dryRun: boolean,
): Promise<unknown> {
  const week = await repository.week(roundWeekId);
  if (!week) throw new OperationError('No such Round Week.', 'NO_SUCH_WEEK');
  const round = await repository.round(week.killerRoundId);
  if (!round) throw new OperationError('No such Killer Round.', 'NO_SUCH_ROUND');

  // Automatic picks need the table as it stood at the deadline, so make sure a
  // recent snapshot exists before planning anything.
  let snapshotId = week.standingsSnapshotId ?? null;
  if (!dryRun && !snapshotId && shouldPrefetchStandings(week.deadline ?? null, clock)) {
    snapshotId = await ensureStandingsSnapshot(
      await syncContext('ADMIN'),
      round.seasonId,
      (capturedAt) => isStandingsSnapshotFresh(capturedAt, clock),
    );
  }

  const state = await loadDeadlineState(repository, roundWeekId, snapshotId);
  if (!state) throw new OperationError('Could not load the Round Week.', 'LOAD_FAILED');

  const { result } = await executeDeadlineProcessing(
    repository,
    state,
    clock,
    actor,
    dryRun,
  );
  return result;
}

async function handleProcessResults(viewer: Viewer, args: Record<string, unknown>) {
  requireAdmin(viewer);

  const dryRun = args['dryRun'] === true;
  const explicitWeekId = asOptionalString(args['roundWeekId']);

  const weekIds = explicitWeekId
    ? [explicitWeekId]
    : [
        ...(await repository.weeksByStatus('LOCKED')),
        ...(await repository.weeksByStatus('RESULTS_PENDING')),
      ].map((week) => week.id);

  const results = [];
  for (const weekId of weekIds) {
    const state = await loadResultState(repository, weekId);
    if (!state) continue;
    const { result } = await executeResultProcessing(repository, state, clock, viewer, dryRun);
    results.push(result);
  }

  return { ok: true, processed: results.length, results };
}

// ---------------------------------------------------------------------------
// Argument coercion
//
// AppSync validates types against the schema, but these keep the handler honest
// and produce a clear message instead of a downstream `undefined`.
// ---------------------------------------------------------------------------

function asString(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  throw new OperationError(`"${name}" is required.`, 'BAD_ARGUMENT');
}

function asOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asNumber(value: unknown, name: string): number {
  // Guard against `Number(null) === 0` and `Number('') === 0`, which would turn
  // an absent argument into a real-looking zero.
  if (value === null || value === undefined || value === '') {
    throw new OperationError(`"${name}" is required.`, 'BAD_ARGUMENT');
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new OperationError(`"${name}" must be a number.`, 'BAD_ARGUMENT');
  }
  return parsed;
}

/**
 * An optional number argument.
 *
 * GraphQL nullable arguments arrive as `null`, not `undefined`, so an absent
 * value must be normalised rather than coerced — `Number(null)` is `0`, and a
 * matchday of 0 is a real request for a gameweek that does not exist.
 */
function asOptionalNumber(value: unknown, name: string): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  return asNumber(value, name);
}
