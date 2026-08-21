/**
 * Bulk entry of players, payments and picks.
 *
 *   npm run bulk -- --help
 *
 * Picks arrive in a WhatsApp group, not through the app. This turns a plain text
 * list into players, round entries, payment flags and selections, going through
 * the same admin mutations the UI calls — so the same rules apply. Nothing here
 * writes to DynamoDB directly and nothing bypasses `validateSelection`.
 *
 * Dry run by default. `--commit` is required to write.
 *
 * Input is one player per line, comma separated:
 *
 *   name, email, team, paid
 *   Alice, alice@example.com, Brighton, yes
 *   Bob Smith, bob@example.com, Man United, no
 *   Carol, carol@example.com, , yes            <- blank team: entered, no pick
 *
 * Keep real lists out of the repository — `picks-*.txt` is gitignored for that
 * reason, since these files hold everybody's email address.
 *
 * `team` may be blank when somebody has not sent theirs in yet — they are still
 * entered and still owe the fee, and the deadline processor will assign them a
 * team if they never reply. Team names are loose: `Man U`, `Spurs` and
 * `Newcastle` all resolve.
 *
 * `paid` accepts yes/no/y/n/true/false and defaults to no.
 */

import { readFile } from 'node:fs/promises';
import { argv, exit } from 'node:process';
import { resolveTeamName } from '../shared/domain/teamNames.js';
import { openAdminSession, payload } from './adminSession.js';

interface Row {
  line: number;
  name: string;
  email: string;
  team: string;
  paid: boolean;
}

interface Options {
  file: string;
  commit: boolean;
  outputsPath: string;
  matchday: number | null;
  roundId: string | null;
  email: string | null;
}

function parseArgs(): Options {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Bulk-enter players, payments and picks from a text list.

Usage:
  npm run bulk -- --file picks.txt [--commit]

Options:
  --file <path>     Input list (required). See the header of this script.
  --commit          Actually write. Without it, a dry run.
  --matchday <n>    Target gameweek. Default: the round's open week.
  --round <id>      Killer Round id. Default: the active round.
  --outputs <path>  amplify_outputs.json. Default: ./amplify_outputs.json
  --email <address> Admin email. Otherwise KILLER_ADMIN_EMAIL, otherwise asked.
  --help

The password is asked for at a hidden prompt. Set KILLER_ADMIN_PASSWORD to skip
that, but be aware an inline assignment lands in your shell history.
`);
    exit(0);
  }
  const valueOf = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const file = valueOf('--file');
  if (!file) {
    console.error('--file is required. Use --help for the format.');
    exit(1);
  }
  const matchday = valueOf('--matchday');
  return {
    file,
    commit: args.includes('--commit'),
    outputsPath: valueOf('--outputs') ?? 'amplify_outputs.json',
    matchday: matchday ? Number(matchday) : null,
    roundId: valueOf('--round') ?? null,
    email: valueOf('--email') ?? null,
  };
}

function parseRows(text: string): { rows: Row[]; problems: string[] } {
  const rows: Row[] = [];
  const problems: string[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    // Blank lines and `#` comments are ignored, so the file can be annotated.
    if (!trimmed || trimmed.startsWith('#')) return;

    const parts = trimmed.split(',').map((part) => part.trim());
    const [name, email, team = '', paid = ''] = parts;

    if (!name || !email) {
      problems.push(`line ${line}: needs at least "name, email" — got "${trimmed}"`);
      return;
    }
    if (!email.includes('@')) {
      problems.push(`line ${line}: "${email}" is not an email address`);
      return;
    }
    if (team && !resolveTeamName(team)) {
      // Refuse rather than guess: an unrecognised team must not silently become
      // no pick, because the deadline processor would then assign one.
      problems.push(`line ${line}: team "${team}" not recognised (${name})`);
      return;
    }

    rows.push({
      line,
      name,
      email: email.toLowerCase(),
      team,
      paid: /^(y|yes|true|1|paid)$/i.test(paid),
    });
  });

  return { rows, problems };
}

