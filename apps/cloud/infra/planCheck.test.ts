import { describe, expect, it } from "@effect/vitest";

import { readPlan } from "./planCheck.ts";

const line = (text: string) => `[12:00:00.000] INFO (#1): ${text}`;

describe("readPlan", () => {
  it("passes an adopting plan", () => {
    const report = readPlan(
      [
        line("Plan: 5 to adopted"),
        line("[Cloud] adopted"),
        line("[Cloud/PoolContainer] adopted"),
        line("[DrivePacks] adopted"),
        line("[ModelGateway] update"),
        line("[PreviewDrivePacks] noop"),
      ].join("\n"),
    );
    expect(report.summary).toBe("5 to adopted");
    expect(report.rows.map((row) => row.action)).toEqual([
      "adopted",
      "adopted",
      "adopted",
      "update",
      "noop",
    ]);
    expect(report.blocking).toEqual([]);
  });

  it("blocks anything that recreates or drops a resource", () => {
    const report = readPlan(
      [
        line("Plan: 1 to replace, 1 to delete, 1 to orphaned"),
        line("[Cloud] replace"),
        line("[DrivePacks] orphaned"),
        line("[OldWorker] delete"),
        line("[Cloud/USERS] unbind"),
      ].join("\n"),
    );
    expect(report.blocking).toEqual([
      { resource: "Cloud", action: "replace" },
      { resource: "DrivePacks", action: "orphaned" },
      { resource: "OldWorker", action: "delete" },
      { resource: "Cloud/USERS", action: "unbind" },
    ]);
  });

  it("has no summary when the dry run died", () => {
    expect(readPlan("Error: Cloudflare State store not found").summary).toBeNull();
  });

  it("ignores log lines that only look like rows", () => {
    expect(readPlan(line("Cloudflare Worker put: [object] creates")).rows).toEqual([]);
  });
});
