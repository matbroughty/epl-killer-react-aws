import type { Clock } from '../../shared/domain/clock.js';
import {
  planDeadlineProcessing,
  type DeadlinePlan,
  type DeadlineState,
} from '../../shared/domain/planDeadline.js';
import {
  planResultProcessing,
  type ResultPlan,
  type ResultState,
} from '../../shared/domain/planResults.js';
import type {
  Fixture,
  FixtureStatus,
  FixtureWinner,
  RoundEntryStatus,
  RoundWeekStatus,
  Selection,
  SelectionOutcome,
  SelectionType,
  StandingsSnapshot,
} from '../../shared/domain/types.js';
import { computePot } from '../../shared/domain/money.js';
import {
  eliminationMessage,
  finalTwoMessage,
  rolloverMessage,
  winnerMessage,
  type Message,
} from '../../shared/domain/notifications.js';
import { recordAudit, SYSTEM_ACTOR } from './audit.js';
import { sendAll, type Recipient } from './email.js';
import { isConditionalCheckFailure } from './client.js';
import type { Repository } from './repository.js';
import type { ResolvedViewer } from './viewer.js';

/**
 * The executors.
 *
 * These are the only places that turn a plan into writes. Each write
 * corresponds one-for-one with an entry in the plan, which is what makes the
 * idempotency tests in `shared/domain/*.test.ts` meaningful: if this file
 * started doing extra work of its own, those tests would no longer describe
 * production behaviour.
 */

// ---------------------------------------------------------------------------
// Loading state for the planners
// ---------------------------------------------------------------------------

/** Narrow Amplify's nullable enums to our domain unions, failing safe. */
function asFixtureStatus(value: string | null | undefined): FixtureStatus {
  return (value ?? 'UNKNOWN') as FixtureStatus;
}

function toDomainFixture(row: {
  id: string;
  seasonId: string;
  providerMatchId?: number | null;
  matchday: number;
  utcKickoff: string;
  status?: string | null;
  homeTeamId: string;
  awayTeamId: string;
  homeGoals?: number | null;
  awayGoals?: number | null;
  winner?: string | null;
}): Fixture {
  return {
    id: row.id,
    seasonId: row.seasonId,
    providerMatchId: row.providerMatchId ?? null,
    matchday: row.matchday,
    utcKickoff: row.utcKickoff,
    status: asFixtureStatus(row.status),
    homeTeamId: row.homeTeamId,
    awayTeamId: row.awayTeamId,
    homeGoals: row.homeGoals ?? null,
    awayGoals: row.awayGoals ?? null,
    winner: (row.winner ?? null) as FixtureWinner | null,
  };
}

function toDomainSelection(row: {
  id: string;
  roundWeekId: string;
  roundEntryId: string;
  playerId: string;
  killerRoundId: string;
  teamId?: string | null;
  teamName?: string | null;
  teamCode?: string | null;
  selectionType?: string | null;
  selectedAt: string;
  lockedAt?: string | null;
  outcome?: string | null;
  overridden?: boolean | null;
  fixtureId?: string | null;
  standingsSnapshotId?: string | null;
  autoReason?: string | null;
}): Selection {
  return {
    id: row.id,
    roundWeekId: row.roundWeekId,
    roundEntryId: row.roundEntryId,
    playerId: row.playerId,
    killerRoundId: row.killerRoundId,
    teamId: row.teamId ?? null,
    teamName: row.teamName ?? null,
    teamCode: row.teamCode ?? null,
    selectionType: (row.selectionType ?? 'MANUAL') as SelectionType,
    selectedAt: row.selectedAt,
    lockedAt: row.lockedAt ?? null,
    outcome: (row.outcome ?? 'PENDING') as SelectionOutcome,
    overridden: row.overridden ?? false,
    fixtureId: row.fixtureId ?? null,
    standingsSnapshotId: row.standingsSnapshotId ?? null,
    autoReason: (row.autoReason ?? null) as Selection['autoReason'],
  };
}

async function loadSnapshot(
  repository: Repository,
  snapshotId: string | null | undefined,
): Promise<StandingsSnapshot | null> {
  if (!snapshotId) return null;
  const row = await repository.snapshot(snapshotId);
  if (!row) return null;
  return {
    id: row.id,
    seasonId: row.seasonId,
    matchday: row.matchday ?? null,
    capturedAt: row.capturedAt,
    rows: (row.rows ?? []).flatMap((entry) =>
      entry
        ? [
            {
              teamId: entry.teamId,
              providerTeamId: entry.providerTeamId ?? null,
              position: entry.position,
              playedGames: entry.playedGames,
              points: entry.points,
              goalDifference: entry.goalDifference,
            },
          ]
        : [],
    ),
  };
}

