/**
 * Local access state for any item (team thread, room, or real thread) and the
 * builders that turn each into an `AccessItem`. Visibility reuses the thread
 * visibility store (keyed by item id); direct grants and their roles live
 * here. Preview only.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import type { Room } from "../rooms/roomModel";
import { defaultScopeFor } from "./containerScope";
import type { TeamThread, ThreadVisibility } from "./multiplayerModel";
import type { AccessItem, ShareRole } from "./sharing";
import { currentPerson, useThreadVisibility } from "./teamThreads";

const NO_GRANTS: readonly string[] = [];
const NO_ROLES: Readonly<Record<string, ShareRole>> = {};

interface GrantsState {
  grants: Record<string, readonly string[]>;
  /** itemId → personId → role, only where the user changed it. */
  roles: Record<string, Readonly<Record<string, ShareRole>>>;
  /** Emails invited from outside the team, pending until they join. */
  invites: Record<string, readonly string[]>;
  invite: (itemId: string, email: string) => void;
  grant: (itemId: string, personIds: readonly string[]) => void;
  revoke: (itemId: string, personId: string) => void;
  setRole: (itemId: string, personId: string, role: ShareRole) => void;
}

export const useItemGrantsStore = create<GrantsState>()(
  persist(
    (set) => ({
      grants: {},
      roles: {},
      invites: {},
      invite: (itemId, email) =>
        set((state) => {
          const current = state.invites[itemId] ?? NO_GRANTS;
          return current.includes(email)
            ? state
            : { invites: { ...state.invites, [itemId]: [...current, email] } };
        }),
      setRole: (itemId, personId, role) =>
        set((state) =>
          state.roles[itemId]?.[personId] === role
            ? state
            : {
                roles: {
                  ...state.roles,
                  [itemId]: { ...(state.roles[itemId] ?? NO_ROLES), [personId]: role },
                },
              },
        ),
      grant: (itemId, personIds) =>
        set((state) => {
          const current = state.grants[itemId] ?? NO_GRANTS;
          const added = personIds.filter((id) => !current.includes(id));
          if (added.length === 0) return state;
          return { grants: { ...state.grants, [itemId]: [...current, ...added] } };
        }),
      revoke: (itemId, personId) =>
        set((state) => {
          const current = state.grants[itemId] ?? NO_GRANTS;
          if (!current.includes(personId)) return state;
          return {
            grants: { ...state.grants, [itemId]: current.filter((id) => id !== personId) },
          };
        }),
    }),
    {
      name: "t3code:multiplayer:grants:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        grants: state.grants,
        roles: state.roles,
        invites: state.invites,
      }),
    },
  ),
);

/** People added directly to an item. Stable reference while unchanged. */
export function useItemGrantedIds(itemId: string): readonly string[] {
  return useItemGrantsStore((state) => state.grants[itemId]) ?? NO_GRANTS;
}

export type AccessItemBase = Omit<AccessItem, "visibility" | "grantedIds" | "roles" | "invites"> & {
  readonly initialVisibility: ThreadVisibility;
};

/** The item with the user's local visibility change, grants and roles applied. */
export function useAccessItem(base: AccessItemBase): AccessItem {
  const visibility = useThreadVisibility(base.id, base.initialVisibility);
  const grantedIds = useItemGrantedIds(base.id);
  const roles = useItemGrantsStore((state) => state.roles[base.id]) ?? NO_ROLES;
  const invites = useItemGrantsStore((state) => state.invites[base.id]) ?? NO_GRANTS;
  const { id, title, kind, containerId, ownerIds, repliedIds } = base;
  return useMemo(
    () => ({
      id,
      title,
      kind,
      containerId,
      ownerIds,
      repliedIds,
      visibility,
      grantedIds,
      roles,
      invites,
    }),
    [id, title, kind, containerId, ownerIds, repliedIds, visibility, grantedIds, roles, invites],
  );
}

/** `containerId` defaults to the thread's team project; loose items pass their section. */
export function teamThreadAccessBase(
  thread: TeamThread,
  containerId = thread.projectId,
): AccessItemBase {
  const ownerId = thread.participantIds[0] ?? currentPerson.id;
  return {
    id: thread.id,
    title: thread.title,
    kind: thread.kind,
    containerId,
    ownerIds: [ownerId],
    repliedIds: thread.participantIds.filter((id) => id !== ownerId),
    initialVisibility: thread.visibility,
  };
}

/**
 * Both owners always have access. A room starts with just them in any
 * container: what an assistant shared was cleared for that one person.
 */
export function roomAccessBase(room: Room): AccessItemBase {
  return {
    id: room.id,
    title: room.title,
    kind: "room",
    containerId: room.containerKey,
    ownerIds: room.ownerIds,
    repliedIds: [],
    initialVisibility: room.visibility ?? "private",
  };
}

/**
 * A real thread: placeholder access is just you; visibility starts from the
 * default of the container Home shows it in (`containerIdForThread`).
 */
export function localThreadAccessBase(input: {
  readonly threadId: string;
  readonly title: string;
  readonly kind: "chat" | "task";
  readonly containerId: string;
}): AccessItemBase {
  return {
    id: input.threadId,
    title: input.title,
    kind: input.kind,
    containerId: input.containerId,
    ownerIds: [currentPerson.id],
    repliedIds: [],
    initialVisibility: defaultScopeFor(input.containerId),
  };
}
