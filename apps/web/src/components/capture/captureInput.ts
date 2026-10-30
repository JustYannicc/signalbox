import type { CaptureDestination } from "@t3tools/client-runtime/capture/destinations";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@t3tools/contracts";

export class CaptureDestinationUnavailableError extends Error {
  constructor() {
    super("This capture's folder is unavailable. Reconnect its account or pick a folder to save.");
    this.name = "CaptureDestinationUnavailableError";
  }
}

export function captureDefaultDestination(
  current: CaptureDestination | null,
  destinations: ReadonlyArray<CaptureDestination>,
): CaptureDestination | null {
  return current ?? destinations[0] ?? null;
}

export function captureDestinationAvailable(
  destination: CaptureDestination | null,
  destinations: ReadonlyArray<CaptureDestination>,
): boolean {
  return (
    destination !== null &&
    destinations.some(
      (current) =>
        current.key === destination.key &&
        current.environmentId === destination.environmentId &&
        current.ownerProjectId === destination.ownerProjectId &&
        current.folderId === destination.folderId,
    )
  );
}

export function selectCaptureFiles<T extends Pick<File, "name" | "size">>(
  incoming: ReadonlyArray<T>,
  existingCount: number,
): { files: T[]; message: string | null } {
  const valid: T[] = [];
  const rejected: string[] = [];
  for (const file of incoming) {
    if (file.size === 0) rejected.push(`${file.name} is empty.`);
    else if (file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES)
      rejected.push(
        `${file.name} is too large. Files must be ${formatAttachmentSize(PROVIDER_SEND_TURN_MAX_FILE_BYTES)} or smaller.`,
      );
    else valid.push(file);
  }
  const room = Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - existingCount);
  if (valid.length > room)
    rejected.push(`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files.`);
  return { files: valid.slice(0, room), message: rejected.length ? rejected.join(" ") : null };
}
