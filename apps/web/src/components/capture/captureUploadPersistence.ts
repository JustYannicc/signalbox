import type { EnvironmentId } from "@t3tools/contracts";

import {
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
} from "../../composerDraftStore";
import {
  awaitAttachmentUploads,
  readAttachmentUpload,
  retryAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import type { PreparedCaptureAttachments } from "./captureAttachments";

export async function startCaptureUploadsAndPersistFiles(input: {
  readonly draftId: DraftId;
  readonly environmentId: EnvironmentId;
  readonly files: PreparedCaptureAttachments["files"];
  readonly uploadsSupported: boolean;
  readonly maxFileBytes: number | null;
}): Promise<boolean> {
  const draft = useComposerDraftStore.getState().getComposerDraft(input.draftId);
  if (!draft) return false;
  if (input.uploadsSupported) {
    for (const image of draft.images) {
      startOrRetryCaptureUpload({
        environmentId: input.environmentId,
        image,
        draftTarget: input.draftId,
      });
    }
  }
  if (input.files.length === 0) return true;
  const maxFileBytes = input.maxFileBytes;
  if (
    !input.uploadsSupported ||
    maxFileBytes === null ||
    input.files.some((file) => file.sizeBytes > maxFileBytes)
  ) {
    return false;
  }

  const uploads = input.files.map((file) => {
    const current = draft.files.find((candidate) => candidate.id === file.id);
    if (current?.uploadedAttachmentId && current.uploadEnvironmentId !== input.environmentId) {
      return null;
    }
    return current?.uploadedAttachmentId && current.uploadEnvironmentId
      ? {
          ...file,
          uploadedAttachmentId: current.uploadedAttachmentId,
          uploadEnvironmentId: current.uploadEnvironmentId,
        }
      : file;
  });
  if (uploads.some((file) => file === null)) return false;
  for (const file of uploads) {
    if (file === null) continue;
    startOrRetryCaptureUpload({
      environmentId: input.environmentId,
      image: file,
      draftTarget: input.draftId,
    });
  }
  await awaitAttachmentUploads(input.files.map((file) => file.id));

  const readyUploads = input.files.map((file) => readAttachmentUpload(file.id));
  if (
    readyUploads.some(
      (upload) => upload?.status !== "ready" || upload.environmentId !== input.environmentId,
    )
  ) {
    return false;
  }
  for (const [index, file] of input.files.entries()) {
    const upload = readyUploads[index];
    if (upload?.status === "ready") {
      useComposerDraftStore
        .getState()
        .setFileUpload(input.draftId, file.id, input.environmentId, upload.attachmentId);
    }
  }
  return true;
}

export function startOrRetryCaptureUpload(input: {
  readonly environmentId: EnvironmentId;
  readonly image: ComposerImageAttachment | ComposerFileAttachment;
  readonly draftTarget: DraftId;
}): void {
  const existing = readAttachmentUpload(input.image.id);
  const start =
    existing?.status === "failed" && existing.environmentId === input.environmentId
      ? retryAttachmentUpload
      : startAttachmentUpload;
  start(input);
}
