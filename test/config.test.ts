/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import raw from "../wrangler.jsonc?raw";
import { DAILY_CRON, getConfig, WELCOME_CRON, type Env } from "../src/config";
import { LEADERBOARD_PATH } from "../src/programs";
import { parseJsonc } from "../scripts/jsonc";

describe("wrangler.jsonc configuration", () => {
  // Parsed the same way as in scripts/register-commands.mjs
  const config = parseJsonc(raw);
  const cfg = getConfig(config.vars as unknown as Env);

  it("has triggers.crons matching DAILY_CRON and WELCOME_CRON and nothing else", () => {
    expect(config.triggers?.crons).toEqual([DAILY_CRON, WELCOME_CRON]);
  });

  it("leaves out blocked issues from ISSUES_URL", () => {
    expect(decodeURIComponent(config.vars?.ISSUES_URL ?? "")).toContain("-label:blocked");
  });

  describe("PROGRAMS", () => {
    it("has unique IDs for every program", () => {
      const ids = cfg.programs.map((p) => p.id);
      const unique = new Set(ids);
      expect(unique.size, `Duplicate program IDs found: ${ids.join(", ")}`).toBe(ids.length);
    });

    it("validates every program fields, dates, paths, and bounds", () => {
      expect(cfg.programs.length).toBeGreaterThan(0);

      for (const p of cfg.programs) {
        // Valid start and end dates
        expect(!isNaN(p.start.getTime()), `program "${p.id}" start date is invalid`).toBe(true);
        expect(!isNaN(p.end.getTime()), `program "${p.id}" end date is invalid`).toBe(true);

        // end after start
        expect(
          p.end.getTime(),
          `program "${p.id}" end date must be after start date`
        ).toBeGreaterThan(p.start.getTime());

        // id matches LEADERBOARD_PATH
        expect(
          LEADERBOARD_PATH.test(`/leaderboard/${p.id}`),
          `program "${p.id}" id does not match LEADERBOARD_PATH pattern`
        ).toBe(true);

        // minPrs and topN whole numbers of 1 or more
        expect(
          Number.isInteger(p.minPrs) && p.minPrs >= 1,
          `program "${p.id}" minPrs must be a whole number of 1 or more (got ${p.minPrs})`
        ).toBe(true);
        expect(
          Number.isInteger(p.topN) && p.topN >= 1,
          `program "${p.id}" topN must be a whole number of 1 or more (got ${p.topN})`
        ).toBe(true);

        // label and reward aren't empty
        expect(
          typeof p.label === "string" && p.label.trim().length > 0,
          `program "${p.id}" label must not be empty`
        ).toBe(true);
        expect(
          typeof p.reward === "string" && p.reward.trim().length > 0,
          `program "${p.id}" reward must not be empty`
        ).toBe(true);
      }
    });
  });

  describe("ROADMAPS", () => {
    it("has unique IDs for every roadmap", () => {
      const ids = cfg.roadmaps.map((r) => r.id);
      const unique = new Set(ids);
      expect(unique.size, `Duplicate roadmap IDs found: ${ids.join(", ")}`).toBe(ids.length);
    });

    it("validates every roadmap days and https url", () => {
      expect(cfg.roadmaps.length).toBeGreaterThan(0);

      for (const r of cfg.roadmaps) {
        // days whole number of 1 or more
        expect(
          Number.isInteger(r.days) && r.days >= 1,
          `roadmap "${r.id}" days must be a whole number of 1 or more (got ${r.days})`
        ).toBe(true);

        // https:// url
        expect(
          typeof r.url === "string" && r.url.startsWith("https://"),
          `roadmap "${r.id}" url must start with https:// (got "${r.url}")`
        ).toBe(true);
      }
    });
  });

  describe("ROLE_TIERS", () => {
    it("has unique role IDs for every tier", () => {
      const roles = cfg.roleTiers.map((t) => t.role);
      const unique = new Set(roles);
      expect(unique.size, `Duplicate role tier IDs found: ${roles.join(", ")}`).toBe(roles.length);
    });

    it("validates minPrs of 1 or more for every tier", () => {
      expect(cfg.roleTiers.length).toBeGreaterThan(0);

      for (const t of cfg.roleTiers) {
        const tierName = t.name ?? t.role;
        expect(
          Number.isInteger(t.minPrs) && t.minPrs >= 1,
          `role tier "${tierName}" minPrs must be a whole number of 1 or more (got ${t.minPrs})`
        ).toBe(true);
      }
    });
  });
});
