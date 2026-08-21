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
