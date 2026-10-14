import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./entities", () => ({
  useEnvironmentServerConfig: () => null,
  useServerConfigs: () => new Map(),
}));

import { anyEnvironmentSupports } from "./environmentCapabilities";

function config(capabilities: Partial<ExecutionEnvironmentCapabilities>) {
  return { environment: { capabilities: capabilities as ExecutionEnvironmentCapabilities } };
}

describe("anyEnvironmentSupports", () => {
  it("shows the control until an environment reports in", () => {
    expect(anyEnvironmentSupports([], "scheduledTasks")).toBe(true);
  });

  it("shows it while any environment can do it", () => {
    expect(
      anyEnvironmentSupports([config({ scheduledTasks: false }), config({})], "scheduledTasks"),
    ).toBe(true);
  });

  it("hides it when every environment turns it off", () => {
    expect(anyEnvironmentSupports([config({ scheduledTasks: false })], "scheduledTasks")).toBe(
      false,
    );
  });
});
