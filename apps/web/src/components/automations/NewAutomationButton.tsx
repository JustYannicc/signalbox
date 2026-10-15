/**
 * The overview's New automation: starts a thread asking an agent to build one,
 * in the project in front of the user, else the first one.
 */
import { NEW_AUTOMATION_PROMPT } from "@t3tools/client-runtime/automations/prompts";
import { PlusIcon } from "lucide-react";

import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import { Button } from "../ui/button";
import { useOpenAgentDraft } from "./useAutomationAgent";

export function NewAutomationButton() {
  const newThreadContext = useHandleNewThread();
  const openDraft = useOpenAgentDraft();
  const projectRef = resolveThreadActionProjectRef({
    ...newThreadContext,
    activeThread: newThreadContext.activeThread ?? undefined,
  });
  if (!projectRef) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={() => void openDraft(projectRef, NEW_AUTOMATION_PROMPT)}
    >
      <PlusIcon />
      New automation
    </Button>
  );
}
