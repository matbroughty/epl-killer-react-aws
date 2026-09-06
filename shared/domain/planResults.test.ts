import { describe, expect, it } from 'vitest';
import { planResultProcessing, type ResultPlan, type ResultState } from './planResults.js';
import { formatPence } from './money.js';
import type { FixtureWinner } from './types.js';
import {
  fixture,
  killerRound,
  roundEntry,
  roundWeek,
  selection,
  teamId,
} from './__fixtures__/builders.js';

const NOW = '2026-08-22T18:00:00.000Z';

/** A finished fixture between two teams with a known winner. */
function played(home: number, away: number, winner: FixtureWinner) {
  return fixture({
    id: `fixture-${home}-${away}`,
    matchday: 5,
    homeTeamId: teamId(home),
    awayTeamId: teamId(away),
    status: 'FINISHED',
    winner,
    homeGoals: winner === 'HOME' ? 1 : 0,
    awayGoals: winner === 'AWAY' ? 1 : 0,
  });
}

function state(overrides: Partial<ResultState> = {}): ResultState {
  return {
    round: killerRound(),
    week: roundWeek({ status: 'LOCKED', matchday: 5 }),
    selections: [],
    entries: [],
    fixtures: [],
    ...overrides,
  };
}

/**
 * Apply the plan, mirroring the executor's writes. Kept literal for the same
 * reason as the deadline applier: the idempotency property depends on this
 * being what actually happens.
 */
function apply(previous: ResultState, plan: ResultPlan): ResultState {
  return {
    ...previous,
    week: plan.weekStatus
      ? { ...previous.week, status: plan.weekStatus.toStatus }
      : previous.week,
    round:
      plan.roundOutcome?.kind === 'WON'
        ? { ...previous.round, status: 'WON', winnerPlayerId: plan.roundOutcome.winnerPlayerId }
        : plan.roundOutcome?.kind === 'ROLLOVER'
          ? { ...previous.round, status: 'ROLLOVER' }
          : previous.round,
    selections: previous.selections.map((existing) => {
      const update = plan.updateSelections.find((u) => u.selectionId === existing.id);
      return update
        ? { ...existing, outcome: update.outcome, fixtureId: update.fixtureId }
        : existing;
    }),
    entries: previous.entries.map((entry) =>
      plan.eliminateEntries.some((e) => e.roundEntryId === entry.id)
        ? { ...entry, status: 'ELIMINATED' as const, eliminatedRoundWeekId: plan.roundWeekId }
        : plan.winnerEntryId === entry.id && plan.roundOutcome?.kind === 'WON'
          ? { ...entry, status: 'WINNER' as const }
          : entry,
    ),
  };
}

