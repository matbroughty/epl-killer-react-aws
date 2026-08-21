# Production initialisation runbook

One-time setup for the `main` environment, in order. Roughly 15 minutes.

Production is a **completely separate backend** from your sandbox — its own Cognito user pool, its
own DynamoDB tables. Nothing you created in the sandbox exists here. That is the point: the
sandbox is disposable, this is not.

---

## 0. Prerequisites (already done)

| | |
| --- | --- |
| `amplify.yml` with the backend phase | committed |
| Amplify service role | `AMPLIFY_ASSUME`, trust policy covering `d3kbnyd2qvlcqc` |
| `FOOTBALL_DATA_TOKEN` | `/amplify/shared/d3kbnyd2qvlcqc/FOOTBALL_DATA_TOKEN` |

## 1. Wait for the build

```bash
aws amplify list-jobs --app-id d3kbnyd2qvlcqc --branch-name main --region eu-west-2 \
  --max-results 1 --query 'jobSummaries[0].{Status:status,Job:jobId}' --output table
```

`SUCCEED` before continuing. On `FAILED`, read the backend phase log in the Amplify console — a
first fullstack deploy fails most often on the service role or a missing secret, both of which are
covered above.

Live at <https://killer.fourfold.co.uk> once green. It should render the public view with
"No Killer Round yet" — no login required.

## 2. Pull the production outputs

The scripts need to talk to production, so fetch its config into a **separate directory** so your
sandbox `amplify_outputs.json` survives:

```bash
mkdir -p .prod
npx ampx generate outputs --app-id d3kbnyd2qvlcqc --branch main --out-dir .prod
POOL=$(node -p "require('./.prod/amplify_outputs.json').auth.user_pool_id")
echo "production user pool: $POOL"
```

`.prod/` is gitignored. Every script below takes `--outputs .prod/amplify_outputs.json`.

## 3. Create the first administrator

Public sign-up is closed, so this cannot be done through the site.

```bash
EMAIL=you@example.com

aws cognito-idp admin-create-user --region eu-west-2 \
  --user-pool-id "$POOL" --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS

aws cognito-idp admin-add-user-to-group --region eu-west-2 \
  --user-pool-id "$POOL" --username "$EMAIL" --group-name ADMIN

aws cognito-idp admin-set-user-password --region eu-west-2 \
  --user-pool-id "$POOL" --username "$EMAIL" \
  --password 'at-least-10-chars-with-a-number' --permanent
```

`--message-action SUPPRESS` skips the invitation email, and `--permanent` avoids the forced
password change — together they mean no reliance on Cognito's default email, which is
spam-prone. See the SES section of the README to fix that properly before inviting players.

Sign in at <https://killer.fourfold.co.uk/login>. `Admin` should appear in the navigation.

## 4. Season and football data

*Admin → Rounds → Seasons*: enter `2026`, **Create season**. It becomes active as the first one.

Then *Admin → Football data*, and sync **in this order** — each depends on the last:

1. **Competition** — picks up `currentMatchday`
2. **Teams** — fixtures cannot be attributed without them
3. **Fixtures** — whole season, one request
4. **Standings** — needs teams; captures the first snapshot

Expect "20 team(s) imported" and "380 fixture(s) imported". Anything else is in the *Sync log* on
that page.

## 5. Killer Round

*Admin → Rounds → Create a Killer Round*: entry fee £5, nothing rolled over (Round 1).

Do **not** press Start yet if you are about to bulk-import players — Start enters everyone *active
at that moment*, and there is nobody yet. Either:

- **Bulk import first** (step 6), then Start; or
- **Start now**, then use *Manage → Enter all remaining active players* afterwards.

Both work. The second is the recoverable path if you get the order wrong.

## 6. Players and picks

Point the bulk tool at production:

```bash
export KILLER_ADMIN_EMAIL=you@example.com
export KILLER_ADMIN_PASSWORD='...'

npm run bulk -- --file picks-gw1.txt --outputs .prod/amplify_outputs.json          # dry run
npm run bulk -- --file picks-gw1.txt --outputs .prod/amplify_outputs.json --commit
```

Creates players with **no Cognito user** (`sendInvite: false`), enters them, sets payment flags and
records picks. Idempotent — safe to re-run.

It needs a Round Week to exist for the picks, so add one first (step 7) or run it twice: once to
create players and entries, once more after the week exists to attach picks.

## 7. Round Week

*Admin → Round Weeks*: choose the gameweek. The deadline defaults to that gameweek's first
kick-off; override it if you want. **Add and open**.

From here the scheduler takes over. Every 15 minutes it will:

- lock the week once the deadline passes, assigning the lowest-placed eligible team to anyone
  without a pick
- pull results once fixtures could have finished, and resolve outcomes
- refresh fixtures and standings daily

Nothing else needs pressing. The admin buttons exist for when you want to force it.

## 8. Historical data (optional)

```bash
npm run import:legacy -- --outputs .prod/amplify_outputs.json                # dry run
npm run import:legacy -- --outputs .prod/amplify_outputs.json --commit
```

29 rounds, 787 picks, 20 winners into `/history`. Read `docs/MIGRATION_REPORT.md` first — it
documents the nine rounds whose column-to-player mapping is an assumption, and the three whose
outcome could not be determined.

## 9. Tidy up

```bash
npx ampx sandbox delete        # when you no longer need the sandbox
```

Remove the now-unused `VITE_CSV_URL` variable from the Amplify console. The CSV's S3 bucket and
CloudFront distribution (`E2HS1JC1TWFE6R`) are read-only history and can be retired.

---

## Verification

| Check | Expected |
| --- | --- |
| `/` as a guest, signed out | round, pot, players, picks as `Submitted 🔒` before the deadline |
| `/history` | past rounds if imported, otherwise "No history yet" |
| `/admin` signed out | redirects to login |
| *Admin → Football data* | last successful sync for all four kinds |
| *Admin → Audit* | `KILLER_ROUND_STARTED`, `ROUND_WEEK_CREATED`, entrants, picks |
| After the deadline | picks revealed to everyone, including guests |
| After results | outcomes resolved, eliminations applied, week `COMPLETE` |

The last two are the ones worth actually waiting for — they are the automation, and nobody has
seen it run against real fixtures yet.
