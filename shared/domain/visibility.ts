import { isPastDeadline, type Clock } from './clock.js';
import type {
  AutoReason,
  IsoInstant,
  KillerRoundStatus,
  Pence,
  RoundEntryStatus,
  RoundWeekStatus,
  SelectionOutcome,
  SelectionType,
} from './types.js';

/**
 * Who is asking. Derived on the server from the AppSync identity only — never
 * from a request argument — so a player cannot claim to be an admin.
 */
export interface Viewer {
  kind: 'ANONYMOUS' | 'PLAYER' | 'ADMIN';
  /** The viewer's own Player id, when they have one. */
  playerId: string | null;
}

export const ANONYMOUS_VIEWER: Viewer = { kind: 'ANONYMOUS', playerId: null };

// ---------------------------------------------------------------------------
// The wire shape returned by `getCompetitionView`
// ---------------------------------------------------------------------------

/**
 * A cell in the competition table. `team` is populated only when the viewer is
 * allowed to see it. Before a deadline, other players get `submitted: true` and
 * nothing else — that is the whole privacy rule, in one field.
 */
export interface SelectionCell {
  roundWeekId: string;
  playerId: string;
  submitted: boolean;
  /** Null when hidden. */
  teamId: string | null;
  teamName: string | null;
  teamCode: string | null;
  badgeUrl: string | null;
  /** Null when hidden, so an auto-pick is not leaked before the reveal either. */
  selectionType: SelectionType | null;
  outcome: SelectionOutcome | null;
  autoReason: AutoReason | null;
  /** True when the viewer is seeing a redacted cell. */
  hidden: boolean;
  /** True when this cell belongs to the viewer. */
  own: boolean;
}

export interface WeekView {
  id: string;
  sequenceNumber: number;
  matchday: number | null;
  deadline: IsoInstant | null;
  status: RoundWeekStatus;
  /** True once the deadline has passed, i.e. selections are public. */
  revealed: boolean;
}

export interface EntryView {
  roundEntryId: string;
  playerId: string;
  displayName: string;
  status: RoundEntryStatus;
  paid: boolean | null;
  eliminatedRoundWeekId: string | null;
}

export interface PotView {
  entryFeePence: Pence;
  entrantCount: number;
  paidCount: number;
  expectedEntriesPence: Pence;
  collectedPence: Pence;
  outstandingPence: Pence;
  rolloverInPence: Pence;
  totalPotPence: Pence;
}

export interface CompetitionView {
  round: {
    id: string;
    number: number;
    status: KillerRoundStatus;
    seasonId: string;
    seasonName: string;
    winnerPlayerId: string | null;
    winnerDisplayName: string | null;
    previousRoundId: string | null;
  } | null;
  weeks: WeekView[];
  entries: EntryView[];
  selections: SelectionCell[];
  pot: PotView | null;
  /** The week currently accepting picks, if any. */
  currentWeekId: string | null;
  aliveCount: number;
  /** Everything the signed-in player needs for the pick UI. Null otherwise. */
  me: MeView | null;
  viewerKind: Viewer['kind'];
}

export interface MeView {
  playerId: string;
  displayName: string;
  roundEntryId: string | null;
  status: RoundEntryStatus | null;
  paid: boolean;
  /** Teams already spent in this Killer Round. */
  usedTeamIds: string[];
  /** The viewer's pick for the current week, if made. */
  currentSelection: {
    teamId: string | null;
    teamName: string | null;
    teamCode: string | null;
    selectionType: SelectionType;
    locked: boolean;
  } | null;
  canSelect: boolean;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export interface RedactableSelection {
  roundWeekId: string;
  playerId: string;
  teamId: string | null;
  teamName: string | null;
  teamCode: string | null;
  badgeUrl: string | null;
  selectionType: SelectionType;
  outcome: SelectionOutcome;
  autoReason: AutoReason | null;
}

/**
 * Apply the selection privacy rule.
 *
 * Before a Round Week's deadline a normal player sees only that a pick exists.
 * After the deadline everything is revealed. Administrators see picks
 * immediately, and everyone always sees their own.
 *
 * This runs on the server, inside the Lambda that backs `getCompetitionView`.
 * Selections have no client-side read path at all, so there is no version of
 * this that a determined player can bypass from the browser.
 */
export function redactSelections(
  selections: readonly RedactableSelection[],
  weeks: readonly Pick<WeekView, 'id' | 'deadline'>[],
  viewer: Viewer,
  clock: Clock,
): SelectionCell[] {
  const revealedWeekIds = new Set(
    weeks.filter((week) => isPastDeadline(week.deadline, clock)).map((week) => week.id),
  );

  return selections.map((selection) => {
    const own = viewer.playerId !== null && viewer.playerId === selection.playerId;
    const maySee =
      viewer.kind === 'ADMIN' || own || revealedWeekIds.has(selection.roundWeekId);

    if (!maySee) {
      return {
        roundWeekId: selection.roundWeekId,
        playerId: selection.playerId,
        submitted: true,
        teamId: null,
        teamName: null,
        teamCode: null,
        badgeUrl: null,
        selectionType: null,
        outcome: null,
        autoReason: null,
        hidden: true,
        own,
      };
    }

    return {
      roundWeekId: selection.roundWeekId,
      playerId: selection.playerId,
      submitted: true,
      teamId: selection.teamId,
      teamName: selection.teamName,
      teamCode: selection.teamCode,
      badgeUrl: selection.badgeUrl,
      selectionType: selection.selectionType,
      outcome: selection.outcome,
      autoReason: selection.autoReason,
      hidden: false,
      own,
    };
  });
}

/**
 * Payment status is shown to signed-in players and admins, but not published to
 * the world — who has and has not paid up is the group's business.
 */
export function redactPaid(paid: boolean, viewer: Viewer): boolean | null {
  return viewer.kind === 'ANONYMOUS' ? null : paid;
}
