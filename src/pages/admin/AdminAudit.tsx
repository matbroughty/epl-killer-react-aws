import { useEffect, useState } from 'react';
import { formatDateTime } from '@shared/domain/format';
import { adminReads } from '@/lib/adminApi';

/**
 * The audit log.
 *
 * Two kinds of entry: administrative overrides, because somebody changed the
 * outcome of a competition people have paid into, and automated decisions,
 * because "the computer picked Burnley for you" has to be explainable weeks
 * later. Automated entries show as `Automated`.
 *
 * Written only by the backend. A client that reported its own actions would not
 * be an audit trail.
 */
type AuditEvent = Awaited<ReturnType<typeof adminReads.audit>>[number];

/** Actions worth calling out visually, since they change money or outcomes. */
const SIGNIFICANT = new Set([
  'SELECTION_OVERRIDDEN',
  'KILLER_ROUND_WON',
  'KILLER_ROUND_ROLLOVER',
  'KILLER_ROUND_WON_BY_ADMIN',
  'KILLER_ROUND_ROLLOVER_BY_ADMIN',
  'KILLER_ROUND_ABANDONED_BY_ADMIN',
  'PAYMENT_STATUS_CHANGED',
  'AUTO_SELECTION_FAILED',
  'FIXTURE_NEEDS_ATTENTION',
]);

export function AdminAudit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    adminReads
      .audit()
      .then((loaded) => setEvents(loaded.sort((a, b) => b.at.localeCompare(a.at))))
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not load the audit log.'),
      );
  }, []);

  const shown = filter
    ? events.filter((event) =>
        [event.action, event.actorName, event.note, event.entityId]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(filter.toLowerCase()),
      )
    : events;

  if (error) {
    return (
      <div className="notice notice--error" role="alert">
        {error}
      </div>
    );
  }

  return (
    <section className="card">
      <h2 className="card__title">Audit log</h2>

      <div className="field">
        <input
          className="input"
          placeholder="Filter by action, person or note…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <div className="rows">
        {shown.map((event) => (
          <div className="row" key={event.id} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div className="spread">
              <div className="row__name">
                {event.action.replaceAll('_', ' ').toLowerCase()}{' '}
                {SIGNIFICANT.has(event.action) && (
                  <span className="pill pill--pending">Notable</span>
                )}
              </div>
              <span className="faint">{formatDateTime(event.at)}</span>
            </div>
            <div className="row__meta">
              {event.actorName ?? event.actorSub ?? 'unknown'}
              {event.entityType && ` · ${event.entityType} ${event.entityId ?? ''}`}
            </div>
            {event.note && <div className="row__meta">{event.note}</div>}
            {(event.before || event.after) && (
              <details style={{ marginTop: 6 }}>
                <summary className="faint">Before / after</summary>
                <pre
                  style={{
                    overflowX: 'auto',
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    margin: '6px 0 0',
                  }}
                >
                  {formatJson(event.before)}
                  {'\n→\n'}
                  {formatJson(event.after)}
                </pre>
              </details>
            )}
          </div>
        ))}
        {shown.length === 0 && (
          <div className="empty">
            {events.length === 0 ? 'Nothing recorded yet.' : 'Nothing matches that filter.'}
          </div>
        )}
      </div>
    </section>
  );
}

/** `before`/`after` are stored as JSON strings; show them readably. */
function formatJson(value: unknown): string {
  if (value === null || value === undefined) return '—';
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return String(value);
  }
}
