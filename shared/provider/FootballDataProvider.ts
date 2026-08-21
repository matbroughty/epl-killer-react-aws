import type { FixtureStatus, FixtureWinner } from '../domain/types.js';

/**
 * The boundary between the Killer application and whichever football data
 * service we happen to be using.
 *
 * This is the one place a speculative abstraction is justified: free football
 * APIs change their terms, their rate limits and their existence, and we do not
 * want that to touch the elimination rules. Everything below is *our* shape.
 * Nothing outside `shared/provider/` may reference a provider's own field names.
 *
 * To add a provider, implement this interface and map its responses into these
 * types. Nothing else changes.
 */

// ---------------------------------------------------------------------------
// Provider-neutral results
// ---------------------------------------------------------------------------

export interface ProviderCompetition {
  /** Provider's competition code, e.g. `PL`. */
  code: string;
  name: string;
  /** Provider's season identifier, needed for later calls. */
  seasonId: number | null;
  /** Season start year, e.g. 2026 for 2026/27. */
  startYear: number | null;
  startDate: string | null;
  endDate: string | null;
  /** The gameweek the competition is currently on. */
  currentMatchday: number | null;
}

export interface ProviderTeam {
  providerId: number;
  name: string;
  shortName: string;
  /** Three-letter code as supplied by the provider. */
  code: string;
  badgeUrl: string | null;
}

export interface ProviderFixture {
  providerMatchId: number;
  matchday: number;
  utcKickoff: string;
  status: FixtureStatus;
  homeProviderTeamId: number;
  awayProviderTeamId: number;
  homeGoals: number | null;
  awayGoals: number | null;
  winner: FixtureWinner | null;
  providerLastUpdated: string | null;
}

export interface ProviderStandingRow {
  providerTeamId: number;
  position: number;
  playedGames: number;
  points: number;
  goalDifference: number;
}

export interface ProviderStandings {
  /** The matchday the table reflects, when the provider tells us. */
  matchday: number | null;
  rows: ProviderStandingRow[];
}

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface FootballDataProvider {
  readonly name: string;

  /** Competition metadata, including the current matchday. */
  getCompetition(): Promise<ProviderCompetition>;

  /** The teams in a season. `season` is the start year, e.g. 2026. */
  getTeams(season?: number): Promise<ProviderTeam[]>;

  /** Every fixture in a season. One call; used by the daily refresh. */
  getFixtures(season?: number): Promise<ProviderFixture[]>;

  /** Fixtures for a single gameweek. Cheaper, used around deadlines. */
  getFixturesForMatchday(matchday: number, season?: number): Promise<ProviderFixture[]>;

  /** The current league table. */
  getStandings(season?: number): Promise<ProviderStandings>;

  /**
   * Finished fixtures for a gameweek. Separate from `getFixturesForMatchday`
   * because some providers expose a cheaper results-only endpoint; the default
   * implementation just filters.
   */
  getResults(matchday: number, season?: number): Promise<ProviderFixture[]>;

  /** How many HTTP requests this instance has made, for rate-limit accounting. */
  requestCount(): number;
}

/** Raised when a provider fails, so callers can record it without inspecting HTTP internals. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}
