import { isPastDeadline, type Clock } from '../../shared/domain/clock.js';
import { proposeDeadline } from '../../shared/domain/deadlines.js';
import { computePot, DEFAULT_ENTRY_FEE_PENCE } from '../../shared/domain/money.js';
import {
  rejectionMessage,
  usedTeamIds,
  validateSelection,
  findFixtureForTeam,
} from '../../shared/domain/selection.js';
import {
  SELECTION_OUTCOMES,
  selectionId,
  type RoundWeekStatus,
  type SelectionOutcome,
} from '../../shared/domain/types.js';
import { recordAudit } from './audit.js';
import type { Repository } from './repository.js';
import { OperationError, requireAdmin, requirePlayer, type ResolvedViewer } from './viewer.js';

/**
 * Player and administrator write operations.
 *
 * Every rule that decides who stays in the competition and who owes money is
 * checked here, on the server, from data read out of DynamoDB. Nothing trusts a
 * resolver argument beyond the ids it needs to look things up.
 */

// ---------------------------------------------------------------------------
// Player operations
// ---------------------------------------------------------------------------

export interface SubmitSelectionResult {
  ok: boolean;
  reason?: string;
  message?: string;
  selection?: {
    roundWeekId: string;
    teamId: string;
    teamName: string | null;
    teamCode: string | null;
    changed: boolean;
  };
}

/**
 * Make or change a pick.
 *
 * This is the security-critical write in the whole application, so the checks
 * are all here and all server-side: the caller's own entry, the week open, the
 * deadline not passed, the team unused by *this* player in *this* round, and the
 * team in the right season. `validateSelection` is the pure function those rules
 * live in, and it is unit-tested independently.
 */
export async function submitSelection(
  repository: Repository,
  viewer: ResolvedViewer,
  clock: Clock,
  input: { roundWeekId: string; teamId: string },
): Promise<SubmitSelectionResult> {
  const playerId = requirePlayer(viewer);

  const week = await repository.week(input.roundWeekId);
  if (!week) throw new OperationError('That Round Week does not exist.', 'NO_SUCH_WEEK');

  const [round, player, team] = await Promise.all([
    repository.round(week.killerRoundId),
    repository.player(playerId),
    repository.models.Team.get({ id: input.teamId }).then((result) => result.data),
  ]);

  if (!round) throw new OperationError('That Killer Round does not exist.', 'NO_SUCH_ROUND');

  const entries = await repository.entries(round.id);
  const entry = entries.find((candidate) => candidate.playerId === playerId) ?? null;

  const priorSelections = entry ? await repository.selectionsByEntry(entry.id) : [];
  const fixtures =
    week.matchday === null || week.matchday === undefined
      ? []
      : await repository.fixtures(round.seasonId, week.matchday);

  const decision = validateSelection(
    {
      entry: entry
        ? { id: entry.id, status: entry.status ?? 'ALIVE', killerRoundId: entry.killerRoundId }
        : null,
      roundStatus: round.status ?? 'DRAFT',
      week: {
        id: week.id,
        status: (week.status ?? 'DRAFT') as RoundWeekStatus,
        deadline: week.deadline ?? null,
        matchday: week.matchday ?? null,
        killerRoundId: week.killerRoundId,
      },
      team: team ? { id: team.id, seasonId: team.seasonId, active: team.active } : null,
      seasonId: round.seasonId,
      usedTeamIds: usedTeamIds(
        priorSelections.map((selection) => ({
          roundWeekId: selection.roundWeekId,
          teamId: selection.teamId ?? null,
        })),
        // The week being changed does not count against itself, so a player can
        // re-pick the team they already chose this week.
        week.id,
      ),
      fixtures: fixtures.map((fixture) => ({
        homeTeamId: fixture.homeTeamId,
        awayTeamId: fixture.awayTeamId,
        status: (fixture.status ?? 'UNKNOWN') as 'SCHEDULED',
      })),
      playerActive: player?.active ?? false,
    },
    clock,
  );

  if (!decision.ok) {
    return { ok: false, reason: decision.reason, message: rejectionMessage(decision.reason) };
  }

  // Safe: `validateSelection` rejected a null entry or team above.
  const confirmedEntry = entry!;
  const confirmedTeam = team!;

  const id = selectionId(week.id, confirmedEntry.id);
  const existing = priorSelections.find((selection) => selection.roundWeekId === week.id);
  const now = clock.nowIso();
  const fixture = findFixtureForTeam(
    confirmedTeam.id,
    fixtures.map((f) => ({ id: f.id, homeTeamId: f.homeTeamId, awayTeamId: f.awayTeamId })),
  );

  const fields = {
    teamId: confirmedTeam.id,
    teamName: confirmedTeam.name,
    teamCode: confirmedTeam.code,
    selectionType: 'MANUAL' as const,
    selectedAt: now,
    outcome: 'PENDING' as const,
    fixtureId: fixture?.id ?? null,
  };

  if (existing) {
    // Changing a pick. Players may do this as often as they like before the
    // deadline; `lockedAt` is deliberately untouched, and a locked selection
    // could not have reached this point because the week would not be OPEN.
    await repository.models.Selection.update({ id, ...fields });
  } else {
    await repository.models.Selection.create({
      id,
      roundWeekId: week.id,
      roundEntryId: confirmedEntry.id,
      killerRoundId: round.id,
      playerId,
      overridden: false,
      ...fields,
    });
  }

  return {
    ok: true,
    selection: {
      roundWeekId: week.id,
      teamId: confirmedTeam.id,
      teamName: confirmedTeam.name,
      teamCode: confirmedTeam.code,
      changed: Boolean(existing),
    },
  };
}

