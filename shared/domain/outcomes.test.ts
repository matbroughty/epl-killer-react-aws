import { describe, expect, it } from 'vitest';
import { needsAdminAttention, resolveOutcome, resolveRoundWeek } from './outcomes.js';
import type { FixtureStatus } from './types.js';
import { fixture, selection, teamId } from './__fixtures__/builders.js';

/** The player picked the home side, `team-01`. */
const pickedHome = selection({ teamId: teamId(1) });
/** The player picked the away side, `team-20`. */
const pickedAway = selection({ teamId: teamId(20) });

const finished = (winner: 'HOME' | 'AWAY' | 'DRAW') =>
  fixture({
    status: 'FINISHED',
    winner,
    homeTeamId: teamId(1),
    awayTeamId: teamId(20),
    homeGoals: winner === 'HOME' ? 2 : winner === 'DRAW' ? 1 : 0,
    awayGoals: winner === 'AWAY' ? 2 : winner === 'DRAW' ? 1 : 0,
  });

describe('resolveOutcome', () => {
  it('survives when the selected team wins at home', () => {
    expect(resolveOutcome({ selection: pickedHome, fixture: finished('HOME') })).toBe(
      'SURVIVED',
    );
  });

  it('survives when the selected team wins away', () => {
    expect(resolveOutcome({ selection: pickedAway, fixture: finished('AWAY') })).toBe(
      'SURVIVED',
    );
  });

  it('eliminates on a draw', () => {
    expect(resolveOutcome({ selection: pickedHome, fixture: finished('DRAW') })).toBe(
      'ELIMINATED',
    );
    expect(resolveOutcome({ selection: pickedAway, fixture: finished('DRAW') })).toBe(
      'ELIMINATED',
    );
  });

  it('eliminates on a loss', () => {
    expect(resolveOutcome({ selection: pickedHome, fixture: finished('AWAY') })).toBe(
      'ELIMINATED',
    );
    expect(resolveOutcome({ selection: pickedAway, fixture: finished('HOME') })).toBe(
      'ELIMINATED',
    );
  });

  it('treats an awarded match as a real result', () => {
    const awarded = fixture({
      status: 'AWARDED',
      winner: 'HOME',
      homeTeamId: teamId(1),
      awayTeamId: teamId(20),
    });
    expect(resolveOutcome({ selection: pickedHome, fixture: awarded })).toBe('SURVIVED');
    expect(resolveOutcome({ selection: pickedAway, fixture: awarded })).toBe('ELIMINATED');
  });

  it('leaves a postponed fixture pending rather than eliminating the player', () => {
    const postponed = fixture({ status: 'POSTPONED', winner: null });
    expect(resolveOutcome({ selection: pickedHome, fixture: postponed })).toBe('PENDING');
  });

  it.each<FixtureStatus>([
    'SCHEDULED',
    'TIMED',
    'IN_PLAY',
    'PAUSED',
    'POSTPONED',
    'SUSPENDED',
    'CANCELLED',
    'UNKNOWN',
  ])('leaves a %s fixture pending', (status) => {
    expect(resolveOutcome({ selection: pickedHome, fixture: fixture({ status }) })).toBe(
      'PENDING',
    );
  });

  it('never eliminates on an unrecognised provider status', () => {
    // The mapper turns anything it does not know into UNKNOWN; this asserts the
    // consequence, which is that nobody goes out because of a provider change.
    const odd = fixture({ status: 'UNKNOWN', winner: 'AWAY' });
    expect(resolveOutcome({ selection: pickedHome, fixture: odd })).toBe('PENDING');
  });

  it('stays pending when the fixture has not been imported', () => {
    expect(resolveOutcome({ selection: pickedHome, fixture: null })).toBe('PENDING');
  });

  it('stays pending when a finished fixture has no winner recorded', () => {
    const noWinner = fixture({ status: 'FINISHED', winner: null });
    expect(resolveOutcome({ selection: pickedHome, fixture: noWinner })).toBe('PENDING');
  });

  it('survives a week where the auto-picker found nobody eligible', () => {
    // The player cannot be punished for a gap in the fixture list.
    const noTeam = selection({
      teamId: null,
      selectionType: 'AUTO_LOWEST_POSITION',
      autoReason: 'AUTO_NO_ELIGIBLE_TEAM',
    });
    expect(resolveOutcome({ selection: noTeam, fixture: null })).toBe('SURVIVED');
  });

  it('keeps an admin override, whatever the provider later says', () => {
    const overriddenSurvival = selection({
      teamId: teamId(1),
      outcome: 'SURVIVED',
      overridden: true,
    });
    expect(
      resolveOutcome({ selection: overriddenSurvival, fixture: finished('AWAY') }),
    ).toBe('SURVIVED');

    const overriddenElimination = selection({
      teamId: teamId(1),
      outcome: 'ELIMINATED',
      overridden: true,
    });
    expect(
      resolveOutcome({ selection: overriddenElimination, fixture: finished('HOME') }),
    ).toBe('ELIMINATED');
  });
});

