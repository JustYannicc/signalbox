import { describe, expect, it } from "vite-plus/test";

import { diffSnapshots, everyMsOf, listOf, snapshotOf, sourceIdOf, watchCares } from "./watch.ts";

const watch = { operation: "github.actions.listWorkflowRunsForRepo", key: "id" } as const;

describe("sourceIdOf", () => {
  it("is one source per thing read, whatever fields and pace each watcher wants", () => {
    const base = sourceIdOf("project-1", { ...watch, args: { owner: "o", repo: "r" } });
    expect(
      sourceIdOf("project-1", {
        ...watch,
        args: { repo: "r", owner: "o" },
        fields: ["status"],
        every: { minutes: 1 },
      }),
    ).toBe(base);
    expect(sourceIdOf("project-2", { ...watch, args: { owner: "o", repo: "r" } })).not.toBe(base);
    expect(sourceIdOf("project-1", { ...watch, args: { owner: "o", repo: "x" } })).not.toBe(base);
    expect(
      sourceIdOf("project-1", { ...watch, args: { owner: "o", repo: "r" }, connection: "work" }),
    ).not.toBe(base);
  });
});

describe("listOf", () => {
  it("finds the list: at items, the answer itself, or its only list", () => {
    expect(listOf([1], undefined)).toEqual({ ok: true, list: [1] });
    expect(listOf({ total_count: 1, workflow_runs: [1] }, undefined)).toEqual({
      ok: true,
      list: [1],
    });
    expect(listOf({ data: { rows: [2] } }, "data.rows")).toEqual({ ok: true, list: [2] });
    expect(listOf({ a: [], b: [] }, undefined)).toMatchObject({ ok: false });
    expect(listOf({ a: 1 }, "a")).toMatchObject({ ok: false });
    // An MCP tool's result, as Executor passes it through.
    const mcp = {
      _meta: {},
      content: [{ type: "text", text: '{"issues":[{"number":1}],"totalCount":1}' }],
      structuredContent: { issues: [{ number: 1 }], totalCount: 1 },
    };
    expect(listOf(mcp, undefined)).toEqual({ ok: true, list: [{ number: 1 }] });
    expect(listOf({ ...mcp, structuredContent: undefined }, "issues")).toEqual({
      ok: true,
      list: [{ number: 1 }],
    });
  });
});

describe("diffSnapshots", () => {
  it("adds, changes with the fields that differ, and removes by key", () => {
    const before = snapshotOf(
      [
        { id: 1, status: "queued", updated_at: "1" },
        { id: 2, status: "done" },
      ],
      "id",
    );
    const after = snapshotOf(
      [
        { id: 3, status: "queued" },
        { id: 1, status: "in_progress", updated_at: "2" },
        { id: 3, status: "duplicate" },
        { name: "no key" },
      ],
      "id",
    );
    expect(diffSnapshots(before, after)).toEqual([
      { kind: "added", key: "3", item: { id: 3, status: "queued" } },
      {
        kind: "changed",
        key: "1",
        item: { id: 1, status: "in_progress", updated_at: "2" },
        before: { id: 1, status: "queued", updated_at: "1" },
        changed: ["status", "updated_at"],
      },
      { kind: "removed", key: "2", item: { id: 2, status: "done" } },
    ]);
    expect(diffSnapshots(after, after)).toEqual([]);
  });

  it("reaches into items with a dotted key", () => {
    expect(snapshotOf([{ meta: { uid: "a" } }], "meta.uid").map(([key]) => key)).toEqual(["a"]);
  });
});

describe("watchCares", () => {
  it("counts a change only when it touches the watch's fields", () => {
    expect(watchCares({ fields: ["status"] }, ["updated_at"])).toBe(false);
    expect(watchCares({ fields: ["status"] }, ["status", "updated_at"])).toBe(true);
    expect(watchCares({}, ["updated_at"])).toBe(true);
    expect(watchCares({ fields: ["status"] }, undefined)).toBe(true);
  });
});

it("checks at most once a minute, every 5 minutes by default", () => {
  expect(everyMsOf(watch)).toBe(5 * 60_000);
  expect(everyMsOf({ ...watch, every: { seconds: 5 } })).toBe(60_000);
  expect(everyMsOf({ ...watch, every: { minutes: 2 } })).toBe(120_000);
});
