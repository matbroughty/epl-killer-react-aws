import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { Message } from '../../shared/domain/notifications.js';

/**
 * Sending player notifications.
 *
 * Deliberately thin: the copy lives in `shared/domain/notifications.ts` where it
 * is unit-tested, and this only puts it on the wire.
 *
 * Two rules:
 *
 * 1. **A send failure never fails the caller.** These are called from result
 *    processing, after eliminations and payouts have been decided. Letting a
 *    bounced address roll back somebody's elimination would be absurd, so
 *    failures are logged and swallowed.
 * 2. **One event, one email.** There is no retry and no queue. Idempotency comes
 *    from the planners: an elimination appears in exactly one plan, because the
 *    next plan sees the entry already `ELIMINATED`. Retrying here would break
 *    that guarantee, not improve it.
 */

const ses = new SESv2Client({});

/** Verified SES identity. Must match what Cognito sends as. */
export const FROM_ADDRESS = 'Fourfold Killer <killer@fourfold.co.uk>';

export interface Recipient {
  email: string | null | undefined;
  displayName: string;
  /** False when the player has asked not to be emailed. */
  notifyByEmail: boolean;
}

export interface SendResult {
  sent: number;
  skipped: string[];
  failed: string[];
}

export async function sendMessage(
  recipient: Recipient,
  message: Message,
): Promise<'SENT' | 'SKIPPED' | 'FAILED'> {
  if (!recipient.email) return 'SKIPPED';
  if (!recipient.notifyByEmail) return 'SKIPPED';

  try {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: FROM_ADDRESS,
        Destination: { ToAddresses: [recipient.email] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: message.text, Charset: 'UTF-8' } },
          },
        },
      }),
    );
    return 'SENT';
  } catch (error) {
    // A bad address or an SES problem must not derail the competition.
    console.error(
      `Email to ${recipient.displayName} <${recipient.email}> failed:`,
      error instanceof Error ? error.message : error,
    );
    return 'FAILED';
  }
}

/** Send several, reporting rather than throwing. */
export async function sendAll(
  items: readonly { recipient: Recipient; message: Message }[],
): Promise<SendResult> {
  const result: SendResult = { sent: 0, skipped: [], failed: [] };

  for (const item of items) {
    const outcome = await sendMessage(item.recipient, item.message);
    if (outcome === 'SENT') result.sent += 1;
    else if (outcome === 'SKIPPED') result.skipped.push(item.recipient.displayName);
    else result.failed.push(item.recipient.displayName);
  }

  return result;
}
