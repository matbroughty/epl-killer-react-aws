import { defineFunction, secret } from '@aws-amplify/backend';

/**
 * The single AppSync resolver behind every custom query and mutation.
 *
 * One function rather than a dozen, because each `defineFunction` is another
 * Lambda, another log group and another cold start to pay for on an application
 * that a handful of people open once a week. The handler routes on
 * `event.info.fieldName`; AppSync has already enforced the per-field
 * authorization rules in `data/resource.ts` before we are invoked, and the
 * router re-checks `cognito:groups` for admin fields as a second line.
 */
export const killerApi = defineFunction({
  name: 'killer-api',
  entry: './handler.ts',
  runtime: 20,
  // Generous enough for the largest operation (starting a round, or a manual
  // full-season fixture sync) without being an invitation to do heavy work here.
  timeoutSeconds: 60,
  memoryMB: 512,
  environment: {
    // Read only inside Lambda. The browser never sees this.
    FOOTBALL_DATA_TOKEN: secret('FOOTBALL_DATA_TOKEN'),
  },
});