/**
 * A player marks themselves paid.
 *
 * Scoped to the caller's own entry by construction: the entry is found from the
 * viewer's player id, not from an argument, so there is no id to tamper with.
 * Marking paid is one-way for players — unmarking is an administrator action, so
 * nobody can quietly un-pay after the fact.
 */
export async function markSelfPaid(
  repository: Repository,
  viewer: ResolvedViewer,
  clock: Clock,
  input: { killerRoundId: string },
): Promise<{ ok: boolean; message?: string }> {
  const playerId = requirePlayer(viewer);

  const entries = await repository.entries(input.killerRoundId);
  const entry = entries.find((candidate) => candidate.playerId === playerId);
  if (!entry) {
    throw new OperationError('You are not an entrant in this Killer Round.', 'NOT_AN_ENTRANT');
  }
  if (entry.paid) return { ok: true, message: 'Already marked as paid.' };

  await repository.models.RoundEntry.update({
    id: entry.id,
    paid: true,
    paidAt: clock.nowIso(),
    paidBy: `player:${playerId}`,
  });

  return { ok: true, message: 'Marked as paid. Thanks.' };
}

// ---------------------------------------------------------------------------
// Administrative operations
// ---------------------------------------------------------------------------

export async function adminSetPaid(
  repository: Repository,
  viewer: ResolvedViewer,
  clock: Clock,
  input: { roundEntryId: string; paid: boolean },
): Promise<{ ok: boolean }> {
  requireAdmin(viewer);

  const entry = await repository.entry(input.roundEntryId);
  if (!entry) throw new OperationError('No such entry.', 'NO_SUCH_ENTRY');

  const now = clock.nowIso();
  await repository.models.RoundEntry.update({
    id: entry.id,
    paid: input.paid,
    paidAt: input.paid ? (entry.paidAt ?? now) : null,
    paidBy: `admin:${viewer.sub ?? 'unknown'}`,
  });

  await recordAudit(repository, viewer, now, {
    action: 'PAYMENT_STATUS_CHANGED',
    entityType: 'RoundEntry',
    entityId: entry.id,
    killerRoundId: entry.killerRoundId,
    before: { paid: entry.paid },
    after: { paid: input.paid },
  });

  return { ok: true };
}

/**
 * Override a selection or its outcome.
 *
 * For when the provider is wrong, a fixture was abandoned, or a genuine
 * exception needs settling. Always audited with the before and after state, and
 * the record is marked `overridden` so result processing leaves it alone from
 * then on — otherwise the next sync would quietly undo the decision.
 */
