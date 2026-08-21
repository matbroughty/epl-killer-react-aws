import type { IsoInstant } from './types.js';

/**
 * Everything is stored in UTC. Europe/London exists only here, at the
 * presentation edge, so British Summer Time never leaks into the rules.
 */
export const DISPLAY_TIME_ZONE = 'Europe/London';

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let existing = cache.get(key);
  if (!existing) {
    existing = new Intl.DateTimeFormat('en-GB', {
      timeZone: DISPLAY_TIME_ZONE,
      ...options,
    });
    cache.set(key, existing);
  }
  return existing;
}

function toDate(instant: IsoInstant | null | undefined): Date | null {
  if (!instant) return null;
  const millis = Date.parse(instant);
  return Number.isNaN(millis) ? null : new Date(millis);
}

/** `Saturday 15:00` — the deadline phrasing used throughout the app. */
export function formatDeadline(instant: IsoInstant | null | undefined): string {
  const date = toDate(instant);
  if (!date) return 'To be confirmed';
  return formatter({ weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(date);
}

/** `Sat 22 Aug, 15:00` — when the day of the week alone is ambiguous. */
export function formatDateTime(instant: IsoInstant | null | undefined): string {
  const date = toDate(instant);
  if (!date) return '—';
  return formatter({
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** `22 Aug 2026` */
export function formatDate(instant: IsoInstant | null | undefined): string {
  const date = toDate(instant);
  if (!date) return '—';
  return formatter({ day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

/** `15:00` */
export function formatTime(instant: IsoInstant | null | undefined): string {
  const date = toDate(instant);
  if (!date) return '—';
  return formatter({ hour: '2-digit', minute: '2-digit' }).format(date);
}

/**
 * `2d 4h`, `3h 12m`, `45m`, `30s`, or `Closed`. Coarse on purpose: a countdown
 * that ticks every second is a distraction on a page people open once a week.
 */
export function formatCountdown(millisRemaining: number | null): string {
  if (millisRemaining === null) return '—';
  if (millisRemaining <= 0) return 'Closed';

  const totalSeconds = Math.floor(millisRemaining / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** `GW8` */
export function formatMatchday(matchday: number | null | undefined): string {
  return matchday === null || matchday === undefined ? 'GW—' : `GW${matchday}`;
}

/** `11 players remaining`, with the singular handled. */
export function formatRemaining(count: number): string {
  return `${count} player${count === 1 ? '' : 's'} remaining`;
}
