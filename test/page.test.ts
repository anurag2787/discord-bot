import { beforeEach, describe, expect, it } from "vitest";
import { getConfig } from "../src/config";
import worker from "../src/index";
import { contributorPage, dateRange, escapeHtml, leaderboardJson, leaderboardPage, noticePage, standing, statusLine } from "../src/page";
import { currentProgram } from "../src/programs";
import { makeEnv, mockFetch, OCTOBER } from "./helpers";

const program = getConfig(makeEnv()).programs[0]!;
const during = new Date("2026-10-12T04:30:00Z");
const after = new Date("2026-11-03T00:00:00Z");
const row = (login: string, count: number, qualifies = false, winner = false) => ({ login, count, reachedAt: "2026-10-05T00:00:00Z", qualifies, winner });
const board = { generatedAt: "2026-10-12T04:30:00.000Z", rows: [row("ada", 6, true, true), row("bob", 5, true, false), row("cy", 2), row("dee", 4)] };
const links = {
  issues: "https://github.com/search?q=x&type=issues",
  discord: "https://discord.gg/example",
  self: "https://bot.example/leaderboard/2026-10",
  image: "https://bot.example/leaderboard/2026-10.png?v=abc",
  others: [] as { title: string; path: string }[],
};

describe("standing", () => {
  it("says where each person is for the reward", () => {
    expect(standing(board.rows[0]!, program)).toEqual({ text: "In the top 5", kind: "top" });
    expect(standing(board.rows[1]!, program)).toEqual({ text: "Qualifies", kind: "qualifies" });
    expect(standing(board.rows[2]!, program)).toEqual({ text: "3 more to qualify", kind: "progress" });
    expect(standing(board.rows[3]!, program)).toEqual({ text: "1 more to qualify", kind: "progress" });
  });

  it("names winners once the program is over and drops the countdown", () => {
    expect(standing(board.rows[0]!, program, "ended")).toEqual({ text: "Winner", kind: "top" });
    expect(standing(board.rows[1]!, program, "ended")).toEqual({ text: "Qualified", kind: "qualifies" });
    expect(standing(board.rows[2]!, program, "ended")).toBeNull();
  });
});

describe("dates and status", () => {
  it("writes the window with its year", () => {
    expect(dateRange(program.start, program.end)).toBe("Oct 1 to Oct 31, 2026 (UTC)");
    expect(dateRange(new Date("2026-12-15T00:00:00Z"), new Date("2027-01-15T00:00:00Z"))).toBe("Dec 15, 2026 to Jan 15, 2027 (UTC)");
  });

  it("says whether the program is still on", () => {
    expect(statusLine(program, new Date("2026-09-01T00:00:00Z"))).toEqual({ text: "Starts Oct 1, 2026", status: "upcoming" });
    expect(statusLine(program, during)).toEqual({ text: "Running now. 20 days left.", status: "running" });
    expect(statusLine(program, new Date("2026-10-31T12:00:00Z"))).toEqual({ text: "Running now. 1 day left.", status: "running" });
    expect(statusLine(program, after)).toEqual({ text: "Ended. These are the final results.", status: "ended" });
  });
});

describe("currentProgram", () => {
  const november = { ...OCTOBER, id: "2026-11", title: "November sprint", start: "2026-11-01T00:00:00Z", end: "2026-11-30T23:59:59Z" };
  const cfg = getConfig(makeEnv({ PROGRAMS: [november, OCTOBER] }));
  const at = (iso: string) => currentProgram(cfg, new Date(iso))?.id;

  it("prefers the running program, then the last one that ended, then the next one", () => {
    expect(cfg.programs.map((p) => p.id)).toEqual(["2026-10", "2026-11"]);
    expect(at("2026-09-01T00:00:00Z")).toBe("2026-10");
    expect(at("2026-10-15T00:00:00Z")).toBe("2026-10");
    expect(at("2026-11-15T00:00:00Z")).toBe("2026-11");
    expect(at("2027-03-01T00:00:00Z")).toBe("2026-11");
  });

  it("skips programs of a kind the bot can't count yet", () => {
    const mixed = getConfig(makeEnv({ PROGRAMS: [OCTOBER, { ...november, kind: "volunteers" }] }));
    expect(mixed.programs.map((p) => p.id)).toEqual(["2026-10"]);
    expect(currentProgram(getConfig(makeEnv({ PROGRAMS: [] })), during)).toBeUndefined();
  });
});

