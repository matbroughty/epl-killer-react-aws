import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock.js';
import {
  buildTeamOptions,
  usedTeamIds,
  validateSelection,
  type SelectionContext,
} from './selection.js';
import {
  fixture,
  fixtures,
  roundEntry,
  roundWeek,
  selection,
  team,
  teamId,
  teams,
  SEASON_ID,
} from './__fixtures__/builders.js';

const DEADLINE = '2026-08-22T14:00:00.000Z';
const WELL_BEFORE = fixedClock('2026-08-20T09:00:00.000Z');
const ONE_SECOND_BEFORE = fixedClock('2026-08-22T13:59:59.000Z');
const EXACTLY_ON = fixedClock(DEADLINE);
const AFTER = fixedClock('2026-08-22T14:00:01.000Z');

function context(overrides: Partial<SelectionContext> = {}): SelectionContext {
  return {
    entry: roundEntry(),
    roundStatus: 'ACTIVE',
    week: roundWeek({ deadline: DEADLINE }),
    team: team({ id: teamId(1) }),
    seasonId: SEASON_ID,
    usedTeamIds: [],
    fixtures: fixtures(),
    playerActive: true,
    ...overrides,
  };
}

describe('validateSelection', () => {
  it('accepts a valid pick before the deadline', () => {
    expect(validateSelection(context(), WELL_BEFORE)).toEqual({ ok: true });
  });

  it('lets a player change their selection any number of times before the deadline', () => {
    // Changing a pick is the same operation as making one; the only thing that
    // matters is that the deadline has not passed.
    const ctx = context();
    for (const teamPosition of [1, 5, 12, 3]) {
      const decision = validateSelection(
        { ...ctx, team: team({ id: teamId(teamPosition) }) },
        WELL_BEFORE,
      );
      expect(decision).toEqual({ ok: true });
    }
  });

  it('accepts a pick one second before the deadline', () => {
    expect(validateSelection(context(), ONE_SECOND_BEFORE).ok).toBe(true);
  });

  it('rejects a pick exactly on the deadline', () => {
    // The deadline is the first kick-off. Once it has gone, it has gone.
    const decision = validateSelection(context(), EXACTLY_ON);
    expect(decision).toEqual({
      ok: false,
      reason: 'DEADLINE_PASSED',
      detail: expect.any(String),
    });
  });

  it('rejects a pick after the deadline', () => {
    expect(validateSelection(context(), AFTER)).toMatchObject({
      ok: false,
      reason: 'DEADLINE_PASSED',
    });
  });

  it('rejects a team the player has already used this Killer Round', () => {
    const decision = validateSelection(
      context({ usedTeamIds: [teamId(1), teamId(7)] }),
      WELL_BEFORE,
    );
    expect(decision).toMatchObject({ ok: false, reason: 'TEAM_ALREADY_USED' });
  });

  it('allows a team used by a *different* player', () => {
    // Reuse is per player, not per competition.
    expect(validateSelection(context({ usedTeamIds: [] }), WELL_BEFORE).ok).toBe(true);
  });

  it('rejects a selection from an eliminated player', () => {
    const decision = validateSelection(
      context({ entry: roundEntry({ status: 'ELIMINATED' }) }),
      WELL_BEFORE,
    );
    expect(decision).toMatchObject({ ok: false, reason: 'ALREADY_ELIMINATED' });
  });

  it('rejects a selection from somebody who is not an entrant', () => {
    expect(validateSelection(context({ entry: null }), WELL_BEFORE)).toMatchObject({
      ok: false,
      reason: 'NOT_AN_ENTRANT',
    });
  });

  it('rejects a selection from an inactive player', () => {
    expect(validateSelection(context({ playerActive: false }), WELL_BEFORE)).toMatchObject({
      ok: false,
      reason: 'PLAYER_INACTIVE',
    });
  });

  it('rejects a selection when the round is not active', () => {
    expect(validateSelection(context({ roundStatus: 'DRAFT' }), WELL_BEFORE)).toMatchObject({
      ok: false,
      reason: 'ROUND_NOT_ACTIVE',
    });
  });

  it.each(['DRAFT', 'LOCKED', 'RESULTS_PENDING', 'COMPLETE'] as const)(
    'rejects a selection when the week status is %s',
    (status) => {
      const decision = validateSelection(
        context({ week: roundWeek({ deadline: DEADLINE, status }) }),
        WELL_BEFORE,
      );
      expect(decision).toMatchObject({ ok: false, reason: 'WEEK_NOT_OPEN' });
    },
  );

  it('reports the locked week rather than the deadline when both apply', () => {
    // A clearer message: "this week is closed" beats "you are late" when the
    // admin locked the week early.
    const decision = validateSelection(
      context({ week: roundWeek({ deadline: DEADLINE, status: 'LOCKED' }) }),
      AFTER,
    );
    expect(decision).toMatchObject({ reason: 'WEEK_NOT_OPEN' });
  });

  it('rejects an unknown team', () => {
    expect(validateSelection(context({ team: null }), WELL_BEFORE)).toMatchObject({
      ok: false,
      reason: 'UNKNOWN_TEAM',
    });
  });

  it('rejects a team from another season', () => {
    const decision = validateSelection(
      context({ team: team({ id: teamId(1), seasonId: 'season-2019' }) }),
      WELL_BEFORE,
    );
    expect(decision).toMatchObject({ ok: false, reason: 'TEAM_NOT_IN_SEASON' });
  });

  it('rejects a team with no fixture in the gameweek', () => {
    // Only nine of the ten fixtures imported, so team-01 and team-20 are absent.
    const partial = fixtures().slice(1);
    const decision = validateSelection(
      context({ team: team({ id: teamId(1) }), fixtures: partial }),
      WELL_BEFORE,
    );
    expect(decision).toMatchObject({ ok: false, reason: 'TEAM_HAS_NO_FIXTURE' });
  });

  it('rejects a team whose only fixture was cancelled', () => {
    const withCancellation = [
      fixture({ homeTeamId: teamId(1), awayTeamId: teamId(20), status: 'CANCELLED' }),
    ];
    const decision = validateSelection(
      context({ team: team({ id: teamId(1) }), fixtures: withCancellation }),
      WELL_BEFORE,
    );
    expect(decision).toMatchObject({ ok: false, reason: 'TEAM_HAS_NO_FIXTURE' });
  });

  it('allows a team whose fixture is postponed, since it should be rearranged', () => {
    const postponed = [
      fixture({ homeTeamId: teamId(1), awayTeamId: teamId(20), status: 'POSTPONED' }),
    ];
    const decision = validateSelection(
      context({ team: team({ id: teamId(1) }), fixtures: postponed }),
      WELL_BEFORE,
    );
    expect(decision.ok).toBe(true);
  });

  it('does not block the player when no fixtures have been imported at all', () => {
    // Our sync gap must not become the player's problem.
    expect(validateSelection(context({ fixtures: [] }), WELL_BEFORE).ok).toBe(true);
  });

  it('checks the deadline before any team-level rule', () => {
    // Otherwise a late request could be reported as "team already used" and the
    // player would think a different pick might work.
    const decision = validateSelection(
      context({ usedTeamIds: [teamId(1)], team: null }),
      AFTER,
    );
    expect(decision).toMatchObject({ reason: 'DEADLINE_PASSED' });
  });
});

