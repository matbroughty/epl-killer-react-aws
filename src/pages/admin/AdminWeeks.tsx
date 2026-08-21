import { useCallback, useEffect, useMemo, useState } from 'react';
import { proposeDeadline } from '@shared/domain/deadlines';
import { formatDateTime, formatMatchday } from '@shared/domain/format';
import { adminMutations, adminReads, updateWeekDeadline } from '@/lib/adminApi';
import { Feedback, useAction } from './AdminPage';

/**
 * Round Weeks: choose the gameweek, set the deadline, lock, inspect, override.
 *
 * The gameweeks that make up a Killer Round do not have to be consecutive, so
 * this screen offers every matchday that has fixtures and lets the administrator
 * pick. The deadline defaults to the first kick-off of that gameweek — computed
 * with the same `proposeDeadline` the backend uses, so the preview here cannot
 * disagree with what gets saved.
 */
type Round = Awaited<ReturnType<typeof adminReads.rounds>>[number];
type Week = Awaited<ReturnType<typeof adminReads.weeks>>[number];
type Entry = Awaited<ReturnType<typeof adminReads.entries>>[number];
type Selection = Awaited<ReturnType<typeof adminReads.selections>>[number];
type Fixture = Awaited<ReturnType<typeof adminReads.fixtures>>[number];
type Team = Awaited<ReturnType<typeof adminReads.teams>>[number];
type Player = Awaited<ReturnType<typeof adminReads.players>>[number];

