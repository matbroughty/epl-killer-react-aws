import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { env } from '$amplify/env/killer-scheduler';
import type { EventBridgeHandler } from 'aws-lambda';

import { systemClock } from '../../../shared/domain/clock.js';
import {
  couldHaveResults,
  isDueForDeadlineProcessing,
  isStandingsSnapshotFresh,
} from '../../../shared/domain/deadlines.js';
import { FootballDataOrgProvider } from '../../../shared/provider/footballDataOrg.js';
import type { Schema } from '../../data/resource.js';
import type { KillerClient } from '../../shared/client.js';
import { SYSTEM_ACTOR } from '../../shared/audit.js';
import {
  executeDeadlineProcessing,
  executeResultProcessing,
  loadDeadlineState,
  loadResultState,
} from '../../shared/processing.js';
import { createRepository } from '../../shared/repository.js';
import {
  ensureStandingsSnapshot,
  syncFixtures,
  syncResults,
  syncStandings,
  type SyncContext,
} from '../../shared/sync.js';

/**
 * The competition's heartbeat, every 15 minutes.
 *
 * State-driven rather than time-driven: each tick asks the database what is due
 * and does only that. There is no cron expression encoding "Saturday at 5pm",
 * because the fixture list already knows when the football is on.
 *
 * The consequences are worth spelling out:
 *
 * - **Self-healing.** A missed tick, a provider outage or a Lambda timeout is
 *   picked up by the next run. Nothing needs replaying by hand.
 * - **Cheap.** The common case is one DynamoDB query that finds nothing due and
 *   returns. No provider calls, no writes.
 * - **Idempotent.** All the real work goes through the planners in
 *   `shared/domain/`, which are pure functions of state and unit-tested for
 *   double application.
 *
 * A deadline processed up to 15 minutes late costs nothing, because
 * `submitSelection` rejects picks on the deadline itself. Lateness delays the
 * reveal; it never lets a pick through.
 */

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);

const client = generateClient<Schema>() as KillerClient;
const repository = createRepository(client);
const clock = systemClock;

/** Refresh the whole fixture list and table roughly once a day. */
const DAILY_REFRESH_MS = 20 * 60 * 60 * 1000;

interface TickReport {
  at: string;
  deadlinesProcessed: string[];
  resultsProcessed: string[];
  syncs: string[];
  skipped: string[];
  errors: string[];
}

