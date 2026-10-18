/**
 * Quick capture feeds drafts: whatever you write becomes an unsent draft in
 * the folder you tagged (your top level when untagged), the same draft a
 * folder's "+" opens. Saving never takes you anywhere; opening goes straight
 * to the draft page. Routing a capture to the assistant instead is #53.
 */
import { RegistryContext } from "@effect/atom-react";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useContext } from "react";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { startAttachmentUpload } from "../../lib/attachmentUploadQueue";
import { environmentServerConfigsAtom } from "../../state/server";
import { useStartInFolder } from "../sidebar/folders/useStartInFolder";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  prepareCaptureAttachments,
  type CaptureFile,
  type PreparedCaptureAttachments,
} from "./captureAttachments";
import type { CaptureDestination } from "@t3tools/client-runtime/capture/destinations";
import { captureTitle } from "@t3tools/client-runtime/capture/text";
import { restoreQuickCapture } from "./quickCaptureStore";

export interface Capture {
  readonly text: string;
  readonly files: ReadonlyArray<CaptureFile>;
  /** Null when no folders have loaded; the draft then starts in the default project. */
  readonly destination: CaptureDestination | null;
}

interface Seeded {
  readonly draftId: DraftId;
  /** Names the draft didn't take. */
  readonly rejected: ReadonlyArray<string>;
  readonly acceptedImageIds: ReadonlyArray<string>;
  readonly persisting: Promise<void>;
}

/**
 * Fills a fresh draft with everything at once, the moment it exists: it never
 * sits empty (an empty draft can be replaced), opens already filled, and
 * nothing arrives late to race with what the user does next.
 */
function seedDraft(draftId: DraftId, text: string, prepared: PreparedCaptureAttachments): Seeded {
  const store = useComposerDraftStore.getState();
  if (text.length > 0) store.setPrompt(draftId, text);
  const images = prepared.images.map((entry) => entry.image);
  const acceptedImages = new Set(images.length > 0 ? store.addImages(draftId, images) : []);
  const acceptedFiles = new Set(
    prepared.files.length > 0
      ? store.addFiles(draftId, prepared.files, { appendReference: true })
      : [],
  );
  // A fresh draft has no persisted images yet, so this list is all of them.
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

export function useSaveCapture() {
  const navigate = useNavigate();
  const registry = useContext(RegistryContext);
  const startInFolder = useStartInFolder();
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();

  /** Starts the uploads an ordinary draft's composer would, so attachments outlive a reload. */
  const startUploads = (environmentId: EnvironmentId, draftId: DraftId) => {
    const capabilities = registry.get(environmentServerConfigsAtom).get(environmentId)
      ?.environment.capabilities;
    if (capabilities?.attachmentUploads !== true) return;
    const advertised = capabilities.fileAttachments?.maxUploadBytes ?? null;
    const maxFileBytes = advertised === null ? null : clampFileAttachmentUploadBytes(advertised);
    const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
    if (!draft) return;
    const files =
      maxFileBytes === null ? [] : draft.files.filter((file) => file.sizeBytes <= maxFileBytes);
    for (const attachment of [...draft.images, ...files]) {
      startAttachmentUpload({ environmentId, image: attachment, draftTarget: draftId });
    }
  };

  return async (capture: Capture, options: { readonly open: boolean }): Promise<boolean> => {
    const text = capture.text.trim();
    const { destination } = capture;
    const prepared = await prepareCaptureAttachments(capture.files);
    let seeded: Seeded | null = null;
    const seed = (draftId: DraftId) => {
      seeded = seedDraft(draftId, text, prepared);
    };
    const environmentId = destination?.environmentId ?? defaultProjectRef?.environmentId ?? null;
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
    // Assigned inside the callback, which TypeScript can't follow.
    const filled = seeded as Seeded | null;
    if (filled === null) {
      for (const { image } of prepared.images) URL.revokeObjectURL(image.previewUrl);
      toastManager.add({ type: "error", title: "Couldn't save the draft" });
      // Nothing is lost: it reopens with what was written, files included.
      restoreQuickCapture({ text: capture.text, files: capture.files, destination });
      return false;
    }
    // A draft filled before a later step failed (opening it, filing it) is saved, not retried.
    const filed = opened?.filed ?? false;
    if (environmentId !== null) startUploads(environmentId, filled.draftId);

    const notAttached = [...prepared.skipped, ...filled.rejected];
    if (notAttached.length > 0) {
      toastManager.add({
        type: "warning",
        title: notAttached.length === 1 ? "A file wasn't attached" : "Some files weren't attached",
        description: notAttached.join(", "),
      });
    }
    if (!filed && destination) {
      toastManager.add({
        type: "warning",
        title: `Couldn't file it ${destination.inPlace}`,
        description:
          "The draft was saved. Use Move thread to folder… in the command palette to file it.",
      });
    }
    if (!options.open) {
      showSavedToast(filled.draftId, text, filed ? destination : null, navigate);
    }
    await filled.persisting.catch(() => undefined);
    const notPersisted = new Set(
      useComposerDraftStore.getState().getComposerDraft(filled.draftId)?.nonPersistedImageIds ?? [],
    );
    if (filled.acceptedImageIds.some((id) => notPersisted.has(id))) {
      toastManager.add({
        type: "warning",
        title: "Images in this draft won't survive a reload",
        description: "The browser's storage is full. Open the draft and send it to keep them.",
      });
    }
    return true;
  };
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