export function AdminWeeks() {
  const [rounds, setRounds] = useState<Round[]>([]);
  const [roundId, setRoundId] = useState('');
  const [weeks, setWeeks] = useState<Week[]>([]);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [openWeekId, setOpenWeekId] = useState('');
  const [selections, setSelections] = useState<Selection[]>([]);
  const [matchday, setMatchday] = useState('');
  const [deadlineOverride, setDeadlineOverride] = useState('');
  const { busy, error, message, run } = useAction();

  const round = rounds.find((candidate) => candidate.id === roundId) ?? null;

  useEffect(() => {
    void adminReads.rounds().then((loaded) => {
      const live = loaded
        .filter((candidate) => candidate.dataSource !== 'LEGACY_CSV')
        .sort((a, b) => b.number - a.number);
      setRounds(live);
      const active = live.find((candidate) => candidate.status === 'ACTIVE') ?? live[0];
      if (active) setRoundId(active.id);
    });
    void adminReads.players().then(setPlayers);
  }, []);

  const loadRound = useCallback(async (id: string, seasonId: string) => {
    const [loadedWeeks, loadedFixtures, loadedTeams, loadedEntries] = await Promise.all([
      adminReads.weeks(id),
      adminReads.fixtures(seasonId),
      adminReads.teams(seasonId),
      adminReads.entries(id),
    ]);
    setWeeks(loadedWeeks.sort((a, b) => a.sequenceNumber - b.sequenceNumber));
    setFixtures(loadedFixtures);
    setTeams(loadedTeams.sort((a, b) => a.name.localeCompare(b.name, 'en-GB')));
    setEntries(loadedEntries);
  }, []);

  useEffect(() => {
    if (round) void loadRound(round.id, round.seasonId);
  }, [round, loadRound]);

  const reload = async () => {
    if (round) await loadRound(round.id, round.seasonId);
    if (openWeekId) setSelections(await adminReads.selections(openWeekId));
  };

  useEffect(() => {
    if (openWeekId) void adminReads.selections(openWeekId).then(setSelections);
    else setSelections([]);
  }, [openWeekId]);

  /** Matchdays that have fixtures and are not already in this round. */
  const availableMatchdays = useMemo(() => {
    const used = new Set(weeks.map((week) => week.matchday));
    const all = new Set(
      fixtures.filter((fixture) => fixture.matchday > 0).map((fixture) => fixture.matchday),
    );
    return [...all].filter((day) => !used.has(day)).sort((a, b) => a - b);
  }, [fixtures, weeks]);

  const matchdayFixtures = matchday
    ? fixtures.filter((fixture) => fixture.matchday === Number(matchday))
    : [];

  const proposed = proposeDeadline(
    matchdayFixtures.map((fixture) => ({
      utcKickoff: fixture.utcKickoff,
      status: (fixture.status ?? 'UNKNOWN') as 'SCHEDULED',
    })),
  );

  return (
    <>
      <Feedback error={error} message={message} />

      <section className="card">
        <h2 className="card__title">Killer Round</h2>
        <select
          className="select"
          value={roundId}
          onChange={(event) => {
            setRoundId(event.target.value);
            setOpenWeekId('');
          }}
        >
          <option value="">Choose a round…</option>
          {rounds.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              Round {candidate.number} ({candidate.status})
            </option>
          ))}
        </select>
      </section>

      {round && (
        <>
          <section className="card">
            <h2 className="card__title">Add a Round Week</h2>
            {availableMatchdays.length === 0 ? (
              <p className="notice notice--warn">
                No gameweeks with imported fixtures are available. Sync fixtures on the football
                data tab first.
              </p>
            ) : (
              <>
                <div className="field">
                  <label className="field__label" htmlFor="matchday">
                    Premier League gameweek
                  </label>
                  <select
                    id="matchday"
                    className="select"
                    value={matchday}
                    onChange={(event) => {
                      setMatchday(event.target.value);
                      setDeadlineOverride('');
                    }}
                  >
                    <option value="">Choose a gameweek…</option>
                    {availableMatchdays.map((day) => (
                      <option key={day} value={day}>
                        GW{day}
                      </option>
                    ))}
                  </select>
                  <div className="field__hint">
                    Gameweeks do not have to be consecutive.
                  </div>
                </div>

                {matchday && (
                  <>
                    <div className="notice notice--info">
                      Proposed deadline (first fixture): <b>{formatDateTime(proposed)}</b>
                      <br />
                      {matchdayFixtures.length} fixture(s) imported for GW{matchday}.
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor="deadline-override">
                        Override deadline (optional)
                      </label>
                      <input
                        id="deadline-override"
                        className="input"
                        type="datetime-local"
                        value={deadlineOverride}
                        onChange={(event) => setDeadlineOverride(event.target.value)}
                      />
                      <div className="field__hint">
                        Entered in your local time and stored as UTC. Leave blank to use the
                        first kick-off.
                      </div>
                    </div>

                    <details style={{ marginBottom: 12 }}>
                      <summary className="muted">Fixtures for GW{matchday}</summary>
                      <div className="rows" style={{ marginTop: 8 }}>
                        {matchdayFixtures
                          .slice()
                          .sort((a, b) => a.utcKickoff.localeCompare(b.utcKickoff))
                          .map((fixture) => (
                            <div className="row" key={fixture.id}>
                              <div className="row__main">
                                <div className="row__name">
                                  {teamName(teams, fixture.homeTeamId)} v{' '}
                                  {teamName(teams, fixture.awayTeamId)}
                                </div>
                                <div className="row__meta">
                                  {formatDateTime(fixture.utcKickoff)} · {fixture.status}
                                  {fixture.homeGoals !== null &&
                                    fixture.awayGoals !== null &&
                                    ` · ${fixture.homeGoals}–${fixture.awayGoals}`}
                                </div>
                              </div>
                            </div>
                          ))}
                      </div>
                    </details>

                    <div className="row__actions">
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const result = await adminMutations.createRoundWeek({
                              killerRoundId: round.id,
                              matchday: Number(matchday),
                              deadline: deadlineOverride
                                ? new Date(deadlineOverride).toISOString()
                                : null,
                              open: true,
                            });
                            setMatchday('');
                            setDeadlineOverride('');
                            return `Round Week added for GW${matchday}, open, deadline ${formatDateTime(String(result['deadline']))} (${String(result['deadlineSource'])}).`;
                          }, reload)
                        }
                      >
                        Add and open
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await adminMutations.createRoundWeek({
                              killerRoundId: round.id,
                              matchday: Number(matchday),
                              deadline: deadlineOverride
                                ? new Date(deadlineOverride).toISOString()
                                : null,
                              open: false,
                            });
                            setMatchday('');
                            return `Round Week added for GW${matchday} as a draft.`;
                          }, reload)
                        }
                      >
                        Add as draft
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </section>

          <section className="card">
            <h2 className="card__title">Round Weeks</h2>
            <div className="rows">
              {weeks.map((week) => (
                <div className="row" key={week.id}>
                  <div className="row__main">
                    <div className="row__name">
                      Week {week.sequenceNumber} · {formatMatchday(week.matchday)}{' '}
                      <span className="pill pill--neutral">{week.status}</span>
                    </div>
                    <div className="row__meta">
                      Deadline {formatDateTime(week.deadline)}
                      {week.deadlineSource === 'MANUAL' && ' (overridden)'}
                      {week.standingsSnapshotId && ' · table captured'}
                    </div>
                  </div>
                  <div className="row__actions">
                    <button
                      type="button"
                      className="btn btn--small"
                      onClick={() => setOpenWeekId(openWeekId === week.id ? '' : week.id)}
                    >
                      {openWeekId === week.id ? 'Hide' : 'Selections'}
                    </button>
                    {week.status === 'DRAFT' && (
                      <button
                        type="button"
                        className="btn btn--small btn--primary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await adminMutations.setWeekStatus(week.id, 'OPEN');
                            return 'Week opened.';
                          }, reload)
                        }
                      >
                        Open
                      </button>
                    )}
                    {week.status === 'OPEN' && (
                      <button
                        type="button"
                        className="btn btn--small"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const result = await adminMutations.processDeadlines(week.id);
                            const first = (result['results'] as Record<string, unknown>[])?.[0];
                            return `Processed: locked=${String(first?.['locked'])}, auto-assigned=${String(first?.['autoAssigned'])}, unassigned=${String(first?.['autoUnassigned'])}.`;
                          }, reload)
                        }
                      >
                        Lock &amp; auto-pick
                      </button>
                    )}
                    {(week.status === 'LOCKED' || week.status === 'RESULTS_PENDING' || week.status === 'COMPLETE') && (
                      <button
                        type="button"
                        className="btn btn--small"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const result = await adminMutations.processResults(week.id);
                            const first = (result['results'] as Record<string, unknown>[])?.[0];
                            return `Processed: updated=${String(first?.['selectionsUpdated'])}, eliminated=${String(first?.['eliminated'])}, pending=${String(first?.['pendingCount'])}, outcome=${String(first?.['outcome'] ?? 'none')}.`;
                          }, reload)
                        }
                      >
                        Process results
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {weeks.length === 0 && <div className="empty">No Round Weeks yet.</div>}
            </div>
          </section>

          {openWeekId && (
            <WeekSelections
              week={weeks.find((week) => week.id === openWeekId)!}
              entries={entries}
              players={players}
              selections={selections}
              teams={teams}
              busy={busy}
              run={run}
              reload={reload}
              onDeadlineSaved={reload}
            />
          )}
        </>
      )}
    </>
  );
}

