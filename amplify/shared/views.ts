import { isPastDeadline, type Clock } from '../../shared/domain/clock.js';
import { computePot } from '../../shared/domain/money.js';
import { usedTeamIds } from '../../shared/domain/selection.js';
import { SELECTION_TYPES, type SelectionType } from '../../shared/domain/types.js';
import {
  redactPaid,
  redactSelections,
  type CompetitionView,
  type EntryView,
  type MeView,
  type RedactableSelection,
  type SelectionCell,
  type WeekView,
} from '../../shared/domain/visibility.js';
import type { Repository } from './repository.js';
import type { ResolvedViewer } from './viewer.js';

/**
 * The read path.
 *
 * Everything a player or a visitor sees comes through here, and the redaction in
 * `redactSelections` is applied before the payload leaves the Lambda. There is
 * deliberately no way to ask for the raw selections: `Selection` has no client
 * authorization rule at all, so this function *is* the API for picks.
 */
export async function buildCompetitionView(
  repository: Repository,
  viewer: ResolvedViewer,
  clock: Clock,
  killerRoundId?: string | null,
): Promise<CompetitionView> {
  const round = killerRoundId
    ? await repository.round(killerRoundId)
    : await repository.currentRound();

  if (!round) {
    return {
      round: null,
      weeks: [],
      entries: [],
      selections: [],
      pot: null,
      currentWeekId: null,
      aliveCount: 0,
      me: null,
      viewerKind: viewer.kind,
    };
  }

  const [season, rawWeeks, rawEntries, rawSelections, players, teams] = await Promise.all([
    repository.season(round.seasonId),
    repository.weeks(round.id),
    repository.entries(round.id),
    repository.selectionsByRound(round.id),
    repository.players(),
    repository.teams(round.seasonId),
  ]);

  const playersById = new Map(players.map((player) => [player.id, player]));
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  const entriesById = new Map(rawEntries.map((entry) => [entry.id, entry]));

  const weeks: WeekView[] = rawWeeks
    .slice()
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
    .map((week) => ({
      id: week.id,
      sequenceNumber: week.sequenceNumber,
      matchday: week.matchday ?? null,
      deadline: week.deadline ?? null,
      status: week.status ?? 'DRAFT',
      revealed: isPastDeadline(week.deadline, clock),
    }));

  const entries: EntryView[] = rawEntries
    .map((entry) => ({
      roundEntryId: entry.id,
      playerId: entry.playerId,
      displayName: playersById.get(entry.playerId)?.displayName ?? 'Unknown player',
      status: entry.status ?? 'ALIVE',
      // Withheld from the public; visible to signed-in players and admins.
      paid: redactPaid(entry.paid, viewer),
      eliminatedRoundWeekId: entry.eliminatedRoundWeekId ?? null,
    }))
    // Alive players first, then alphabetically — the table people actually want.
    .sort((a, b) => {
      const rank = (status: string) => (status === 'WINNER' ? 0 : status === 'ALIVE' ? 1 : 2);
      const byStatus = rank(a.status) - rank(b.status);
      return byStatus !== 0 ? byStatus : a.displayName.localeCompare(b.displayName, 'en-GB');
    });

  const redactable: RedactableSelection[] = rawSelections.map((selection) => ({
    roundWeekId: selection.roundWeekId,
    playerId: selection.playerId,
    teamId: selection.teamId ?? null,
    teamName: selection.teamName ?? teamsById.get(selection.teamId ?? '')?.name ?? null,
    teamCode: selection.teamCode ?? teamsById.get(selection.teamId ?? '')?.code ?? null,
    badgeUrl: teamsById.get(selection.teamId ?? '')?.badgeUrl ?? null,
    selectionType: selection.selectionType ?? 'MANUAL',
    outcome: selection.outcome ?? 'PENDING',
    autoReason: selection.autoReason ?? null,
  }));

  const selections: SelectionCell[] = redactSelections(redactable, weeks, viewer, clock);

  const pot = computePot(
    { rolloverInPence: round.rolloverInPence ?? 0 },
    rawEntries.map((entry) => ({
      paid: entry.paid,
      entryFeePence: entry.entryFeePence ?? round.entryFeePence,
    })),
  );

  // The week accepting picks: open, with its deadline still ahead.
  const currentWeek =
    weeks.find((week) => week.status === 'OPEN' && !week.revealed) ??
    // Failing that, the latest week, so a locked or completed round still shows
    // where it got to.
    weeks.at(-1) ??
    null;

  const winner = round.winnerPlayerId ? playersById.get(round.winnerPlayerId) : undefined;

  return {
    round: {
      id: round.id,
      number: round.number,
      status: round.status ?? 'DRAFT',
      seasonId: round.seasonId,
      seasonName: season?.name ?? '',
      winnerPlayerId: round.winnerPlayerId ?? null,
      winnerDisplayName: winner?.displayName ?? null,
      previousRoundId: round.previousRoundId ?? null,
    },
    weeks,
    entries,
    selections,
    pot: {
      entryFeePence: round.entryFeePence,
      entrantCount: pot.entrantCount,
      paidCount: pot.paidCount,
      expectedEntriesPence: pot.expectedEntriesPence,
      collectedPence: pot.collectedPence,
      outstandingPence: pot.outstandingPence,
      rolloverInPence: pot.rolloverInPence,
      totalPotPence: pot.totalPotPence,
    },
    currentWeekId: currentWeek?.id ?? null,
    aliveCount: entries.filter((entry) => entry.status === 'ALIVE' || entry.status === 'WINNER')
      .length,
    me: buildMe(viewer, {
      entries: entriesById,
      rawSelections,
      weeks,
      currentWeekId: currentWeek?.id ?? null,
      currentWeekStatus: currentWeek?.status ?? null,
      currentWeekRevealed: currentWeek?.revealed ?? true,
      roundStatus: round.status ?? 'DRAFT',
      displayName: viewer.displayName,
    }),
    viewerKind: viewer.kind,
  };
}

