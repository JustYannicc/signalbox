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
  destinations: ReadonlyArray<CaptureDestination>,
  save: ReturnType<typeof useSaveCapture>,
) {
  const destination =
    pending.destinationKey === null
      ? destinations[0]
      : destinations.find((item) => item.key === pending.destinationKey);
  if (!destination)
    throw new Error("The capture's folder is unavailable. Reconnect its environment to retry.");
  const capture = await bridge.readCapture(pending.id);
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
  if (capture.open) await bridge.openCaptureMainWindow();
  await bridge.acknowledgeCapture(capture.id);
}