export async function adminOverrideSelection(
  repository: Repository,
  viewer: ResolvedViewer,
  clock: Clock,
  input: {
    roundWeekId: string;
    roundEntryId: string;
    teamId?: string | null;
    outcome?: string | null;
    note?: string | null;
  },
): Promise<{ ok: boolean }> {
  requireAdmin(viewer);

  const week = await repository.week(input.roundWeekId);
  if (!week) throw new OperationError('No such Round Week.', 'NO_SUCH_WEEK');

  const entry = await repository.entry(input.roundEntryId);
  if (!entry) throw new OperationError('No such entry.', 'NO_SUCH_ENTRY');

  const outcome = input.outcome ? normaliseOutcome(input.outcome) : null;
  const team = input.teamId
    ? await repository.models.Team.get({ id: input.teamId }).then((result) => result.data)
    : null;
  if (input.teamId && !team) throw new OperationError('No such team.', 'NO_SUCH_TEAM');

  const id = selectionId(week.id, entry.id);
  const existing = await repository.selection(id);
  const now = clock.nowIso();

  // Re-link the fixture when the team changes, so result processing (and the
  // reprocess button) has something to resolve against.
  const round = await repository.round(week.killerRoundId);
  const fixtures =
    round && week.matchday !== null && week.matchday !== undefined
      ? await repository.fixtures(round.seasonId, week.matchday)
      : [];

  const fixture = team
    ? findFixtureForTeam(
        team.id,
        fixtures.map((f) => ({ id: f.id, homeTeamId: f.homeTeamId, awayTeamId: f.awayTeamId })),
      )
    : null;

  const fields = {
    teamId: team?.id ?? existing?.teamId ?? null,
    teamName: team?.name ?? existing?.teamName ?? null,
    teamCode: team?.code ?? existing?.teamCode ?? null,
    outcome: outcome ?? existing?.outcome ?? 'PENDING',
    /**
     * Only an explicit *outcome* counts as an override.
     *
     * `overridden` tells result processing to leave the record alone for good.
     * Setting it merely because an administrator typed the team would mean a
     * hand-entered pick never gets its result computed — which is exactly what
     * happens when picks arrive by message and are entered on players' behalf.
     * Correcting the team is a pick; deciding the outcome is an override.
     */
    overridden: outcome !== null || (existing?.overridden ?? false),
    overrideNote: input.note ?? null,
    fixtureId: fixture?.id ?? existing?.fixtureId ?? null,
    resolvedAt: outcome && outcome !== 'PENDING' ? now : (existing?.resolvedAt ?? null),
  };

  if (existing) {
    await repository.models.Selection.update({ id, ...fields });
  } else {
    // An override can create a pick for a player who never made one.
    await repository.models.Selection.create({
      id,
      roundWeekId: week.id,
      roundEntryId: entry.id,
      killerRoundId: week.killerRoundId,
      playerId: entry.playerId,
      selectionType: 'ADMIN',
      selectedAt: now,
      lockedAt: now,
      ...fields,
    });
  }

  // Keep the entry's alive/eliminated state consistent with the decision, or
  // the competition table would contradict the override.
  if (fields.outcome === 'ELIMINATED' && entry.status === 'ALIVE') {
    await repository.models.RoundEntry.update({
      id: entry.id,
      status: 'ELIMINATED',
      eliminatedRoundWeekId: week.id,
    });
  } else if (fields.outcome === 'SURVIVED' && entry.status === 'ELIMINATED') {
    await repository.models.RoundEntry.update({
      id: entry.id,
      status: 'ALIVE',
      eliminatedRoundWeekId: null,
    });
  }

  await recordAudit(repository, viewer, now, {
    action: 'SELECTION_OVERRIDDEN',
    entityType: 'Selection',
    entityId: id,
    killerRoundId: week.killerRoundId,
    before: existing
      ? { teamId: existing.teamId, teamName: existing.teamName, outcome: existing.outcome }
      : null,
    after: { teamId: fields.teamId, teamName: fields.teamName, outcome: fields.outcome },
    note: input.note ?? undefined,
  });

  return { ok: true };
}

