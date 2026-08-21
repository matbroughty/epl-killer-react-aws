import { hasParentheticalAlternative, resolveTeamName } from '../domain/teamNames.js';

/**
 * Parser for the historical `killer.csv`.
 *
 * The file is a decade of hand-maintained spreadsheet, and the shape is:
 *
 *   Mat,Jase,Pia,Jon,Frank,...           <- header: player display names
 *   Arsenal,Brentford,Man City,...       <- round week 1, one pick per player
 *   Fulham,x,x,x,Fulham,...              <- round week 2
 *   ---,---,---,---,---,...              <- block separator
 *   ...                                  <- the next (older) Killer Round
 *
 * with `x` meaning no pick, `+` marking the winner on the row *after* their last
 * surviving pick, and `?` meaning nobody wrote it down. Blocks run newest first.
 *
 * Everything this parser cannot know for certain, it reports rather than guesses.
 * The importer turns those reports into notes on the records it writes, so the
 * limits of the imported history stay visible in the application.
 */

export const NO_PICK = 'x';
export const WINNER_MARK = '+';
export const UNKNOWN_MARK = '?';
export const SEPARATOR = '---';

export interface LegacyPick {
  /** 1-based Round Week within the block. */
  week: number;
  /** Raw cell contents, for the audit trail. */
  raw: string;
  /** Canonical team name, or null when it could not be resolved. */
  teamName: string | null;
  teamCode: string | null;
  /** `?` in the source: a pick was made but not recorded. */
  unknown: boolean;
  /** The cell held two names, e.g. `Liverpool(Southampton)`. */
  ambiguous: boolean;
}

export interface LegacyEntrant {
  displayName: string;
  /** Column index in the source, kept so problems can be traced back. */
  column: number;
  picks: LegacyPick[];
  /** True when this column carried the `+` winner mark. */
  won: boolean;
  /**
   * The week whose pick knocked them out, if we can tell: their last pick,
   * when they did not win and somebody else was still playing afterwards.
   */
  eliminatedInWeek: number | null;
  /** True when the column was entirely `x` — they sat the round out. */
  didNotEnter: boolean;
}

export type LegacyOutcome = 'WON' | 'ROLLOVER' | 'UNKNOWN';

export interface LegacyRound {
  /** Position in the file, 0 = the topmost (most recent) block. */
  fileIndex: number;
  /** 1-based line number of the block's first row, for error messages. */
  firstLine: number;
  weekCount: number;
  entrants: LegacyEntrant[];
  outcome: LegacyOutcome;
  winnerDisplayName: string | null;
  /** Column count in this block, when it differs from the header width. */
  columnCount: number;
  /** Problems worth recording on the imported round. */
  warnings: string[];
}

export interface ParsedKillerCsv {
  playerNames: string[];
  /** Oldest first, so round numbering runs forwards. */
  rounds: LegacyRound[];
  warnings: string[];
  /** Every cell that could not be resolved to a team, with where it came from. */
  unresolvedCells: { round: number; week: number; player: string; raw: string }[];
}

/** Split on commas and trim. The file has no quoted fields or embedded commas. */
function splitRow(line: string): string[] {
  return line.split(',').map((cell) => cell.trim());
}

function isSeparator(cells: string[]): boolean {
  const meaningful = cells.filter((cell) => cell !== '');
  return meaningful.length > 0 && meaningful.every((cell) => cell === SEPARATOR);
}

function isBlank(cells: string[]): boolean {
  return cells.every((cell) => cell === '');
}

export function parseKillerCsv(text: string): ParsedKillerCsv {
  const warnings: string[] = [];
  const unresolvedCells: ParsedKillerCsv['unresolvedCells'] = [];

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const firstContent = lines.findIndex((line) => line.trim() !== '');
  if (firstContent === -1) {
    return { playerNames: [], rounds: [], warnings: ['The file is empty.'], unresolvedCells: [] };
  }

  const playerNames = splitRow(lines[firstContent]!).filter((name) => name !== '');
  const width = playerNames.length;

  // Group the remaining rows into blocks.
  const blocks: { rows: string[][]; firstLine: number }[] = [];
  let current: string[][] = [];
  let currentFirstLine = firstContent + 2;

  for (let index = firstContent + 1; index < lines.length; index += 1) {
    const cells = splitRow(lines[index]!);

    if (isBlank(cells)) continue;

    if (isSeparator(cells)) {
      if (current.length > 0) blocks.push({ rows: current, firstLine: currentFirstLine });
      current = [];
      currentFirstLine = index + 2;
      continue;
    }
    current.push(cells);
  }
  if (current.length > 0) blocks.push({ rows: current, firstLine: currentFirstLine });

  const rounds = blocks.map((block, fileIndex) =>
    parseBlock(block, fileIndex, playerNames, width, unresolvedCells),
  );

  // The file runs newest first; reverse so round 1 is the oldest.
  rounds.reverse();

  return { playerNames, rounds, warnings, unresolvedCells };
}

