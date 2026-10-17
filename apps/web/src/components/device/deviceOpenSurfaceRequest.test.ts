import { DeviceId, LOCAL_DEVICE_HOST_ID, ThreadId, type DeviceSession } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { settleDeviceOpenForSurface } from "./deviceOpenSurfaceRequest";

const session: DeviceSession = {
  sessionId: "late-session",
  leaseId: "late-generation",
  ownerKind: "panel",
  threadId: ThreadId.make("thread-1"),
  hostId: LOCAL_DEVICE_HOST_ID,
  deviceId: DeviceId.make("emulator-5554"),
  platform: "android",
  openedAt: "2026-10-17T00:00:00.000Z",
};

describe("settleDeviceOpenForSurface", () => {
  it("releases a successful open that returns after its panel was cancelled", async () => {
    const controller = new AbortController();
    let resolveOpen: ((result: { _tag: "Success"; value: DeviceSession }) => void) | undefined;
    const open = vi.fn(
      (signal: AbortSignal) =>
        new Promise<{ _tag: "Success"; value: DeviceSession }>((resolve) => {
          resolveOpen = resolve;
          signal.addEventListener("abort", () => undefined, { once: true });
        }),
    );
    const release = vi.fn(async () => undefined);
    const accept = vi.fn();
    const request = settleDeviceOpenForSurface({
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
      open,
      release,
      accept,
    });

    controller.abort();
    if (!resolveOpen) throw new Error("Open request did not start.");
    resolveOpen({ _tag: "Success", value: session });
    await request;

    expect(open).toHaveBeenCalledWith(controller.signal);
    expect(release).toHaveBeenCalledWith(session);
    expect(accept).not.toHaveBeenCalled();
  });
});