function normaliseOutcome(value: string): SelectionOutcome {
  const upper = value.toUpperCase();
  if (!SELECTION_OUTCOMES.includes(upper as SelectionOutcome)) {
    throw new OperationError(
      `Outcome must be one of ${SELECTION_OUTCOMES.join(', ')}.`,
      'BAD_OUTCOME',
    );
  }
  return upper as SelectionOutcome;
}

/**
 * Start a Killer Round.
 *
 * Snapshots the entry fee onto every entry and carries the pot forward from the
 * previous round if that one rolled over. Doing the rollover here, at the moment
 * the round starts, means the money trail is fixed by an explicit act rather
 * than recomputed on every read.
 */
export async function adminStartRound(
  repository: Repository,
  viewer: ResolvedViewer,
  clock: Clock,
  input: { killerRoundId: string; playerIds?: (string | null)[] | null },
): Promise<{ ok: boolean; entrants: number; rolloverInPence: number }> {
  requireAdmin(viewer);

  const round = await repository.round(input.killerRoundId);
  if (!round) throw new OperationError('No such Killer Round.', 'NO_SUCH_ROUND');
  if (round.status === 'ACTIVE') {
    throw new OperationError('That Killer Round has already started.', 'ALREADY_ACTIVE');
  }
  if (round.status !== 'DRAFT') {
    throw new OperationError('Only a draft Killer Round can be started.', 'NOT_DRAFT');
  }

  const now = clock.nowIso();
  const requested = (input.playerIds ?? []).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );

  const existingEntries = await repository.entries(round.id);
  const existingPlayerIds = new Set(existingEntries.map((entry) => entry.playerId));

  // With no explicit list, everybody active enters — the usual case for a group
  // that plays every round.
  const players = await repository.players();
  const entrantIds =
    requested.length > 0
      ? requested
      : players.filter((player) => player.active).map((player) => player.id);

  for (const playerId of entrantIds) {
    if (existingPlayerIds.has(playerId)) continue;
    await repository.models.RoundEntry.create({
      killerRoundId: round.id,
      playerId,
      status: 'ALIVE',
      paid: false,
      // The fee as it stands now. Changing the round fee later cannot rewrite
      // what these entrants owed.
      entryFeePence: round.entryFeePence ?? DEFAULT_ENTRY_FEE_PENCE,
    });
  }

  // Carry the pot forward if the previous round rolled over and this round has
  // not already been given a rollover by hand.
  let rolloverInPence = round.rolloverInPence ?? 0;
  if (round.previousRoundId && rolloverInPence === 0) {
    const previous = await repository.round(round.previousRoundId);
    if (previous?.status === 'ROLLOVER') {
      if (previous.rolloverOutPence && previous.rolloverOutPence > 0) {
        rolloverInPence = previous.rolloverOutPence;
      } else {
        // The previous round was declared a rollover without an amount being
        // recorded; derive it from its entries.
        const previousEntries = await repository.entries(previous.id);
        rolloverInPence = computePot(
          { rolloverInPence: previous.rolloverInPence ?? 0 },
          previousEntries.map((entry) => ({
            paid: entry.paid,
            entryFeePence: entry.entryFeePence ?? previous.entryFeePence,
          })),
        ).totalPotPence;
      }
    }
  }

  await repository.models.KillerRound.update({
    id: round.id,
    status: 'ACTIVE',
    startedAt: now,
    rolloverInPence,
  });

  const entrants = await repository.entries(round.id);

  await recordAudit(repository, viewer, now, {
    action: 'KILLER_ROUND_STARTED',
    entityType: 'KillerRound',
    entityId: round.id,
    killerRoundId: round.id,
    before: { status: round.status, rolloverInPence: round.rolloverInPence },
    after: { status: 'ACTIVE', rolloverInPence, entrants: entrants.length },
  });

  return { ok: true, entrants: entrants.length, rolloverInPence };
}

