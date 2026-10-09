/**
 * Move a Round Week to a different gameweek.
 *
 *   npm run change-week -- --round 2 --week 2 --matchday 6
 *
 * For a week created against the wrong gameweek. Goes through
 * `adminChangeWeekMatchday`, the same mutation as the "Change gameweek" button,
 * so the same rules and audit apply: every pick for the week is discarded (and
 * recorded in the audit log first), anyone the week eliminated is put back, and
 * the week reopens.
 *
 * Dry run by default. `--commit` is required to write.
 *
 * If the new gameweek has already kicked off, `--deadline` is required: left on
 * the first kick-off, the scheduler would lock the week, auto-pick for everyone
 * and apply results within 15 minutes, before the real picks are entered.
 */

import { argv, exit } from 'node:process';
import { openAdminSession, payload } from './adminSession.js';

interface Options {
  round: number;
  week: number;
  matchday: number;
  deadline: string | null;
  note: string | null;
  commit: boolean;
  outputsPath: string;
  email: string | null;
}

function parseArgs(): Options {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Move a Round Week to a different gameweek, discarding its picks.

Usage:
  npm run change-week -- --round 2 --week 2 --matchday 6 [--deadline 2026-10-17T11:30:00Z] [--commit]

Options:
  --round <n>        Killer Round number (required).
  --week <n>         Week number within the round (required).
  --matchday <n>     The gameweek it should be (required).
  --deadline <iso>   Deadline for the moved week. Default: first kick-off of the
                     gameweek. Required if that has already passed.
  --note <text>      Reason, recorded in the audit log.
  --commit           Actually write. Without it, a dry run.
  --outputs <path>   amplify_outputs.json. Default: ./amplify_outputs.json
  --email <address>  Admin email. Otherwise KILLER_ADMIN_EMAIL, otherwise asked.
  --help
`);
    exit(0);
  }
  const valueOf = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const required = (flag: string) => {
    const value = Number(valueOf(flag));
    if (!Number.isInteger(value) || value <= 0) {
      console.error(`${flag} <n> is required. Use --help.`);
      exit(1);
    }
    return value;
  };
  const deadline = valueOf('--deadline') ?? null;
  if (deadline && Number.isNaN(new Date(deadline).getTime())) {
    console.error(`--deadline "${deadline}" is not a valid date. Use ISO, e.g. 2026-10-17T11:30:00Z.`);
    exit(1);
  }
  return {
    round: required('--round'),
    week: required('--week'),
    matchday: required('--matchday'),
    deadline: deadline ? new Date(deadline).toISOString() : null,
    note: valueOf('--note') ?? null,
    commit: args.includes('--commit'),
    outputsPath: valueOf('--outputs') ?? 'amplify_outputs.json',
    email: valueOf('--email') ?? null,
  };
}

async function main(): Promise<void> {
  const options = parseArgs();
  const { client } = await openAdminSession(options.outputsPath, options.email);

  const rounds = (await client.models.KillerRound.list({ limit: 200 })).data;
  const round = rounds.find(
    (candidate) => candidate.number === options.round && candidate.dataSource !== 'LEGACY_CSV',
  );
  if (!round) {
    console.error(`No Killer Round ${options.round} found.`);
    exit(1);
  }

  const weeks = (
    await client.models.RoundWeek.listWeeksByRound({ killerRoundId: round.id }, { limit: 100 })
  ).data;
  const week = weeks.find((candidate) => candidate.sequenceNumber === options.week);
  if (!week) {
    console.error(`Round ${round.number} has no Week ${options.week}.`);
    exit(1);
  }

  const selections = (
    await client.models.Selection.listSelectionsByWeek({ roundWeekId: week.id }, { limit: 200 })
  ).data;
  const players = (await client.models.Player.list({ limit: 500 })).data;
  const nameOf = new Map(players.map((player) => [player.id, player.displayName]));
  const fixtures = (
    await client.models.Fixture.listFixturesBySeasonAndMatchday(
      { seasonId: round.seasonId, matchday: { eq: options.matchday } },
      { limit: 100 },
    )
  ).data;
  const firstKickoff =
    fixtures
      .map((fixture) => fixture.utcKickoff)
      .sort()
      .at(0) ?? null;

  console.log(`Round ${round.number} (${round.status})`);
  console.log(
    `  Week ${week.sequenceNumber}: GW${week.matchday}, ${week.status}, deadline ${week.deadline}`,
  );
  console.log(`  ${selections.length} pick(s) would be removed:`);
  for (const selection of selections) {
    console.log(
      `    ${nameOf.get(selection.playerId) ?? selection.playerId}  ${selection.teamName ?? 'no team'}  ${selection.selectionType}  ${selection.outcome}`,
    );
  }
  console.log(`\nGW${options.matchday}: ${fixtures.length} fixture(s), first kick-off ${firstKickoff}`);

  const deadline = options.deadline ?? firstKickoff;
  const deadlinePassed = deadline !== null && new Date(deadline).getTime() <= Date.now();
  console.log(`New deadline: ${deadline}${options.deadline ? ' (override)' : ' (first kick-off)'}`);

  if (deadlinePassed && !options.deadline) {
    console.error(
      `\nGW${options.matchday} has already kicked off. Pass --deadline with a future time, ` +
        'or the scheduler will auto-pick for everyone and apply results within 15 minutes.',
    );
    exit(1);
  }
  if (deadlinePassed) {
    console.warn('\nWarning: the --deadline you gave has already passed.');
  }

  if (!options.commit) {
    console.log('\nDry run. Nothing written. Add --commit to apply.');
    return;
  }

  const response = await client.mutations.adminChangeWeekMatchday({
    roundWeekId: week.id,
    matchday: options.matchday,
    deadline: options.deadline,
    note: options.note,
  });
  if (response.errors?.length) {
    console.error('\nRefused:', response.errors.map((error) => error.message).join('; '));
    exit(1);
  }
  const result = payload<{ ok: boolean; message: string }>(response.data);
  console.log(`\n${result.message}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  exit(1);
});
