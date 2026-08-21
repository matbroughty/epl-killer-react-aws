import { describe, expect, it } from 'vitest';
import { pickAutoTeam } from './autoSelection.js';
import { fixture, fixtures, standingsRows, teamId } from './__fixtures__/builders.js';

describe('pickAutoTeam', () => {
  it('picks the team in 20th position when it is eligible', () => {
    const result = pickAutoTeam({
      standings: standingsRows(),
      fixtures: fixtures(),
      usedTeamIds: [],
    });

    expect(result).toMatchObject({
      teamId: teamId(20),
      position: 20,
      reason: 'AUTO_LOWEST_POSITION',
    });
    expect(result.skipped).toEqual([]);
  });

  it('works upwards from 20th, skipping teams the player has already used', () => {
    const result = pickAutoTeam({
      standings: standingsRows(),
      fixtures: fixtures(),
      usedTeamIds: [teamId(20), teamId(19), teamId(18)],
    });

    expect(result.teamId).toBe(teamId(17));
    expect(result.position).toBe(17);
    expect(result.skipped).toEqual([
      { teamId: teamId(20), position: 20, because: 'USED' },
      { teamId: teamId(19), position: 19, because: 'USED' },
      { teamId: teamId(18), position: 18, because: 'USED' },
    ]);
  });

  it('skips teams with no fixture in the gameweek', () => {
    // Blank gameweek for the bottom two: their fixture is simply absent.
    const withoutBottomTwo = fixtures().filter(
      (f) => f.awayTeamId !== teamId(20) && f.awayTeamId !== teamId(19),
    );

    const result = pickAutoTeam({
      standings: standingsRows(),
      fixtures: withoutBottomTwo,
      usedTeamIds: [],
    });

    expect(result.teamId).toBe(teamId(18));
    expect(result.skipped).toEqual([
      { teamId: teamId(20), position: 20, because: 'NO_FIXTURE' },
      { teamId: teamId(19), position: 19, because: 'NO_FIXTURE' },
    ]);
  });

  it('skips a team whose fixture was cancelled', () => {
    const withCancellation = fixtures().map((f) =>
      f.awayTeamId === teamId(20) ? { ...f, status: 'CANCELLED' as const } : f,
    );

    const result = pickAutoTeam({
      standings: standingsRows(),
      fixtures: withCancellation,
      usedTeamIds: [],
    });

    expect(result.teamId).toBe(teamId(19));
    expect(result.skipped).toEqual([
      { teamId: teamId(20), position: 20, because: 'NO_FIXTURE' },
    ]);
  });

  it('still assigns a team whose fixture is postponed, since it should be rearranged', () => {
    const withPostponement = fixtures().map((f) =>
      f.awayTeamId === teamId(20) ? { ...f, status: 'POSTPONED' as const } : f,
    );

    const result = pickAutoTeam({
      standings: standingsRows(),
      fixtures: withPostponement,
      usedTeamIds: [],
    });

    expect(result.teamId).toBe(teamId(20));
  });

  it('combines both exclusions, taking the lowest team that satisfies each', () => {
    const withoutSeventeenth = fixtures().filter(
      (f) => f.homeTeamId !== teamId(17) && f.awayTeamId !== teamId(17),
    );

    const result = pickAutoTeam({
      standings: standingsRows(),
      fixtures: withoutSeventeenth,
      usedTeamIds: [teamId(20), teamId(18)],
    });

    // 20 used, 19 available -> 19.
    expect(result.teamId).toBe(teamId(19));

    const deeper = pickAutoTeam({
      standings: standingsRows(),
      fixtures: withoutSeventeenth,
      usedTeamIds: [teamId(20), teamId(19), teamId(18)],
    });

    // 20/19/18 used, 17 has no fixture -> 16.
    expect(deeper.teamId).toBe(teamId(16));
    expect(deeper.skipped.at(-1)).toEqual({
      teamId: teamId(17),
      position: 17,
      because: 'NO_FIXTURE',
    });
  });

  it('reports no eligible team rather than guessing when everything is exhausted', () => {
    const result = pickAutoTeam({
      standings: standingsRows(),
      fixtures: fixtures(),
      usedTeamIds: standingsRows().map((row) => row.teamId),
    });

    expect(result).toMatchObject({ teamId: null, reason: 'AUTO_NO_ELIGIBLE_TEAM' });
    expect(result.skipped).toHaveLength(20);
  });

  it('reports no eligible team when the standings snapshot is empty', () => {
    // Rather than falling back to an arbitrary team, which would be unauditable.
    const result = pickAutoTeam({ standings: [], fixtures: fixtures(), usedTeamIds: [] });
    expect(result).toMatchObject({ teamId: null, reason: 'AUTO_NO_ELIGIBLE_TEAM' });
  });

  it('reads position, not array order', () => {
    // The snapshot may arrive in any order; only `position` decides.
    const shuffled = [...standingsRows()].reverse();
    const result = pickAutoTeam({ standings: shuffled, fixtures: fixtures(), usedTeamIds: [] });
    expect(result.teamId).toBe(teamId(20));
  });

  it('is deterministic for the same snapshot', () => {
    // A historical auto-pick must be explainable years later.
    const input = {
      standings: standingsRows(),
      fixtures: fixtures(),
      usedTeamIds: [teamId(20), teamId(19)],
    };
    expect(pickAutoTeam(input)).toEqual(pickAutoTeam(input));
  });

  it('handles a table with fewer than twenty teams', () => {
    const short = standingsRows().slice(0, 5);
    const only = [fixture({ homeTeamId: teamId(5), awayTeamId: teamId(1) })];
    const result = pickAutoTeam({ standings: short, fixtures: only, usedTeamIds: [] });
    expect(result.teamId).toBe(teamId(5));
    expect(result.position).toBe(5);
  });
});
