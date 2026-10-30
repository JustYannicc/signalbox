import type { CaptureDestination } from "@t3tools/client-runtime/capture/destinations";
import type { DesktopPendingCapture } from "@t3tools/contracts";
import type { DesktopCaptureBridge } from "./desktopCaptureBridge";
import type { useSaveCapture } from "./useSaveCapture";

export async function deliverDesktopCapture(
  bridge: Pick<
    DesktopCaptureBridge,
    "readCapture" | "acknowledgeCapture" | "openCaptureMainWindow"
  >,
  pending: DesktopPendingCapture,
  getDestinations: () => ReadonlyArray<CaptureDestination>,
  save: ReturnType<typeof useSaveCapture>,
) {
  const requireCurrentDestination = () => {
    const destination = getDestinations().find(
      (item) =>
        pending.destinationKey !== null &&
        item.key === pending.destinationKey &&
        pending.owner !== undefined &&
        item.environmentId === pending.owner.environmentId &&
        item.ownerProjectId === pending.owner.ownerProjectId,
    );
    if (!destination)
      throw new Error("The capture's folder is unavailable. Reconnect its environment to retry.");
    return destination;
  };
  requireCurrentDestination();
  const capture = await bridge.readCapture(pending.id);
  const destination = requireCurrentDestination();
  if (
    capture.id !== pending.id ||
    capture.destinationKey !== pending.destinationKey ||
    capture.owner?.environmentId !== pending.owner?.environmentId ||
    capture.owner?.ownerProjectId !== pending.owner?.ownerProjectId
  ) {
    throw new Error("The capture's folder is unavailable. Reconnect its environment to retry.");
  }
  const saved = await save(
    {
      text: capture.text,
      destination,
      files: capture.files.map((file) => ({
        id: file.id,
        file: new File([new Uint8Array(file.bytes)], file.name, {
          type: file.mimeType,
          lastModified: capture.capturedAt,
        }),
      })),
    },
    {
      open: capture.open,
      captureId: capture.id,
      requirePersistence: true,
      restoreOnFailure: false,
    },
  );
  if (!saved) throw new Error("Couldn't save the draft. Your capture is still kept on this Mac.");
  requireCurrentDestination();
  if (capture.open) {
    await bridge.openCaptureMainWindow();
    requireCurrentDestination();
  }
  await bridge.acknowledgeCapture(capture.id);
}
