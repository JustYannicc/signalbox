import { expect, it } from "vite-plus/test";
import { rpcResourceSnapshot } from "../../../../src/rpc/Resources.ts";
import {
  emptyClaudeAttemptResources,
  emptyClaudeRequestAttemptCounters,
  finishClaudeRequestAttempt,
  startClaudeRequestAttempt,
} from "./claudeAttemptCounters.ts";

it("persists RPC scope snapshots and finalizes a successful request once", () => {
  const rpcSnapshot = rpcResourceSnapshot();
  const started = startClaudeRequestAttempt(
    emptyClaudeRequestAttemptCounters(),
    "not-owned",
    rpcSnapshot,
  );
  const resources = {
    ...emptyClaudeAttemptResources(),
    transportEntered: true,
    requestCaptureBytes: 2,
    responseCaptureBytes: 3,
    peakBufferedBytes: 5,
    cumulativeBufferedBytes: 5,
    requestCaptureBodyLifecycle: "consumed" as const,
    responseCaptureBodyLifecycle: "consumed" as const,
    returnedResponseBodyLifecycle: "caller-owned" as const,
  };
  const finished = finishClaudeRequestAttempt(
    started.counters,
    started.marker,
    "success",
    resources,
    rpcSnapshot,
  );

  expect(finished.counters).toMatchObject({
    nextOrdinal: 1,
    started: 1,
    activeRequests: 0,
    succeeded: 1,
    failed: 0,
    finalized: 1,
    transportEntered: 1,
    requestCaptureBytes: 2,
    responseCaptureBytes: 3,
    cumulativeBufferedBytes: 5,
    peakAttemptBufferedBytes: 5,
    requestCaptureBodiesConsumed: 1,
    responseCaptureBodiesConsumed: 1,
  });
  expect(finished.marker).toMatchObject({
    ordinal: 1,
    state: "finished",
    outcome: "success",
    finalized: true,
    rpc: {
      scope: "cloud-rpc-module-global",
      start: { memoryMeasurement: "unavailable", heapBytes: null, rssBytes: null },
      end: { memoryMeasurement: "unavailable", heapBytes: null, rssBytes: null },
    },
  });
  expect(() =>
    finishClaudeRequestAttempt(
      finished.counters,
      finished.marker,
      "success",
      resources,
      rpcSnapshot,
    ),
  ).toThrow("cannot be finalized from its current state");
});
