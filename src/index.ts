import { listCheckins, localDate, rankStreaks } from "./checkin";
import { runCommand, type CommandData, type CommandUser } from "./commands";
import { DAILY_CRON, getConfig, WELCOME_CRON, type Config, type Env } from "./config";
import { editInteractionReply, sendMessage } from "./discord";
import { getLeaderboard } from "./leaderboard";
import { GithubError } from "./github";
import { linkedMembers } from "./links";
import { completeLink } from "./linking";
import { leaderboardMessage, LINK_BUTTON_ID, streaksMessage } from "./messages";
import { linkingEnabled } from "./oauth";
import { BOARD_ROWS, boardSvg, boardVersion, cardSvg } from "./card";
import { contributorPage, FAVICON_SVG, leaderboardJson, leaderboardPage, noticePage, standing } from "./page";
import { currentProgram, findProgram, LEADERBOARD_IMAGE_PATH, LEADERBOARD_PATH, leaderboardUrl, programStatus } from "./programs";
import { verifyDiscordRequest, verifyGithubSignature } from "./verify";
import { handleGithubEvent, resyncStarterIssues } from "./webhook";
import { welcomeNewMembers } from "./welcome";
import { version } from "../package.json";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

// Discord interaction and response types we use.
const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const PONG = 1;
const DEFERRED_CHANNEL_MESSAGE = 5;
const EPHEMERAL = 64;


const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

interface Interaction {
  type: number;
  token: string;
  /** A command's name and options, or the custom_id of the button that was pressed. */
  data?: CommandData & { custom_id?: string };
  /** Present when the command is run in a server. */
  member?: { nick?: string | null; user: DiscordUser };
}

// Commands that act on a person only work inside the server, so DMs give null.
function commandUser(interaction: Interaction): CommandUser | null {
  const member = interaction.member;
  if (!member) return null;
  return { id: member.user.id, name: member.nick || member.user.global_name || member.user.username };
}

async function handleInteraction(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.text();
  const valid = await verifyDiscordRequest(
    env.DISCORD_PUBLIC_KEY,
    request.headers.get("X-Signature-Ed25519"),
    request.headers.get("X-Signature-Timestamp"),
    body
  );
  if (!valid) return new Response("invalid request signature", { status: 401 });

  const interaction = JSON.parse(body) as Interaction;
  if (interaction.type === PING) return json({ type: PONG });

  // The "Link GitHub" button on the welcome post does what /link does.
  const pressedLink = interaction.type === MESSAGE_COMPONENT && interaction.data?.custom_id === LINK_BUTTON_ID;
  if ((interaction.type === APPLICATION_COMMAND || pressedLink) && interaction.data) {
    const data: CommandData = pressedLink ? { name: "link" } : interaction.data;
    // Discord wants an answer within 3 seconds. Acknowledge now, then fill in
    // the reply once GitHub has answered.
    ctx.waitUntil(
      (async () => {
        const reply = await runCommand(data, commandUser(interaction), env, getConfig(env));
        await editInteractionReply(env, interaction.token, reply);
      })().catch((err) => console.error("interaction reply failed", err))
    );
    return json({ type: DEFERRED_CHANNEL_MESSAGE, data: { flags: EPHEMERAL } });
  }

  return json({ error: "unsupported interaction" }, 400);
}

async function handleGithubWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const valid = await verifyGithubSignature(env.GITHUB_WEBHOOK_SECRET, request.headers.get("X-Hub-Signature-256"), body);
  if (!valid) return new Response("invalid signature", { status: 401 });

  const event = request.headers.get("X-GitHub-Event") ?? "";
  try {
    const result = await handleGithubEvent(event, JSON.parse(body), env, getConfig(env));
    return json({ ok: true, result });
  } catch (err) {
    // A 5xx makes the delivery show as failed in GitHub, where it can be redelivered.
    console.error("webhook failed", event, err);
    return json({ ok: false }, 500);
  }
}

