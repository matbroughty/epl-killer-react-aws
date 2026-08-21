import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  completeNewPassword,
  completePasswordReset,
  requestPasswordReset,
  startSignIn,
  useAuth,
} from '@/lib/auth';

/**
 * Sign in.
 *
 * Three states, because Cognito's admin-created accounts need all three: the
 * ordinary password form, the forced first-password change, and a reset. There
 * is no "create account" — sign-up is closed, and players arrive by
 * administrator invitation.
 */
type Stage = 'SIGN_IN' | 'NEW_PASSWORD' | 'RESET_REQUEST' | 'RESET_CONFIRM';

export function LoginPage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const [stage, setStage] = useState<Stage>('SIGN_IN');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    await refresh();
    navigate('/', { replace: true });
  };

  const onSignIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const outcome = await startSignIn(email, password);
    setBusy(false);

    if (outcome.kind === 'DONE') await finish();
    else if (outcome.kind === 'NEW_PASSWORD_REQUIRED') {
      setStage('NEW_PASSWORD');
      setInfo('Choose a password to replace the temporary one.');
    } else setError(outcome.message);
  };

  const onNewPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const outcome = await completeNewPassword(newPassword);
    setBusy(false);

    if (outcome.kind === 'DONE') await finish();
    else if (outcome.kind === 'ERROR') setError(outcome.message);
  };

  const onResetRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await requestPasswordReset(email);
    setBusy(false);

    if (result.ok) {
      setStage('RESET_CONFIRM');
      setInfo(result.message);
    } else setError(result.message);
  };

  const onResetConfirm = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await completePasswordReset(email, code, newPassword);
    setBusy(false);

    if (result.ok) {
      setStage('SIGN_IN');
      setPassword('');
      setNewPassword('');
      setCode('');
      setInfo(result.message);
    } else setError(result.message);
  };

  return (
    <div className="auth">
      <div className="card">
        <h1 className="card__title">
          {stage === 'SIGN_IN' && 'Sign in'}
          {stage === 'NEW_PASSWORD' && 'Set your password'}
          {stage === 'RESET_REQUEST' && 'Forgotten password'}
          {stage === 'RESET_CONFIRM' && 'Enter your code'}
        </h1>

        {error && (
          <div className="notice notice--error" role="alert">
            {error}
          </div>
        )}
        {info && !error && (
          <div className="notice notice--info" role="status">
            {info}
          </div>
        )}

        {stage === 'SIGN_IN' && (
          <form onSubmit={onSignIn}>
            <div className="field">
              <label className="field__label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                className="input"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="faint center" style={{ marginTop: 14 }}>
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  setStage('RESET_REQUEST');
                  setError(null);
                  setInfo(null);
                }}
              >
                Forgotten password
              </button>
            </p>
          </form>
        )}

        {stage === 'NEW_PASSWORD' && (
          <form onSubmit={onNewPassword}>
            <div className="field">
              <label className="field__label" htmlFor="new-password">
                New password
              </label>
              <input
                id="new-password"
                className="input"
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
              <div className="field__hint">At least 10 characters, including a number.</div>
            </div>
            <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
              {busy ? 'Saving…' : 'Save and sign in'}
            </button>
          </form>
        )}

        {stage === 'RESET_REQUEST' && (
          <form onSubmit={onResetRequest}>
            <div className="field">
              <label className="field__label" htmlFor="reset-email">
                Email
              </label>
              <input
                id="reset-email"
                className="input"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
              {busy ? 'Sending…' : 'Send reset code'}
            </button>
            <p className="faint center" style={{ marginTop: 14 }}>
              <button type="button" className="btn btn--small" onClick={() => setStage('SIGN_IN')}>
                Back to sign in
              </button>
            </p>
          </form>
        )}

        {stage === 'RESET_CONFIRM' && (
          <form onSubmit={onResetConfirm}>
            <div className="field">
              <label className="field__label" htmlFor="code">
                Reset code
              </label>
              <input
                id="code"
                className="input"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="reset-password">
                New password
              </label>
              <input
                id="reset-password"
                className="input"
                type="password"
                autoComplete="new-password"
                required
                minLength={10}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </div>
            <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
              {busy ? 'Saving…' : 'Change password'}
            </button>
          </form>
        )}
      </div>

      <p className="faint center">
        There is no public sign-up. Ask an administrator to add you.
      </p>
    </div>
  );
}