describe('usedTeamIds', () => {
  it('collects the teams an entry has committed to', () => {
    const used = usedTeamIds([
      selection({ roundWeekId: 'week-1', teamId: teamId(3) }),
      selection({ roundWeekId: 'week-2', teamId: teamId(9) }),
    ]);
    expect(used.sort()).toEqual([teamId(3), teamId(9)]);
  });

  it('excludes the week being changed, so re-picking this week is not reuse', () => {
    const used = usedTeamIds(
      [
        selection({ roundWeekId: 'week-1', teamId: teamId(3) }),
        selection({ roundWeekId: 'week-2', teamId: teamId(9) }),
      ],
      'week-2',
    );
    expect(used).toEqual([teamId(3)]);
  });

  it('ignores selections with no team, which do not consume one', () => {
    const used = usedTeamIds([selection({ roundWeekId: 'week-1', teamId: null })]);
    expect(used).toEqual([]);
  });

  it('de-duplicates', () => {
    const used = usedTeamIds([
      selection({ roundWeekId: 'week-1', teamId: teamId(3) }),
      selection({ roundWeekId: 'week-2', teamId: teamId(3) }),
    ]);
    expect(used).toEqual([teamId(3)]);
  });
});

describe('buildTeamOptions', () => {
  it('marks used teams as not selectable but still lists them', () => {
    const options = buildTeamOptions(teams(), [teamId(1), teamId(2)], fixtures());
    const used = options.filter((option) => option.used);
    expect(used).toHaveLength(2);
    expect(used.every((option) => !option.selectable)).toBe(true);
    // Still present, so the UI can show them disabled rather than hiding them.
    expect(options).toHaveLength(20);
  });

  it('marks teams without a fixture as not selectable', () => {
    const options = buildTeamOptions(teams(), [], fixtures().slice(1));
    const missing = options.filter((option) => !option.hasFixture).map((o) => o.team.id);
    expect(missing.sort()).toEqual([teamId(1), teamId(20)]);
  });

  it('treats every team as playable when no fixtures are imported', () => {
    const options = buildTeamOptions(teams(), [], []);
    expect(options.every((option) => option.selectable)).toBe(true);
  });

  it('sorts alphabetically and excludes inactive teams', () => {
    const withInactive = [...teams(), team({ id: 'team-old', name: 'Watford', active: false })];
    const options = buildTeamOptions(withInactive, [], fixtures());
    expect(options.map((option) => option.team.name)).not.toContain('Watford');
    const names = options.map((option) => option.team.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en-GB')));
  });
});
