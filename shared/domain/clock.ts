import type { IsoInstant } from './types.js';

/**
 * Injected time source. Every rule that depends on "now" takes one of these so
 * deadline behaviour is deterministic in tests without fake timers.
 */
export interface Clock {
  now(): Date;
  nowIso(): IsoInstant;
  nowMillis(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
  nowMillis: () => Date.now(),
};

/** A clock frozen at a fixed instant. Test helper, but harmless in production. */
export function fixedClock(at: Date | IsoInstant | number): Clock {
  const millis =
    typeof at === 'number'
      ? at
      : typeof at === 'string'
        ? Date.parse(at)
        : at.getTime();
  if (Number.isNaN(millis)) {
    throw new Error(`fixedClock: not a valid instant: ${String(at)}`);
  }
  return {
    now: () => new Date(millis),
    nowIso: () => new Date(millis).toISOString(),
    nowMillis: () => millis,
  };
}

/** Parse an instant, returning null rather than `Invalid Date` or NaN. */
export function parseInstant(value: IsoInstant | null | undefined): number | null {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : millis;
}

/**
 * Has `deadline` passed as at `clock`?
 *
 * A missing or unparseable deadline is treated as **not yet reached**, so a
 * misconfigured week never silently locks players out. A deadline exactly equal
 * to now counts as passed — the deadline is the kick-off, and you cannot pick
 * once the whistle has gone.
 */
export function isPastDeadline(
  deadline: IsoInstant | null | undefined,
  clock: Clock,
): boolean {
  const at = parseInstant(deadline);
  if (at === null) return false;
  return clock.nowMillis() >= at;
}

export function millisUntil(
  deadline: IsoInstant | null | undefined,
  clock: Clock,
): number | null {
  const at = parseInstant(deadline);
  if (at === null) return null;
  return at - clock.nowMillis();
}