describe('planResultProcessing', () => {
  it('marks a winning pick as survived and a losing pick as eliminated', () => {
    const plan = planResultProcessing(
      state({
        selections: [
          selection({ roundEntryId: 'entry-mat', teamId: teamId(1) }),
          selection({ roundEntryId: 'entry-dave', teamId: teamId(20) }),
        ],
        entries: [
          roundEntry({ id: 'entry-mat', playerId: 'player-mat' }),
          roundEntry({ id: 'entry-dave', playerId: 'player-dave' }),
        ],
        fixtures: [played(1, 20, 'HOME')],
      }),
      NOW,
    );

    expect(plan.updateSelections).toEqual([
      expect.objectContaining({ outcome: 'SURVIVED', resolvedAt: NOW }),
      expect.objectContaining({ outcome: 'ELIMINATED', resolvedAt: NOW }),
    ]);
    expect(plan.eliminateEntries).toEqual([
      { roundEntryId: 'entry-dave', eliminatedRoundWeekId: 'week-1' },
    ]);
  });

  it('declares the winner and the pot when one player is left', () => {
    const plan = planResultProcessing(
      state({
        round: killerRound({ rolloverInPence: 6_500 }),
        selections: [
          selection({ roundEntryId: 'entry-mat', teamId: teamId(1) }),
          selection({ roundEntryId: 'entry-dave', teamId: teamId(20) }),
        ],
        entries: [
          roundEntry({ id: 'entry-mat', playerId: 'player-mat', paid: true }),
          roundEntry({ id: 'entry-dave', playerId: 'player-dave', paid: true }),
        ],
        fixtures: [played(1, 20, 'HOME')],
      }),
      NOW,
    );

    expect(plan.winnerEntryId).toBe('entry-mat');
    expect(plan.roundOutcome).toEqual({
      kind: 'WON',
      winnerEntryId: 'entry-mat',
      winnerPlayerId: 'player-mat',
      potPence: 7_500,
    });
    expect(formatPence(7_500)).toBe('£75');
    expect(plan.weekStatus).toEqual({ toStatus: 'COMPLETE', at: NOW });
  });

  it('rolls over when every remaining player is eliminated in the same week', () => {
    const plan = planResultProcessing(
      state({
        round: killerRound({ rolloverInPence: 1_000 }),
        selections: [
          // Both picked the away side; the home side won.
          selection({ roundEntryId: 'entry-mat', teamId: teamId(20) }),
          selection({ roundEntryId: 'entry-dave', teamId: teamId(20) }),
        ],
        entries: [
          roundEntry({ id: 'entry-mat', playerId: 'player-mat' }),
          roundEntry({ id: 'entry-dave', playerId: 'player-dave' }),
        ],
        fixtures: [played(1, 20, 'HOME')],
      }),
      NOW,
    );

    expect(plan.winnerEntryId).toBeNull();
    // £10 carried in plus 2 x £5 = £20, all of it rolling on.
    expect(plan.roundOutcome).toEqual({ kind: 'ROLLOVER', rolloverOutPence: 2_000 });
    expect(plan.eliminateEntries).toHaveLength(2);
  });

  it('rolls over on a shared draw, since a draw eliminates', () => {
    const plan = planResultProcessing(
      state({
        selections: [
          selection({ roundEntryId: 'entry-mat', teamId: teamId(1) }),
          selection({ roundEntryId: 'entry-dave', teamId: teamId(20) }),
        ],
        entries: [
          roundEntry({ id: 'entry-mat', playerId: 'player-mat' }),
          roundEntry({ id: 'entry-dave', playerId: 'player-dave' }),
        ],
        fixtures: [played(1, 20, 'DRAW')],
      }),
      NOW,
    );
    expect(plan.roundOutcome).toMatchObject({ kind: 'ROLLOVER' });
  });

  it('continues when two or more survive, without creating the next week', () => {
    const plan = planResultProcessing(
      state({
        selections: [
          selection({ roundEntryId: 'entry-mat', teamId: teamId(1) }),
          selection({ roundEntryId: 'entry-jase', teamId: teamId(2) }),
          selection({ roundEntryId: 'entry-dave', teamId: teamId(20) }),
        ],
        entries: [
          roundEntry({ id: 'entry-mat', playerId: 'player-mat' }),
          roundEntry({ id: 'entry-jase', playerId: 'player-jase' }),
          roundEntry({ id: 'entry-dave', playerId: 'player-dave' }),
        ],
        fixtures: [played(1, 20, 'HOME'), played(2, 19, 'HOME')],
      }),
      NOW,
    );

    expect(plan.roundOutcome).toEqual({ kind: 'CONTINUE', survivorCount: 2 });
    expect(plan.winnerEntryId).toBeNull();
    // The admin chooses the next gameweek; nothing here does it for them.
    expect(plan).not.toHaveProperty('createNextWeek');
  });

  it('stays pending on a postponed fixture and decides nothing', () => {
    const plan = planResultProcessing(
      state({
        selections: [
          selection({ roundEntryId: 'entry-mat', teamId: teamId(1) }),
          selection({ roundEntryId: 'entry-dave', teamId: teamId(3) }),
        ],
        entries: [
          roundEntry({ id: 'entry-mat', playerId: 'player-mat' }),
          roundEntry({ id: 'entry-dave', playerId: 'player-dave' }),
        ],
        fixtures: [
          played(1, 20, 'AWAY'),
          fixture({ matchday: 5, homeTeamId: teamId(3), awayTeamId: teamId(18), status: 'POSTPONED' }),
        ],
      }),
      NOW,
    );

    expect(plan.pendingCount).toBe(1);
    // The *round* is undecided: no winner and no rollover while a fixture could
    // still change who is last standing.
    expect(plan.roundOutcome).toBeNull();
    expect(plan.winnerEntryId).toBeNull();
    expect(plan.weekStatus).toEqual({ toStatus: 'RESULTS_PENDING', at: NOW });
    // But the player whose team has already lost is out immediately. Their
    // fixture finished and there is no way back from it, so making them wait
    // would show a lost pick next to an "Alive" status.
    expect(plan.eliminateEntries).toEqual([
      { roundEntryId: 'entry-mat', eliminatedRoundWeekId: 'week-1' },
    ]);
  });

  it('eliminates on a resolved fixture even when the gameweek spans days', () => {
    // The real shape of a Premier League gameweek: Friday night, Saturday
    // lunchtime, Sunday afternoon. Two results in, one to come.
    const plan = planResultProcessing(
      state({
        selections: [
          selection({ roundEntryId: 'entry-a', teamId: teamId(1) }), // won
          selection({ roundEntryId: 'entry-b', teamId: teamId(20) }), // lost
          selection({ roundEntryId: 'entry-c', teamId: teamId(5) }), // not played
        ],
        entries: [
          roundEntry({ id: 'entry-a', playerId: 'player-a' }),
          roundEntry({ id: 'entry-b', playerId: 'player-b' }),
          roundEntry({ id: 'entry-c', playerId: 'player-c' }),
        ],
        fixtures: [
          played(1, 20, 'HOME'),
          fixture({ matchday: 5, homeTeamId: teamId(5), awayTeamId: teamId(16), status: 'TIMED' }),
        ],
      }),
      NOW,
    );

    expect(plan.eliminateEntries).toEqual([
      { roundEntryId: 'entry-b', eliminatedRoundWeekId: 'week-1' },
    ]);
    expect(plan.pendingCount).toBe(1);
    expect(plan.roundOutcome).toBeNull();
  });

  it('does not eliminate on a draw that has not been played yet', () => {
    // Guards the obvious mistake: an unplayed fixture must not read as a draw
    // just because both goal counts are null.
    const plan = planResultProcessing(
      state({
        selections: [selection({ roundEntryId: 'entry-a', teamId: teamId(1) })],
        entries: [roundEntry({ id: 'entry-a', playerId: 'player-a' })],
        fixtures: [
          fixture({ matchday: 5, homeTeamId: teamId(1), awayTeamId: teamId(20), status: 'TIMED' }),
        ],
      }),
      NOW,
    );
    expect(plan.eliminateEntries).toEqual([]);
    expect(plan.pendingCount).toBe(1);
  });

  it('flags a cancelled fixture for the administrator', () => {
    const plan = planResultProcessing(
      state({
        selections: [selection({ roundEntryId: 'entry-mat', teamId: teamId(1) })],
        entries: [roundEntry({ id: 'entry-mat', playerId: 'player-mat' })],
        fixtures: [
          fixture({ matchday: 5, homeTeamId: teamId(1), awayTeamId: teamId(20), status: 'CANCELLED' }),
        ],
      }),
      NOW,
    );

    expect(plan.needsAttention).toEqual([
      expect.objectContaining({ reason: expect.stringContaining('cancelled') }),
    ]);
    expect(plan.pendingCount).toBe(1);
  });

  it('does not re-eliminate an entry already marked out', () => {
    const plan = planResultProcessing(
      state({
        selections: [selection({ roundEntryId: 'entry-dave', teamId: teamId(20), outcome: 'ELIMINATED' })],
        entries: [
          roundEntry({
            id: 'entry-dave',
            playerId: 'player-dave',
            status: 'ELIMINATED',
            eliminatedRoundWeekId: 'week-1',
          }),
        ],
        fixtures: [played(1, 20, 'HOME')],
      }),
      NOW,
    );
    expect(plan.eliminateEntries).toEqual([]);
  });

  it('respects an admin override and does not overwrite it', () => {
    const plan = planResultProcessing(
      state({
        selections: [
          selection({
            roundEntryId: 'entry-dave',
            teamId: teamId(20),
            outcome: 'SURVIVED',
            overridden: true,
          }),
        ],
        entries: [roundEntry({ id: 'entry-dave', playerId: 'player-dave' })],
        // The provider says their team lost.
        fixtures: [played(1, 20, 'HOME')],
      }),
      NOW,
    );

    expect(plan.updateSelections).toEqual([]);
    expect(plan.eliminateEntries).toEqual([]);
    expect(plan.roundOutcome).toMatchObject({ kind: 'WON' });
  });

  describe('leniency when the next Round Week opens', () => {
    const postponedScenario = () =>
      state({
        selections: [
          selection({ roundEntryId: 'entry-mat', teamId: teamId(1) }), // won
          selection({ roundEntryId: 'entry-dave', teamId: teamId(3) }), // postponed
        ],
        entries: [
          roundEntry({ id: 'entry-mat', playerId: 'player-mat' }),
          roundEntry({ id: 'entry-dave', playerId: 'player-dave' }),
        ],
        fixtures: [
          played(1, 20, 'HOME'),
          fixture({ matchday: 5, homeTeamId: teamId(3), awayTeamId: teamId(18), status: 'POSTPONED' }),
        ],
      });

    it('leaves the week unresolved when leniency is not applied', () => {
      const plan = planResultProcessing(postponedScenario(), NOW);
      expect(plan.pendingCount).toBe(1);
      expect(plan.lenientSurvivals).toEqual([]);
      expect(plan.roundOutcome).toBeNull();
    });

    it('puts an unresolved pick through as a win', () => {
      const plan = planResultProcessing(postponedScenario(), NOW, { applyLeniency: true });

      expect(plan.lenientSurvivals).toEqual([
        { selectionId: 'week-1#entry-dave', teamName: 'Liverpool' },
      ]);
      expect(plan.updateSelections).toContainEqual(
        expect.objectContaining({
          selectionId: 'week-1#entry-dave',
          outcome: 'SURVIVED',
          overridden: true,
        }),
      );
      // The week can now settle, which is the whole point.
      expect(plan.pendingCount).toBe(0);
      expect(plan.roundOutcome).toEqual({ kind: 'CONTINUE', survivorCount: 2 });
    });

    it('marks the ruling final so a later result cannot reverse it', () => {
      // Apply leniency, then play the rearranged fixture — and lose it.
      const initial = postponedScenario();
      const lenient = planResultProcessing(initial, NOW, { applyLeniency: true });
      const afterLeniency = apply(initial, lenient);

      // Mirror the executor: leniency sets `overridden` on the record.
      const settled: ResultState = {
        ...afterLeniency,
        selections: afterLeniency.selections.map((s) =>
          s.roundEntryId === 'entry-dave' ? { ...s, overridden: true } : s,
        ),
        fixtures: [played(1, 20, 'HOME'), played(3, 18, 'AWAY')], // team-03 lost
      };

      const later = planResultProcessing(settled, '2026-09-10T21:00:00.000Z');
      expect(later.updateSelections).toEqual([]);
      expect(later.eliminateEntries).toEqual([]);
    });

    it('never overturns a result that did resolve', () => {
      // Leniency only ever upgrades a PENDING. A genuine loss stays a loss.
      const plan = planResultProcessing(
        state({
          selections: [selection({ roundEntryId: 'entry-dave', teamId: teamId(20) })],
          entries: [roundEntry({ id: 'entry-dave', playerId: 'player-dave' })],
          fixtures: [played(1, 20, 'HOME')],
        }),
        NOW,
        { applyLeniency: true },
      );

      expect(plan.lenientSurvivals).toEqual([]);
      expect(plan.updateSelections[0]).toMatchObject({ outcome: 'ELIMINATED' });
      expect(plan.eliminateEntries).toHaveLength(1);
    });

    it('can produce a winner that a postponement was holding up', () => {
      const plan = planResultProcessing(
        state({
          selections: [
            selection({ roundEntryId: 'entry-mat', teamId: teamId(3) }), // postponed
            selection({ roundEntryId: 'entry-dave', teamId: teamId(20) }), // lost
          ],
          entries: [
            roundEntry({ id: 'entry-mat', playerId: 'player-mat' }),
            roundEntry({ id: 'entry-dave', playerId: 'player-dave' }),
          ],
          fixtures: [
            played(1, 20, 'HOME'),
            fixture({ matchday: 5, homeTeamId: teamId(3), awayTeamId: teamId(18), status: 'POSTPONED' }),
          ],
        }),
        NOW,
        { applyLeniency: true },
      );

      expect(plan.roundOutcome).toMatchObject({ kind: 'WON', winnerPlayerId: 'player-mat' });
    });

    it('is idempotent — a second lenient run changes nothing', () => {
      const initial = postponedScenario();
      const first = planResultProcessing(initial, NOW, { applyLeniency: true });
      const afterFirst: ResultState = {
        ...apply(initial, first),
        selections: apply(initial, first).selections.map((s) =>
          s.roundEntryId === 'entry-dave' ? { ...s, overridden: true } : s,
        ),
      };
      const second = planResultProcessing(afterFirst, NOW, { applyLeniency: true });
      expect(second.empty).toBe(true);
      expect(second.lenientSurvivals).toEqual([]);
    });
  });

  describe('idempotency', () => {
    const winnerScenario = () =>
      state({
        round: killerRound({ rolloverInPence: 500 }),
        selections: [
          selection({ roundEntryId: 'entry-mat', teamId: teamId(1) }),
          selection({ roundEntryId: 'entry-dave', teamId: teamId(20) }),
        ],
        entries: [
          roundEntry({ id: 'entry-mat', playerId: 'player-mat' }),
          roundEntry({ id: 'entry-dave', playerId: 'player-dave' }),
        ],
        fixtures: [played(1, 20, 'HOME')],
      });

    it('produces an empty plan when re-run against its own result', () => {
      const initial = winnerScenario();
      const first = planResultProcessing(initial, NOW);
      expect(first.empty).toBe(false);

      const second = planResultProcessing(apply(initial, first), NOW);
      expect(second.empty).toBe(true);
      expect(second.updateSelections).toEqual([]);
      expect(second.eliminateEntries).toEqual([]);
      expect(second.roundOutcome).toBeNull();
    });

    it('is stable over many runs and does not pay out twice', () => {
      let current = winnerScenario();
      const outcomes: string[] = [];
      for (let run = 0; run < 4; run += 1) {
        const plan = planResultProcessing(current, NOW);
        if (plan.roundOutcome) outcomes.push(plan.roundOutcome.kind);
        current = apply(current, plan);
      }
      // The round is won exactly once.
      expect(outcomes).toEqual(['WON']);
      expect(current.round.status).toBe('WON');
    });

    it('resolves a postponed fixture on a later run without disturbing the rest', () => {
      const pending = state({
        selections: [
          selection({ roundEntryId: 'entry-mat', teamId: teamId(1), outcome: 'PENDING' }),
          selection({ roundEntryId: 'entry-dave', teamId: teamId(3), outcome: 'PENDING' }),
        ],
        entries: [
          roundEntry({ id: 'entry-mat', playerId: 'player-mat' }),
          roundEntry({ id: 'entry-dave', playerId: 'player-dave' }),
        ],
        fixtures: [
          played(1, 20, 'HOME'),
          fixture({ matchday: 5, homeTeamId: teamId(3), awayTeamId: teamId(18), status: 'POSTPONED' }),
        ],
      });

      const first = planResultProcessing(pending, NOW);
      expect(first.pendingCount).toBe(1);
      const afterFirst = apply(pending, first);

      // The rearranged match is played and imported.
      const rearranged: ResultState = {
        ...afterFirst,
        fixtures: [played(1, 20, 'HOME'), played(3, 18, 'AWAY')],
      };

      const second = planResultProcessing(rearranged, '2026-09-10T21:00:00.000Z');
      expect(second.roundOutcome).toMatchObject({ kind: 'WON', winnerPlayerId: 'player-mat' });
      expect(second.eliminateEntries).toEqual([
        { roundEntryId: 'entry-dave', eliminatedRoundWeekId: 'week-1' },
      ]);

      expect(planResultProcessing(apply(rearranged, second), NOW).empty).toBe(true);
    });
  });
});
