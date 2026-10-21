// What happens when Discord sends a member back to /link/callback.
import type { Config, Env } from "./config";
import { countMergedPrs } from "./github";
import { saveLink } from "./links";
import { exchangeCode, linkingEnabled, readState, type DiscordIdentity } from "./oauth";
import { grantEarnedRoles, isMaintainer } from "./roles";

export interface LinkOutcome {
  ok: boolean;
  title: string;
  /** Paragraphs for the page the member sees. Plain text. */
  lines: string[];
}

const AGAIN = "Run /link in the server to get a fresh link.";

export async function completeLink(env: Env, cfg: Config, query: URLSearchParams, now: Date): Promise<LinkOutcome> {
  const secret = env.DISCORD_CLIENT_SECRET;
  if (!secret || !linkingEnabled(env)) {
    return { ok: false, title: "Linking isn't switched on", lines: ["Nothing was linked."] };
  }
  if (query.get("error")) {
    return { ok: false, title: "Nothing was linked", lines: ["You cancelled, so nothing changed.", AGAIN] };
  }
  const code = query.get("code");
  const expected = await readState(secret, query.get("state") ?? "", now);
  if (!code || !expected) {
    return { ok: false, title: "This link has expired", lines: ["Links work for 15 minutes.", AGAIN] };
  }

  let identity: DiscordIdentity;
  try {
    identity = await exchangeCode(env, cfg, code);
  } catch (err) {
    console.error("link exchange failed", err);
    return { ok: false, title: "Something went wrong", lines: ["Discord didn't accept the request.", AGAIN] };
  }
  if (identity.id !== expected) {
    return {
      ok: false,
      title: "That link was for someone else",
      lines: ["It was made for a different Discord account.", "Run /link yourself to get your own."],
    };
  }
  if (!identity.github) {
    return {
      ok: false,
      title: "No GitHub account found",
      lines: [
        "Your Discord profile has no verified GitHub connection yet.",
        "In Discord, open User Settings, then Connections, and add GitHub. Then run /link again.",
      ],
    };
  }

  const { login } = identity.github;
  await saveLink(env, { discordId: identity.id, githubLogin: login, githubId: identity.github.id, linkedAt: now.toISOString() });

  // The link is saved. Roles are a bonus, so a failure here doesn't undo it.
  let roles: string[] = [];
  let mergedPrs = 0;
  try {
    mergedPrs = await countMergedPrs(env, cfg, login);
    roles = await grantEarnedRoles(env, cfg, { discordId: identity.id, githubLogin: login }, mergedPrs);
  } catch (err) {
    mergedPrs = 0;
    console.error("granting roles after linking failed", err);
  }

  return {
    ok: true,
    title: "GitHub linked",
    lines: [
      `${identity.name} on Discord is now linked to github.com/${login}.`,
      roles.length > 0
        ? `You already have merged pull requests with us, so you now have the ${roles.join(" and ")} role.`
        : isMaintainer(cfg, login)
          ? "Your merged pull requests will show up under your name in the server."
          : mergedPrs > 0
            ? `You already have ${mergedPrs} merged pull request${mergedPrs === 1 ? "" : "s"} with us.`
            : "Your merged pull requests will show up under your name in the server, and your first one earns you the Contributor role.",
      "Run /me in the server to see where you stand. You can close this tab.",
    ],
  };
}
