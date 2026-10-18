import { afterEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "../src/config";
import { countMergedPrs, GithubError, listStarterIssues } from "../src/github";
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