function teamName(teams: Team[], teamId: string | null | undefined): string {
  if (!teamId) return '—';
  return teams.find((team) => team.id === teamId)?.shortName ?? teamId;
}

/**
 * Selections for one week, with a manual override per player.
 *
 * Administrators see picks before the deadline, which is the one exception to
 * the privacy rule and is enforced server-side in `redactSelections`.
 */
function WeekSelections({
  week,
  entries,
  players,
  selections,
  teams,
  busy,
  run,
  reload,
  onDeadlineSaved,
}: {
  week: Week;
  entries: Entry[];
  players: Player[];
  selections: Selection[];
  teams: Team[];
  busy: boolean;
  run: ReturnType<typeof useAction>['run'];
  reload: () => Promise<void>;
  onDeadlineSaved: () => Promise<void>;
}) {
  const [newDeadline, setNewDeadline] = useState('');
  const playersById = new Map(players.map((player) => [player.id, player]));
  const byEntry = new Map(selections.map((selection) => [selection.roundEntryId, selection]));

  return (
    <>
      <section className="card">
        <h2 className="card__title">
          Week {week.sequenceNumber} · {formatMatchday(week.matchday)} — selections
        </h2>

        <div className="spread" style={{ alignItems: 'flex-end', marginBottom: 14 }}>
          <div className="field" style={{ flex: 1, marginBottom: 0, minWidth: 200 }}>
            <label className="field__label" htmlFor="new-deadline">
              Change deadline
            </label>
            <input
              id="new-deadline"
              className="input"
              type="datetime-local"
              value={newDeadline}
              onChange={(event) => setNewDeadline(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn"
            disabled={busy || !newDeadline}
            onClick={() =>
              void run(async () => {
                await updateWeekDeadline(week.id, new Date(newDeadline).toISOString());
                setNewDeadline('');
                return 'Deadline updated.';
              }, onDeadlineSaved)
            }
          >
            Save
          </button>
        </div>

        <div className="notice notice--info">
          <strong>Entering picks received by message.</strong> Choose a team next to each player and
          it saves immediately. Team reuse and elimination are still enforced, exactly as they
          would be for the player's own pick — and unlike an override, these resolve normally when
          results come in.
        </div>

        <div className="rows">
          {entries.map((entry) => (
            <EnterPickRow
              key={entry.id}
              entry={entry}
              displayName={playersById.get(entry.playerId)?.displayName ?? entry.playerId}
              selection={byEntry.get(entry.id)}
              allSelections={selections}
              week={week}
              teams={teams}
              busy={busy}
              run={run}
              reload={reload}
            />
          ))}
          {entries.length === 0 && (
            <div className="empty">
              No entrants. Add them under Rounds → Manage before entering picks.
            </div>
          )}
        </div>
      </section>
    </>
  );
}

/**
 * One player's row: a team dropdown for entering their pick, plus an override
 * panel for correcting an outcome.
 *
 * The two are deliberately separate controls, because they mean different
 * things. Choosing a team records a pick that results processing will resolve
 * like any other. Setting an outcome is an override, and results processing
 * will never touch it again.
 */
function EnterPickRow({
  entry,
  displayName,
  selection,
  allSelections,
  week,
  teams,
  busy,
  run,
  reload,
}: {
  entry: Entry;
  displayName: string;
  selection: Selection | undefined;
  allSelections: Selection[];
  week: Week;
  teams: Team[];
  busy: boolean;
  run: ReturnType<typeof useAction>['run'];
  reload: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [teamId, setTeamId] = useState(selection?.teamId ?? '');
  const [outcome, setOutcome] = useState<string>(selection?.outcome ?? 'PENDING');
  const [note, setNote] = useState('');

  // Teams this player has already used earlier in the round, so the dropdown
  // shows them struck out rather than letting an admin pick an invalid team and
  // then reporting a rejection.
  const usedByThisPlayer = new Set(
    allSelections
      .filter((s) => s.roundEntryId === entry.id && s.roundWeekId !== week.id && s.teamId)
      .map((s) => s.teamId as string),
  );

  const eliminated = entry.status === 'ELIMINATED';

  return (
    <>
      <div className="row">
        <div className="row__main">
          <div className="row__name">
            {displayName}{' '}
            {eliminated && <span className="pill pill--out">OUT</span>}
            {selection?.selectionType === 'ADMIN' && (
              <span className="pill pill--neutral" title="Entered by an administrator">
                entered
              </span>
            )}
            {selection?.selectionType === 'AUTO_LOWEST_POSITION' && (
              <span className="pill pill--pending">auto</span>
            )}
            {selection?.overridden && <span className="pill pill--pending">overridden</span>}
          </div>
          <div className="row__meta">
            {selection
              ? `${selection.teamName ?? 'no team'} · ${selection.outcome}`
              : 'no pick yet'}
          </div>
        </div>
        <div className="row__actions" style={{ alignItems: 'center' }}>
          <select
            className="select"
            style={{ minWidth: 170 }}
            value={selection?.teamId ?? ''}
            disabled={busy || eliminated}
            onChange={(event) => {
              const chosen = event.target.value;
              if (!chosen) return;
              void run(async () => {
                const result = await adminMutations.submitSelectionFor({
                  roundWeekId: week.id,
                  playerId: entry.playerId,
                  teamId: chosen,
                  // Deadline gone but the pick was sent in time: allowed, and
                  // audited as a bypass so it is never invisible.
                  allowAfterDeadline: true,
                });
                return String(result['message'] ?? 'Pick saved.');
              }, reload);
            }}
          >
            <option value="">{eliminated ? 'eliminated' : 'choose a team…'}</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id} disabled={usedByThisPlayer.has(team.id)}>
                {team.name}
                {usedByThisPlayer.has(team.id) ? ' (used)' : ''}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn--small" onClick={() => setEditing(!editing)}>
            {editing ? 'Cancel' : 'Outcome'}
          </button>
        </div>
      </div>
      {editing && (
        <OverrideRow
          entry={entry}
          displayName={displayName}
          week={week}
          teams={teams}
          busy={busy}
          run={run}
          reload={reload}
          teamId={teamId}
          setTeamId={setTeamId}
          outcome={outcome}
          setOutcome={setOutcome}
          note={note}
          setNote={setNote}
          onDone={() => setEditing(false)}
        />
      )}
    </>
  );
}

/**
 * The outcome override panel.
 *
 * Separate from entering a pick because setting an outcome marks the selection
 * `overridden`, after which result processing never touches it again. That is
 * right for "the fixture was abandoned" and wrong for "here is their pick".
 */
function OverrideRow({
  entry,
  displayName,
  week,
  teams,
  busy,
  run,
  reload,
  teamId,
  setTeamId,
  outcome,
  setOutcome,
  note,
  setNote,
  onDone,
}: {
  entry: Entry;
  displayName: string;
  week: Week;
  teams: Team[];
  busy: boolean;
  run: ReturnType<typeof useAction>['run'];
  reload: () => Promise<void>;
  teamId: string;
  setTeamId: (value: string) => void;
  outcome: string;
  setOutcome: (value: string) => void;
  note: string;
  setNote: (value: string) => void;
  onDone: () => void;
}) {
  return (
    <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className="notice notice--warn" style={{ marginBottom: 12 }}>
        Overriding the outcome for <strong>{displayName}</strong> stops results processing from
        ever recalculating it. Use this when the football data is wrong or a fixture was
        abandoned — not to record a pick.
      </div>

      <div className="field">
        <label className="field__label">Team (optional)</label>
        <select
          className="select"
          value={teamId}
          onChange={(event) => setTeamId(event.target.value)}
        >
          <option value="">Leave unchanged</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label">Outcome</label>
        <select
          className="select"
          value={outcome}
          onChange={(event) => setOutcome(event.target.value)}
        >
          <option value="PENDING">PENDING</option>
          <option value="SURVIVED">SURVIVED</option>
          <option value="ELIMINATED">ELIMINATED</option>
        </select>
      </div>

      <div className="field">
        <label className="field__label">Reason (recorded in the audit log)</label>
        <input
          className="input"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="e.g. fixture abandoned at half time"
        />
      </div>

      <div className="row__actions">
        <button
          type="button"
          className="btn btn--primary btn--small"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await adminMutations.overrideSelection({
                roundWeekId: week.id,
                roundEntryId: entry.id,
                teamId: teamId || null,
                outcome,
                note: note || null,
              });
              setNote('');
              onDone();
              return `Outcome overridden for ${displayName}. Results processing will now leave it alone.`;
            }, reload)
          }
        >
          Save override
        </button>
        <button type="button" className="btn btn--small" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