/**
 * Enter a pick on a player's behalf.
 *
 * Picks arrive by message rather than through the app — especially in the first
 * round, before anybody has a login. This is the supported way to record them.
 *
 * It runs the **same** `validateSelection` a player's own pick goes through, so
 * team reuse, elimination and the week's status are all enforced identically. An
 * administrator does not get to accidentally give somebody Arsenal twice.
 *
 * The result is a normal pick: `selectionType: 'ADMIN'` for honesty about who
 * typed it, but `overridden: false`, so result processing resolves it like any
 * other. That distinction is the whole reason this is separate from
 * `adminOverrideSelection`.
 *
 * `allowAfterDeadline` exists because messages arrive late. It is off by
 * default, and every use is audited as a deadline bypass — entering a pick after
 * kick-off is exactly the integrity risk the rest of the design guards against,
 * so it should be visible when it happens.
 */
export async function adminSubmitSelectionFor(
  repository: Repository,
  viewer: ResolvedViewer,
  clock: Clock,
  input: {
    roundWeekId: string;
    playerId: string;
    teamId: string;
    allowAfterDeadline?: boolean | null;
  },
): Promise<{ ok: boolean; reason?: string; message: string }> {
  requireAdmin(viewer);

  const week = await repository.week(input.roundWeekId);
  if (!week) throw new OperationError('No such Round Week.', 'NO_SUCH_WEEK');

  const [round, player, team] = await Promise.all([
    repository.round(week.killerRoundId),
    repository.player(input.playerId),
    repository.models.Team.get({ id: input.teamId }).then((result) => result.data),
  ]);

  if (!round) throw new OperationError('No such Killer Round.', 'NO_SUCH_ROUND');
  if (!player) throw new OperationError('No such player.', 'NO_SUCH_PLAYER');

  const entries = await repository.entries(round.id);
  const entry = entries.find((candidate) => candidate.playerId === input.playerId) ?? null;
  const priorSelections = entry ? await repository.selectionsByEntry(entry.id) : [];
  const fixtures =
    week.matchday === null || week.matchday === undefined
      ? []
      : await repository.fixtures(round.seasonId, week.matchday);

  const afterDeadline = isPastDeadline(week.deadline ?? null, clock);
  const bypassing = afterDeadline && input.allowAfterDeadline === true;

  const decision = validateSelection(
    {
      entry: entry
        ? { id: entry.id, status: entry.status ?? 'ALIVE', killerRoundId: entry.killerRoundId }
        : null,
      roundStatus: round.status ?? 'DRAFT',
      week: {
        id: week.id,
        // When bypassing, present the week as open so the remaining rules still
        // run. Everything except the deadline is still enforced.
        status: bypassing ? 'OPEN' : ((week.status ?? 'DRAFT') as RoundWeekStatus),
        deadline: bypassing ? null : (week.deadline ?? null),
        matchday: week.matchday ?? null,
        killerRoundId: week.killerRoundId,
      },
      team: team ? { id: team.id, seasonId: team.seasonId, active: team.active } : null,
      seasonId: round.seasonId,
      usedTeamIds: usedTeamIds(
        priorSelections.map((selection) => ({
          roundWeekId: selection.roundWeekId,
          teamId: selection.teamId ?? null,
        })),
        week.id,
      ),
      fixtures: fixtures.map((fixture) => ({
        homeTeamId: fixture.homeTeamId,
        awayTeamId: fixture.awayTeamId,
        status: (fixture.status ?? 'UNKNOWN') as 'SCHEDULED',
      })),
      playerActive: player.active,
    },
    clock,
  );

  if (!decision.ok) {
    return {
      ok: false,
      reason: decision.reason,
      message: `${player.displayName}: ${rejectionMessage(decision.reason)}`,
    };
  }

  const confirmedEntry = entry!;
  const confirmedTeam = team!;
  const id = selectionId(week.id, confirmedEntry.id);
  const existing = priorSelections.find((selection) => selection.roundWeekId === week.id);
  const now = clock.nowIso();
  const fixture = findFixtureForTeam(
    confirmedTeam.id,
    fixtures.map((f) => ({ id: f.id, homeTeamId: f.homeTeamId, awayTeamId: f.awayTeamId })),
  );

  const fields = {
    teamId: confirmedTeam.id,
    teamName: confirmedTeam.name,
    teamCode: confirmedTeam.code,
    selectionType: 'ADMIN' as const,
    selectedAt: now,
    outcome: 'PENDING' as const,
    fixtureId: fixture?.id ?? null,
  };

  if (existing) {
    await repository.models.Selection.update({ id, ...fields });
  } else {
    await repository.models.Selection.create({
      id,
      roundWeekId: week.id,
      roundEntryId: confirmedEntry.id,
      killerRoundId: round.id,
      playerId: input.playerId,
      // Not an override: results must resolve for this pick like any other.
      overridden: false,
      // Stamped only when the deadline has already gone, so the pick is locked
      // immediately rather than being editable after kick-off.
      lockedAt: afterDeadline ? now : null,
      ...fields,
    });
  }

  await recordAudit(repository, viewer, now, {
    action: bypassing ? 'SELECTION_ENTERED_AFTER_DEADLINE' : 'SELECTION_ENTERED_BY_ADMIN',
    entityType: 'Selection',
    entityId: id,
    killerRoundId: round.id,
    before: existing ? { teamId: existing.teamId, teamName: existing.teamName } : null,
    after: { teamId: confirmedTeam.id, teamName: confirmedTeam.name },
    note: bypassing
      ? `Entered for ${player.displayName} AFTER the deadline of ${week.deadline ?? 'unknown'}.`
      : `Entered for ${player.displayName} by an administrator.`,
  });

  return {
    ok: true,
    message: `${player.displayName} → ${confirmedTeam.name}${bypassing ? ' (after deadline)' : ''}`,
  };
}

