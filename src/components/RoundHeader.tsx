import { formatMatchday, formatRemaining } from '@shared/domain/format';
import { formatPence } from '@shared/domain/money';
import type { CompetitionView } from '@shared/domain/visibility';

/**
 * The top of the page: round, pot, gameweek, survivors.
 *
 * Deliberately the largest thing on screen. On a phone this is often all anyone
 * reads — how much is in it, which gameweek, am I still alive.
 */
export function RoundHeader({ view }: { view: CompetitionView }) {
  const { round, pot } = view;
  if (!round) return null;

  const currentWeek = view.weeks.find((week) => week.id === view.currentWeekId);
  const showMoneyDetail = view.viewerKind !== 'ANONYMOUS' && pot !== null;

  return (
    <header className="roundhead">
      <div className="spread">
        <h1 className="roundhead__title">Killer Round {round.number}</h1>
        <RoundStatus status={round.status} winner={round.winnerDisplayName} />
      </div>

      {pot && (
        <>
          <div className="roundhead__pot">{formatPence(pot.totalPotPence)}</div>
          <div className="roundhead__potlabel">Prize pot</div>
        </>
      )}

      <div className="roundhead__meta">
        {currentWeek && (
          <>
            <span>Round Week {currentWeek.sequenceNumber}</span>
            <span className="roundhead__sep">·</span>
            <span>Premier League {formatMatchday(currentWeek.matchday)}</span>
            <span className="roundhead__sep">·</span>
          </>
        )}
        <span>{formatRemaining(view.aliveCount)}</span>
      </div>

      {showMoneyDetail && (
        <div className="roundhead__money">
          <span>
            Entry <b>{formatPence(pot.entryFeePence)}</b>
          </span>
          {pot.rolloverInPence > 0 && (
            <span>
              Rollover in <b>{formatPence(pot.rolloverInPence)}</b>
            </span>
          )}
          <span>
            Collected{' '}
            <b>
              {formatPence(pot.collectedPence)} of {formatPence(pot.expectedEntriesPence)}
            </b>
          </span>
          {pot.outstandingPence > 0 && (
            <span>
              Outstanding <b>{formatPence(pot.outstandingPence)}</b>
            </span>
          )}
          <span>
            Paid{' '}
            <b>
              {pot.paidCount}/{pot.entrantCount}
            </b>
          </span>
        </div>
      )}
    </header>
  );
}

function RoundStatus({ status, winner }: { status: string; winner: string | null }) {
  switch (status) {
    case 'ACTIVE':
      return <span className="pill pill--alive">In play</span>;
    case 'WON':
      return <span className="pill pill--winner">Won{winner ? ` · ${winner}` : ''}</span>;
    case 'ROLLOVER':
      return <span className="pill pill--pending">Rollover</span>;
    case 'DRAFT':
      return <span className="pill pill--neutral">Not started</span>;
    default:
      return <span className="pill pill--neutral">{status}</span>;
  }
}
