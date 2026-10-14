import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ExecutionEnvironmentCapabilities } from "./environment.ts";
import { environmentSupports } from "./signalboxCapabilities.ts";

describe("environmentSupports", () => {
  it("treats servers that never send a capability as supporting it", () => {
    const capabilities = Schema.decodeSync(ExecutionEnvironmentCapabilities)({});
    expect(environmentSupports(capabilities, "terminal")).toBe(true);
    expect(environmentSupports(null, "worktrees")).toBe(true);
  });

  it("hides only what an environment rules out", () => {
    const capabilities = Schema.decodeSync(ExecutionEnvironmentCapabilities)({
      terminal: false,
      devices: true,
    });
    expect(environmentSupports(capabilities, "terminal")).toBe(false);
    expect(environmentSupports(capabilities, "devices")).toBe(true);
    expect(environmentSupports(capabilities, "scheduledTasks")).toBe(true);
  });
});
