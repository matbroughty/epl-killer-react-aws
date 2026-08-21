import {
  ProviderError,
  type FootballDataProvider,
  type ProviderCompetition,
  type ProviderFixture,
  type ProviderStandings,
  type ProviderTeam,
} from './FootballDataProvider.js';
import {
  mapCompetition,
  mapFixtures,
  mapStandings,
  mapTeams,
} from './footballDataOrgMapping.js';

/**
 * football-data.org v4 client.
 *
 * Verified against the current documentation: base `https://api.football-data.org/v4`,
 * `X-Auth-Token` header, free tier 10 requests/minute, Premier League code `PL`.
 *
 * This runs only inside Lambda. The token is a secret and must never be sent to
 * the browser, which is why nothing in `src/` imports this file.
 */

export const FOOTBALL_DATA_BASE_URL = 'https://api.football-data.org/v4';

/** Premier League. The only competition this application needs. */
export const PREMIER_LEAGUE_CODE = 'PL';

/** 20 teams playing each other twice. */
export const MATCHDAYS_IN_SEASON = 38;

/**
 * Reject a matchday the provider cannot possibly answer for.
 *
 * Exported so callers can validate before spending a request, and enforced
 * inside the client so nothing can bypass it.
 */
export function assertValidMatchday(matchday: number): void {
  if (!Number.isInteger(matchday) || matchday < 1 || matchday > MATCHDAYS_IN_SEASON) {
    throw new ProviderError(
      `Matchday must be a whole number between 1 and ${MATCHDAYS_IN_SEASON}, got ${matchday}.`,
    );
  }
}

/** Free tier allowance, used to space requests out. */
export const FREE_TIER_REQUESTS_PER_MINUTE = 10;

export interface FootballDataOrgOptions {
  token: string;
  competitionCode?: string;
  baseUrl?: string;
  /** Injected for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests so retry backoff does not really sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Requests are spaced by at least this long. Defaults to the free-tier pace. */
  minRequestIntervalMs?: number;
  maxRetries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FootballDataOrgProvider implements FootballDataProvider {
  readonly name = 'football-data.org';

  private readonly token: string;
  private readonly competitionCode: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly minRequestIntervalMs: number;
  private readonly maxRetries: number;

  private requests = 0;
  private lastRequestAt = 0;

  constructor(options: FootballDataOrgOptions) {
    if (!options.token) {
      throw new Error('football-data.org token missing. Set the FOOTBALL_DATA_TOKEN secret.');
    }
    this.token = options.token;
    this.competitionCode = options.competitionCode ?? PREMIER_LEAGUE_CODE;
    this.baseUrl = options.baseUrl ?? FOOTBALL_DATA_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.minRequestIntervalMs =
      options.minRequestIntervalMs ?? Math.ceil(60_000 / FREE_TIER_REQUESTS_PER_MINUTE);
    this.maxRetries = options.maxRetries ?? 2;
  }

  requestCount(): number {
    return this.requests;
  }

  async getCompetition(): Promise<ProviderCompetition> {
    return mapCompetition(await this.get(`/competitions/${this.competitionCode}`));
  }

  async getTeams(season?: number): Promise<ProviderTeam[]> {
    return mapTeams(
      await this.get(`/competitions/${this.competitionCode}/teams`, this.seasonQuery(season)),
    );
  }

  async getFixtures(season?: number): Promise<ProviderFixture[]> {
    return mapFixtures(
      await this.get(`/competitions/${this.competitionCode}/matches`, this.seasonQuery(season)),
    );
  }

  async getFixturesForMatchday(matchday: number, season?: number): Promise<ProviderFixture[]> {
    // Fail here rather than sending `?matchday=0` and taking a 400 back. An
    // absent argument coerced to zero is the obvious way to reach this, and a
    // provider error is far harder to trace than a thrown one.
    assertValidMatchday(matchday);
    return mapFixtures(
      await this.get(`/competitions/${this.competitionCode}/matches`, {
        ...this.seasonQuery(season),
        matchday: String(matchday),
      }),
    );
  }

  async getStandings(season?: number): Promise<ProviderStandings> {
    return mapStandings(
      await this.get(`/competitions/${this.competitionCode}/standings`, this.seasonQuery(season)),
    );
  }

  /**
   * Results for a gameweek. football-data.org has no results-only endpoint, so
   * this is the matchday fixtures filtered to those that have actually produced
   * a result.
   */
  async getResults(matchday: number, season?: number): Promise<ProviderFixture[]> {
    const fixtures = await this.getFixturesForMatchday(matchday, season);
    return fixtures.filter(
      (fixture) => fixture.status === 'FINISHED' || fixture.status === 'AWARDED',
    );
  }

  private seasonQuery(season?: number): Record<string, string> {
    return season === undefined ? {} : { season: String(season) };
  }

  private async get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    let attempt = 0;
    for (;;) {
      await this.throttle();

      let response: Response;
      try {
        this.requests += 1;
        this.lastRequestAt = Date.now();
        response = await this.fetchImpl(url, {
          headers: { 'X-Auth-Token': this.token, Accept: 'application/json' },
        });
      } catch (cause) {
        // Network-level failure. Worth one retry; a sync failure is recorded
        // rather than surfaced to players either way.
        if (attempt < this.maxRetries) {
          attempt += 1;
          await this.sleepImpl(backoffMs(attempt));
          continue;
        }
        throw new ProviderError(
          `football-data.org request failed: ${(cause as Error)?.message ?? 'unknown error'}`,
        );
      }

      if (response.ok) {
        return (await response.json()) as unknown;
      }

      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));

      // 429 means we have outrun the free tier. Wait as instructed and retry.
      if (response.status === 429 && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleepImpl((retryAfter ?? 60) * 1000);
        continue;
      }

      // 5xx is usually transient.
      if (response.status >= 500 && attempt < this.maxRetries) {
        attempt += 1;
        await this.sleepImpl(backoffMs(attempt));
        continue;
      }

      throw new ProviderError(
        `football-data.org returned ${response.status} for ${path}`,
        response.status,
        retryAfter,
      );
    }
  }

  /** Keep requests at or below the free-tier pace without needing a scheduler. */
  private async throttle(): Promise<void> {
    if (this.lastRequestAt === 0) return;
    const elapsed = Date.now() - this.lastRequestAt;
    const wait = this.minRequestIntervalMs - elapsed;
    if (wait > 0) await this.sleepImpl(wait);
  }
}

function backoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** attempt);
}

export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  // The header may be an HTTP date instead of a delay.
  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}
