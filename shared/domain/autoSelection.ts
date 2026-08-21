import { hasPlayableFixture } from './selection.js';
import type { AutoReason, Fixture, StandingRow } from './types.js';

export interface AutoSelectionInput {
  /** The table as it stood at the deadline. Order does not matter; `position` does. */
  standings: readonly StandingRow[];
  /** Fixtures for the week's matchday. */
  fixtures: readonly Pick<Fixture, 'homeTeamId' | 'awayTeamId' | 'status'>[];
  /** Teams the player has already used in this Killer Round. */
  usedTeamIds: readonly string[];
}

export interface AutoSelectionResult {
  teamId: string | null;
  reason: AutoReason;
  /** Teams walked past, in the order considered, and why. Persisted for audit. */
  skipped: { teamId: string; position: number; because: 'USED' | 'NO_FIXTURE' }[];
  /** Position of the chosen team in the snapshot, for the audit trail. */
  position: number | null;
}

/**
 * Assign a team to a player who missed the deadline.
 *
 * Start at the bottom of the table and walk upwards, taking the first team that
 * both has a fixture in this gameweek and has not already been used by this
 * player in this Killer Round. Reading from 20th place upwards is the rule as
 * specified — the player who could not be bothered gets the worst available side.
 *
 * The standings passed in must be the snapshot captured at the deadline, so a
 * historical pick is never re-derived from a table that has since moved on.
 */
export function pickAutoTeam(input: AutoSelectionInput): AutoSelectionResult {
  const used = new Set(input.usedTeamIds);
  const skipped: AutoSelectionResult['skipped'] = [];

  // Bottom of the table first: 20th, then 19th, and so on.
  const worstFirst = [...input.standings].sort((a, b) => b.position - a.position);

  for (const row of worstFirst) {
    if (used.has(row.teamId)) {
      skipped.push({ teamId: row.teamId, position: row.position, because: 'USED' });
      continue;
    }
    if (!hasPlayableFixture(row.teamId, input.fixtures)) {
      skipped.push({ teamId: row.teamId, position: row.position, because: 'NO_FIXTURE' });
      continue;
    }
    return {
      teamId: row.teamId,
      reason: 'AUTO_LOWEST_POSITION',
      skipped,
      position: row.position,
    };
  }

  // Every team is either used or not playing. There is no fair pick to make, so
  // we record that rather than eliminating somebody by accident.
  return { teamId: null, reason: 'AUTO_NO_ELIGIBLE_TEAM', skipped, position: null };
}

/**
 * Human-readable audit note for an automatic assignment. Stored alongside the
 * snapshot id so the decision can be explained without re-running anything.
 */
export function describeAutoSelection(
  result: AutoSelectionResult,
  teamName: (teamId: string) => string,
): string {
  if (!result.teamId) {
    return `No eligible team: ${result.skipped.length} considered, all either already used or without a fixture.`;
  }
  const skippedNote =
    result.skipped.length === 0
      ? 'bottom of the table was eligible'
      : `skipped ${result.skipped
          .map((s) => `${teamName(s.teamId)} (${s.position}, ${s.because === 'USED' ? 'already used' : 'no fixture'})`)
          .join(', ')}`;
  return `Assigned ${teamName(result.teamId)} at position ${result.position}; ${skippedNote}.`;
}
