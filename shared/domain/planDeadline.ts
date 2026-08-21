import { pickAutoTeam, describeAutoSelection } from './autoSelection.js';
import { isPastDeadline, type Clock } from './clock.js';
import { findFixtureForTeam, usedTeamIds } from './selection.js';
import { selectionId } from './types.js';
import type {
  AutoReason,
  Fixture,
  RoundEntry,
  RoundWeek,
  Selection,
  StandingsSnapshot,
  Team,
} from './types.js';

/**
 * Deadline processing, expressed as a *plan* rather than a sequence of writes.
 *
 * The point of this shape is idempotency. The planner is a pure function of
 * state, so "running it twice must not create duplicate picks or change an
 * already-created automatic pick" becomes a property we can assert: apply the
 * plan, re-plan against the resulting state, and the second plan must be empty.
 *
 * The executor turns these intentions into conditional writes. Because
 * `Selection.id` is `{roundWeekId}#{roundEntryId}`, a create that loses a race
 * fails on `attribute_not_exists(id)` and is simply skipped — no locking.
 */
export interface DeadlinePlan {
  roundWeekId: string;
  /** Set when the week still needs locking. */
  lockWeek: { toStatus: 'LOCKED'; lockedAt: string; standingsSnapshotId: string | null } | null;
  /** Automatic picks to create. Never updates: an existing pick is left alone. */
  createSelections: PlannedAutoSelection[];
  /** Existing picks that need `lockedAt` stamping so they can be revealed. */
  lockSelections: { selectionId: string; lockedAt: string }[];
  /** Notes for the audit log. */
  auditNotes: string[];
  /** True when there is nothing at all to do. */
  empty: boolean;
}

export interface PlannedAutoSelection {
  id: string;
  roundWeekId: string;
  roundEntryId: string;
  playerId: string;
  killerRoundId: string;
  teamId: string | null;
  teamName: string | null;
  teamCode: string | null;
  selectionType: 'AUTO_LOWEST_POSITION';
  selectedAt: string;
  lockedAt: string;
  outcome: 'PENDING';
  overridden: false;
  fixtureId: string | null;
  standingsSnapshotId: string | null;
  autoReason: AutoReason;
  auditNote: string;
}

export interface DeadlineState {
  week: Pick<
    RoundWeek,
    'id' | 'killerRoundId' | 'status' | 'deadline' | 'matchday' | 'standingsSnapshotId'
  >;
  /** Entries that were alive going into this week. */
  aliveEntries: readonly Pick<RoundEntry, 'id' | 'playerId' | 'status'>[];
  /** Selections already recorded for this week. */
  weekSelections: readonly Pick<
    Selection,
    'id' | 'roundEntryId' | 'teamId' | 'lockedAt'
  >[];
  /** Every selection in this Killer Round, used to work out which teams are spent. */
  roundSelections: readonly Pick<Selection, 'roundWeekId' | 'roundEntryId' | 'teamId'>[];
  fixtures: readonly Fixture[];
  standings: StandingsSnapshot | null;
  teams: readonly Pick<Team, 'id' | 'name' | 'code'>[];
}

export function planDeadlineProcessing(
  state: DeadlineState,
  clock: Clock,
): DeadlinePlan {
  const { week } = state;
  const now = clock.nowIso();

  const empty: DeadlinePlan = {
    roundWeekId: week.id,
    lockWeek: null,
    createSelections: [],
    lockSelections: [],
    auditNotes: [],
    empty: true,
  };

  // Nothing to do unless the deadline has actually passed.
  if (!isPastDeadline(week.deadline, clock)) return empty;
  // COMPLETE and RESULTS_PENDING weeks have already been through this.
  if (week.status === 'LOCKED' || week.status === 'RESULTS_PENDING' || week.status === 'COMPLETE') {
    // Still worth checking for unlocked selections — a previous run may have
    // been interrupted between locking the week and stamping every pick.
    const stragglers = planSelectionLocks(state, now);
    if (stragglers.length === 0) return empty;
    return {
      roundWeekId: week.id,
      lockWeek: null,
      createSelections: [],
      lockSelections: stragglers,
      auditNotes: [`Locked ${stragglers.length} selection(s) left unstamped by an earlier run.`],
      empty: false,
    };
  }

  const teamsById = new Map(state.teams.map((team) => [team.id, team]));
  const teamName = (id: string) => teamsById.get(id)?.name ?? id;
  const matchdayFixtures =
    week.matchday === null
      ? []
      : state.fixtures.filter((fixture) => fixture.matchday === week.matchday);

  const selectedEntryIds = new Set(state.weekSelections.map((s) => s.roundEntryId));
  const auditNotes: string[] = [];
  const createSelections: PlannedAutoSelection[] = [];

  for (const entry of state.aliveEntries) {
    if (entry.status !== 'ALIVE') continue;
    if (selectedEntryIds.has(entry.id)) continue;

    const used = usedTeamIds(
      state.roundSelections.filter((s) => s.roundEntryId === entry.id),
      week.id,
    );

    const result = pickAutoTeam({
      standings: state.standings?.rows ?? [],
      fixtures: matchdayFixtures,
      usedTeamIds: used,
    });

    const team = result.teamId ? teamsById.get(result.teamId) : undefined;
    const fixture = result.teamId
      ? findFixtureForTeam(result.teamId, matchdayFixtures)
      : null;

    createSelections.push({
      id: selectionId(week.id, entry.id),
      roundWeekId: week.id,
      roundEntryId: entry.id,
      playerId: entry.playerId,
      killerRoundId: week.killerRoundId,
      teamId: result.teamId,
      teamName: team?.name ?? null,
      teamCode: team?.code ?? null,
      selectionType: 'AUTO_LOWEST_POSITION',
      selectedAt: now,
      lockedAt: now,
      outcome: 'PENDING',
      overridden: false,
      fixtureId: fixture?.id ?? null,
      standingsSnapshotId: state.standings?.id ?? null,
      autoReason: result.reason,
      auditNote: describeAutoSelection(result, teamName),
    });
  }

  // Any player left without a team needs flagging, whether the cause was a
  // missing snapshot, an empty one, or a genuinely exhausted set of teams.
  const unassigned = createSelections.filter((planned) => planned.teamId === null);
  if (unassigned.length > 0) {
    const cause =
      (state.standings?.rows.length ?? 0) === 0
        ? 'No standings snapshot was available'
        : 'Every team was either already used or without a fixture';
    auditNotes.push(
      `${cause}, so ${unassigned.length} player(s) could not be assigned a team by league position. They survive the week; an administrator should review.`,
    );
  }

  return {
    roundWeekId: week.id,
    lockWeek: {
      toStatus: 'LOCKED',
      lockedAt: now,
      standingsSnapshotId: state.standings?.id ?? week.standingsSnapshotId,
    },
    createSelections,
    lockSelections: planSelectionLocks(state, now),
    auditNotes,
    empty: false,
  };
}

function planSelectionLocks(
  state: DeadlineState,
  now: string,
): { selectionId: string; lockedAt: string }[] {
  return state.weekSelections
    .filter((selection) => !selection.lockedAt)
    .map((selection) => ({ selectionId: selection.id, lockedAt: now }));
}
