// Pure functions that turn GitHub data into Discord messages. No I/O here, so
// everything in this file is easy to unit test.
import type { CheckinRecord, CheckinResult } from "./checkin";
import type { Config, Program, Roadmap } from "./config";
import type { ActionRow, Button, Embed, MessagePayload } from "./discord";
import type { StarterIssue } from "./github";
import type { Leaderboard, LeaderboardRow } from "./leaderboard";
import type { ProgramStatus } from "./programs";

const COLOR = { open: 0x2ea043, claimed: 0x8b949e, done: 0x8957e5, unavailable: 0xf85149, release: 0x1f6feb, merged: 0x8957e5, gold: 0xd4a72c };

// Discord's limits: embed title 256, embed description 4096.
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function truncateReleaseNotes(notes: string, releaseUrl: string, limit = 3500): string {
  if (notes.length <= limit) return notes;

  const suffix = `\n[Read the full notes](${releaseUrl})`;
  const budget = Math.min(limit, 4096 - suffix.length);

  const cut = notes.lastIndexOf("\n", budget);
  const trimmed = (cut > 0 ? notes.slice(0, cut) : notes.slice(0, budget)).trimEnd();

  const fenceCount = (trimmed.match(/^```/gm) ?? []).length;
  const closeIfNeeded = fenceCount % 2 !== 0 ? "\n```" : "";

  return `${trimmed}${closeIfNeeded}${suffix}`;
}

// Markdown characters in a title would otherwise change how the line renders.
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>\[\]()])/g, "\\$1");
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export function releaseMessage(repo: string, release: { name: string | null; tag_name: string; body: string | null; html_url: string }): MessagePayload {
  const name = release.name?.trim() || release.tag_name;
  const title = name.toLowerCase().includes(repo.toLowerCase()) ? name : `${repo} ${name}`;
  return {
    embeds: [
      {
        title: truncate(title, 256),
        url: release.html_url,
        description: truncateReleaseNotes(release.body?.trim() || "No release notes.", release.html_url),
        color: COLOR.release,
      },
    ],
  };
}

export type StarterState = { kind: "open" } | { kind: "claimed"; by: string } | { kind: "done" } | { kind: "unavailable" };

export function starterIssueMessage(issue: StarterIssue, state: StarterState): MessagePayload {
  const labels = issue.labels.join(", ");
  const status =
    state.kind === "open"
      ? "Open. Comment on the issue to claim it (one issue at a time)."
      : state.kind === "claimed"
        ? `Claimed by ${escapeMarkdown(state.by)}.`
        : state.kind === "done"
          ? "Done."
          : "No longer available.";
  return {
    embeds: [
      {
        title: truncate(`${issue.repo} #${issue.number}: ${issue.title}`, 256),
        url: issue.url,
        description: labels ? `${labels}\n${status}` : status,
        color: COLOR[state.kind],
      },
    ],
  };
}

/** A GitHub login in bold, followed by the Discord member behind it when they've linked their account. */
const person = (login: string, discordId?: string) =>
  `**${escapeMarkdown(login)}**${discordId ? ` (<@${discordId}>)` : ""}`;

const joinNames = (names: string[]) => names.join(", ").replace(/, ([^,]*)$/, " and $1");

export function mergedPrMessage(
  pr: {
    repo: string;
    number: number;
    title: string;
    url: string;
    login: string;
    /** The author's Discord id, when they've linked their GitHub account. */
    discordId?: string;
    /** Roles this merge earned them. */
    newRoles?: string[];
  },
  /** How many counted PRs the author has in the leaderboard window, when known. */
  countInWindow?: {
    count: number;
    label: string;
    /** Set when this merge is the one that takes them to the program's minimum. */
    qualified?: { topN: number; reward: string; note?: string };
  }
): MessagePayload {
  let description = `${person(pr.login, pr.discordId)} got a PR merged in **${pr.repo}**: [${escapeMarkdown(truncate(pr.title, 200))}](${pr.url})`;
  if (countInWindow && countInWindow.count > 0) {
    description += `\nThat's their ${ordinal(countInWindow.count)} merged PR on the ${countInWindow.label} leaderboard.`;
    const q = countInWindow.qualified;
    if (q) {
      // Reaching the minimum isn't a win yet: only the top N get the reward.
      description += `\nWith ${countInWindow.count} they now qualify for ${q.reward}, which goes to the top ${q.topN} when the program ends.${q.note ? ` ${q.note}` : ""}`;
    }
  }
  if (pr.newRoles?.length) {
    description += `\nThat earns them the ${joinNames(pr.newRoles.map((r) => `**${r}**`))} role.`;
  }
  return { embeds: [{ description, color: COLOR.merged }] };
}

