/**
 * The top-level assistant's identity: the name the user gives it. Its face is
 * the avatar from `./avatar`, rendered through `AssistantIcon`.
 * PLACEHOLDER: prototype state (`usePrototypeState`), until identity is a real setting.
 * Read it with `useAssistantIdentity()`; `ASSISTANT_NAME` is the default name.
 */
import * as Schema from "effect/Schema";

import { usePrototypeState } from "../../lib/prototypeStorage";

export const ASSISTANT_NAME = "Appa";

// Only the name lives here; the face is the avatar module's (`./avatar`).
const AssistantIdentitySchema = Schema.Struct({ name: Schema.String });

export type AssistantIdentity = typeof AssistantIdentitySchema.Type;

export const DEFAULT_ASSISTANT_IDENTITY: AssistantIdentity = { name: ASSISTANT_NAME };

const STORAGE_KEY = "t3code:assistant-identity:v1";

/** The identity and its setter; every reader re-renders when it changes. */
export function useAssistantIdentityState() {
  return usePrototypeState(STORAGE_KEY, DEFAULT_ASSISTANT_IDENTITY);
}

export function useAssistantIdentity(): AssistantIdentity {
  const [identity] = useAssistantIdentityState();
  return identity.name.trim() ? identity : { ...identity, name: ASSISTANT_NAME };
}

export { AssistantIcon } from "./AssistantIcon";
