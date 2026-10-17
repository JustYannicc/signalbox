import {
  RunId,
  ThreadId,
  OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { DependencyProgress, RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import type { DecisionContext } from "../threadEvents.ts";
import { dependencyProgressEvents, noticeEvents } from "./driveItems.ts";

const threadId = ThreadId.make("drive-items-test");
const runId = RunId.make("drive-items-run");
const run = {
  id: runId,
  ordinal: 1,
  rootNodeId: null,
  providerThreadId: null,
} as unknown as OrchestrationV2Run;
const projection = {
  thread: { id: threadId },
  runs: [run],
  turnItems: [],
} as unknown as OrchestrationV2ThreadProjection;
const contextAt = (at: string): DecisionContext => ({ now: DateTime.makeUnsafe(at) });

function itemFromProgress(
  input: typeof DependencyProgress.Type,
  context: DecisionContext,
  existing = projection,
) {
  const event = dependencyProgressEvents(existing, run, input, context)[0];
  if (event?.type !== "turn-item.updated") throw new Error("Expected a turn item event");
  expect(
    Schema.decodeUnknownSync(OrchestrationV2TurnItem)(
      Schema.encodeSync(OrchestrationV2TurnItem)(event.payload),
    ),
  ).toEqual(event.payload);
  return event.payload;
}

describe("runner dependency progress", () => {
  it("decodes only checkout-relative roots in the typed RunnerItem", () => {
    const decode = Schema.decodeUnknownSync(RunnerItem);
    const progress = {
      kind: "dependencies.progress",
      runId,
      root: "app",
      status: "installing",
      reason: "new",
      message: "Installing dependencies in app/ from pnpm-lock.yaml.",
    };

    expect(decode(progress)).toEqual(progress);
    expect(() => decode({ ...progress, root: "/Users/agent/project/app" })).toThrow();
    expect(() => decode({ ...progress, root: "../../private" })).toThrow();
    expect(() => decode({ ...progress, root: "\\\\server\\share" })).toThrow();
  });

  it("updates one informational row from installing through success", () => {
    const startedAt = "2026-01-01T00:00:00Z";
    const install = itemFromProgress(
      {
        root: "app",
        status: "installing",
        reason: "new",
        message: "Installing dependencies in app/ from pnpm-lock.yaml.",
      },
      contextAt(startedAt),
    );
    expect(install).toMatchObject({
      id: `turn-item:${runId}:dependencies:app`,
      type: "notification",
      status: "running",
      startedAt: DateTime.makeUnsafe(startedAt),
      completedAt: null,
      outcome: "updated",
    });

    const readyAt = "2026-01-01T00:00:12Z";
    const ready = itemFromProgress(
      {
        root: "app",
        status: "installed",
        reason: "new",
        message: "Dependencies installed in app/.",
        durationMs: 12_000,
      },
      contextAt(readyAt),
      { ...projection, turnItems: [install] },
    );
    expect(ready).toMatchObject({
      id: install.id,
      type: "notification",
      status: "completed",
      startedAt: DateTime.makeUnsafe(startedAt),
      completedAt: DateTime.makeUnsafe(readyAt),
      outcome: "completed",
      summary: "Dependencies installed in app/.",
    });
  });

  it("records reused dependencies as informational and install failures as warnings", () => {
    const reused = itemFromProgress(
      {
        root: "",
        status: "reused",
        reason: "adopted",
        message: "Dependencies already installed in this folder.",
      },
      contextAt("2026-01-01T00:00:03Z"),
    );
    expect(reused).toMatchObject({
      id: `turn-item:${runId}:dependencies:`,
      type: "notification",
      status: "completed",
      source: { kind: "system" },
      outcome: "completed",
    });

    const startedAt = "2026-01-01T00:00:00Z";
    const install = itemFromProgress(
      {
        root: "app",
        status: "installing",
        reason: "new",
        message: "Installing dependencies in app/ from pnpm-lock.yaml.",
      },
      contextAt(startedAt),
    );
    const failed = itemFromProgress(
      {
        root: "app",
        status: "failed",
        reason: "new",
        message: "Installing dependencies in app/ failed: ERR_PNPM_BROKEN_LOCKFILE.",
        durationMs: 3_000,
      },
      contextAt("2026-01-01T00:00:03Z"),
      { ...projection, turnItems: [install] },
    );

    expect(failed).toMatchObject({
      id: install.id,
      type: "system_notice",
      status: "failed",
      startedAt: DateTime.makeUnsafe(startedAt),
      completedAt: DateTime.makeUnsafe("2026-01-01T00:00:03Z"),
      message: "Installing dependencies in app/ failed: ERR_PNPM_BROKEN_LOCKFILE.",
    });
  });

  it("leaves existing drive notices unchanged", () => {
    const event = noticeEvents(
      projection,
      run,
      { kind: "drive.notice", runId, message: "Merged main with conflicts." },
      contextAt("2026-01-01T00:00:00Z"),
    )[0];
    if (event?.type !== "turn-item.updated") throw new Error("Expected a turn item event");
    expect(event.payload).toMatchObject({
      type: "system_notice",
      status: "completed",
      title: "Drive",
      message: "Merged main with conflicts.",
    });
  });
});
