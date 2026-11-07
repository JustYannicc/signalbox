import { describe, expect, it } from "vite-plus/test";
import { observeCommandInvocation, readCommandObservation } from "./commandObservation.ts";

describe("per-invocation command observation", () => {
  it("tags successive calls independently and restores exact original command fields", () => {
    const command = { argv: ["bash", "-c", "echo hello"], cwd: "/workspace", env: { LANG: "en" } };
    const second = observeCommandInvocation(command, "/turn/2/dispatch", "two");
    const third = observeCommandInvocation(command, "/turn/3/dispatch", "three");
    expect(readCommandObservation(second)).toEqual({
      command,
      call: { route: { method: "POST", path: "/turn/2/dispatch" }, invocationId: "two" },
    });
    expect(readCommandObservation(third)).toEqual({
      command,
      call: { route: { method: "POST", path: "/turn/3/dispatch" }, invocationId: "three" },
    });
    expect(Object.keys(command)).toEqual(["argv", "cwd", "env"]);
  });
  it("admits the Claude thread step's route and no retired Claude step route", () => {
    const command = { executable: "/bin/rg", argv: ["rg", "needle", "/workspace"] };
    const path = "/claude/thread/dispatch";
    expect(readCommandObservation(observeCommandInvocation(command, path, "rg-1"))).toEqual({
      command,
      call: { route: { method: "POST", path }, invocationId: "rg-1" },
    });
    for (const retired of [
      "/claude/baseline/turn/1/dispatch",
      "/claude/hooks/replace/dispatch",
      "/claude/thread/receipt",
    ])
      expect(() => observeCommandInvocation(command, retired, "invalid")).toThrow("invalid");
  });
  it("refuses missing metadata, collisions and undeclared routes", () => {
    expect(() => readCommandObservation({ argv: [] })).toThrow("missing");
    expect(() =>
      observeCommandInvocation({ __sb1070CommandObservation: {} }, "/turn/1/dispatch", "one"),
    ).toThrow();
    expect(() => observeCommandInvocation({}, "/turn/4/dispatch", "four")).toThrow();
    expect(() =>
      readCommandObservation({
        __sb1070CommandObservation: {
          invocationId: "three",
          route: { method: "GET", path: "/turn/3/dispatch" },
        },
      }),
    ).toThrow("invalid");
  });
});
