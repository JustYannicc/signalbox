import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useProjects } from "../../state/entities";
import { newDraftThreadId, type HarnessRef } from "../multiplayer/multiplayerModel";
import { useAssistantIdentity } from "../assistant/assistantIdentity";
import { toastManager } from "../ui/toast";
import { isAssistantToken, type CaptureToken } from "./captureTokens";
import { addLooseItem } from "../sidebar/sections/sectionStore";
import { postOpeningMessage } from "../multiplayer/TeamComposer";

const NEW_CHAT_HARNESS: HarnessRef = { provider: "codex", model: "GPT-5.4" };

/**
 * Turning New into a chat. Where it opens follows the chips:
 * - a real `#project` (or a chat in one): a T3 draft there, text prefilled;
 * - a `#team project` or `#section`: that container's shared draft;
 * - nothing tagged, assistant chip on: the assistant's chat, text prefilled;
 * - nothing tagged, no assistant: a new unfiled chat at Home's top level,
 *   with what you typed already sent.
 * `+` shares and `+private` ride along to shared drafts as `?share=`.
 */
export function useOpenAsFullChat(tokens: ReadonlyArray<CaptureToken>) {
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const projects = useProjects();
  const assistant = useAssistantIdentity();

  const projectRef = tokens.find((token) => token.projectRef)?.projectRef ?? null;
  const container = tokens.find((token) => token.containerKey);
  const withAssistant = tokens.some(isAssistantToken);
  const projectKey = projectRef ? scopedProjectKey(projectRef) : null;
  const projectTitle =
    projectKey === null
      ? null
      : (projects.find(
          (project) =>
            scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }) ===
            projectKey,
        )?.title ?? null);

  const label = projectRef
    ? projectTitle
      ? `Chat in ${projectTitle}`
      : "Chat"
    : container
      ? `Chat in ${container.label}`
      : withAssistant
        ? `Chat with ${assistant.name}`
        : "New chat";

  /**
   * `send` (Enter without the assistant chip) posts an unfiled chat's first
   * message; `draft` (⌘↵, full screen) only prefills it. Other targets always
   * open prefilled.
   */
  const openAsFullChat = async (text: string, mode: "send" | "draft" = "draft") => {
    const prompt = text.trim();
    const promptSearch = prompt.length > 0 ? { prompt } : {};
    if (projectRef) {
      const opened = await handleNewThread(projectRef).catch(() => null);
      if (!opened) {
        if (prompt.length > 0) await navigator.clipboard?.writeText(prompt).catch(() => {});
        toastManager.add({
          type: "warning",
          title: "Couldn't open the chat",
          description: prompt.length > 0 ? "What you typed is on the clipboard." : "Try New again.",
        });
        return;
      }
      if (prompt.length === 0) return;
      // Usually a fresh draft; if an empty one was reused, keep anything it had.
      const store = useComposerDraftStore.getState();
      const existing = store.getComposerDraft(opened.draftId)?.prompt.trim() ?? "";
      store.setPrompt(opened.draftId, existing.length > 0 ? `${existing}\n\n${prompt}` : prompt);
      return;
    }
    const share = shareParam(tokens);
    const shareSearch = share ? { share } : {};
    if (container?.containerKey) {
      await navigate({
        to: "/shared/$threadId",
        params: { threadId: newDraftThreadId() },
        search: {
          project: container.containerKey.replace(/^(section|team-project):/, ""),
          kind: "chat",
          ...promptSearch,
          ...shareSearch,
        },
      });
      return;
    }
    if (withAssistant) {
      await navigate({ to: "/assistant", search: promptSearch });
      return;
    }
    // Unfiled: a top-level chat that shows in Home › Chats right away.
    const threadId = newDraftThreadId();
    addLooseItem({
      id: threadId,
      title: unfiledChatTitle(prompt),
      kind: "chat",
      createdAt: new Date().toISOString(),
    });
    // Enter in New sends: the chat opens with your message already posted.
    const send = mode === "send" && prompt.length > 0;
    if (send) postOpeningMessage(threadId, prompt, NEW_CHAT_HARNESS);
    await navigate({
      to: "/shared/$threadId",
      params: { threadId },
      search: { kind: "chat", ...(send ? {} : promptSearch), ...shareSearch },
    });
  };

  return { label, withAssistant, openAsFullChat };
}

/** "Draft Q4 OKRs", from the first line of what was typed. */
function unfiledChatTitle(prompt: string): string {
  const firstLine = prompt.trim().split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) return "New chat";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine;
}

/** `?share=` for a shared draft: `private`, person ids and team ids from `+` tokens. */
function shareParam(tokens: ReadonlyArray<CaptureToken>): string | null {
  if (tokens.some((token) => token.kind === "private")) return "private";
  const ids = tokens
    .filter((token) => token.kind === "share")
    .map((token) => token.id.replace(/^share:(team:)?/, ""));
  return ids.length > 0 ? ids.join(",") : null;
}