async function main(): Promise<void> {
  const options = parseArgs();
  const { rows, problems } = parseRows(await readFile(options.file, 'utf8'));

  console.log(`Parsed ${rows.length} player(s) from ${options.file}`);
  for (const row of rows) {
    console.log(
      `  ${row.name.padEnd(12)} ${row.email.padEnd(38)} ${(row.team || '(no pick)').padEnd(18)} ${row.paid ? 'paid' : 'NOT PAID'}`,
    );
  }
  if (problems.length > 0) {
    console.log('\nProblems (these rows are skipped):');
    for (const problem of problems) console.log('  !', problem);
  }

  const withoutPick = rows.filter((row) => !row.team);
  if (withoutPick.length > 0) {
    console.log(
      `\n${withoutPick.length} player(s) have no pick: ${withoutPick.map((r) => r.name).join(', ')}`,
    );
    console.log(
      '  They will be entered and will owe the fee. If they never send one, the deadline',
      '\n  processor assigns the lowest-placed eligible team.',
    );
  }

  if (!options.commit) {
    console.log('\n--- DRY RUN. Nothing written. Pass --commit to apply. ---');
    return;
  }
  if (problems.length > 0) {
    console.error('\nRefusing to commit while rows have problems. Fix them or remove them.');
    exit(1);
  }

  // --- Connect -------------------------------------------------------------

  const { client } = await openAdminSession(options.outputsPath, options.email);

  // --- Target round and week ----------------------------------------------

  const rounds = await client.models.KillerRound.list({ limit: 200 });
  const round = options.roundId
    ? rounds.data.find((candidate) => candidate.id === options.roundId)
    : rounds.data
        .filter((candidate) => candidate.status === 'ACTIVE')
        .sort((a, b) => b.number - a.number)[0];

  if (!round) {
    console.error('No active Killer Round found. Start one first, or pass --round.');
    exit(1);
  }

  const weeks = await client.models.RoundWeek.listWeeksByRound(
    { killerRoundId: round.id },
    { limit: 100 },
  );
  const week = options.matchday
    ? weeks.data.find((candidate) => candidate.matchday === options.matchday)
    : (weeks.data.find((candidate) => candidate.status === 'OPEN') ??
      weeks.data.sort((a, b) => b.sequenceNumber - a.sequenceNumber)[0]);

  if (!week) {
    console.error('No Round Week found. Add one first, or pass --matchday.');
    exit(1);
  }

  console.log(
    `Round ${round.number} (${round.status}), week ${week.sequenceNumber} GW${week.matchday}, deadline ${week.deadline}\n`,
  );

  // --- Teams, for name resolution -----------------------------------------

  const teams = await client.models.Team.listTeamsBySeason(
    { seasonId: round.seasonId },
    { limit: 200 },
  );
  const teamIdByCode = new Map(
    teams.data.filter((team) => team.active).map((team) => [team.code, team.id] as const),
  );

  // --- Apply ---------------------------------------------------------------

  let created = 0;
  let entered = 0;
  let picked = 0;
  let paidSet = 0;
  const failures: string[] = [];

  for (const row of rows) {
    // 1. Player. `adminInvitePlayer` matches on email and updates rather than
    //    duplicating, so this is safe to re-run. `sendInvite: false` means no
    //    Cognito user and no email — access is rolled out separately.
    try {
      const result = payload<{ ok: boolean; playerId: string; message: string }>(
        (await client.mutations.adminInvitePlayer({
          displayName: row.name,
          email: row.email,
          makeAdmin: false,
          sendInvite: false,
        })).data,
      );
      if (!result.ok) throw new Error(result.message);
      created += 1;

      // 2. Entrant.
      const entrant = payload<{ ok: boolean; message: string }>(
        (await client.mutations.adminSetEntrant({
          killerRoundId: round.id,
          playerId: result.playerId,
          entered: true,
        })).data,
      );
      if (entrant.ok) entered += 1;

      // 3. Payment. Needs the entry id, so re-read after entering.
      const entries = await client.models.RoundEntry.listEntriesByRound(
        { killerRoundId: round.id },
        { limit: 200 },
      );
      const entry = entries.data.find((candidate) => candidate.playerId === result.playerId);

      if (entry && entry.paid !== row.paid) {
        const paidResult = payload<{ ok: boolean }>(
          (await client.mutations.adminSetPaid({ roundEntryId: entry.id, paid: row.paid })).data,
        );
        if (paidResult.ok) paidSet += 1;
      }

      // 4. Pick, when one was given.
      if (row.team) {
        const canonical = resolveTeamName(row.team);
        const teamId = canonical ? teamIdByCode.get(canonical.code) : undefined;
        if (!teamId) {
          failures.push(`${row.name}: "${row.team}" resolved to ${canonical?.code} but that team is not in this season`);
        } else {
          const pick = payload<{ ok: boolean; message: string }>(
            (await client.mutations.adminSubmitSelectionFor({
              roundWeekId: week.id,
              playerId: result.playerId,
              teamId,
              allowAfterDeadline: true,
            })).data,
          );
          if (pick.ok) {
            picked += 1;
            console.log(`  ✓ ${pick.message}`);
          } else {
            failures.push(`${row.name}: ${pick.message}`);
          }
        }
      } else {
        console.log(`  – ${row.name}: entered, no pick`);
      }
    } catch (error) {
      failures.push(`${row.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(
    `\nPlayers ${created}, entrants ${entered}, payments set ${paidSet}, picks ${picked}.`,
  );
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const failure of failures) console.log('  !', failure);
    exit(1);
  }
}

main().catch((error: unknown) => {
  console.error('\nFailed:', error instanceof Error ? error.message : error);
  exit(1);
});
