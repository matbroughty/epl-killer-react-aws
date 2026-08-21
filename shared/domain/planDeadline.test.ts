import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock.js';
import { planDeadlineProcessing, type DeadlineState } from './planDeadline.js';
import { selectionId, type Selection } from './types.js';
import {
  fixtures,
  roundEntry,
  roundWeek,
  selection,
  standingsSnapshot,
  teamId,
  teams,
} from './__fixtures__/builders.js';

const DEADLINE = '2026-08-22T14:00:00.000Z';
const BEFORE = fixedClock('2026-08-22T13:00:00.000Z');
const AFTER = fixedClock('2026-08-22T14:05:00.000Z');

function state(overrides: Partial<DeadlineState> = {}): DeadlineState {
  return {
    week: roundWeek({ deadline: DEADLINE, status: 'OPEN', matchday: 5 }),
    aliveEntries: [
      roundEntry({ id: 'entry-mat', playerId: 'player-mat' }),
      roundEntry({ id: 'entry-dave', playerId: 'player-dave' }),
      roundEntry({ id: 'entry-jase', playerId: 'player-jase' }),
    ],
    weekSelections: [],
    roundSelections: [],
    fixtures: fixtures({ matchday: 5 }),
    standings: standingsSnapshot(),
    teams: teams(),
    ...overrides,
  };
}

/**
 * Apply a plan to the state, the way the executor does.
 *
 * Kept deliberately literal — one branch per field of the plan — so it stays an
 * obvious mirror of the Lambda's writes. The idempotency property below is only
 * meaningful because the executor performs exactly these mutations and nothing
 * else.
 */
function apply(previous: DeadlineState, plan: ReturnType<typeof planDeadlineProcessing>): DeadlineState {
  const created: Selection[] = plan.createSelections.map((planned) => ({
    ...planned,
    outcome: 'PENDING',
    overridden: false,
    selectionType: 'AUTO_LOWEST_POSITION',
  }));

  const lockedIds = new Set(plan.lockSelections.map((lock) => lock.selectionId));

  const weekSelections = [
    ...previous.weekSelections.map((existing) =>
      lockedIds.has(existing.id)
        ? { ...existing, lockedAt: plan.lockSelections.find((l) => l.selectionId === existing.id)!.lockedAt }
        : existing,
    ),
    ...created,
  ];

  return {
    ...previous,
    week: plan.lockWeek
      ? {
          ...previous.week,
          status: plan.lockWeek.toStatus,
          standingsSnapshotId: plan.lockWeek.standingsSnapshotId,
        }
      : previous.week,
    weekSelections,
    roundSelections: [...previous.roundSelections, ...created],
  };
}