export function leaderboardMessage(
  board: Leaderboard,
  program: Program,
  opts: {
    final?: boolean;
    limit?: number;
    /** The program's public page. */
    url?: string;
    /** Extra line for the final results. */
    finalNote?: string;
    /** Lowercased GitHub login to Discord id, for people who linked their account. */
    members?: Map<string, string>;
    /** True when members can link their GitHub account with /link. */
    linking?: boolean;
  } = {}
): MessagePayload {
  const who = (login: string) => person(login, opts.members?.get(login.toLowerCase()));
  const { title, minPrs, topN, reward, label, note } = program;
  const shown = board.rows.slice(0, opts.limit ?? 10);
  const lines = shown.map((row, i) => {
    const prs = `${row.count} merged ${row.count === 1 ? "PR" : "PRs"}`;
    // Same as the chips on the page: a countdown while it runs, nothing once it's over.
    const countdown = opts.final ? "" : ` · ${minPrs - row.count} more to qualify`;
    const note = row.winner ? (opts.final ? " · winner" : " · in the top " + topN) : row.qualifies ? " · qualifies" : countdown;
    return `${i + 1}. ${who(row.login)} · ${prs}${note}`;
  });
  const winners = board.rows.filter((r) => r.winner);

  let description: string;
  if (lines.length === 0) {
    description = "No merged PRs counted yet. Pick a starter issue and be the first.";
  } else {
    description = lines.join("\n");
    if (opts.final) {
      description +=
        winners.length > 0
          ? `\n\nCongratulations to ${winners.map((w) => who(w.login)).join(", ")}. We'll DM you on Discord with a private form for the shipping details, so we can send you ${reward}.`
          : `\n\nNobody reached ${minPrs} merged PRs this time. Thank you to everyone who contributed.`;
      // A DM needs a Discord account, and we only know it for winners who linked.
      const unlinked = opts.linking ? winners.filter((w) => !opts.members?.has(w.login.toLowerCase())) : [];
      if (unlinked.length > 0) {
        description += ` ${joinNames(unlinked.map((w) => person(w.login)))}: run \`/link\` in this server so we know which Discord account is yours.`;
      }
      if (opts.finalNote) description += `\n\n${opts.finalNote}`;
    }
  }
  if (opts.url) description = `${truncate(description, 3800)}\n\n[Full leaderboard and rules](${opts.url})`;

  const embed: Embed = {
    title: opts.final ? `${title} leaderboard: final results` : `${title} leaderboard`,
    url: opts.url,
    description: truncate(description, 4000),
    color: COLOR.gold,
    footer: {
      text: `Top ${topN} with at least ${minPrs} merged PRs labeled ${label} get ${reward}. Ties go to whoever got there first.${note ? ` ${note}` : ""}`,
    },
    timestamp: board.generatedAt,
  };
  return { embeds: [embed] };
}

export function starterIssuesReply(
  cfg: Config,
  issuesByRepo: { repo: string; issues: StarterIssue[] }[],
  labels: string[] = cfg.starterLabels
): MessagePayload {
  const perRepo = Math.max(3, Math.floor(12 / Math.max(1, issuesByRepo.length)));
  const embeds: Embed[] = issuesByRepo.map(({ repo, issues }) => {
    // A comma between quoted labels means "any of these" in GitHub search.
    const labelFilter = labels.map((l) => `"${l}"`).join(",");
    const listUrl = `https://github.com/${cfg.org}/${repo}/issues?q=${encodeURIComponent(`is:issue is:open no:assignee -label:blocked label:${labelFilter}`)}`;
    const lines = issues
      .slice(0, perRepo)
      .map((i) => `[#${i.number}](${i.url}) ${escapeMarkdown(truncate(i.title, 90))}`);
    const more = issues.length > perRepo ? `\n[and ${issues.length - perRepo} more](${listUrl})` : "";
    return {
      title: `${repo}: ${issues.length} open starter ${issues.length === 1 ? "issue" : "issues"}`,
      url: listUrl,
      description: lines.length ? lines.join("\n") + more : "Nothing unassigned right now. Check back soon.",
      color: COLOR.open,
    };
  });
  return {
    content: "Comment on an issue on GitHub to claim it. One issue at a time, please.",
    embeds,
  };
}

// ---- learning check-ins ----

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The first message of a learner's log thread. The mention shows their name but doesn't ping. */
export function checkinThreadIntro(userId: string, roadmap: Roadmap): MessagePayload {
  return {
    content: `<@${userId}>'s log for **${roadmap.name}** (${roadmap.days} days).\nRoadmap: <${roadmap.url}>\n\nEvery \`/checkin\` lands here. Reply with notes, code, screenshots or questions.`,
  };
}

