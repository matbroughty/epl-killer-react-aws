import { describe, expect, it } from 'vitest';
import { fixedClock, isPastDeadline, millisUntil, parseInstant } from './clock.js';
import {
  couldHaveResults,
  isDueForDeadlineProcessing,
  isStandingsSnapshotFresh,
  proposeDeadline,
  shouldPrefetchStandings,
} from './deadlines.js';
import { fixture } from './__fixtures__/builders.js';

describe('proposeDeadline', () => {
  it('takes the kick-off of the first fixture in the gameweek', () => {
    const proposed = proposeDeadline([
      fixture({ utcKickoff: '2026-08-23T15:30:00.000Z' }),
      fixture({ utcKickoff: '2026-08-22T11:30:00.000Z' }),
      fixture({ utcKickoff: '2026-08-22T14:00:00.000Z' }),
    ]);
    expect(proposed).toBe('2026-08-22T11:30:00.000Z');
  });

  it('ignores a cancelled fixture, even the earliest one', () => {
    const proposed = proposeDeadline([
      fixture({ utcKickoff: '2026-08-21T19:00:00.000Z', status: 'CANCELLED' }),
      fixture({ utcKickoff: '2026-08-22T11:30:00.000Z' }),
    ]);
    expect(proposed).toBe('2026-08-22T11:30:00.000Z');
  });

  it('still counts a postponed fixture, so the deadline is not pushed back', () => {
    // The slot existed; moving the deadline later would let people pick after
    // other matches had kicked off.
    const proposed = proposeDeadline([
      fixture({ utcKickoff: '2026-08-21T19:00:00.000Z', status: 'POSTPONED' }),
      fixture({ utcKickoff: '2026-08-22T11:30:00.000Z' }),
    ]);
    expect(proposed).toBe('2026-08-21T19:00:00.000Z');
  });

  it('returns null when no fixtures have been imported, rather than inventing a time', () => {
    expect(proposeDeadline([])).toBeNull();
  });

  it('ignores an unparseable kick-off', () => {
    const proposed = proposeDeadline([
      fixture({ utcKickoff: 'not a date' }),
      fixture({ utcKickoff: '2026-08-22T11:30:00.000Z' }),
    ]);
    expect(proposed).toBe('2026-08-22T11:30:00.000Z');
  });
});

describe('isPastDeadline', () => {
  const deadline = '2026-08-22T14:00:00.000Z';

  it('is false before, true at, and true after the deadline', () => {
    expect(isPastDeadline(deadline, fixedClock('2026-08-22T13:59:59.999Z'))).toBe(false);
    expect(isPastDeadline(deadline, fixedClock(deadline))).toBe(true);
    expect(isPastDeadline(deadline, fixedClock('2026-08-22T14:00:00.001Z'))).toBe(true);
  });

  it('treats a missing deadline as not reached, so nobody is locked out by a misconfiguration', () => {
    const now = fixedClock('2030-01-01T00:00:00.000Z');
    expect(isPastDeadline(null, now)).toBe(false);
    expect(isPastDeadline(undefined, now)).toBe(false);
    expect(isPastDeadline('nonsense', now)).toBe(false);
  });

  it('is unaffected by British Summer Time, because everything is UTC', () => {
    // 15:00 London in August is 14:00 UTC. A pick at 14:30 London (13:30 UTC)
    // is still in time.
    const bstAfternoon = fixedClock('2026-08-22T13:30:00.000Z');
    expect(isPastDeadline('2026-08-22T14:00:00.000Z', bstAfternoon)).toBe(false);
  });
});

describe('millisUntil', () => {
  it('counts down and goes negative once passed', () => {
    const clock = fixedClock('2026-08-22T13:00:00.000Z');
    expect(millisUntil('2026-08-22T14:00:00.000Z', clock)).toBe(3_600_000);
    expect(millisUntil('2026-08-22T12:00:00.000Z', clock)).toBe(-3_600_000);
    expect(millisUntil(null, clock)).toBeNull();
  });
});

