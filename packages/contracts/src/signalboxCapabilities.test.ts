import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ExecutionEnvironmentCapabilities } from "./environment.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";
import { environmentImportsFrom, environmentSupports } from "./signalboxCapabilities.ts";

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

const GITHUB = SourceControlProviderKind.make("github");
const GITLAB = SourceControlProviderKind.make("gitlab");

describe("environmentImportsFrom", () => {
  it("offers every host where the environment doesn't list them", () => {
    const capabilities = Schema.decodeSync(ExecutionEnvironmentCapabilities)({});
    expect(environmentImportsFrom(capabilities, GITLAB)).toBe(true);
    expect(environmentImportsFrom(null, GITLAB)).toBe(true);
  });

  it("offers only the hosts an environment imports from", () => {
    const capabilities = Schema.decodeSync(ExecutionEnvironmentCapabilities)({
      sourceControlImports: ["github"],
    });
    expect(environmentImportsFrom(capabilities, GITHUB)).toBe(true);
    expect(environmentImportsFrom(capabilities, GITLAB)).toBe(false);
  });
});
