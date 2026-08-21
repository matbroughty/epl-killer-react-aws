import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from './FootballDataProvider.js';
import { FootballDataOrgProvider, parseRetryAfter } from './footballDataOrg.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

function provider(fetchImpl: typeof fetch, options: Record<string, unknown> = {}) {
  return new FootballDataOrgProvider({
    token: 'test-token',
    fetchImpl,
    // No real waiting in tests.
    sleepImpl: async () => {},
    minRequestIntervalMs: 0,
    ...options,
  });
}

describe('FootballDataOrgProvider', () => {
  it('refuses to be constructed without a token', () => {
    expect(() => new FootballDataOrgProvider({ token: '' })).toThrow(/FOOTBALL_DATA_TOKEN/);
  });

  it('sends the token in the X-Auth-Token header and never in the URL', () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ code: 'PL' }));
    return provider(fetchImpl as unknown as typeof fetch)
      .getCompetition()
      .then(() => {
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
        expect((init.headers as Record<string, string>)['X-Auth-Token']).toBe('test-token');
        // A token in a query string would end up in access logs.
        expect(url.toString()).not.toContain('test-token');
      });
  });

  it('calls the Premier League endpoints', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ matches: [] }));
    const client = provider(fetchImpl as unknown as typeof fetch);

    await client.getTeams(2026);
    await client.getFixturesForMatchday(5, 2026);
    await client.getStandings(2026);

    const urls = (fetchImpl.mock.calls as unknown as [URL][]).map(([url]) => url.toString());
    expect(urls[0]).toBe('https://api.football-data.org/v4/competitions/PL/teams?season=2026');
    expect(urls[1]).toBe(
      'https://api.football-data.org/v4/competitions/PL/matches?season=2026&matchday=5',
    );
    expect(urls[2]).toBe('https://api.football-data.org/v4/competitions/PL/standings?season=2026');
  });

  it('omits the season parameter when not given', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ teams: [] }));
    await provider(fetchImpl as unknown as typeof fetch).getTeams();
    const [url] = fetchImpl.mock.calls[0] as unknown as [URL];
    expect(url.toString()).toBe('https://api.football-data.org/v4/competitions/PL/teams');
  });

  it('counts requests so rate-limit usage can be recorded', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ teams: [] }));
    const client = provider(fetchImpl as unknown as typeof fetch);
    expect(client.requestCount()).toBe(0);
    await client.getTeams(2026);
    await client.getTeams(2026);
    expect(client.requestCount()).toBe(2);
  });

  it('retries a 429 after the interval the server asks for, then succeeds', async () => {
    const sleepImpl = vi.fn(async (_ms: number) => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '7' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ teams: [{ id: 57, name: 'Arsenal FC', tla: 'ARS' }] }));

    const teams = await provider(fetchImpl as unknown as typeof fetch, { sleepImpl }).getTeams(2026);

    expect(teams).toHaveLength(1);
    expect(sleepImpl).toHaveBeenCalledWith(7_000);
  });

  it('gives up on a 429 once retries are exhausted and reports it as rate limited', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('rate limited', { status: 429, headers: { 'Retry-After': '30' } }),
    );

    const error = await provider(fetchImpl as unknown as typeof fetch, { maxRetries: 1 })
      .getStandings(2026)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).isRateLimited).toBe(true);
    expect((error as ProviderError).retryAfterSeconds).toBe(30);
  });

  it('retries a 5xx and then fails cleanly', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 503 }));
    const error = await provider(fetchImpl as unknown as typeof fetch, { maxRetries: 2 })
      .getCompetition()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 403, which means the token or plan is wrong', async () => {
    const fetchImpl = vi.fn(async () => new Response('forbidden', { status: 403 }));
    await expect(
      provider(fetchImpl as unknown as typeof fetch).getStandings(2026),
    ).rejects.toThrow(/403/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('wraps a network failure in a ProviderError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const error = await provider(fetchImpl as unknown as typeof fetch, { maxRetries: 0 })
      .getCompetition()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain('ENOTFOUND');
  });

  it('spaces requests to stay inside the free-tier allowance', async () => {
    const sleepImpl = vi.fn(async (_ms: number) => {});
    const fetchImpl = vi.fn(async () => jsonResponse({ teams: [] }));
    // 10 requests/minute means at least 6 seconds between calls.
    const client = provider(fetchImpl as unknown as typeof fetch, {
      sleepImpl,
      minRequestIntervalMs: 6_000,
    });

    await client.getTeams(2026);
    await client.getTeams(2026);

    // First call is not delayed; the second waits.
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl.mock.calls[0]![0]).toBeGreaterThan(0);
  });

  // Regression: an absent GraphQL argument arrives as `null`, and `Number(null)`
  // is 0. That reached the provider as `?matchday=0` and came back as a 400 that
  // only showed up in the sync log. Refuse it before spending a request.
  it.each([0, -1, 39, 1.5, Number.NaN])('refuses matchday %s without calling out', async (bad) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ matches: [] }));
    await expect(
      provider(fetchImpl as unknown as typeof fetch).getFixturesForMatchday(bad, 2026),
    ).rejects.toThrow(/between 1 and 38/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([1, 20, 38])('accepts matchday %s', async (good) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ matches: [] }));
    await provider(fetchImpl as unknown as typeof fetch).getFixturesForMatchday(good, 2026);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('getResults returns only fixtures that produced a result', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        matches: [
          { id: 1, utcDate: '2026-08-22T14:00:00Z', matchday: 5, status: 'FINISHED', homeTeam: { id: 1 }, awayTeam: { id: 2 }, score: { winner: 'HOME_TEAM', fullTime: { home: 1, away: 0 } } },
          { id: 2, utcDate: '2026-08-22T14:00:00Z', matchday: 5, status: 'POSTPONED', homeTeam: { id: 3 }, awayTeam: { id: 4 }, score: { winner: null, fullTime: {} } },
          { id: 3, utcDate: '2026-08-22T14:00:00Z', matchday: 5, status: 'AWARDED', homeTeam: { id: 5 }, awayTeam: { id: 6 }, score: { winner: 'AWAY_TEAM', fullTime: { home: 0, away: 3 } } },
        ],
      }),
    );

    const results = await provider(fetchImpl as unknown as typeof fetch).getResults(5, 2026);
    expect(results.map((fixture) => fixture.providerMatchId)).toEqual([1, 3]);
  });
});

describe('parseRetryAfter', () => {
  it('reads a delay in seconds', () => {
    expect(parseRetryAfter('42')).toBe(42);
  });

  it('reads an HTTP date as a delay', () => {
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    expect(parseRetryAfter(inTenSeconds)).toBeGreaterThanOrEqual(9);
  });

  it('returns null when absent or unparseable', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});