describe('planDeadlineProcessing', () => {
  it('does nothing before the deadline', () => {
    const plan = planDeadlineProcessing(state(), BEFORE);
    expect(plan.empty).toBe(true);
    expect(plan.lockWeek).toBeNull();
    expect(plan.createSelections).toEqual([]);
  });

  it('locks the week once the deadline has passed', () => {
    const plan = planDeadlineProcessing(state(), AFTER);
    expect(plan.lockWeek).toEqual({
      toStatus: 'LOCKED',
      lockedAt: '2026-08-22T14:05:00.000Z',
      standingsSnapshotId: 'snapshot-1',
    });
  });

  it('assigns the lowest-ranked eligible team to everybody who did not pick', () => {
    const plan = planDeadlineProcessing(state(), AFTER);

    expect(plan.createSelections).toHaveLength(3);
    for (const created of plan.createSelections) {
      expect(created).toMatchObject({
        teamId: teamId(20),
        teamName: 'Burnley',
        selectionType: 'AUTO_LOWEST_POSITION',
        autoReason: 'AUTO_LOWEST_POSITION',
        outcome: 'PENDING',
        overridden: false,
        standingsSnapshotId: 'snapshot-1',
      });
      // Locked at creation: an automatic pick is never editable.
      expect(created.lockedAt).toBe('2026-08-22T14:05:00.000Z');
      // The fixture is recorded so result processing does not have to guess.
      expect(created.fixtureId).toBeTruthy();
    }
  });

  it('respects each player’s own used teams when auto-assigning', () => {
    const plan = planDeadlineProcessing(
      state({
        roundSelections: [
          // Mat has already had the bottom two.
          selection({ roundWeekId: 'week-0', roundEntryId: 'entry-mat', teamId: teamId(20) }),
          selection({ roundWeekId: 'week-0b', roundEntryId: 'entry-mat', teamId: teamId(19) }),
          // Dave has only had the bottom one.
          selection({ roundWeekId: 'week-0', roundEntryId: 'entry-dave', teamId: teamId(20) }),
        ],
      }),
      AFTER,
    );

    const byEntry = new Map(plan.createSelections.map((s) => [s.roundEntryId, s.teamId]));
    expect(byEntry.get('entry-mat')).toBe(teamId(18));
    expect(byEntry.get('entry-dave')).toBe(teamId(19));
    expect(byEntry.get('entry-jase')).toBe(teamId(20));
  });

  it('leaves an existing manual pick completely alone', () => {
    const existing = selection({
      roundWeekId: 'week-1',
      roundEntryId: 'entry-mat',
      teamId: teamId(2),
      selectionType: 'MANUAL',
    });

    const plan = planDeadlineProcessing(
      state({ weekSelections: [existing], roundSelections: [existing] }),
      AFTER,
    );

    // No create for Mat.
    expect(plan.createSelections.map((s) => s.roundEntryId)).toEqual([
      'entry-dave',
      'entry-jase',
    ]);
    // Only a lock stamp, which does not touch the team.
    expect(plan.lockSelections).toEqual([
      { selectionId: existing.id, lockedAt: '2026-08-22T14:05:00.000Z' },
    ]);
  });

  it('stamps lockedAt on manual picks so they can be revealed', () => {
    const plan = planDeadlineProcessing(
      state({
        weekSelections: [
          selection({ roundEntryId: 'entry-mat', lockedAt: null }),
          selection({ roundEntryId: 'entry-dave', lockedAt: null }),
        ],
      }),
      AFTER,
    );
    expect(plan.lockSelections).toHaveLength(2);
  });

  it('skips entries that are not alive', () => {
    const plan = planDeadlineProcessing(
      state({
        aliveEntries: [
          roundEntry({ id: 'entry-mat', playerId: 'player-mat', status: 'ALIVE' }),
          roundEntry({ id: 'entry-out', playerId: 'player-out', status: 'ELIMINATED' }),
        ],
      }),
      AFTER,
    );
    expect(plan.createSelections.map((s) => s.roundEntryId)).toEqual(['entry-mat']);
  });

  it('records a null team with a reason when nothing is eligible', () => {
    const plan = planDeadlineProcessing(
      state({
        standings: standingsSnapshot({ rows: [] }),
        aliveEntries: [roundEntry({ id: 'entry-mat', playerId: 'player-mat' })],
      }),
      AFTER,
    );

    expect(plan.createSelections[0]).toMatchObject({
      teamId: null,
      teamName: null,
      autoReason: 'AUTO_NO_ELIGIBLE_TEAM',
    });
    expect(plan.auditNotes.join(' ')).toContain('No standings snapshot');
  });

  it('flags an exhausted set of teams distinctly from a missing snapshot', () => {
    const plan = planDeadlineProcessing(
      state({
        aliveEntries: [roundEntry({ id: 'entry-mat', playerId: 'player-mat' })],
        // `prior-*` so none of these collide with the week being processed,
        // which is excluded from the used-team set by design.
        roundSelections: teams().map((t, index) =>
          selection({ roundWeekId: `prior-${index}`, roundEntryId: 'entry-mat', teamId: t.id }),
        ),
      }),
      AFTER,
    );

    expect(plan.createSelections[0]).toMatchObject({
      teamId: null,
      autoReason: 'AUTO_NO_ELIGIBLE_TEAM',
    });
    expect(plan.auditNotes.join(' ')).toContain('already used or without a fixture');
  });

  it('uses deterministic selection ids so a duplicate create cannot succeed', () => {
    const plan = planDeadlineProcessing(state(), AFTER);
    expect(plan.createSelections.map((s) => s.id)).toEqual([
      selectionId('week-1', 'entry-mat'),
      selectionId('week-1', 'entry-dave'),
      selectionId('week-1', 'entry-jase'),
    ]);
  });

  it('carries an audit note explaining each automatic pick', () => {
    const plan = planDeadlineProcessing(
      state({
        roundSelections: [
          selection({ roundWeekId: 'week-0', roundEntryId: 'entry-mat', teamId: teamId(20) }),
        ],
        aliveEntries: [roundEntry({ id: 'entry-mat', playerId: 'player-mat' })],
      }),
      AFTER,
    );
    expect(plan.createSelections[0]!.auditNote).toContain('Sunderland');
    expect(plan.createSelections[0]!.auditNote).toContain('already used');
  });

  describe('idempotency', () => {
    it('produces an empty plan when re-run against its own result', () => {
      const initial = state();
      const first = planDeadlineProcessing(initial, AFTER);
      expect(first.empty).toBe(false);

      const afterFirst = apply(initial, first);
      const second = planDeadlineProcessing(afterFirst, AFTER);

      expect(second.empty).toBe(true);
      expect(second.createSelections).toEqual([]);
      expect(second.lockSelections).toEqual([]);
      expect(second.lockWeek).toBeNull();
    });

    it('does not change an automatic pick that already exists', () => {
      const initial = state();
      const first = planDeadlineProcessing(initial, AFTER);
      const afterFirst = apply(initial, first);

      // Even an hour later, and even though the table has since moved on.
      const later = fixedClock('2026-08-22T15:05:00.000Z');
      const second = planDeadlineProcessing(
        { ...afterFirst, standings: standingsSnapshot({ id: 'snapshot-2' }) },
        later,
      );

      expect(second.empty).toBe(true);
      expect(afterFirst.weekSelections.map((s) => s.teamId)).toEqual([
        teamId(20),
        teamId(20),
        teamId(20),
      ]);
    });

    it('is stable over many runs', () => {
      let current = state();
      for (let run = 0; run < 5; run += 1) {
        current = apply(current, planDeadlineProcessing(current, AFTER));
      }
      expect(current.weekSelections).toHaveLength(3);
      expect(planDeadlineProcessing(current, AFTER).empty).toBe(true);
    });

    it('finishes the job when an earlier run died between locking and stamping', () => {
      // Simulates a Lambda timeout: week locked, one pick left unstamped.
      const interrupted = state({
        week: roundWeek({ deadline: DEADLINE, status: 'LOCKED', matchday: 5 }),
        weekSelections: [selection({ roundEntryId: 'entry-mat', lockedAt: null })],
      });

      const plan = planDeadlineProcessing(interrupted, AFTER);
      expect(plan.empty).toBe(false);
      expect(plan.lockSelections).toHaveLength(1);
      // But it does not re-lock the week or invent picks for the others: that
      // work belongs to the run that locked it.
      expect(plan.lockWeek).toBeNull();
      expect(plan.createSelections).toEqual([]);

      expect(planDeadlineProcessing(apply(interrupted, plan), AFTER).empty).toBe(true);
    });

    it('does nothing for a week that is already complete', () => {
      const complete = state({
        week: roundWeek({ deadline: DEADLINE, status: 'COMPLETE', matchday: 5 }),
        weekSelections: [selection({ roundEntryId: 'entry-mat', lockedAt: DEADLINE })],
      });
      expect(planDeadlineProcessing(complete, AFTER).empty).toBe(true);
    });
  });
});
