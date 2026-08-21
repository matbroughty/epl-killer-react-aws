/**
 * One-time import of the historical `killer.csv`.
 *
 *   npm run import:legacy -- --help
 *
 * Runs as a signed-in administrator against a deployed environment (sandbox or
 * production) and writes through the same authorization rules as the
 * application. Nothing here bypasses the schema.
 *
 * Dry run by default. `--commit` is required to write anything.
 *
 * What it imports, and what it refuses to guess, is documented in the report it
 * writes to `docs/MIGRATION_REPORT.md`. The short version: player names, pick
 * sequences, winners and inferred elimination weeks are recoverable from the
 * file; gameweeks, dates, deadlines, fixtures, scores, entry fees, pot sizes,
 * payment status and the rollover chain are simply not in it, and are left null
 * rather than invented.
 *
 * After this runs the database is authoritative. The application never reads the
 * CSV.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';
import { Amplify } from 'aws-amplify';
import { signIn } from 'aws-amplify/auth';
import { cognitoUserPoolsTokenProvider } from 'aws-amplify/auth/cognito';
import { generateClient } from 'aws-amplify/data';
import type { Schema } from '../amplify/data/resource.js';
import {
  collectLegacyTeams,
  parseKillerCsv,
  type LegacyRound,
  type ParsedKillerCsv,
} from '../shared/legacy/parseKillerCsv.js';

const DEFAULT_CSV_URL = 'https://d2gxtwxranyjlp.cloudfront.net/killer.csv';
const LEGACY_SEASON_NAME = 'Legacy (pre-2025/26)';
const REPORT_PATH = 'docs/MIGRATION_REPORT.md';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Options {
  source: string;
  commit: boolean;
  outputsPath: string;
  reportPath: string;
  /** Skip the newest N blocks — useful when the last round is still live. */
  skipNewest: number;
}

function parseArgs(): Options {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Import the historical killer.csv into the Killer database.

Usage:
  npm run import:legacy -- [options]

Options:
  --source <url|path>   CSV to read. Default: ${DEFAULT_CSV_URL}
  --commit              Actually write. Without this it is a dry run.
  --skip-newest <n>     Ignore the newest n blocks in the file. Use this if the
                        most recent round is still in progress and you would
                        rather start it properly in the application.
  --outputs <path>      amplify_outputs.json location. Default: ./amplify_outputs.json
  --report <path>       Where to write the report. Default: ${REPORT_PATH}
  --help                Show this.

Environment:
  KILLER_ADMIN_EMAIL     Cognito email of an ADMIN user (required to commit)
  KILLER_ADMIN_PASSWORD  that user's password

The admin must have signed in through the website at least once, so their
temporary password has been replaced.
`);
    exit(0);
  }

  const valueOf = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  return {
    source: valueOf('--source') ?? DEFAULT_CSV_URL,
    commit: args.includes('--commit'),
    outputsPath: valueOf('--outputs') ?? 'amplify_outputs.json',
    reportPath: valueOf('--report') ?? REPORT_PATH,
    skipNewest: Number(valueOf('--skip-newest') ?? '0') || 0,
  };
}

// ---------------------------------------------------------------------------
// Amplify in Node
// ---------------------------------------------------------------------------

/**
 * Amplify's token provider expects browser storage. In a script there is none,
 * so give it a map — tokens live for the length of the process and no further,
 * which is what we want for a one-off admin task.
 */
function useInMemoryTokenStorage(): void {
  const store = new Map<string, string>();
  cognitoUserPoolsTokenProvider.setKeyValueStorage({
    setItem: async (key: string, value: string) => {
      store.set(key, value);
    },
    getItem: async (key: string) => store.get(key) ?? null,
    removeItem: async (key: string) => {
      store.delete(key);
    },
    clear: async () => {
      store.clear();
    },
  });
}

async function readSource(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not fetch ${source}: HTTP ${response.status}`);
    return response.text();
  }
  return readFile(source, 'utf8');
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

interface Counters {
  seasons: number;
  teams: number;
  players: number;
  rounds: number;
  weeks: number;
  entries: number;
  selections: number;
}