// A program's public leaderboard, as a page for people and as JSON for anything
// else. /leaderboard shows the current program; /leaderboard/{id} is the
// permanent address of one program, so past ones stay online.
async function handleLeaderboardPage(request: Request, env: Env, id: string | undefined, asJson: boolean): Promise<Response> {
  const cfg = getConfig(env);
  const now = new Date();
  const program = id === undefined ? currentProgram(cfg, now) : findProgram(cfg, id);
  if (!program) return new Response("not found", { status: 404 });
  // Browsers and the edge may reuse the response for five minutes.
  const cache = "public, max-age=300";
  try {
    const board = await getLeaderboard(env, cfg, program);
    if (asJson) {
      return new Response(JSON.stringify(leaderboardJson(board, program, now)), {
        headers: { "Content-Type": "application/json", "Cache-Control": cache, "Access-Control-Allow-Origin": "*" },
      });
    }
    const self = new URL(`/leaderboard/${program.id}`, request.url).href;
    // The version makes share previews pick up a new image when the top five change.
    const image = new URL(`/leaderboard/${program.id}.png?v=${boardVersion(board.rows, program, now)}`, request.url).href;
    const others = cfg.programs
      .filter((p) => p.id !== program.id)
      .reverse()
      .map((p) => ({ title: p.title, path: `/leaderboard/${p.id}` }));
    const html = leaderboardPage(board, program, { issues: env.ISSUES_URL, discord: env.DISCORD_INVITE, self, image, others }, now, {
      linking: linkingEnabled(env),
    });
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": cache,
        // Nothing on the page runs scripts or loads anything but the favicon and GitHub avatars.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https://github.com https://avatars.githubusercontent.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      },
    });
  } catch (err) {
    const limited = err instanceof GithubError && (err.status === 403 || err.status === 429);
    console.error("leaderboard page failed", err);
    return new Response(limited ? "GitHub is rate limiting us. Try again in a minute." : "The leaderboard is unavailable right now.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "60" },
    });
  }
}

// A program's leaderboard as a share image: /leaderboard/{id}.png. The page's
// og:image points here.
async function handleLeaderboardImage(request: Request, env: Env, ctx: ExecutionContext, id: string): Promise<Response> {
  const cfg = getConfig(env);
  const now = new Date();
  const program = findProgram(cfg, id);
  if (!program) return new Response("not found", { status: 404 });

  // The image is the same for everyone and costs some CPU to draw, so keep it at the edge.
  const cache = typeof caches !== "undefined" ? await caches.open("cards").catch(() => undefined) : undefined;
  // The cache only takes GET requests, and it keys on the address. So a HEAD
  // asks for the image under the key a GET uses, and stores it there too:
  // otherwise the cache would throw, and the image would be left empty for the
  // next GET.
  const cacheKey = request.method === "GET" ? request : new Request(request.url);
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;

  let board;
  try {
    board = await getLeaderboard(env, cfg, program);
  } catch (err) {
    console.error("leaderboard image failed", err);
    return new Response("The leaderboard is unavailable right now.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "60" },
    });
  }

  // Loaded on demand: this module pulls in the rasterizer and the fonts.
  const { fetchAvatar, renderPng } = await import("./card-image");
  const avatars = await Promise.all(board.rows.slice(0, BOARD_ROWS).map((row) => fetchAvatar(row.login)));
  const svg = boardSvg({
    program,
    rows: board.rows,
    avatars,
    now,
    site: cfg.publicUrl ? new URL(cfg.publicUrl).host : new URL(request.url).host,
  });
  const png = await renderPng(svg);
  const response = new Response(png, {
    headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=600", "X-Content-Type-Options": "nosniff" },
  });
  if (cache) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// Where Discord sends a member after they approve (or cancel) the /link request.
