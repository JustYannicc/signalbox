import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import type { PreparedCaptureAttachments } from "./captureAttachments";

export interface SeededCaptureDraft {
  readonly draftId: DraftId;
  /** Names the draft didn't take. */
  readonly rejected: ReadonlyArray<string>;
  readonly acceptedImageIds: ReadonlyArray<string>;
  readonly persisting: Promise<void>;
}

/** Fills a fresh draft before it can open or be replaced. */
export function seedCaptureDraft(
  draftId: DraftId,
  text: string,
  prepared: PreparedCaptureAttachments,
): SeededCaptureDraft {
  const store = useComposerDraftStore.getState();
  if (text.length > 0) store.setPrompt(draftId, text);
  const images = prepared.images.map((entry) => entry.image);
  const acceptedImages = new Set(images.length > 0 ? store.addImages(draftId, images) : []);
  const acceptedFiles = new Set(
    prepared.files.length > 0
      ? store.addFiles(draftId, prepared.files, { appendReference: true })
      : [],
  );
  const persisted = prepared.images.flatMap(({ image, dataUrl }) =>
    acceptedImages.has(image.id)
      ? [
          {
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl,
          },
        ]
      : [],
  );
  const persisting =
    persisted.length > 0 ? store.syncPersistedAttachments(draftId, persisted) : Promise.resolve();
  for (const image of images) {
    if (!acceptedImages.has(image.id)) URL.revokeObjectURL(image.previewUrl);
  }
  return {
    draftId,
    rejected: [
      ...images.filter((image) => !acceptedImages.has(image.id)).map((image) => image.name),
      ...prepared.files.filter((file) => !acceptedFiles.has(file.id)).map((file) => file.name),
    ],
    acceptedImageIds: [...acceptedImages],
    persisting,
  };
}
