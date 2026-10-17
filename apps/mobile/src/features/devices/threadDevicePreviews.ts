import type { DeviceServiceState, DeviceSession, ThreadId } from "@t3tools/contracts";

/** Host identity is part of the selection because Android serials repeat across hosts. */
export function threadDevicePreviews(state: DeviceServiceState | null, threadId: ThreadId) {
  const sessionsByDevice = new Map<string, DeviceSession>();
  for (const session of state?.sessions ?? []) {
    if (session.threadId !== threadId) continue;
    const key = JSON.stringify([session.hostId, session.deviceId]);
    const current = sessionsByDevice.get(key);
    if (!current || (isPanelSession(session) && !isPanelSession(current))) {
      sessionsByDevice.set(key, session);
    }
  }
  return Array.from(sessionsByDevice, ([key, session]) => {
    const device = state?.devices.find(
      (device) => device.hostId === session.hostId && device.id === session.deviceId,
    );
    const host = state?.hosts.find((host) => host.id === session.hostId);
    return {
      key,
      session,
      name: device?.name ?? (session.platform === "ios" ? "iOS Simulator" : "Android Emulator"),
      description: [device?.version, host?.label].filter(Boolean).join(" · "),
    };
  });
}

const isPanelSession = (session: DeviceSession) =>
  "ownerKind" in session && session.ownerKind === "panel";

export type ThreadDevicePreview = ReturnType<typeof threadDevicePreviews>[number];

export function selectedThreadDevicePreview(
  previews: ReadonlyArray<ThreadDevicePreview>,
  selectedKey: string | null,
) {
  return previews.find((preview) => preview.key === selectedKey) ?? previews[0] ?? null;
}