export async function loadDeadlineState(
  repository: Repository,
  roundWeekId: string,
  /** Snapshot to use, when the caller has just captured a fresh one. */
  snapshotId?: string | null,
): Promise<DeadlineState | null> {
  const week = await repository.week(roundWeekId);
  if (!week) return null;

  const round = await repository.round(week.killerRoundId);
  if (!round) return null;

  const [entries, weekSelections, roundSelections, fixtures, teams] = await Promise.all([
    repository.entries(week.killerRoundId),
    repository.selectionsByWeek(week.id),
    repository.selectionsByRound(week.killerRoundId),
    week.matchday === null || week.matchday === undefined
      ? Promise.resolve([])
      : repository.fixtures(round.seasonId, week.matchday),
    repository.teams(round.seasonId),
  ]);

  const standings = await loadSnapshot(
    repository,
    snapshotId ?? week.standingsSnapshotId ?? (await repository.latestSnapshot(round.seasonId))?.id,
  );

  return {
    week: {
      id: week.id,
      killerRoundId: week.killerRoundId,
      status: (week.status ?? 'DRAFT') as RoundWeekStatus,
      deadline: week.deadline ?? null,
      matchday: week.matchday ?? null,
      standingsSnapshotId: week.standingsSnapshotId ?? null,
    },
    aliveEntries: entries.map((entry) => ({
      id: entry.id,
      playerId: entry.playerId,
      status: (entry.status ?? 'ALIVE') as RoundEntryStatus,
    })),
    weekSelections: weekSelections.map((selection) => ({
      id: selection.id,
      roundEntryId: selection.roundEntryId,
      teamId: selection.teamId ?? null,
      lockedAt: selection.lockedAt ?? null,
    })),
    roundSelections: roundSelections.map((selection) => ({
      roundWeekId: selection.roundWeekId,
      roundEntryId: selection.roundEntryId,
      teamId: selection.teamId ?? null,
    })),
    fixtures: fixtures.map(toDomainFixture),
    standings,
    teams: teams.map((team) => ({ id: team.id, name: team.name, code: team.code })),
  };
}

export async function loadResultState(
  repository: Repository,
  roundWeekId: string,
): Promise<ResultState | null> {
  const week = await repository.week(roundWeekId);
  if (!week) return null;

  const round = await repository.round(week.killerRoundId);
  if (!round) return null;

  const [selections, entries, fixtures] = await Promise.all([
    repository.selectionsByWeek(week.id),
    repository.entries(week.killerRoundId),
    week.matchday === null || week.matchday === undefined
      ? Promise.resolve([])
      : repository.fixtures(round.seasonId, week.matchday),
  ]);

  return {
    round: {
      id: round.id,
      status: (round.status ?? 'DRAFT') as ResultState['round']['status'],
      rolloverInPence: round.rolloverInPence ?? 0,
      entryFeePence: round.entryFeePence,
      winnerPlayerId: round.winnerPlayerId ?? null,
    },
    week: {
      id: week.id,
      status: (week.status ?? 'DRAFT') as RoundWeekStatus,
      matchday: week.matchday ?? null,
    },
    selections: selections.map(toDomainSelection),
    entries: entries.map((entry) => ({
      id: entry.id,
      playerId: entry.playerId,
      status: (entry.status ?? 'ALIVE') as RoundEntryStatus,
      paid: entry.paid,
      entryFeePence: entry.entryFeePence ?? round.entryFeePence,
      eliminatedRoundWeekId: entry.eliminatedRoundWeekId ?? null,
    })),
    fixtures: fixtures.map(toDomainFixture),
  };
}

// ---------------------------------------------------------------------------
// Deadline processing
// ---------------------------------------------------------------------------

export interface DeadlineResult {
  roundWeekId: string;
  locked: boolean;
  autoAssigned: number;
  autoUnassigned: number;
  selectionsLocked: number;
  skippedExisting: number;
  notes: string[];
  dryRun: boolean;
}

/**
 * Lock a week and fill in the missing picks.
 *
 * The order matters. Selections are created *before* the week is marked
 * `LOCKED`, so a run that dies halfway leaves the week still `OPEN` and the next
 * tick finishes the job. Marking the week first and then crashing would leave
 * players with no pick in a week nothing will process again.
 */
