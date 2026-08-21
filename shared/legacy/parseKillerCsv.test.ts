import { describe, expect, it } from 'vitest';
import { collectLegacyTeams, parseKillerCsv } from './parseKillerCsv.js';

/**
 * Tests written against the shapes actually present in the live
 * `killer.csv` — including its mistakes, because those are the cases that
 * decide whether the import is trustworthy.
 */

const HEADER = 'Mat,Jase,Pia,Jon,Frank';

function csv(...lines: string[]): string {
  return [HEADER, ...lines].join('\n');
}

describe('parseKillerCsv', () => {
  it('reads the player names from the header', () => {
    const parsed = parseKillerCsv(csv('Arsenal,Chelsea,Liverpool,Everton,Fulham'));
    expect(parsed.playerNames).toEqual(['Mat', 'Jase', 'Pia', 'Jon', 'Frank']);
  });

  it('splits blocks on the separator row and reverses to oldest first', () => {
    const parsed = parseKillerCsv(
      csv(
        'Arsenal,Arsenal,Arsenal,Arsenal,Arsenal',
        '---,---,---,---,---',
        'Chelsea,Chelsea,Chelsea,Chelsea,Chelsea',
      ),
    );

    expect(parsed.rounds).toHaveLength(2);
    // The file is newest first, so the *older* block comes out first.
    expect(parsed.rounds[0]!.entrants[0]!.picks[0]!.teamName).toBe('Chelsea');
    expect(parsed.rounds[1]!.entrants[0]!.picks[0]!.teamName).toBe('Arsenal');
  });

  it('treats x as no pick and ignores blank cells', () => {
    const parsed = parseKillerCsv(csv('Arsenal,x,X,,Fulham'));
    const picks = parsed.rounds[0]!.entrants.map((entrant) => entrant.picks.length);
    expect(picks).toEqual([1, 0, 0, 0, 1]);
  });

  it('marks a column that never picked as not having entered', () => {
    const parsed = parseKillerCsv(csv('Arsenal,x,Liverpool,x,Fulham', 'Chelsea,x,x,x,x'));
    const jase = parsed.rounds[0]!.entrants[1]!;
    expect(jase.didNotEnter).toBe(true);
  });

  it('reads the + mark as the winner, on the row after their last pick', () => {
    const parsed = parseKillerCsv(
      csv(
        'Arsenal,Chelsea,Liverpool,Everton,Fulham',
        'Chelsea,x,Arsenal,x,x',
        'x,x,+,x,x',
      ),
    );

    const round = parsed.rounds[0]!;
    expect(round.outcome).toBe('WON');
    expect(round.winnerDisplayName).toBe('Pia');
    expect(round.entrants[2]!.won).toBe(true);
    // The mark is not a pick.
    expect(round.entrants[2]!.picks.map((pick) => pick.teamName)).toEqual([
      'Liverpool',
      'Arsenal',
    ]);
  });

  it('infers a rollover when the last row is entirely x', () => {
    const parsed = parseKillerCsv(
      csv('Arsenal,Chelsea,x,x,x', 'Everton,Everton,x,x,x', 'x,x,x,x,x'),
    );
    expect(parsed.rounds[0]!.outcome).toBe('ROLLOVER');
    expect(parsed.rounds[0]!.winnerDisplayName).toBeNull();
  });

  it('declines to infer an outcome for a round still in progress', () => {
    // The top block of the real file: no winner, and a trailing `?` row.
    const parsed = parseKillerCsv(
      csv('Arsenal,Chelsea,x,x,Fulham', 'Fulham,x,x,x,Liverpool', '?,x,x,x,?'),
    );
    const round = parsed.rounds[0]!;
    expect(round.outcome).toBe('UNKNOWN');
    expect(round.warnings.join(' ')).toContain('could not be inferred');
  });

  it('records ? as a pick that was made but never written down', () => {
    const parsed = parseKillerCsv(csv('?,Chelsea,x,x,x'));
    const pick = parsed.rounds[0]!.entrants[0]!.picks[0]!;
    expect(pick).toMatchObject({ unknown: true, teamName: null, raw: '?' });
  });

  it('works out the week each player was eliminated', () => {
    const parsed = parseKillerCsv(
      csv(
        'Arsenal,Chelsea,Liverpool,Everton,Fulham',
        'Chelsea,x,Arsenal,Everton,x',
        'x,x,Chelsea,x,x',
        'x,x,+,x,x',
      ),
    );

    const round = parsed.rounds[0]!;
    const byName = new Map(round.entrants.map((entrant) => [entrant.displayName, entrant]));

    // Mat's last pick was week 2, and others played on: week 2 knocked him out.
    expect(byName.get('Mat')!.eliminatedInWeek).toBe(2);
    // Jase went out in week 1.
    expect(byName.get('Jase')!.eliminatedInWeek).toBe(1);
    // Pia won, so she was never eliminated.
    expect(byName.get('Pia')!.eliminatedInWeek).toBeNull();
    expect(byName.get('Jon')!.eliminatedInWeek).toBe(2);
  });

  it('does not claim an elimination for the final week of a round nobody won', () => {
    // Their last pick may simply have been where the record stops.
    const parsed = parseKillerCsv(csv('Arsenal,Chelsea,x,x,x', 'Everton,Fulham,x,x,x'));
    for (const entrant of parsed.rounds[0]!.entrants.slice(0, 2)) {
      expect(entrant.eliminatedInWeek).toBeNull();
    }
  });

  it('normalises the misspellings in the real file', () => {
    const parsed = parseKillerCsv(
      csv('Necastle,Forrest,Liecester,ManCity,Man U', 'Newastle,Sheff Utd,City,Nottingham,Man Utd'),
    );

    const names = parsed.rounds[0]!.entrants.map((entrant) =>
      entrant.picks.map((pick) => pick.teamName),
    );

    expect(names).toEqual([
      ['Newcastle United', 'Newcastle United'],
      ['Nottingham Forest', 'Sheffield United'],
      ['Leicester City', 'Manchester City'],
      ['Manchester City', 'Nottingham Forest'],
      ['Manchester United', 'Manchester United'],
    ]);
    expect(parsed.unresolvedCells).toEqual([]);
  });

  it('handles the cell that recorded two teams', () => {
    const parsed = parseKillerCsv(csv('Liverpool(Southampton),x,x,x,x'));
    const pick = parsed.rounds[0]!.entrants[0]!.picks[0]!;
    expect(pick.teamName).toBe('Liverpool');
    expect(pick.ambiguous).toBe(true);
    expect(pick.raw).toBe('Liverpool(Southampton)');
  });

  it('truncates a row inflated by a trailing comma and warns', () => {
    const parsed = parseKillerCsv(csv('Arsenal,Chelsea,Liverpool,Everton,Fulham,'));
    const round = parsed.rounds[0]!;
    expect(round.entrants).toHaveLength(5);
    expect(round.warnings.join(' ')).toContain('trailing comma');
  });

  it('flags a block with fewer columns than the header as ambiguous', () => {
    // Older rounds were played by fewer people, and the file does not record
    // which of the eleven names those columns belonged to.
    const parsed = parseKillerCsv(csv('Arsenal,Chelsea,Liverpool'));
    const round = parsed.rounds[0]!;
    expect(round.columnCount).toBe(3);
    expect(round.entrants.map((entrant) => entrant.displayName)).toEqual(['Mat', 'Jase', 'Pia']);
    expect(round.warnings.join(' ')).toContain('AMBIGUOUS_COLUMNS');
  });

  it('reports cells it cannot resolve rather than guessing', () => {
    const parsed = parseKillerCsv(csv('Arsenal,Rovers United,x,x,x'));
    expect(parsed.unresolvedCells).toEqual([
      { round: 0, week: 1, player: 'Jase', raw: 'Rovers United' },
    ]);
    expect(parsed.rounds[0]!.entrants[1]!.picks[0]!.teamName).toBeNull();
  });

  it('survives an empty file', () => {
    expect(parseKillerCsv('')).toMatchObject({ playerNames: [], rounds: [] });
  });

  it('ignores blank lines between blocks', () => {
    const parsed = parseKillerCsv(csv('Arsenal,x,x,x,x', '', '---,---,---,---,---', '', 'Chelsea,x,x,x,x'));
    expect(parsed.rounds).toHaveLength(2);
  });
});

describe('collectLegacyTeams', () => {
  it('gathers every distinct team, de-duplicating spelling variants', () => {
    const parsed = parseKillerCsv(
      csv('Necastle,Newcastle,Man U,Man Utd,Leeds', 'Newcastle United,x,x,x,x'),
    );
    const teams = collectLegacyTeams(parsed);

    expect(teams.resolved.map((team) => team.code).sort()).toEqual(['LEE', 'MUN', 'NEW']);
    expect(teams.unresolved).toEqual([]);
  });

  it('separates the names it could not resolve', () => {
    const parsed = parseKillerCsv(csv('Arsenal,Wanderers FC,x,x,x'));
    const teams = collectLegacyTeams(parsed);
    expect(teams.resolved.map((team) => team.code)).toEqual(['ARS']);
    expect(teams.unresolved).toEqual(['Wanderers FC']);
  });

  it('ignores unknown-pick markers', () => {
    const parsed = parseKillerCsv(csv('?,?,?,?,?'));
    expect(collectLegacyTeams(parsed)).toEqual({ resolved: [], unresolved: [] });
  });
});