function asSelectionType(value: string | null | undefined): SelectionType {
  return SELECTION_TYPES.includes(value as SelectionType) ? (value as SelectionType) : 'MANUAL';
}

interface MeContext {
  entries: Map<string, { id: string; playerId: string; status?: string | null; paid: boolean }>;
  rawSelections: {
    roundWeekId: string;
    roundEntryId: string;
    playerId: string;
    teamId?: string | null;
    teamName?: string | null;
    teamCode?: string | null;
    selectionType?: string | null;
    lockedAt?: string | null;
  }[];
  weeks: WeekView[];
  currentWeekId: string | null;
  currentWeekStatus: string | null;
  currentWeekRevealed: boolean;
  roundStatus: string;
  displayName: string | null;
}

function buildMe(viewer: ResolvedViewer, context: MeContext): MeView | null {
  if (!viewer.playerId) return null;

  const entry = [...context.entries.values()].find(
    (candidate) => candidate.playerId === viewer.playerId,
  );

  const mine = context.rawSelections.filter(
    (selection) => selection.playerId === viewer.playerId,
  );

  const current = context.currentWeekId
    ? mine.find((selection) => selection.roundWeekId === context.currentWeekId)
    : undefined;

  return {
    playerId: viewer.playerId,
    displayName: context.displayName ?? '',
    roundEntryId: entry?.id ?? null,
    status: (entry?.status as MeView['status']) ?? null,
    paid: entry?.paid ?? false,
    // Excludes the current week, so re-picking the same team is not a reuse.
    usedTeamIds: usedTeamIds(
      mine.map((selection) => ({
        roundWeekId: selection.roundWeekId,
        teamId: selection.teamId ?? null,
      })),
      context.currentWeekId ?? undefined,
    ),
    currentSelection: current
      ? {
          teamId: current.teamId ?? null,
          teamName: current.teamName ?? null,
          teamCode: current.teamCode ?? null,
          selectionType: asSelectionType(current.selectionType),
          // Locked once the deadline processor has stamped it, or once the
          // deadline has passed — whichever the player notices first.
          locked: Boolean(current.lockedAt) || context.currentWeekRevealed,
        }
      : null,
    canSelect:
      entry?.status === 'ALIVE' &&
      context.roundStatus === 'ACTIVE' &&
      context.currentWeekStatus === 'OPEN' &&
      !context.currentWeekRevealed,
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface HistoryRound {
  id: string;
  number: number;
  status: string;
  seasonId: string;
  seasonName: string;
  weekCount: number;
  entrantCount: number;
  winnerPlayerId: string | null;
  winnerDisplayName: string | null;
  totalPotPence: number;
  rolloverInPence: number;
  rolloverOutPence: number;
  previousRoundId: string | null;
  dataSource: string;
  startedAt: string | null;
  completedAt: string | null;
  notes: string | null;
}

export interface PlayerStats {
  playerId: string;
  displayName: string;
  roundsEntered: number;
  roundsWon: number;
  totalWinningsPence: number;
  eliminations: number;
  firstWeekEliminations: number;
  autoSelections: number;
  longestSurvivalStreak: number;
  favouriteTeamName: string | null;
  favouriteTeamCount: number;
}

export interface HistoryView {
  rounds: HistoryRound[];
  players: PlayerStats[];
  /** Most-selected teams across every round. */
  teamPopularity: { teamName: string; teamCode: string | null; count: number }[];
}

/**
 * History and statistics.
 *
 * Computed on read rather than maintained incrementally: with a couple of dozen
 * rounds and a dozen players this is a handful of table scans, and a derived
 * counter that drifts out of step with the selections is worse than a query.
 * If it ever gets slow, the fix is a cached summary — not a schema change.
 */
export async function buildHistoryView(
  repository: Repository,
  seasonId?: string | null,
): Promise<HistoryView> {
  const [rounds, players, seasons] = await Promise.all([
    repository.rounds(seasonId ?? undefined),
    repository.players(),
    repository.seasons(),
  ]);

  const playersById = new Map(players.map((player) => [player.id, player]));
  const seasonsById = new Map(seasons.map((season) => [season.id, season]));

  // Finished rounds first, newest first.
  const ordered = rounds.slice().sort((a, b) => b.number - a.number);

  const perRound = await Promise.all(
    ordered.map(async (round) => {
      const [entries, weeks, selections] = await Promise.all([
        repository.entries(round.id),
        repository.weeks(round.id),
        repository.selectionsByRound(round.id),
      ]);
      return { round, entries, weeks, selections };
    }),
  );

  const historyRounds: HistoryRound[] = perRound.map(({ round, entries, weeks }) => {
    const pot = computePot(
      { rolloverInPence: round.rolloverInPence ?? 0 },
      entries.map((entry) => ({
        paid: entry.paid,
        entryFeePence: entry.entryFeePence ?? round.entryFeePence,
      })),
    );
    const winner = round.winnerPlayerId ? playersById.get(round.winnerPlayerId) : undefined;

    return {
      id: round.id,
      number: round.number,
      status: round.status ?? 'DRAFT',
      seasonId: round.seasonId,
      seasonName: seasonsById.get(round.seasonId)?.name ?? '',
      weekCount: weeks.length,
      entrantCount: entries.length,
      winnerPlayerId: round.winnerPlayerId ?? null,
      winnerDisplayName: winner?.displayName ?? null,
      totalPotPence: pot.totalPotPence,
      rolloverInPence: pot.rolloverInPence,
      rolloverOutPence: round.rolloverOutPence ?? 0,
      previousRoundId: round.previousRoundId ?? null,
      dataSource: round.dataSource ?? 'LIVE',
      startedAt: round.startedAt ?? null,
      completedAt: round.completedAt ?? null,
      notes: round.notes ?? null,
    };
  });

  // --- Per-player statistics ------------------------------------------------

  const stats = new Map<string, PlayerStats>();
  const teamCounts = new Map<string, { teamName: string; teamCode: string | null; count: number }>();

  const ensure = (playerId: string): PlayerStats => {
    let existing = stats.get(playerId);
    if (!existing) {
      existing = {
        playerId,
        displayName: playersById.get(playerId)?.displayName ?? 'Unknown player',
        roundsEntered: 0,
        roundsWon: 0,
        totalWinningsPence: 0,
        eliminations: 0,
        firstWeekEliminations: 0,
        autoSelections: 0,
        longestSurvivalStreak: 0,
        favouriteTeamName: null,
        favouriteTeamCount: 0,
      };
      stats.set(playerId, existing);
    }
    return existing;
  };

  for (const { round, entries, weeks, selections } of perRound) {
    const potForRound = historyRounds.find((entry) => entry.id === round.id)?.totalPotPence ?? 0;
    const firstWeekId = weeks
      .slice()
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0]?.id;

    for (const entry of entries) {
      const player = ensure(entry.playerId);
      player.roundsEntered += 1;

      if (round.winnerPlayerId === entry.playerId) {
        player.roundsWon += 1;
        player.totalWinningsPence += potForRound;
      }
      if (entry.status === 'ELIMINATED') {
        player.eliminations += 1;
        if (entry.eliminatedRoundWeekId && entry.eliminatedRoundWeekId === firstWeekId) {
          player.firstWeekEliminations += 1;
        }
      }

      // Survival streak: consecutive weeks survived within this round. Tracked
      // per round because a streak does not carry across a fresh Killer Round.
      const mine = selections
        .filter((selection) => selection.roundEntryId === entry.id)
        .map((selection) => ({
          sequence:
            weeks.find((week) => week.id === selection.roundWeekId)?.sequenceNumber ?? 0,
          outcome: selection.outcome ?? 'PENDING',
        }))
        .sort((a, b) => a.sequence - b.sequence);

      let streak = 0;
      for (const selection of mine) {
        if (selection.outcome === 'SURVIVED') {
          streak += 1;
          player.longestSurvivalStreak = Math.max(player.longestSurvivalStreak, streak);
        } else {
          streak = 0;
        }
      }
    }

    for (const selection of selections) {
      const player = ensure(selection.playerId);
      if (selection.selectionType === 'AUTO_LOWEST_POSITION') player.autoSelections += 1;

      const name = selection.teamName;
      if (name) {
        const key = `${selection.playerId}::${name}`;
        const existing = teamCounts.get(key);
        teamCounts.set(key, {
          teamName: name,
          teamCode: selection.teamCode ?? null,
          count: (existing?.count ?? 0) + 1,
        });
      }
    }
  }

  // Favourite team per player, from the per-player tallies above.
  for (const [key, value] of teamCounts) {
    const playerId = key.split('::')[0]!;
    const player = stats.get(playerId);
    if (player && value.count > player.favouriteTeamCount) {
      player.favouriteTeamName = value.teamName;
      player.favouriteTeamCount = value.count;
    }
  }

  // Overall popularity, summed across players.
  const popularity = new Map<string, { teamName: string; teamCode: string | null; count: number }>();
  for (const value of teamCounts.values()) {
    const existing = popularity.get(value.teamName);
    popularity.set(value.teamName, {
      teamName: value.teamName,
      teamCode: value.teamCode ?? existing?.teamCode ?? null,
      count: (existing?.count ?? 0) + value.count,
    });
  }

  return {
    rounds: historyRounds,
    players: [...stats.values()].sort(
      (a, b) =>
        b.roundsWon - a.roundsWon ||
        b.totalWinningsPence - a.totalWinningsPence ||
        a.displayName.localeCompare(b.displayName, 'en-GB'),
    ),
    teamPopularity: [...popularity.values()]
      .sort((a, b) => b.count - a.count || a.teamName.localeCompare(b.teamName, 'en-GB'))
      .slice(0, 25),
  };
}
