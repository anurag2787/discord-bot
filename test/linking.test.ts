import { beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/commands";
import { getConfig } from "../src/config";
import worker from "../src/index";
import { getLink, getLinkByGithub, linkedMembers, removeLink, saveLink } from "../src/links";
import { leaderboardMessage, mergedPrMessage } from "../src/messages";
import { authorizeUrl, readState, signState } from "../src/oauth";
import { handleGithubEvent } from "../src/webhook";
import { makeEnv, mockFetch, type RecordedCall } from "./helpers";

const SECRET = "client-secret";
const now = new Date("2026-10-12T10:00:00Z");
const linkingEnv = () => makeEnv({ LINKING: "on", DISCORD_CLIENT_SECRET: SECRET });
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const ada = { discordId: "42", githubLogin: "Ada", githubId: "9001", linkedAt: now.toISOString() };

/** Answers the Discord calls behind /link, /me and the role changes. */
function discordApi(opts: {
  connections?: unknown[];
  userId?: string;
  memberRoles?: string[] | null;
  tokenStatus?: number;
} = {}) {
  return (call: RecordedCall): Response | undefined => {
    const path = new URL(call.url).pathname;
    if (path.endsWith("/oauth2/token")) return jsonResponse({ access_token: "tok" }, opts.tokenStatus ?? 200);
    if (path.endsWith("/oauth2/token/revoke")) return jsonResponse({});
    if (path.endsWith("/users/@me")) return jsonResponse({ id: opts.userId ?? "42", username: "ada_l", global_name: "Ada L" });
    if (path.endsWith("/users/@me/connections")) {
      return jsonResponse(opts.connections ?? [{ type: "github", id: "9001", name: "Ada", verified: true }]);
    }
    if (/\/members\/\d+$/.test(path)) {
      return opts.memberRoles === null ? jsonResponse({ message: "Unknown Member" }, 404) : jsonResponse({ roles: opts.memberRoles ?? [], joined_at: "2026-01-01T00:00:00Z" });
    }
    if (path.includes("/roles/")) return new Response(null, { status: 204 });
    return undefined;
  };
}

const search = (count: number) => () => ({
  total_count: count,
  items: Array.from({ length: count }, (_, i) => ({
    html_url: `https://github.com/codercops/toolbelt/pull/${i + 1}`,
    user: { login: "Ada" },
    pull_request: { merged_at: `2026-10-0${i + 1}T00:00:00Z` },
  })),
});

describe("link state", () => {
  it("round-trips the Discord id it was signed for", async () => {
    const state = await signState(SECRET, "42", now);
    expect(await readState(SECRET, state, now)).toBe("42");
    expect(await readState(SECRET, state, new Date(now.getTime() + 14 * 60 * 1000))).toBe("42");
  });

  it("stops working after 15 minutes", async () => {
    const state = await signState(SECRET, "42", now);
    expect(await readState(SECRET, state, new Date(now.getTime() + 16 * 60 * 1000))).toBeNull();
  });

  it("rejects anything that was changed, signed with another secret, or isn't a state at all", async () => {
    const state = await signState(SECRET, "42", now);
    const [user, expires, signature] = state.split(".");
    expect(await readState(SECRET, `43.${expires}.${signature}`, now)).toBeNull();
    expect(await readState(SECRET, `${user}.${Number(expires) + 60_000}.${signature}`, now)).toBeNull();
    expect(await readState(SECRET, `${user}.${expires}.${"0".repeat(64)}`, now)).toBeNull();
    expect(await readState("another-secret", state, now)).toBeNull();
    expect(await readState(SECRET, `${state}.extra`, now)).toBeNull();
    expect(await readState(SECRET, "", now)).toBeNull();
    expect(await readState(SECRET, "not.a.state", now)).toBeNull();
  });

  it("uses a separate redirect address when one is configured", () => {
    const env = makeEnv({ LINKING: "on", DISCORD_CLIENT_SECRET: SECRET, OAUTH_REDIRECT_URL: "https://bot.someone.workers.dev/link/callback" });
    const url = new URL(authorizeUrl(env, getConfig(env), "s"));
    expect(url.searchParams.get("redirect_uri")).toBe("https://bot.someone.workers.dev/link/callback");
  });

  it("builds an authorize URL that asks for two scopes and comes back to /link/callback", () => {
    const env = linkingEnv();
    const url = new URL(authorizeUrl(env, getConfig(env), "the-state"));
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "111",
      response_type: "code",
      redirect_uri: "https://bot.example/link/callback",
      scope: "identify connections",
      state: "the-state",
    });
  });
});

