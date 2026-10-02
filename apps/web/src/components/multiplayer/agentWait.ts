/**
 * "Wait for Samir": the visible, per-message way to hold the agent until
 * someone replies. Set from the composer (button or the question suggestion);
 * it ends by itself once everyone waited for has posted, or by "Reply now" /
 * "Stop waiting". The per-chat reply mode stays as the background rule.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import type { TeamMessage, TeamPerson, TeamThread } from "./multiplayerModel";
import { peopleByIds } from "./teamThreads";

interface AgentWait {
  readonly ids: readonly string[];
  /** Messages before this index don't count as a reply. */
  readonly afterCount: number;
}

interface AgentWaitState {
  /** `null` records a cleared fixture wait. */
  waits: Record<string, AgentWait | null>;
  setWait: (threadId: string, wait: AgentWait | null) => void;
}

export const useAgentWaitStore = create<AgentWaitState>()(
  persist(
    (set) => ({
      waits: {},
      setWait: (threadId, wait) =>
        set((state) => ({ waits: { ...state.waits, [threadId]: wait } })),
    }),
    {
      name: "t3code:multiplayer:agent-wait:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ waits: state.waits }),
    },
  ),
);

/** People the agent still waits for: set by hand or by the fixture, minus those who replied. */
export function useAgentWait(thread: TeamThread, messages: readonly TeamMessage[]) {
  const stored = useAgentWaitStore((state) => state.waits[thread.id]);
  const fixtureMessageCount = messages.filter((message) => !message.createdAt).length;
  const wait =
    stored !== undefined
      ? stored
      : thread.waitingForIds
        ? { ids: thread.waitingForIds, afterCount: fixtureMessageCount }
        : null;
  const repliedIds = new Set(
    messages
      .slice(wait?.afterCount ?? messages.length)
      .flatMap((message) => (message.author.kind === "person" ? [message.author.personId] : [])),
  );
  const waitingFor: readonly TeamPerson[] = peopleByIds(
    (wait?.ids ?? []).filter((id) => !repliedIds.has(id)),
  );
  return {
    waitingFor,
    waitFor: (ids: readonly string[]) =>
      useAgentWaitStore
        .getState()
        .setWait(thread.id, ids.length > 0 ? { ids, afterCount: messages.length } : null),
    stopWaiting: () => useAgentWaitStore.getState().setWait(thread.id, null),
  };
}
