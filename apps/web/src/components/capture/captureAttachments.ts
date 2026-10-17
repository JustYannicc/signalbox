/**
 * Files dropped or pasted into quick capture, turned into the draft's
 * attachments the way the composer would: supported images compressed under
 * the provider limit, everything else as a file. The draft's composer then
 * owns them, including upload and any send-time limits.
 */
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { videoMimeType } from "@t3tools/shared/video";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { prepareImageForAttachment, readFileAsDataUrl } from "../../lib/imageCompression";
import { randomUUID } from "../../lib/utils";
import {
  classifyComposerAttachmentFile,
  normalizeComposerImageFileMimeType,
} from "../chat/composerAttachmentFiles";

export interface CaptureFile {
  readonly id: string;
  readonly file: File;
}

export interface PreparedCaptureImage {
  readonly image: ComposerImageAttachment;
  /** What the draft persists, so the image survives a reload before the draft is opened. */
  readonly dataUrl: string;
}

export interface PreparedCaptureAttachments {
  readonly images: PreparedCaptureImage[];
  readonly files: ComposerFileAttachment[];
  /** Names that couldn't be attached. */
  readonly skipped: string[];
}

type Prepared =
  | { readonly kind: "image"; readonly image: PreparedCaptureImage }
  | { readonly kind: "file"; readonly file: ComposerFileAttachment }
  | { readonly kind: "skipped"; readonly name: string };

async function prepareOne(file: File): Promise<Prepared> {
  const kind = classifyComposerAttachmentFile(file);
  if (kind === "unsupported-image" || file.size <= 0) return { kind: "skipped", name: file.name };
  if (kind === "image") {
    const prepared = await prepareImageForAttachment(
      normalizeComposerImageFileMimeType(file),
      PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
    );
    if (!prepared.ok) return { kind: "skipped", name: file.name };
    const dataUrl = await readFileAsDataUrl(prepared.file).catch(() => null);
    if (dataUrl === null) return { kind: "skipped", name: file.name };
    return {
      kind: "image",
      image: {
        dataUrl,
        image: {
          type: "image",
          id: randomUUID(),
          name: prepared.file.name || "image",
          mimeType: prepared.file.type,
          sizeBytes: prepared.file.size,
          previewUrl: URL.createObjectURL(prepared.file),
          file: prepared.file,
        },
      },
    };
  }
  const mimeType =
    videoMimeType({ name: file.name, mimeType: file.type }) ??
    (file.type || "application/octet-stream");
  return {
    kind: "file",
    file: {
      type: "file",
      id: randomUUID(),
      name: file.name || "file",
      mimeType,
      sizeBytes: file.size,
      file:
        file.type === mimeType
          ? file
          : new File([file], file.name, { type: mimeType, lastModified: file.lastModified }),
    },
  };
}

export async function prepareCaptureAttachments(
  captured: ReadonlyArray<CaptureFile>,
): Promise<PreparedCaptureAttachments> {
  const prepared = await Promise.all(captured.map(({ file }) => prepareOne(file)));
  return {
    images: prepared.flatMap((entry) => (entry.kind === "image" ? [entry.image] : [])),
    files: prepared.flatMap((entry) => (entry.kind === "file" ? [entry.file] : [])),
    skipped: prepared.flatMap((entry) => (entry.kind === "skipped" ? [entry.name] : [])),
  };
}
