import { defineFunction, secret } from '@aws-amplify/backend';

/**
 * The competition's heartbeat.
 *
 * One EventBridge schedule rather than several, and state-driven rather than
 * time-driven: each tick asks the database what is due and does only that. The
 * effect is self-healing — a missed tick, a failed provider call or a Lambda
 * timeout is simply picked up by the next run — and cheap, because the common
 * case is a single DynamoDB query against `listWeeksByStatusAndDeadline` and no
 * external calls at all.
 *
 * Every 15 minutes is 96 invocations a day, comfortably inside the Lambda free
 * tier, and well inside football-data.org's 10 requests/minute since most ticks
 * make none. A deadline processed up to 15 minutes late costs nothing: the
 * server rejects selections on the deadline itself, so lateness only delays the
 * reveal, it never lets a pick through.
 */
export const killerScheduler = defineFunction({
  name: 'killer-scheduler',
  entry: './handler.ts',
  runtime: 20,
  schedule: 'every 15m',
  // Long enough for a full-season fixture sync plus result processing, with the
  // provider's own request spacing factored in.
  timeoutSeconds: 300,
  memoryMB: 512,
  environment: {
    FOOTBALL_DATA_TOKEN: secret('FOOTBALL_DATA_TOKEN'),
  },
});
