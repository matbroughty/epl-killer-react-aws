import { isPastDeadline, type Clock } from './clock.js';
import type { Fixture, IsoInstant } from './types.js';

/**
 * Propose a Round Week deadline from its fixtures: the kick-off of the first
 * Premier League match of that gameweek. Cancelled fixtures are ignored;
 * postponed ones are not, because a postponed match still had a scheduled slot
 * and pushing the deadline later would let people pick after other games start.
 *
 * Returns null when no fixtures have been imported yet, so the admin screen can
 * say "sync fixtures first" rather than inventing a time.
 */
export function proposeDeadline(
  fixtures: readonly Pick<Fixture, 'utcKickoff' | 'status'>[],
): IsoInstant | null {
  const kickoffs = fixtures
    .filter((fixture) => fixture.status !== 'CANCELLED')
    .map((fixture) => Date.parse(fixture.utcKickoff))
    .filter((millis) => !Number.isNaN(millis));

  if (kickoffs.length === 0) return null;
  return new Date(Math.min(...kickoffs)).toISOString();
}

/**
 * How long until the last fixture of a gameweek could plausibly have finished,
 * used to decide when it is worth asking the provider for results. Two hours
 * after the latest kick-off covers 90 minutes plus stoppages and a half-time.
 */
export const RESULT_READY_GRACE_MS = 2 * 60 * 60 * 1000;

export function couldHaveResults(
  fixtures: readonly Pick<Fixture, 'utcKickoff'>[],
  clock: Clock,
): boolean {
  return fixtures.some((fixture) => {
    const kickoff = Date.parse(fixture.utcKickoff);
    if (Number.isNaN(kickoff)) return false;
    return clock.nowMillis() >= kickoff + RESULT_READY_GRACE_MS;
  });
}

/**
 * A standings snapshot is only fit to drive automatic picks if it was captured
 * recently enough to be "the table as it stood at the deadline". Six hours is
 * comfortably inside a single matchday while avoiding a fetch on every tick.
 */
export const STANDINGS_FRESHNESS_MS = 6 * 60 * 60 * 1000;

export function isStandingsSnapshotFresh(
  capturedAt: IsoInstant | null | undefined,
  clock: Clock,
): boolean {
  const at = capturedAt ? Date.parse(capturedAt) : NaN;
  if (Number.isNaN(at)) return false;
  return clock.nowMillis() - at <= STANDINGS_FRESHNESS_MS;
}

/**
 * How close to a deadline we start caring about having a fresh table, so the
 * snapshot used for auto-picks reflects the standings at kick-off.
 */
export const STANDINGS_PREFETCH_MS = 60 * 60 * 1000;

export function shouldPrefetchStandings(
  deadline: IsoInstant | null,
  clock: Clock,
): boolean {
  const at = deadline ? Date.parse(deadline) : NaN;
  if (Number.isNaN(at)) return false;
  return at - clock.nowMillis() <= STANDINGS_PREFETCH_MS;
}

/** Is this week due to be locked and processed? */
export function isDueForDeadlineProcessing(
  week: { status: string; deadline: IsoInstant | null },
  clock: Clock,
): boolean {
  if (week.status !== 'OPEN' && week.status !== 'DRAFT') return false;
  return isPastDeadline(week.deadline, clock);
}
