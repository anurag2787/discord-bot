import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config";
import {
  escapeMarkdown,
  leaderboardMessage,
  mergedPrMessage,
  ordinal,
  releaseMessage,
  starterIssueMessage,
  starterIssuesReply,
  truncate,
  truncateReleaseNotes,
} from "../src/messages";
import { makeEnv, OCTOBER } from "./helpers";

const cfg = getConfig(makeEnv());

describe("helpers", () => {
  it("truncates with an ellipsis and never exceeds the limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
    const out = truncate("a".repeat(50), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("escapes markdown so titles render literally", () => {
    expect(escapeMarkdown("fix *bold* [x](y) `code`")).toBe("fix \\*bold\\* \\[x\\]\\(y\\) \\`code\\`");
  });

  it("builds ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th",
    ]);
  });
});

describe("releaseMessage", () => {
  const release = { name: "v0.6.2", tag_name: "v0.6.2", body: "Fixes", html_url: "https://github.com/codercops/toolbelt/releases/tag/v0.6.2" };

  it("prefixes the repo name when the release name doesn't have it", () => {
    expect(releaseMessage("toolbelt", release).embeds?.[0]).toMatchObject({ title: "toolbelt v0.6.2", url: release.html_url, description: "Fixes" });
  });

  it("keeps names that already mention the repo, like scoped packages", () => {
    const msg = releaseMessage("chatcops", { ...release, name: "@chatcops/widget@0.4.1" });
    expect(msg.embeds?.[0]?.title).toBe("@chatcops/widget@0.4.1");
  });

  it("falls back to the tag and a placeholder body, and trims long notes", () => {
    const msg = releaseMessage("ogcops", { ...release, name: null, body: null });
    expect(msg.embeds?.[0]).toMatchObject({ title: "ogcops v0.6.2", description: "No release notes." });
    const long = releaseMessage("ogcops", { ...release, body: "x".repeat(6000) });
    expect(long.embeds?.[0]?.description?.length).toBeLessThanOrEqual(4096);
  });
});

