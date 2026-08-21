# Fourfold Killer — Implementation Plan

Phase 1 (Discovery) complete. This is the design the rewrite follows.

## 1. What exists today

| | |
| --- | --- |
| App | Vite + React 18 + TS, ~600 lines, no router, no tests. A CSV table renderer. |
| Backend | `amplify/` is untouched Gen 2 boilerplate — a `Todo` model with `allow.guest()` full CRUD. Never deployed. |
| Dead code | `src/amplify.ts` uses `require('./aws-exports')` inside ESM; always throws, always falls back to empty config. |
| Worth keeping | `teamAbbreviations.ts`, `useMediaQuery`, the dark-navy identity. |
| Infra (verified via CLI) | Amplify app `d3kbnyd2qvlcqc`, **eu-west-2**, branch `main`, domain `killer.fourfold.co.uk` (verified cert), rewrite `/<*>` → `/index.html`. Build spec is static-only. |
| CSV | Separate S3 + CloudFront `E2HS1JC1TWFE6R`. Live file (199 lines) is 2 rounds newer than the committed `s3/killer.csv`. |

Keep: app, branch, domain, rewrite rule. Replace: build spec (add `ampx pipeline-deploy`), everything in `src/`, everything in `amplify/`.

## 2. Provider verification (football-data.org v4, current docs)

`https://api.football-data.org/v4`, header **`X-Auth-Token`**, free tier **10 req/min** (429 + retry headers), EPL code **`PL`**.
Endpoints used: `/competitions/PL`, `/competitions/PL/teams?season=`, `/competitions/PL/matches?season=&matchday=`, `/competitions/PL/standings?season=`.
Match status enum: `SCHEDULED TIMED IN_PLAY PAUSED FINISHED POSTPONED SUSPENDED CANCELLED AWARDED`. `score.winner`: `HOME_TEAM | AWAY_TEAM | DRAW | null`. Crests usable as badge URLs.

## 3. Architecture

```
React SPA ──AppSync──┬─ direct model access (ADMIN only)
 (Amplify Hosting)   ├─ killer-api        Lambda, AppSync resolver router
                     └─ killer-scheduler  Lambda, EventBridge every 15m
                            │
                     DynamoDB (Amplify Data) ── football-data.org (token in Secrets)
```

Two Lambdas, not a dozen: `killer-api` routes on `event.info.fieldName` (AppSync still enforces per-field authz before invoking; the router re-checks `cognito:groups` for admin fields). `killer-scheduler` runs the *same* pure planners on a timer, so the automated and admin-button paths cannot drift.

**Pure planners, thin executors.** `shared/domain/` has no AWS imports and no I/O:

```
validateSelection(req, state, clock)   -> Ok | Rejected(reason)
pickAutoTeam({standings, fixtures, usedTeamIds}) -> teamId | null
resolveOutcome(selection, fixture)     -> PENDING | SURVIVED | ELIMINATED
resolveRoundWeek(outcomes)             -> PENDING | WINNER | ROLLOVER | CONTINUE
planDeadlineProcessing(state, clock)   -> DeadlinePlan
planResultProcessing(state)            -> ResultPlan
redactSelections(view, viewer, clock)  -> view
computePot(round, entries)             -> PotBreakdown (pence)
```

Idempotency becomes testable: apply a plan, re-plan against the result, assert empty. Time is injected via `Clock`, so deadline tests are deterministic.

Money: integer pence everywhere, default fee `500`. Time: ISO-8601 UTC stored, `Europe/London` only in `Intl.DateTimeFormat` at the presentation edge. No date library.

## 4. Schema

