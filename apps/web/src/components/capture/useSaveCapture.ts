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
import { prepareCaptureAttachments, type CaptureFile } from "./captureAttachments";
import type { CaptureDestination } from "./captureDestinations";
import { captureTitle } from "./captureText";
import { openQuickCapture } from "./quickCaptureStore";

export interface Capture {
  readonly text: string;
  readonly files: ReadonlyArray<CaptureFile>;
  /** Null when no folders have loaded; the draft then starts in the default project. */
  readonly destination: CaptureDestination | null;
}

export function useSaveCapture() {
  const navigate = useNavigate();
  const startInFolder = useStartInFolder();
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();

  return useCallback(
    async (capture: Capture, options: { readonly open: boolean }): Promise<boolean> => {
      const text = capture.text.trim();
      const { destination } = capture;
      const [opened, attachments] = await Promise.all([
        destination
          ? startInFolder({
              environmentId: destination.environmentId,
              ownerProjectId: destination.ownerProjectId,
              folderId: destination.folderId,
              navigate: options.open,
            })
          : defaultProjectRef
            ? handleNewThread(defaultProjectRef, {
                freshDraft: true,
                navigate: options.open,
              }).catch(() => null)
            : Promise.resolve(null),
        prepareCaptureAttachments(capture.files),
      ]);
      const { images, files, skipped } = attachments;
      if (opened === null) {
        for (const image of images) URL.revokeObjectURL(image.previewUrl);
        // Nothing is lost: it reopens with what was written.
        toastManager.add({ type: "error", title: "Couldn't save the draft" });
        openQuickCapture({ text: capture.text, destination });
        return false;
      }

      const store = useComposerDraftStore.getState();
      if (text.length > 0) store.setPrompt(opened.draftId, text);
      const accepted = new Set(images.length > 0 ? store.addImages(opened.draftId, images) : []);
      for (const image of images) {
        if (!accepted.has(image.id)) URL.revokeObjectURL(image.previewUrl);
      }
      if (files.length > 0) store.addFiles(opened.draftId, files, { appendReference: true });
      if (skipped.length > 0) {
        toastManager.add({
          type: "warning",
          title: skipped.length === 1 ? "A file wasn't attached" : "Some files weren't attached",
          description: skipped.join(", "),
        });
      }

      if (!options.open) showSavedToast(opened.draftId, text, destination, navigate);
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
