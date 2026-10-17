import { describe, expect, it } from "@effect/vitest";

import { whereMatches } from "./subscriptions.ts";

describe("GitHub event filters", () => {
  it("matches repository names copied from GitHub regardless of casing", () => {
    for (const event of ["pr.opened", "pr.checks.completed", "release.published", "issue.opened"]) {
      expect(
        whereMatches(
          { repository: "JustYannicc/Signalbox" },
          { event, repository: "justyannicc/signalbox" },
        ),
      ).toBe(true);
      expect(
        whereMatches(
          { repository: ["other/repo", "JustYannicc/Signalbox"] },
          { event, repository: "justyannicc/signalbox" },
        ),
      ).toBe(true);
    }
  });

  it("keeps other filters and non-GitHub source data case-sensitive", () => {
    expect(whereMatches({ title: "Bug" }, { event: "issue.opened", title: "bug" })).toBe(false);
    expect(
      whereMatches(
        { repository: "Owner/Repo" },
        { event: "source.item.changed", repository: "owner/repo" },
      ),
    ).toBe(false);
  });
});
