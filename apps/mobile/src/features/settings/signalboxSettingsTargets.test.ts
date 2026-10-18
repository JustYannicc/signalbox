import type { ExecutionEnvironmentCapabilities } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  targetsSupporting,
  targetsWithProviderAccounts,
  targetsWithRepositoryIdentity,
} from "./signalboxSettingsTargets";

function target(id: string, capabilities: Partial<ExecutionEnvironmentCapabilities>) {
  return {
    id,
    serverConfig: {
      environment: { capabilities: capabilities as ExecutionEnvironmentCapabilities },
    },
  };
}

function repositoryTarget(id: string, repositoryIdentity: boolean) {
  return {
    id,
    serverConfig: {
      environment: {
        capabilities: { repositoryIdentity } as ExecutionEnvironmentCapabilities,
      },
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

describe("targetsWithRepositoryIdentity", () => {
  it("keeps self-hosted environments and drops Cloud", () => {
    const selfHosted = repositoryTarget("self-hosted", true);
    const cloud = repositoryTarget("cloud", false);

    expect(targetsWithRepositoryIdentity([selfHosted, cloud])).toEqual([selfHosted]);
  });
});

describe("targetsWithProviderAccounts", () => {
  it("keeps only targets with an installed ACP agent to sign in", () => {
    const [cloud, idle, acp] = [
      { environmentId: "cloud" },
      { environmentId: "idle" },
      { environmentId: "acp" },
    ];
    const providers = new Map([
      ["cloud", [{ driver: "codex", installed: true }]],
      ["idle", [{ driver: "acpRegistry", installed: false }]],
      ["acp", [{ driver: "acpRegistry", installed: true }]],
    ]);

    expect(targetsWithProviderAccounts([cloud, idle, acp], providers)).toEqual([acp]);
  });
});
