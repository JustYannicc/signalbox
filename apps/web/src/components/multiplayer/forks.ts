/**
 * Private copies. Forking copies an item's history into a new private item in
 * the same container; the original stays as it is. Chats, tasks and rooms all
 * fork the same way. Local only: the copy's history is read from its source.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import { shortId } from "./multiplayerModel";

export interface ForkRecord {
  readonly id: string;
  /** The item this copies; may itself be a fork. */
  readonly sourceId: string;
  readonly sourceType: "thread" | "room";
  readonly title: string;
  readonly createdAt: string;
}

interface ForkState {
  forks: Record<string, ForkRecord>;
  addFork: (record: ForkRecord) => void;
}

export const useForkStore = create<ForkState>()(
  persist(
    (set) => ({
      forks: {},
      addFork: (record) => set((state) => ({ forks: { ...state.forks, [record.id]: record } })),
    }),
    {
      name: "t3code:multiplayer:forks:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ forks: state.forks }),
    },
  ),
);

export function findFork(itemId: string): ForkRecord | undefined {
  return useForkStore.getState().forks[itemId];
}

/** Records a private copy of an item and returns the copy's id. */
export function forkItem(source: {
  readonly id: string;
  readonly title: string;
  readonly type: "thread" | "room";
}): string {
  const id = `fork-${shortId()}`;
  useForkStore.getState().addFork({
    id,
    sourceId: source.id,
    sourceType: source.type,
    title: source.title.endsWith("(copy)") ? source.title : `${source.title} (copy)`,
    createdAt: new Date().toISOString(),
  });
  return id;
}
