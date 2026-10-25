import { ProviderSessionId, ThreadId, type DeviceSession } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { agentDeviceSessionIdForPanelSession } from "./device.ts";

const baseSession = Object.assign(
  {
    threadId: ThreadId.make("thread-1"),
    hostId: "local",
    deviceId: "simulator-1",
    platform: "ios" as const,
    openedAt: "2026-10-17T00:00:00.000Z",
  },
  { sessionId: "base-session", leaseId: "lease-1", ownerKind: "panel" as const },
);

const panelSession = {
  ...baseSession,
  sessionId: "panel-session",
  leaseId: "lease-1",
  ownerKind: "panel" as const,
};

const agentSession = (
  values: Partial<{
    readonly leaseId: string;
    readonly threadId: DeviceSession["threadId"];
    readonly hostId: DeviceSession["hostId"];
    readonly deviceId: DeviceSession["deviceId"];
  }> = {},
) => ({
  ...baseSession,
  sessionId: "agent-session",
  leaseId: values.leaseId ?? "lease-1",
  ownerKind: "agent" as const,
  providerSessionId: ProviderSessionId.make("provider-session"),
  threadId: values.threadId ?? baseSession.threadId,
  hostId: values.hostId ?? baseSession.hostId,
  deviceId: values.deviceId ?? baseSession.deviceId,
});

describe("agent device diagnostics session lookup", () => {
  it("uses the agent session sharing the panel lease and device", () => {
    expect(
      agentDeviceSessionIdForPanelSession(panelSession, [
        agentSession({ leaseId: "other-lease" }),
        agentSession(),
      ]),
    ).toBe("agent-session");
  });

  it("does not match another lease or an unrelated device session", () => {
    expect(
      agentDeviceSessionIdForPanelSession(panelSession, [
        agentSession({ leaseId: "other-lease" }),
        agentSession({ deviceId: "simulator-2" }),
      ]),
    ).toBeNull();
  });

  it("uses an agent session directly", () => {
    expect(agentDeviceSessionIdForPanelSession(agentSession(), [panelSession])).toBe(
      "agent-session",
    );
  });
});
