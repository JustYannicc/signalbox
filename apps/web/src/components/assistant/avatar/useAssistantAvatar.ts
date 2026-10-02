/**
 * The saved avatar config and its setter; every reader re-renders on change,
 * across tabs too. PLACEHOLDER persistence: localStorage only, until the
 * assistant identity becomes a real server-side setting.
 */
import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { AssistantAvatarConfigSchema, DEFAULT_ASSISTANT_AVATAR } from "./avatarConfig";

export const ASSISTANT_AVATAR_STORAGE_KEY = "t3code:assistant-avatar:v1";

export function useAssistantAvatar() {
  return useLocalStorage(
    ASSISTANT_AVATAR_STORAGE_KEY,
    DEFAULT_ASSISTANT_AVATAR,
    AssistantAvatarConfigSchema,
  );
}
