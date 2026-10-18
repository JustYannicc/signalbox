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
import { environmentServerConfigsAtom } from "../../state/server";
import { useStartInFolder } from "../sidebar/folders/useStartInFolder";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  prepareCaptureAttachments,
  type CaptureFile,
  type PreparedCaptureAttachments,
} from "./captureAttachments";
import { seedCaptureDraft } from "./captureDraftSeeding";
import type { CaptureDestination } from "@t3tools/client-runtime/capture/destinations";
import { captureTitle } from "@t3tools/client-runtime/capture/text";
import { restoreQuickCapture } from "./quickCaptureStore";
import { captureAttachmentId, runCaptureOnce } from "./durableCapture";
import { saveCaptureDraftDurably } from "./durableCaptureDraft";
import {
  startCaptureUploadsAndPersistFiles,
  startOrRetryCaptureUpload,
} from "./captureUploadPersistence";

export interface Capture {
  readonly text: string;
  readonly files: ReadonlyArray<CaptureFile>;
  /** Null when no folders have loaded; the draft then starts in the default project. */
  readonly destination: CaptureDestination | null;
}

export interface SaveCaptureOptions {
  readonly open: boolean;
  readonly captureId?: string;
  readonly requirePersistence?: boolean;
  readonly restoreOnFailure?: boolean;
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
      startOrRetryCaptureUpload({ environmentId, image: attachment, draftTarget: draftId });
    }
  };

  const save = async (capture: Capture, options: SaveCaptureOptions): Promise<boolean> => {
    const text = capture.text.trim();
    const { destination } = capture;
    const requirePersistence = options.requirePersistence === true;
    const captureId = options.captureId?.trim();
    const restoreOnFailure = options.restoreOnFailure !== false;
    const restore = () => {
      if (restoreOnFailure) {
        restoreQuickCapture({ text: capture.text, files: capture.files, destination });
      }
    };
    if (requirePersistence && !captureId) {
      toastManager.add({ type: "error", title: "Capture id is required for durable saving" });
      restore();
      return false;
    }

    let prepared: PreparedCaptureAttachments;
    try {
      prepared = await prepareCaptureAttachments(
        capture.files,
        requirePersistence
          ? (file, kind, index) => captureAttachmentId(captureId!, file.id, kind, index)
          : undefined,
      );
    } catch {
      toastManager.add({ type: "error", title: "Couldn't prepare the capture" });
      restore();
      return false;
    }

    const environmentId = destination?.environmentId ?? defaultProjectRef?.environmentId ?? null;
    if (requirePersistence) {
      let result: Awaited<ReturnType<typeof saveCaptureDraftDurably>>;
      try {
        result = await saveCaptureDraftDurably({
          captureId: captureId!,
          text,
          prepared,
          createDraft: async (seedDraft) => {
            const opened = destination
              ? await startInFolder({
                  environmentId: destination.environmentId,
                  ownerProjectId: destination.ownerProjectId,
                  folderId: destination.folderId,
                  navigate: false,
                  seed: seedDraft,
                })
              : defaultProjectRef
                ? await handleNewThread(defaultProjectRef, {
                    freshDraft: true,
                    navigate: false,
                    seed: seedDraft,
                  })
                    .then((draft) => draft && { ...draft, filed: true })
                    .catch(() => null)
                : null;
            return opened ? { draftId: opened.draftId, filed: opened.filed } : null;
          },
          startUploadsAndPersistFiles: async (draftId, targetEnvironmentId) => {
            const capabilities = registry.get(environmentServerConfigsAtom).get(targetEnvironmentId)
              ?.environment.capabilities;
            const advertised = capabilities?.fileAttachments?.maxUploadBytes ?? null;
            return startCaptureUploadsAndPersistFiles({
              draftId,
              environmentId: targetEnvironmentId,
              files: prepared.files,
              uploadsSupported: capabilities?.attachmentUploads === true,
              maxFileBytes: advertised === null ? null : clampFileAttachmentUploadBytes(advertised),
            });
          },
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Capture is still queued",
          description:
            error instanceof Error ? error.message : "The durable draft could not be confirmed.",
        });
        restore();
        return false;
      }
      if (!result.ok || result.draftId === null) {
        toastManager.add({
          type: "error",
          title: "Capture is still queued",
          description:
            result.rejected.length > 0
              ? `Couldn't persist: ${result.rejected.join(", ")}`
              : "The draft or its attachments aren't durable yet.",
        });
        restore();
        return false;
      }
      if (!result.filed && destination) {
        toastManager.add({
          type: "warning",
          title: `Couldn't file it ${destination.inPlace}`,
          description:
            "The draft was saved. Use Move thread to folder… in the command palette to file it.",
        });
      }
      if (options.open) {
        await navigate({ to: "/draft/$draftId", params: { draftId: result.draftId } });
      } else {
        showSavedToast(result.draftId, text, result.filed ? destination : null, navigate);
      }
      return true;
    }

    let seeded: ReturnType<typeof seedCaptureDraft> | null = null;
    const seed = (draftId: DraftId) => {
      seeded = seedCaptureDraft(draftId, text, prepared);
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
    // Assigned inside the callback, which TypeScript can't follow.
    const filled = seeded as ReturnType<typeof seedCaptureDraft> | null;
    if (filled === null) {
      for (const { image } of prepared.images) URL.revokeObjectURL(image.previewUrl);
      toastManager.add({ type: "error", title: "Couldn't save the draft" });
      restore();
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

  return (capture: Capture, options: SaveCaptureOptions): Promise<boolean> => {
    const captureId = options.captureId?.trim();
    return options.requirePersistence === true && captureId
      ? runCaptureOnce(captureId, () => save(capture, options))
      : save(capture, options);
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
