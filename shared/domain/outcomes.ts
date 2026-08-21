import type {
  Fixture,
  FixtureStatus,
  Selection,
  SelectionOutcome,
} from './types.js';

/**
 * Fixture states from which a result can be read. Everything else means "we do
 * not know yet", including states an unfamiliar provider might invent.
 *
 * `AWARDED` is included: the match was decided off the pitch, but it was
 * decided, and the provider reports a winner.
 */
const RESOLVED_STATUSES: ReadonlySet<FixtureStatus> = new Set<FixtureStatus>([
  'FINISHED',
  'AWARDED',
]);

/**
 * States where the fixture is expected to happen later, so the player waits.
 * A postponed selection stays pending until the rearranged match is played —
 * we never eliminate somebody because the weather intervened.
 */
const UNRESOLVED_STATUSES: ReadonlySet<FixtureStatus> = new Set<FixtureStatus>([
  'SCHEDULED',
  'TIMED',
  'IN_PLAY',
  'PAUSED',
  'POSTPONED',
  'SUSPENDED',
  // A cancelled fixture will never produce a result. It cannot eliminate the
  // player, and it cannot let them survive either, so it needs an admin. It
  // stays pending and shows up in the admin "needs attention" list.
  'CANCELLED',
  'UNKNOWN',
]);

export interface OutcomeInput {
  selection: Pick<
    Selection,
    'teamId' | 'outcome' | 'selectionType' | 'autoReason' | 'overridden'
  >;
  fixture: Pick<Fixture, 'status' | 'winner' | 'homeTeamId' | 'awayTeamId'> | null;
}

/**
 * Decide one selection's fate.
 *
 * Win => survive. Draw => out. Loss => out. Anything unresolved => pending.
 * An outcome already set by an administrator is never overwritten.
 */
export function resolveOutcome(input: OutcomeInput): SelectionOutcome {
  const { selection, fixture } = input;

  // An admin override is final. Result processing must not undo it, however
  // many times it reruns and whatever the provider later says.
  if (selection.overridden) return selection.outcome;

  // The deadline processor found nobody eligible to assign. The player cannot
  // be punished for a gap in the fixture list, so they survive the week.
  if (!selection.teamId) {
    return selection.autoReason === 'AUTO_NO_ELIGIBLE_TEAM' ? 'SURVIVED' : 'PENDING';
  }

  if (!fixture) return 'PENDING';

  if (UNRESOLVED_STATUSES.has(fixture.status)) return 'PENDING';
  if (!RESOLVED_STATUSES.has(fixture.status)) return 'PENDING';

  // Finished, but the provider has not told us who won. Do not guess.
  if (!fixture.winner) return 'PENDING';
  if (fixture.winner === 'DRAW') return 'ELIMINATED';

  const winningTeamId =
    fixture.winner === 'HOME' ? fixture.homeTeamId : fixture.awayTeamId;

  return selection.teamId === winningTeamId ? 'SURVIVED' : 'ELIMINATED';
}

/** Is this fixture in a state that needs a human to look at it? */
export function needsAdminAttention(
  fixture: Pick<Fixture, 'status'> | null,
): boolean {
  if (!fixture) return false;
  return fixture.status === 'CANCELLED' || fixture.status === 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Round week progression
// ---------------------------------------------------------------------------

export type RoundWeekResolution =
  /** At least one selection has no result yet. Nothing is decided. */
  | { kind: 'PENDING'; pendingCount: number }
  /** One survivor. They win the Killer Round and the pot. */
  | { kind: 'WINNER'; roundEntryId: string }
  /** Everybody went out together. No winner; the pot rolls over. */
  | { kind: 'ROLLOVER' }
  /** More than one survivor. The admin chooses the next gameweek. */
  | { kind: 'CONTINUE'; survivorEntryIds: string[] };

export interface RoundWeekResolutionInput {
  /**
   * Every selection belonging to this week, for entries that were alive going
   * into it. Entries eliminated in an earlier week are not included.
   */
  selections: readonly Pick<Selection, 'roundEntryId' | 'outcome'>[];
}

/**
 * Work out where a Round Week leaves the competition.
 *
 * Note the order: pending beats everything. We do not declare a winner while a
 * postponed fixture could still eliminate them.
 */
export function resolveRoundWeek(
  input: RoundWeekResolutionInput,
): RoundWeekResolution {
  const pending = input.selections.filter(
    (s) => s.outcome === 'PENDING' || s.outcome === 'UNKNOWN',
  );
  if (pending.length > 0) return { kind: 'PENDING', pendingCount: pending.length };

  const unique = [
    ...new Set(
      input.selections
        .filter((s) => s.outcome === 'SURVIVED')
        .map((s) => s.roundEntryId),
    ),
  ];

  if (unique.length === 1) return { kind: 'WINNER', roundEntryId: unique[0]! };
  if (unique.length === 0) return { kind: 'ROLLOVER' };
  return { kind: 'CONTINUE', survivorEntryIds: unique };
}
