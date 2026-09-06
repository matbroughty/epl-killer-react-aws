import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatPence } from '@shared/domain/money';
import type { Fixture, Team } from '@shared/domain/types';
import type { CompetitionView } from '@shared/domain/visibility';
import { CompetitionTable } from '@/components/CompetitionTable';
import { PickPanel } from '@/components/PickPanel';
import { RoundHeader } from '@/components/RoundHeader';
import { fetchCompetitionView, fetchFixtures, fetchTeams, markSelfPaid } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/**
 * The home page, serving both audiences.
 *
 * Signed out it is the public leaderboard: round, pot, who is alive, and the
 * history of weeks whose deadlines have passed. Signed in the pick interface
 * appears above the same table.
 *
 * One page rather than two, because the underlying data is identical — the only
 * difference is what the server chose to reveal.
 */
export function HomePage() {
  const { user, loading: authLoading } = useAuth();
  const signedIn = Boolean(user);

  const [view, setView] = useState<CompetitionView | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [payMessage, setPayMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await fetchCompetitionView(signedIn);
      setView(next);

      // Only the pick grid needs teams and fixtures, so only load them when
      // there is somebody who might pick.
      if (next.me?.canSelect && next.round) {
        const week = next.weeks.find((candidate) => candidate.id === next.currentWeekId);
        const [loadedTeams, loadedFixtures] = await Promise.all([
          fetchTeams(signedIn, next.round.seasonId),
          week?.matchday != null
            ? fetchFixtures(signedIn, next.round.seasonId, week.matchday)
            : Promise.resolve([]),
        ]);
        setTeams(loadedTeams);
        setFixtures(loadedFixtures);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load the competition.');
    } finally {
      setLoading(false);
    }
  }, [signedIn]);

  useEffect(() => {
    // Wait for auth to settle, or the first load would fire as a guest and then
    // immediately repeat as a player.
    if (!authLoading) void load();
  }, [authLoading, load]);

  const pay = async () => {
    if (!view?.round) return;
    try {
      const result = await markSelfPaid(view.round.id);
      setPayMessage(result.message ?? 'Marked as paid.');
      await load();
    } catch (caught) {
      setPayMessage(caught instanceof Error ? caught.message : 'Could not update payment.');
    }
  };

  if (loading || authLoading) return <div className="loading">Loading…</div>;

  if (error) {
    return (
      <div className="notice notice--error" role="alert">
        {error}
      </div>
    );
  }

  if (!view?.round) {
    return (
      <div className="card">
        <h2 className="card__title">No Killer Round yet</h2>
        <p className="muted">
          Nothing is running at the moment. {user?.isAdmin ? 'Create one in the ' : ''}
          {user?.isAdmin && <Link to="/admin">admin area</Link>}
          {user?.isAdmin ? '.' : 'Check back soon.'}
        </p>
      </div>
    );
  }

  return (
    <>
      <RoundHeader view={view} />

      {!signedIn && (
        <div className="notice notice--info">
          <Link to="/login">Sign in</Link> to make your pick. Picks stay hidden until each
          deadline passes.
        </div>
      )}

      {view.me && (
        <>
          <PickPanel view={view} teams={teams} fixtures={fixtures} onChanged={load} />

          {!view.me.paid && view.round.status === 'ACTIVE' && (
            <div className="card">
              <div className="spread">
                <div>
                  <div className="row__name">Entry fee not recorded</div>
                  <div className="row__meta">
                    {formatPence(view.pot?.entryFeePence ?? 500)} for this Killer Round. You owe
                    it whether or not it is marked here.
                  </div>
                </div>
                <button type="button" className="btn btn--primary btn--small" onClick={() => void pay()}>
                  I have paid
                </button>
              </div>
              {payMessage && (
                <div className="notice notice--ok" role="status" style={{ marginTop: 12 }}>
                  {payMessage}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <CompetitionTable view={view} />

      <p className="faint center" style={{ marginTop: 20 }}>
        Win and you survive. Draw or lose and you are out. A team can only be used once per
        Killer Round. <Link to="/rules">Full rules</Link> · <Link to="/history">Past rounds</Link>
      </p>
    </>
  );
}