interface ImportLog {
  counters: Counters;
  notes: string[];
  perRound: {
    number: number;
    fileIndex: number;
    outcome: string;
    winner: string | null;
    weeks: number;
    entrants: number;
    picks: number;
    warnings: string[];
  }[];
}

async function main(): Promise<void> {
  const options = parseArgs();

  console.log(`Reading ${options.source}`);
  const text = await readSource(options.source);
  const parsed = parseKillerCsv(text);

  if (parsed.rounds.length === 0) {
    console.error('No rounds found in the file. Nothing to do.');
    exit(1);
  }

  // `rounds` is oldest-first, so "newest" is the tail.
  const rounds =
    options.skipNewest > 0 ? parsed.rounds.slice(0, -options.skipNewest) : parsed.rounds;

  const teams = collectLegacyTeams(parsed);

  console.log(`\nParsed ${parsed.rounds.length} round(s); importing ${rounds.length}.`);
  console.log(`Players: ${parsed.playerNames.join(', ')}`);
  console.log(`Distinct teams: ${teams.resolved.length}`);
  if (teams.unresolved.length > 0) {
    console.log(`Unresolved team names: ${teams.unresolved.join(', ')}`);
  }
  console.log(`Unresolved cells: ${parsed.unresolvedCells.length}`);

  const log: ImportLog = {
    counters: {
      seasons: 0,
      teams: 0,
      players: 0,
      rounds: 0,
      weeks: 0,
      entries: 0,
      selections: 0,
    },
    notes: [],
    perRound: [],
  };

  if (!options.commit) {
    console.log('\n--- DRY RUN. Nothing will be written. Pass --commit to import. ---\n');
    summarise(rounds, log);
    await writeReport(options.reportPath, parsed, rounds, teams, log, false);
    return;
  }

  // --- Connect -------------------------------------------------------------

  const outputs = JSON.parse(await readFile(options.outputsPath, 'utf8')) as Record<
    string,
    unknown
  >;
  useInMemoryTokenStorage();
  Amplify.configure(outputs as Parameters<typeof Amplify.configure>[0]);

  const email = env['KILLER_ADMIN_EMAIL'];
  const password = env['KILLER_ADMIN_PASSWORD'];
  if (!email || !password) {
    console.error(
      'Set KILLER_ADMIN_EMAIL and KILLER_ADMIN_PASSWORD to an ADMIN Cognito user before committing.',
    );
    exit(1);
  }

  const signInResult = await signIn({ username: email, password });
  if (signInResult.nextStep.signInStep !== 'DONE') {
    console.error(
      `That account needs "${signInResult.nextStep.signInStep}" first. Sign in through the website once, then rerun.`,
    );
    exit(1);
  }
  console.log(`Signed in as ${email}.`);

  const client = generateClient<Schema>({ authMode: 'userPool' });

  // --- Legacy season -------------------------------------------------------
  //
  // Historical picks include teams that are not in the current Premier League
  // (Leeds, Sunderland, Sheffield United and so on). Rather than polluting the
  // live season's twenty teams, they go into their own inactive season. Every
  // legacy selection therefore points at a real Team record, so statistics work
  // across eras without special cases.

  const existingSeasons = await client.models.Season.list({ limit: 50 });
  let legacySeason = existingSeasons.data.find((season) => season.name === LEGACY_SEASON_NAME);

  if (!legacySeason) {
    const created = await client.models.Season.create({
      name: LEGACY_SEASON_NAME,
      startYear: 2000,
      active: false,
      isLegacy: true,
    });
    legacySeason = created.data ?? undefined;
    if (!legacySeason) throw new Error('Could not create the legacy season.');
    log.counters.seasons += 1;
    console.log(`Created season "${LEGACY_SEASON_NAME}".`);
  } else {
    console.log(`Reusing season "${LEGACY_SEASON_NAME}".`);
  }

  const seasonId = legacySeason.id;

  // --- Teams ---------------------------------------------------------------

  const existingTeams = await client.models.Team.listTeamsBySeason(
    { seasonId },
    { limit: 200 },
  );
  const teamIdByCode = new Map(
    existingTeams.data.map((team) => [team.code, team.id] as const),
  );

  for (const team of teams.resolved) {
    if (teamIdByCode.has(team.code)) continue;
    const created = await client.models.Team.create({
      seasonId,
      providerId: null,
      name: team.name,
      shortName: team.name,
      code: team.code,
      badgeUrl: null,
      // Inactive: these must never appear in a live pick list.
      active: false,
    });
    if (created.data) {
      teamIdByCode.set(team.code, created.data.id);
      log.counters.teams += 1;
    }
  }
  console.log(`Teams: ${log.counters.teams} created, ${teamIdByCode.size} available.`);

  // --- Players -------------------------------------------------------------
  //
  // Matched by display name, which is all the file gives us. No email and no
  // Cognito user is invented: an administrator invites the real people
  // separately, and `resolveViewer` links a Player to a Cognito subject on
  // first sign-in.

  const existingPlayers = await client.models.Player.list({ limit: 200 });
  const playerIdByName = new Map(
    existingPlayers.data.map((player) => [player.displayName, player.id] as const),
  );

  for (const name of parsed.playerNames) {
    if (playerIdByName.has(name)) continue;
    const created = await client.models.Player.create({
      displayName: name,
      email: null,
      cognitoUserId: null,
      // Inactive until an administrator invites them, so importing history does
      // not silently enter 11 people into the next live round.
      active: false,
    });
    if (created.data) {
      playerIdByName.set(name, created.data.id);
      log.counters.players += 1;
    }
  }
  console.log(`Players: ${log.counters.players} created, ${playerIdByName.size} available.`);

  // --- Rounds --------------------------------------------------------------

  const existingRounds = await client.models.KillerRound.list({ limit: 200 });
  const highestNumber = existingRounds.data.reduce(
    (highest, round) => Math.max(highest, round.number),
    0,
  );
  const alreadyImported = new Set(
    existingRounds.data
      .filter((round) => round.dataSource === 'LEGACY_CSV')
      .map((round) => round.notes?.match(/csvBlock=(\d+)/)?.[1])
      .filter((value): value is string => Boolean(value)),
  );

  let nextNumber = highestNumber + 1;

  for (const round of rounds) {
    if (alreadyImported.has(String(round.fileIndex))) {
      console.log(`Skipping block ${round.fileIndex}: already imported.`);
      continue;
    }

    const number = nextNumber;
    nextNumber += 1;

    const status =
      round.outcome === 'WON' ? 'WON' : round.outcome === 'ROLLOVER' ? 'ROLLOVER' : 'ABANDONED';

    const winnerPlayerId = round.winnerDisplayName
      ? (playerIdByName.get(round.winnerDisplayName) ?? null)
      : null;

    const notes = [
      `Imported from killer.csv (csvBlock=${round.fileIndex}, line ${round.firstLine}).`,
      'Gameweeks, dates, deadlines, fixtures, scores, entry fee, pot size, payment status and the rollover chain were not recorded in the source and are not set.',
      ...round.warnings,
    ].join(' ');

    const createdRound = await client.models.KillerRound.create({
      seasonId,
      number,
      status,
      // Zero rather than £5: the file records no money at all, and a plausible
      // guess here would show up as a real pot on the history page.
      entryFeePence: 0,
      rolloverInPence: 0,
      rolloverOutPence: 0,
      winnerPlayerId,
      previousRoundId: null,
      startedAt: null,
      completedAt: null,
      dataSource: 'LEGACY_CSV',
      notes,
    });

    const killerRoundId = createdRound.data?.id;
    if (!killerRoundId) {
      console.error(`Could not create round for block ${round.fileIndex}; skipping.`);
      continue;
    }
    log.counters.rounds += 1;

    // Weeks. `matchday` and `deadline` stay null, which is why the domain treats
    // a week with no deadline as never open.
    const weekIdBySequence = new Map<number, string>();
    for (let sequence = 1; sequence <= round.weekCount; sequence += 1) {
      const createdWeek = await client.models.RoundWeek.create({
        killerRoundId,
        sequenceNumber: sequence,
        matchday: null,
        deadline: null,
        deadlineSource: null,
        status: 'COMPLETE',
      });
      if (createdWeek.data) {
        weekIdBySequence.set(sequence, createdWeek.data.id);
        log.counters.weeks += 1;
      }
    }

    // Entries and selections.
    let picksWritten = 0;
    let entrantsWritten = 0;

    for (const entrant of round.entrants) {
      if (entrant.didNotEnter) continue;

      const playerId = playerIdByName.get(entrant.displayName);
      if (!playerId) {
        log.notes.push(
          `Round ${number}: no player record for "${entrant.displayName}"; their picks were skipped.`,
        );
        continue;
      }

      const eliminatedWeekId =
        entrant.eliminatedInWeek !== null
          ? (weekIdBySequence.get(entrant.eliminatedInWeek) ?? null)
          : null;

      const createdEntry = await client.models.RoundEntry.create({
        killerRoundId,
        playerId,
        status: entrant.won ? 'WINNER' : eliminatedWeekId ? 'ELIMINATED' : 'ELIMINATED',
        // The file records no payments. `false` here means "not recorded",
        // which with a £0 fee cannot mislead anybody about money owed.
        paid: false,
        paidAt: null,
        paidBy: null,
        entryFeePence: 0,
        eliminatedRoundWeekId: eliminatedWeekId,
      });

      const roundEntryId = createdEntry.data?.id;
      if (!roundEntryId) continue;
      log.counters.entries += 1;
      entrantsWritten += 1;

      for (const pick of entrant.picks) {
        const roundWeekId = weekIdBySequence.get(pick.week);
        if (!roundWeekId) continue;

        const teamId = pick.teamCode ? (teamIdByCode.get(pick.teamCode) ?? null) : null;

        // Outcome inference: a pick they played on from was survived; their last
        // pick, where somebody carried on afterwards, eliminated them. A `?`
        // cell stays UNKNOWN because the source genuinely does not say.
        const outcome = pick.unknown
          ? 'UNKNOWN'
          : entrant.eliminatedInWeek === pick.week
            ? 'ELIMINATED'
            : entrant.eliminatedInWeek === null && pick.week === entrant.picks.at(-1)?.week && !entrant.won
              ? 'UNKNOWN'
              : 'SURVIVED';

        await client.models.Selection.create({
          id: `${roundWeekId}#${roundEntryId}`,
          roundWeekId,
          roundEntryId,
          killerRoundId,
          playerId,
          teamId,
          teamName: pick.teamName,
          teamCode: pick.teamCode,
          selectionType: 'LEGACY',
          // No timestamps exist in the source. Epoch marks these clearly as
          // imported rather than pretending to a real time.
          selectedAt: '1970-01-01T00:00:00.000Z',
          lockedAt: '1970-01-01T00:00:00.000Z',
          outcome,
          overridden: false,
          overrideNote: pick.ambiguous
            ? `Source cell recorded more than one team: "${pick.raw}". The first was taken.`
            : null,
          fixtureId: null,
          standingsSnapshotId: null,
          autoReason: null,
          autoNote: null,
          resolvedAt: null,
        });

        log.counters.selections += 1;
        picksWritten += 1;
      }
    }

    log.perRound.push({
      number,
      fileIndex: round.fileIndex,
      outcome: status,
      winner: round.winnerDisplayName,
      weeks: round.weekCount,
      entrants: entrantsWritten,
      picks: picksWritten,
      warnings: round.warnings,
    });

    console.log(
      `Round ${number} (block ${round.fileIndex}): ${status}${round.winnerDisplayName ? ` — ${round.winnerDisplayName}` : ''}, ${round.weekCount} week(s), ${entrantsWritten} entrant(s), ${picksWritten} pick(s).`,
    );
  }

  console.log('\nDone.');
  console.table(log.counters);

  await writeReport(options.reportPath, parsed, rounds, teams, log, true);
  console.log(`Report written to ${options.reportPath}`);
}

