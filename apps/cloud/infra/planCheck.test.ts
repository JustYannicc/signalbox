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

  it("blocks changing an existing infrastructure binding's target", () => {
    const report = readPlan(
      [
        line("Plan: 1 to update, 4 binding changes"),
        line("[Cloud] update"),
        line("[Cloud/DRIVE_PACKS] update"),
        line("[Cloud/POOLS] update"),
        line("[PoolContainer/POOLS] update"),
        line("[ModelGateway/GRANTS] update"),
      ].join("\n"),
    );
    expect(report.blocking.map((row) => row.resource)).toEqual([
      "Cloud/DRIVE_PACKS",
      "Cloud/POOLS",
      "PoolContainer/POOLS",
      "ModelGateway/GRANTS",
    ]);
  });

  it("allows additive infrastructure bindings and ordinary secret updates", () => {
    const report = readPlan(
      [
        line("Plan: 1 to update, 2 binding changes"),
        line("[Cloud] update"),
        line("[Cloud/DRIVE_PACKS] create"),
        line("[Cloud/BOAT_API_KEY] update"),
      ].join("\n"),
    );
    expect(report.blocking).toEqual([]);
  });

  it("recognizes explicit destroy and rebind actions as unsafe", () => {
    const report = readPlan(
      [
        line("Plan: 1 to destroy, 1 to rebind"),
        line("[Cloud] destroy"),
        line("[Cloud/POOLS] rebind"),
      ].join("\n"),
    );
    expect(report.blocking.map((row) => row.action)).toEqual(["destroy", "rebind"]);
  });

  it("blocks updating a runner snapshot's artifact under its existing name", () => {
    expect(readPlan(line("[BoatRunnerSnapshot] update")).blocking).toEqual([
      { resource: "BoatRunnerSnapshot", action: "update" },
    ]);
    expect(readPlan(line("[BoatRunnerSnapshot] create")).blocking).toEqual([]);
  });

  it("ignores log lines that only look like rows", () => {
    expect(readPlan(line("Cloudflare Worker put: [object] creates")).rows).toEqual([]);
  });
});
