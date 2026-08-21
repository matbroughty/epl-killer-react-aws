import { useState } from 'react';
import { AdminPlayers } from './AdminPlayers';
import { AdminRounds } from './AdminRounds';
import { AdminWeeks } from './AdminWeeks';
import { AdminFootballData } from './AdminFootballData';
import { AdminAudit } from './AdminAudit';

/**
 * The admin area.
 *
 * Plain tabs and plain forms. The brief asked for functionality and clarity over
 * polish, and this is the screen that runs the competition — being able to see
 * every field at once matters more than looking nice.
 *
 * Tab state is local rather than routed: the admin area is one working surface,
 * and a deep link to "the players tab" is not worth a route.
 */
const TABS = [
  { id: 'rounds', label: 'Rounds' },
  { id: 'weeks', label: 'Round Weeks' },
  { id: 'players', label: 'Players' },
  { id: 'football', label: 'Football data' },
  { id: 'audit', label: 'Audit' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function AdminPage() {
  const [tab, setTab] = useState<TabId>('rounds');

  return (
    <>
      <h1 className="card__title" style={{ fontSize: '1.4rem', marginBottom: 12 }}>
        Administration
      </h1>

      <div className="masthead__nav" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`navlink ${tab === entry.id ? 'navlink--active' : ''}`}
            onClick={() => setTab(entry.id)}
            aria-current={tab === entry.id ? 'page' : undefined}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === 'rounds' && <AdminRounds />}
      {tab === 'weeks' && <AdminWeeks />}
      {tab === 'players' && <AdminPlayers />}
      {tab === 'football' && <AdminFootballData />}
      {tab === 'audit' && <AdminAudit />}
    </>
  );
}

/** Shared feedback banner, so every admin screen reports the same way. */
export function Feedback({
  error,
  message,
}: {
  error: string | null;
  message: string | null;
}) {
  if (error) {
    return (
      <div className="notice notice--error" role="alert">
        {error}
      </div>
    );
  }
  if (message) {
    return (
      <div className="notice notice--ok" role="status">
        {message}
      </div>
    );
  }
  return null;
}

/**
 * Wraps an admin action so every screen handles success and failure the same
 * way, and nothing is left in a half-reported state after a rejected mutation.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const run = async (
    work: () => Promise<string | void>,
    after?: () => Promise<unknown> | unknown,
  ) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await work();
      if (typeof result === 'string') setMessage(result);
      await after?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, message, run, setError, setMessage };
}
