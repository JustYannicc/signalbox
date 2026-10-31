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
  it("keeps Claude variant and workload phase distinct on cached command workers", () => {
    const command = { executable: "bash", argv: ["bash", "-c", "echo qualification"] };
    for (const variant of ["baseline", "hooks"]) {
      for (const phase of ["turn/1", "replace", "turn/2", "turn/3", "finish"]) {
        const path = `/claude/${variant}/${phase}/dispatch`;
        expect(readCommandObservation(observeCommandInvocation(command, path, path))).toEqual({
          command,
          call: { route: { method: "POST", path }, invocationId: path },
        });
      }
    }
    for (const path of [
      "/claude/other/work/dispatch",
      "/claude/baseline/unknown/dispatch",
      "/claude/hooks/work/receipt",
    ])
      expect(() => observeCommandInvocation(command, path, "invalid")).toThrow("invalid");
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