| Model | Key fields | Indexes |
| --- | --- | --- |
| `Season` | name, startYear, providerCompetitionCode, providerSeasonId, active, currentMatchday, isLegacy | byActive |
| `Team` | seasonId, providerId, name, shortName, code, badgeUrl, active | bySeason, bySeasonAndProviderId |
| `Player` | displayName, email, cognitoUserId, active | byCognitoUserId, byEmail |
| `KillerRound` | seasonId, number, status, entryFeePence, rolloverInPence, rolloverOutPence, winnerPlayerId, previousRoundId, startedAt, completedAt, dataSource, notes | bySeasonAndNumber, byStatus |
| `RoundEntry` | killerRoundId, playerId, status, paid, paidAt, paidBy, entryFeePence, eliminatedRoundWeekId | byKillerRound, byPlayer |
| `RoundWeek` | killerRoundId, sequenceNumber, matchday, deadline, deadlineSource, status, lockedAt, standingsSnapshotId, resultsProcessedAt | byKillerRoundAndSequence, byStatusAndDeadline |
| `Selection` | **id = `{roundWeekId}#{roundEntryId}`**, roundWeekId, roundEntryId, playerId, killerRoundId, teamId, teamName, teamCode, selectionType, selectedAt, lockedAt, outcome, fixtureId, standingsSnapshotId, autoReason, overrideNote | byRoundWeek, byRoundEntry, byKillerRoundAndPlayer, byTeam |
| `Fixture` | seasonId, providerMatchId, matchday, utcKickoff, status, home/awayTeamId, home/awayGoals, winner, providerLastUpdated | bySeasonAndMatchday, byProviderMatchId |
| `StandingsSnapshot` | seasonId, matchday, capturedAt, source, `rows: [StandingRow]` (embedded) | bySeasonAndCapturedAt |
| `FootballDataSync` | kind, trigger, status, startedAt, finishedAt, message, itemsWritten, requestCount | byKindAndStartedAt |
| `AdminAuditEvent` | at, actorSub, actorName, action, entityType, entityId, killerRoundId, before, after, note | byAt, byEntity |

Deliberate choices:

- **Deterministic `Selection.id`** makes "one pick per player per week" a DB constraint — Amplify's `create` puts with `attribute_not_exists(id)`, so auto-pick creation is idempotent under concurrency with no extra locking.
- `Selection.teamName`/`teamCode` are **denormalised snapshots**, so relegated and legacy teams still render in history.
- `StandingsSnapshot.rows` is **embedded** (20 small rows always read together) — one item, one read, and immutable so historical auto-picks are never recomputed against a changed table.
- `RoundEntry.entryFeePence` **snapshots the fee at entry**, so editing a round's fee can't rewrite history. Expected pot sums *all* entrants' fees regardless of `paid`.
- `byStatusAndDeadline` is the scheduler's only hot query — one GSI hit says whether there's work.
- `previousRoundId` + `rolloverInPence`/`rolloverOutPence` make the money trail explicit and traversable.
- `dataSource: LIVE | LEGACY_CSV` keeps imported history from ever being mistaken for authoritative data.

## 5. Authorization

| Model | guest | PLAYER | ADMIN | functions |
| --- | --- | --- | --- | --- |
| Season, Team, Fixture, StandingsSnapshot | read | read | full | full |
| KillerRound | read | read | full | full |
| Player | — | read (`email` field: own + ADMIN) | full | full |
| RoundEntry | — | read | full | full |
| **Selection** | **none** | **none** | full | full |
| FootballDataSync, AdminAuditEvent | — | — | read | full |

Selections have **no** client read path. The only way to see picks is `getCompetitionView`, whose Lambda applies `redactSelections` server-side. Players also have no write on `RoundEntry`, so they cannot touch anyone's `paid` flag or their own `status`. Viewer identity comes only from `event.identity` (`sub`, `cognito:groups`); a guest/IAM identity is anonymous. Never from an argument.

| Custom operation | Auth | Server enforces |
| --- | --- | --- |
| `getCompetitionView(killerRoundId?)` | guest, auth, ADMIN | deadline redaction; emails never returned |
| `getHistoryView()` | guest, auth, ADMIN | past rounds, winners, rollover chain, stats |
| `submitSelection(roundWeekId, teamId)` | auth | identity, entry ALIVE, week OPEN, `now < deadline`, team unused this round, team in season |
| `markSelfPaid(killerRoundId)` | auth | caller's own entry only |
| `adminSetPaid` / `adminOverrideSelection` | ADMIN | audited |
| `adminInvitePlayer(name, email, admin)` | ADMIN | Cognito `AdminCreateUser` + group + `Player` |
| `adminSyncFootballData(kind, seasonId, matchday?)` | ADMIN | token stays server-side |
| `adminProcessDeadlines` / `adminProcessResults` | ADMIN | same planners as the scheduler |

