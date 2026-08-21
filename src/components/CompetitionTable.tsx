import { formatMatchday } from '@shared/domain/format';
import type { CompetitionView, SelectionCell } from '@shared/domain/visibility';

/**
 * The competition history grid: one row per player, one column per Round Week.
 *
 * The privacy rule is visible here as `cell.hidden`, but it is not decided here.
 * The server has already stripped the team name out of any cell the viewer is
 * not entitled to, so there is nothing in the payload to leak. All this
 * component does is render `Submitted 🔒` instead of a team.
 *
 * On a phone the table scrolls inside its own container with the player column
 * pinned, so the page body never scrolls sideways.
 */
export function CompetitionTable({ view }: { view: CompetitionView }) {
  if (!view.round || view.entries.length === 0) {
    return (
      <section className="card">
        <h2 className="card__title">Competition</h2>
        <p className="empty">No entrants yet.</p>
      </section>
    );
  }

  const byPlayerAndWeek = new Map<string, SelectionCell>();
  for (const cell of view.selections) {
    byPlayerAndWeek.set(`${cell.playerId}::${cell.roundWeekId}`, cell);
  }

  return (
    <section>
      <h2 className="card__title">Competition</h2>
      <div className="tablewrap">
        <table className="grid">
          <caption className="sr-only">
            Each player's pick for every Round Week. Picks for a week whose deadline has not
            passed are hidden.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="col-player">
                Player
              </th>
              <th scope="col">Status</th>
              {view.weeks.map((week) => (
                <th key={week.id} scope="col">
                  {formatMatchday(week.matchday)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.entries.map((entry) => {
              const isMe = view.me?.playerId === entry.playerId;
              return (
                <tr
                  key={entry.roundEntryId}
                  className={[entry.status === 'ELIMINATED' ? 'is-out' : '', isMe ? 'is-me' : '']
                    .filter(Boolean)
                    .join(' ')}
                >
                  <th scope="row" className="col-player">
                    {entry.displayName}
                    {isMe && <span className="sr-only"> (you)</span>}
                  </th>
                  <td>
                    <StatusPill status={entry.status} paid={entry.paid} />
                  </td>
                  {view.weeks.map((week) => (
                    <td key={week.id}>
                      <Cell
                        cell={byPlayerAndWeek.get(`${entry.playerId}::${week.id}`)}
                        eliminatedBefore={wasAlreadyOut(entry, week, view)}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Was this player already out before the given week?
 *
 * Used to tell "no pick because they were eliminated" (blank) apart from "no
 * pick yet" — the difference between a finished row and a live one.
 */
function wasAlreadyOut(
  entry: CompetitionView['entries'][number],
  week: CompetitionView['weeks'][number],
  view: CompetitionView,
): boolean {
  if (entry.status !== 'ELIMINATED' || !entry.eliminatedRoundWeekId) return false;
  const eliminatedIn = view.weeks.find(
    (candidate) => candidate.id === entry.eliminatedRoundWeekId,
  );
  return eliminatedIn ? week.sequenceNumber > eliminatedIn.sequenceNumber : false;
}

function Cell({
  cell,
  eliminatedBefore,
}: {
  cell: SelectionCell | undefined;
  eliminatedBefore: boolean;
}) {
  if (!cell) {
    return eliminatedBefore ? (
      <span className="cell-empty" aria-label="Out of the competition">
        —
      </span>
    ) : (
      <span className="cell-empty" aria-label="No pick">
        ·
      </span>
    );
  }

  if (cell.hidden) {
    // The whole privacy rule, as the player sees it.
    return (
      <span className="cell-hidden" title="Hidden until the deadline">
        Submitted 🔒
      </span>
    );
  }

  const outcomeClass =
    cell.outcome === 'SURVIVED'
      ? 'cell-survived'
      : cell.outcome === 'ELIMINATED'
        ? 'cell-eliminated'
        : 'cell-pending';

  const mark =
    cell.outcome === 'SURVIVED' ? '✓' : cell.outcome === 'ELIMINATED' ? '✗' : '';

  return (
    <span className={`cell-team ${outcomeClass}`}>
      {cell.teamCode ?? cell.teamName ?? '—'}
      {mark && (
        <>
          {' '}
          <span aria-hidden="true">{mark}</span>
          <span className="sr-only">
            {cell.outcome === 'SURVIVED' ? 'survived' : 'eliminated'}
          </span>
        </>
      )}
      {cell.selectionType === 'AUTO_LOWEST_POSITION' && (
        <span title="Automatically assigned after the deadline"> ᴀ</span>
      )}
    </span>
  );
}

function StatusPill({ status, paid }: { status: string; paid: boolean | null }) {
  const label =
    status === 'WINNER' ? 'Winner' : status === 'ALIVE' ? 'Alive' : 'Out';
  const className =
    status === 'WINNER' ? 'pill--winner' : status === 'ALIVE' ? 'pill--alive' : 'pill--out';

  return (
    <>
      <span className={`pill ${className}`}>{label}</span>
      {paid === false && (
        <>
          {' '}
          <span className="pill pill--pending" title="Entry fee not yet recorded">
            Unpaid
          </span>
        </>
      )}
    </>
  );
}
