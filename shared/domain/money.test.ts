import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENTRY_FEE_PENCE,
  computePot,
  formatPence,
  parsePoundsToPence,
  rolloverAmount,
} from './money.js';
import { killerRound, roundEntry } from './__fixtures__/builders.js';

function entries(specs: { paid: boolean; feePence?: number }[]) {
  return specs.map((spec, index) =>
    roundEntry({
      id: `entry-${index}`,
      paid: spec.paid,
      entryFeePence: spec.feePence ?? DEFAULT_ENTRY_FEE_PENCE,
    }),
  );
}

describe('computePot', () => {
  it('defaults to a £5 entry fee', () => {
    expect(DEFAULT_ENTRY_FEE_PENCE).toBe(500);
  });

  it('counts every entrant in the expected pot, paid or not', () => {
    // The rule that matters: entering incurs the fee. The pot is not a tally of
    // payment flags.
    const pot = computePot(killerRound(), entries([
      { paid: true },
      { paid: true },
      { paid: false },
      { paid: false },
      { paid: false },
    ]));

    expect(pot.entrantCount).toBe(5);
    expect(pot.expectedEntriesPence).toBe(2_500);
    expect(pot.totalPotPence).toBe(2_500);
  });

  it('tracks collected and outstanding separately', () => {
    const pot = computePot(killerRound(), entries([
      { paid: true },
      { paid: true },
      { paid: false },
    ]));

    expect(pot.paidCount).toBe(2);
    expect(pot.collectedPence).toBe(1_000);
    expect(pot.outstandingPence).toBe(500);
  });

  it('adds the rollover carried in from the previous round', () => {
    const pot = computePot(
      killerRound({ rolloverInPence: 7_000 }),
      entries([{ paid: true }, { paid: false }]),
    );

    expect(pot.rolloverInPence).toBe(7_000);
    expect(pot.expectedEntriesPence).toBe(1_000);
    // £70 carried in plus 2 x £5 = £80.
    expect(pot.totalPotPence).toBe(8_000);
    expect(formatPence(pot.totalPotPence)).toBe('£80');
  });

  it('honours a per-entry fee snapshot rather than the round fee', () => {
    // Changing a round's fee later must not rewrite what existing entrants owe.
    const pot = computePot(
      killerRound({ entryFeePence: 1_000 }),
      entries([{ paid: true, feePence: 500 }, { paid: false, feePence: 500 }]),
    );
    expect(pot.expectedEntriesPence).toBe(1_000);
  });

  it('supports a configured non-default fee', () => {
    const pot = computePot(
      killerRound({ entryFeePence: 1_000 }),
      entries([{ paid: true, feePence: 1_000 }, { paid: true, feePence: 1_000 }]),
    );
    expect(pot.totalPotPence).toBe(2_000);
    expect(formatPence(pot.totalPotPence)).toBe('£20');
  });

  it('handles a round with no entrants', () => {
    const pot = computePot(killerRound({ rolloverInPence: 1_500 }), []);
    expect(pot).toMatchObject({
      entrantCount: 0,
      expectedEntriesPence: 0,
      collectedPence: 0,
      outstandingPence: 0,
      totalPotPence: 1_500,
    });
  });

  it('never reports negative outstanding when over-collected', () => {
    const pot = computePot(killerRound(), entries([{ paid: true, feePence: 500 }]));
    expect(pot.outstandingPence).toBe(0);
  });

  it('produces the pot in the brief: 11 entrants plus a £65 rollover', () => {
    const pot = computePot(
      killerRound({ rolloverInPence: 6_500 }),
      entries(Array.from({ length: 11 }, () => ({ paid: true }))),
    );
    expect(formatPence(pot.totalPotPence)).toBe('£120');
  });
});

describe('rolloverAmount', () => {
  it('carries the whole available pot forward when nobody wins', () => {
    const pot = computePot(
      killerRound({ rolloverInPence: 2_000 }),
      entries([{ paid: true }, { paid: true }, { paid: false }]),
    );
    // £20 carried in plus 3 x £5 = £35, all of which rolls on.
    expect(rolloverAmount(pot)).toBe(3_500);
  });

  it('compounds across successive rollovers', () => {
    const first = computePot(killerRound({ rolloverInPence: 0 }), entries([
      { paid: true },
      { paid: true },
    ]));
    const second = computePot(
      killerRound({ rolloverInPence: rolloverAmount(first) }),
      entries([{ paid: true }, { paid: true }]),
    );
    const third = computePot(
      killerRound({ rolloverInPence: rolloverAmount(second) }),
      entries([{ paid: true }, { paid: true }]),
    );
    expect(rolloverAmount(third)).toBe(3_000);
    expect(formatPence(rolloverAmount(third))).toBe('£30');
  });
});

describe('formatPence', () => {
  it.each([
    [0, '£0'],
    [500, '£5'],
    [12_000, '£120'],
    [12_345, '£123.45'],
    [12_305, '£123.05'],
    [100_000, '£1,000'],
    [-500, '-£5'],
  ])('formats %i as %s', (pence, expected) => {
    expect(formatPence(pence)).toBe(expected);
  });

  it('treats null as zero', () => {
    expect(formatPence(null)).toBe('£0');
  });
});

describe('parsePoundsToPence', () => {
  it.each([
    ['5', 500],
    ['5.00', 500],
    ['£5', 500],
    ['0.05', 5],
    ['123.45', 12_345],
    ['1,000', 100_000],
    ['5.5', 550],
  ])('parses %s as %i pence', (input, expected) => {
    expect(parsePoundsToPence(input)).toBe(expected);
  });

  it('rejects anything that is not an amount, rather than coercing to NaN', () => {
    for (const bad of ['', 'five', '5.001', '£', '1.2.3']) {
      expect(() => parsePoundsToPence(bad)).toThrow();
    }
  });

  it('round-trips with formatPence', () => {
    for (const pence of [0, 500, 12_345, 100_000]) {
      expect(parsePoundsToPence(formatPence(pence))).toBe(pence);
    }
  });
});
