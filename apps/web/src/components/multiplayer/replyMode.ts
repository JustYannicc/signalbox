/**
 * When a shared chat's agent answers: each message right away (a normal AI
 * chat), or once everyone taking part has replied. The user's choice per
 * thread is local; fixtures carry the starting mode.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import type { ReplyMode, TeamMessage, TeamPerson } from "./multiplayerModel";
import { peopleByIds } from "./teamThreads";

export const REPLY_MODE_LABEL: Record<ReplyMode, string> = {
  each: "To each message",
  everyone: "When everyone has replied",
};

interface ReplyModeState {
  modes: Record<string, ReplyMode>;
  setMode: (threadId: string, mode: ReplyMode) => void;
}

export const useReplyModeStore = create<ReplyModeState>()(
  persist(
    (set) => ({
      modes: {},
      setMode: (threadId, mode) =>
        set((state) =>
          state.modes[threadId] === mode ? state : { modes: { ...state.modes, [threadId]: mode } },
        ),
    }),
    {
      name: "t3code:multiplayer:reply-mode:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ modes: state.modes }),
    },
  ),
);

export function useReplyMode(threadId: string, initial: ReplyMode = "each"): ReplyMode {
  return useReplyModeStore((state) => state.modes[threadId]) ?? initial;
}

/**
 * Who the agent still waits for in "everyone" mode: people who have posted in
 * the thread but not since its last answer. Empty when nobody has posted since.
 */
export function waitingForReplies(messages: readonly TeamMessage[]): readonly TeamPerson[] {
  const participants = new Set<string>();
  let sinceAnswer = new Set<string>();
  let anyoneSinceAnswer = false;
  for (const message of messages) {
    if (message.author.kind === "person") {
      participants.add(message.author.personId);
      sinceAnswer.add(message.author.personId);
      anyoneSinceAnswer = true;
    } else if (message.author.kind === "agent") {
      sinceAnswer = new Set();
      anyoneSinceAnswer = false;
    }
  }
  if (!anyoneSinceAnswer) return [];
  return peopleByIds([...participants].filter((id) => !sinceAnswer.has(id)));
}
