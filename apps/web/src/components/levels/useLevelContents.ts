/**
 * What lives at one Home level, for the agent page's "Coordinates" view: its
 * threads (chats, tasks, rooms, real threads), automations and places, read
 * from the same indexes as the Home tree. Only what sits directly at the
 * level; folders inside it have agents of their own. Accounts and skills are
 * left out: Access lists those.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useMemo } from "react";

import { useAutomations } from "../homeAutomations/runDecisions";
import { useRoomArchiveStore } from "../rooms/rooms";
import { buildContainerIndex, contentsOf } from "../sidebar/sections/containerContents";
import { buildMappedIndex, useMappedStore } from "../sidebar/sections/mappedItems";
import { allLooseItems } from "../sidebar/sections/sectionModel";
import { useHomeSectionStore } from "../sidebar/sections/sectionStore";
import { homeThreadKey, useHomeSidebarData } from "../sidebar/useHomeSidebarData";
import type { LevelKey } from "./levels";

export type LevelEntryTarget =
  | { readonly kind: "shared"; readonly threadId: string }
  | { readonly kind: "room"; readonly roomId: string }
  | { readonly kind: "thread"; readonly ref: ScopedThreadRef }
  | { readonly kind: "automation"; readonly automationId: string }
  | { readonly kind: "place"; readonly mappingId: string };

export interface LevelEntry {
  readonly id: string;
  readonly title: string;
  /** "Task", "Chat", "Room", a cadence, or what a place is. */
  readonly detail: string;
  readonly target: LevelEntryTarget;
}

export interface LevelContents {
  readonly threads: readonly LevelEntry[];
  readonly automations: readonly LevelEntry[];
  readonly places: readonly LevelEntry[];
}

const kindLabel = (kind: "chat" | "task") => (kind === "chat" ? "Chat" : "Task");

export function useLevelContents(level: LevelKey | null): LevelContents {
  const { projectEntries } = useHomeSidebarData();
  const automations = useAutomations();
  const homes = useMappedStore((state) => state.homes);
  const references = useMappedStore((state) => state.references);
  const reach = useMappedStore((state) => state.reach);
  // Cached by `allLooseItems`, so this only changes when loose items do.
  const looseItems = useHomeSectionStore(() => allLooseItems());
  const archived = useHomeSectionStore((state) => state.archived);
  const itemContainers = useHomeSectionStore((state) => state.itemContainers);
  const archivedRooms = useRoomArchiveStore((state) => state.archived);

  return useMemo(() => {
    if (level === null) return { threads: [], automations: [], places: [] };
    const mapped = buildMappedIndex({
      automations,
      projects: projectEntries.map((entry) => entry.group),
      overrides: { homes, references, reach },
    });
    const index = buildContainerIndex({
      projectEntries,
      looseItems,
      archived,
      archivedRooms,
      itemContainers,
      mapped,
    });
    const contents = contentsOf(index, level);
    const ownThreads = level.startsWith("project:")
      ? (projectEntries
          .find((entry) => `project:${entry.group.projectKey}` === level)
          ?.threads.filter((thread) => !index.movedThreadKeys.has(homeThreadKey(thread))) ?? [])
      : [];
    const threads = [
      ...contents.loose.map((item) => ({
        at: item.lastActiveAt,
        entry: {
          id: item.id,
          title: item.title,
          detail: kindLabel(item.type),
          target: { kind: "shared", threadId: item.id },
        } satisfies LevelEntry,
      })),
      ...contents.teamThreads.map((thread) => ({
        at: thread.lastActiveAt,
        entry: {
          id: thread.id,
          title: thread.title,
          detail: kindLabel(thread.kind),
          target: { kind: "shared", threadId: thread.id },
        } satisfies LevelEntry,
      })),
      ...contents.rooms.map((room) => ({
        at: room.lastActiveAt,
        entry: {
          id: room.id,
          title: room.title,
          detail: "Room",
          target: { kind: "room", roomId: room.id },
        } satisfies LevelEntry,
      })),
      ...[...ownThreads, ...contents.threads].map((thread) => ({
        at: thread.latestUserMessageAt ?? thread.updatedAt,
        entry: {
          id: homeThreadKey(thread),
          title: thread.title,
          detail: "Thread",
          target: { kind: "thread", ref: scopeThreadRef(thread.environmentId, thread.id) },
        } satisfies LevelEntry,
      })),
    ]
      .toSorted((left, right) => Date.parse(right.at) - Date.parse(left.at))
      .map(({ entry }): LevelEntry => entry);
    const automationEntries: LevelEntry[] = [];
    const places: LevelEntry[] = [];
    for (const item of contents.mapped) {
      if (item.kind === "automation") {
        automationEntries.push({
          id: item.id,
          title: item.title,
          detail: item.automation.cadence,
          target: { kind: "automation", automationId: item.automation.id },
        });
      } else if (item.kind === "place") {
        places.push({
          id: item.id,
          title: item.title,
          detail: item.mapping.what,
          target: { kind: "place", mappingId: item.mapping.id },
        });
      }
    }
    return { threads, automations: automationEntries, places };
  }, [
    archived,
    archivedRooms,
    automations,
    homes,
    itemContainers,
    level,
    looseItems,
    projectEntries,
    reach,
    references,
  ]);
}
