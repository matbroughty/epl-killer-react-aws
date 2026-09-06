import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatPence } from '@shared/domain/money';
import { fetchCompetitionView } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/**
 * How the competition works, at a glance.
 *
 * Public, because someone following a link should be able to understand the
 * game without an account. Kept short and scannable on purpose — this is the
 * page people check to settle an argument, not something they read end to end.
 *
 * The entry fee is read from the live round rather than written into the copy,
 * since it is configurable per round and hard-coded money goes stale silently.
 */
export function RulesPage() {
  const { user, loading } = useAuth();
  const [entryFeePence, setEntryFeePence] = useState<number | null>(null);

  useEffect(() => {
    if (loading) return;
    // Best effort: the rules stand whether or not a round is running.
    fetchCompetitionView(Boolean(user))
      .then((view) => setEntryFeePence(view.pot?.entryFeePence ?? null))
      .catch(() => setEntryFeePence(null));
  }, [loading, user]);

  const fee = formatPence(entryFeePence ?? 500);

  return (
    <>
      <h1 className="card__title" style={{ fontSize: '1.4rem', marginBottom: 16 }}>
        How it works
      </h1>

      <section className="card">
        <h2 className="card__title">The game</h2>
        <ol className="rules">
          <li>
            Each gameweek you pick <strong>one Premier League team</strong>.
          </li>
          <li>
            If your team <strong>wins</strong>, you survive to the next week.
          </li>
          <li>
            If your team <strong>draws or loses</strong>, you are out.
          </li>
          <li>
            You <strong>cannot pick the same team twice</strong> in a Killer Round. Teams you have
            used are shown crossed out.
          </li>
          <li>
            Last player standing <strong>wins the whole pot</strong>.
          </li>
        </ol>
      </section>

      <section className="card">
        <h2 className="card__title">Deadlines</h2>
        <p>
          The deadline is the <strong>kick-off of the first match of the gameweek</strong> — usually
          Friday or Saturday lunchtime. It is the same for everyone, whichever team you pick and
          whenever they happen to play.
        </p>
        <p>
          Change your pick as often as you like before then. After the deadline it is locked.
        </p>
        <div className="notice notice--warn">
          <strong>Forget to pick?</strong> You are not eliminated — but you do not get to choose.
          You are automatically given the <strong>lowest-placed team in the league</strong> that is
          playing that week and that you have not already used. Bottom of the table first, working
          upwards.
        </div>
      </section>

      <section className="card">
        <h2 className="card__title">Nobody sees your pick</h2>
        <p>
          Before the deadline, everyone else sees only <code>Submitted 🔒</code> against your name —
          never which team you chose. Once the deadline passes, all picks are revealed at the same
          time.
        </p>
        <p className="faint">
          This is enforced on the server, not just hidden in the page.
        </p>
      </section>

      <section className="card">
        <h2 className="card__title">Money</h2>
        <ul className="rules">
          <li>
            <strong>{fee} per player</strong>, per Killer Round.
          </li>
          <li>
            You owe it as soon as you enter, whether or not it has been marked as paid yet.
          </li>
          <li>The winner takes the entire pot.</li>
          <li>
            <strong>If everyone left goes out in the same week</strong>, there is no winner. The
            round is a <strong>rollover</strong> and the whole pot carries into the next one — so
            the next round is worth more.
          </li>
        </ul>
      </section>

      <section className="card">
        <h2 className="card__title">Odds and ends</h2>
        <ul className="rules">
          <li>
            <strong>Postponed match?</strong> Your pick stays pending until it is played. You are
            never knocked out because a game was called off.
          </li>
          <li>
            <strong>Eliminated?</strong> You are out for the rest of that Killer Round, but you go
            back in when the next one starts — and everyone's used teams reset.
          </li>
          <li>
            The gameweeks in a round <strong>need not be consecutive</strong>. The admin picks which
            ones count.
          </li>
          <li>Results come from the official fixture data, updated automatically after matches.</li>
        </ul>
      </section>

      <p className="center" style={{ marginTop: 20 }}>
        <Link to="/">← Back to the competition</Link>
        {' · '}
        <Link to="/history">Past rounds</Link>
      </p>
    </>
  );
}