describe("stored links", () => {
  it("finds a link from either side, whatever the casing of the login", async () => {
    const env = makeEnv();
    await saveLink(env, ada);
    expect(await getLink(env, "42")).toEqual(ada);
    expect((await getLinkByGithub(env, "ADA"))?.discordId).toBe("42");
    expect(await linkedMembers(env, ["ada", "bob"])).toEqual(new Map([["ada", "42"]]));
  });

  it("keeps one GitHub account per member and one member per GitHub account", async () => {
    const env = makeEnv();
    await saveLink(env, ada);
    // Ada switches to another GitHub account: the old login is free again.
    await saveLink(env, { ...ada, githubLogin: "ada-work", githubId: "9002" });
    expect(await getLinkByGithub(env, "ada")).toBeNull();
    expect((await getLink(env, "42"))?.githubLogin).toBe("ada-work");
    // Someone else proves they own ada-work now: Ada's link goes.
    await saveLink(env, { ...ada, discordId: "77", githubLogin: "ada-work", githubId: "9002" });
    expect(await getLink(env, "42")).toBeNull();
    expect((await getLinkByGithub(env, "ada-work"))?.discordId).toBe("77");
  });

  it("removes both sides and reports what was there", async () => {
    const env = makeEnv();
    await saveLink(env, ada);
    expect(await removeLink(env, "42")).toEqual(ada);
    expect(env.STATE.store.size).toBe(0);
    expect(await removeLink(env, "42")).toBeNull();
  });
});

