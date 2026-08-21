import type { Viewer } from '../../shared/domain/visibility.js';
import type { Repository } from './repository.js';

/**
 * Who is calling.
 *
 * Derived **only** from the AppSync identity that Cognito signed. Nothing here
 * reads a resolver argument, because an argument is whatever the caller typed:
 * if `viewerIsAdmin` were an input, being an administrator would be a matter of
 * asking nicely.
 */

/** The identity shapes AppSync passes to a Lambda resolver. */
interface CognitoIdentity {
  sub?: string;
  username?: string;
  claims?: Record<string, unknown>;
  groups?: string[] | null;
}

interface IamIdentity {
  cognitoIdentityId?: string | null;
  userArn?: string | null;
}

export type AppSyncIdentity = (CognitoIdentity & IamIdentity) | null | undefined;

export interface ResolvedViewer extends Viewer {
  /** Cognito subject, when signed in. */
  sub: string | null;
  email: string | null;
  displayName: string | null;
}

export const ANONYMOUS: ResolvedViewer = {
  kind: 'ANONYMOUS',
  playerId: null,
  sub: null,
  email: null,
  displayName: null,
};

function claimString(claims: Record<string, unknown> | undefined, key: string): string | null {
  const value = claims?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Cognito groups, which arrive either on `identity.groups` or in the claims. */
export function groupsFrom(identity: AppSyncIdentity): string[] {
  if (!identity) return [];
  if (Array.isArray(identity.groups)) return identity.groups;
  const claim = identity.claims?.['cognito:groups'];
  if (Array.isArray(claim)) return claim.filter((entry): entry is string => typeof entry === 'string');
  // Some configurations deliver the claim as a space-separated string.
  if (typeof claim === 'string') return claim.split(/[\s,]+/).filter(Boolean);
  return [];
}

export function isAdmin(identity: AppSyncIdentity): boolean {
  return groupsFrom(identity).includes('ADMIN');
}

/**
 * Resolve the caller to a Player record.
 *
 * A guest or IAM identity has no `sub`, so it resolves to anonymous — the view
 * then redacts everything that is not already public. This fails closed: an
 * identity we do not recognise gets the public view, never a privileged one.
 *
 * The Cognito subject is the primary key, with an email fallback that back-fills
 * `cognitoUserId`. That fallback exists so a Player created by the legacy import
 * or by hand in the console links itself up the first time that person signs in,
 * rather than needing an administrator to paste a subject id.
 */
export async function resolveViewer(
  identity: AppSyncIdentity,
  repository: Repository,
): Promise<ResolvedViewer> {
  const sub = identity?.sub ?? claimString(identity?.claims, 'sub');
  const admin = isAdmin(identity);

  if (!sub) return ANONYMOUS;

  const email =
    claimString(identity?.claims, 'email') ??
    (typeof identity?.username === 'string' && identity.username.includes('@')
      ? identity.username
      : null);

  let player = await repository.playerByCognitoUserId(sub);

  if (!player && email) {
    const byEmail = await repository.playerByEmail(email);
    if (byEmail) {
      // First sign-in for a record that predates this Cognito user. Link them.
      await repository.models.Player.update({ id: byEmail.id, cognitoUserId: sub });
      player = { ...byEmail, cognitoUserId: sub };
    }
  }

  return {
    // An administrator with no Player record is still an administrator; they
    // simply have nothing to pick with.
    kind: admin ? 'ADMIN' : player ? 'PLAYER' : 'ANONYMOUS',
    playerId: player?.id ?? null,
    sub,
    email,
    displayName: player?.displayName ?? email ?? sub,
  };
}

/** Thrown when a caller is refused; the router turns it into a clean response. */
export class OperationError extends Error {
  constructor(
    message: string,
    readonly code: string = 'REJECTED',
  ) {
    super(message);
    this.name = 'OperationError';
  }
}

export function requireAdmin(viewer: ResolvedViewer): void {
  if (viewer.kind !== 'ADMIN') {
    throw new OperationError('Administrator access is required.', 'NOT_ADMIN');
  }
}

export function requirePlayer(viewer: ResolvedViewer): string {
  if (!viewer.playerId) {
    throw new OperationError(
      'You do not have a player record. Ask an administrator to add you.',
      'NO_PLAYER_RECORD',
    );
  }
  return viewer.playerId;
}