describe("truncateReleaseNotes", () => {
  const url = "https://github.com/codercops/toolbelt/releases/tag/v1.0.0";

  it("returns short notes completely unchanged", () => {
    const notes = "Fixes a bug.\nSee the changelog.";
    expect(truncateReleaseNotes(notes, url)).toBe(notes);
  });

  it("cuts long notes at the last line break and appends a link to the release", () => {
    const line = "a".repeat(100);
    const notes = Array.from({ length: 35 }, () => line).join("\n");
    const result = truncateReleaseNotes(notes, url);
    const [body] = result.split("\n[Read the full notes]");
    expect(body?.trim().endsWith(line)).toBe(true);
    expect(result).toContain(`[Read the full notes](${url})`);
    expect(result.length).toBeLessThanOrEqual(4096);
  });

  it("closes an open code fence before the link", () => {
    const notes = "```ts\n" + "const x = 1;\n".repeat(300) + "trailing\n".repeat(10);
    const result = truncateReleaseNotes(notes, url);
    expect(result).toMatch(/^```$/m);
    expect(result).toContain(`[Read the full notes](${url})`);
    expect(result.length).toBeLessThanOrEqual(4096);
  });

  it("stays within Discord's 4096-character embed description limit", () => {
    const result = truncateReleaseNotes("word\n".repeat(1000), url);
    expect(result.length).toBeLessThanOrEqual(4096);
  });
});

describe("starterIssueMessage", () => {
  const issue = { repo: "toolbelt", number: 124, title: "Quote YAML strings", url: "https://github.com/codercops/toolbelt/issues/124", labels: ["bug", "good first issue"] };

  it("describes each state", () => {
    expect(starterIssueMessage(issue, { kind: "open" }).embeds?.[0]?.description).toContain("Comment on the issue to claim it");
    expect(starterIssueMessage(issue, { kind: "claimed", by: "ada_l" }).embeds?.[0]?.description).toContain("Claimed by ada\\_l.");
    expect(starterIssueMessage(issue, { kind: "done" }).embeds?.[0]?.description).toContain("Done.");
  });

  it("puts the repo and number in the title and links to the issue", () => {
    expect(starterIssueMessage(issue, { kind: "open" }).embeds?.[0]).toMatchObject({
      title: "toolbelt #124: Quote YAML strings",
      url: issue.url,
    });
  });
});

describe("mergedPrMessage", () => {
  const pr = { repo: "chatcops", number: 103, title: "fix(widget): hide the *open* launcher", url: "https://github.com/codercops/chatcops/pull/103", login: "Pratham2511" };

  it("names the author and links the PR with an escaped title", () => {
    const text = mergedPrMessage(pr).embeds?.[0]?.description ?? "";
    expect(text).toContain("**Pratham2511** got a PR merged in **chatcops**");
    expect(text).toContain("[fix\\(widget\\): hide the \\*open\\* launcher](https://github.com/codercops/chatcops/pull/103)");
    expect(text).not.toContain("That's their");
  });

  it("adds the running count when it's known", () => {
    const text = mergedPrMessage(pr, { count: 3, label: "Hacktoberfest 2026" }).embeds?.[0]?.description ?? "";
    expect(text).toContain("That's their 3rd merged PR on the Hacktoberfest 2026 leaderboard.");
    expect(text).not.toContain("qualify");
  });

  it("says so when this merge takes them to the minimum, and where the reward comes from", () => {
    const qualified = { topN: 5, reward: "a CODERCOPS T-shirt and stickers", note: "This swag comes from CODERCOPS, separate from Hacktoberfest." };
    const text = mergedPrMessage(pr, { count: 5, label: "Hacktoberfest 2026", qualified }).embeds?.[0]?.description ?? "";
    expect(text.split("\n")).toEqual([
      expect.stringContaining("got a PR merged in **chatcops**"),
      "That's their 5th merged PR on the Hacktoberfest 2026 leaderboard.",
      "With 5 they now qualify for a CODERCOPS T-shirt and stickers, which goes to the top 5 when the program ends. This swag comes from CODERCOPS, separate from Hacktoberfest.",
    ]);
    const plain = mergedPrMessage(pr, { count: 5, label: "Hacktoberfest 2026", qualified: { ...qualified, note: undefined } }).embeds?.[0]?.description ?? "";
    expect(plain.endsWith("which goes to the top 5 when the program ends.")).toBe(true);
  });
});

describe("leaderboardMessage", () => {
  const row = (login: string, count: number, qualifies = false, winner = false) => ({ login, count, reachedAt: "2026-10-05T00:00:00Z", qualifies, winner });
  const board = { generatedAt: "2026-10-12T04:30:00.000Z", rows: [row("ada", 6, true, true), row("bob", 2), row("cy", 1)] };

  const program = cfg.programs[0]!;

  it("lists people in order and marks who is in the running", () => {
    const embed = leaderboardMessage(board, program).embeds?.[0];
    expect(embed?.title).toBe("Hacktoberfest 2026 leaderboard");
    expect(embed?.description).toBe(
      "1. **ada** · 6 merged PRs · in the top 5\n2. **bob** · 2 merged PRs · 3 more to qualify\n3. **cy** · 1 merged PR · 4 more to qualify"
    );
    expect(embed?.footer?.text).toContain("at least 5 merged PRs labeled hacktoberfest-accepted");
    expect(embed?.footer?.text).toContain("a CODERCOPS T-shirt and stickers");
    // The footer says who the reward comes from, so nobody takes it for Hacktoberfest swag.
    expect(embed?.footer?.text?.endsWith("This swag comes from CODERCOPS, separate from Hacktoberfest.")).toBe(true);
  });

  it("leaves the footer note out when none is configured", () => {
    const plain = getConfig(makeEnv({ PROGRAMS: [{ ...OCTOBER, note: undefined }] })).programs[0]!;
    expect(leaderboardMessage(board, plain).embeds?.[0]?.footer?.text?.endsWith("Ties go to whoever got there first.")).toBe(true);
  });

  it("links to the program's page when it has one", () => {
    const url = "https://bot.example/leaderboard/2026-10";
    const embed = leaderboardMessage(board, program, { url }).embeds?.[0];
    expect(embed?.url).toBe(url);
    expect(embed?.description?.endsWith(`\n\n[Full leaderboard and rules](${url})`)).toBe(true);
    expect(leaderboardMessage(board, program).embeds?.[0]?.description).not.toContain("Full leaderboard");
  });

  it("announces winners in the final results", () => {
    const embed = leaderboardMessage(board, program, { final: true }).embeds?.[0];
    expect(embed?.title).toBe("Hacktoberfest 2026 leaderboard: final results");
    expect(embed?.description).toContain("1. **ada** · 6 merged PRs · winner");
    expect(embed?.description).toContain(
      "Congratulations to **ada**. We'll DM you on Discord with a private form for the shipping details, so we can send you a CODERCOPS T-shirt and stickers."
    );
    // Nothing about /link unless linking is on.
    expect(embed?.description).not.toContain("/link");
    // The countdown stops with the program.
    expect(embed?.description).toContain("2. **bob** · 2 merged PRs\n");
    expect(embed?.description).not.toContain("more to qualify");
  });

  it("asks winners who haven't linked to run /link, since the form goes out by DM", () => {
    const winners = { ...board, rows: [row("ada", 6, true, true), row("Bob", 5, true, true), row("cy", 5, true, true)] };
    const text = (members: Map<string, string>) =>
      leaderboardMessage(winners, program, { final: true, linking: true, members }).embeds?.[0]?.description;
    expect(text(new Map([["ada", "42"]]))).toContain(
      "send you a CODERCOPS T-shirt and stickers. **Bob** and **cy**: run `/link` in this server so we know which Discord account is yours."
    );
    // Everyone linked: nothing to ask.
    expect(text(new Map([["ada", "42"], ["bob", "43"], ["cy", "44"]]))).not.toContain("/link");
    // Not in the weekly post.
    expect(leaderboardMessage(winners, program, { linking: true, members: new Map() }).embeds?.[0]?.description).not.toContain("/link");
  });

  it("adds the final note to the final results only", () => {
    const finalNote = "Add it to your profile.";
    expect(leaderboardMessage(board, program, { final: true, finalNote }).embeds?.[0]?.description?.endsWith("\n\nAdd it to your profile.")).toBe(true);
    expect(leaderboardMessage(board, program, { finalNote }).embeds?.[0]?.description).not.toContain("Add it to your profile.");
  });

  it("handles a final result with no qualifiers and an empty board", () => {
    const none = leaderboardMessage({ ...board, rows: [row("bob", 2)] }, program, { final: true }).embeds?.[0];
    expect(none?.description).toContain("Nobody reached 5 merged PRs");
    const empty = leaderboardMessage({ ...board, rows: [] }, program).embeds?.[0];
    expect(empty?.description).toContain("No merged PRs counted yet");
  });
});

describe("starterIssuesReply", () => {
  const issue = (n: number) => ({ repo: "toolbelt", number: n, title: `Issue ${n}`, url: `https://github.com/codercops/toolbelt/issues/${n}`, labels: ["good first issue"] });

  it("shows one embed per repo with a link to the full filtered list", () => {
    const reply = starterIssuesReply(cfg, [{ repo: "toolbelt", issues: [issue(2), issue(1)] }, { repo: "ogcops", issues: [] }]);
    expect(reply.embeds).toHaveLength(2);
    expect(reply.embeds?.[0]?.title).toBe("toolbelt: 2 open starter issues");
    expect(reply.embeds?.[0]?.description).toContain("[#2](https://github.com/codercops/toolbelt/issues/2) Issue 2");
    expect(decodeURIComponent(reply.embeds?.[0]?.url ?? "")).toContain("-label:blocked");
    expect(decodeURIComponent(reply.embeds?.[0]?.url ?? "")).toContain("no:assignee");
    expect(decodeURIComponent(reply.embeds?.[0]?.url ?? "")).toContain('label:"good first issue","help wanted"');
    expect(reply.embeds?.[1]?.description).toContain("Nothing unassigned right now");
  });

  it("links to the chosen label only, in the title and in the \"more\" line", () => {
    const issues = Array.from({ length: 30 }, (_, i) => issue(30 - i));
    const embed = starterIssuesReply(cfg, [{ repo: "toolbelt", issues }], ["help wanted"]).embeds?.[0];
    const links = [embed?.url, embed?.description?.match(/\[and \d+ more\]\(([^)]+)\)/)?.[1]].map((u) => decodeURIComponent(u ?? ""));
    for (const link of links) {
      expect(link).toContain("-label:blocked");
      expect(link).toContain("no:assignee");
      expect(link).toContain('label:"help wanted"');
      expect(link).not.toContain("good first issue");
    }
  });

  it("caps long lists and says how many more there are", () => {
    const issues = Array.from({ length: 30 }, (_, i) => issue(30 - i));
    const embed = starterIssuesReply(cfg, [{ repo: "toolbelt", issues }]).embeds?.[0];
    expect(embed?.title).toBe("toolbelt: 30 open starter issues");
    expect(embed?.description).toContain("and 18 more");
  });
});
