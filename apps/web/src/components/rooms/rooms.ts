/**
 * Room lookups and the one local state: which rooms the user archived. A
 * `new-<personId>-…` id resolves to an empty room with that person's
 * assistant; a fork id to a private copy of its source room.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import { CURRENT_PERSON_ID } from "../multiplayer/multiplayerFixtures";
import { ROOMS, policiesFor } from "./roomFixtures";
import { containerSectionId } from "../multiplayer/containerScope";
import { findFork } from "../multiplayer/forks";
import { newRoomId, personIdOfNewRoom, type Room } from "./roomModel";

export function findRoom(roomId: string): Room | undefined {
  return ROOMS.find((room) => room.id === roomId);
}

/** Rooms listed in a Home container (`section:<id>` or `team-project:<id>`). */
export function roomsInContainer(containerKey: string): readonly Room[] {
  return ROOMS.filter((room) => room.containerKey === containerKey);
}

export const ALL_ROOMS = ROOMS;

/**
 * The latest open room with this person's assistant, or a fresh room id. Open
 * a fresh one with `?container=` so it lands where you asked from.
 */
export function roomIdForPerson(personId: string): string {
  const archived = useRoomArchiveStore.getState().archived;
  const existing = ROOMS.filter(
    (room) => room.ownerIds.includes(personId) && room.status === "open" && !archived[room.id],
  ).toSorted((left, right) => Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt))[0];
  return existing?.id ?? newRoomId(personId);
}

/** Container key for new rooms opened at the top level. */
export const ROOT_ROOM_CONTAINER_KEY = "root";

/**
 * A fixture room, a private fork of one, or a fresh room for a `new-…` id.
 * `containerKey` places a fresh room (`section:…`, `team-project:…`, `root`).
 */
export function resolveRoom(roomId: string, containerKey?: string): Room | null {
  const existing = findRoom(roomId);
  if (existing) return existing;
  const fork = findFork(roomId);
  if (fork?.sourceType === "room") {
    const source = resolveRoom(fork.sourceId);
    return source
      ? {
          ...source,
          id: fork.id,
          title: fork.title,
          visibility: "private",
          lastActiveAt: fork.createdAt,
        }
      : null;
  }
  const personId = personIdOfNewRoom(roomId);
  if (!personId || personId === CURRENT_PERSON_ID) return null;
  const key = containerKey ?? ROOT_ROOM_CONTAINER_KEY;
  return {
    id: roomId,
    title: "New room",
    ownerIds: [CURRENT_PERSON_ID, personId],
    status: "open",
    containerKey: key,
    sectionId: containerSectionId(key) ?? "home",
    lastActiveAt: new Date().toISOString(),
    messages: [],
    policies: policiesFor([CURRENT_PERSON_ID, personId]),
  };
}

interface RoomArchiveState {
  archived: Record<string, true>;
  setArchived: (roomId: string, archived: boolean) => void;
}

export const useRoomArchiveStore = create<RoomArchiveState>()(
  persist(
    (set) => ({
      archived: {},
      setArchived: (roomId, archived) =>
        set((state) => {
          if (Boolean(state.archived[roomId]) === archived) return state;
          if (archived) return { archived: { ...state.archived, [roomId]: true } };
          const { [roomId]: _removed, ...rest } = state.archived;
          return { archived: rest };
        }),
    }),
    {
      name: "t3code:rooms:archived:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ archived: state.archived }),
    },
  ),
);
