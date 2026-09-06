import { describe, expect, it } from 'vitest';
import {
  eliminationMessage,
  finalTwoMessage,
  rolloverMessage,
  winnerMessage,
} from './notifications.js';

/**
 * These go to real people, so the facts in them are asserted rather than eyeballed.
 * Getting a pot figure or a team name wrong in an automated email is worse than
 * not sending one.
 */

describe('eliminationMessage', () => {
  const base = {
    displayName: 'Dave',
    teamName: 'Tottenham Hotspur',
    matchday: 8,
    roundNumber: 4,
    survivorCount: 5,
    wasAutoPick: false,
  };

  it('names the team, the gameweek and the round', () => {
    const message = eliminationMessage(base);
    expect(message.subject).toBe("You're out — Killer Round 4, GW8");
    expect(message.text).toContain('Dave');
    expect(message.text).toContain('Tottenham Hotspur');
    expect(message.text).toContain('Killer Round 4');
    expect(message.text).toContain('5 players are still standing');
  });

  it('calls out an auto-assigned pick, because that is the annoying way to go', () => {
    const message = eliminationMessage({ ...base, wasAutoPick: true });
    expect(message.text).toContain('auto-assigned');
    expect(message.text).toContain('without a pick from you');
  });

  it('does not mention auto-assignment for a pick they actually made', () => {
    expect(eliminationMessage(base).text).not.toContain('auto-assigned');
  });

  it('handles the singular survivor', () => {
    const message = eliminationMessage({ ...base, survivorCount: 1 });
    expect(message.text).toContain('One player is still standing');
    expect(message.text).not.toContain('1 players');
  });

  it('tells everyone it is a rollover when they all went out together', () => {
    const message = eliminationMessage({ ...base, survivorCount: 0 });
    expect(message.text).toContain('nobody wins this one');
    expect(message.text).toContain('rolls over');
  });

  it('copes with a missing team name rather than printing null', () => {
    const message = eliminationMessage({ ...base, teamName: null });
    expect(message.text).toContain('your team');
    expect(message.text).not.toContain('null');
  });

  it('copes with a missing matchday', () => {
    const message = eliminationMessage({ ...base, matchday: null });
    expect(message.subject).toContain('this gameweek');
    expect(message.subject).not.toContain('null');
  });
});

describe('winnerMessage', () => {
  const base = {
    displayName: 'Mat',
    roundNumber: 1,
    potPence: 5000,
    teamName: 'Brighton & Hove Albion',
    matchday: 3,
    entrantCount: 10,
    weeksSurvived: 3,
  };

  it('states the pot exactly, in the subject and the body', () => {
    const message = winnerMessage(base);
    expect(message.subject).toBe("You've won Killer Round 1 — £50");
    expect(message.text).toContain('£50');
  });

  it('counts the other entrants, not including the winner', () => {
    expect(winnerMessage(base).text).toContain('outlasted 9 other players');
  });

  it('uses the singular when they beat exactly one other player', () => {
    const message = winnerMessage({ ...base, entrantCount: 2 });
    expect(message.text).toContain('outlasted 1 other player');
    expect(message.text).not.toContain('1 other players');
  });

  it('uses the singular for a one-week round', () => {
    const message = winnerMessage({ ...base, weeksSurvived: 1 });
    expect(message.text).toContain('1 gameweek');
    expect(message.text).not.toContain('1 gameweeks');
  });

  it('formats pence that are not whole pounds', () => {
    expect(winnerMessage({ ...base, potPence: 12_350 }).subject).toContain('£123.50');
  });
});

describe('rolloverMessage', () => {
  it('states what carries forward', () => {
    const message = rolloverMessage({
      displayName: 'Pia',
      roundNumber: 2,
      rolloverPence: 4500,
      matchday: 6,
    });
    expect(message.subject).toContain('rolls over');
    expect(message.text).toContain('£45');
    expect(message.text).toContain('GW6');
    expect(message.text).toContain('no winner');
  });
});

describe('finalTwoMessage', () => {
  it('is about the last two and names the pot', () => {
    const message = finalTwoMessage({
      displayName: 'Erik',
      roundNumber: 3,
      teamName: 'Arsenal',
      matchday: 9,
      survivorCount: 2,
      potPence: 6000,
    });
    expect(message.subject).toContain('last two');
    expect(message.text).toContain('Arsenal');
    expect(message.text).toContain('£60');
  });
});

describe('every message', () => {
  const all = [
    eliminationMessage({
      displayName: 'A', teamName: 'Arsenal', matchday: 1, roundNumber: 1,
      survivorCount: 2, wasAutoPick: false,
    }),
    winnerMessage({
      displayName: 'A', roundNumber: 1, potPence: 500, teamName: 'Arsenal',
      matchday: 1, entrantCount: 3, weeksSurvived: 2,
    }),
    rolloverMessage({ displayName: 'A', roundNumber: 1, rolloverPence: 500, matchday: 1 }),
    finalTwoMessage({
      displayName: 'A', roundNumber: 1, teamName: 'Arsenal', matchday: 1,
      survivorCount: 2, potPence: 500,
    }),
  ];

  it('links to the site so people can go and look', () => {
    for (const message of all) {
      expect(message.text).toContain('https://killer.fourfold.co.uk');
    }
  });

  it('says how to stop receiving them', () => {
    // Automated mail to real people needs an obvious way out, even among friends.
    for (const message of all) {
      expect(message.text).toContain("turn these off");
    }
  });

  it('has a non-empty subject that is short enough not to be truncated', () => {
    for (const message of all) {
      expect(message.subject.length).toBeGreaterThan(0);
      expect(message.subject.length).toBeLessThanOrEqual(78);
    }
  });

  it('never leaks undefined or null into the copy', () => {
    for (const message of all) {
      expect(message.text).not.toMatch(/undefined|null|NaN|\[object/);
      expect(message.subject).not.toMatch(/undefined|null|NaN/);
    }
  });
});
