import type { generateClient } from 'aws-amplify/data';
import type { Schema } from '../data/resource.js';

/** The Amplify Data client, as the backend functions use it. */
export type KillerClient = ReturnType<typeof generateClient<Schema>>;

/** Shape of an Amplify Data list call: one page plus a continuation token. */
interface Page<T> {
  data: T[];
  nextToken?: string | null;
  errors?: { message: string }[] | null;
}

/**
 * Read every page of a list query.
 *
 * Amplify returns 100 items by default, which is more than a Killer Round will
 * ever need — but "more than we need" is exactly the assumption that breaks
 * quietly in year three, so we page properly. The cap is a safety net against a
 * runaway loop, not an expected limit.
 */
export async function collect<T>(
  query: (args: { nextToken?: string | null; limit?: number }) => Promise<Page<T>>,
  options: { limit?: number; maxPages?: number } = {},
): Promise<T[]> {
  const maxPages = options.maxPages ?? 50;
  const items: T[] = [];
  let nextToken: string | null | undefined;
  let pages = 0;

  do {
    const page = await query({ nextToken, limit: options.limit ?? 200 });
    if (page.errors?.length) {
      throw new Error(page.errors.map((error) => error.message).join('; '));
    }
    items.push(...page.data);
    nextToken = page.nextToken;
    pages += 1;
  } while (nextToken && pages < maxPages);

  return items;
}

/** Throw on a GraphQL error rather than silently returning null data. */
export function unwrap<T>(result: {
  data: T;
  errors?: { message: string }[] | null;
}): T {
  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join('; '));
  }
  return result.data;
}

/**
 * True when a create failed only because the item already exists.
 *
 * This is how the deadline processor stays idempotent under concurrency: two
 * simultaneous runs both try to create the same `{weekId}#{entryId}` selection,
 * one wins, and the loser treats this as success rather than an error.
 */
export function isConditionalCheckFailure(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error ?? '');
  return /ConditionalCheckFailed|conditional request failed|already exists/i.test(message);
}
