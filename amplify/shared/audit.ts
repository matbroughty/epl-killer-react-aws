import type { Repository } from './repository.js';
import type { ResolvedViewer } from './viewer.js';

/**
 * The audit trail.
 *
 * Two kinds of thing get recorded: administrative overrides, because somebody
 * changed the result of a game people have paid into, and automated decisions,
 * because "the computer picked Burnley for you" needs to be explainable months
 * later. Automated entries use the actor `system`.
 *
 * Auditing is written from the backend, never from React — a client that reports
 * its own actions is not an audit trail.
 */

export const SYSTEM_ACTOR: ResolvedViewer = {
  kind: 'ADMIN',
  playerId: null,
  sub: 'system',
  email: null,
  displayName: 'Automated',
};

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string;
  killerRoundId?: string | null;
  before?: unknown;
  after?: unknown;
  note?: string;
}

export async function recordAudit(
  repository: Repository,
  actor: ResolvedViewer,
  at: string,
  entry: AuditEntry,
): Promise<void> {
  try {
    await repository.models.AdminAuditEvent.create({
      at,
      actorSub: actor.sub ?? 'system',
      actorName: actor.displayName ?? 'Unknown',
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      killerRoundId: entry.killerRoundId ?? null,
      before: entry.before === undefined ? null : JSON.stringify(entry.before),
      after: entry.after === undefined ? null : JSON.stringify(entry.after),
      note: entry.note ?? null,
    });
  } catch (error) {
    // A failed audit write must not roll back the thing being audited — the
    // player's pick matters more than our bookkeeping. It is logged loudly so
    // the gap is visible in CloudWatch.
    console.error('AUDIT WRITE FAILED', entry.action, entry.entityId, error);
  }
}

export async function recordAuditBatch(
  repository: Repository,
  actor: ResolvedViewer,
  at: string,
  entries: readonly AuditEntry[],
): Promise<void> {
  for (const entry of entries) {
    await recordAudit(repository, actor, at, entry);
  }
}