describe("leaderboardPage", () => {
  const html = leaderboardPage(board, program, links, during);

  it("lists people in order with their counts and links to their profiles", () => {
    expect(html).toContain("<h1>Hacktoberfest 2026 leaderboard</h1>");
    expect(html.indexOf(">ada<")).toBeLessThan(html.indexOf(">bob<"));
    expect(html).toContain('<a href="https://github.com/ada">ada</a>');
    expect(html).toContain("6 merged PRs");
    expect(html).toContain('<span class="chip top">In the top 5</span>');
    expect(html).toContain('<span class="chip progress">3 more to qualify</span>');
  });

  it("states the rules, the window and who the reward comes from", () => {
    expect(html).toContain("Merged pull requests in chatcops, ogcops and toolbelt, Oct 1 to Oct 31, 2026 (UTC).");
    expect(html).toContain('<p class="status running">Running now. 20 days left.</p>');
    expect(html).toContain("at least 5 merged PRs get a CODERCOPS T-shirt and stickers");
    expect(html).toContain("Only PRs for issues that were assigned to you count.");
    expect(html).toContain("This swag comes from CODERCOPS, separate from Hacktoberfest.");
  });

  it("says how winners are contacted, only when members can link their account", () => {
    expect(html).not.toContain("/link");
    const linking = leaderboardPage(board, program, links, during, { linking: true });
    expect(linking).toContain(
      '<p>We contact the winners by Discord DM. <a href="https://discord.gg/example">Join the server</a> and run <code>/link</code> there, so we know which Discord account is yours.</p>'
    );
    // Still true after the end, until the winners have heard from us.
    expect(leaderboardPage(board, program, links, after, { linking: true })).toContain("We contact the winners by Discord DM.");
  });

  it("links to issues, Discord and the platform, with escaped URLs", () => {
    expect(html).toContain('href="https://github.com/search?q=x&amp;type=issues"');
    expect(html).toContain('href="https://discord.gg/example"');
    expect(html).toContain('href="https://www.codercops.com"');
  });

  it("escapes anything that isn't ours", () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe("&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
    const evil = leaderboardPage({ ...board, rows: [row('"><script>alert(1)</script>', 1)] }, program, links, during);
    expect(evil).not.toContain("<script>");
    expect(evil).toContain("&lt;script&gt;");
  });

  it("has an empty state", () => {
    expect(leaderboardPage({ ...board, rows: [] }, program, links, during)).toContain("No merged pull requests counted yet");
  });

  it("shows final results once the program is over", () => {
    const ended = leaderboardPage(board, program, links, after);
    expect(ended).toContain('<p class="status ended">Ended. These are the final results.</p>');
    expect(ended).toContain('<span class="chip top">Winner</span>');
    expect(ended).not.toContain("more to qualify");
  });

  it("links to the other programs and to its own JSON", () => {
    expect(html).not.toContain("Other programs");
    expect(html).toContain('<a href="/leaderboard/2026-10.json">JSON</a>');
    expect(html).toContain('<link rel="canonical" href="https://bot.example/leaderboard/2026-10">');
    const many = leaderboardPage(board, program, { ...links, others: [{ title: "November sprint", path: "/leaderboard/2026-11" }] }, during);
    expect(many).toContain('<li><a href="/leaderboard/2026-11">November sprint</a></li>');
  });

  it("links to the favicon in the head", () => {
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
  });

  it("has the same share preview tags as a contributor page, pointing at its own image", () => {
    expect(html).toContain('<meta property="og:image" content="https://bot.example/leaderboard/2026-10.png?v=abc">');
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain('<meta name="twitter:image" content="https://bot.example/leaderboard/2026-10.png?v=abc">');
    expect(html).not.toContain("og.codercops.com");
    expect(html).toContain(
      '<meta property="og:image:alt" content="Share image: Hacktoberfest 2026 leaderboard. 1. ada, 6 merged PRs; 2. bob, 5 merged PRs; 3. cy, 2 merged PRs; 4. dee, 4 merged PRs.">'
    );
    const empty = leaderboardPage({ ...board, rows: [] }, program, links, during);
    expect(empty).toContain('content="Share image: Hacktoberfest 2026 leaderboard. No merged pull requests counted yet.">');
    const evil = leaderboardPage({ ...board, rows: [row('"><script>', 1)] }, program, links, during);
    expect(evil).toContain("1. &quot;&gt;&lt;script&gt;, 1 merged PR.");
  });
});

describe("noticePage", () => {
  it("links to the favicon in the head", () => {
    const html = noticePage("Done", ["Everything is linked."], true);
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
  });
});

describe("contributorPage", () => {
  it("links to the favicon in the head", () => {
    const html = contributorPage(
      { program, row: board.rows[0]!, rank: 1, of: 4, generatedAt: "2026-10-12T04:30:00.000Z" },
      {
        self: "https://bot.example/leaderboard/2026-10/u/ada",
        image: "https://bot.example/leaderboard/2026-10/u/ada.png",
        board: "/leaderboard/2026-10",
        prs: "https://github.com/search?q=x",
        issues: "https://github.com/search?q=x",
        discord: "https://discord.gg/example",
      },
      during
    );
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
  });
});

