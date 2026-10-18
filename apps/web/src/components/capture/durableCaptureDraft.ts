import type { EnvironmentId } from "@t3tools/contracts";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { stripInlineContextReferences } from "../../lib/composerContextReferences";
import type { PreparedCaptureAttachments } from "./captureAttachments";
import {
  completeCaptureDraftReceipt,
  isPersistedCaptureDraftAbsent,
  readCaptureDraftReceipt,
  readPersistedCaptureDraft,
  reserveCaptureDraftReceipt,
  updateReservedCaptureDraftReceipt,
  verifyPersistedCaptureDraft,
  type CaptureReceiptStorage,
} from "./durableCapture";

export interface DurableCaptureDraftResult {
  readonly ok: boolean;
  readonly draftId: DraftId | null;
  readonly filed: boolean;
  readonly rejected: ReadonlyArray<string>;
}

export interface DurableCaptureDraftInput {
  readonly captureId: string;
  readonly text: string;
  readonly prepared: PreparedCaptureAttachments;
  readonly receiptStorage?: CaptureReceiptStorage;
  readonly createDraft: (seedDraft: (draftId: DraftId) => void) => Promise<{
    readonly draftId: DraftId;
    readonly filed: boolean;
  } | null>;
  readonly startUploadsAndPersistFiles: (
    draftId: DraftId,
    environmentId: EnvironmentId,
  ) => Promise<boolean>;
}

/** Keeps a disk-queued capture attached to one draft until its browser receipt is complete. */
export function saveCaptureDraftDurably(
  input: DurableCaptureDraftInput,
): Promise<DurableCaptureDraftResult> {
  return saveCaptureDraftOnce(input);
}

