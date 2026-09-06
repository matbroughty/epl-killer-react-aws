import { defineAuth } from '@aws-amplify/backend';
import { killerApi } from '../functions/killer-api/resource.js';

/**
 * Authentication for a small private group.
 *
 * Two things matter here:
 *
 * 1. **No open self-registration.** The user pool is switched to
 *    admin-create-only in `backend.ts` (`allowAdminCreateUserOnly`), because
 *    that lives on the underlying Cognito resource rather than in `defineAuth`.
 *    The only way in is an administrator invitation, which `killer-api`
 *    performs with `AdminCreateUser`; Cognito emails a temporary password and
 *    the user sets their own on first sign-in.
 * 2. **Administrators are a Cognito group, not an email address in the React
 *    bundle.** The `ADMIN` group arrives in the token as `cognito:groups`, and
 *    AppSync enforces it before any admin resolver runs.
 *
 * Cognito deliberately holds the bare minimum. The durable record of who a
 * player is lives in the `Player` model, so their history survives a change of
 * email address or a rebuilt login.
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },

  /**
   * Send through SES rather than Cognito's built-in sender.
   *
   * The default (`COGNITO_DEFAULT`) is capped at 50 emails a day, sends from a
   * generic no-reply address and signs nothing against this domain — invitations
   * routinely landed in spam. `fourfold.co.uk` is a DKIM-verified SES identity in
   * this account and region, so mail is signed and arrives.
   *
   * This matters most for **password resets**, which are the only self-service
   * route back in for a player who has forgotten theirs. Without working email
   * every reset is a manual admin command.
   *
   * `fromEmail` must stay a verified SES identity in the same region as the user
   * pool, or Cognito cannot send at all. See the SES section of the README.
   */
  senders: {
    email: {
      fromEmail: 'killer@fourfold.co.uk',
      fromName: 'Fourfold Killer',
    },
  },

  groups: ['ADMIN'],

  /**
   * `killer-api` invites players. Granting exactly these actions keeps the
   * Cognito administrative surface off the browser entirely — React never holds
   * credentials that could create a user.
   */
  access: (allow) => [
    allow
      .resource(killerApi)
      .to(['createUser', 'addUserToGroup', 'listUsers', 'getUser', 'updateUserAttributes']),
  ],
});
