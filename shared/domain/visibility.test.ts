import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock.js';
import {
  ANONYMOUS_VIEWER,
  redactPaid,
  redactSelections,
  type RedactableSelection,
  type Viewer,
} from './visibility.js';

const OPEN_WEEK = { id: 'week-3', deadline: '2026-08-22T14:00:00.000Z' };
const PAST_WEEK = { id: 'week-2', deadline: '2026-08-15T14:00:00.000Z' };
const WEEKS = [PAST_WEEK, OPEN_WEEK];

/** Before the current week's deadline, after the previous week's. */
const BEFORE_DEADLINE = fixedClock('2026-08-21T10:00:00.000Z');
const AFTER_DEADLINE = fixedClock('2026-08-22T14:00:00.000Z');

const MAT: Viewer = { kind: 'PLAYER', playerId: 'player-mat' };
const DAVE: Viewer = { kind: 'PLAYER', playerId: 'player-dave' };
const ADMIN: Viewer = { kind: 'ADMIN', playerId: 'player-mat' };

function pick(overrides: Partial<RedactableSelection> = {}): RedactableSelection {
  return {
    roundWeekId: OPEN_WEEK.id,
    playerId: 'player-dave',
    teamId: 'team-arsenal',
    teamName: 'Arsenal',
    teamCode: 'ARS',
    badgeUrl: 'https://crests.example/ars.svg',
    selectionType: 'MANUAL',
    outcome: 'PENDING',
    autoReason: null,
    ...overrides,
  };
}

describe('redactSelections before a deadline', () => {
  it('hides another player’s team but confirms they have submitted', () => {
    const [cell] = redactSelections([pick()], WEEKS, MAT, BEFORE_DEADLINE);

    expect(cell).toMatchObject({
      submitted: true,
      hidden: true,
      own: false,
      teamId: null,
      teamName: null,
      teamCode: null,
      badgeUrl: null,
    });
  });

  it('hides the selection type too, so an auto-pick is not leaked early', () => {
    const [cell] = redactSelections(
      [pick({ selectionType: 'AUTO_LOWEST_POSITION', autoReason: 'AUTO_LOWEST_POSITION' })],
      WEEKS,
      MAT,
      BEFORE_DEADLINE,
    );
    expect(cell!.selectionType).toBeNull();
    expect(cell!.autoReason).toBeNull();
  });

  it('hides the outcome, which would otherwise narrow down the team', () => {
    const [cell] = redactSelections([pick({ outcome: 'SURVIVED' })], WEEKS, MAT, BEFORE_DEADLINE);
    expect(cell!.outcome).toBeNull();
  });

  it('shows a player their own pick', () => {
    const [cell] = redactSelections(
      [pick({ playerId: 'player-mat' })],
      WEEKS,
      MAT,
      BEFORE_DEADLINE,
    );
    expect(cell).toMatchObject({ hidden: false, own: true, teamName: 'Arsenal' });
  });

  it('shows administrators every pick before the deadline', () => {
    const [cell] = redactSelections([pick()], WEEKS, ADMIN, BEFORE_DEADLINE);
    expect(cell).toMatchObject({ hidden: false, teamName: 'Arsenal', teamCode: 'ARS' });
  });

  it('hides picks from anonymous visitors', () => {
    const [cell] = redactSelections([pick()], WEEKS, ANONYMOUS_VIEWER, BEFORE_DEADLINE);
    expect(cell).toMatchObject({ hidden: true, submitted: true, teamName: null, own: false });
  });

  it('reveals a past week while still hiding the current one', () => {
    const cells = redactSelections(
      [pick({ roundWeekId: PAST_WEEK.id }), pick({ roundWeekId: OPEN_WEEK.id })],
      WEEKS,
      MAT,
      BEFORE_DEADLINE,
    );
    expect(cells[0]).toMatchObject({ hidden: false, teamName: 'Arsenal' });
    expect(cells[1]).toMatchObject({ hidden: true, teamName: null });
  });
});

describe('redactSelections after a deadline', () => {
  it('reveals every player’s team', () => {
    const cells = redactSelections(
      [pick(), pick({ playerId: 'player-jase', teamName: 'Chelsea', teamCode: 'CHE' })],
      WEEKS,
      MAT,
      AFTER_DEADLINE,
    );
    expect(cells.map((cell) => cell.teamName)).toEqual(['Arsenal', 'Chelsea']);
    expect(cells.every((cell) => !cell.hidden)).toBe(true);
  });

  it('reveals to anonymous visitors as well', () => {
    const [cell] = redactSelections([pick()], WEEKS, ANONYMOUS_VIEWER, AFTER_DEADLINE);
    expect(cell).toMatchObject({ hidden: false, teamName: 'Arsenal' });
  });

  it('reveals exactly on the deadline, not a second later', () => {
    // Viewed by Mat; the pick belongs to Dave, so only the clock decides.
    const [onTheDot] = redactSelections([pick()], WEEKS, MAT, fixedClock(OPEN_WEEK.deadline));
    expect(onTheDot!.hidden).toBe(false);

    const [aSecondBefore] = redactSelections(
      [pick()],
      WEEKS,
      MAT,
      fixedClock('2026-08-22T13:59:59.000Z'),
    );
    expect(aSecondBefore!.hidden).toBe(true);
  });

  it('reveals the selection type once the deadline has passed', () => {
    const [cell] = redactSelections(
      [pick({ selectionType: 'AUTO_LOWEST_POSITION', autoReason: 'AUTO_LOWEST_POSITION' })],
      WEEKS,
      MAT,
      AFTER_DEADLINE,
    );
    expect(cell!.selectionType).toBe('AUTO_LOWEST_POSITION');
    expect(cell!.autoReason).toBe('AUTO_LOWEST_POSITION');
  });
});

describe('redactSelections edge cases', () => {
  it('hides a pick for a week it knows nothing about, failing closed', () => {
    // A selection whose week is not in the list must not default to visible.
    const [cell] = redactSelections([pick({ roundWeekId: 'week-unknown' })], WEEKS, MAT, AFTER_DEADLINE);
    expect(cell!.hidden).toBe(true);
  });

  it('hides a pick for a week with no deadline set', () => {
    const [cell] = redactSelections(
      [pick({ roundWeekId: 'week-draft' })],
      [...WEEKS, { id: 'week-draft', deadline: null }],
      MAT,
      AFTER_DEADLINE,
    );
    expect(cell!.hidden).toBe(true);
  });

  it('does not treat a null viewer playerId as matching a null selection owner', () => {
    const anonymous: Viewer = { kind: 'ANONYMOUS', playerId: null };
    const [cell] = redactSelections([pick()], WEEKS, anonymous, BEFORE_DEADLINE);
    expect(cell!.own).toBe(false);
    expect(cell!.hidden).toBe(true);
  });
});

describe('redactPaid', () => {
  it('withholds payment status from the public', () => {
    expect(redactPaid(true, ANONYMOUS_VIEWER)).toBeNull();
  });

  it('shows payment status to signed-in players and admins', () => {
    expect(redactPaid(true, MAT)).toBe(true);
    expect(redactPaid(false, DAVE)).toBe(false);
    expect(redactPaid(true, ADMIN)).toBe(true);
  });
});