/**
 * Add or remove one entrant.
 *
 * `adminStartRound` enters everybody active at the moment the round starts,
 * which is the common case for a group that plays every week. This exists for
 * everything else: somebody added after the round began, somebody who has
 * dropped out, or a round started before the players were set up.
 *
 * Adding to an already-active round is allowed on purpose — the pot is derived
 * from the entries, so a late entrant is simply counted from now on. Removal is
 * refused once they have a selection, because deleting the entry would orphan
 * that pick and rewrite the competition's history.
 */
export async function adminSetEntrant(
  repository: Repository,
  viewer: ResolvedViewer,
  clock: Clock,
  input: { killerRoundId: string; playerId: string; entered: boolean },
): Promise<{ ok: boolean; message: string; entrantCount: number }> {
  requireAdmin(viewer);

  const round = await repository.round(input.killerRoundId);
  if (!round) throw new OperationError('No such Killer Round.', 'NO_SUCH_ROUND');

  if (round.status !== 'DRAFT' && round.status !== 'ACTIVE') {
    throw new OperationError(
      'Entrants can only be changed while a round is a draft or active.',
      'ROUND_FINISHED',
    );
  }

  const player = await repository.player(input.playerId);
  if (!player) throw new OperationError('No such player.', 'NO_SUCH_PLAYER');

  const entries = await repository.entries(round.id);
  const existing = entries.find((entry) => entry.playerId === input.playerId);
  const now = clock.nowIso();

  if (input.entered) {
    if (existing) {
      return {
        ok: true,
        message: `${player.displayName} is already an entrant.`,
        entrantCount: entries.length,
      };
    }

    await repository.models.RoundEntry.create({
      killerRoundId: round.id,
      playerId: input.playerId,
      status: 'ALIVE',
      paid: false,
      // Snapshot the fee as it stands now, exactly as starting the round does.
      entryFeePence: round.entryFeePence ?? DEFAULT_ENTRY_FEE_PENCE,
    });

    await recordAudit(repository, viewer, now, {
      action: 'ENTRANT_ADDED',
      entityType: 'RoundEntry',
      entityId: input.playerId,
      killerRoundId: round.id,
      after: { playerId: input.playerId, entryFeePence: round.entryFeePence },
      note:
        round.status === 'ACTIVE'
          ? `${player.displayName} was added after the round had started.`
          : undefined,
    });

    return {
      ok: true,
      message: `${player.displayName} entered.`,
      entrantCount: entries.length + 1,
    };
  }

  if (!existing) {
    return {
      ok: true,
      message: `${player.displayName} was not an entrant.`,
      entrantCount: entries.length,
    };
  }

  const selections = await repository.selectionsByEntry(existing.id);
  if (selections.length > 0) {
    throw new OperationError(
      `${player.displayName} has already made ${selections.length} selection(s) in this round, so removing them would orphan that history. Leave them in — an eliminated entrant does not affect the winner.`,
      'HAS_SELECTIONS',
    );
  }

  await repository.models.RoundEntry.delete({ id: existing.id });

  await recordAudit(repository, viewer, now, {
    action: 'ENTRANT_REMOVED',
    entityType: 'RoundEntry',
    entityId: existing.id,
    killerRoundId: round.id,
    before: { playerId: input.playerId, entryFeePence: existing.entryFeePence },
  });

  return {
    ok: true,
    message: `${player.displayName} removed.`,
    entrantCount: entries.length - 1,
  };
}

