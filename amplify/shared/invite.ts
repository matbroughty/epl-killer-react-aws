import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  UsernameExistsException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import type { Clock } from '../../shared/domain/clock.js';
import { recordAudit } from './audit.js';
import type { Repository } from './repository.js';
import { OperationError, requireAdmin, type ResolvedViewer } from './viewer.js';

/**
 * Adding a player.
 *
 * Cognito administrative calls happen here, inside the Lambda, with credentials
 * from the execution role that `defineAuth`'s `access` block granted. React
 * never holds anything that could create a user — it just calls
 * `adminInvitePlayer` and AppSync checks the caller is in the `ADMIN` group.
 *
 * The `Player` record and the Cognito user are deliberately separate. The Player
 * is the durable identity that owns the history; the Cognito user is just a way
 * to log in, and can be recreated or have its email changed without touching a
 * single past selection.
 */

const cognito = new CognitoIdentityProviderClient({});

export interface InviteResult {
  ok: boolean;
  playerId: string;
  cognitoUserId: string | null;
  invited: boolean;
  message: string;
}

export async function adminInvitePlayer(
  repository: Repository,
  viewer: ResolvedViewer,
  clock: Clock,
  userPoolId: string,
  input: {
    displayName: string;
    email: string;
    makeAdmin?: boolean | null;
    sendInvite?: boolean | null;
  },
): Promise<InviteResult> {
  requireAdmin(viewer);

  const displayName = input.displayName.trim();
  const email = input.email.trim().toLowerCase();
  if (!displayName) throw new OperationError('A display name is required.', 'NO_NAME');
  if (!email.includes('@')) throw new OperationError('A valid email is required.', 'BAD_EMAIL');

  const now = clock.nowIso();
  const sendInvite = input.sendInvite ?? true;

  // Reuse an existing Player rather than creating a duplicate history.
  const existingPlayer = await repository.playerByEmail(email);

  let cognitoUserId: string | null = existingPlayer?.cognitoUserId ?? null;
  let invited = false;
  let message: string;

  if (sendInvite) {
    try {
      const created = await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: email,
          UserAttributes: [
            { Name: 'email', Value: email },
            // Pre-verified: an administrator vouched for the address, and making
            // people confirm an email they were just sent is pointless friction.
            { Name: 'email_verified', Value: 'true' },
          ],
          DesiredDeliveryMediums: ['EMAIL'],
        }),
      );

      cognitoUserId =
        created.User?.Attributes?.find((attribute) => attribute.Name === 'sub')?.Value ??
        cognitoUserId;
      invited = true;
      message = `Invitation sent to ${email} with a temporary password.`;
    } catch (error) {
      if (error instanceof UsernameExistsException) {
        // Already has a login. Look up their subject so the Player links to it.
        cognitoUserId = (await findCognitoSub(userPoolId, email)) ?? cognitoUserId;
        message = `${email} already has a login; the player record has been linked to it.`;
      } else {
        throw error;
      }
    }

    if (input.makeAdmin) {
      await cognito.send(
        new AdminAddUserToGroupCommand({
          UserPoolId: userPoolId,
          Username: email,
          GroupName: 'ADMIN',
        }),
      );
    }
  } else {
    // A player record with no login: useful for importing somebody who pays in
    // cash and never signs in, and for the legacy CSV import.
    message = `Player record created for ${displayName} without a login.`;
  }

  let playerId: string;
  if (existingPlayer) {
    await repository.models.Player.update({
      id: existingPlayer.id,
      displayName,
      email,
      cognitoUserId,
      active: true,
    });
    playerId = existingPlayer.id;
  } else {
    const created = await repository.models.Player.create({
      displayName,
      email,
      cognitoUserId,
      active: true,
    });
    const id = created.data?.id;
    if (!id) {
      throw new OperationError('Could not create the player record.', 'CREATE_FAILED');
    }
    playerId = id;
  }

  await recordAudit(repository, viewer, now, {
    action: existingPlayer ? 'PLAYER_UPDATED' : 'PLAYER_ADDED',
    entityType: 'Player',
    entityId: playerId,
    after: { displayName, email, cognitoUserId, admin: Boolean(input.makeAdmin), invited },
    note: message,
  });

  return { ok: true, playerId, cognitoUserId, invited, message };
}

