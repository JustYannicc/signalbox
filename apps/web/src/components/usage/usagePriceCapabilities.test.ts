import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hasWritableSelectedUsagePriceTarget } from "./usagePriceCapabilities";

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
});
