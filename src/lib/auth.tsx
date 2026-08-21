import {
  confirmResetPassword,
  confirmSignIn,
  fetchAuthSession,
  getCurrentUser,
  signIn as amplifySignIn,
  signOut as amplifySignOut,
  resetPassword,
} from 'aws-amplify/auth';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

/**
 * Authentication state.
 *
 * Hand-rolled over `aws-amplify/auth` rather than pulling in
 * `@aws-amplify/ui-react`: this is about a hundred lines, it keeps the login
 * screen looking like the rest of the site, and the only flows we need are
 * sign-in, the forced first-password change, and a reset.
 */

export interface AuthUser {
  username: string;
  email: string | null;
  isAdmin: boolean;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  refresh: async () => {},
  signOut: async () => {},
});

/** Read the session and pull the group claim out of the token. */
async function loadUser(): Promise<AuthUser | null> {
  try {
    const current = await getCurrentUser();
    const session = await fetchAuthSession();
    const payload = session.tokens?.idToken?.payload ?? {};

    const groupsClaim = payload['cognito:groups'];
    const groups = Array.isArray(groupsClaim)
      ? groupsClaim.filter((group): group is string => typeof group === 'string')
      : [];

    const email = typeof payload['email'] === 'string' ? payload['email'] : null;

    return {
      username: current.username,
      email,
      // Only ever a hint for what the UI offers. Every admin operation is
      // authorized again by AppSync against the signed token.
      isAdmin: groups.includes('ADMIN'),
    };
  } catch {
    // Not signed in. The public view is the default experience, so this is a
    // normal state rather than an error.
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setUser(await loadUser());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doSignOut = useCallback(async () => {
    await amplifySignOut();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, refresh, signOut: doSignOut }),
    [user, loading, refresh, doSignOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

// ---------------------------------------------------------------------------
// Sign-in flow
// ---------------------------------------------------------------------------

export type SignInOutcome =
  | { kind: 'DONE' }
  /** Cognito's `AdminCreateUser` temporary password must be replaced. */
  | { kind: 'NEW_PASSWORD_REQUIRED' }
  | { kind: 'ERROR'; message: string };

export async function startSignIn(email: string, password: string): Promise<SignInOutcome> {
  try {
    const result = await amplifySignIn({ username: email.trim(), password });

    switch (result.nextStep.signInStep) {
      case 'DONE':
        return { kind: 'DONE' };
      case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
        return { kind: 'NEW_PASSWORD_REQUIRED' };
      default:
        return {
          kind: 'ERROR',
          message: `This account needs a step we do not support here (${result.nextStep.signInStep}). Ask an administrator.`,
        };
    }
  } catch (error) {
    return { kind: 'ERROR', message: friendlyAuthError(error) };
  }
}

/** Complete the forced password change on a first sign-in. */
export async function completeNewPassword(newPassword: string): Promise<SignInOutcome> {
  try {
    const result = await confirmSignIn({ challengeResponse: newPassword });
    return result.nextStep.signInStep === 'DONE'
      ? { kind: 'DONE' }
      : { kind: 'ERROR', message: 'Could not set that password. Please try another.' };
  } catch (error) {
    return { kind: 'ERROR', message: friendlyAuthError(error) };
  }
}

export async function requestPasswordReset(email: string): Promise<{ ok: boolean; message: string }> {
  try {
    await resetPassword({ username: email.trim() });
    return { ok: true, message: 'Check your email for a reset code.' };
  } catch (error) {
    return { ok: false, message: friendlyAuthError(error) };
  }
}

export async function completePasswordReset(
  email: string,
  code: string,
  newPassword: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    await confirmResetPassword({
      username: email.trim(),
      confirmationCode: code.trim(),
      newPassword,
    });
    return { ok: true, message: 'Password changed. You can sign in now.' };
  } catch (error) {
    return { ok: false, message: friendlyAuthError(error) };
  }
}

/**
 * Turn Cognito's exception names into something a player can act on.
 *
 * Note the deliberate vagueness on unknown users: because sign-up is closed,
 * confirming that an address does or does not have an account would leak the
 * membership of a private group.
 */
function friendlyAuthError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);

  switch (name) {
    case 'NotAuthorizedException':
    case 'UserNotFoundException':
      return 'That email and password do not match.';
    case 'PasswordResetRequiredException':
      return 'Your password needs resetting. Use “Forgotten password”.';
    case 'InvalidPasswordException':
      return 'That password is too weak. Use at least 10 characters, with a number.';
    case 'LimitExceededException':
    case 'TooManyRequestsException':
      return 'Too many attempts. Please wait a few minutes and try again.';
    case 'CodeMismatchException':
      return 'That code is not right. Check the email and try again.';
    case 'ExpiredCodeException':
      return 'That code has expired. Request a new one.';
    case 'UserNotConfirmedException':
      return 'This account has not been confirmed yet. Ask an administrator.';
    default:
      return message || 'Something went wrong signing in.';
  }
}
