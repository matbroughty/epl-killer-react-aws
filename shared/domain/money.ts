import type { KillerRound, Pence, RoundEntry } from './types.js';

/** Default entry fee: £5.00. */
export const DEFAULT_ENTRY_FEE_PENCE: Pence = 500;

export interface PotBreakdown {
  /** Entrants counted, whether or not they have paid. */
  entrantCount: number;
  paidCount: number;
  /** Fees owed by every entrant, paid or not. */
  expectedEntriesPence: Pence;
  /** Fees actually marked as collected. */
  collectedPence: Pence;
  /** Still to collect. Never negative. */
  outstandingPence: Pence;
  /** Money carried in from a previous rolled-over round. */
  rolloverInPence: Pence;
  /** What the winner takes: rollover plus every entrant's fee. */
  totalPotPence: Pence;
}

/**
 * Work out the pot.
 *
 * Deliberately *not* derived from payment flags alone: entering the round
 * incurs the fee, so the expected pot counts every entrant. `collectedPence`
 * tracks what has actually come in, and the two are reported separately rather
 * than conflated.
 */
export function computePot(
  round: Pick<KillerRound, 'rolloverInPence'>,
  entries: readonly Pick<RoundEntry, 'paid' | 'entryFeePence'>[],
): PotBreakdown {
  let expectedEntriesPence = 0;
  let collectedPence = 0;
  let paidCount = 0;

  for (const entry of entries) {
    const fee = entry.entryFeePence;
    expectedEntriesPence += fee;
    if (entry.paid) {
      collectedPence += fee;
      paidCount += 1;
    }
  }

  const rolloverInPence = round.rolloverInPence ?? 0;

  return {
    entrantCount: entries.length,
    paidCount,
    expectedEntriesPence,
    collectedPence,
    outstandingPence: Math.max(0, expectedEntriesPence - collectedPence),
    rolloverInPence,
    totalPotPence: rolloverInPence + expectedEntriesPence,
  };
}

/**
 * The amount that carries into the next round when this one rolls over: the
 * whole available pot, since nobody won it.
 */
export function rolloverAmount(pot: PotBreakdown): Pence {
  return pot.totalPotPence;
}

/** `50000` -> `"£500"`, `12345` -> `"£123.45"`. Presentation only. */
export function formatPence(pence: Pence | null | undefined): string {
  const value = pence ?? 0;
  const negative = value < 0;
  const absolute = Math.abs(value);
  const pounds = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  const body =
    remainder === 0
      ? `£${pounds.toLocaleString('en-GB')}`
      : `£${pounds.toLocaleString('en-GB')}.${String(remainder).padStart(2, '0')}`;
  return negative ? `-${body}` : body;
}

/** `"5"`, `"5.00"`, `"£5"` -> `500`. Throws on anything else. */
export function parsePoundsToPence(input: string): Pence {
  const cleaned = input.trim().replace(/^£/, '').replace(/,/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(`Not a valid amount in pounds: "${input}"`);
  }
  const negative = cleaned.startsWith('-');
  const [wholePart = '0', fractionPart = ''] = cleaned.replace(/^-/, '').split('.');
  const pence =
    Number(wholePart) * 100 + Number(fractionPart.padEnd(2, '0').slice(0, 2) || 0);
  return negative ? -pence : pence;
}
