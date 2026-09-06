import { useCallback, useEffect, useState } from 'react';
import { adminMutations, adminReads, setPlayerNotify } from '@/lib/adminApi';
import { Feedback, useAction } from './AdminPage';

/**
 * Players.
 *
 * Adding a player creates the durable `Player` record and, optionally, a Cognito
 * user. The invitation happens in the Lambda with `AdminCreateUser` — nothing
 * here holds credentials that could create an account.
 *
 * Deactivation never deletes: a former player's history stays in every round
 * they played.
 */
type Player = Awaited<ReturnType<typeof adminReads.players>>[number];

export function AdminPlayers() {
  const [players, setPlayers] = useState<Player[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [sendInvite, setSendInvite] = useState(true);
  const { busy, error, message, run } = useAction();

  const load = useCallback(async () => {
    setPlayers(
      (await adminReads.players()).sort((a, b) =>
        a.displayName.localeCompare(b.displayName, 'en-GB'),
      ),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await adminMutations.invitePlayer({
        displayName,
        email,
        makeAdmin,
        sendInvite,
      });
      setDisplayName('');
      setEmail('');
      setMakeAdmin(false);
      return String(result['message'] ?? 'Player added.');
    }, load);
  };

  return (
    <>
      <Feedback error={error} message={message} />

      <section className="card">
        <h2 className="card__title">Add a player</h2>
        <form onSubmit={add}>
          <div className="field">
            <label className="field__label" htmlFor="p-name">
              Display name
            </label>
            <input
              id="p-name"
              className="input"
              required
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="p-email">
              Email
            </label>
            <input
              id="p-email"
              className="input"
              type="email"
              autoCapitalize="none"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="field">
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={sendInvite}
                onChange={(event) => setSendInvite(event.target.checked)}
              />
              <span>Send a Cognito invitation with a temporary password</span>
            </label>
            <div className="field__hint">
              Leave unticked to create a player record with no login — useful for somebody who
              pays in cash and never signs in.
            </div>
          </div>
          <div className="field">
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={makeAdmin}
                disabled={!sendInvite}
                onChange={(event) => setMakeAdmin(event.target.checked)}
              />
              <span>Administrator</span>
            </label>
          </div>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? 'Adding…' : 'Add player'}
          </button>
        </form>
      </section>

      <section className="card">
        <h2 className="card__title">Players ({players.length})</h2>
        <div className="rows">
          {players.map((player) => (
            <div className="row" key={player.id}>
              <div className="row__main">
                <div className="row__name">
                  {player.displayName}{' '}
                  {!player.active && <span className="pill pill--neutral">Inactive</span>}
                  {!player.cognitoUserId && (
                    <span className="pill pill--pending" title="No Cognito login linked yet">
                      No login
                    </span>
                  )}
                </div>
                <div className="row__meta">
                  {player.email ?? 'no email'}
                  {player.notifyByEmail === false && ' · emails muted'}
                </div>
              </div>
              <div className="row__actions">
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={busy || !player.email}
                  title={
                    player.email
                      ? 'Elimination, winner and rollover emails'
                      : 'No email address on file'
                  }
                  onClick={() =>
                    void run(async () => {
                      const next = player.notifyByEmail === false;
                      await setPlayerNotify(player.id, next);
                      return `${player.displayName} will ${next ? 'now' : 'no longer'} get result emails.`;
                    }, load)
                  }
                >
                  {player.notifyByEmail === false ? 'Unmute' : 'Mute emails'}
                </button>
                <button
                  type="button"
                  className={`btn btn--small ${player.active ? 'btn--danger' : ''}`}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      async () => {
                        await adminMutations.setPlayerActive(player.id, !player.active);
                        return `${player.displayName} ${player.active ? 'deactivated' : 'activated'}.`;
                      },
                      load,
                    )
                  }
                >
                  {player.active ? 'Deactivate' : 'Activate'}
                </button>
              </div>
            </div>
          ))}
          {players.length === 0 && <div className="empty">No players yet.</div>}
        </div>
      </section>
    </>
  );
}
