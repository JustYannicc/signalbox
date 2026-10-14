import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { targetsSupporting } from "./signalboxSettingsTargets";

function target(id: string, capabilities: Partial<ExecutionEnvironmentCapabilities>) {
  return {
    id,
    serverConfig: {
      environment: { capabilities: capabilities as ExecutionEnvironmentCapabilities },
    },
  };
}

describe("targetsSupporting", () => {
  it("keeps self-hosted servers and drops the ones that turn the area off", () => {
    const selfHosted = target("self-hosted", {});
    const cloud = target("cloud", { serverSettingsWrite: false, scheduledTasks: false });
    const mixed = target("mixed", { serverSettingsWrite: false, scheduledTasks: true });

    expect(targetsSupporting([selfHosted, cloud, mixed], "serverSettingsWrite")).toEqual([
      selfHosted,
    ]);
    expect(targetsSupporting([selfHosted, cloud, mixed], "scheduledTasks")).toEqual([
      selfHosted,
      mixed,
    ]);
  });
});