async function handleLinkCallback(request: Request, env: Env): Promise<Response> {
  const outcome = await completeLink(env, getConfig(env), new URL(request.url).searchParams, new Date());
  return new Response(noticePage(outcome.title, outcome.lines, outcome.ok), {
    status: outcome.ok ? 200 : 400,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // The URL carries a one-time code. Keep it out of caches and referrers.
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// One contributor's page in a program, and their share card as a PNG:
// /leaderboard/{id}/u/{login} and /leaderboard/{id}/u/{login}.png
const CONTRIBUTOR_PATH = /^\/leaderboard\/([a-z0-9][a-z0-9-]*)\/u\/([A-Za-z\d](?:[A-Za-z\d-]{0,38}))(\.png)?$/;

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
// The contributor page shows one image: the card, served from this Worker.
const CONTRIBUTOR_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

async function handleContributor(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  programId: string,
  login: string,
  asPng: boolean
): Promise<Response> {
  const cfg = getConfig(env);
  const now = new Date();
  const program = findProgram(cfg, programId);
  if (!program) return new Response("not found", { status: 404 });

  // The card is the same for everyone and costs some CPU to draw, so keep it at the edge.
  const cache = asPng && typeof caches !== "undefined" ? await caches.open("cards").catch(() => undefined) : undefined;
  // The cache only takes GET requests, and it keys on the address. So a HEAD
  // asks for the card under the key a GET uses, and stores it there too:
  // otherwise the cache would throw, and the card would be left empty for the
  // next GET.
  const cacheKey = request.method === "GET" ? request : new Request(request.url);
  const cached = await cache?.match(cacheKey);
  if (cached) return cached;

  let board;
  try {
    board = await getLeaderboard(env, cfg, program);
  } catch (err) {
    console.error("contributor page failed", err);
    return new Response("The leaderboard is unavailable right now.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Retry-After": "60" },
    });
  }
  const index = board.rows.findIndex((r) => r.login.toLowerCase() === login.toLowerCase());
  const row = board.rows[index];
  const boardPath = `/leaderboard/${program.id}`;
  if (!row) {
    if (asPng) return new Response("not found", { status: 404 });
    const body = noticePage(
      "No card yet",
      [
        `${login} has no counted pull requests in ${program.title}.`,
        `A card appears with the first merged pull request that counts. The leaderboard is at ${new URL(boardPath, request.url).href}`,
      ],
      false,
      "No card"
    );
    return new Response(body, { status: 404, headers: { ...PAGE_HEADERS, "Cache-Control": "no-store", "Content-Security-Policy": CONTRIBUTOR_CSP } });
  }

  const rank = index + 1;
  const of = board.rows.length;
  const status = programStatus(program, now);
  const path = `${boardPath}/u/${encodeURIComponent(row.login)}`;

  if (asPng) {
    // Loaded on demand: this module pulls in the rasterizer and the fonts.
    const { fetchAvatar, renderPng } = await import("./card-image");
    const svg = cardSvg({
      program,
      row,
      rank,
      of,
      chip: standing(row, program, status),
      avatar: await fetchAvatar(row.login),
      site: cfg.publicUrl ? new URL(cfg.publicUrl).host : new URL(request.url).host,
    });
    const png = await renderPng(svg);
    const response = new Response(png, {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=600", "X-Content-Type-Options": "nosniff" },
    });
    if (cache) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  // The version makes share previews pick up a new image when the numbers change.
  const version = `${row.count}-${rank}-${of}-${status}`;
  const prsQuery = `org:${cfg.org} is:pr is:merged author:${row.login} label:"${program.label}" merged:${program.start.toISOString().slice(0, 10)}..${program.end.toISOString().slice(0, 10)}`;
  const html = contributorPage(
    { program, row, rank, of, generatedAt: board.generatedAt },
    {
      self: new URL(path, request.url).href,
      image: new URL(`${path}.png?v=${version}`, request.url).href,
      board: boardPath,
      prs: `https://github.com/search?${new URLSearchParams({ q: prsQuery, type: "pullrequests" })}`,
      issues: env.ISSUES_URL,
      discord: env.DISCORD_INVITE,
    },
    now
  );
  return new Response(html, { headers: { ...PAGE_HEADERS, "Cache-Control": "public, max-age=300", "Content-Security-Policy": CONTRIBUTOR_CSP } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const response = await route(request, env, ctx);
    if (request.method !== "HEAD" || !response.body) return response;
    // A HEAD is a GET without the body: the same status and the same headers,
    // and nothing to read.
    const { status, statusText, headers } = response;
    await response.arrayBuffer();
    return new Response(null, { status, statusText, headers });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const cfg = getConfig(env);
    const now = new Date(controller.scheduledTime);
    if (controller.cron === DAILY_CRON) await dailyPosts(env, cfg, now);
    if (controller.cron === WELCOME_CRON) {
      await resyncStarterIssues(env, cfg);
      await welcomeNewMembers(env, cfg, now);
    }
  },
} satisfies ExportedHandler<Env>;

// The public pages answer GET and HEAD alike. /link/callback stays on GET
// alone, because it spends a one-time code from Discord.
async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (request.method === "POST" && pathname === "/interactions") return handleInteraction(request, env, ctx);
  if (request.method === "POST" && pathname === "/github") return handleGithubWebhook(request, env);

  const read = request.method === "GET" || request.method === "HEAD";

  // The public pages have their own address. Links to them on the Worker's
  // workers.dev address keep working by redirecting there.
  const publicUrl = getConfig(env).publicUrl;
  const onPublicHost = publicUrl !== "" && new URL(publicUrl).host === url.host;
  if (read && pathname.startsWith("/leaderboard") && !onPublicHost && url.hostname.endsWith(".workers.dev") && publicUrl) {
    return Response.redirect(`${publicUrl}${pathname}${url.search}`, 301);
  }
  if (read && pathname === "/" && onPublicHost) {
    return Response.redirect(`${publicUrl}/leaderboard`, 302);
  }
  if (read && pathname !== "/" && pathname.endsWith("/")) {
    return Response.redirect(`${url.origin}${pathname.replace(/\/+$/, "") || "/"}${url.search}`, 301);
  }
  const page = read ? LEADERBOARD_PATH.exec(pathname) : null;
  if (page) return handleLeaderboardPage(request, env, page[1], page[2] !== undefined);
  const boardImage = read ? LEADERBOARD_IMAGE_PATH.exec(pathname) : null;
  if (boardImage) return handleLeaderboardImage(request, env, ctx, boardImage[1]!);
  const person = read ? CONTRIBUTOR_PATH.exec(pathname) : null;
  if (person) return handleContributor(request, env, ctx, person[1]!, person[2]!, person[3] !== undefined);
  if (request.method === "GET" && pathname === "/link/callback") return handleLinkCallback(request, env);
  if (read && pathname === "/favicon.svg") {
    return new Response(FAVICON_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  if (read && pathname === "/") {
    return json({ name: "codercops-discord-bot", source: "https://github.com/codercops/discord-bot", version, commit: env.GIT_SHA || "dev" });
  }
  return new Response("not found", { status: 404 });
}

// Mondays: the leaderboard of every running program, plus the learning streaks.
// Any day: the final results of a program that has just ended, once.
async function dailyPosts(env: Env, cfg: Config, now: Date): Promise<void> {
  const monday = now.getUTCDay() === 1;
  // Each post on its own: one failing doesn't stop the rest. Failures are only
  // logged, not thrown, so the run never ends as failed and gets retried with
  // posts that already went out.
  const attempt = async (post: string, send: () => Promise<void>) => {
    try {
      await send();
    } catch (err) {
      console.error("daily post failed", post, err);
    }
  };
  for (const program of cfg.programs) {
    const status = programStatus(program, now);
    const url = leaderboardUrl(cfg, program);
    if (status === "running" && monday) {
      await attempt(`leaderboard ${program.id}`, async () => {
        const board = await getLeaderboard(env, cfg, program, { fresh: true });
        const members = await linkedMembers(env, board.rows.slice(0, 10).map((r) => r.login));
        await sendMessage(env, env.CHANNEL_LEADERBOARD, leaderboardMessage(board, program, { url, members }));
      });
    }
    // Only in the week after the end, so adding an old program to the config
    // doesn't announce it.
    if (status === "ended" && now.getTime() - program.end.getTime() <= WEEK_MS) {
      await attempt(`final results ${program.id}`, async () => {
        const posted = `final:${program.id}`;
        if (await env.STATE.get(posted)) return;
        const board = await getLeaderboard(env, cfg, program, { fresh: true });
        const members = await linkedMembers(env, board.rows.slice(0, 10).map((r) => r.login));
        await sendMessage(
          env,
          env.CHANNEL_LEADERBOARD,
          leaderboardMessage(board, program, {
            final: true,
            url,
            finalNote: cfg.finalResultsNote,
            members,
            linking: linkingEnabled(env),
          })
        );
        await env.STATE.put(posted, now.toISOString());
      });
    }
  }

  // The streak board, as long as someone checked in during the past week.
  if (monday) {
    await attempt("streak board", async () => {
      const today = localDate(now, cfg.checkinUtcOffsetMinutes);
      const weekAgo = localDate(new Date(now.getTime() - WEEK_MS), cfg.checkinUtcOffsetMinutes);
      const ranked = rankStreaks(await listCheckins(env), today);
      if (ranked.some((r) => r.lastDate >= weekAgo)) {
        await sendMessage(env, env.CHANNEL_LEADERBOARD, streaksMessage(cfg, ranked));
      }
    });
  }
}
