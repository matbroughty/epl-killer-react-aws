import { useCallback, useEffect, useState } from 'react';
import { formatDateTime } from '@shared/domain/format';
import { adminMutations, adminReads } from '@/lib/adminApi';
import { Feedback, useAction } from './AdminPage';

/**
 * Football data synchronisation.
 *
 * The buttons trigger the same code the 15-minute scheduler runs. The
 * football-data.org token lives in Secrets Manager and is read only inside the
 * Lambda — nothing on this page could reveal it.
 *
 * Every attempt, successful or not, appears in the log below, so a broken token
 * or an exhausted rate limit is visible here rather than in CloudWatch.
 */
type Season = Awaited<ReturnType<typeof adminReads.seasons>>[number];
type Sync = Awaited<ReturnType<typeof adminReads.syncs>>[number];
type Snapshot = Awaited<ReturnType<typeof adminReads.snapshots>>[number];

export function AdminFootballData() {
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [seasonId, setSeasonId] = useState('');
  const [syncs, setSyncs] = useState<Sync[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [teamCount, setTeamCount] = useState<number | null>(null);
  const [matchday, setMatchday] = useState('');
  const { busy, error, message, run } = useAction();

  const load = useCallback(async () => {
    const loadedSeasons = await adminReads.seasons();
    setSeasons(loadedSeasons);
    const active = loadedSeasons.find((season) => season.active);
    const chosen = seasonId || active?.id || '';
    if (chosen !== seasonId) setSeasonId(chosen);

    const loadedSyncs = await adminReads.syncs();
    setSyncs(
      loadedSyncs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 25),
    );

    if (chosen) {
      const [teams, loadedSnapshots] = await Promise.all([
        adminReads.teams(chosen),
        adminReads.snapshots(chosen),
      ]);
      setTeamCount(teams.filter((team) => team.active).length);
      setSnapshots(loadedSnapshots);
    }
  }, [seasonId]);

  useEffect(() => {
    void load();
  }, [load]);

  const lastOf = (kind: string) =>
    syncs.find((sync) => sync.kind === kind && sync.status === 'SUCCESS');
  const lastFailureOf = (kind: string) =>
    syncs.find((sync) => sync.kind === kind && sync.status === 'FAILURE');

  const sync = (kind: string, withMatchday = false) =>
    void run(async () => {
      const result = await adminMutations.sync(
        kind,
        seasonId,
        withMatchday && matchday ? Number(matchday) : undefined,
      );
      const detail = result['sync'] as Record<string, unknown> | undefined;
      return `${kind}: ${String(detail?.['status'])} — ${String(detail?.['message'] ?? '')} (${String(detail?.['requestCount'] ?? 0)} API request(s))`;
    }, load);

  return (
    <>
      <Feedback error={error} message={message} />

      <section className="card">
        <h2 className="card__title">Season</h2>
        <select
          className="select"
          value={seasonId}
          onChange={(event) => setSeasonId(event.target.value)}
        >
          <option value="">Choose a season…</option>
          {seasons.map((season) => (
            <option key={season.id} value={season.id}>
              {season.name}
              {season.active ? ' (active)' : ''}
            </option>
          ))}
        </select>
        {seasonId && (
          <p className="field__hint">
            {teamCount ?? 0} active team(s) imported.{' '}
            {teamCount === 0 && 'Sync teams first — fixtures cannot be matched without them.'}
          </p>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">Sync</h2>
        <p className="faint">
          Order matters on a new season: competition, then teams, then fixtures, then standings.
          Fixtures and standings are refreshed automatically once a day, and results on match
          days, so these buttons are for setting up or forcing a catch-up.
        </p>

        <div className="rows" style={{ marginBottom: 12 }}>
          {[
            { kind: 'COMPETITION', label: 'Competition & current gameweek' },
            { kind: 'TEAMS', label: 'Teams' },
            { kind: 'FIXTURES', label: 'Fixtures (whole season)' },
            { kind: 'STANDINGS', label: 'Standings (captures a snapshot)' },
          ].map((entry) => {
            const last = lastOf(entry.kind);
            const failure = lastFailureOf(entry.kind);
            return (
              <div className="row" key={entry.kind}>
                <div className="row__main">
                  <div className="row__name">{entry.label}</div>
                  <div className="row__meta">
                    {last
                      ? `Last success ${formatDateTime(last.finishedAt ?? last.startedAt)}`
                      : 'Never synced'}
                    {failure && (!last || failure.startedAt > last.startedAt) && (
                      <span className="cell-eliminated"> · last attempt failed</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={busy || !seasonId}
                  onClick={() => sync(entry.kind)}
                >
                  Sync
                </button>
              </div>
            );
          })}
        </div>

        <div className="spread" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 1, marginBottom: 0, minWidth: 120 }}>
            <label className="field__label" htmlFor="sync-matchday">
              Results for gameweek
            </label>
            <input
              id="sync-matchday"
              className="input"
              inputMode="numeric"
              value={matchday}
              onChange={(event) => setMatchday(event.target.value)}
              placeholder="e.g. 8"
            />
          </div>
          <button
            type="button"
            className="btn"
            disabled={busy || !seasonId || !matchday}
            onClick={() => sync('RESULTS', true)}
          >
            Sync results
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Standings snapshots</h2>
        <p className="faint">
          Immutable captures of the league table. Automatic picks record which snapshot they came
          from, so a historical decision is never recomputed from a table that has moved on.
        </p>
        <div className="rows">
          {snapshots.map((snapshot) => (
            <div className="row" key={snapshot.id}>
              <div className="row__main">
                <div className="row__name">{formatDateTime(snapshot.capturedAt)}</div>
                <div className="row__meta">
                  {snapshot.matchday ? `GW${snapshot.matchday}` : 'gameweek unknown'} ·{' '}
                  {(snapshot.rows ?? []).length} rows · {snapshot.source}
                </div>
              </div>
            </div>
          ))}
          {snapshots.length === 0 && <div className="empty">No snapshots captured yet.</div>}
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Sync log</h2>
        <div className="rows">
          {syncs.map((entry) => (
            <div className="row" key={entry.id}>
              <div className="row__main">
                <div className="row__name">
                  {entry.kind}{' '}
                  <span
                    className={`pill ${
                      entry.status === 'SUCCESS'
                        ? 'pill--alive'
                        : entry.status === 'PARTIAL'
                          ? 'pill--pending'
                          : 'pill--out'
                    }`}
                  >
                    {entry.status}
                  </span>
                  <span className="pill pill--neutral">{entry.trigger}</span>
                </div>
                <div className="row__meta">
                  {formatDateTime(entry.startedAt)}
                  {entry.matchday ? ` · GW${entry.matchday}` : ''} ·{' '}
                  {entry.itemsWritten ?? 0} item(s) · {entry.requestCount ?? 0} request(s)
                  {entry.message ? ` · ${entry.message}` : ''}
                </div>
              </div>
            </div>
          ))}
          {syncs.length === 0 && <div className="empty">No syncs recorded yet.</div>}
        </div>
      </section>
    </>
  );
}
