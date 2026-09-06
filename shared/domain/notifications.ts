import { formatPence } from './money.js';

/**
 * The emails players receive.
 *
 * Pure functions returning subject and body, so the copy can be unit-tested and
 * reviewed without sending anything. Nothing here knows about SES.
 *
 * Tone is deliberately light — this is a five-pound sweepstake among friends,
 * and an elimination notice that reads like a service outage would be worse than
 * no notice at all. But the *facts* are exact: which team, which gameweek, how
 * much. People will check them against the table.
 */

export interface Message {
  subject: string;
  /** Plain text. Every client renders it and it cannot break. */
  text: string;
}

const SITE = 'https://killer.fourfold.co.uk';

function signOff(): string {
  return `\n\n${SITE}\n\nYou're getting this because you're in the Fourfold Killer sweepstake.\nAsk the organiser to turn these off if you'd rather not have them.`;
}

/** `GW8` */
function gw(matchday: number | null): string {
  return matchday === null ? 'this gameweek' : `GW${matchday}`;
}

export interface EliminationFacts {
  displayName: string;
  teamName: string | null;
  matchday: number | null;
  roundNumber: number;
  /** How many are left after this week. */
  survivorCount: number;
  /** True when the pick was auto-assigned because they missed the deadline. */
  wasAutoPick: boolean;
}

export function eliminationMessage(facts: EliminationFacts): Message {
  const team = facts.teamName ?? 'your team';

  // The auto-pick case deserves its own line: being knocked out by a team you
  // never chose is the most annoying way to go, and pretending otherwise in the
  // copy would read as tone-deaf.
  const cause = facts.wasAutoPick
    ? `${team} — auto-assigned after the deadline went by without a pick from you — didn't win.`
    : `${team} didn't win.`;

  const remaining =
    facts.survivorCount === 0
      ? `That's everyone gone in the same week, so nobody wins this one. The pot rolls over.`
      : facts.survivorCount === 1
        ? `One player is still standing.`
        : `${facts.survivorCount} players are still standing.`;

  return {
    subject: `You're out — Killer Round ${facts.roundNumber}, ${gw(facts.matchday)}`,
    text:
      `Bad news, ${facts.displayName}.\n\n` +
      `${cause} You're out of Killer Round ${facts.roundNumber}.\n\n` +
      `${remaining}\n\n` +
      `You'll be back in when the next round starts, with a clean slate and every team available again.` +
      signOff(),
  };
}

export interface WinnerFacts {
  displayName: string;
  roundNumber: number;
  potPence: number;
  teamName: string | null;
  matchday: number | null;
  /** How many started the round. */
  entrantCount: number;
  weeksSurvived: number;
}

export function winnerMessage(facts: WinnerFacts): Message {
  const team = facts.teamName ?? 'your final pick';
  return {
    subject: `You've won Killer Round ${facts.roundNumber} — ${formatPence(facts.potPence)}`,
    text:
      `Congratulations, ${facts.displayName}.\n\n` +
      `${team} came through in ${gw(facts.matchday)} and you're the last player standing in ` +
      `Killer Round ${facts.roundNumber}.\n\n` +
      `You outlasted ${facts.entrantCount - 1} other ${facts.entrantCount === 2 ? 'player' : 'players'} ` +
      `over ${facts.weeksSurvived} ${facts.weeksSurvived === 1 ? 'gameweek' : 'gameweeks'}.\n\n` +
      `The pot is ${formatPence(facts.potPence)}. Have a word with the organiser about getting hold of it.` +
      signOff(),
  };
}

export interface RolloverFacts {
  displayName: string;
  roundNumber: number;
  rolloverPence: number;
  matchday: number | null;
}

export function rolloverMessage(facts: RolloverFacts): Message {
  return {
    subject: `Everyone's out — Killer Round ${facts.roundNumber} rolls over`,
    text:
      `Well, that was carnage.\n\n` +
      `Every remaining player went out in ${gw(facts.matchday)}, so Killer Round ` +
      `${facts.roundNumber} has no winner.\n\n` +
      `Nobody takes the money, which means ${formatPence(facts.rolloverPence)} carries into the ` +
      `next round. It'll be worth more than usual — so it's worth entering.\n\n` +
      `Everyone starts again with every team available.` +
      signOff(),
  };
}

/**
 * A player who survived. Deliberately *not* sent on every survival — a weekly
 * "you're still in" email is the fastest way to get a mail rule created against
 * you. Kept for the case where it is genuinely news: the final two.
 */
export interface SurvivalFacts {
  displayName: string;
  roundNumber: number;
  teamName: string | null;
  matchday: number | null;
  survivorCount: number;
  potPence: number;
}

export function finalTwoMessage(facts: SurvivalFacts): Message {
  return {
    subject: `Down to the last two — Killer Round ${facts.roundNumber}`,
    text:
      `Nicely done, ${facts.displayName}.\n\n` +
      `${facts.teamName ?? 'Your pick'} won in ${gw(facts.matchday)} and there are just two of ` +
      `you left in Killer Round ${facts.roundNumber}.\n\n` +
      `${formatPence(facts.potPence)} on the line. Choose carefully.` +
      signOff(),
  };
}