export async function executeDeadlineProcessing(
  repository: Repository,
  state: DeadlineState,
  clock: Clock,
  actor: ResolvedViewer = SYSTEM_ACTOR,
  dryRun = false,
): Promise<{ plan: DeadlinePlan; result: DeadlineResult }> {
  const plan = planDeadlineProcessing(state, clock);
  const now = clock.nowIso();

  const result: DeadlineResult = {
    roundWeekId: plan.roundWeekId,
    locked: false,
    autoAssigned: 0,
    autoUnassigned: 0,
    selectionsLocked: 0,
    skippedExisting: 0,
    notes: [...plan.auditNotes],
    dryRun,
  };

  if (plan.empty || dryRun) {
    result.autoAssigned = plan.createSelections.filter((s) => s.teamId !== null).length;
    result.autoUnassigned = plan.createSelections.filter((s) => s.teamId === null).length;
    result.selectionsLocked = plan.lockSelections.length;
    return { plan, result };
  }

  for (const planned of plan.createSelections) {
    try {
      // The id is `{weekId}#{entryId}`, and Amplify's create resolver puts with
      // `attribute_not_exists(id)`. A concurrent run therefore loses this race
      // cleanly instead of producing a second pick for the same player.
      await repository.models.Selection.create({
        id: planned.id,
        roundWeekId: planned.roundWeekId,
        roundEntryId: planned.roundEntryId,
        killerRoundId: planned.killerRoundId,
        playerId: planned.playerId,
        teamId: planned.teamId,
        teamName: planned.teamName,
        teamCode: planned.teamCode,
        selectionType: 'AUTO_LOWEST_POSITION',
        selectedAt: planned.selectedAt,
        lockedAt: planned.lockedAt,
        outcome: 'PENDING',
        overridden: false,
        fixtureId: planned.fixtureId,
        standingsSnapshotId: planned.standingsSnapshotId,
        autoReason: planned.autoReason,
        autoNote: planned.auditNote,
      });

      if (planned.teamId) result.autoAssigned += 1;
      else result.autoUnassigned += 1;

      await recordAudit(repository, actor, now, {
        action:
          planned.autoReason === 'AUTO_NO_ELIGIBLE_TEAM'
            ? 'AUTO_SELECTION_FAILED'
            : 'AUTO_SELECTION_ASSIGNED',
        entityType: 'Selection',
        entityId: planned.id,
        killerRoundId: planned.killerRoundId,
        after: {
          teamId: planned.teamId,
          teamName: planned.teamName,
          standingsSnapshotId: planned.standingsSnapshotId,
          autoReason: planned.autoReason,
        },
        note: planned.auditNote,
      });
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        // Another run got there first, or the player squeaked a pick in. Both
        // are correct outcomes; the existing record wins.
        result.skippedExisting += 1;
        continue;
      }
      throw error;
    }
  }

  for (const lock of plan.lockSelections) {
    await repository.models.Selection.update({ id: lock.selectionId, lockedAt: lock.lockedAt });
    result.selectionsLocked += 1;
  }

  if (plan.lockWeek) {
    await repository.models.RoundWeek.update({
      id: plan.roundWeekId,
      status: plan.lockWeek.toStatus,
      lockedAt: plan.lockWeek.lockedAt,
      standingsSnapshotId: plan.lockWeek.standingsSnapshotId,
    });
    result.locked = true;

    await recordAudit(repository, actor, now, {
      action: 'ROUND_WEEK_LOCKED',
      entityType: 'RoundWeek',
      entityId: plan.roundWeekId,
      after: {
        status: 'LOCKED',
        standingsSnapshotId: plan.lockWeek.standingsSnapshotId,
        autoAssigned: result.autoAssigned,
        autoUnassigned: result.autoUnassigned,
      },
      note: plan.auditNotes.join(' ') || undefined,
    });
  }

  return { plan, result };
}

// ---------------------------------------------------------------------------
// Result processing
// ---------------------------------------------------------------------------

export interface ResultProcessingResult {
  roundWeekId: string;
  selectionsUpdated: number;
  eliminated: number;
  pendingCount: number;
  outcome: string | null;
  winnerPlayerId: string | null;
  rolloverOutPence: number | null;
  needsAttention: { selectionId: string; reason: string }[];
  dryRun: boolean;
  /** Populated once notifications have been attempted. */
  emails?: { sent: number; skipped: string[]; failed: string[] };
}

