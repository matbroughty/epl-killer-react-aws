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
    /** Set when leniency decided this, so it is never recomputed. */
    overridden?: boolean;
    note?: string;
  }[];
  /** Selections given the benefit of the doubt under leniency. */
  lenientSurvivals: { selectionId: string; teamName: string | null }[];
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

export interface ResultOptions {
  /**
   * Give unresolved picks the benefit of the doubt.
   *
   * Applied when an administrator opens the *next* Round Week, which is the
   * moment the competition declares this one over. A fixture postponed out of
   * the gameweek and not rearranged in time would otherwise hold the whole round
   * up indefinitely, so the player goes through as though their team had won —
   * and the team still counts as used, because the selection keeps its `teamId`.
   *
   * The ruling is marked `overridden` so it sticks. If the rearranged match is
   * eventually played and lost, the player is *not* retrospectively knocked out
   * — they have already been told they went through.
   */
  applyLeniency?: boolean;
}

export function planResultProcessing(
  state: ResultState,
  now: string,
  options: ResultOptions = {},
): ResultPlan {
  const { week, round } = state;
  const matchdayFixtures =
    week.matchday === null
      ? state.fixtures
      : state.fixtures.filter((fixture) => fixture.matchday === week.matchday);

  const updateSelections: ResultPlan['updateSelections'] = [];
  const needsAttention: ResultPlan['needsAttention'] = [];
  const lenientSurvivals: ResultPlan['lenientSurvivals'] = [];
  /** The outcome each selection *should* have, whether or not it changed. */
  const effective: { roundEntryId: string; outcome: SelectionOutcome }[] = [];

  for (const selection of state.selections) {
    const fixture = selection.teamId
      ? findFixtureForTeam(selection.teamId, matchdayFixtures)
      : null;

    const resolved = resolveOutcome({ selection, fixture });

    // Leniency: the round is moving on, so anything still unresolved goes
    // through. Only ever upgrades a PENDING — it never overturns a real result.
    const lenient =
      options.applyLeniency === true && resolved === 'PENDING' && !selection.overridden;
    const outcome: SelectionOutcome = lenient ? 'SURVIVED' : resolved;

    effective.push({ roundEntryId: selection.roundEntryId, outcome });

    // An administrator has ruled on this one. Leave the record exactly as they
    // left it — not even the fixture link gets rewritten.
    if (selection.overridden) continue;

    if (lenient) {
      lenientSurvivals.push({
        selectionId: selection.id,
        teamName: selection.teamName,
      });
      updateSelections.push({
        selectionId: selection.id,
        outcome: 'SURVIVED',
        fixtureId: fixture?.id ?? selection.fixtureId ?? null,
        resolvedAt: now,
        // Marked final: a rearranged match played later must not retrospectively
        // knock out somebody who has already been told they went through.
        overridden: true,
        note:
          `Fixture unresolved when the next Round Week opened. Given the benefit of the doubt ` +
          `and treated as a win; the team still counts as used.`,
      });
      continue;
    }

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

  /**
   * Eliminate a player as soon as *their own* selection resolves against them,
   * without waiting for the rest of the week.
   *
   * A lost or drawn fixture is final — there is no path back from it — so making
   * people wait produces a table that contradicts itself: a red ✗ against the
   * pick while the player still reads "Alive", sometimes for days when a
   * gameweek spans a weekend.
   *
   * Only the *round's* outcome genuinely needs every result in, because you
   * cannot know who is last standing until nothing is outstanding. That
   * distinction is why `weekStatus` and `roundOutcome` below remain gated on
   * `resolution` while this does not.
   */
  const eliminateEntries: ResultPlan['eliminateEntries'] = [];
  const eliminatedEntryIds = effective
    .filter((entry) => entry.outcome === 'ELIMINATED')
    .map((entry) => entry.roundEntryId);

  for (const entryId of new Set(eliminatedEntryIds)) {
    const entry = state.entries.find((candidate) => candidate.id === entryId);
    // Only a change if they are not already marked out — this is what keeps
    // repeated runs idempotent.
    if (entry && entry.status === 'ALIVE') {
      eliminateEntries.push({ roundEntryId: entryId, eliminatedRoundWeekId: week.id });
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
    lenientSurvivals,
    eliminateEntries,
    winnerEntryId,
    weekStatus,
    roundOutcome,
    needsAttention,
    pendingCount: resolution.kind === 'PENDING' ? resolution.pendingCount : 0,
    empty,
  };
}
