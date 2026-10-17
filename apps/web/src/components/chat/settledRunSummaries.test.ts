import { RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { settledRunSummaries } from "./settledRunSummaries";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const run = (id: string, status: "completed" | "interrupted" | "running", end: string | null) => ({
  id: RunId.make(id),
  status,
  startedAt: at("2026-01-01T00:00:00.000Z"),
  completedAt: end === null ? null : at(end),
});

describe("settledRunSummaries", () => {
  it("keeps each settled run's own status and times, and skips live runs", () => {
    const summaries = settledRunSummaries(
      [run("a", "interrupted", "2026-01-01T00:01:29.000Z"), run("b", "running", null)],
      null,
    );
    expect([...summaries.values()]).toEqual([
      {
        runId: "a",
        status: "interrupted",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:29.000Z",
      },
    ]);
  });

  it("returns the previous map while nothing settled changed", () => {
    const first = settledRunSummaries([run("a", "completed", "2026-01-01T00:00:10.000Z")], null);
    const same = settledRunSummaries(
      [run("a", "completed", "2026-01-01T00:00:10.000Z"), run("b", "running", null)],
      first,
    );
    expect(same).toBe(first);
    const changed = settledRunSummaries(
      [
        run("a", "completed", "2026-01-01T00:00:10.000Z"),
        run("b", "interrupted", "2026-01-01T00:00:20.000Z"),
      ],
      first,
    );
    expect(changed).not.toBe(first);
    expect(changed.size).toBe(2);
  });
});
