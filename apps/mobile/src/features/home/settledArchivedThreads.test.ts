import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../archive/useArchivedThreadSnapshots", () => ({}));
vi.mock("../../state/use-remote-environment-registry", () => ({}));

import { makeRawThreadShell, makeThreadShellFixture } from "../../test-fixtures";
import { settledArchivedThreads, withSettledArchivedThreads } from "./settledArchivedThreads";

const environmentId = EnvironmentId.make("environment-test");
const archivedAt = DateTime.makeUnsafe("2026-01-02T00:00:00.000Z");
const archive = (threads: ReturnType<typeof makeRawThreadShell>[]) =>
  settledArchivedThreads([
    { environmentId, snapshot: { schemaVersion: 1, snapshotSequence: 1, projects: [], threads } },
  ]);

describe("settled archived threads", () => {
  it("adds settled archived threads, skips plain archives, and keeps the live copy", () => {
    const live = [makeThreadShellFixture({ id: ThreadId.make("live") })];
    const merged = withSettledArchivedThreads(
      live,
      archive([
        makeRawThreadShell({
          id: ThreadId.make("done"),
          archivedAt,
          settledOverride: "settled",
          settledAt: archivedAt,
        }),
        makeRawThreadShell({ id: ThreadId.make("put-away"), archivedAt }),
        makeRawThreadShell({ id: ThreadId.make("live"), archivedAt, settledOverride: "settled" }),
      ]),
    );
    expect(merged.map((thread) => [thread.id, thread.archivedAt])).toEqual([
      ["live", null],
      ["done", "2026-01-02T00:00:00.000Z"],
    ]);
  });

  it("returns the live list itself when nothing settled is archived", () => {
    const live = [makeThreadShellFixture()];
    expect(withSettledArchivedThreads(live, archive([]))).toBe(live);
  });
});