/**
 * Add a Round Week for a chosen EPL gameweek.
 *
 * The deadline defaults to the first fixture's kick-off and can be overridden.
 * Consecutive gameweeks are not assumed — the administrator picks which
 * matchdays make up the competition.
 */
export async function adminCreateRoundWeek(
  repository: Repository,
  viewer: ResolvedViewer,
  clock: Clock,
  input: { killerRoundId: string; matchday: number; deadline?: string | null; open?: boolean | null },
): Promise<{ ok: boolean; roundWeekId: string; deadline: string | null; deadlineSource: string }> {
  requireAdmin(viewer);

  const round = await repository.round(input.killerRoundId);
  if (!round) throw new OperationError('No such Killer Round.', 'NO_SUCH_ROUND');

  const weeks = await repository.weeks(round.id);
  if (weeks.some((week) => week.matchday === input.matchday)) {
    throw new OperationError(
      `Gameweek ${input.matchday} is already part of this Killer Round.`,
      'DUPLICATE_MATCHDAY',
    );
  }

  const fixtures = await repository.fixtures(round.seasonId, input.matchday);
  const proposed = proposeDeadline(
    fixtures.map((fixture) => ({
      utcKickoff: fixture.utcKickoff,
      status: (fixture.status ?? 'UNKNOWN') as 'SCHEDULED',
    })),
  );

  const deadline = input.deadline ?? proposed;
  if (!deadline) {
    throw new OperationError(
      `No fixtures have been imported for gameweek ${input.matchday}, so no deadline can be proposed. Sync fixtures first or set a deadline explicitly.`,
      'NO_DEADLINE',
    );
  }

  const now = clock.nowIso();
  const sequenceNumber =
    weeks.reduce((highest, week) => Math.max(highest, week.sequenceNumber), 0) + 1;

  const created = await repository.models.RoundWeek.create({
    killerRoundId: round.id,
    sequenceNumber,
    matchday: input.matchday,
    deadline,
    deadlineSource: input.deadline ? 'MANUAL' : 'FIRST_FIXTURE',
    status: input.open ? 'OPEN' : 'DRAFT',
  });

  const roundWeekId = created.data?.id;
  if (!roundWeekId) throw new OperationError('Could not create the Round Week.', 'CREATE_FAILED');

  await recordAudit(repository, viewer, now, {
    action: 'ROUND_WEEK_CREATED',
    entityType: 'RoundWeek',
    entityId: roundWeekId,
    killerRoundId: round.id,
    after: {
      sequenceNumber,
      matchday: input.matchday,
      deadline,
      deadlineSource: input.deadline ? 'MANUAL' : 'FIRST_FIXTURE',
      proposedFromFixtures: proposed,
    },
    note: input.deadline
      ? `Deadline overridden by an administrator (first fixture was ${proposed ?? 'unknown'}).`
      : undefined,
  });

  return {
    ok: true,
    roundWeekId,
    deadline,
    deadlineSource: input.deadline ? 'MANUAL' : 'FIRST_FIXTURE',
  };
}

const WEEK_STATUSES: RoundWeekStatus[] = [
  'DRAFT',
  'OPEN',
  'LOCKED',
  'RESULTS_PENDING',
  'COMPLETE',
];

