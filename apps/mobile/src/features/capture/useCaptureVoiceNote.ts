import { useCallback, useEffect, useRef, useState } from "react";
import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { retainComposerAttachmentFileForPreview } from "../../lib/composerAttachmentPreviewRetention";
import { copyVoiceNoteAttachment } from "../../lib/voiceNoteAttachment";
import {
  removePersistedComposerAttachmentFile,
  type DraftComposerFileAttachment,
} from "../../lib/composerImages";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  appendComposerDraftAttachments,
  composerDraftsAtom,
  flushComposerDrafts,
  getComposerDraftSnapshot,
  removeComposerDraftAttachment,
  readComposerDraftSelection,
  setComposerDraftText,
} from "../../state/use-composer-drafts";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";

export function useCaptureVoiceNote(input: {
  readonly ownerKey: string;
  readonly prepare: () => string | null;
  readonly selection: ComposerEditorSelection;
  readonly onSelectionChange: (selection: ComposerEditorSelection) => void;
  readonly disabled: boolean;
  readonly maxBytes: number;
}) {
  const copies = useRef(new Map<string, DraftComposerFileAttachment>());
  const retainedCopies = useRef(new Map<string, () => void>());
  const staged = useRef(
    new Map<string, { draftKey: string; attachment: DraftComposerFileAttachment }>(),
  );
  const unfinished = useRef(new Set<string>());
  const discardInFlight = useRef<Promise<void> | null>(null);
  const [hasPendingWork, setHasPendingWork] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const voice = useVoiceInputController({
    ownerKey: input.ownerKey,
    label: "Quick capture",
    disabled: input.disabled,
    selection: input.selection,
    readDraftMessage: () => {
      const key = input.prepare();
      return key ? getComposerDraftSnapshot(key).text : null;
    },
    subscribeToDraftChanges: (onChange) => appAtomRegistry.subscribe(composerDraftsAtom, onChange),
    onChangeDraftMessage: (text) => {
      const key = input.prepare();
      if (key) setComposerDraftText(key, text);
    },
    onChangeSelection: input.onSelectionChange,
    onRecording: async (uri, { readDraft }) => {
      unfinished.current.add(uri);
      setHasPendingWork(true);
      setDiscardError(null);
      const key = input.prepare();
      if (!key) throw new Error("Choose a destination before saving this voice note.");
      let attachment = copies.current.get(uri);
      if (!attachment) {
        attachment = await copyVoiceNoteAttachment(uri, input.maxBytes);
        copies.current.set(uri, attachment);
      }
      const draft = getComposerDraftSnapshot(key);
      const before = readDraft();
      if (!draft.attachments.some((item) => item.id === attachment.id)) {
        const rejected = appendComposerDraftAttachments(key, [attachment], {
          appendReference: true,
        });
        if (rejected > 0) {
          copies.current.delete(uri);
          await removePersistedComposerAttachmentFile(attachment.fileUri);
          throw new Error("Remove an attachment, then retry saving this voice note.");
        }
        staged.current.set(uri, { draftKey: key, attachment });
      }
      const after = readDraft();
      const selection = after ? readComposerDraftSelection(key, after.text) : null;
      await flushComposerDrafts();
      const releaseCopy = retainedCopies.current.get(uri);
      if (releaseCopy) {
        retainedCopies.current.delete(uri);
        releaseCopy();
      }
      unfinished.current.delete(uri);
      copies.current.delete(uri);
      staged.current.delete(uri);
      setHasPendingWork(unfinished.current.size > 0);
      if (before && after)
        return { before, after: { ...after, selection: selection ?? after.selection } };
    },
  });
  const {
    cancelOwned,
    cancelPendingRecording,
    hasPendingRecording,
    isBusy,
    state: voiceState,
    stop,
  } = voice;
  const hasPendingAudio = hasPendingWork || hasPendingRecording();
  const discardPendingAudio = useCallback(async () => {
    if (discardInFlight.current) return discardInFlight.current;
    setDiscardError(null);
    const operation = (async () => {
      for (const [uri, attachment] of Array.from(copies.current)) {
        const stagedCopy = staged.current.get(uri);
        if (stagedCopy) {
          if (!retainedCopies.current.has(uri)) {
            retainedCopies.current.set(uri, retainComposerAttachmentFileForPreview(attachment));
          }
          const draft = getComposerDraftSnapshot(stagedCopy.draftKey);
          if (draft.attachments.some((item) => item.id === stagedCopy.attachment.id)) {
            removeComposerDraftAttachment(stagedCopy.draftKey, stagedCopy.attachment.id);
          }
          await flushComposerDrafts();
          const releaseCopy = retainedCopies.current.get(uri);
          if (releaseCopy) {
            retainedCopies.current.delete(uri);
            releaseCopy();
          }
        }
        await removePersistedComposerAttachmentFile(attachment.fileUri);
        copies.current.delete(uri);
        staged.current.delete(uri);
        unfinished.current.delete(uri);
      }
      unfinished.current.clear();
      setHasPendingWork(false);
      cancelPendingRecording();
    })();
    discardInFlight.current = operation;
    try {
      await operation;
    } catch (error) {
      setDiscardError("Couldn't discard unsaved audio. Try again.");
      throw error;
    } finally {
      if (discardInFlight.current === operation) discardInFlight.current = null;
    }
  }, [cancelPendingRecording]);

  useEffect(() => {
    if (voiceState.phase !== "idle" || !hasPendingAudio) return;
    // The global voice control can discard a pending capture while this route is hidden.
    // oxlint-disable-next-line react/set-state-in-effect -- The global voice control can cancel this capture's pending recording.
    void discardPendingAudio().catch(() => undefined);
  }, [discardPendingAudio, hasPendingAudio, voiceState.phase]);
  useEffect(
    () => () => {
      for (const release of retainedCopies.current.values()) release();
      retainedCopies.current.clear();
    },
    [],
  );
  const beforeSave = async () => {
    if (
      voiceState.phase === "preparing" &&
      !hasPendingRecording() &&
      unfinished.current.size === 0 &&
      copies.current.size === 0
    ) {
      cancelOwned();
    } else if (isBusy) {
      await stop();
    }
    if (unfinished.current.size > 0 || copies.current.size > 0 || hasPendingRecording()) {
      throw new Error("The voice note isn't saved yet. Retry it before closing this capture.");
    }
  };
  return { ...voice, hasPendingAudio, discardError, discardPendingAudio, beforeSave };
}
