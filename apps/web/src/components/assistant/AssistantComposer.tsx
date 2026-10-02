/**
 * The normal chat composer for the assistant and agent chats. They have no
 * server thread yet, so `onSend` feeds the local mock conversation. Supervisors
 * run on a harness too, so the model/harness picker is on; mode and access
 * aren't the user's to steer here. It speaks the New bar's grammar (`@` people
 * and agents, `#` projects, sections and chats) and takes files as chips.
 */
import { useState } from "react";

import { MockBoundComposer } from "../chat/MockBoundComposer";
import { useAssistantComposerSources } from "./useAssistantComposerSources";

export function AssistantComposer(props: {
  /** Who the message goes to, e.g. "Appa" or "Work agent". */
  recipient: string;
  /** Stable per chat surface; keys the composer's send lock. */
  targetKey: string;
  placeholder: string;
  size?: "default" | "large";
  prompt?: string;
  onPromptChange?: (prompt: string) => void;
  onSend: (text: string, files: ReadonlyArray<File>) => void;
}) {
  const { mentions, tags } = useAssistantComposerSources();
  // Always controlled here, so a send can clear the draft.
  const [localPrompt, setLocalPrompt] = useState("");
  const prompt = props.prompt ?? localPrompt;
  const setPrompt = props.onPromptChange ?? setLocalPrompt;
  return (
    <MockBoundComposer
      targetKey={`assistant-preview:${props.targetKey}`}
      placeholder={props.placeholder}
      agentControls="model"
      mentions={mentions}
      tags={tags}
      attachments
      {...(props.size ? { size: props.size } : {})}
      prompt={prompt}
      onPromptChange={setPrompt}
      onSend={(text, files) => {
        props.onSend(text, files);
        setPrompt("");
      }}
    />
  );
}