export const handler: EventBridgeHandler<'Scheduled Event', null, TickReport> = async () => {
  const report: TickReport = {
    at: clock.nowIso(),
    deadlinesProcessed: [],
    resultsProcessed: [],
    syncs: [],
    skipped: [],
    errors: [],
  };

  const season = await repository.activeSeason();
  if (!season) {
    report.skipped.push('No active season configured.');
    return report;
  }

  const context: SyncContext = {
    repository,
    provider: new FootballDataOrgProvider({ token: env.FOOTBALL_DATA_TOKEN }),
    clock,
    trigger: 'SCHEDULE',
  };

  // -------------------------------------------------------------------------
  // 1. Weeks whose deadline has passed: lock them and fill in missing picks.
  // -------------------------------------------------------------------------
  try {
    const candidates = [
      ...(await repository.weeksByStatus('OPEN')),
      ...(await repository.weeksByStatus('DRAFT')),
    ];

    const due = candidates.filter((week) =>
      isDueForDeadlineProcessing(
        { status: week.status ?? 'DRAFT', deadline: week.deadline ?? null },
        clock,
      ),
    );

    for (const week of due) {
      // Automatic picks must come from the table as it stood at the deadline, so
      // make sure a recent snapshot exists before planning.
      const snapshotId =
        week.standingsSnapshotId ??
        (await ensureStandingsSnapshot(context, season.id, (capturedAt) =>
          isStandingsSnapshotFresh(capturedAt, clock),
        ));

      const state = await loadDeadlineState(repository, week.id, snapshotId);
      if (!state) continue;

      const { result } = await executeDeadlineProcessing(
        repository,
        state,
        clock,
        SYSTEM_ACTOR,
      );
      if (result.locked || result.autoAssigned > 0 || result.selectionsLocked > 0) {
        report.deadlinesProcessed.push(
          `${week.id}: locked=${result.locked}, auto=${result.autoAssigned}, unassigned=${result.autoUnassigned}`,
        );
      }
    }
  } catch (error) {
    report.errors.push(`Deadline processing: ${message(error)}`);
  }

  // -------------------------------------------------------------------------
  // 2. Locked weeks whose matches could have finished: refresh and resolve.
  // -------------------------------------------------------------------------
  try {
    const awaiting = [
      ...(await repository.weeksByStatus('LOCKED')),
      ...(await repository.weeksByStatus('RESULTS_PENDING')),
    ];

    for (const week of awaiting) {
      if (week.matchday === null || week.matchday === undefined) continue;

      const fixtures = await repository.fixtures(season.id, week.matchday);

      // Nothing can have a result yet, so do not spend a request on it.
      if (!couldHaveResults(fixtures.map((f) => ({ utcKickoff: f.utcKickoff })), clock)) {
        continue;
      }

      const unresolved = await repository.selectionsByWeek(week.id);
      const stillPending = unresolved.filter(
        (selection) => (selection.outcome ?? 'PENDING') === 'PENDING' && !selection.overridden,
      );

      // Every pick already resolved; the week just needs its final transition,
      // which `planResultProcessing` will work out without a provider call.
      if (stillPending.length > 0) {
        const sync = await syncResults(context, season.id, week.matchday);
        report.syncs.push(`RESULTS md${week.matchday}: ${sync.status} (${sync.itemsWritten})`);
      }

      const state = await loadResultState(repository, week.id);
      if (!state) continue;

      const { result } = await executeResultProcessing(
        repository,
        state,
        clock,
        SYSTEM_ACTOR,
      );

      if (result.selectionsUpdated > 0 || result.outcome) {
        report.resultsProcessed.push(
          `${week.id}: updated=${result.selectionsUpdated}, eliminated=${result.eliminated}, outcome=${result.outcome ?? 'none'}, pending=${result.pendingCount}`,
        );
      }
    }
  } catch (error) {
    report.errors.push(`Result processing: ${message(error)}`);
  }

  // -------------------------------------------------------------------------
  // 3. Daily refresh of the full fixture list and the league table.
  //
  // Driven by the age of the last successful sync rather than by a separate
  // cron rule, so a day of provider failures self-corrects on the next tick
  // instead of waiting for tomorrow's schedule.
  // -------------------------------------------------------------------------
  try {
    if (await isStale('FIXTURES')) {
      const sync = await syncFixtures(context, season.id);
      report.syncs.push(`FIXTURES: ${sync.status} (${sync.itemsWritten})`);
    }
    if (await isStale('STANDINGS')) {
      const sync = await syncStandings(context, season.id);
      report.syncs.push(`STANDINGS: ${sync.status} (${sync.itemsWritten})`);
    }
  } catch (error) {
    report.errors.push(`Daily refresh: ${message(error)}`);
  }

  if (report.errors.length > 0) console.error('Scheduler tick had errors', report);
  else console.log('Scheduler tick', JSON.stringify(report));

  return report;
};

/** Back off for an hour after a failure rather than retrying every tick. */
const FAILURE_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Should we refresh this kind of data?
 *
 * Yes if the last success is a day old, or if the last attempt failed more than
 * an hour ago. The backoff matters: without it a revoked token would burn 96
 * requests and 96 audit rows a day announcing the same failure.
 */
async function isStale(kind: 'FIXTURES' | 'STANDINGS'): Promise<boolean> {
  const last = await repository.lastSync(kind);
  if (!last?.finishedAt) return true;

  const age = clock.nowMillis() - Date.parse(last.finishedAt);
  if (Number.isNaN(age)) return true;

  return last.status === 'SUCCESS' ? age > DAILY_REFRESH_MS : age > FAILURE_BACKOFF_MS;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