async function findCognitoSub(userPoolId: string, email: string): Promise<string | null> {
  const response = await cognito.send(
    new ListUsersCommand({
      UserPoolId: userPoolId,
      Filter: `email = "${email}"`,
      Limit: 1,
    }),
  );
  return (
    response.Users?.[0]?.Attributes?.find((attribute) => attribute.Name === 'sub')?.Value ?? null
  );
}

/**
 * Set a player's password directly.
 *
 * Email delivery is the weak link in getting people signed in — invitations and
 * reset codes both go through it, and when it fails there is no self-service way
 * back in. This is the path that does not depend on it at all: set a password,
 * tell the player however you actually reach them.
 *
 * **Temporary by default.** `permanent: false` leaves Cognito in
 * `FORCE_CHANGE_PASSWORD`, so the administrator's chosen password stops working
 * the moment the player signs in and picks their own. That matters when the
 * password is being passed over a group chat.
 *
 * Audited either way, without the password: who reset whose login is worth
 * knowing, and the value itself never belongs in an audit log.
 */
export async function adminSetPassword(
  repository: Repository,
  viewer: ResolvedViewer,
  clock: Clock,
  userPoolId: string,
  input: { playerId: string; password: string; permanent?: boolean | null },
): Promise<{ ok: boolean; message: string; permanent: boolean }> {
  requireAdmin(viewer);

  const player = await repository.player(input.playerId);
  if (!player) throw new OperationError('No such player.', 'NO_SUCH_PLAYER');
  if (!player.email) {
    throw new OperationError(
      `${player.displayName} has no email address, so there is no login to set a password for.`,
      'NO_EMAIL',
    );
  }

  // Mirrors the pool policy in backend.ts. Checked here so the error names the
  // actual rule rather than surfacing Cognito's generic complaint.
  if (input.password.length < 10) {
    throw new OperationError('Password must be at least 10 characters.', 'PASSWORD_TOO_SHORT');
  }
  if (!/[a-z]/.test(input.password) || !/\d/.test(input.password)) {
    throw new OperationError(
      'Password must contain a lower-case letter and a number.',
      'PASSWORD_TOO_WEAK',
    );
  }

  const permanent = input.permanent === true;

  try {
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: player.email,
        Password: input.password,
        Permanent: permanent,
      }),
    );
  } catch (error) {
    if (error instanceof UserNotFoundException) {
      throw new OperationError(
        `${player.displayName} has no Cognito login yet. Invite them first, then set a password.`,
        'NO_LOGIN',
      );
    }
    throw error;
  }

  await recordAudit(repository, viewer, clock.nowIso(), {
    action: permanent ? 'PASSWORD_SET_PERMANENT' : 'PASSWORD_SET_TEMPORARY',
    entityType: 'Player',
    entityId: player.id,
    // Deliberately no password, not even a hash or a length.
    after: { permanent, forcesChangeAtNextSignIn: !permanent },
    note: `Password set for ${player.displayName} by an administrator.`,
  });

  return {
    ok: true,
    permanent,
    message: permanent
      ? `Password set for ${player.displayName}. They can sign in with it and will not be asked to change it.`
      : `Temporary password set for ${player.displayName}. They will be asked to choose their own on first sign-in.`,
  };
}

/** Activate or deactivate a player. Their history is never deleted. */
export async function adminSetPlayerActive(
  repository: Repository,
  viewer: ResolvedViewer,
  clock: Clock,
  input: { playerId: string; active: boolean },
): Promise<{ ok: boolean }> {
  requireAdmin(viewer);

  const player = await repository.player(input.playerId);
  if (!player) throw new OperationError('No such player.', 'NO_SUCH_PLAYER');

  await repository.models.Player.update({ id: player.id, active: input.active });

  await recordAudit(repository, viewer, clock.nowIso(), {
    action: input.active ? 'PLAYER_ACTIVATED' : 'PLAYER_DEACTIVATED',
    entityType: 'Player',
    entityId: player.id,
    before: { active: player.active },
    after: { active: input.active },
  });

  return { ok: true };
}
