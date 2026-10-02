import { useCallback } from "react";

import { ASSISTANT_NAME, useAssistantIdentity } from "../assistant/assistantIdentity";

/**
 * Fixtures spell the assistant with its default name. This swaps in the name
 * the user gave it wherever automation text is rendered.
 */
export function useAssistantName() {
  const { name } = useAssistantIdentity();
  return useCallback(
    (text: string) => (name === ASSISTANT_NAME ? text : text.replaceAll(ASSISTANT_NAME, name)),
    [name],
  );
}
