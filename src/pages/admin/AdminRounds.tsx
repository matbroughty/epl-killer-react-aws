import { useCallback, useEffect, useState } from 'react';
import { computePot, DEFAULT_ENTRY_FEE_PENCE, formatPence, parsePoundsToPence } from '@shared/domain/money';
import {
  adminMutations,
  adminReads,
  createRound,
  createSeason,
  setActiveSeason,
  updateRound,
} from '@/lib/adminApi';
import { Feedback, useAction } from './AdminPage';

/**
 * Seasons, Killer Rounds, entrants and money.
 *
 * The pot is shown as three separate numbers — expected, collected, outstanding
 * — because conflating them is exactly the mistake the brief warns against. A
 * player owes their fee the moment they enter, whether or not it has arrived.
 */
type Season = Awaited<ReturnType<typeof adminReads.seasons>>[number];
type Round = Awaited<ReturnType<typeof adminReads.rounds>>[number];
type Player = Awaited<ReturnType<typeof adminReads.players>>[number];
type Entry = Awaited<ReturnType<typeof adminReads.entries>>[number];

export function AdminRounds() {
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [selectedRoundId, setSelectedRoundId] = useState<string>('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const { busy, error, message, run } = useAction();

  const load = useCallback(async () => {
    const [loadedSeasons, loadedRounds, loadedPlayers] = await Promise.all([
      adminReads.seasons(),
      adminReads.rounds(),
      adminReads.players(),
    ]);
    setSeasons(loadedSeasons.sort((a, b) => b.startYear - a.startYear));
    setRounds(loadedRounds.sort((a, b) => b.number - a.number));
    setPlayers(loadedPlayers.filter((player) => player.active));
    return loadedRounds;
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadEntries = useCallback(async (roundId: string) => {
    setEntries(roundId ? await adminReads.entries(roundId) : []);
  }, []);

  useEffect(() => {
    void loadEntries(selectedRoundId);
  }, [selectedRoundId, loadEntries]);

  const refresh = async () => {
    await load();
    if (selectedRoundId) await loadEntries(selectedRoundId);
  };

  const selectedRound = rounds.find((round) => round.id === selectedRoundId) ?? null;

  return (
    <>
      <Feedback error={error} message={message} />

      <SeasonSection seasons={seasons} busy={busy} run={run} reload={load} />

      <CreateRoundSection
        seasons={seasons}
        rounds={rounds}
        busy={busy}
        run={run}
        reload={refresh}
      />

      <section className="card">
        <h2 className="card__title">Killer Rounds</h2>
        <div className="rows">
          {rounds.map((round) => (
            <div className="row" key={round.id}>
              <div className="row__main">
                <div className="row__name">
                  Round {round.number}{' '}
                  <span
                    className={`pill ${
                      round.status === 'ACTIVE'
                        ? 'pill--alive'
                        : round.status === 'WON'
                          ? 'pill--winner'
                          : round.status === 'ROLLOVER'
                            ? 'pill--pending'
                            : 'pill--neutral'
                    }`}
                  >
                    {round.status}
                  </span>
                  {round.dataSource === 'LEGACY_CSV' && (
                    <span className="pill pill--neutral">Archive</span>
                  )}
                </div>
                <div className="row__meta">
                  Entry {formatPence(round.entryFeePence)}
                  {(round.rolloverInPence ?? 0) > 0 &&
                    ` · rollover in ${formatPence(round.rolloverInPence)}`}
                  {(round.rolloverOutPence ?? 0) > 0 &&
                    ` · rolled out ${formatPence(round.rolloverOutPence)}`}
                  {round.previousRoundId && ' · carried from a previous round'}
                </div>
              </div>
              <div className="row__actions">
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => setSelectedRoundId(round.id === selectedRoundId ? '' : round.id)}
                >
                  {round.id === selectedRoundId ? 'Hide' : 'Manage'}
                </button>
                {round.status === 'DRAFT' && (
                  <button
                    type="button"
                    className="btn btn--small btn--primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await adminMutations.startRound(round.id);
                        return `Round ${round.number} started with ${String(result['entrants'])} entrant(s); rollover in ${formatPence(Number(result['rolloverInPence'] ?? 0))}.`;
                      }, refresh)
                    }
                  >
                    Start
                  </button>
                )}
              </div>
            </div>
          ))}
          {rounds.length === 0 && <div className="empty">No Killer Rounds yet.</div>}
        </div>
      </section>

      {selectedRound && (
        <RoundDetail
          round={selectedRound}
          entries={entries}
          players={players}
          busy={busy}
          run={run}
          reload={refresh}
        />
      )}
    </>
  );
}

// --------------------------------------------------------------------- seasons

