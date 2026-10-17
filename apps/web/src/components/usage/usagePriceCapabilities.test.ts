import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasWritableSelectedUsagePriceTarget,
  usagePriceCapabilityTargets,
} from "./usagePriceCapabilities";

const target = (id: string, serverSettingsWrite?: boolean) => ({
  environmentId: EnvironmentId.make(id),
  serverSettingsWrite,
});

describe("usage price capability gating", () => {
  it("hides editing when every selected environment rejects server settings writes", () => {
    expect(
      hasWritableSelectedUsagePriceTarget(
        [target("cloud", false)],
        new Set([EnvironmentId.make("cloud")]),
      ),
    ).toBe(false);
  });

  it("keeps the editor available for selected self-hosted environments with no capability field", () => {
    expect(hasWritableSelectedUsagePriceTarget([target("self-hosted")], null)).toBe(true);
  });

  it("considers only selected environments while allowing a writable target in a mixed selection", () => {
    const cloud = target("cloud", false);
    const selfHosted = target("self-hosted");
    expect(
      hasWritableSelectedUsagePriceTarget([cloud, selfHosted], new Set([cloud.environmentId])),
    ).toBe(false);
    expect(
      hasWritableSelectedUsagePriceTarget(
        [cloud, selfHosted],
        new Set([cloud.environmentId, selfHosted.environmentId]),
      ),
    ).toBe(true);
  });

  it("waits for an environment's config before offering price editing", () => {
    const cloud = EnvironmentId.make("cloud");
    const loading = usagePriceCapabilityTargets(new Map([[cloud, { serverConfig: null }]]));
    expect(hasWritableSelectedUsagePriceTarget(loading, null)).toBe(false);
    const legacy = usagePriceCapabilityTargets(new Map([[cloud, { serverConfig: {} }]]));
    expect(hasWritableSelectedUsagePriceTarget(legacy, null)).toBe(true);
  });
});