export async function executeResultProcessing(
  repository: Repository,
  state: ResultState,
  clock: Clock,
  actor: ResolvedViewer = SYSTEM_ACTOR,
  dryRun = false,
): Promise<{ plan: ResultPlan; result: ResultProcessingResult }> {
  const now = clock.nowIso();
  const plan = planResultProcessing(state, now);

  const result: ResultProcessingResult = {
    roundWeekId: plan.roundWeekId,
    selectionsUpdated: plan.updateSelections.length,
    eliminated: plan.eliminateEntries.length,
    pendingCount: plan.pendingCount,
    outcome: plan.roundOutcome?.kind ?? null,
    winnerPlayerId:
      plan.roundOutcome?.kind === 'WON' ? plan.roundOutcome.winnerPlayerId : null,
    rolloverOutPence:
      plan.roundOutcome?.kind === 'ROLLOVER' ? plan.roundOutcome.rolloverOutPence : null,
    needsAttention: plan.needsAttention.map((entry) => ({
      selectionId: entry.selectionId,
      reason: entry.reason,
    })),
    dryRun,
  };

  if (plan.empty || dryRun) return { plan, result };

  for (const update of plan.updateSelections) {
    await repository.models.Selection.update({
      id: update.selectionId,
      outcome: update.outcome,
      fixtureId: update.fixtureId,
      resolvedAt: update.resolvedAt,
    });
  }

  for (const elimination of plan.eliminateEntries) {
    await repository.models.RoundEntry.update({
      id: elimination.roundEntryId,
      status: 'ELIMINATED',
      eliminatedRoundWeekId: elimination.eliminatedRoundWeekId,
    });
  }

  if (plan.weekStatus) {
    await repository.models.RoundWeek.update({
      id: plan.roundWeekId,
      status: plan.weekStatus.toStatus,
      resultsProcessedAt: plan.weekStatus.at,
      completedAt: plan.weekStatus.toStatus === 'COMPLETE' ? plan.weekStatus.at : null,
    });
  }

  if (plan.roundOutcome?.kind === 'WON') {
    const { winnerEntryId, winnerPlayerId, potPence } = plan.roundOutcome;

    await repository.models.RoundEntry.update({ id: winnerEntryId, status: 'WINNER' });
    await repository.models.KillerRound.update({
      id: state.round.id,
      status: 'WON',
      winnerPlayerId,
      completedAt: now,
    });

    await recordAudit(repository, actor, now, {
      action: 'KILLER_ROUND_WON',
      entityType: 'KillerRound',
      entityId: state.round.id,
      killerRoundId: state.round.id,
      after: { winnerPlayerId, potPence, decidedInRoundWeekId: plan.roundWeekId },
      note: `Won by the last player standing after Round Week ${plan.roundWeekId}.`,
    });
  }

  if (plan.roundOutcome?.kind === 'ROLLOVER') {
    await repository.models.KillerRound.update({
      id: state.round.id,
      status: 'ROLLOVER',
      rolloverOutPence: plan.roundOutcome.rolloverOutPence,
      completedAt: now,
    });

    await recordAudit(repository, actor, now, {
      action: 'KILLER_ROUND_ROLLOVER',
      entityType: 'KillerRound',
      entityId: state.round.id,
      killerRoundId: state.round.id,
      after: {
        rolloverOutPence: plan.roundOutcome.rolloverOutPence,
        decidedInRoundWeekId: plan.roundWeekId,
      },
      note:
        'Every remaining player was eliminated in the same Round Week. No winner; the pot carries into the next Killer Round.',
    });
  }

  for (const attention of plan.needsAttention) {
    await recordAudit(repository, actor, now, {
      action: 'FIXTURE_NEEDS_ATTENTION',
      entityType: 'Selection',
      entityId: attention.selectionId,
      killerRoundId: state.round.id,
      after: { fixtureId: attention.fixtureId },
      note: attention.reason,
    });
  }

  // Notify last, once every write has succeeded. An email announcing an
  // elimination that then failed to persist would be the worst possible order.
  await notifyFromPlan(repository, state, plan, result);

  return { plan, result };
}

/**
 * Email the people this plan affects.
 *
 * Exactly-once delivery falls out of the planner rather than needing a sent-log:
 * an elimination only appears in a plan while the entry is still `ALIVE`, and a
 * round outcome only while the round is still `ACTIVE`. Once applied, neither
 * appears again, so the fifteen-minute scheduler cannot re-send.
 *
 * Failures are swallowed. Results processing has already committed.
 */
