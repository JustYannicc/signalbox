/**
 * Opens a new thread in the automation's project with a request from
 * `@t3tools/client-runtime/automations/prompts` started in its composer, so
 * the user only types what to change and sends.
 */
import type { Automation, EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useCallback } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { toastManager } from "../ui/toast";

/** Puts `prompt` in the draft without wiping what the user already typed there. */
function mergePrompt(existing: string, prompt: string): string {
  const typed = existing.trimEnd();
  if (!typed) return prompt;
  if (typed.endsWith(prompt.trimEnd())) return existing;
  return `${typed}\n\n${prompt}`;
}

/** Opens a draft thread in `projectRef` holding `prompt`. Reports when it couldn't. */
export function useOpenAgentDraft() {
  const newThread = useNewThreadHandler();
  return useCallback(
    async (projectRef: ScopedProjectRef, prompt: string) => {
      const session = await newThread(projectRef).catch(() => null);
      if (!session) {
        toastManager.add({
          type: "error",
          title: "Couldn't open a thread",
          description: "The automation's project isn't available on this device.",
        });
        return;
      }
      const store = useComposerDraftStore.getState();
      const existing = store.getComposerDraft(session.draftId)?.prompt ?? "";
      store.setPrompt(session.draftId, mergePrompt(existing, prompt));
    },
    [newThread],
  );
}

/** Opens a draft in the automation's project; pass a prompt builder above. */
export function useAutomationAgent(
  environmentId: EnvironmentId,
  automation: Pick<Automation, "projectId">,
) {
  const openDraft = useOpenAgentDraft();
  const { projectId } = automation;
  return useCallback(
    (prompt: string) => openDraft(scopeProjectRef(environmentId, projectId), prompt),
    [environmentId, openDraft, projectId],
  );
}