export function checkinPost(input: {
  userId: string;
  roadmap: Roadmap;
  record: CheckinRecord;
  note?: string;
  finished: boolean;
}): MessagePayload {
  const { record, roadmap } = input;
  const headline = input.finished
    ? `**Day ${record.day} of ${roadmap.days}. Finished!**`
    : `**Day ${record.day} of ${roadmap.days}** · ${plural(record.streak, "day")} streak`;
  const note = input.note?.trim();
  // Quote the note line by line so it can't break out of the block quote.
  const quoted = note ? "\n" + truncate(note, 500).split("\n").map((line) => `> ${line}`).join("\n") : "";
  return { content: `${headline} · <@${input.userId}>${quoted}` };
}

/** What the learner sees after running /checkin. Only they can see it. */
export function checkinReply(result: CheckinResult, roadmap: Roadmap, threadId?: string): MessagePayload {
  const thread = threadId ? ` Your log: <#${threadId}>` : "";
  if (result.ok) {
    const { record } = result;
    if (result.finished) {
      return { content: `Day ${record.day} of ${roadmap.days}. You finished **${roadmap.name}**. That took real work, well done.${thread}` };
    }
    const best = record.streak === record.bestStreak && record.streak > 1 ? " That's your best streak so far." : "";
    return {
      content: `Checked in: day ${record.day} of ${roadmap.days} on **${roadmap.name}**. Streak: ${plural(record.streak, "day")}.${best}${thread}`,
    };
  }
  switch (result.reason) {
    case "already-today":
      return { content: `You already checked in today (day ${result.record?.day}). Come back tomorrow, and add anything else in your log thread.${thread}` };
    case "already-finished":
      return { content: `You've already finished **${roadmap.name}**. Pick another roadmap, or help someone who's still on it.${thread}` };
    case "day-out-of-range":
      return { content: `**${roadmap.name}** has days 1 to ${roadmap.days}. Pick a day in that range.` };
    case "day-not-ahead":
      return { content: `Your last check-in was day ${result.record?.day}, so the next one has to be a later day. Leave \`day\` empty to continue from there.` };
  }
}

export function streaksMessage(
  cfg: Config,
  ranked: (CheckinRecord & { live: number })[],
  opts: { limit?: number; roadmap?: string } = {}
): MessagePayload {
  const wanted = opts.roadmap
    ? cfg.roadmaps.filter((r) => r.name === opts.roadmap)
    : cfg.roadmaps;
  const embeds: Embed[] = [];
  for (const roadmap of wanted) {
    const rows = ranked.filter((r) => r.roadmap === roadmap.id);
    if (rows.length === 0) continue;
    const lines = rows.slice(0, opts.limit ?? 10).map((r, i) => {
      const progress = r.day >= roadmap.days ? "finished" : `day ${r.day} of ${roadmap.days}`;
      const streak = r.live > 0 ? `${plural(r.live, "day")} streak` : "streak ended";
      return `${i + 1}. **${escapeMarkdown(r.name)}** · ${streak} · ${progress}`;
    });
    embeds.push({ title: roadmap.name, url: roadmap.url, description: lines.join("\n"), color: COLOR.gold });
  }
  if (embeds.length === 0) {
    if (opts.roadmap) {
      return { content: `Nobody has checked in on **${opts.roadmap}** yet. Run \`/checkin\` to start your streak.` };
    }
    return { content: "Nobody has checked in yet. Run `/checkin` to start your streak." };
  }
  return { content: "Learning streaks. Check in every day with `/checkin` to keep yours alive.", embeds };
}

// ---- welcome, linking and /me ----

const row = (...components: Button[]): ActionRow => ({ type: 1, components });
const linkButton = (label: string, url: string): Button => ({ type: 2, style: 5, label, url });

/** The button on the welcome post that starts /link. Its id is matched in src/index.ts. */
export const LINK_BUTTON_ID = "link";

/** Posted once for every new member. The only message that notifies the person it mentions. */
export function welcomeMessage(userId: string, cfg: Config, opts: { linking: boolean; issuesUrl?: string }): MessagePayload {
  const lines = [
    "Good to have you here. CODERCOPS is a community of developers: open source contributors, people working through our learning roadmaps, and people looking for their next job.",
    "",
    "Say hi in this channel. Tell us who you are and what you're building.",
    "Want to contribute? Run `/issues` to see what's free to pick up.",
  ];
  if (cfg.roadmapsChannel) lines.push(`Here to learn? Pick a roadmap in <#${cfg.roadmapsChannel}> and log each day with \`/checkin\`.`);
  if (opts.linking) {
    lines.push("Link your GitHub with the button below, so your merged PRs show up under your name and you get the Contributor role.");
  }

  const buttons: Button[] = [];
  if (opts.linking) buttons.push({ type: 2, style: 1, label: "Link GitHub", custom_id: LINK_BUTTON_ID });
  if (opts.issuesUrl) buttons.push(linkButton("Find an issue", opts.issuesUrl));
  if (cfg.guildId && cfg.roadmapsChannel) {
    buttons.push(linkButton("Pick a roadmap", `https://discord.com/channels/${cfg.guildId}/${cfg.roadmapsChannel}`));
  }
  return {
    content: `Welcome, <@${userId}>!`,
    embeds: [{ description: lines.join("\n"), color: COLOR.open }],
    components: buttons.length ? [row(...buttons)] : undefined,
  };
}

