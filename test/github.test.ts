import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "../src/config";
import { countMergedPrs, GithubError, listStarterIssues, searchMergedPrs } from "../src/github";
import { makeEnv } from "./helpers";

/** Answers each GitHub call with `answer(auth, url)` and records the Authorization header it came with. */
function github(answer: (auth: string | undefined, url: URL) => Response) {
  const auths: (string | undefined)[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("Authorization") ?? undefined;
    auths.push(auth);
    return answer(auth, new URL(String(input)));
  }) as typeof fetch;
  return auths;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const found = { total_count: 4, items: [] };

const originalFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = originalFetch; });

describe("GitHub requests", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends no Authorization header without a token", async () => {
    const env = makeEnv();
    const auths = github(() => json(found));
    expect(await countMergedPrs(env, getConfig(env), "ada")).toBe(4);
    expect(auths).toEqual([undefined]);
  });

  it("sends the token when there is one", async () => {
    const env = makeEnv({ GITHUB_TOKEN: "tok" });
    const auths = github(() => json(found));
    expect(await countMergedPrs(env, getConfig(env), "ada")).toBe(4);
    expect(auths).toEqual(["Bearer tok"]);
  });

  it("asks again without the token when it has expired", async () => {
    const env = makeEnv({ GITHUB_TOKEN: "expired" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const auths = github((auth) => (auth ? json({ message: "Bad credentials" }, 401) : json(found)));
    expect(await countMergedPrs(env, getConfig(env), "ada")).toBe(4);
    expect(auths).toEqual(["Bearer expired", undefined]);
    // The log names the problem and never the token.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toBe("GitHub refused GITHUB_TOKEN (401) for /search/issues, retrying without it");
  });

  it("asks again without the token when the organization's token policy blocks it", async () => {
    const env = makeEnv({ GITHUB_TOKEN: "tok", REPOS: "chatcops", STARTER_LABELS: "good first issue" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const issue = { number: 7, title: "Fix it", html_url: "https://github.com/codercops/chatcops/issues/7", labels: ["good first issue"] };
    const auths = github((auth) =>
      auth
        ? json({ message: "The organization forbids access via a fine-grained personal access token" }, 403, { "x-ratelimit-remaining": "4995" })
        : json([issue])
    );
    const issues = await listStarterIssues(env, getConfig(env), "chatcops");
    expect(issues.map((i) => i.number)).toEqual([7]);
    expect(auths).toEqual(["Bearer tok", undefined]);
  });

  it("doesn't retry a rate limit", async () => {
    const env = makeEnv({ GITHUB_TOKEN: "tok" });
    const limits: Record<string, string>[] = [{ "x-ratelimit-remaining": "0" }, { "retry-after": "60" }];
    for (const headers of limits) {
      const auths = github(() => json({ message: "rate limit exceeded" }, 403, headers));
      const err = await countMergedPrs(env, getConfig(env), "ada").catch((e) => e);
      expect(err).toBeInstanceOf(GithubError);
      expect(err.status).toBe(403);
      expect(auths).toEqual(["Bearer tok"]);
    }
  });

  it("reports the second answer when the retry fails too", async () => {
    const env = makeEnv({ GITHUB_TOKEN: "expired" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const auths = github((auth) => (auth ? json({}, 401) : json({}, 429)));
    const err = await countMergedPrs(env, getConfig(env), "ada").catch((e) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect(err.status).toBe(429);
    expect(auths).toEqual(["Bearer expired", undefined]);
  });
});

describe("searchMergedPrs", () => {
  afterEach(() => vi.restoreAllMocks());

  const baseProgram = {
    id: "2026-10",
    title: "Hacktoberfest 2026",
    repos: [] as string[],
    label: "hacktoberfest-accepted",
    start: new Date("2026-10-01T00:00:00Z"),
    end: new Date("2026-10-31T23:59:59Z"),
    minPrs: 5,
    topN: 5,
    reward: "T-shirt",
    note: "",
  };

  function makePage(items: object[], total = items.length) {
    return { total_count: total, items };
  }

  function prItem(login: string, mergedAt: string, url: string) {
    return { html_url: url, user: { login }, pull_request: { merged_at: mergedAt } };
  }

  it("stops after a page that has fewer than 100 items", async () => {
    const env = makeEnv();
    const cfg = getConfig(env);
    const program = { ...baseProgram, repos: cfg.repos };
    let pageCount = 0;
    github(() => {
      pageCount++;
      return json(makePage([prItem("ada", "2026-10-02T10:00:00Z", "https://github.com/codercops/chatcops/pull/1")]));
    });
    await searchMergedPrs(env, cfg, program);
    expect(pageCount).toBe(1);
  });

  it("requests page 2 after exactly 100 items on page 1", async () => {
    const env = makeEnv();
    const cfg = getConfig(env);
    const program = { ...baseProgram, repos: cfg.repos };
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      prItem(`user${i}`, "2026-10-05T00:00:00Z", `https://github.com/codercops/chatcops/pull/${i + 1}`)
    );
    const pages = [fullPage, [prItem("last", "2026-10-06T00:00:00Z", "https://github.com/codercops/chatcops/pull/101")]];
    const pagesRequested: number[] = [];
    github((_, url) => {
      const page = Number(url.searchParams.get("page"));
      pagesRequested.push(page);
      return json(makePage(pages[page - 1] ?? [], 101));
    });
    const prs = await searchMergedPrs(env, cfg, program);
    expect(pagesRequested).toEqual([1, 2]);
    expect(prs).toHaveLength(101);
  });

  it("never fetches more than 10 pages", async () => {
    const env = makeEnv();
    const cfg = getConfig(env);
    const program = { ...baseProgram, repos: cfg.repos };
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      prItem(`u${i}`, "2026-10-10T00:00:00Z", `https://github.com/codercops/chatcops/pull/${i}`)
    );
    let requestCount = 0;
    github(() => {
      requestCount++;
      return json(makePage(fullPage, 1000));
    });
    const prs = await searchMergedPrs(env, cfg, program);
    expect(requestCount).toBe(10);
    expect(prs).toHaveLength(1000);
  });

  it("skips items where user is null", async () => {
    const env = makeEnv();
    const cfg = getConfig(env);
    const program = { ...baseProgram, repos: cfg.repos };
    const items = [
      { html_url: "https://github.com/codercops/chatcops/pull/1", user: null, pull_request: { merged_at: "2026-10-02T10:00:00Z" } },
      prItem("ada", "2026-10-03T10:00:00Z", "https://github.com/codercops/chatcops/pull/2"),
    ];
    github(() => json(makePage(items)));
    const prs = await searchMergedPrs(env, cfg, program);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ login: "ada" });
  });

  it("skips items where pull_request.merged_at is null", async () => {
    const env = makeEnv();
    const cfg = getConfig(env);
    const program = { ...baseProgram, repos: cfg.repos };
    const items = [
      { html_url: "https://github.com/codercops/chatcops/pull/1", user: { login: "ghost" }, pull_request: { merged_at: null } },
      prItem("bob", "2026-10-04T10:00:00Z", "https://github.com/codercops/chatcops/pull/2"),
    ];
    github(() => json(makePage(items)));
    const prs = await searchMergedPrs(env, cfg, program);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ login: "bob" });
  });

  it("builds the query with is:pr is:merged, the label, the merged window and one repo: per program repo", async () => {
    const env = makeEnv();
    const cfg = getConfig(env);
    const program = { ...baseProgram, repos: cfg.repos };
    let capturedQ = "";
    github((_, url) => {
      capturedQ = url.searchParams.get("q") ?? "";
      return json(makePage([]));
    });
    await searchMergedPrs(env, cfg, program);
    expect(capturedQ).toContain("is:pr");
    expect(capturedQ).toContain("is:merged");
    expect(capturedQ).toContain('label:"hacktoberfest-accepted"');
    expect(capturedQ).toContain("merged:2026-10-01T00:00:00Z..2026-10-31T23:59:59Z");
    for (const repo of cfg.repos) {
      expect(capturedQ).toContain(`repo:codercops/${repo}`);
    }
  });

  it("sends sort=created, order=asc and per_page=100", async () => {
    const env = makeEnv();
    const cfg = getConfig(env);
    const program = { ...baseProgram, repos: cfg.repos };
    let capturedUrl!: URL;
    github((_, url) => {
      capturedUrl = url;
      return json(makePage([]));
    });
    await searchMergedPrs(env, cfg, program);
    expect(capturedUrl.searchParams.get("sort")).toBe("created");
    expect(capturedUrl.searchParams.get("order")).toBe("asc");
    expect(capturedUrl.searchParams.get("per_page")).toBe("100");
  });

  it("uses the program's own repos instead of the global list", async () => {
    const env = makeEnv();
    const cfg = getConfig(env);
    const program = { ...baseProgram, repos: ["special-repo", "another-repo"] };
    let capturedQ = "";
    github((_, url) => {
      capturedQ = url.searchParams.get("q") ?? "";
      return json(makePage([]));
    });
    await searchMergedPrs(env, cfg, program);
    expect(capturedQ).toContain("repo:codercops/special-repo");
    expect(capturedQ).toContain("repo:codercops/another-repo");
    for (const repo of cfg.repos) {
      expect(capturedQ).not.toContain(`repo:codercops/${repo}`);
    }
  });

  it("returns login, mergedAt and url for each item", async () => {
    const env = makeEnv();
    const cfg = getConfig(env);
    const program = { ...baseProgram, repos: cfg.repos };
    const items = [
      prItem("ada", "2026-10-02T10:00:00Z", "https://github.com/codercops/chatcops/pull/1"),
      prItem("bob", "2026-10-03T11:00:00Z", "https://github.com/codercops/chatcops/pull/2"),
    ];
    github(() => json(makePage(items)));
    const prs = await searchMergedPrs(env, cfg, program);
    expect(prs[0]).toMatchObject({ login: "ada", mergedAt: "2026-10-02T10:00:00Z", url: "https://github.com/codercops/chatcops/pull/1" });
    expect(prs[1]).toMatchObject({ login: "bob", mergedAt: "2026-10-03T11:00:00Z", url: "https://github.com/codercops/chatcops/pull/2" });
  });

  it("rejects with GithubError on an error response", async () => {
    const env = makeEnv();
    const cfg = getConfig(env);
    const program = { ...baseProgram, repos: cfg.repos };
    github(() => json({ message: "Service Unavailable" }, 503));
    const err = await searchMergedPrs(env, cfg, program).catch((e) => e);
    expect(err).toBeInstanceOf(GithubError);
    expect(err.status).toBe(503);
  });
});
