import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { AdminPage } from '@/pages/admin/AdminPage';
import { HistoryPage } from '@/pages/HistoryPage';
import { HomePage } from '@/pages/HomePage';
import { LoginPage } from '@/pages/LoginPage';
import { useAuth } from '@/lib/auth';

/**
 * The application shell and routes.
 *
 * Four routes. The public competition view is the default, so the site remains
 * useful to anyone who follows a link without an account.
 */
export default function App() {
  return (
    <div className="shell">
      <Masthead />
      <main>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/admin/*"
            element={
              <RequireAdmin>
                <AdminPage />
              </RequireAdmin>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <SiteFooter />
    </div>
  );
}

/**
 * Attribution is a condition of the football-data.org free tier, which requires
 * a visible credit in the footer, about section or similar. It is a licence
 * obligation, not decoration — do not remove it while that provider is in use.
 */
function SiteFooter() {
  return (
    <footer className="footer">
      <p>
        Football data provided by the{' '}
        <a href="https://www.football-data.org/" target="_blank" rel="noreferrer noopener">
          Football-Data.org
        </a>{' '}
        API.
      </p>
      <p>Fourfold Killer · times shown in UK local time</p>
    </footer>
  );
}

function Masthead() {
  const { user, signOut } = useAuth();

  return (
    <header className="masthead">
      <div className="masthead__brand">
        <NavLink to="/" className="masthead__title" style={{ color: 'inherit' }}>
          Fourfold <span>Killer</span>
        </NavLink>
        <span className="masthead__sub">Premier League Last Man Standing</span>
      </div>

      <nav className="masthead__nav">
        <NavLink
          to="/history"
          className={({ isActive }) => `navlink ${isActive ? 'navlink--active' : ''}`}
        >
          History
        </NavLink>
        {user?.isAdmin && (
          <NavLink
            to="/admin"
            className={({ isActive }) => `navlink ${isActive ? 'navlink--active' : ''}`}
          >
            Admin
          </NavLink>
        )}
        {user ? (
          <button type="button" className="navlink" onClick={() => void signOut()}>
            Sign out
          </button>
        ) : (
          <NavLink
            to="/login"
            className={({ isActive }) => `navlink ${isActive ? 'navlink--active' : ''}`}
          >
            Sign in
          </NavLink>
        )}
      </nav>
    </header>
  );
}

/**
 * Hides the admin area from everyone else.
 *
 * A convenience, not a control: every admin operation is authorized again by
 * AppSync against the signed token, so bypassing this in the browser gets you a
 * page of failed requests.
 */
function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return <div className="loading">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (!user.isAdmin) {
    return (
      <div className="notice notice--error" role="alert">
        This area is for administrators.
      </div>
    );
  }
  return <>{children}</>;
}
