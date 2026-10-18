import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "./baseSchemas.ts";
import {
  DeviceId,
  LOCAL_DEVICE_HOST_ID,
  deviceSessionRequiresReadOnlyPanel,
  deviceToolInstallMessage,
} from "./device.ts";

describe("device tool install progress", () => {
  it("distinguishes a new install from an upgrade and chooses versions numerically", () => {
    expect(
      deviceToolInstallMessage("device hub", {
        requiredVersion: "0.11.0",
        installedVersions: [],
        runningVersion: null,
      }),
    ).toBe("Installing device hub 0.11.0…");
    expect(
      deviceToolInstallMessage("device hub", {
        requiredVersion: "0.11.0",
        installedVersions: ["0.9.0", "0.10.0"],
        runningVersion: null,
      }),
    ).toBe("Updating device hub from 0.10.0 to 0.11.0…");
  });
});

describe("device session panel ownership", () => {
  it("makes agent-owned and observer sessions read-only while keeping the panel owner interactive", () => {
    const session = {
      sessionId: "session",
      leaseId: "lease",
      threadId: ThreadId.make("thread"),
      hostId: LOCAL_DEVICE_HOST_ID,
      deviceId: DeviceId.make("emulator-5554"),
      platform: "android" as const,
      openedAt: "2026-10-17T00:00:00Z",
    };

    expect(deviceSessionRequiresReadOnlyPanel({ ...session, ownerKind: "panel" })).toBe(false);
    expect(
      deviceSessionRequiresReadOnlyPanel({ ...session, ownerKind: "panel", observer: true }),
    ).toBe(true);
    expect(deviceSessionRequiresReadOnlyPanel({ ...session, ownerKind: "agent" })).toBe(true);
  });
});