async function notifyFromPlan(
  repository: Repository,
  state: ResultState,
  plan: ResultPlan,
  result: ResultProcessingResult,
): Promise<void> {
  if (plan.eliminateEntries.length === 0 && !plan.roundOutcome) return;

  try {
    const [players, week, round] = await Promise.all([
      repository.players(),
      repository.week(plan.roundWeekId),
      repository.round(state.round.id),
    ]);

    const playersById = new Map(players.map((player) => [player.id, player]));
    const matchday = week?.matchday ?? null;
    const roundNumber = round?.number ?? 0;

    const pot = computePot(
      { rolloverInPence: state.round.rolloverInPence ?? 0 },
      state.entries.map((entry) => ({
        paid: entry.paid,
        entryFeePence: entry.entryFeePence ?? state.round.entryFeePence,
      })),
    );

    const toRecipient = (playerId: string) => {
      const player = playersById.get(playerId);
      return {
        email: player?.email ?? null,
        displayName: player?.displayName ?? 'Player',
        notifyByEmail: player?.notifyByEmail ?? true,
      };
    };

    // Survivor count *after* this week, which is what the copy talks about.
    const eliminatedNow = new Set(plan.eliminateEntries.map((entry) => entry.roundEntryId));
    const survivorCount = state.entries.filter(
      (entry) =>
        !eliminatedNow.has(entry.id) &&
        entry.status !== 'ELIMINATED',
    ).length;

    const outbox: { recipient: Recipient; message: Message }[] = [];

    for (const elimination of plan.eliminateEntries) {
      const entry = state.entries.find((candidate) => candidate.id === elimination.roundEntryId);
      if (!entry) continue;
      const selection = state.selections.find(
        (candidate) => candidate.roundEntryId === elimination.roundEntryId,
      );

      outbox.push({
        recipient: toRecipient(entry.playerId),
        message: eliminationMessage({
          displayName: playersById.get(entry.playerId)?.displayName ?? 'there',
          teamName: selection?.teamName ?? null,
          matchday,
          roundNumber,
          survivorCount,
          wasAutoPick: selection?.selectionType === 'AUTO_LOWEST_POSITION',
        }),
      });
    }

    if (plan.roundOutcome?.kind === 'WON') {
      const { winnerPlayerId, winnerEntryId, potPence } = plan.roundOutcome;
      const selection = state.selections.find(
        (candidate) => candidate.roundEntryId === winnerEntryId,
      );
      const weeks = await repository.weeks(state.round.id);

      outbox.push({
        recipient: toRecipient(winnerPlayerId),
        message: winnerMessage({
          displayName: playersById.get(winnerPlayerId)?.displayName ?? 'there',
          roundNumber,
          potPence,
          teamName: selection?.teamName ?? null,
          matchday,
          entrantCount: state.entries.length,
          weeksSurvived: weeks.length,
        }),
      });
    }

    if (plan.roundOutcome?.kind === 'ROLLOVER') {
      // Everyone gets this one — it is news for the whole group, and it makes
      // the next round more attractive.
      for (const entry of state.entries) {
        outbox.push({
          recipient: toRecipient(entry.playerId),
          message: rolloverMessage({
            displayName: playersById.get(entry.playerId)?.displayName ?? 'there',
            roundNumber,
            rolloverPence: plan.roundOutcome.rolloverOutPence,
            matchday,
          }),
        });
      }
    }

    // Reaching the last two is worth telling people about; surviving an ordinary
    // week is not, and a weekly "you're still in" would earn a mail filter.
    if (plan.roundOutcome?.kind === 'CONTINUE' && plan.roundOutcome.survivorCount === 2) {
      for (const entry of state.entries) {
        if (eliminatedNow.has(entry.id) || entry.status === 'ELIMINATED') continue;
        const selection = state.selections.find(
          (candidate) => candidate.roundEntryId === entry.id,
        );
        outbox.push({
          recipient: toRecipient(entry.playerId),
          message: finalTwoMessage({
            displayName: playersById.get(entry.playerId)?.displayName ?? 'there',
            roundNumber,
            teamName: selection?.teamName ?? null,
            matchday,
            survivorCount: 2,
            potPence: pot.totalPotPence,
          }),
        });
      }
    }

    const sent = await sendAll(outbox);
    result.emails = sent;
    console.log(
      `Notifications: ${sent.sent} sent, ${sent.skipped.length} skipped, ${sent.failed.length} failed`,
    );
  } catch (error) {
    console.error('Notification step failed (results were still applied):', error);
  }
}
