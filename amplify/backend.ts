import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource.js';
import { data } from './data/resource.js';
import { killerApi } from './functions/killer-api/resource.js';
import { killerScheduler } from './functions/killer-scheduler/resource.js';

/**
 * Fourfold Killer backend.
 *
 * Four resources and nothing else: Cognito, AppSync/DynamoDB, and two Lambdas.
 * No containers, no queues, no relational database — the application is a
 * weekly pick and a table, and it should cost close to nothing to run.
 */
const backend = defineBackend({
  auth,
  data,
  killerApi,
  killerScheduler,
});

/**
 * Close public sign-up.
 *
 * This is not exposed by `defineAuth`, so it is set on the underlying Cognito
 * resource. Without it anybody who found the AppSync endpoint could create
 * themselves an account. Players arrive by administrator invitation only, via
 * `adminInvitePlayer` -> `AdminCreateUser`.
 */
backend.auth.resources.cfnResources.cfnUserPool.adminCreateUserConfig = {
  allowAdminCreateUserOnly: true,
  inviteMessageTemplate: {
    emailSubject: 'You have been added to Fourfold Killer',
    emailMessage:
      'You have been entered into Fourfold Killer, the Premier League Last Man Standing competition.<br/><br/>' +
      'Sign in at https://killer.fourfold.co.uk with:<br/>' +
      'Email: {username}<br/>' +
      'Temporary password: {####}<br/><br/>' +
      'You will be asked to choose your own password when you first sign in.',
  },
};

/**
 * A sensible password policy for a football sweepstake: long enough to be
 * respectable, not so fussy that people give up on their phone.
 */
backend.auth.resources.cfnResources.cfnUserPool.policies = {
  passwordPolicy: {
    minimumLength: 10,
    requireLowercase: true,
    requireNumbers: true,
    requireUppercase: false,
    requireSymbols: false,
    temporaryPasswordValidityDays: 14,
  },
};
