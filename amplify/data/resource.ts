import { a, defineData, type ClientSchema } from '@aws-amplify/backend';
import { killerApi } from '../functions/killer-api/resource.js';
import { killerScheduler } from '../functions/killer-scheduler/resource.js';

/**
 * The Killer data model.
 *
 * Authorization principles, applied model by model below:
 *
 * - **Nobody gets blanket CRUD.** `ADMIN` holds write access; players and
 *   guests read only what is safe to publish.
 * - **`Selection` has no client read path at all.** Picks are served solely by
 *   `getCompetitionView`, which redacts them server-side according to the
 *   deadline. There is no query a curious player can issue to see their rivals'
 *   teams early, so the privacy rule is genuinely enforced rather than hidden
 *   behind a disabled button.
 * - **Players cannot write anything directly.** Submitting a pick and marking
 *   yourself paid go through custom mutations that check identity, deadlines and
 *   team reuse on the server. That is why `RoundEntry` grants players read but
 *   never update: otherwise one player could flip another's `paid` flag or
 *   resurrect their own eliminated entry.
 * - **`email` is field-restricted.** Guests never see it; players see their own;
 *   admins see all.
 */

const schema = a
  .schema({
    // -----------------------------------------------------------------------
    // Reference data
    // -----------------------------------------------------------------------

    Season: a
      .model({
        name: a.string().required(), // e.g. "2026/27"
        startYear: a.integer().required(),
        providerCompetitionCode: a.string(), // "PL"
        providerSeasonId: a.integer(),
        currentMatchday: a.integer(),
        active: a.boolean().required(),
        /** True for the synthetic season that holds imported historical teams. */
        isLegacy: a.boolean().default(false),
        teams: a.hasMany('Team', 'seasonId'),
        rounds: a.hasMany('KillerRound', 'seasonId'),
        fixtures: a.hasMany('Fixture', 'seasonId'),
      })
      // No secondary index: there are a handful of seasons ever, so the active
      // one is found with a filtered list rather than a GSI on a boolean.
      .authorization((allow) => [
        allow.guest().to(['read']),
        allow.authenticated().to(['read']),
        allow.group('ADMIN'),
      ]),

    /**
     * The 20 teams of a season, maintained centrally so no React component has
     * to hard-code a team list.
     */
    Team: a
      .model({
        seasonId: a.id().required(),
        season: a.belongsTo('Season', 'seasonId'),
        providerId: a.integer(),
        name: a.string().required(),
        shortName: a.string().required(),
        code: a.string().required(), // "ARS"
        badgeUrl: a.url(),
        active: a.boolean().required(),
      })
      .secondaryIndexes((index) => [
        index('seasonId').sortKeys(['name']).queryField('listTeamsBySeason'),
      ])
      .authorization((allow) => [
        allow.guest().to(['read']),
        allow.authenticated().to(['read']),
        allow.group('ADMIN'),
      ]),

    // -----------------------------------------------------------------------
    // People
    // -----------------------------------------------------------------------

    Player: a
      .model({
        displayName: a.string().required(),
        /**
         * Restricted at field level: a field rule replaces the model rule
         * entirely, so guests cannot read this even though they can read the
         * rest of the record. The public leaderboard shows names, never emails.
         */
        email: a.email().authorization((allow) => [allow.group('ADMIN')]),
        /** Set when the invitation is accepted; null for imported legacy players. */
        cognitoUserId: a.string().authorization((allow) => [allow.group('ADMIN')]),
        active: a.boolean().required(),
        /**
         * Whether to email this player when they are eliminated, win, or the
         * round rolls over. Defaults on; automated mail to real people needs an
         * off switch even among friends.
         */
        notifyByEmail: a.boolean().default(true),
        entries: a.hasMany('RoundEntry', 'playerId'),
      })
      .secondaryIndexes((index) => [
        // The hot path: every authenticated request resolves its caller here.
        index('cognitoUserId').queryField('listPlayersByCognitoUserId'),
      ])
      .authorization((allow) => [
        // Names and active status only — the sensitive fields are locked above.
        allow.authenticated().to(['read']),
        allow.group('ADMIN'),
      ]),

    // -----------------------------------------------------------------------
    // The competition
    // -----------------------------------------------------------------------

    KillerRound: a
      .model({
        seasonId: a.id().required(),
        season: a.belongsTo('Season', 'seasonId'),
        number: a.integer().required(),
        status: a.enum(['DRAFT', 'ACTIVE', 'WON', 'ROLLOVER', 'ABANDONED']),
        /** Money is integer pence throughout. Default £5. */
        entryFeePence: a.integer().required(),
        /** Carried in from `previousRoundId` when that round rolled over. */
        rolloverInPence: a.integer().required(),
        /** What this round handed on, when it rolled over. */
        rolloverOutPence: a.integer().default(0),
        winnerPlayerId: a.id(),
        /**
         * The round whose pot rolled into this one. Makes the money trail
         * explicit and traversable rather than implied by round numbering.
         */
        previousRoundId: a.id(),
        startedAt: a.datetime(),
        completedAt: a.datetime(),
        /** `LEGACY_CSV` marks imported history so it is never mistaken for live data. */
        dataSource: a.enum(['LIVE', 'LEGACY_CSV']),
        notes: a.string(),
        entries: a.hasMany('RoundEntry', 'killerRoundId'),
        weeks: a.hasMany('RoundWeek', 'killerRoundId'),
        selections: a.hasMany('Selection', 'killerRoundId'),
      })
      .secondaryIndexes((index) => [
        index('seasonId').sortKeys(['number']).queryField('listRoundsBySeason'),
        index('status').sortKeys(['number']).queryField('listRoundsByStatus'),
      ])
      .authorization((allow) => [
        // Safe to publish: round number, status, pot inputs, winner.
        allow.guest().to(['read']),
        allow.authenticated().to(['read']),
        allow.group('ADMIN'),
      ]),

    /**
     * A player's participation in one Killer Round.
     *
     * Players get `read` and nothing else. `paid` is changed through
     * `markSelfPaid` (own entry only) or `adminSetPaid` (audited); `status` is
     * changed only by result processing.
     */
    RoundEntry: a
      .model({
        killerRoundId: a.id().required(),
        killerRound: a.belongsTo('KillerRound', 'killerRoundId'),
        playerId: a.id().required(),
        player: a.belongsTo('Player', 'playerId'),
        status: a.enum(['ALIVE', 'ELIMINATED', 'WINNER']),
        paid: a.boolean().required(),
        paidAt: a.datetime(),
        /** Who recorded the payment: the player themselves, or an admin. */
        paidBy: a.string(),
        /**
         * The fee this entrant incurred, captured at entry. Editing the round's
         * fee later cannot retroactively change what anybody owed.
         */
        entryFeePence: a.integer().required(),
        eliminatedRoundWeekId: a.id(),
        selections: a.hasMany('Selection', 'roundEntryId'),
      })
      .secondaryIndexes((index) => [
        index('killerRoundId').queryField('listEntriesByRound'),
        index('playerId').queryField('listEntriesByPlayer'),
      ])
      .authorization((allow) => [
        allow.authenticated().to(['read']),
        allow.group('ADMIN'),
      ]),

    RoundWeek: a
      .model({
        killerRoundId: a.id().required(),
        killerRound: a.belongsTo('KillerRound', 'killerRoundId'),
        sequenceNumber: a.integer().required(),
        /** The EPL matchday. Null only for imported legacy weeks. */
        matchday: a.integer(),
        /** UTC. Normally the first fixture's kick-off; the admin may override. */
        deadline: a.datetime(),
        deadlineSource: a.enum(['FIRST_FIXTURE', 'MANUAL']),
        status: a.enum(['DRAFT', 'OPEN', 'LOCKED', 'RESULTS_PENDING', 'COMPLETE']),
        lockedAt: a.datetime(),
        /** The table used for this week's automatic picks. Immutable once set. */
        standingsSnapshotId: a.id(),
        resultsProcessedAt: a.datetime(),
        completedAt: a.datetime(),
        selections: a.hasMany('Selection', 'roundWeekId'),
      })
      .secondaryIndexes((index) => [
        index('killerRoundId').sortKeys(['sequenceNumber']).queryField('listWeeksByRound'),
        // The scheduler's only hot query: one hit says whether work is due.
        index('status').sortKeys(['deadline']).queryField('listWeeksByStatusAndDeadline'),
      ])
      .authorization((allow) => [
        allow.guest().to(['read']),
        allow.authenticated().to(['read']),
        allow.group('ADMIN'),
      ]),

    /**
     * A pick.
     *
     * Note what is missing: any read or write rule for `guest` or
     * `authenticated`. Selections are reachable only through
     * `getCompetitionView`, which applies the deadline-based redaction. This is
     * the model where the privacy rule is actually enforced.
     *
     * `id` is `{roundWeekId}#{roundEntryId}`, set explicitly on create. Amplify's
     * create resolver puts with `attribute_not_exists(id)`, so one-pick-per-
     * player-per-week is a database constraint and the deadline processor's
     * auto-picks are idempotent under concurrency with no extra locking.
     */
    Selection: a
      .model({
        roundWeekId: a.id().required(),
        roundWeek: a.belongsTo('RoundWeek', 'roundWeekId'),
        roundEntryId: a.id().required(),
        roundEntry: a.belongsTo('RoundEntry', 'roundEntryId'),
        killerRoundId: a.id().required(),
        killerRound: a.belongsTo('KillerRound', 'killerRoundId'),
        playerId: a.id().required(),
        /** Null when the auto-picker found nobody eligible. */
        /**
         * Plain foreign key rather than a `belongsTo`: the relation is never
         * traversed, because `teamName`/`teamCode` below are denormalised
         * snapshots. That keeps relegated and legacy teams rendering correctly
         * in history without a join.
         */
        teamId: a.id(),
        /** Snapshots, so relegated and legacy teams still render in history. */
        teamName: a.string(),
        teamCode: a.string(),
        selectionType: a.enum(['MANUAL', 'AUTO_LOWEST_POSITION', 'ADMIN', 'LEGACY']),
        selectedAt: a.datetime().required(),
        lockedAt: a.datetime(),
        outcome: a.enum(['PENDING', 'SURVIVED', 'ELIMINATED', 'UNKNOWN']),
        /** True once an admin has set the team or outcome by hand. */
        overridden: a.boolean().default(false),
        overrideNote: a.string(),
        fixtureId: a.id(),
        /** The table this automatic pick was derived from. Never recomputed. */
        standingsSnapshotId: a.id(),
        autoReason: a.enum(['AUTO_LOWEST_POSITION', 'AUTO_NO_ELIGIBLE_TEAM']),
        /** Human-readable explanation of an automatic assignment. */
        autoNote: a.string(),
        resolvedAt: a.datetime(),
      })
      .secondaryIndexes((index) => [
        index('roundWeekId').queryField('listSelectionsByWeek'),
        index('roundEntryId').queryField('listSelectionsByEntry'),
        index('killerRoundId').sortKeys(['playerId']).queryField('listSelectionsByRoundAndPlayer'),
        index('teamId').queryField('listSelectionsByTeam'),
      ])
      .authorization((allow) => [allow.group('ADMIN')]),

    // -----------------------------------------------------------------------
    // Imported football data
    // -----------------------------------------------------------------------

    Fixture: a
      .model({
        seasonId: a.id().required(),
        season: a.belongsTo('Season', 'seasonId'),
        providerMatchId: a.integer(),
        matchday: a.integer().required(),
        utcKickoff: a.datetime().required(),
        status: a.enum([
          'SCHEDULED',
          'TIMED',
          'IN_PLAY',
          'PAUSED',
          'FINISHED',
          'AWARDED',
          'POSTPONED',
          'SUSPENDED',
          'CANCELLED',
          'UNKNOWN',
        ]),
        homeTeamId: a.id().required(),
        awayTeamId: a.id().required(),
        homeGoals: a.integer(),
        awayGoals: a.integer(),
        winner: a.enum(['HOME', 'AWAY', 'DRAW']),
        providerLastUpdated: a.datetime(),
      })
      .secondaryIndexes((index) => [
        index('seasonId').sortKeys(['matchday']).queryField('listFixturesBySeasonAndMatchday'),
      ])
      .authorization((allow) => [
        allow.guest().to(['read']),
        allow.authenticated().to(['read']),
        allow.group('ADMIN'),
      ]),

    /** One row of a league table. Embedded, not a model — see below. */
    StandingRow: a.customType({
      teamId: a.id().required(),
      providerTeamId: a.integer(),
      position: a.integer().required(),
      playedGames: a.integer().required(),
      points: a.integer().required(),
      goalDifference: a.integer().required(),
    }),

    /**
     * An immutable capture of the league table.
     *
     * The 20 rows are embedded rather than kept in a second table: they are
     * always read together, so this is one item and one read. Immutability is
     * the point — a historical automatic pick must remain explainable from the
     * table as it stood, not as it stands now.
     */
    StandingsSnapshot: a
      .model({
        seasonId: a.id().required(),
        matchday: a.integer(),
        capturedAt: a.datetime().required(),
        source: a.enum(['PROVIDER', 'MANUAL']),
        rows: a.ref('StandingRow').array(),
      })
      .secondaryIndexes((index) => [
        index('seasonId').sortKeys(['capturedAt']).queryField('listSnapshotsBySeason'),
      ])
      .authorization((allow) => [
        allow.guest().to(['read']),
        allow.authenticated().to(['read']),
        allow.group('ADMIN'),
      ]),

    // -----------------------------------------------------------------------
    // Operational audit
    // -----------------------------------------------------------------------

    FootballDataSync: a
      .model({
        kind: a.enum(['TEAMS', 'FIXTURES', 'STANDINGS', 'RESULTS', 'COMPETITION']),
        trigger: a.enum(['SCHEDULE', 'ADMIN']),
        status: a.enum(['SUCCESS', 'FAILURE', 'PARTIAL']),
        startedAt: a.datetime().required(),
        finishedAt: a.datetime(),
        message: a.string(),
        itemsWritten: a.integer(),
        requestCount: a.integer(),
        seasonId: a.id(),
        matchday: a.integer(),
      })
      .secondaryIndexes((index) => [
        index('kind').sortKeys(['startedAt']).queryField('listSyncsByKind'),
      ])
      .authorization((allow) => [
        allow.group('ADMIN').to(['read']),
      ]),

    /** Administrative overrides and automated decisions, for later inspection. */
    AdminAuditEvent: a
      .model({
        at: a.datetime().required(),
        /** Cognito subject of the actor, or `system` for automated decisions. */
        actorSub: a.string(),
        actorName: a.string(),
        action: a.string().required(),
        entityType: a.string(),
        entityId: a.string(),
        killerRoundId: a.id(),
        /** JSON strings: enough to reconstruct what changed, without a schema. */
        before: a.json(),
        after: a.json(),
        note: a.string(),
      })
      .secondaryIndexes((index) => [
        index('action').sortKeys(['at']).queryField('listAuditByAction'),
        index('killerRoundId').sortKeys(['at']).queryField('listAuditByRound'),
      ])
      .authorization((allow) => [
        allow.group('ADMIN').to(['read']),
      ]),

    // =======================================================================
    // Custom operations
    //
    // Everything a player or the public can do goes through one of these, so
    // the business rules live in one auditable place instead of being spread
    // across client-side model calls.
    // =======================================================================

    /**
     * Everything the home page, competition table and public view need, in one
     * call, with selections already redacted for the caller.
     *
     * Returns `a.json()` rather than a hand-written GraphQL type: the shape is
     * defined once in `shared/domain/visibility.ts` and used by both sides, and
     * a deep nested type here would be a second definition to keep in step.
     */
    getCompetitionView: a
      .query()
      .arguments({ killerRoundId: a.id() })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [
        allow.guest(),
        allow.authenticated(),
        allow.group('ADMIN'),
      ]),

    /** Past rounds, winners, the rollover chain and per-player statistics. */
    getHistoryView: a
      .query()
      .arguments({ seasonId: a.id() })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [
        allow.guest(),
        allow.authenticated(),
        allow.group('ADMIN'),
      ]),

    /**
     * Make or change a pick. All enforcement is here: caller identity, entry
     * alive, week open, deadline not passed, team not already used, team in
     * season. The client's disabled buttons are a courtesy, not a control.
     */
    submitSelection: a
      .mutation()
      .arguments({ roundWeekId: a.id().required(), teamId: a.id().required() })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [allow.authenticated()]),

    /** A player marks their own entry paid. Cannot touch anybody else's. */
    markSelfPaid: a
      .mutation()
      .arguments({ killerRoundId: a.id().required() })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [allow.authenticated()]),

    // --- Administrative -----------------------------------------------------

    adminSetPaid: a
      .mutation()
      .arguments({ roundEntryId: a.id().required(), paid: a.boolean().required() })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [allow.group('ADMIN')]),

    /** Correct a pick or a result when the provider has it wrong. Audited. */
    adminOverrideSelection: a
      .mutation()
      .arguments({
        roundWeekId: a.id().required(),
        roundEntryId: a.id().required(),
        teamId: a.id(),
        outcome: a.string(),
        note: a.string(),
      })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [allow.group('ADMIN')]),

    /** Create a Player and, optionally, invite them into Cognito. */
    adminInvitePlayer: a
      .mutation()
      .arguments({
        displayName: a.string().required(),
        email: a.email().required(),
        makeAdmin: a.boolean(),
        sendInvite: a.boolean(),
      })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [allow.group('ADMIN')]),

    /**
     * Enter a pick on a player's behalf, for picks that arrive by message.
     *
     * Runs the same validation as a player's own pick — team reuse and
     * elimination are still enforced — and produces a normal, resolvable
     * selection rather than an override.
     */
    adminSubmitSelectionFor: a
      .mutation()
      .arguments({
        roundWeekId: a.id().required(),
        playerId: a.id().required(),
        teamId: a.id().required(),
        allowAfterDeadline: a.boolean(),
      })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [allow.group('ADMIN')]),

    /**
     * Add or remove a single entrant, before or after the round has started.
     *
     * `adminStartRound` enters everybody active, which covers the usual case,
     * but people join late and drop out. Removal refuses once they have made a
     * selection, so history is never orphaned.
     */
    adminSetEntrant: a
      .mutation()
      .arguments({
        killerRoundId: a.id().required(),
        playerId: a.id().required(),
        entered: a.boolean().required(),
      })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [allow.group('ADMIN')]),

    /** Deactivate a player without deleting any of their history. */
    adminSetPlayerActive: a
      .mutation()
      .arguments({ playerId: a.id().required(), active: a.boolean().required() })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [allow.group('ADMIN')]),

    /** Manual sync buttons. The provider token never leaves the Lambda. */
    adminSyncFootballData: a
      .mutation()
      .arguments({
        kind: a.string().required(), // TEAMS | FIXTURES | STANDINGS | RESULTS | COMPETITION
        seasonId: a.id(),
        matchday: a.integer(),
      })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [allow.group('ADMIN')]),

    /** Run the same planner the scheduler runs. Safe to press twice. */
    adminProcessDeadlines: a
      .mutation()
      .arguments({ roundWeekId: a.id(), dryRun: a.boolean() })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [allow.group('ADMIN')]),

    adminProcessResults: a
      .mutation()
      .arguments({ roundWeekId: a.id(), dryRun: a.boolean() })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [allow.group('ADMIN')]),

    /** Declare a winner or a rollover by hand, e.g. when the season ends. */
    adminCompleteRound: a
      .mutation()
      .arguments({
        killerRoundId: a.id().required(),
        resolution: a.string().required(), // WON | ROLLOVER | ABANDONED
        winnerPlayerId: a.id(),
        note: a.string(),
      })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [allow.group('ADMIN')]),

    /**
     * Start a round: snapshot the entry fee onto every entry, set the rollover
     * carried in from the previous round, and open it for selections.
     */
    adminStartRound: a
      .mutation()
      .arguments({
        killerRoundId: a.id().required(),
        playerIds: a.string().array(),
      })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [allow.group('ADMIN')]),

    /** Add a Round Week, proposing the deadline from the gameweek's fixtures. */
    adminCreateRoundWeek: a
      .mutation()
      .arguments({
        killerRoundId: a.id().required(),
        matchday: a.integer().required(),
        deadline: a.datetime(),
        open: a.boolean(),
      })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [allow.group('ADMIN')]),

    /** Open or lock a week by hand. */
    adminSetWeekStatus: a
      .mutation()
      .arguments({ roundWeekId: a.id().required(), status: a.string().required() })
      .returns(a.json())
      .handler(a.handler.function(killerApi))
      .authorization((allow) => [allow.group('ADMIN')]),
  })
  .authorization((allow) => [allow.resource(killerApi), allow.resource(killerScheduler)]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    // Signed-in players and admins are the normal case.
    defaultAuthorizationMode: 'userPool',
    // Guest (identity pool) access powers the public view. Unlike an API key it
    // does not expire, so the public site cannot silently go dark after a year.
  },
});