export async function adminSetWeekStatus(
  repository: Repository,
  viewer: ResolvedViewer,
  clock: Clock,
  input: { roundWeekId: string; status: string },
): Promise<{ ok: boolean }> {
  requireAdmin(viewer);

  const status = input.status.toUpperCase() as RoundWeekStatus;
  if (!WEEK_STATUSES.includes(status)) {
    throw new OperationError(`Status must be one of ${WEEK_STATUSES.join(', ')}.`, 'BAD_STATUS');
  }

  const week = await repository.week(input.roundWeekId);
  if (!week) throw new OperationError('No such Round Week.', 'NO_SUCH_WEEK');

  const now = clock.nowIso();
  await repository.models.RoundWeek.update({
    id: week.id,
    status,
    lockedAt: status === 'LOCKED' ? (week.lockedAt ?? now) : week.lockedAt,
  });

  await recordAudit(repository, viewer, now, {
    action: 'ROUND_WEEK_STATUS_CHANGED',
    entityType: 'RoundWeek',
    entityId: week.id,
    killerRoundId: week.killerRoundId,
    before: { status: week.status },
    after: { status },
  });

  return { ok: true };
}

/**
 * Declare a round won, rolled over or abandoned by hand.
 *
 * Needed for the case the brief calls out: the season ends without an outright
 * winner, so the administrator rolls the pot on. Also the escape hatch when the
 * automated path cannot settle a round.
 */
export async function adminCompleteRound(
  repository: Repository,
  viewer: ResolvedViewer,
  clock: Clock,
  input: {
    killerRoundId: string;
    resolution: string;
    winnerPlayerId?: string | null;
    note?: string | null;
  },
): Promise<{ ok: boolean; rolloverOutPence: number }> {
  requireAdmin(viewer);

  const resolution = input.resolution.toUpperCase();
  if (!['WON', 'ROLLOVER', 'ABANDONED'].includes(resolution)) {
    throw new OperationError('Resolution must be WON, ROLLOVER or ABANDONED.', 'BAD_RESOLUTION');
  }

  const round = await repository.round(input.killerRoundId);
  if (!round) throw new OperationError('No such Killer Round.', 'NO_SUCH_ROUND');

  const entries = await repository.entries(round.id);
  const pot = computePot(
    { rolloverInPence: round.rolloverInPence ?? 0 },
    entries.map((entry) => ({
      paid: entry.paid,
      entryFeePence: entry.entryFeePence ?? round.entryFeePence,
    })),
  );

  const now = clock.nowIso();
  let rolloverOutPence = 0;

  if (resolution === 'WON') {
    if (!input.winnerPlayerId) {
      throw new OperationError('A winner must be named.', 'NO_WINNER');
    }
    const winnerEntry = entries.find((entry) => entry.playerId === input.winnerPlayerId);
    if (!winnerEntry) {
      throw new OperationError('That player is not an entrant in this round.', 'NOT_AN_ENTRANT');
    }
    await repository.models.RoundEntry.update({ id: winnerEntry.id, status: 'WINNER' });
  } else {
    // Nobody won, so the whole pot carries into the next Killer Round.
    rolloverOutPence = pot.totalPotPence;
  }

  await repository.models.KillerRound.update({
    id: round.id,
    status: resolution as 'WON' | 'ROLLOVER' | 'ABANDONED',
    winnerPlayerId: resolution === 'WON' ? input.winnerPlayerId : null,
    rolloverOutPence,
    completedAt: now,
  });

  await recordAudit(repository, viewer, now, {
    action: `KILLER_ROUND_${resolution}_BY_ADMIN`,
    entityType: 'KillerRound',
    entityId: round.id,
    killerRoundId: round.id,
    before: { status: round.status, winnerPlayerId: round.winnerPlayerId },
    after: {
      status: resolution,
      winnerPlayerId: resolution === 'WON' ? input.winnerPlayerId : null,
      rolloverOutPence,
      potPence: pot.totalPotPence,
    },
    note: input.note ?? undefined,
  });

  return { ok: true, rolloverOutPence };
}
