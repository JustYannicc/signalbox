import type { DraftComposerAttachment } from "../../lib/composerImages";
import {
  appendComposerDraftAttachments,
  captureComposerDraftInsertion,
  clearComposerDraft,
  createNewTaskDraft,
  getComposerDraftSnapshot,
  removeComposerDraftAttachment,
  retargetNewTaskDraft,
  setNewTaskDraftFolderStart,
  setComposerDraftText,
  useComposerDraft,
  type ComposerDraftInsertion,
} from "../../state/use-composer-drafts";
import type { CaptureTarget } from "./destinations";
import { useCallback, useEffect, useRef, useState } from "react";

export type CaptureAddAttachments = (
  attachments: ReadonlyArray<DraftComposerAttachment>,
  insertion?: ComposerDraftInsertion,
) => number;

export function useCaptureDraft(target: CaptureTarget | null) {
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const draftKeyRef = useRef<string | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  const draft = useComposerDraft(draftKey);

  const ensureDraft = useCallback(() => {
    const currentTarget = targetRef.current;
    if (!currentTarget) return null;
    const project = {
      environmentId: currentTarget.start.environmentId,
      projectId: currentTarget.start.projectId,
    };
    let key = draftKeyRef.current;
    if (key === null) {
      key = createNewTaskDraft(project);
      draftKeyRef.current = key;
      setDraftKey(key);
    } else {
      retargetNewTaskDraft(key, project);
    }
    setNewTaskDraftFolderStart(key, currentTarget.start);
    return key;
  }, []);

  const clearEmptyDraft = useCallback(
    (key: string) => {
      clearComposerDraft(key);
      draftKeyRef.current = null;
      // Keep the focused editor ready for another paste after its content is cleared.
      if (ensureDraft() === null) setDraftKey(null);
    },
    [ensureDraft],
  );

  const retarget = useCallback((nextTarget: CaptureTarget) => {
    const key = draftKeyRef.current;
    if (!key) return;
    retargetNewTaskDraft(key, {
      environmentId: nextTarget.start.environmentId,
      projectId: nextTarget.start.projectId,
    });
    setNewTaskDraftFolderStart(key, nextTarget.start);
  }, []);

  useEffect(() => {
    const key = draftKeyRef.current;
    if (!key || !target) return;
    retargetNewTaskDraft(key, {
      environmentId: target.start.environmentId,
      projectId: target.start.projectId,
    });
    setNewTaskDraftFolderStart(key, target.start);
  }, [target]);

  useEffect(
    () => () => {
      const key = draftKeyRef.current;
      if (!key) return;
      const { text, attachments } = getComposerDraftSnapshot(key);
      if (text.length === 0 && attachments.length === 0) clearComposerDraft(key);
      draftKeyRef.current = null;
    },
    [],
  );

  const setText = useCallback(
    (value: string) => {
      if (value.length === 0 && draftKeyRef.current === null) return;
      const key = draftKeyRef.current ?? ensureDraft();
      if (!key) return;
      setComposerDraftText(key, value);
      if (value.length === 0 && draft.text.length > 0 && draft.attachments.length === 0) {
        clearEmptyDraft(key);
      }
    },
    [clearEmptyDraft, draft.attachments.length, draft.text.length, ensureDraft],
  );

  const addAttachments = useCallback<CaptureAddAttachments>(
    (attachments, selection) => {
      const key = ensureDraft();
      if (!key) throw new Error("Choose a destination before adding attachments.");
      const insertion = captureComposerDraftInsertion(key, selection);
      return appendComposerDraftAttachments(key, attachments, {
        appendReference: true,
        insertion,
      });
    },
    [ensureDraft],
  );

  const removeAttachment = useCallback((attachmentId: string) => {
    const key = draftKeyRef.current;
    if (!key) return;
    removeComposerDraftAttachment(key, attachmentId);
    const { text, attachments } = getComposerDraftSnapshot(key);
    if (text.length === 0 && attachments.length === 0) {
      clearEmptyDraft(key);
    }
  }, [clearEmptyDraft]);

  const prepare = useCallback(() => ensureDraft(), [ensureDraft]);

  return { draft, draftKey, setText, addAttachments, removeAttachment, prepare, retarget };
}