function SeasonSection({
  seasons,
  busy,
  run,
  reload,
}: {
  seasons: Season[];
  busy: boolean;
  run: ReturnType<typeof useAction>['run'];
  reload: () => Promise<unknown>;
}) {
  const [startYear, setStartYear] = useState(String(new Date().getUTCFullYear()));

  return (
    <section className="card">
      <h2 className="card__title">Seasons</h2>
      <div className="rows" style={{ marginBottom: 12 }}>
        {seasons.map((season) => (
          <div className="row" key={season.id}>
            <div className="row__main">
              <div className="row__name">
                {season.name}{' '}
                {season.active && <span className="pill pill--alive">Active</span>}
                {season.isLegacy && (
                  <span
                    className="pill pill--neutral"
                    title="Holds teams imported from the historical spreadsheet"
                  >
                    Legacy
                  </span>
                )}
              </div>
              <div className="row__meta">
                {season.providerCompetitionCode ?? '—'}
                {season.currentMatchday ? ` · currently GW${season.currentMatchday}` : ''}
              </div>
            </div>
            {!season.active && !season.isLegacy && (
              <button
                type="button"
                className="btn btn--small"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await setActiveSeason(season.id, seasons);
                    return `${season.name} is now the active season.`;
                  }, reload)
                }
              >
                Make active
              </button>
            )}
          </div>
        ))}
        {seasons.length === 0 && <div className="empty">No seasons yet. Create one below.</div>}
      </div>

      <div className="spread">
        <div className="field" style={{ flex: 1, marginBottom: 0, minWidth: 140 }}>
          <label className="field__label" htmlFor="season-year">
            Season start year
          </label>
          <input
            id="season-year"
            className="input"
            inputMode="numeric"
            value={startYear}
            onChange={(event) => setStartYear(event.target.value)}
          />
          <div className="field__hint">
            2026 creates “2026/27”. This is the value football-data.org expects as `season`.
          </div>
        </div>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const year = Number(startYear);
              if (!Number.isInteger(year) || year < 1990 || year > 2100) {
                throw new Error('Enter a four-digit season start year.');
              }
              await createSeason({
                name: `${year}/${String((year + 1) % 100).padStart(2, '0')}`,
                startYear: year,
                // The first season created becomes active automatically.
                active: seasons.filter((season) => !season.isLegacy).length === 0,
              });
              return `Season ${year} created. Sync teams next.`;
            }, reload)
          }
        >
          Create season
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- create round

