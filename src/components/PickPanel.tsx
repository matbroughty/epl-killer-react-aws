import { useEffect, useMemo, useState } from 'react';
import { formatCountdown, formatDeadline } from '@shared/domain/format';
import { buildTeamOptions } from '@shared/domain/selection';
import { millisUntil, systemClock } from '@shared/domain/clock';
import type { Fixture, Team } from '@shared/domain/types';
import type { CompetitionView } from '@shared/domain/visibility';
import { submitSelection } from '@/lib/api';

/**
 * The pick interface — the most important thing in the application.
 *
 * Everything about it assumes a phone held in one hand on a Saturday morning:
 * large tap targets, the current pick obvious, used teams visible but disabled,
 * and the deadline stated in words rather than left to be worked out.
 *
 * The disabled buttons here are courtesy only. Every rule is enforced again by
 * `submitSelection` on the server, so nothing is lost if someone re-enables one
 * in dev tools.
 */

interface Props {
  view: CompetitionView;
  teams: Team[];
  fixtures: Fixture[];
  onChanged: () => void | Promise<void>;
}

export function PickPanel({ view, teams, fixtures, onChanged }: Props) {
  const me = view.me;
  const week = view.weeks.find((candidate) => candidate.id === view.currentWeekId);

  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(
    week ? millisUntil(week.deadline, systemClock) : null,
  );

  // A one-second tick would be noise on a page opened once a week; a minute is
  // enough to watch a deadline approach.
  useEffect(() => {
    if (!week?.deadline) return;
    const update = () => setRemaining(millisUntil(week.deadline, systemClock));
    update();
    const timer = window.setInterval(update, 30_000);
    return () => window.clearInterval(timer);
  }, [week?.deadline]);

  const options = useMemo(
    () => buildTeamOptions(teams, me?.usedTeamIds ?? [], fixtures),
    [teams, me?.usedTeamIds, fixtures],
  );

  if (!me) return null;

  if (me.status === 'ELIMINATED') {
    return (
      <section className="card">
        <h2 className="card__title">Your pick</h2>
        <div className="notice notice--error" role="status">
          You were eliminated from this Killer Round. Better luck in the next one.
        </div>
      </section>
    );
  }

  if (!me.roundEntryId) {
    return (
      <section className="card">
        <h2 className="card__title">Your pick</h2>
        <p className="muted">You are not an entrant in this Killer Round.</p>
      </section>
    );
  }

  const used = options.filter((option) => option.used);
  const locked = !me.canSelect;

  const choose = async (teamId: string) => {
    // Unreachable from the UI — the grid only renders with an open week — but
    // asserted rather than `!`-ed so a future refactor cannot post to undefined.
    if (!week) return;

    setPending(teamId);
    setError(null);
    try {
      const result = await submitSelection(week.id, teamId);
      if (!result.ok) {
        // The server is the authority. If it says no, say why — and refresh, in
        // case the reason is that the world moved on while the page sat open.
        setError(result.message ?? 'That pick was not accepted.');
        await onChanged();
      } else {
        await onChanged();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save your pick.');
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="card">
      <h2 className="card__title">Your pick</h2>

      {error && (
        <div className="notice notice--error" role="alert">
          {error}
        </div>
      )}

      {me.currentSelection?.teamName ? (
        <div className={locked ? 'chosen chosen--locked' : 'chosen'}>
          <span aria-hidden="true">{locked ? '🔒' : '✓'}</span>
          <span>{me.currentSelection.teamName}</span>
          {me.currentSelection.selectionType === 'AUTO_LOWEST_POSITION' && (
            <span className="pill pill--pending">Auto</span>
          )}
        </div>
      ) : locked ? (
        <div className="notice notice--warn" role="status">
          No pick was recorded for this week.
        </div>
      ) : (
        <p className="muted">Choose a team. You can change it until the deadline.</p>
      )}

      {!locked && week && (
        <>
          <div className="pickgrid">
            {options.map((option) => {
              const isSelected = me.currentSelection?.teamId === option.team.id;
              const disabled = !option.selectable || pending !== null;
              return (
                <button
                  key={option.team.id}
                  type="button"
                  className={[
                    'pick',
                    isSelected ? 'pick--selected' : '',
                    option.used ? 'pick--used' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  disabled={disabled && !isSelected}
                  onClick={() => void choose(option.team.id)}
                  aria-pressed={isSelected}
                  aria-label={
                    option.used
                      ? `${option.team.name} — already used`
                      : !option.hasFixture
                        ? `${option.team.name} — no fixture this gameweek`
                        : option.team.name
                  }
                >
                  <TeamMark team={option.team} />
                  <span className="pick__name">{option.team.shortName || option.team.name}</span>
                </button>
              );
            })}
          </div>

          {used.length > 0 && (
            <p className="faint" style={{ marginTop: 10 }}>
              Previously used: {used.map((option) => option.team.shortName).join(', ')}
            </p>
          )}
        </>
      )}

      {week && (
        <div className="deadline">
          <div>
            <span className="muted">{locked ? 'Closed' : 'Selection closes'} </span>
            <span className="deadline__when">{formatDeadline(week.deadline)}</span>
          </div>
          {!locked && <div className="deadline__count">{formatCountdown(remaining)}</div>}
        </div>
      )}
    </section>
  );
}

/**
 * A badge where the provider gave us one, the three-letter code otherwise.
 *
 * The code fallback matters: a missing crest should not leave a blank square,
 * and `ARS` is perfectly recognisable to anyone playing this.
 */
function TeamMark({ team }: { team: Team }) {
  if (team.badgeUrl) {
    return (
      <img
        className="pick__badge"
        src={team.badgeUrl}
        alt=""
        aria-hidden="true"
        loading="lazy"
        width={26}
        height={26}
      />
    );
  }
  return (
    <span className="pick__code" aria-hidden="true">
      {team.code}
    </span>
  );
}
