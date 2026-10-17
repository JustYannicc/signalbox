/**
 * Quick capture feeds drafts: whatever you write becomes an unsent draft in
 * the folder you tagged (your top level when untagged), the same draft a
 * folder's "+" opens. Saving never takes you anywhere; opening goes straight
 * to the draft page. Routing a capture to the assistant instead is #53.
 */
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useStartInFolder } from "../sidebar/folders/useStartInFolder";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  prepareCaptureAttachments,
  type CaptureFile,
  type PreparedCaptureAttachments,
} from "./captureAttachments";
import type { CaptureDestination } from "./captureDestinations";
import { captureTitle } from "./captureText";
import { restoreQuickCapture } from "./quickCaptureStore";

export interface Capture {
  readonly text: string;
  readonly files: ReadonlyArray<CaptureFile>;
  /** Null when no folders have loaded; the draft then starts in the default project. */
  readonly destination: CaptureDestination | null;
}

/**
 * Writes the capture into the draft the moment it exists, so it never sits
 * empty (an empty draft can be replaced and dropped) and the draft page opens
 * already filled. Returns the names the draft didn't take.
 */
function seedDraft(draftId: DraftId, text: string, prepared: PreparedCaptureAttachments) {
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
  if (persisted.length > 0) void store.syncPersistedAttachments(draftId, persisted);
  for (const image of images) {
    if (!acceptedImages.has(image.id)) URL.revokeObjectURL(image.previewUrl);
  }
  return [
    ...images.filter((image) => !acceptedImages.has(image.id)).map((image) => image.name),
    ...prepared.files.filter((file) => !acceptedFiles.has(file.id)).map((file) => file.name),
  ];
}

export function useSaveCapture() {
  const navigate = useNavigate();
  const startInFolder = useStartInFolder();
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();

  return useCallback(
    async (capture: Capture, options: { readonly open: boolean }): Promise<boolean> => {
      const text = capture.text.trim();
      const { destination } = capture;
      const prepared = await prepareCaptureAttachments(capture.files);
      let rejected: string[] = [];
      let seeded: DraftId | null = null;
      const seed = (draftId: DraftId) => {
        seeded = draftId;
        rejected = seedDraft(draftId, text, prepared);
      };
      const opened = destination
        ? await startInFolder({
            environmentId: destination.environmentId,
            ownerProjectId: destination.ownerProjectId,
            folderId: destination.folderId,
            navigate: options.open,
            seed,
          })
        : defaultProjectRef
          ? await handleNewThread(defaultProjectRef, {
              freshDraft: true,
              navigate: options.open,
              seed,
            })
              .then((draft) => draft && { ...draft, filed: true })
              .catch(() => null)
          : null;
      // Filled before a later step failed (opening it, filing it): it's saved, don't duplicate it.
      const saved = opened ?? (seeded === null ? null : { draftId: seeded, filed: false });
      if (saved === null) {
        for (const { image } of prepared.images) URL.revokeObjectURL(image.previewUrl);
        toastManager.add({ type: "error", title: "Couldn't save the draft" });
        // Nothing is lost: it reopens with what was written, files included.
        restoreQuickCapture({ text: capture.text, files: capture.files, destination });
        return false;
      }

      const notAttached = [...prepared.skipped, ...rejected];
      if (notAttached.length > 0) {
        toastManager.add({
          type: "warning",
          title:
            notAttached.length === 1 ? "A file wasn't attached" : "Some files weren't attached",
          description: notAttached.join(", "),
        });
      }
      if (!saved.filed && destination) {
        toastManager.add({
          type: "warning",
          title: `Couldn't file it ${destination.inPlace}`,
          description:
            "The draft was saved. Use Move thread to folder… in the command palette to file it.",
        });
      }
      if (!options.open) {
        showSavedToast(saved.draftId, text, saved.filed ? destination : null, navigate);
      }
      return true;
    },
    [defaultProjectRef, handleNewThread, navigate, startInFolder],
  );
}

function showSavedToast(
  draftId: DraftId,
  text: string,
  destination: CaptureDestination | null,
  navigate: ReturnType<typeof useNavigate>,
) {
  const title = captureTitle(text);
  const toastId = toastManager.add(
    stackedThreadToast({
      type: "success",
      title: destination ? `Saved to drafts ${destination.inPlace}` : "Saved to drafts",
      ...(title.length > 0 ? { description: title } : {}),
      actionProps: {
        children: "Open",
        onClick: () => {
          toastManager.close(toastId);
          void navigate({ to: "/draft/$draftId", params: { draftId } });
        },
      },
    }),
  );
}