/** The private reply to /link: what gets shared, and the button that opens Discord's consent screen. */
export function linkPrompt(url: string, currentLogin?: string): MessagePayload {
  const lines = [
    currentLogin
      ? `You're linked to **${escapeMarkdown(currentLogin)}** right now. Linking again replaces that.`
      : "Link your GitHub account to your Discord account.",
    "",
    "The button opens Discord and asks to share your username and your connected accounts. I read the GitHub account connected to your Discord profile and store two things: your Discord id and your GitHub username. Your GitHub username will show next to your name in this server, for example when a PR of yours is merged. `/unlink` deletes it again.",
    "",
    "No GitHub on your Discord profile yet? Add it first under User Settings > Connections. The button works for 15 minutes.",
  ];
  return { content: lines.join("\n"), components: [row(linkButton("Link my GitHub", url))] };
}

// ---- /help ----

/**
 * The private reply to /help: every command the member can run right now, one
 * line each. The link commands only exist while linking is switched on, so
 * they're left out otherwise.
 */
export function helpReply(linking: boolean): MessagePayload {
  const lines = [
    "`/help`: Show the commands and what they do.",
    "`/issues`: List open starter issues nobody has claimed yet.",
    "`/leaderboard`: Show who has the most merged PRs in a contributor program.",
    "`/checkin`: Log today on a learning roadmap and keep your streak alive.",
    "`/streaks`: Show the learning streaks for every roadmap.",
  ];
  if (linking) {
    lines.push(
      "`/link`: Link your GitHub account to your Discord account.",
      "`/unlink`: Remove the link between your GitHub and Discord accounts.",
      "`/me`: Show your merged PRs and where you stand."
    );
  }
  lines.push("", "Spotted a bug or have an idea? Open an issue at https://github.com/codercops/discord-bot");
  return { content: lines.join("\n") };
}

/** The private reply to /me. */
export function meReply(input: {
  login: string;
  /** Merged PRs in our repos, at any time. */
  merged: number;
  /** Roles handed out just now. */
  newRoles: string[];
  /** Maintainers aren't on the leaderboard and don't get the contributor roles. */
  maintainer?: boolean;
  standing?: {
    program: Program;
    status: ProgramStatus;
    url: string;
    /** 1-based, with the row; both missing when they have no counted PR. */
    rank?: number;
    row?: LeaderboardRow;
    of: number;
  };
}): MessagePayload {
  const lines = [
    `You're linked to **${escapeMarkdown(input.login)}** on GitHub.`,
    `Merged PRs in our repos: **${input.merged}**.`,
  ];
  if (input.newRoles.length) lines.push(`You now have the ${joinNames(input.newRoles.map((r) => `**${r}**`))} role.`);
  if (input.maintainer) lines.push("You're a maintainer, so you're not on the leaderboard and the contributor roles aren't for you.");

  const s = input.standing;
  if (s) {
    const { title, minPrs, topN, reward } = s.program;
    if (!s.row || !s.rank) {
      lines.push(
        s.status === "ended"
          ? `**${title}** is over and you had no counted PRs in it.`
          : `**${title}**: no counted PRs yet. Run \`/issues\` to find one.`
      );
    } else {
      const prs = `${s.row.count} merged ${s.row.count === 1 ? "PR" : "PRs"}`;
      let line = `**${title}**: ${prs}, ${ordinal(s.rank)} of ${s.of}.`;
      if (s.status === "ended") line += s.row.winner ? " You're one of the winners." : "";
      else if (s.row.winner) line += ` You're in the top ${topN} right now.`;
      else if (s.row.qualifies) line += ` You qualify, but you're outside the top ${topN} right now.`;
      else line += ` ${minPrs - s.row.count} more to qualify for ${reward}.`;
      lines.push(line);
      lines.push(`Your card to share: <${s.url}/u/${encodeURIComponent(input.login)}>`);
    }
    if (!s.row || !s.rank) lines.push(`<${s.url}>`);
  }
  return { content: lines.join("\n") };
}