describe('needsAdminAttention', () => {
  it('flags a cancelled fixture, which will never produce a result', () => {
    expect(needsAdminAttention(fixture({ status: 'CANCELLED' }))).toBe(true);
  });

  it('flags an unrecognised state', () => {
    expect(needsAdminAttention(fixture({ status: 'UNKNOWN' }))).toBe(true);
  });

  it('does not flag a postponed fixture, which is expected to be rearranged', () => {
    expect(needsAdminAttention(fixture({ status: 'POSTPONED' }))).toBe(false);
  });

  it('does not flag a normal fixture', () => {
    expect(needsAdminAttention(fixture({ status: 'FINISHED' }))).toBe(false);
    expect(needsAdminAttention(null)).toBe(false);
  });
});

describe('resolveRoundWeek', () => {
  it('reports pending while any selection is unresolved, even with one survivor', () => {
    // Critical: we must not crown a winner while a postponed fixture could
    // still eliminate them.
    const resolution = resolveRoundWeek({
      selections: [
        { roundEntryId: 'a', outcome: 'SURVIVED' },
        { roundEntryId: 'b', outcome: 'PENDING' },
        { roundEntryId: 'c', outcome: 'ELIMINATED' },
      ],
    });
    expect(resolution).toEqual({ kind: 'PENDING', pendingCount: 1 });
  });

  it('declares a winner when exactly one player survives', () => {
    const resolution = resolveRoundWeek({
      selections: [
        { roundEntryId: 'a', outcome: 'ELIMINATED' },
        { roundEntryId: 'b', outcome: 'SURVIVED' },
        { roundEntryId: 'c', outcome: 'ELIMINATED' },
      ],
    });
    expect(resolution).toEqual({ kind: 'WINNER', roundEntryId: 'b' });
  });

  it('rolls over when everybody goes out in the same week', () => {
    const resolution = resolveRoundWeek({
      selections: [
        { roundEntryId: 'a', outcome: 'ELIMINATED' },
        { roundEntryId: 'b', outcome: 'ELIMINATED' },
      ],
    });
    expect(resolution).toEqual({ kind: 'ROLLOVER' });
  });

  it('continues when two or more survive', () => {
    const resolution = resolveRoundWeek({
      selections: [
        { roundEntryId: 'a', outcome: 'SURVIVED' },
        { roundEntryId: 'b', outcome: 'SURVIVED' },
        { roundEntryId: 'c', outcome: 'ELIMINATED' },
      ],
    });
    expect(resolution).toEqual({ kind: 'CONTINUE', survivorEntryIds: ['a', 'b'] });
  });

  it('rolls over on an empty week rather than crashing', () => {
    expect(resolveRoundWeek({ selections: [] })).toEqual({ kind: 'ROLLOVER' });
  });

  it('treats a legacy UNKNOWN outcome as unresolved', () => {
    const resolution = resolveRoundWeek({
      selections: [{ roundEntryId: 'a', outcome: 'UNKNOWN' }],
    });
    expect(resolution).toMatchObject({ kind: 'PENDING' });
  });
});
