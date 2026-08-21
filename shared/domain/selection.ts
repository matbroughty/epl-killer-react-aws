import { isPastDeadline, type Clock } from './clock.js';
import type { Fixture, RoundEntry, RoundWeek, Selection, Team } from './types.js';

/**
 * Every way a selection can be refused. These are returned to the client as
 * stable codes so the UI can phrase them without the server sending prose.
 */
export const REJECTION_REASONS = [
  'NO_PLAYER_RECORD',
  'PLAYER_INACTIVE',
  'NOT_AN_ENTRANT',
  'ALREADY_ELIMINATED',
  'ROUND_NOT_ACTIVE',
  'WEEK_NOT_OPEN',
  'DEADLINE_PASSED',
  'UNKNOWN_TEAM',
  'TEAM_NOT_IN_SEASON',
  'TEAM_ALREADY_USED',
  'TEAM_HAS_NO_FIXTURE',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export type SelectionDecision =
  | { ok: true }
  | { ok: false; reason: RejectionReason; detail?: string };

const REJECTION_MESSAGES: Record<RejectionReason, string> = {
  NO_PLAYER_RECORD: 'You do not have a player record. Ask an admin to add you.',
  PLAYER_INACTIVE: 'Your player record is inactive.',
  NOT_AN_ENTRANT: 'You are not an entrant in this Killer Round.',
  ALREADY_ELIMINATED: 'You have been eliminated from this Killer Round.',
  ROUND_NOT_ACTIVE: 'This Killer Round is not active.',
  WEEK_NOT_OPEN: 'This Round Week is not open for selections.',
  DEADLINE_PASSED: 'The selection deadline has passed.',
  UNKNOWN_TEAM: 'That team does not exist.',
  TEAM_NOT_IN_SEASON: 'That team is not in this season.',
  TEAM_ALREADY_USED: 'You have already used that team in this Killer Round.',
  TEAM_HAS_NO_FIXTURE: 'That team has no fixture in this gameweek.',
};

export function rejectionMessage(reason: RejectionReason): string {
  return REJECTION_MESSAGES[reason];
}

export interface SelectionContext {
  entry: Pick<RoundEntry, 'id' | 'status' | 'killerRoundId'> | null;
  roundStatus: string;
  week: Pick<RoundWeek, 'id' | 'status' | 'deadline' | 'matchday' | 'killerRoundId'>;
  team: Pick<Team, 'id' | 'seasonId' | 'active'> | null;
  seasonId: string;
  /** Teams this entry has already used in this Killer Round, excluding this week. */
  usedTeamIds: readonly string[];
  /** Fixtures for the week's matchday. Empty means "not imported yet". */
  fixtures: readonly Pick<Fixture, 'homeTeamId' | 'awayTeamId' | 'status'>[];
  playerActive: boolean;
}

/**
 * The single gate every selection passes through, whether it arrives from the
 * pick UI or an admin screen. Server-side only — the React button being
 * disabled is a courtesy, not a control.
 */
export function validateSelection(
  context: SelectionContext,
  clock: Clock,
): SelectionDecision {
  if (!context.playerActive) return reject('PLAYER_INACTIVE');
  if (!context.entry) return reject('NOT_AN_ENTRANT');
  if (context.entry.status !== 'ALIVE') return reject('ALREADY_ELIMINATED');
  if (context.roundStatus !== 'ACTIVE') return reject('ROUND_NOT_ACTIVE');
  if (context.week.status !== 'OPEN') return reject('WEEK_NOT_OPEN');

  // Checked after `WEEK_NOT_OPEN` so a locked week reports the clearer reason,
  // but before any team checks: once the whistle has gone, nothing else matters.
  if (isPastDeadline(context.week.deadline, clock)) return reject('DEADLINE_PASSED');

  if (!context.team) return reject('UNKNOWN_TEAM');
  if (context.team.seasonId !== context.seasonId) return reject('TEAM_NOT_IN_SEASON');
  if (context.usedTeamIds.includes(context.team.id)) return reject('TEAM_ALREADY_USED');

  // Only enforced once fixtures are actually imported. If we have no fixture
  // data for the matchday we must not block the player on our own sync gap.
  if (context.fixtures.length > 0 && !hasPlayableFixture(context.team.id, context.fixtures)) {
    return reject('TEAM_HAS_NO_FIXTURE');
  }

  return { ok: true };
}

function reject(reason: RejectionReason): SelectionDecision {
  return { ok: false, reason, detail: REJECTION_MESSAGES[reason] };
}

/**
 * Does this team have a fixture that could still be played? A cancelled fixture
 * does not count — it will never produce a result — but a postponed one does,
 * since it is expected to be rearranged.
 */
export function hasPlayableFixture(
  teamId: string,
  fixtures: readonly Pick<Fixture, 'homeTeamId' | 'awayTeamId' | 'status'>[],
): boolean {
  return fixtures.some(
    (fixture) =>
      fixture.status !== 'CANCELLED' &&
      (fixture.homeTeamId === teamId || fixture.awayTeamId === teamId),
  );
}

export function findFixtureForTeam<T extends Pick<Fixture, 'homeTeamId' | 'awayTeamId'>>(
  teamId: string,
  fixtures: readonly T[],
): T | null {
  return fixtures.find((f) => f.homeTeamId === teamId || f.awayTeamId === teamId) ?? null;
}

/**
 * Teams an entry has already committed to in this Killer Round.
 *
 * `exceptRoundWeekId` lets the caller ignore the week being changed, so
 * re-picking the same team you already chose this week is not a reuse.
 * Selections with no team (an auto-pick that found nobody eligible) do not
 * consume a team.
 */
export function usedTeamIds(
  selections: readonly Pick<Selection, 'roundWeekId' | 'teamId'>[],
  exceptRoundWeekId?: string,
): string[] {
  const used = new Set<string>();
  for (const selection of selections) {
    if (exceptRoundWeekId && selection.roundWeekId === exceptRoundWeekId) continue;
    if (selection.teamId) used.add(selection.teamId);
  }
  return [...used];
}

export interface TeamOption {
  team: Team;
  used: boolean;
  hasFixture: boolean;
  selectable: boolean;
  kickoff: string | null;
}

/**
 * Build the pick list for a week: every season team, annotated with whether it
 * is already used and whether it is playing. The same derivation the server
 * uses to validate, so the UI cannot disagree with the rules.
 */
export function buildTeamOptions(
  teams: readonly Team[],
  used: readonly string[],
  fixtures: readonly Pick<Fixture, 'homeTeamId' | 'awayTeamId' | 'status' | 'utcKickoff'>[],
): TeamOption[] {
  const usedSet = new Set(used);
  return teams
    .filter((team) => team.active)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'en-GB'))
    .map((team) => {
      const fixture = fixtures.find(
        (f) =>
          f.status !== 'CANCELLED' &&
          (f.homeTeamId === team.id || f.awayTeamId === team.id),
      );
      const isUsed = usedSet.has(team.id);
      // With no fixture data at all we cannot claim a team is not playing.
      const hasFixture = fixtures.length === 0 ? true : Boolean(fixture);
      return {
        team,
        used: isUsed,
        hasFixture,
        selectable: !isUsed && hasFixture,
        kickoff: fixture?.utcKickoff ?? null,
      };
    });
}