function summarise(rounds: LegacyRound[], log: ImportLog): void {
  for (const round of rounds) {
    const entrants = round.entrants.filter((entrant) => !entrant.didNotEnter);
    const picks = entrants.reduce((total, entrant) => total + entrant.picks.length, 0);
    log.perRound.push({
      number: 0,
      fileIndex: round.fileIndex,
      outcome: round.outcome,
      winner: round.winnerDisplayName,
      weeks: round.weekCount,
      entrants: entrants.length,
      picks,
      warnings: round.warnings,
    });
    console.log(
      `block ${String(round.fileIndex).padStart(2)}: ${round.outcome.padEnd(8)} ${(round.winnerDisplayName ?? '-').padEnd(8)} ${round.weekCount} week(s), ${entrants.length} entrant(s), ${picks} pick(s)${round.warnings.length > 0 ? '  ⚠' : ''}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

async function writeReport(
  path: string,
  parsed: ParsedKillerCsv,
  imported: LegacyRound[],
  teams: ReturnType<typeof collectLegacyTeams>,
  log: ImportLog,
  committed: boolean,
): Promise<void> {
  const ambiguous = imported.filter((round) =>
    round.warnings.some((warning) => warning.includes('AMBIGUOUS_COLUMNS')),
  );
  const unknownOutcome = imported.filter((round) => round.outcome === 'UNKNOWN');

  const lines = [
    '# Legacy CSV migration report',
    '',
    committed
      ? 'This import has been **committed**. The database is authoritative from here; the application never reads the CSV.'
      : 'This was a **dry run**. Nothing was written.',
    '',
    '## Source',
    '',
    '`https://d2gxtwxranyjlp.cloudfront.net/killer.csv`',
    '',
    `- ${parsed.playerNames.length} player names: ${parsed.playerNames.join(', ')}`,
    `- ${parsed.rounds.length} round blocks found, ${imported.length} imported`,
    `- ${teams.resolved.length} distinct teams resolved`,
    `- ${parsed.unresolvedCells.length} cell(s) could not be resolved to a team`,
    '',
    '## What was imported',
    '',
    '| Data | Source |',
    '| --- | --- |',
    '| Player display names | CSV header row |',
    '| Ordered pick sequences per player per round | one row per Round Week |',
    '| Round winners | the `+` mark, placed in the winner\'s column on the row after their last pick |',
    '| Round outcome (won / rollover) | `+` present, or a final row entirely `x` |',
    '| Elimination week | a player\'s last pick, where others played on afterwards |',
    '| Round order | reverse file order — the file runs newest first |',
    '',
    '## What was NOT imported, and why',
    '',
    'These are absent from the source. They are stored as null rather than guessed, because a plausible-looking',
    'invented value is worse than an obvious gap:',
    '',
    '- **EPL gameweek / matchday** — never recorded. `RoundWeek.matchday` is null.',
    '- **Dates, kick-off times, selection deadlines** — never recorded. `RoundWeek.deadline` is null, which the',
    '  domain treats as "never open", so no imported week can accept a pick.',
    '- **Fixtures and scores** — never recorded. Outcomes are inferred from the pick sequence, not from results.',
    '- **Entry fees and pot sizes** — never recorded. `entryFeePence` is **0**, not £5, so the history page shows',
    '  `—` instead of a fabricated pot.',
    '- **Payment status** — never recorded. `paid` is false, meaning "not recorded"; with a £0 fee this cannot',
    '  misrepresent money owed.',
    '- **Rollover amounts and the rollover chain** — never recorded. `previousRoundId` is null on every imported',
    '  round, so no money trail is implied between them.',
    '- **Manual versus automatic picks** — never distinguished. Every imported pick is `selectionType: LEGACY`.',
    '- **Selection timestamps** — never recorded. `selectedAt` is the epoch, which marks these unmistakably as',
    '  imported.',
    '',
    '## Assumptions and data quality',
    '',
    `### Ambiguous column mapping (${ambiguous.length} round(s))`,
    '',
    'The oldest blocks have fewer columns than the 11-name header, because fewer people played then. The file does',
    'not record which names those columns belonged to. Columns were mapped **left-to-right against the header**,',
    'which is the only available ordering but is an assumption, not a fact. Affected rounds carry',
    '`AMBIGUOUS_COLUMNS` in their notes:',
    '',
    ...(ambiguous.length > 0
      ? ambiguous.map(
          (round) =>
            `- block ${round.fileIndex}: ${round.columnCount} columns against ${parsed.playerNames.length} names`,
        )
      : ['- none']),
    '',
    `### Undetermined outcomes (${unknownOutcome.length} round(s))`,
    '',
    'Blocks with no `+` and no all-`x` final row. Most likely rounds still in progress when the spreadsheet was',
    'retired. Imported as `ABANDONED` with an explanatory note rather than being forced into a winner or a rollover:',
    '',
    ...(unknownOutcome.length > 0
      ? unknownOutcome.map((round) => `- block ${round.fileIndex}, ${round.weekCount} week(s)`)
      : ['- none']),
    '',
    '### Normalised spellings',
    '',
    'A decade of typing produced `Necastle`, `Newastle`, `Forrest`, `Liecester`, `ManCity`, `Man U`, `Sheff Utd`',
    'and `City`. These were resolved through `shared/domain/teamNames.ts`, which is tested against exactly these',
    'cases. One cell, `Liverpool(Southampton)`, recorded two teams; the first was taken and the full original',
    'string is preserved in the selection\'s override note.',
    '',
    '### Row width',
    '',
    'One row carries a trailing comma, producing 12 fields against 11 names. The extra field was ignored, matching',
    'what the previous application did.',
    '',
    '### Unresolved cells',
    '',
    ...(parsed.unresolvedCells.length > 0
      ? parsed.unresolvedCells.map(
          (cell) =>
            `- block ${cell.round}, week ${cell.week}, ${cell.player}: \`${cell.raw}\` — stored with a null team`,
        )
      : ['None. Every non-empty cell resolved to a known team.']),
    '',
    '## Legacy teams',
    '',
    `Historical picks include clubs that are not in the current Premier League. Rather than adding them to the live`,
    `season's twenty, they live in a season named \`${LEGACY_SEASON_NAME}\` with \`isLegacy: true\` and`,
    '`active: false`. Every legacy selection therefore points at a real Team record — so statistics work across',
    'eras — while none of them can appear in a live pick list.',
    '',
    teams.resolved.map((team) => `${team.code} (${team.name})`).join(', '),
    '',
    '## Imported players',
    '',
    'Created with `active: false` and no email or Cognito link. Importing history must not silently enter eleven',
    'people into the next live round; an administrator invites the real people through the admin area, and',
    '`resolveViewer` links a Player to their Cognito subject the first time they sign in.',
    '',
    ...(log.perRound.length > 0
      ? [
          '## Rounds',
          '',
          '| Round | CSV block | Outcome | Winner | Weeks | Entrants | Picks |',
          '| --- | --- | --- | --- | --- | --- | --- |',
          ...log.perRound.map(
            (round) =>
              `| ${round.number || '—'} | ${round.fileIndex} | ${round.outcome} | ${round.winner ?? '—'} | ${round.weeks} | ${round.entrants} | ${round.picks} |`,
          ),
          '',
        ]
      : []),
    ...(committed
      ? [
          '## Records written',
          '',
          '| Model | Count |',
          '| --- | --- |',
          ...Object.entries(log.counters).map(([model, count]) => `| ${model} | ${count} |`),
          '',
        ]
      : []),
    ...(log.notes.length > 0 ? ['## Notes', '', ...log.notes.map((note) => `- ${note}`), ''] : []),
    '## Re-running',
    '',
    'Each imported round records `csvBlock=<n>` in its notes, and the importer skips blocks it has already done, so',
    'rerunning it does not duplicate history.',
    '',
  ];

  await writeFile(path, lines.join('\n'), 'utf8');
}

main().catch((error: unknown) => {
  console.error('\nImport failed:', error instanceof Error ? error.message : error);
  exit(1);
});