describe("GET /link/callback", () => {
  let env = linkingEnv();
  beforeEach(() => {
    env = linkingEnv();
  });
  const callback = async (params: Record<string, string>, e = env) =>
    worker.fetch(new Request(`https://bot.example/link/callback?${new URLSearchParams(params)}`), e, ctx);
  const validState = () => signState(SECRET, "42", new Date());

  it("links the verified GitHub account, hands out earned roles and revokes the token", async () => {
    const fetched = mockFetch(search(2), discordApi());
    const res = await callback({ code: "the-code", state: await validState() });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    const html = await res.text();
    expect(html).toContain("<h1>GitHub linked</h1>");
    expect(html).toContain("Ada L on Discord is now linked to github.com/Ada.");
    expect(html).toContain("you now have the Contributor role");

    expect(await getLink(env, "42")).toMatchObject({ githubLogin: "Ada", githubId: "9001" });

    const token = fetched.calls.find((c) => c.url.endsWith("/oauth2/token"));
    expect(token?.body).toEqual({ grant_type: "authorization_code", code: "the-code", redirect_uri: "https://bot.example/link/callback" });
    expect(token?.auth).toBe(`Basic ${btoa(`111:${SECRET}`)}`);
    expect(fetched.calls.find((c) => c.url.endsWith("/users/@me"))?.auth).toBe("Bearer tok");
    expect(fetched.calls.find((c) => c.url.endsWith("/oauth2/token/revoke"))?.body).toEqual({ token: "tok", token_type_hint: "access_token" });

    // Two merged PRs earn the first tier, not the second.
    const roleCalls = fetched.calls.filter((c) => c.url.includes("/roles/"));
    expect(roleCalls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([
      ["PUT", "/api/v10/guilds/guild-1/members/42/roles/role-contributor"],
    ]);
  });

  it("tells people without a verified GitHub connection how to add one, and stores nothing", async () => {
    for (const connections of [[], [{ type: "github", id: "1", name: "Ada", verified: false }], [{ type: "twitch", id: "1", name: "Ada", verified: true }], [{ type: "github", id: "1", name: "not a login!", verified: true }]]) {
      const fetched = mockFetch(search(0), discordApi({ connections }));
      const res = await callback({ code: "c", state: await validState() });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("<h1>No GitHub account found</h1>");
      expect(await getLink(env, "42")).toBeNull();
      // The token is revoked on this path too.
      expect(fetched.calls.some((c) => c.url.endsWith("/oauth2/token/revoke"))).toBe(true);
    }
  });

  it("refuses a link that was made for another Discord account", async () => {
    mockFetch(search(0), discordApi({ userId: "43" }));
    const res = await callback({ code: "c", state: await validState() });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("That link was for someone else");
    expect(env.STATE.store.size).toBe(0);
  });

  it("doesn't talk to Discord at all for an expired or forged state", async () => {
    const fetched = mockFetch(search(0), discordApi());
    const old = await signState(SECRET, "42", new Date(Date.now() - 60 * 60 * 1000));
    for (const state of [old, "42.9999999999999.deadbeef", ""]) {
      const res = await callback({ code: "c", state });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("This link has expired");
    }
    expect((await callback({ state: await validState() })).status).toBe(400);
    expect(fetched.calls).toHaveLength(0);
  });

  it("handles a cancelled request, a rejected code and linking being off", async () => {
    const fetched = mockFetch(search(0), discordApi({ tokenStatus: 400 }));
    const cancelled = await callback({ error: "access_denied", state: await validState() });
    expect(cancelled.headers.get("Content-Security-Policy")).toContain("img-src 'self'");
    const cancelledHtml = await cancelled.text();
    expect(cancelledHtml).toContain("Nothing was linked");
    expect(cancelledHtml).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
    expect(fetched.calls).toHaveLength(0);

    const rejected = await callback({ code: "used-twice", state: await validState() });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("Something went wrong");

    for (const off of [makeEnv({ DISCORD_CLIENT_SECRET: SECRET }), makeEnv({ LINKING: "on" })]) {
      const res = await callback({ code: "c", state: await validState() }, off);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Linking isn&#39;t switched on");
    }
  });

  it("links a maintainer without giving them the contributor roles", async () => {
    const fetched = mockFetch(search(40), discordApi({ connections: [{ type: "github", id: "1", name: "Anurag629", verified: true }] }));
    const res = await callback({ code: "c", state: await validState() });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("is now linked to github.com/Anurag629.");
    expect(html).not.toContain("Contributor role");
    expect((await getLink(env, "42"))?.githubLogin).toBe("Anurag629");
    expect(fetched.calls.some((c) => c.url.includes("/roles/") || c.url.includes("/members/"))).toBe(false);
  });

  it("keeps the link when the roles can't be handed out", async () => {
    mockFetch(() => {
      throw new Error("GitHub is down");
    }, discordApi());
    const res = await callback({ code: "c", state: await validState() });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("your first one earns you the Contributor role");
    expect((await getLink(env, "42"))?.githubLogin).toBe("Ada");
  });

  it("tells someone who already has the role about their merged PRs instead of promising the role", async () => {
    const fetched = mockFetch(search(3), discordApi({ memberRoles: ["role-contributor"] }));
    const res = await callback({ code: "c", state: await validState() });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("You already have 3 merged pull requests with us.");
    expect(html).not.toContain("your first one earns you the Contributor role");
    expect(fetched.calls.some((c) => c.url.includes("/roles/"))).toBe(false);

    mockFetch(search(1), discordApi({ memberRoles: ["role-contributor"] }));
    const single = await (await callback({ code: "c", state: await validState() })).text();
    expect(single).toContain("You already have 1 merged pull request with us.");
  });

  it("tells someone with no merged PRs that their first one earns the role", async () => {
    mockFetch(search(0), discordApi());
    const res = await callback({ code: "c", state: await validState() });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("your first one earns you the Contributor role");
  });

  it("escapes names that come from Discord", async () => {
    mockFetch(search(0), (call) =>
      call.url.endsWith("/users/@me") ? jsonResponse({ id: "42", username: "x", global_name: "<img src=x>" }) : discordApi()(call)
    );
    const html = await (await callback({ code: "c", state: await validState() })).text();
    expect(html).toContain("&lt;img src=x&gt; on Discord");
    expect(html).not.toContain("<img");
  });
});

describe("/link, /unlink and /me", () => {
  const user = { id: "42", name: "Ada" };
  let env = linkingEnv();
  let cfg = getConfig(env);
  beforeEach(() => {
    env = linkingEnv();
    cfg = getConfig(env);
  });
  const run = (name: string, who: typeof user | null = user) => runCommand({ name }, who, env, cfg, now);

  it("/link answers with a button that opens Discord's consent screen for that member", async () => {
    mockFetch();
    const reply = await run("link");
    expect(reply.content).toContain("Link your GitHub account to your Discord account.");
    const button = reply.components?.[0]?.components[0];
    expect(button).toMatchObject({ type: 2, style: 5, label: "Link my GitHub" });
    const state = new URL(button!.url!).searchParams.get("state")!;
    expect(await readState(SECRET, state, now)).toBe("42");
    expect(button!.url!.length).toBeLessThan(512);
  });

  it("/link says which account is linked already, and stays off until it's configured", async () => {
    mockFetch();
    await saveLink(env, ada);
    expect((await run("link")).content).toContain("You're linked to **Ada** right now. Linking again replaces that.");

    env = makeEnv({ DISCORD_CLIENT_SECRET: SECRET });
    const off = await run("link");
    expect(off.content).toBe("Linking isn't switched on yet. Check back soon.");
    expect(off.components).toBeUndefined();
  });

  it("only works inside the server", async () => {
    mockFetch();
    for (const name of ["link", "unlink", "me"]) {
      expect((await run(name, null)).content).toBe("Run this inside the server, not in a DM.");
    }
  });

  it("/unlink deletes the link and takes the roles back", async () => {
    await saveLink(env, ada);
    const fetched = mockFetch(search(0), discordApi({ memberRoles: ["role-contributor", "some-other-role"] }));
    const reply = await run("unlink");
    expect(reply.content).toContain("Unlinked from **Ada**.");
    expect(env.STATE.store.size).toBe(0);
    expect(fetched.calls.filter((c) => c.method === "DELETE").map((c) => new URL(c.url).pathname)).toEqual([
      "/api/v10/guilds/guild-1/members/42/roles/role-contributor",
    ]);
    expect((await run("unlink")).content).toContain("nothing to remove");
  });

  it("/unlink still unlinks when the member has left or Discord refuses the role change", async () => {
    await saveLink(env, ada);
    mockFetch(search(0), discordApi({ memberRoles: null }));
    expect((await run("unlink")).content).toContain("Unlinked from **Ada**.");

    await saveLink(env, ada);
    mockFetch(search(0), (call) => (call.url.includes("/members/") ? jsonResponse({}, 403) : undefined));
    expect((await run("unlink")).content).toContain("Unlinked from **Ada**.");
    expect(await getLink(env, "42")).toBeNull();
  });

  it("/me asks unlinked members to link first", async () => {
    mockFetch();
    expect((await run("me")).content).toBe("You haven't linked a GitHub account yet. Run `/link` first.");
  });

  it("/me shows the member's count, their place in the current program and any role they were owed", async () => {
    await saveLink(env, ada);
    const fetched = mockFetch(search(4), discordApi({ memberRoles: [] }));
    const reply = await run("me");
    expect(reply.content).toBe(
      [
        "You're linked to **Ada** on GitHub.",
        "Merged PRs in our repos: **4**.",
        "You now have the **Contributor** role.",
        "**Hacktoberfest 2026**: 4 merged PRs, 1st of 1. 1 more to qualify for a CODERCOPS T-shirt and stickers.",
        "Your card to share: <https://bot.example/leaderboard/2026-10/u/Ada>",
      ].join("\n")
    );
    const lifetime = fetched.calls.find((c) => c.url.includes("api.github.com") && decodeURIComponent(c.url).includes("author:Ada"));
    expect(decodeURIComponent(lifetime!.url).replace(/\+/g, " ")).toContain("is:pr is:merged author:Ada repo:codercops/chatcops repo:codercops/ogcops repo:codercops/toolbelt");
  });

  it("/me tells a maintainer why they have no standing and no roles", async () => {
    await saveLink(env, { ...ada, githubLogin: "anurag629" });
    const fetched = mockFetch(search(40), discordApi({ memberRoles: [] }));
    const reply = await run("me");
    expect(reply.content).toBe(
      [
        "You're linked to **anurag629** on GitHub.",
        "Merged PRs in our repos: **40**.",
        "You're a maintainer, so you're not on the leaderboard and the contributor roles aren't for you.",
      ].join("\n")
    );
    expect(fetched.calls.some((c) => c.url.includes("/roles/"))).toBe(false);
  });

  it("/me covers people with nothing counted, people in the top N, and a program that's over", async () => {
    await saveLink(env, { ...ada, githubLogin: "newcomer" });
    mockFetch(search(4), discordApi({ memberRoles: ["role-contributor"] }));
    const none = await run("me");
    expect(none.content).toContain("**Hacktoberfest 2026**: no counted PRs yet. Run `/issues` to find one.\n<https://bot.example/leaderboard/2026-10>");
    expect(none.content).not.toContain("Your card");
    expect(none.content).not.toContain("You now have");

    await saveLink(env, ada);
    mockFetch(search(6), discordApi({ memberRoles: ["role-contributor", "role-top"] }));
    await env.STATE.delete("leaderboard:v2:2026-10");
    expect((await run("me")).content).toContain("6 merged PRs, 1st of 1. You're in the top 5 right now.");

    const later = await runCommand({ name: "me" }, user, env, cfg, new Date("2026-11-05T00:00:00Z"));
    expect(later.content).toContain("6 merged PRs, 1st of 1. You're one of the winners.");
  });
});

describe("the Link GitHub button", () => {
  const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  async function press(customId: string) {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const publicKey = toHex((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    const body = JSON.stringify({
      type: 3,
      token: "interaction-token",
      data: { custom_id: customId, component_type: 2 },
      member: { user: { id: "42", username: "ada_l" } },
    });
    const signature = toHex(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, new TextEncoder().encode("1700000000" + body)));
    const pending: Promise<unknown>[] = [];
    const res = await worker.fetch(
      new Request("https://bot.example/interactions", { method: "POST", headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": "1700000000" }, body }),
      makeEnv({ LINKING: "on", DISCORD_CLIENT_SECRET: SECRET, DISCORD_PUBLIC_KEY: publicKey }),
      { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext
    );
    await Promise.all(pending);
    return res;
  }

  it("does what /link does, privately", async () => {
    const fetched = mockFetch();
    const res = await press("link");
    expect(await res.json()).toEqual({ type: 5, data: { flags: 64 } });
    const reply = fetched.discord()[0];
    expect(reply?.url).toBe("https://discord.com/api/v10/webhooks/111/interaction-token/messages/@original");
    expect(reply?.body.components[0].components[0].label).toBe("Link my GitHub");
  });

  it("ignores buttons it doesn't know", async () => {
    const fetched = mockFetch();
    expect((await press("something-else")).status).toBe(400);
    expect(fetched.calls).toHaveLength(0);
  });
});

describe("linked members in posts", () => {
  const prEvent = {
    action: "closed",
    repository: { name: "toolbelt", owner: { login: "codercops" } },
    pull_request: {
      number: 9,
      title: "Fix a thing",
      html_url: "https://github.com/codercops/toolbelt/pull/9",
      merged: true,
      merged_at: "2026-10-05T12:00:00Z",
      user: { login: "Ada", type: "User" },
      labels: [{ name: "hacktoberfest-accepted" }],
    },
  };

  it("shows who merged a PR and announces the role it earned", async () => {
    const env = makeEnv();
    await saveLink(env, ada);
    // GitHub's search doesn't know the new PR yet, so this is their first.
    const fetched = mockFetch(search(0), discordApi({ memberRoles: [] }));
    expect(await handleGithubEvent("pull_request", prEvent, env, getConfig(env))).toBe("posted merged pull request");
    const post = fetched.calls.find((c) => c.url.endsWith("/channels/chan-merged/messages"));
    expect(post?.body.embeds[0].description).toBe(
      "**Ada** (<@42>) got a PR merged in **toolbelt**: [Fix a thing](https://github.com/codercops/toolbelt/pull/9)\nThat's their 1st merged PR on the Hacktoberfest 2026 leaderboard.\nThat earns them the **Contributor** role."
    );
    // The mention shows their name without notifying them.
    expect(post?.body.allowed_mentions).toEqual({ parse: [] });
    expect(fetched.calls.some((c) => c.method === "PUT" && c.url.endsWith("/members/42/roles/role-contributor"))).toBe(true);
  });

  it("doesn't count the merged PR twice once GitHub's search has it", async () => {
    const env = makeEnv();
    await saveLink(env, ada);
    // Five in the index, the new one among them (pull/5 here is #9's stand-in).
    const github = () => ({
      total_count: 5,
      items: [1, 2, 3, 4].map((n) => ({ html_url: `https://github.com/codercops/toolbelt/pull/${n}`, user: { login: "Ada" }, pull_request: { merged_at: "2026-10-01T00:00:00Z" } })).concat([
        { html_url: "https://github.com/codercops/toolbelt/pull/9", user: { login: "Ada" }, pull_request: { merged_at: "2026-10-05T12:00:00Z" } },
      ]),
    });
    const fetched = mockFetch(github, discordApi({ memberRoles: ["role-contributor"] }));
    await handleGithubEvent("pull_request", prEvent, env, getConfig(env));
    const post = fetched.calls.find((c) => c.url.endsWith("/channels/chan-merged/messages"));
    expect(post?.body.embeds[0].description).toContain("That's their 5th merged PR");
    expect(post?.body.embeds[0].description).toContain("That earns them the **Top Contributor** role.");
  });

  it("still posts the shoutout when the role can't be given", async () => {
    const env = makeEnv();
    await saveLink(env, ada);
    const fetched = mockFetch(search(0), (call) => (call.url.includes("/members/") ? jsonResponse({}, 403) : undefined));
    expect(await handleGithubEvent("pull_request", prEvent, env, getConfig(env))).toBe("posted merged pull request");
    const post = fetched.calls.find((c) => c.url.endsWith("/channels/chan-merged/messages"));
    expect(post?.body.embeds[0].description).toContain("**Ada** (<@42>) got a PR merged");
    expect(post?.body.embeds[0].description).not.toContain("earns them");
  });

  it("leaves people who haven't linked exactly as before", () => {
    const text = mergedPrMessage({ repo: "toolbelt", number: 9, title: "Fix", url: "https://x/9", login: "bob", newRoles: [] }).embeds?.[0]?.description;
    expect(text).toBe("**bob** got a PR merged in **toolbelt**: [Fix](https://x/9)");
    expect(mergedPrMessage({ repo: "t", number: 1, title: "x", url: "https://x/1", login: "ada", discordId: "42", newRoles: ["Contributor", "Top Contributor"] }).embeds?.[0]?.description).toContain(
      "That earns them the **Contributor** and **Top Contributor** role."
    );
  });

  it("puts Discord names next to linked people on the leaderboard", () => {
    const program = getConfig(makeEnv()).programs[0]!;
    const row = (login: string, count: number, winner = false) => ({ login, count, reachedAt: "2026-10-05T00:00:00Z", qualifies: winner, winner });
    const board = { generatedAt: now.toISOString(), rows: [row("Ada", 6, true), row("bob", 2)] };
    const embed = leaderboardMessage(board, program, { final: true, members: new Map([["ada", "42"]]) }).embeds?.[0];
    expect(embed?.description).toContain("1. **Ada** (<@42>) · 6 merged PRs · winner\n2. **bob** · 2 merged PRs");
    expect(embed?.description).toContain("Congratulations to **Ada** (<@42>).");
  });
});