async function saveCaptureDraftOnce(
  input: DurableCaptureDraftInput,
): Promise<DurableCaptureDraftResult> {
  const { captureId, text, prepared } = input;
  const receipt = readCaptureDraftReceipt(captureId, input.receiptStorage);
  if (receipt?.phase === "completed") {
    for (const { image } of prepared.images) URL.revokeObjectURL(image.previewUrl);
    return {
      ok: true,
      draftId: DraftId.make(receipt.draftId),
      filed: receipt.filed,
      rejected: [],
    };
  }
  const store = useComposerDraftStore.getState();
  let draftId = receipt?.draftId ?? null;
  let filed = receipt?.filed ?? true;
  let evictedDraftId: string | null = null;
  let seeded: SeededCapture | null = null;

  if (draftId !== null) {
    const target = DraftId.make(draftId);
    const presentInStore =
      store.getDraftSession(target) !== null || store.getComposerDraft(target) !== null;
    if (!presentInStore && isPersistedCaptureDraftAbsent(draftId, input.receiptStorage)) {
      evictedDraftId = draftId;
      draftId = null;
    }
  }

  if (draftId === null) {
    let seedError: unknown;
    let callbackDraftId: DraftId | null = null;
    const seededDraft: { value: SeededCapture | null } = { value: null };
    let created: Awaited<ReturnType<DurableCaptureDraftInput["createDraft"]>>;
    try {
      created = await input.createDraft((createdDraftId) => {
        if (callbackDraftId !== null && callbackDraftId !== createdDraftId) {
          throw new Error("The capture draft changed while it was being created");
        }
        callbackDraftId = createdDraftId;
        const reservation =
          evictedDraftId === null
            ? reserveCaptureDraftReceipt(captureId, createdDraftId, true, input.receiptStorage)
            : updateReservedCaptureDraftReceipt(
                captureId,
                evictedDraftId,
                createdDraftId,
                filed,
                input.receiptStorage,
              );
        draftId = reservation.draftId;
        filed = reservation.filed;
        if (reservation.phase === "completed" || reservation.draftId !== createdDraftId) return;
        try {
          seededDraft.value = seedCapture(createdDraftId, text, prepared);
        } catch (error) {
          seedError = error;
          throw error;
        }
      });
    } catch (error) {
      failed(draftId, prepared, filed);
      throw error;
    }
    const latest = readCaptureDraftReceipt(captureId, input.receiptStorage);
    if (latest?.phase === "completed") {
      releaseUnownedImages(latest.draftId, prepared);
      return {
        ok: true,
        draftId: DraftId.make(latest.draftId),
        filed: latest.filed,
        rejected: [],
      };
    }
    if (created === null) {
      if (seedError !== undefined) {
        failed(draftId, prepared, filed);
        throw seedError;
      }
      return failed(draftId, prepared, filed);
    }
    if (callbackDraftId !== created.draftId || draftId !== created.draftId) {
      return failed(draftId, prepared, filed);
    }
    if (seedError !== undefined) {
      failed(draftId, prepared, filed);
      throw seedError;
    }
    seeded = seededDraft.value;
    if (seeded === null) return failed(draftId, prepared, filed);

    const reservation = updateReservedCaptureDraftReceipt(
      captureId,
      created.draftId,
      created.draftId,
      created.filed,
      input.receiptStorage,
    );
    if (reservation.phase === "completed") {
      releaseUnownedImages(reservation.draftId, prepared);
      return {
        ok: true,
        draftId: DraftId.make(reservation.draftId),
        filed: reservation.filed,
        rejected: [],
      };
    }
    filed = reservation.filed;

    // Flush the session and its initial content before this capture can be acknowledged.
    const initialDraft = store.getComposerDraft(created.draftId);
    await store.syncPersistedAttachments(created.draftId, initialDraft?.persistedAttachments ?? []);
    if (!readPersistedCaptureDraft(created.draftId, input.receiptStorage)?.hasSession) {
      return failed(created.draftId, prepared, filed);
    }
    if (seeded.rejected.length > 0 || prepared.skipped.length > 0) {
      return failed(created.draftId, prepared, filed, [...prepared.skipped, ...seeded.rejected]);
    }
  } else {
    const target = DraftId.make(draftId);
    const session = store.getDraftSession(target);
    if (!session) return failed(target, prepared, filed);

    try {
      seeded = seedCapture(target, text, prepared);
    } catch (error) {
      failed(target, prepared, filed);
      throw error;
    }
    if (seeded.rejected.length > 0 || prepared.skipped.length > 0) {
      return failed(target, prepared, filed, [...prepared.skipped, ...seeded.rejected]);
    }
    const reservedDraft = store.getComposerDraft(target);
    await store.syncPersistedAttachments(target, reservedDraft?.persistedAttachments ?? []);
  }

  if (draftId === null) return failed(null, prepared, filed);
  const target = DraftId.make(draftId);
  const session = store.getDraftSession(target);
  if (!session || !readPersistedCaptureDraft(draftId, input.receiptStorage)?.hasSession) {
    return failed(target, prepared, filed);
  }

  if (seeded === null) return failed(target, prepared, filed);

  const environmentId = session.environmentId;
  if (!(await input.startUploadsAndPersistFiles(target, environmentId))) {
    return failed(target, prepared, filed);
  }

  const current = useComposerDraftStore.getState().getComposerDraft(target);
  if (!current) return failed(target, prepared, filed);
  const captureImageIds = new Set(prepared.images.map(({ image }) => image.id));
  const persistedImages = [
    ...current.persistedAttachments.filter((image) => !captureImageIds.has(image.id)),
    ...prepared.images.map(({ image, dataUrl }) => ({
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl,
    })),
  ];
  await useComposerDraftStore.getState().syncPersistedAttachments(target, persistedImages);

  const persistedDraft = useComposerDraftStore.getState().getComposerDraft(target);
  if (!persistedDraft || persistedDraft.prompt !== seeded.prompt) {
    return failed(target, prepared, filed);
  }
  const files = prepared.files.map((file) => {
    const persisted = persistedDraft.files.find((candidate) => candidate.id === file.id);
    return {
      id: file.id,
      environmentId: persisted?.uploadEnvironmentId ?? "",
      attachmentId: persisted?.uploadedAttachmentId ?? "",
    };
  });
  const ok = verifyPersistedCaptureDraft({
    draftId: target,
    prompt: seeded.prompt,
    images: prepared.images.map(({ image, dataUrl }) => ({
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl,
    })),
    files,
  });
  if (!ok) return failed(target, prepared, filed);
  const completed = completeCaptureDraftReceipt(captureId, target, input.receiptStorage);
  releaseUnownedImages(target, prepared);
  return { ok: true, draftId: target, filed: completed.filed, rejected: [] };
}

