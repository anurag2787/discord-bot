import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { version } from "../package.json";
import { DAILY_CRON } from "../src/config";
import worker from "../src/index";
import { makeEnv, mockFetch, OCTOBER } from "./helpers";

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function signedDiscordRequest(body: unknown) {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = toHex((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const text = JSON.stringify(body);
  const timestamp = "1700000000";
  const signature = toHex(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode(timestamp + text)));
  const request = new Request("https://bot.example/interactions", {
    method: "POST",
    headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp },
    body: text,
  });
  return { request, publicKey };
}

async function githubRequest(secret: string, event: string, body: unknown) {
  const text = JSON.stringify(body);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = "sha256=" + toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
  return new Request("https://bot.example/github", {
    method: "POST",
    headers: { "X-Hub-Signature-256": signature, "X-GitHub-Event": event },
    body: text,
  });
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(pending) };
}

let env = makeEnv();
beforeEach(() => {
  env = makeEnv();
});

describe("routing", () => {
  it("serves a small info page and 404s everything else", async () => {
    const { ctx } = makeCtx();
    // On any host but the public one, the root says what this is.
    const home = await worker.fetch(new Request("https://bot.internal/"), env, ctx);
    expect(home.status).toBe(200);
    expect(await home.json()).toMatchObject({ name: "codercops-discord-bot", commit: "dev" });
    expect((await worker.fetch(new Request("https://bot.example/nope"), env, ctx)).status).toBe(404);
    expect((await worker.fetch(new Request("https://bot.example/github"), env, ctx)).status).toBe(404);
  });

  it("names the deployed commit, which the release smoke test waits for", async () => {
    const { ctx } = makeCtx();
    const sha = "87d8b5095d31988ba530e76443d07a889fea70b5";
    const home = await worker.fetch(new Request("https://bot.internal/"), makeEnv({ GIT_SHA: sha }), ctx);
    expect(await home.json()).toMatchObject({ commit: sha });
  });

  it("serves the SVG favicon with the right content type and cache control", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(new Request("https://bot.example/favicon.svg"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=86400");
    const svg = await res.text();
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");});
  it("names the running version from package.json", async () => {
    const { ctx } = makeCtx();
    const home = await worker.fetch(new Request("https://bot.internal/"), env, ctx);
    expect(await home.json()).toMatchObject({ version });
  });

  it("answers a HEAD like the GET, with the same headers and no body", async () => {
    const { ctx } = makeCtx();
    const get = await worker.fetch(new Request("https://bot.internal/"), env, ctx);
    const head = await worker.fetch(new Request("https://bot.internal/", { method: "HEAD" }), env, ctx);
    expect(head.status).toBe(get.status);
    expect(head.headers.get("Content-Type")).toBe(get.headers.get("Content-Type"));
    expect(await head.text()).toBe("");
  });

  it("still 404s a HEAD for a path that isn't there", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(new Request("https://bot.example/nope", { method: "HEAD" }), env, ctx);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  });

  it("leaves the link callback on GET, so a HEAD never spends the code", async () => {
    // Linking is on, so a GET here would talk to Discord.
    const fetched = mockFetch();
    const { ctx } = makeCtx();
    const linking = makeEnv({ LINKING: "on", DISCORD_CLIENT_SECRET: "secret" });
    const res = await worker.fetch(new Request("https://bot.example/link/callback?code=abc&state=xyz", { method: "HEAD" }), linking, ctx);
    expect(res.status).toBe(404);
    expect(fetched.calls).toHaveLength(0);
  });
});

describe("public address", () => {
  it("sends the public host's root to the leaderboard", async () => {
    const { ctx } = makeCtx();
    const res = await worker.fetch(new Request("https://bot.example/"), env, ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://bot.example/leaderboard");
  });

  it("redirects page links on the workers.dev address to the public one, and nothing else", async () => {
    const fetched = mockFetch();
    const { ctx } = makeCtx();
    const page = await worker.fetch(new Request("https://bot.someone.workers.dev/leaderboard/2026-10/u/ada?x=1"), env, ctx);
    expect(page.status).toBe(301);
    expect(page.headers.get("Location")).toBe("https://bot.example/leaderboard/2026-10/u/ada?x=1");
    expect(fetched.calls).toHaveLength(0);

    // Discord and GitHub keep calling the workers.dev address directly.
    const home = await worker.fetch(new Request("https://bot.someone.workers.dev/"), env, ctx);
    expect(home.status).toBe(200);
    const hook = await worker.fetch(new Request("https://bot.someone.workers.dev/github", { method: "POST", body: "{}" }), env, ctx);
    expect(hook.status).toBe(401);
    // A local preview isn't redirected.
    const local = await worker.fetch(new Request("http://localhost:8787/leaderboard"), env, ctx);
    expect(local.status).toBe(200);
  });

  it("redirects trailing slashes to the path without them, keeping query strings", async () => {
    const { ctx } = makeCtx();
    for (const path of ["/leaderboard/", "/leaderboard/2026-10/", "/leaderboard/2026-10/u/ada/"]) {
      const res = await worker.fetch(new Request(`https://bot.example${path}`), env, ctx);
      expect(res.status).toBe(301);
      expect(res.headers.get("Location")).toBe(`https://bot.example${path.replace(/\/+$/, "")}`);
    }

    const withQuery = await worker.fetch(new Request("https://bot.example/leaderboard/2026-10/?x=1"), env, ctx);
    expect(withQuery.status).toBe(301);
    expect(withQuery.headers.get("Location")).toBe("https://bot.example/leaderboard/2026-10?x=1");

    const head = await worker.fetch(new Request("https://bot.example/leaderboard/", { method: "HEAD" }), env, ctx);
    expect(head.status).toBe(301);
    expect(head.headers.get("Location")).toBe("https://bot.example/leaderboard");

    const post = await worker.fetch(new Request("https://bot.example/leaderboard/", { method: "POST" }), env, ctx);
    expect(post.status).toBe(404);
  });
});

describe("POST /interactions", () => {
  it("answers Discord's PING when the signature is valid", async () => {
    const { request, publicKey } = await signedDiscordRequest({ type: 1 });
    const { ctx } = makeCtx();
    const res = await worker.fetch(request, makeEnv({ DISCORD_PUBLIC_KEY: publicKey }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it("rejects requests that aren't signed by Discord", async () => {
    const { request } = await signedDiscordRequest({ type: 1 });
    const other = await signedDiscordRequest({ type: 1 });
    const { ctx } = makeCtx();
    const res = await worker.fetch(request, makeEnv({ DISCORD_PUBLIC_KEY: other.publicKey }), ctx);
    expect(res.status).toBe(401);
  });

  it("defers a command, then fills in an ephemeral reply through the interaction webhook", async () => {
    const fetched = mockFetch((url) =>
      url.pathname.endsWith("/issues")
        ? [{ number: 7, title: "Starter", html_url: "https://github.com/codercops/toolbelt/issues/7", labels: [{ name: "good first issue" }] }]
        : { total_count: 0, items: [] }
    );
    const { request, publicKey } = await signedDiscordRequest({
      type: 2,
      token: "interaction-token",
      data: { name: "issues", options: [{ name: "repo", value: "toolbelt" }] },
    });
    const { ctx, settle } = makeCtx();
    const res = await worker.fetch(request, makeEnv({ DISCORD_PUBLIC_KEY: publicKey }), ctx);
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });

    await settle();
    const reply = fetched.discord()[0];
    expect(reply).toMatchObject({
      method: "PATCH",
      url: "https://discord.com/api/v10/webhooks/111/interaction-token/messages/@original",
    });
    expect(reply?.body.embeds[0].title).toBe("toolbelt: 1 open starter issue");
    // Only the chosen repo was queried.
    expect(fetched.calls.filter((c) => c.url.includes("api.github.com")).every((c) => c.url.includes("/repos/codercops/toolbelt/"))).toBe(true);
  });
});

describe("/issues label option", () => {
  async function runIssues(options: { name: string; value: string }[]) {
    const fetched = mockFetch((url) => (url.pathname.endsWith("/issues") ? [] : { total_count: 0, items: [] }));
    const { request, publicKey } = await signedDiscordRequest({ type: 2, token: "t", data: { name: "issues", options } });
    const { ctx, settle } = makeCtx();
    await worker.fetch(request, makeEnv({ DISCORD_PUBLIC_KEY: publicKey }), ctx);
    await settle();
    const asked = fetched.calls
      .filter((c) => c.url.includes("api.github.com"))
      .map((c) => new URL(c.url).searchParams.get("labels"));
    return { asked, embeds: fetched.discord()[0]?.body.embeds as { url: string }[] };
  }

  it("asks GitHub only for the chosen label and links to it", async () => {
    const { asked, embeds } = await runIssues([{ name: "label", value: "help wanted" }]);
    expect(new Set(asked)).toEqual(new Set(["help wanted"]));
    expect(decodeURIComponent(embeds[0]!.url)).toContain('label:"help wanted"');
    expect(decodeURIComponent(embeds[0]!.url)).not.toContain("good first issue");
  });

  it("works together with the repo option", async () => {
    const { asked, embeds } = await runIssues([
      { name: "repo", value: "toolbelt" },
      { name: "label", value: "good first issue" },
    ]);
    expect(asked).toEqual(["good first issue"]);
    expect(embeds).toHaveLength(1);
  });

  it("lists everything when the option is missing or isn't a starter label", async () => {
    for (const options of [[], [{ name: "label", value: "bug" }]]) {
      const { asked } = await runIssues(options);
      expect(new Set(asked)).toEqual(new Set(["good first issue", "help wanted"]));
    }
  });
});

describe("POST /github", () => {
  it("rejects a bad signature before doing anything", async () => {
    const fetched = mockFetch();
    const { ctx } = makeCtx();
    const res = await worker.fetch(await githubRequest("wrong-secret", "ping", { zen: "x" }), env, ctx);
    expect(res.status).toBe(401);
    expect(fetched.calls).toHaveLength(0);
  });

  it("accepts a signed ping", async () => {
    mockFetch();
    const { ctx } = makeCtx();
    const res = await worker.fetch(await githubRequest("test-webhook-secret", "ping", { zen: "x" }), env, ctx);
    expect(await res.json()).toEqual({ ok: true, result: "pong" });
  });

  it("returns 500 when Discord fails, so GitHub shows the delivery as failed", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const { ctx } = makeCtx();
    const body = {
      action: "published",
      repository: { name: "toolbelt", owner: { login: "codercops" } },
      release: { name: "v1", tag_name: "v1", body: "", html_url: "https://github.com/codercops/toolbelt/releases/tag/v1", draft: false, prerelease: false },
    };
    const res = await worker.fetch(await githubRequest("test-webhook-secret", "release", body), env, ctx);
    expect(res.status).toBe(500);
  });
});

describe("scheduled leaderboard", () => {
  const run = (when: string, cron = DAILY_CRON) =>
    worker.scheduled({ cron, scheduledTime: Date.parse(when), noRetry() {} } as ScheduledController, env);
  afterEach(() => vi.restoreAllMocks());

  it("posts on Mondays while a program runs and stays quiet otherwise", async () => {
    const fetched = mockFetch();
    await run("2026-09-28T04:30:00Z"); // a Monday before it starts
    await run("2026-10-13T04:30:00Z"); // a Tuesday during it
    expect(fetched.discord()).toHaveLength(0);

    await run("2026-10-12T04:30:00Z");
    expect(fetched.discord()).toHaveLength(1);
    expect(fetched.discord()[0]?.url).toBe("https://discord.com/api/v10/channels/chan-leaderboard/messages");
    const embed = fetched.discord()[0]?.body.embeds[0];
    expect(embed.title).toBe("Hacktoberfest 2026 leaderboard");
    expect(embed.url).toBe("https://bot.example/leaderboard/2026-10");
  });

  it("posts final results once, on the first run after the program ends", async () => {
    const fetched = mockFetch();
    await run("2026-10-31T04:30:00Z");
    expect(fetched.discord()).toHaveLength(0);

    await run("2026-11-01T04:30:00Z");
    expect(fetched.discord()).toHaveLength(1);
    expect(fetched.discord()[0]?.body.embeds[0].title).toBe("Hacktoberfest 2026 leaderboard: final results");

    // Not again the next day (a Monday), and no weekly post either: it's over.
    await run("2026-11-02T04:30:00Z");
    expect(fetched.discord()).toHaveLength(1);
  });

  it("doesn't announce a program that ended long before it was added", async () => {
    const fetched = mockFetch();
    await run("2026-11-20T04:30:00Z");
    await run("2027-11-01T04:30:00Z");
    expect(fetched.discord()).toHaveLength(0);
  });

  it("adds the configured note to the final results", async () => {
    env = makeEnv({ FINAL_RESULTS_NOTE: "Add it to your profile." });
    const fetched = mockFetch(() => ({
      total_count: 1,
      items: [{ html_url: "https://github.com/codercops/toolbelt/pull/1", user: { login: "ada" }, pull_request: { merged_at: "2026-10-02T00:00:00Z" } }],
    }));
    await run("2026-11-01T04:30:00Z");
    expect(fetched.discord()[0]?.body.embeds[0].description).toContain("Add it to your profile.");
  });

  it("handles several programs, each on its own", async () => {
    const november = { ...OCTOBER, id: "2026-11", title: "November sprint", start: "2026-11-01T00:00:00Z", end: "2026-11-30T23:59:59Z" };
    env = makeEnv({ PROGRAMS: [OCTOBER, november] });
    const fetched = mockFetch();
    // Monday Nov 2: October's final results were due the day before but the cron
    // missed it, and November is running.
    await run("2026-11-02T04:30:00Z");
    expect(fetched.discord().map((c) => c.body.embeds[0].title)).toEqual([
      "Hacktoberfest 2026 leaderboard: final results",
      "November sprint leaderboard",
    ]);
  });

  it("still posts the other programs when one of them fails, and logs which one", async () => {
    const november = { ...OCTOBER, id: "2026-11", title: "November sprint", start: "2026-11-01T00:00:00Z", end: "2026-11-30T23:59:59Z" };
    env = makeEnv({ PROGRAMS: [OCTOBER, november] });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetched = mockFetch((url) => {
      if (url.searchParams.get("q")?.includes("2026-10-01")) throw new Error("GitHub is down");
      return { total_count: 0, items: [] };
    });
    // Doesn't throw, so the run isn't retried with the November board already out.
    await expect(run("2026-11-02T04:30:00Z")).resolves.toBeUndefined();
    expect(fetched.discord().map((c) => c.body.embeds[0].title)).toEqual(["November sprint leaderboard"]);
    expect(error).toHaveBeenCalledWith("daily post failed", "final results 2026-10", expect.any(Error));
  });

  it("tries final results that failed to post again on the next run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let failing = true;
    const fetched = mockFetch(undefined, () => (failing ? new Response("", { status: 500 }) : undefined));
    await run("2026-11-01T04:30:00Z");
    expect(env.STATE.store.has("final:2026-10")).toBe(false);

    failing = false;
    fetched.clear();
    await run("2026-11-02T04:30:00Z");
    expect(fetched.discord().map((c) => c.body.embeds[0].title)).toEqual(["Hacktoberfest 2026 leaderboard: final results"]);
  });

  it("ignores crons it doesn't know", async () => {
    const fetched = mockFetch();
    await run("2026-10-12T04:30:00Z", "0 0 * * *");
    expect(fetched.calls).toHaveLength(0);
  });
});