## 6. Scheduler — one `every 15m` rule, state-driven

1. Query `RoundWeek byStatusAndDeadline`; nothing due → return (one DynamoDB query, zero external calls).
2. Deadline imminent/passed and snapshot stale → `getStandings()`, write `StandingsSnapshot`.
3. `planDeadlineProcessing`: lock week → auto-assign missing picks against that snapshot → lock selections → reveal.
4. Locked week with kick-off + 2h passed and unresolved outcomes → `getFixturesForMatchday()` → `planResultProcessing`.
5. Last successful fixtures/standings sync > 20h old → refresh both.

96 invocations/day, most a single query; a handful of provider calls per tick. Inside 10 req/min and the Lambda free tier. Provider failures are recorded on `FootballDataSync` and never reach a read path — reads always serve DynamoDB.

## 7. Frontend

`/` public view, or player home + pick UI when signed in · `/history` · `/login` · `/admin`.

`react-router-dom` only. No component library, no Redux, no date library, no CSS framework. Auth screens hand-rolled over `aws-amplify/auth` (`signIn`, `confirmSignIn` for `NEW_PASSWORD_REQUIRED`, `resetPassword`) — ~150 lines, avoids `@aws-amplify/ui-react`. One `styles.css` with custom properties, mobile-first, large tap targets, competition table scrolls in its own container with a sticky player column.

Runtime deps: `react`, `react-dom`, `react-router-dom`, `aws-amplify`.

## 8. Migration (`scripts/import-legacy-csv.ts`, run once)

CSV shape: header = player names; one block per round separated by `---`, **newest first**; one row per round week; `x` = no pick, `+` = winner (row *after* their last pick), `?` = unknown.

Imports: 11 player names, ordered pick sequences, round winners, inferred elimination week, round order (reverse file order). A `Season` named `Legacy (pre-2025/26)` holds a `Team` per distinct normalised legacy name, so every legacy pick resolves to a real `teamId` and stats work across eras without polluting the current 20.

Round status inference: `+` in a column → `WON`; else last row all `x` → `ROLLOVER`; else → `ABANDONED` + note (this is the in-progress top block).

Not imported, recorded as null, never guessed: gameweeks, dates, deadlines, fixtures, scores, entry fees, pot sizes, payment status, rollover amounts and the rollover chain.

Known dirt handled: older blocks have 9–10 columns against an 11-name header (mapped left-to-right, flagged `AMBIGUOUS_COLUMNS`); line 31 has a trailing comma (truncated to header width); misspellings `Necastle` `Newastle` `Forrest` `Liecester` `ManCity` `Man U` `Sheff Utd` `City` `Liverpool(Southampton)`; stray whitespace. The importer writes a report of every assumption and unmatched cell.

`s3/kent.csv` is an unrelated money sheet for a different group — out of scope. After import the database is authoritative; the app never reads the CSV.

## 9. Testing

`vitest` over `shared/domain/` and `shared/provider/` — money and elimination rules, not component snapshots. Every rule in the brief gets a named test, plus provider mapping, deadline proposal, pot/rollover arithmetic, redaction before/after deadline, and double-application of both planners.

## 10. Deployment changes

1. New fullstack build spec (`npx ampx pipeline-deploy --branch $AWS_BRANCH --app-id $AWS_APP_ID`).
2. Grant the Amplify service role backend-deploy permissions (one-time, README).
3. Set `FOOTBALL_DATA_TOKEN` — `npx ampx sandbox secret set` locally, *Hosting → Secrets* for `main`.
4. Drop the `VITE_CSV_URL` env var after migration.
5. Create the first ADMIN user, run the importer.

Domain, branch and rewrite rule unchanged.
