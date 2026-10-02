/**
 * Every person is represented by their own assistant. Yours is the one you set
 * up (name and avatar from settings); teammates' are fixtures with an avatar
 * generated from their id, so each looks the same everywhere. Assistants are
 * personal: they act for their owner in rooms, never as a shared team agent.
 */
import { useCallback } from "react";

import { useAssistantIdentity } from "../assistant/assistantIdentity";
import {
  generateAvatar,
  useAssistantAvatar,
  type AssistantAvatarConfig,
} from "../assistant/avatar";
import type { TeamPerson } from "./multiplayerModel";
import { currentPerson } from "./teamThreads";

export interface PersonAssistant {
  readonly name: string;
  readonly config: AssistantAvatarConfig;
  readonly isYours: boolean;
}

/** Resolves any person's assistant; call once per surface, not per row. */
export function useAssistantDirectory() {
  const identity = useAssistantIdentity();
  const [ownAvatar] = useAssistantAvatar();
  return useCallback(
    (person: TeamPerson): PersonAssistant =>
      person.id === currentPerson.id
        ? { name: identity.name, config: ownAvatar, isYours: true }
        : { name: person.assistantName, config: generateAvatar(person.id), isYours: false },
    [identity.name, ownAvatar],
  );
}
