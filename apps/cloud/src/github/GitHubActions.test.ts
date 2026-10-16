import { describe, expect, it } from "@effect/vitest";

import { actionsStatus, logTail } from "./GitHubActions.ts";

const ESC = String.fromCharCode(27);

/** A job log as GitHub serves it, cut from a real run of Signalbox's step workflow. */
const LOG = [
  "﻿2026-10-16T15:51:33.2612093Z ##[group]Runner Image Provisioner",
  "2026-10-16T15:51:33.2613000Z Hosted Compute Agent",
  "2026-10-16T15:51:33.2643869Z ##[endgroup]",
  '2026-10-16T15:51:35.7632063Z ##[group]Run mkdir -p "$RUNNER_TEMP/signalbox"',
  `2026-10-16T15:51:35.7633945Z ${ESC}[36;1mmkdir -p "$RUNNER_TEMP/signalbox"${ESC}[0m`,
  "2026-10-16T15:51:35.7700000Z env:",
  '2026-10-16T15:51:35.7700001Z   SIGNALBOX_PAYLOAD: {"module":"import ms from \\"ms\\";"}',
  "2026-10-16T15:51:35.7780317Z ##[endgroup]",
  "2026-10-16T15:51:36.7000000Z ",
  "2026-10-16T15:51:36.7100000Z added 1 package in 845ms",
  `2026-10-16T15:51:36.7762961Z ${ESC}[32mBuilding web at b6aabf6${ESC}[0m`,
  "2026-10-16T15:51:36.7997821Z ##[group]Run actions/upload-artifact@v7",
  "2026-10-16T15:51:36.7998000Z with:",
  "2026-10-16T15:51:36.8007158Z ##[endgroup]",
  "2026-10-16T15:51:37.1000000Z Artifact signalbox-result has been successfully uploaded! Final size is 235 bytes.",
  "2026-10-16T15:51:37.2000000Z ##[error]Process completed with exit code 1.",
  "2026-10-16T15:51:37.3000000Z Post job cleanup.",
  "2026-10-16T15:51:37.4000000Z [command]/usr/bin/git version",
  "2026-10-16T15:51:37.5000000Z Cleaning up orphan processes",
].join("\n");

describe("GitHub Actions", () => {
  it("keeps what the steps printed from a job's log", () => {
    expect(logTail(LOG)).toBe(
      [
        "added 1 package in 845ms",
        "Building web at b6aabf6",
        "Artifact signalbox-result has been successfully uploaded! Final size is 235 bytes.",
        "error: Process completed with exit code 1.",
      ].join("\n"),
    );
  });

  it("reads GitHub's status and conclusion as one status", () => {
    expect(actionsStatus("queued", null)).toBe("queued");
    expect(actionsStatus("waiting", null)).toBe("queued");
    expect(actionsStatus("in_progress", null)).toBe("running");
    expect(actionsStatus("completed", "success")).toBe("succeeded");
    expect(actionsStatus("completed", "skipped")).toBe("skipped");
    expect(actionsStatus("completed", "cancelled")).toBe("cancelled");
    expect(actionsStatus("completed", "timed_out")).toBe("failed");
    expect(actionsStatus("completed", "startup_failure")).toBe("failed");
  });
});