interface SeededCapture {
  readonly prompt: string;
  readonly rejected: ReadonlyArray<string>;
}

function seedCapture(
  draftId: DraftId,
  text: string,
  prepared: PreparedCaptureAttachments,
): SeededCapture {
  const store = useComposerDraftStore.getState();
  const existing = store.getComposerDraft(draftId);
  const cleanExistingPrompt = stripInlineContextReferences(existing?.prompt ?? "").trim();
  if (existing?.prompt.trim() && existing.prompt !== text && cleanExistingPrompt !== text) {
    throw new Error("The capture draft has changed since it was queued");
  }

  const existingImages = new Map((existing?.images ?? []).map((image) => [image.id, image]));
  for (const { image } of prepared.images) {
    const current = existingImages.get(image.id);
    if (
      current &&
      (current.name !== image.name ||
        current.mimeType !== image.mimeType ||
        current.sizeBytes !== image.sizeBytes)
    ) {
      throw new Error("The capture image id already belongs to another image");
    }
  }
  const existingFiles = new Map((existing?.files ?? []).map((file) => [file.id, file]));
  for (const file of prepared.files) {
    const current = existingFiles.get(file.id);
    if (
      current &&
      (current.name !== file.name ||
        current.mimeType !== file.mimeType ||
        current.sizeBytes !== file.sizeBytes)
    ) {
      throw new Error("The capture file id already belongs to another file");
    }
  }

  if (text.length > 0 && !existing?.prompt) store.setPrompt(draftId, text);
  const newImages = prepared.images
    .map(({ image }) => image)
    .filter((image) => !existingImages.has(image.id));
  if (newImages.length > 0) store.addImages(draftId, newImages);

  const filesById = new Map(existingFiles);
  for (const file of prepared.files) {
    const current = filesById.get(file.id);
    if (current && current.file === null && !current.uploadedAttachmentId) {
      store.removeFile(draftId, current.id);
      filesById.delete(current.id);
    }
  }
  const newFiles = prepared.files.filter((file) => !filesById.has(file.id));
  if (newFiles.length > 0) store.addFiles(draftId, [...newFiles], { appendReference: true });

  const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
  const presentImages = new Set(draft?.images.map((image) => image.id) ?? []);
  const presentFiles = new Set(draft?.files.map((file) => file.id) ?? []);
  const rejected = [
    ...prepared.images
      .filter(({ image }) => !presentImages.has(image.id))
      .map(({ image }) => image.name),
    ...prepared.files.filter((file) => !presentFiles.has(file.id)).map((file) => file.name),
  ];
  return { prompt: draft?.prompt ?? "", rejected };
}

function failed(
  draftId: DraftId | null,
  prepared: PreparedCaptureAttachments,
  filed = true,
  rejected: ReadonlyArray<string> = prepared.skipped,
): DurableCaptureDraftResult {
  releaseUnownedImages(draftId, prepared);
  return { ok: false, draftId, filed, rejected };
}

function releaseUnownedImages(
  draftId: string | DraftId | null,
  prepared: PreparedCaptureAttachments,
): void {
  const storedImages = draftId
    ? new Map(
        (
          useComposerDraftStore.getState().getComposerDraft(DraftId.make(draftId))?.images ?? []
        ).map((image) => [image.id, image.previewUrl]),
      )
    : new Map<string, string>();
  for (const { image } of prepared.images) {
    if (storedImages.get(image.id) !== image.previewUrl) URL.revokeObjectURL(image.previewUrl);
  }
}