function CreateRoundSection({
  seasons,
  rounds,
  busy,
  run,
  reload,
}: {
  seasons: Season[];
  rounds: Round[];
  busy: boolean;
  run: ReturnType<typeof useAction>['run'];
  reload: () => Promise<unknown>;
}) {
  const activeSeason = seasons.find((season) => season.active);
  const [seasonId, setSeasonId] = useState(activeSeason?.id ?? '');
  const [fee, setFee] = useState('5');
  const [rollover, setRollover] = useState('0');
  const [previousRoundId, setPreviousRoundId] = useState('');

  useEffect(() => {
    if (activeSeason && !seasonId) setSeasonId(activeSeason.id);
  }, [activeSeason, seasonId]);

  // Offer the rolled-over rounds as a source, since that is the only case where
  // money carries forward.
  const rolloverSources = rounds.filter((round) => round.status === 'ROLLOVER');
  const nextNumber =
    rounds.filter((round) => round.dataSource !== 'LEGACY_CSV').reduce(
      (highest, round) => Math.max(highest, round.number),
      0,
    ) + 1;

  return (
    <section className="card">
      <h2 className="card__title">Create a Killer Round</h2>
      <div className="field">
        <label className="field__label" htmlFor="round-season">
          Season
        </label>
        <select
          id="round-season"
          className="select"
          value={seasonId}
          onChange={(event) => setSeasonId(event.target.value)}
        >
          <option value="">Choose a season…</option>
          {seasons
            .filter((season) => !season.isLegacy)
            .map((season) => (
              <option key={season.id} value={season.id}>
                {season.name}
              </option>
            ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="round-fee">
          Entry fee (£)
        </label>
        <input
          id="round-fee"
          className="input"
          inputMode="decimal"
          value={fee}
          onChange={(event) => setFee(event.target.value)}
        />
        <div className="field__hint">
          Default {formatPence(DEFAULT_ENTRY_FEE_PENCE)}. Stored in pence, and snapshotted onto
          each entry when the round starts.
        </div>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="round-previous">
          Rolled over from
        </label>
        <select
          id="round-previous"
          className="select"
          value={previousRoundId}
          onChange={(event) => setPreviousRoundId(event.target.value)}
        >
          <option value="">Nothing carried forward</option>
          {rolloverSources.map((round) => (
            <option key={round.id} value={round.id}>
              Round {round.number} — {formatPence(round.rolloverOutPence ?? 0)}
            </option>
          ))}
        </select>
        <div className="field__hint">
          Linking the source round makes the money trail explicit. The amount is carried across
          automatically when you start this round.
        </div>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="round-rollover">
          Rollover override (£)
        </label>
        <input
          id="round-rollover"
          className="input"
          inputMode="decimal"
          value={rollover}
          onChange={(event) => setRollover(event.target.value)}
        />
        <div className="field__hint">
          Leave at 0 to use the linked round's amount. Set a value only to correct it by hand.
        </div>
      </div>
      <button
        type="button"
        className="btn btn--primary"
        disabled={busy || !seasonId}
        onClick={() =>
          void run(async () => {
            await createRound({
              seasonId,
              number: nextNumber,
              entryFeePence: parsePoundsToPence(fee),
              rolloverInPence: parsePoundsToPence(rollover),
              previousRoundId: previousRoundId || null,
            });
            return `Killer Round ${nextNumber} created as a draft. Add Round Weeks, then start it.`;
          }, reload)
        }
      >
        Create Round {nextNumber}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------- round detail

function RoundDetail({
  round,
  entries,
  players,
  busy,
  run,
  reload,
}: {
  round: Round;
  entries: Entry[];
  players: Player[];
  busy: boolean;
  run: ReturnType<typeof useAction>['run'];
  reload: () => Promise<void>;
}) {
  const [winnerPlayerId, setWinnerPlayerId] = useState('');
  const [note, setNote] = useState('');
  const [feeEdit, setFeeEdit] = useState(String((round.entryFeePence ?? 500) / 100));
  const [rolloverEdit, setRolloverEdit] = useState(
    String((round.rolloverInPence ?? 0) / 100),
  );

  const playersById = new Map(players.map((player) => [player.id, player]));
  const pot = computePot(
    { rolloverInPence: round.rolloverInPence ?? 0 },
    entries.map((entry) => ({
      paid: entry.paid,
      entryFeePence: entry.entryFeePence ?? round.entryFeePence,
    })),
  );

  return (
    <>
      <section className="card">
        <h2 className="card__title">Round {round.number} — money</h2>
        <div className="rows">
          <div className="row">
            <span>Entrants</span>
            <b>{pot.entrantCount}</b>
          </div>
          <div className="row">
            <span>Expected from entries</span>
            <b>{formatPence(pot.expectedEntriesPence)}</b>
          </div>
          <div className="row">
            <span>Marked as collected</span>
            <b>
              {formatPence(pot.collectedPence)} ({pot.paidCount}/{pot.entrantCount})
            </b>
          </div>
          <div className="row">
            <span>Outstanding</span>
            <b className={pot.outstandingPence > 0 ? 'cell-pending' : ''}>
              {formatPence(pot.outstandingPence)}
            </b>
          </div>
          <div className="row">
            <span>Rollover carried in</span>
            <b>{formatPence(pot.rolloverInPence)}</b>
          </div>
          <div className="row">
            <span>
              <b>Total prize pot</b>
            </span>
            <b className="cell-survived">{formatPence(pot.totalPotPence)}</b>
          </div>
        </div>

        {round.status === 'DRAFT' && (
          <div style={{ marginTop: 14 }}>
            <div className="spread" style={{ alignItems: 'flex-end' }}>
              <div className="field" style={{ flex: 1, marginBottom: 0, minWidth: 120 }}>
                <label className="field__label" htmlFor="edit-fee">
                  Entry fee (£)
                </label>
                <input
                  id="edit-fee"
                  className="input"
                  inputMode="decimal"
                  value={feeEdit}
                  onChange={(event) => setFeeEdit(event.target.value)}
                />
              </div>
              <div className="field" style={{ flex: 1, marginBottom: 0, minWidth: 120 }}>
                <label className="field__label" htmlFor="edit-rollover">
                  Rollover in (£)
                </label>
                <input
                  id="edit-rollover"
                  className="input"
                  inputMode="decimal"
                  value={rolloverEdit}
                  onChange={(event) => setRolloverEdit(event.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await updateRound({
                      id: round.id,
                      entryFeePence: parsePoundsToPence(feeEdit),
                      rolloverInPence: parsePoundsToPence(rolloverEdit),
                    });
                    return 'Round updated.';
                  }, reload)
                }
              >
                Save
              </button>
            </div>
            <p className="field__hint">
              Only editable while the round is a draft — once it starts, each entry holds its own
              fee so history cannot be rewritten.
            </p>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card__title">
          Entrants ({entries.length} of {players.length} active players)
        </h2>

        {entries.length === 0 && (
          <div className="notice notice--warn">
            Nobody is entered. Starting a round enters every active player automatically, but
            players added <em>afterwards</em> need entering here.
          </div>
        )}

        <p className="faint">
          Every active player is listed. Toggle anyone in or out — it works before or after the
          round has started, so a late arrival is no problem. Somebody who has already made a
          selection cannot be removed, because that would orphan their history; leave them in
          instead, since an eliminated entrant does not affect who wins.
        </p>

        <div className="rows">
          {players.map((player) => {
            const entry = entries.find((candidate) => candidate.playerId === player.id);
            return (
              <div className="row" key={player.id}>
                <div className="row__main">
                  <div className="row__name">
                    {player.displayName}{' '}
                    {entry ? (
                      <span
                        className={`pill ${
                          entry.status === 'WINNER'
                            ? 'pill--winner'
                            : entry.status === 'ALIVE'
                              ? 'pill--alive'
                              : 'pill--out'
                        }`}
                      >
                        {entry.status}
                      </span>
                    ) : (
                      <span className="pill pill--neutral">Not entered</span>
                    )}
                  </div>
                  <div className="row__meta">
                    {entry
                      ? `${formatPence(entry.entryFeePence ?? round.entryFeePence)} · ${
                          entry.paid
                            ? `paid${entry.paidBy ? ` (${entry.paidBy})` : ''}`
                            : 'not paid'
                        }`
                      : 'owes nothing — not in this round'}
                  </div>
                </div>
                <div className="row__actions">
                  {entry && (
                    <button
                      type="button"
                      className={`btn btn--small ${entry.paid ? '' : 'btn--primary'}`}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await adminMutations.setPaid(entry.id, !entry.paid);
                          return 'Payment status updated.';
                        }, reload)
                      }
                    >
                      {entry.paid ? 'Mark unpaid' : 'Mark paid'}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`btn btn--small ${entry ? 'btn--danger' : 'btn--primary'}`}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await adminMutations.setEntrant(
                          round.id,
                          player.id,
                          !entry,
                        );
                        return String(result['message'] ?? 'Entrants updated.');
                      }, reload)
                    }
                  >
                    {entry ? 'Remove' : 'Enter'}
                  </button>
                </div>
              </div>
            );
          })}
          {players.length === 0 && (
            <div className="empty">
              No active players. Add them on the Players tab first.
            </div>
          )}
        </div>

        {players.length > 0 && entries.length < players.length && (
          <button
            type="button"
            className="btn btn--primary"
            style={{ marginTop: 12 }}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                // The usual case: the same group plays every round.
                const missing = players.filter(
                  (player) => !entries.some((entry) => entry.playerId === player.id),
                );
                for (const player of missing) {
                  await adminMutations.setEntrant(round.id, player.id, true);
                }
                return `Entered ${missing.length} player(s).`;
              }, reload)
            }
          >
            Enter all {players.length - entries.length} remaining active players
          </button>
        )}
      </section>

      {round.status === 'ACTIVE' && (
        <section className="card">
          <h2 className="card__title">Settle Round {round.number} by hand</h2>
          <p className="faint">
            Normally results processing settles a round automatically. Use this when the season
            ends without an outright winner, or when the provider cannot resolve a fixture.
          </p>
          <div className="field">
            <label className="field__label" htmlFor="winner">
              Winner
            </label>
            <select
              id="winner"
              className="select"
              value={winnerPlayerId}
              onChange={(event) => setWinnerPlayerId(event.target.value)}
            >
              <option value="">Choose a player…</option>
              {entries.map((entry) => (
                <option key={entry.id} value={entry.playerId}>
                  {playersById.get(entry.playerId)?.displayName ?? entry.playerId}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="settle-note">
              Reason (recorded in the audit log)
            </label>
            <input
              id="settle-note"
              className="input"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <div className="row__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || !winnerPlayerId}
              onClick={() =>
                void run(async () => {
                  await adminMutations.completeRound({
                    killerRoundId: round.id,
                    resolution: 'WON',
                    winnerPlayerId,
                    note: note || null,
                  });
                  return 'Winner declared.';
                }, reload)
              }
            >
              Declare winner
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await adminMutations.completeRound({
                    killerRoundId: round.id,
                    resolution: 'ROLLOVER',
                    note: note || null,
                  });
                  return `Round marked as rollover; ${formatPence(Number(result['rolloverOutPence'] ?? 0))} carries forward.`;
                }, reload)
              }
            >
              Declare rollover
            </button>
          </div>
        </section>
      )}
    </>
  );
}