describe("leaderboardJson", () => {
  it("returns ranks, counts and the rules", () => {
    const json = leaderboardJson(board, program, during);
    expect(json).toMatchObject({ id: "2026-10", title: "Hacktoberfest 2026 leaderboard", status: "running" });
    expect(json.rows[0]).toEqual({ rank: 1, login: "ada", mergedPrs: 6, qualifies: true, inTop: true });
    expect(json.rules).toMatchObject({ minPrs: 5, topN: 5, label: "hacktoberfest-accepted", start: "2026-10-01T00:00:00.000Z" });
  });
});

describe("GET /leaderboard", () => {
  let env = makeEnv();
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const search = () => ({
    total_count: 2,
    items: [
      { html_url: "https://github.com/codercops/toolbelt/pull/1", user: { login: "ada" }, pull_request: { merged_at: "2026-10-02T00:00:00Z" } },
      { html_url: "https://github.com/codercops/toolbelt/pull/2", user: { login: "anurag629" }, pull_request: { merged_at: "2026-10-03T00:00:00Z" } },
    ],
  });
  beforeEach(() => {
    env = makeEnv();
  });

  it("serves the page with a strict content security policy and caches the ranking", async () => {
    const fetched = mockFetch(search);
    const res = await worker.fetch(new Request("https://bot.example/leaderboard"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("Content-Security-Policy")).toContain("img-src 'self'");
    const html = await res.text();
    expect(html).toContain(">ada<");
    expect(html).not.toContain("anurag629");
    expect(html).toContain('content="https://bot.example/leaderboard/2026-10"');
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');

    await worker.fetch(new Request("https://bot.example/leaderboard"), env, ctx);
    expect(fetched.calls.filter((c) => c.url.includes("api.github.com"))).toHaveLength(1);
  });

  it("serves JSON with CORS", async () => {
    mockFetch(search);
    const res = await worker.fetch(new Request("https://bot.example/leaderboard.json"), env, ctx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(((await res.json()) as { rows: unknown[] }).rows).toHaveLength(1);
  });

  it("gives every program a permanent address and 404s unknown ones", async () => {
    mockFetch(search);
    const page = await worker.fetch(new Request("https://bot.example/leaderboard/2026-10"), env, ctx);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>Hacktoberfest 2026 leaderboard</h1>");
    const json = await worker.fetch(new Request("https://bot.example/leaderboard/2026-10.json"), env, ctx);
    expect(((await json.json()) as { id: string }).id).toBe("2026-10");

    expect((await worker.fetch(new Request("https://bot.example/leaderboard/2025-10"), env, ctx)).status).toBe(404);
    expect((await worker.fetch(new Request("https://bot.example/leaderboard", { method: "POST" }), env, ctx)).status).toBe(404);
    const none = await worker.fetch(new Request("https://bot.example/leaderboard"), makeEnv({ PROGRAMS: [] }), ctx);
    expect(none.status).toBe(404);
  });

  it("keeps a separate cache per program", async () => {
    const november = { ...OCTOBER, id: "2026-11", title: "November sprint", start: "2026-11-01T00:00:00Z", end: "2026-11-30T23:59:59Z" };
    env = makeEnv({ PROGRAMS: [OCTOBER, november] });
    const fetched = mockFetch(search);
    const oct = await worker.fetch(new Request("https://bot.example/leaderboard/2026-10"), env, ctx);
    const nov = await worker.fetch(new Request("https://bot.example/leaderboard/2026-11"), env, ctx);
    expect(await oct.text()).toContain('<li><a href="/leaderboard/2026-11">November sprint</a></li>');
    expect(await nov.text()).toContain("<h1>November sprint leaderboard</h1>");
    const searches = fetched.calls.filter((c) => c.url.includes("api.github.com"));
    expect(searches).toHaveLength(2);
    expect(decodeURIComponent(searches[1]!.url)).toContain("merged:2026-11-01T00:00:00Z..2026-11-30T23:59:59Z");
  });

  it("answers a HEAD like the GET, with the same headers and no body", async () => {
    mockFetch(search);
    const get = await worker.fetch(new Request("https://bot.example/leaderboard"), env, ctx);
    const head = await worker.fetch(new Request("https://bot.example/leaderboard", { method: "HEAD" }), env, ctx);
    expect(head.status).toBe(get.status);
    expect(head.headers.get("Content-Type")).toBe(get.headers.get("Content-Type"));
    expect(head.headers.get("Content-Security-Policy")).toBe(get.headers.get("Content-Security-Policy"));
    expect(await head.text()).toBe("");
  });

  it("answers 503 when GitHub is rate limiting", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    const res = await worker.fetch(new Request("https://bot.example/leaderboard"), env, ctx);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
  });
});
