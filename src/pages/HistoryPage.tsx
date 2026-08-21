import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate } from '@shared/domain/format';
import { formatPence } from '@shared/domain/money';
import { fetchHistoryView, type HistoryViewShape } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/**
 * Past rounds, winners and statistics.
 *
 * Kept simple on purpose. The data model carries enough to compute much more
 * later, but a first version that people actually read beats a dashboard nobody
 * opens.
 */
export function HistoryPage() {
  const { user, loading: authLoading } = useAuth();
  const [history, setHistory] = useState<HistoryViewShape | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    fetchHistoryView(Boolean(user))
      .then(setHistory)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not load history.'),
      );
  }, [authLoading, user]);

  if (error) {
    return (
      <div className="notice notice--error" role="alert">
        {error}
      </div>
    );
  }
  if (!history) return <div className="loading">Loading…</div>;

  const decided = history.rounds.filter((round) => round.status !== 'DRAFT');

  // Nothing has been played and nothing imported. One clear message beats three
  // cards of empty tables, which read as broken rather than as "not yet".
  if (decided.length === 0 && history.players.length === 0) {
    return (
      <>
        <h1 className="card__title" style={{ fontSize: '1.4rem', marginBottom: 16 }}>
          History
        </h1>
        <div className="card">
          <p className="empty">
            No history yet. Once a Killer Round finishes it will appear here, with winners,
            rollovers and per-player statistics.
          </p>
        </div>
      </>
    );
  }

  return (
    <>
      <h1 className="card__title" style={{ fontSize: '1.4rem', marginBottom: 16 }}>
        History
      </h1>

      <section className="card">
        <h2 className="card__title">Killer Rounds</h2>
        {decided.length === 0 ? (
          <p className="empty">No completed rounds yet.</p>
        ) : (
          <div className="tablewrap">
            <table className="grid">
              <thead>
                <tr>
                  <th scope="col" className="col-player">
                    Round
                  </th>
                  <th scope="col">Season</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Pot</th>
                  <th scope="col">Weeks</th>
                  <th scope="col">Entrants</th>
                  <th scope="col">Completed</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((round) => (
                  <tr key={round.id}>
                    <th scope="row" className="col-player">
                      <Link to={`/?round=${round.id}`}>Round {round.number}</Link>
                      {round.dataSource === 'LEGACY_CSV' && (
                        <>
                          {' '}
                          <span
                            className="pill pill--neutral"
                            title="Imported from the historical spreadsheet. Gameweeks, dates and pot sizes were not recorded."
                          >
                            Archive
                          </span>
                        </>
                      )}
                    </th>
                    <td>{round.seasonName || '—'}</td>
                    <td>
                      <Outcome round={round} />
                    </td>
                    <td>
                      {round.dataSource === 'LEGACY_CSV' && round.totalPotPence === 0
                        ? '—'
                        : formatPence(round.totalPotPence)}
                      {round.rolloverInPence > 0 && (
                        <span
                          className="faint"
                          title={`Includes ${formatPence(round.rolloverInPence)} rolled over`}
                        >
                          {' '}
                          ↻
                        </span>
                      )}
                    </td>
                    <td>{round.weekCount}</td>
                    <td>{round.entrantCount}</td>
                    <td>{round.completedAt ? formatDate(round.completedAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="faint" style={{ marginTop: 10 }}>
          ↻ marks a round whose pot included money carried over from a previous round.
        </p>
      </section>

      <section className="card">
        <h2 className="card__title">Players</h2>
        {history.players.length === 0 ? (
          <p className="empty">No entrants recorded yet.</p>
        ) : (
        <div className="tablewrap">
          <table className="grid">
            <thead>
              <tr>
                <th scope="col" className="col-player">
                  Player
                </th>
                <th scope="col" title="Killer Rounds won">
                  Won
                </th>
                <th scope="col">Winnings</th>
                <th scope="col" title="Killer Rounds entered">
                  Played
                </th>
                <th scope="col" title="Times eliminated">
                  Out
                </th>
                <th scope="col" title="Eliminated in the first week of a round">
                  1st wk
                </th>
                <th scope="col" title="Longest run of surviving weeks">
                  Streak
                </th>
                <th scope="col" title="Picks assigned automatically after a missed deadline">
                  Auto
                </th>
                <th scope="col">Favourite</th>
              </tr>
            </thead>
            <tbody>
              {history.players.map((player) => (
                <tr key={player.playerId}>
                  <th scope="row" className="col-player">
                    {player.displayName}
                  </th>
                  <td>{player.roundsWon > 0 ? <b>{player.roundsWon}</b> : '—'}</td>
                  <td>
                    {player.totalWinningsPence > 0
                      ? formatPence(player.totalWinningsPence)
                      : '—'}
                  </td>
                  <td>{player.roundsEntered}</td>
                  <td>{player.eliminations}</td>
                  <td>{player.firstWeekEliminations}</td>
                  <td>{player.longestSurvivalStreak}</td>
                  <td>{player.autoSelections}</td>
                  <td>
                    {player.favouriteTeamName ? (
                      <span className="faint">
                        {player.favouriteTeamName} ({player.favouriteTeamCount})
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </section>

      {history.teamPopularity.length > 0 && (
        <section className="card">
          <h2 className="card__title">Most-picked teams</h2>
          <div className="rows">
            {history.teamPopularity.slice(0, 12).map((team) => (
              <div className="row" key={team.teamName}>
                <div className="row__main">
                  <div className="row__name">{team.teamName}</div>
                </div>
                <div className="muted">{team.count} picks</div>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function Outcome({ round }: { round: HistoryViewShape['rounds'][number] }) {
  switch (round.status) {
    case 'WON':
      return (
        <span className="pill pill--winner">{round.winnerDisplayName ?? 'Won'}</span>
      );
    case 'ROLLOVER':
      return (
        <span
          className="pill pill--pending"
          title={
            round.rolloverOutPence > 0
              ? `${formatPence(round.rolloverOutPence)} carried forward`
              : 'Pot carried forward'
          }
        >
          Rollover
        </span>
      );
    case 'ACTIVE':
      return <span className="pill pill--alive">In play</span>;
    case 'ABANDONED':
      return (
        <span className="pill pill--neutral" title={round.notes ?? undefined}>
          Unknown
        </span>
      );
    default:
      return <span className="pill pill--neutral">{round.status}</span>;
  }
}
