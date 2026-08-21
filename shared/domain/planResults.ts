import { computePot, rolloverAmount } from './money.js';
import { needsAdminAttention, resolveOutcome, resolveRoundWeek } from './outcomes.js';
import { findFixtureForTeam } from './selection.js';
import type {
  Fixture,
  KillerRound,
  Pence,
  RoundEntry,
  RoundWeek,
  Selection,
  SelectionOutcome,
} from './types.js';

/**
 * Result processing as a plan, for the same reason as deadline processing: so
 * "reprocess" is safe to press twice and the scheduler and the admin button
 * cannot drift apart.
 */
export interface ResultPlan {
  roundWeekId: string;
  /** Selections whose outcome changes. Unchanged ones are not rewritten. */
  updateSelections: {
    selectionId: string;
    outcome: SelectionOutcome;
    fixtureId: string | null;
    resolvedAt: string | null;
  }[];
  /** Entries to mark eliminated, with the week that did it. */
  eliminateEntries: { roundEntryId: string; eliminatedRoundWeekId: string }[];
  /** The single survivor, when the round has been won. */
  winnerEntryId: string | null;
  /** Week status transition, or null when it should stay as it is. */
  weekStatus: { toStatus: RoundWeek['status']; at: string } | null;
  /** Round status transition plus the money consequences. */
  roundOutcome:
    | { kind: 'WON'; winnerEntryId: string; winnerPlayerId: string; potPence: Pence }
    | { kind: 'ROLLOVER'; rolloverOutPence: Pence }
    | { kind: 'CONTINUE'; survivorCount: number }
    | null;
  /** Fixtures a human needs to look at (cancelled, or an unrecognised state). */
  needsAttention: { selectionId: string; fixtureId: string | null; reason: string }[];
  pendingCount: number;
  empty: boolean;
}

export interface ResultState {
  round: Pick<
    KillerRound,
    'id' | 'status' | 'rolloverInPence' | 'entryFeePence' | 'winnerPlayerId'
  >;
  week: Pick<RoundWeek, 'id' | 'status' | 'matchday'>;
  /** Selections for this week only. */
  selections: readonly Selection[];
  /** All entries in the round, so pot and elimination state can be computed. */
  entries: readonly Pick<
    RoundEntry,
    'id' | 'playerId' | 'status' | 'paid' | 'entryFeePence' | 'eliminatedRoundWeekId'
  >[];
  fixtures: readonly Fixture[];
}

export function planResultProcessing(state: ResultState, now: string): ResultPlan {
  const { week, round } = state;
  const matchdayFixtures =
    week.matchday === null
      ? state.fixtures
      : state.fixtures.filter((fixture) => fixture.matchday === week.matchday);

  const updateSelections: ResultPlan['updateSelections'] = [];
  const needsAttention: ResultPlan['needsAttention'] = [];
  /** The outcome each selection *should* have, whether or not it changed. */
  const effective: { roundEntryId: string; outcome: SelectionOutcome }[] = [];

  for (const selection of state.selections) {
    const fixture = selection.teamId
      ? findFixtureForTeam(selection.teamId, matchdayFixtures)
      : null;

    const outcome = resolveOutcome({ selection, fixture });
    effective.push({ roundEntryId: selection.roundEntryId, outcome });

    // An administrator has ruled on this one. Leave the record exactly as they
    // left it — not even the fixture link gets rewritten.
    if (selection.overridden) continue;

    if (needsAdminAttention(fixture)) {
      needsAttention.push({
        selectionId: selection.id,
        fixtureId: fixture?.id ?? null,
        reason:
          fixture?.status === 'CANCELLED'
            ? 'Selected fixture was cancelled and will never produce a result.'
            : 'Selected fixture is in an unrecognised state.',
      });
    }

    const fixtureId = fixture?.id ?? selection.fixtureId ?? null;
    const changed = outcome !== selection.outcome || fixtureId !== selection.fixtureId;
    if (changed) {
      updateSelections.push({
        selectionId: selection.id,
        outcome,
        fixtureId,
        resolvedAt: outcome === 'PENDING' ? null : now,
      });
    }
  }

  const resolution = resolveRoundWeek({ selections: effective });

  const eliminateEntries: ResultPlan['eliminateEntries'] = [];
  if (resolution.kind !== 'PENDING') {
    const eliminatedEntryIds = effective
      .filter((entry) => entry.outcome === 'ELIMINATED')
      .map((entry) => entry.roundEntryId);

    for (const entryId of new Set(eliminatedEntryIds)) {
      const entry = state.entries.find((candidate) => candidate.id === entryId);
      // Only a change if they are not already marked out.
      if (entry && entry.status === 'ALIVE') {
        eliminateEntries.push({ roundEntryId: entryId, eliminatedRoundWeekId: week.id });
      }
    }
  }

  const pot = computePot(round, state.entries);

  let weekStatus: ResultPlan['weekStatus'] = null;
  let roundOutcome: ResultPlan['roundOutcome'] = null;
  let winnerEntryId: string | null = null;

  switch (resolution.kind) {
    case 'PENDING': {
      if (week.status !== 'RESULTS_PENDING' && week.status !== 'DRAFT' && week.status !== 'OPEN') {
        weekStatus = { toStatus: 'RESULTS_PENDING', at: now };
      }
      break;
    }
    case 'WINNER': {
      winnerEntryId = resolution.roundEntryId;
      const entry = state.entries.find((candidate) => candidate.id === winnerEntryId);
      if (week.status !== 'COMPLETE') weekStatus = { toStatus: 'COMPLETE', at: now };
      if (round.status === 'ACTIVE' && entry) {
        roundOutcome = {
          kind: 'WON',
          winnerEntryId,
          winnerPlayerId: entry.playerId,
          potPence: pot.totalPotPence,
        };
      }
      break;
    }
    case 'ROLLOVER': {
      if (week.status !== 'COMPLETE') weekStatus = { toStatus: 'COMPLETE', at: now };
      if (round.status === 'ACTIVE') {
        roundOutcome = { kind: 'ROLLOVER', rolloverOutPence: rolloverAmount(pot) };
      }
      break;
    }
    case 'CONTINUE': {
      if (week.status !== 'COMPLETE') weekStatus = { toStatus: 'COMPLETE', at: now };
      roundOutcome = { kind: 'CONTINUE', survivorCount: resolution.survivorEntryIds.length };
      break;
    }
  }

  // CONTINUE alone is not a state change — the admin creates the next week.
  const empty =
    updateSelections.length === 0 &&
    eliminateEntries.length === 0 &&
    weekStatus === null &&
    (roundOutcome === null || roundOutcome.kind === 'CONTINUE');

  return {
    roundWeekId: week.id,
    updateSelections,
    eliminateEntries,
    winnerEntryId,
    weekStatus,
    roundOutcome,
    needsAttention,
    pendingCount: resolution.kind === 'PENDING' ? resolution.pendingCount : 0,
    empty,
  };
}
