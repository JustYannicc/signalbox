/**
 * The avatar config and its setter; every reader re-renders on change.
 * PLACEHOLDER: prototype state (`usePrototypeState`), until the assistant identity
 * becomes a real server-side setting.
 */
import { usePrototypeState } from "../../../lib/prototypeStorage";
import { DEFAULT_ASSISTANT_AVATAR } from "./avatarConfig";

export const ASSISTANT_AVATAR_STORAGE_KEY = "t3code:assistant-avatar:v1";

export function useAssistantAvatar() {
  return usePrototypeState(ASSISTANT_AVATAR_STORAGE_KEY, DEFAULT_ASSISTANT_AVATAR);
}