function parseBlock(
  block: { rows: string[][]; firstLine: number },
  fileIndex: number,
  playerNames: string[],
  width: number,
  unresolvedCells: ParsedKillerCsv['unresolvedCells'],
): LegacyRound {
  const blockWarnings: string[] = [];

  // Rows vary in length: a trailing comma inflates one, and older blocks were
  // written when fewer people played. Take the widest row as the block's width.
  const widest = block.rows.reduce((most, row) => Math.max(most, row.length), 0);

  if (widest > width) {
    blockWarnings.push(
      `A row had ${widest} fields against ${width} player names (a stray trailing comma); the extra fields were ignored.`,
    );
  }

  const columnCount = Math.min(widest, width);
  if (columnCount < width) {
    // The significant ambiguity in the whole import. Columns are mapped
    // left-to-right against the header, which is the only ordering available —
    // but the file does not actually say who the columns belonged to.
    blockWarnings.push(
      `AMBIGUOUS_COLUMNS: this round has ${columnCount} columns against ${width} player names. Columns were mapped left-to-right to the first ${columnCount} names; the association is an assumption, not recorded in the source.`,
    );
  }

  const weekCount = block.rows.length;
  const entrants: LegacyEntrant[] = [];
  let winnerDisplayName: string | null = null;

  for (let column = 0; column < columnCount; column += 1) {
    const displayName = playerNames[column]!;
    const picks: LegacyPick[] = [];
    let won = false;

    for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
      const raw = block.rows[rowIndex]?.[column] ?? '';
      const week = rowIndex + 1;

      if (raw === WINNER_MARK) {
        won = true;
        winnerDisplayName = displayName;
        continue;
      }
      if (raw === '' || raw.toLowerCase() === NO_PICK) continue;

      if (raw === UNKNOWN_MARK) {
        picks.push({ week, raw, teamName: null, teamCode: null, unknown: true, ambiguous: false });
        continue;
      }

      const resolved = resolveTeamName(raw);
      const ambiguous = hasParentheticalAlternative(raw);

      if (!resolved) {
        unresolvedCells.push({ round: fileIndex, week, player: displayName, raw });
      }

      picks.push({
        week,
        raw,
        teamName: resolved?.name ?? null,
        teamCode: resolved?.code ?? null,
        unknown: false,
        ambiguous,
      });
    }

    entrants.push({
      displayName,
      column,
      picks,
      won,
      eliminatedInWeek: null,
      didNotEnter: picks.length === 0 && !won,
    });
  }

  // Work out who went out when. A player's last pick is the one that knocked
  // them out — unless they won, or unless nobody carried on after them, in which
  // case the round simply ended.
  const lastWeekWithAnyPick = entrants.reduce(
    (latest, entrant) => Math.max(latest, entrant.picks.at(-1)?.week ?? 0),
    0,
  );

  for (const entrant of entrants) {
    const lastPick = entrant.picks.at(-1);
    if (entrant.won || entrant.didNotEnter || !lastPick) continue;
    if (lastPick.week < lastWeekWithAnyPick) entrant.eliminatedInWeek = lastPick.week;
  }

  const outcome = inferOutcome(entrants, winnerDisplayName, block.rows);

  if (outcome === 'UNKNOWN') {
    blockWarnings.push(
      'The outcome could not be inferred: no winner mark, and the final week does not show everybody eliminated. This is most likely a round that was still in progress when the spreadsheet was retired.',
    );
  }

  return {
    fileIndex,
    firstLine: block.firstLine,
    weekCount,
    entrants,
    outcome,
    winnerDisplayName,
    columnCount,
    warnings: blockWarnings,
  };
}

/**
 * What happened to this round?
 *
 * A `+` means somebody won it. Otherwise, if the final row is entirely `x` then
 * everyone left went out together, which is a rollover. Anything else we decline
 * to name.
 */
function inferOutcome(
  entrants: LegacyEntrant[],
  winnerDisplayName: string | null,
  rows: string[][],
): LegacyOutcome {
  if (winnerDisplayName) return 'WON';

  const lastRow = rows.at(-1) ?? [];
  const allOut =
    lastRow.length > 0 &&
    lastRow.every((cell) => cell === '' || cell.toLowerCase() === NO_PICK);

  // A trailing `?` row means somebody's pick was never written down, so we
  // cannot claim everybody was eliminated.
  const anyUnknown = entrants.some((entrant) =>
    entrant.picks.some((pick) => pick.unknown),
  );

  if (allOut && !anyUnknown) return 'ROLLOVER';
  return 'UNKNOWN';
}

/**
 * Every distinct team name the file mentions, resolved where possible.
 *
 * The importer uses this to build a legacy `Season` containing every team that
 * has ever been picked, so historical selections always point at a real team
 * record and statistics work across eras.
 */
export function collectLegacyTeams(parsed: ParsedKillerCsv): {
  resolved: { name: string; code: string }[];
  unresolved: string[];
} {
  const resolved = new Map<string, { name: string; code: string }>();
  const unresolved = new Set<string>();

  for (const round of parsed.rounds) {
    for (const entrant of round.entrants) {
      for (const pick of entrant.picks) {
        if (pick.unknown) continue;
        if (pick.teamName && pick.teamCode) {
          resolved.set(pick.teamCode, { name: pick.teamName, code: pick.teamCode });
        } else {
          unresolved.add(pick.raw);
        }
      }
    }
  }

  return {
    resolved: [...resolved.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-GB')),
    unresolved: [...unresolved].sort(),
  };
}
