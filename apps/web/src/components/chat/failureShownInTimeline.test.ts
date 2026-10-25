import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { failureShownInTimeline } from "./failureShownInTimeline";

const run = RunId.make("run-1");
const failure = (
  runId: RunId,
  status: "failed" | "running",
  message: string,
): OrchestrationV2TurnItem =>
  ({
    type: "error",
    runId,
    status,
    failure: { class: "provider_error", message, code: null, retryable: null },
  }) as unknown as OrchestrationV2TurnItem;

describe("failureShownInTimeline", () => {
  it("is true when the latest run's failure row carries the same error", () => {
    expect(
      failureShownInTimeline(
        [failure(run, "failed", "Provider turn failed.")],
        run,
        "Provider turn failed.",
      ),
    ).toBe(true);
  });

  it("is false for an error the timeline doesn't hold, so the banner still shows it", () => {
    expect(failureShownInTimeline([], run, "Couldn't send the message.")).toBe(false);
    expect(
      failureShownInTimeline(
        [failure(run, "failed", "Another cause")],
        run,
        "Provider turn failed.",
      ),
    ).toBe(false);
  });

  it("ignores retries still running and failures of earlier runs", () => {
    expect(failureShownInTimeline([failure(run, "running", "Overloaded")], run, "Overloaded")).toBe(
      false,
    );
    expect(
      failureShownInTimeline(
        [failure(RunId.make("run-0"), "failed", "Overloaded")],
        run,
        "Overloaded",
      ),
    ).toBe(false);
  });

  it("is false without an error", () => {
    expect(failureShownInTimeline([failure(run, "failed", "x")], run, null)).toBe(false);
  });
});