describe('parseInstant', () => {
  it('returns null rather than NaN for bad input', () => {
    expect(parseInstant('2026-08-22T14:00:00.000Z')).toBe(1787407200000);
    expect(parseInstant('rubbish')).toBeNull();
    expect(parseInstant(null)).toBeNull();
    expect(parseInstant('')).toBeNull();
  });
});

describe('couldHaveResults', () => {
  it('is false until two hours after the earliest kick-off', () => {
    const kickoff = '2026-08-22T14:00:00.000Z';
    expect(couldHaveResults([fixture({ utcKickoff: kickoff })], fixedClock('2026-08-22T15:30:00.000Z'))).toBe(false);
    expect(couldHaveResults([fixture({ utcKickoff: kickoff })], fixedClock('2026-08-22T16:00:00.000Z'))).toBe(true);
  });

  it('is true as soon as any fixture could have finished', () => {
    const fixtures = [
      fixture({ utcKickoff: '2026-08-22T11:30:00.000Z' }),
      fixture({ utcKickoff: '2026-08-23T15:30:00.000Z' }),
    ];
    expect(couldHaveResults(fixtures, fixedClock('2026-08-22T13:31:00.000Z'))).toBe(true);
  });

  it('is false with no fixtures', () => {
    expect(couldHaveResults([], fixedClock('2026-08-22T20:00:00.000Z'))).toBe(false);
  });
});

describe('isStandingsSnapshotFresh', () => {
  const now = fixedClock('2026-08-22T14:00:00.000Z');

  it('accepts a snapshot from within the last six hours', () => {
    expect(isStandingsSnapshotFresh('2026-08-22T09:00:00.000Z', now)).toBe(true);
  });

  it('rejects an older snapshot, so auto-picks use the table at the deadline', () => {
    expect(isStandingsSnapshotFresh('2026-08-21T09:00:00.000Z', now)).toBe(false);
  });

  it('rejects a missing or malformed snapshot timestamp', () => {
    expect(isStandingsSnapshotFresh(null, now)).toBe(false);
    expect(isStandingsSnapshotFresh('whenever', now)).toBe(false);
  });
});

describe('shouldPrefetchStandings', () => {
  it('is true within the hour before a deadline', () => {
    expect(shouldPrefetchStandings('2026-08-22T14:00:00.000Z', fixedClock('2026-08-22T13:30:00.000Z'))).toBe(true);
  });

  it('is false well before a deadline, to avoid pointless provider calls', () => {
    expect(shouldPrefetchStandings('2026-08-22T14:00:00.000Z', fixedClock('2026-08-22T09:00:00.000Z'))).toBe(false);
  });

  it('is true after a deadline, since processing still needs a table', () => {
    expect(shouldPrefetchStandings('2026-08-22T14:00:00.000Z', fixedClock('2026-08-22T14:10:00.000Z'))).toBe(true);
  });

  it('is false with no deadline', () => {
    expect(shouldPrefetchStandings(null, fixedClock('2026-08-22T14:00:00.000Z'))).toBe(false);
  });
});

describe('isDueForDeadlineProcessing', () => {
  const after = fixedClock('2026-08-22T14:05:00.000Z');
  const before = fixedClock('2026-08-22T13:05:00.000Z');
  const deadline = '2026-08-22T14:00:00.000Z';

  it('is due for an open week whose deadline has passed', () => {
    expect(isDueForDeadlineProcessing({ status: 'OPEN', deadline }, after)).toBe(true);
  });

  it('is due for a draft week whose deadline has passed, so it cannot be missed', () => {
    expect(isDueForDeadlineProcessing({ status: 'DRAFT', deadline }, after)).toBe(true);
  });

  it('is not due before the deadline', () => {
    expect(isDueForDeadlineProcessing({ status: 'OPEN', deadline }, before)).toBe(false);
  });

  it.each(['LOCKED', 'RESULTS_PENDING', 'COMPLETE'])('is not due for a %s week', (status) => {
    expect(isDueForDeadlineProcessing({ status, deadline }, after)).toBe(false);
  });
});
