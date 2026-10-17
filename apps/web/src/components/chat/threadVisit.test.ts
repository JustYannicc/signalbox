import { describe, expect, it } from "vite-plus/test";

import { hasUnseenFailure } from "../sidebar/failedPill";
import { createVisitDedupe, visitStampFor } from "./threadVisit";

// The #841 preview walk: sent at 16:49:41.972, failed at 16:50:30.039 while elsewhere.
const SENT = "2026-10-17T16:49:41.972Z";
const FAILED = "2026-10-17T16:50:30.039Z";
const failedRun = { status: "failed" as const, completedAt: FAILED };
const thread = (route: string) => `env-1:${route}`;

describe("visitStampFor", () => {
  it("stamps the failure's end, which clears the Failed pill once the visit lands", () => {
    const stamp = visitStampFor({ updatedAt: FAILED, latestRun: failedRun });
    expect(stamp).toBe(FAILED);
    expect(hasUnseenFailure({ latestRun: failedRun, lastVisitedAt: SENT } as never)).toBe(true);
    expect(hasUnseenFailure({ latestRun: failedRun, lastVisitedAt: stamp } as never)).toBe(false);
  });

  it("never stamps before the latest run ended, even with an older updatedAt", () => {
    expect(visitStampFor({ updatedAt: SENT, latestRun: failedRun })).toBe(FAILED);
    expect(visitStampFor({ updatedAt: SENT, latestRun: { completedAt: null } })).toBe(SENT);
    expect(visitStampFor({ updatedAt: SENT })).toBe(SENT);
  });
});

describe("createVisitDedupe", () => {
  const key = `${thread("a")}:${FAILED}`;

  it("skips a repeat while the same thread stays open, so mark-unread sticks", () => {
    const dedupe = createVisitDedupe();
    dedupe.sent(thread("a"), key);
    expect(dedupe.isDuplicate(thread("a"), key)).toBe(true);
  });

  it("visits again when the thread is reopened with the same watermark", () => {
    const dedupe = createVisitDedupe();
    dedupe.sent(thread("a"), key);
    expect(dedupe.isDuplicate(thread("b"), `${thread("b")}:${SENT}`)).toBe(false);
    expect(dedupe.isDuplicate(thread("a"), key)).toBe(false);
  });

  it("retries a visit that failed", () => {
    const dedupe = createVisitDedupe();
    dedupe.sent(thread("a"), key);
    dedupe.failed(key);
    expect(dedupe.isDuplicate(thread("a"), key)).toBe(false);
  });
});
