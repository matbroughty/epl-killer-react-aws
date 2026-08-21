# Legacy CSV migration report

This was a **dry run**. Nothing was written.

## Source

`https://d2gxtwxranyjlp.cloudfront.net/killer.csv`

- 11 player names: Mat, Jase, Pia, Jon, Frank, Tim, Todd, George, Erik, Dave, Matt
- 29 round blocks found, 29 imported
- 23 distinct teams resolved
- 0 cell(s) could not be resolved to a team

## What was imported

| Data | Source |
| --- | --- |
| Player display names | CSV header row |
| Ordered pick sequences per player per round | one row per Round Week |
| Round winners | the `+` mark, placed in the winner's column on the row after their last pick |
| Round outcome (won / rollover) | `+` present, or a final row entirely `x` |
| Elimination week | a player's last pick, where others played on afterwards |
| Round order | reverse file order — the file runs newest first |

## What was NOT imported, and why

These are absent from the source. They are stored as null rather than guessed, because a plausible-looking
invented value is worse than an obvious gap:

- **EPL gameweek / matchday** — never recorded. `RoundWeek.matchday` is null.
- **Dates, kick-off times, selection deadlines** — never recorded. `RoundWeek.deadline` is null, which the
  domain treats as "never open", so no imported week can accept a pick.
- **Fixtures and scores** — never recorded. Outcomes are inferred from the pick sequence, not from results.
- **Entry fees and pot sizes** — never recorded. `entryFeePence` is **0**, not £5, so the history page shows
  `—` instead of a fabricated pot.
- **Payment status** — never recorded. `paid` is false, meaning "not recorded"; with a £0 fee this cannot
  misrepresent money owed.
- **Rollover amounts and the rollover chain** — never recorded. `previousRoundId` is null on every imported
  round, so no money trail is implied between them.
- **Manual versus automatic picks** — never distinguished. Every imported pick is `selectionType: LEGACY`.
- **Selection timestamps** — never recorded. `selectedAt` is the epoch, which marks these unmistakably as
  imported.

## Assumptions and data quality

### Ambiguous column mapping (9 round(s))

The oldest blocks have fewer columns than the 11-name header, because fewer people played then. The file does
not record which names those columns belonged to. Columns were mapped **left-to-right against the header**,
which is the only available ordering but is an assumption, not a fact. Affected rounds carry
`AMBIGUOUS_COLUMNS` in their notes:

- block 28: 9 columns against 11 names
- block 27: 9 columns against 11 names
- block 26: 9 columns against 11 names
- block 25: 9 columns against 11 names
- block 24: 9 columns against 11 names
- block 23: 9 columns against 11 names
- block 22: 9 columns against 11 names
- block 21: 9 columns against 11 names
- block 20: 10 columns against 11 names

### Undetermined outcomes (3 round(s))

Blocks with no `+` and no all-`x` final row. Most likely rounds still in progress when the spreadsheet was
retired. Imported as `ABANDONED` with an explanatory note rather than being forced into a winner or a rollover:

- block 23, 8 week(s)
- block 8, 5 week(s)
- block 0, 7 week(s)

### Normalised spellings

A decade of typing produced `Necastle`, `Newastle`, `Forrest`, `Liecester`, `ManCity`, `Man U`, `Sheff Utd`
and `City`. These were resolved through `shared/domain/teamNames.ts`, which is tested against exactly these
cases. One cell, `Liverpool(Southampton)`, recorded two teams; the first was taken and the full original
string is preserved in the selection's override note.

### Row width

One row carries a trailing comma, producing 12 fields against 11 names. The extra field was ignored, matching
what the previous application did.

### Unresolved cells

None. Every non-empty cell resolved to a known team.

## Legacy teams

Historical picks include clubs that are not in the current Premier League. Rather than adding them to the live
season's twenty, they live in a season named `Legacy (pre-2025/26)` with `isLegacy: true` and
`active: false`. Every legacy selection therefore points at a real Team record — so statistics work across
eras — while none of them can appear in a live pick list.

ARS (Arsenal), AVL (Aston Villa), BOU (Bournemouth), BRE (Brentford), BHA (Brighton & Hove Albion), CHE (Chelsea), CRY (Crystal Palace), EVE (Everton), FUL (Fulham), IPS (Ipswich Town), LEE (Leeds United), LEI (Leicester City), LIV (Liverpool), MCI (Manchester City), MUN (Manchester United), NEW (Newcastle United), NOT (Nottingham Forest), SHU (Sheffield United), SOU (Southampton), SUN (Sunderland), TOT (Tottenham Hotspur), WHU (West Ham United), WOL (Wolverhampton Wanderers)

## Imported players

Created with `active: false` and no email or Cognito link. Importing history must not silently enter eleven
people into the next live round; an administrator invites the real people through the admin area, and
`resolveViewer` links a Player to their Cognito subject the first time they sign in.

## Rounds

| Round | CSV block | Outcome | Winner | Weeks | Entrants | Picks |
| --- | --- | --- | --- | --- | --- | --- |
| — | 28 | WON | Frank | 5 | 9 | 28 |
| — | 27 | WON | Mat | 4 | 9 | 18 |
| — | 26 | WON | Mat | 7 | 9 | 35 |
| — | 25 | ROLLOVER | — | 6 | 8 | 26 |
| — | 24 | WON | Mat | 4 | 8 | 19 |
| — | 23 | UNKNOWN | — | 8 | 9 | 30 |
| — | 22 | WON | Jon | 7 | 9 | 34 |
| — | 21 | WON | Frank | 10 | 9 | 33 |
| — | 20 | ROLLOVER | — | 5 | 10 | 27 |
| — | 19 | ROLLOVER | — | 4 | 11 | 20 |
| — | 18 | WON | Tim | 6 | 10 | 26 |
| — | 17 | WON | Pia | 5 | 10 | 19 |
| — | 16 | WON | Erik | 6 | 11 | 30 |
| — | 15 | WON | Jon | 10 | 9 | 45 |
| — | 14 | WON | Jase | 3 | 10 | 12 |
| — | 13 | WON | Mat | 6 | 10 | 37 |
| — | 12 | WON | Tim | 3 | 11 | 17 |
| — | 11 | WON | George | 3 | 10 | 15 |
| — | 10 | ROLLOVER | — | 5 | 11 | 32 |
| — | 9 | WON | Jon | 15 | 11 | 47 |
| — | 8 | UNKNOWN | — | 5 | 11 | 19 |
| — | 7 | WON | Dave | 9 | 11 | 48 |
| — | 6 | WON | George | 5 | 11 | 25 |
| — | 5 | WON | Mat | 6 | 11 | 31 |
| — | 4 | WON | Erik | 3 | 10 | 20 |
| — | 3 | ROLLOVER | — | 4 | 10 | 20 |
| — | 2 | WON | Erik | 5 | 11 | 32 |
| — | 1 | ROLLOVER | — | 4 | 9 | 13 |
| — | 0 | UNKNOWN | — | 7 | 10 | 29 |

## Re-running

Each imported round records `csvBlock=<n>` in its notes, and the importer skips blocks it has already done, so
rerunning it does not duplicate history.
