import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  type DesktopCapture,
  type DesktopPendingCapture,
} from "@t3tools/contracts";
import type { CaptureDestination } from "@t3tools/client-runtime/capture/destinations";
import { deliverDesktopCapture } from "./deliverDesktopCapture";
import type { DesktopCaptureBridge } from "./desktopCaptureBridge";

const destination: CaptureDestination = {
  key: "home",
  environmentId: EnvironmentId.make("environment"),
  ownerProjectId: ProjectId.make("project"),
  folderId: null,
  label: "Top level",
  detail: null,
  inPlace: "at the top level",
};
const capture: DesktopCapture = {
  id: "aabb",
  text: "Remember this",
  files: [],
  destinationKey: "home",
  capturedAt: 123,
  source: "quick-capture",
  open: false,
  deliveryError: null,
};
function bridgeFor(item: DesktopCapture) {
  const acknowledgeCapture = vi.fn(async () => undefined);
  const openCaptureMainWindow = vi.fn(async () => undefined);
  const bridge = {
    readCapture: vi.fn(async () => item),
    acknowledgeCapture,
    openCaptureMainWindow,
  } satisfies Pick<
    DesktopCaptureBridge,
    "readCapture" | "acknowledgeCapture" | "openCaptureMainWindow"
  >;
  return bridge;
}

function deliver(
  bridge: ReturnType<typeof bridgeFor>,
  pending: DesktopPendingCapture,
  save: Parameters<typeof deliverDesktopCapture>[3],
) {
  return deliverDesktopCapture(bridge, pending, [destination], save);
}

describe("desktop capture delivery", () => {
  it("keeps queue ownership until durable save resolves", async () => {
    let finish: ((saved: boolean) => void) | undefined;
    const persisted = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const bridge = bridgeFor(capture);
    const save = vi.fn(() => persisted);
    const delivery = deliver(bridge, capture, save);
    await Promise.resolve();
    expect(bridge.acknowledgeCapture).not.toHaveBeenCalled();
    finish!(true);
    await delivery;
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Remember this", destination }),
      {
        open: false,
        captureId: "aabb",
        requirePersistence: true,
        restoreOnFailure: false,
      },
    );
    expect(bridge.acknowledgeCapture).toHaveBeenCalledWith("aabb");
    expect(bridge.openCaptureMainWindow).not.toHaveBeenCalled();
  });

  it("does not acknowledge a failed persistence attempt and retries the same capture id", async () => {
    const bridge = bridgeFor(capture);
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(deliver(bridge, capture, save)).rejects.toThrow("still kept on this Mac");
    expect(bridge.acknowledgeCapture).not.toHaveBeenCalled();
    await deliver(bridge, capture, save);
    expect(save.mock.calls.map((call) => call[1].captureId)).toEqual(["aabb", "aabb"]);
    expect(bridge.acknowledgeCapture).toHaveBeenCalledTimes(1);
  });

  it("never silently changes a missing destination to the default", async () => {
    const bridge = bridgeFor(capture);
    const save = vi.fn(async () => true);
    await expect(deliver(bridge, { ...capture, destinationKey: "removed" }, save)).rejects.toThrow(
      "folder is unavailable",
    );
    expect(bridge.readCapture).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(bridge.acknowledgeCapture).not.toHaveBeenCalled();
  });

  it("reconstructs attached bytes and only reveals main for explicit Open draft", async () => {
    const opened = {
      ...capture,
      open: true,
      files: [
        {
          id: "ccee",
          name: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
          bytes: new Uint8Array([97, 98, 99]),
        },
      ],
    };
    const bridge = bridgeFor(opened);
    const save = vi.fn(
      async (input: Parameters<Parameters<typeof deliverDesktopCapture>[3]>[0]) => {
        expect(await input.files[0]!.file.text()).toBe("abc");
        expect(bridge.openCaptureMainWindow).not.toHaveBeenCalled();
        return true;
      },
    );
    await deliver(bridge, opened, save);
    expect(bridge.openCaptureMainWindow).toHaveBeenCalledTimes(1);
    expect(bridge.acknowledgeCapture).toHaveBeenCalledWith("aabb");
  });
});
