/**
 * Local-only Home tree state: sections you created, renamed, or moved; where
 * you moved projects and items; which nodes are collapsed; and what you
 * archived from *your* sidebar (hidden for you only). Node keys are
 * `section:<id>`, `project:<projectKey>`, `team-project:<id>`; item keys are
 * thread keys or fixture ids; container keys are node keys or `root`.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../../lib/storage";
import { toastManager } from "../../ui/toast";

export const ROOT_CONTAINER_KEY = "root";

export interface ArchivedEntry {
  readonly label: string;
  /** "Project", "Section", "Chat", "Task". */
  readonly kind: string;
  readonly archivedAt: string;
}

/** An unfiled chat or task created outside Home (e.g. from the New bar). */
export interface UserLooseItem {
  readonly title: string;
  readonly kind: "chat" | "task";
  readonly createdAt: string;
}

export interface UserSection {
  readonly name: string;
  readonly parentId: string | null;
}

interface HomeSectionState {
  /** Real `projectKey` or `team-project:<id>` → section id, only for moved projects. */
  projectSectionOverrides: Record<string, string>;
  collapsedNodeKeys: Record<string, true>;
  archived: Record<string, ArchivedEntry>;
  userSections: Record<string, UserSection>;
  /** Section id → new parent (`null` = top level), for moved sections. */
  sectionParents: Record<string, string | null>;
  /** Node key → display name you gave it (Home only). */
  names: Record<string, string>;
  /** Item key → container key, for moved items. */
  itemContainers: Record<string, string>;
  /** Unfiled chats and tasks you created, by id. */
  userLooseItems: Record<string, UserLooseItem>;
  /** Transient: the node whose name is being edited inline. */
  renamingKey: string | null;
  /** Transient: projects showing every thread instead of the preview. */
  showAllKeys: Record<string, true>;
  setShowAll: (projectKey: string, showAll: boolean) => void;
  moveProject: (projectKey: string, sectionId: string) => void;
  moveSection: (sectionId: string, parentId: string | null) => void;
  moveItem: (itemKey: string, containerKey: string) => void;
  setNodeExpanded: (nodeKey: string, expanded: boolean) => void;
  setArchived: (key: string, entry: ArchivedEntry | null) => void;
  rename: (nodeKey: string, name: string) => void;
  setRenaming: (nodeKey: string | null) => void;
  /** Creates a section and starts renaming it; returns its id. */
  createSection: (parentId: string | null) => string;
}

function withEntry<T>(record: Record<string, T>, key: string, value: T | undefined) {
  if (value === undefined) {
    if (!(key in record)) return record;
    const { [key]: _removed, ...rest } = record;
    return rest;
  }
  return { ...record, [key]: value };
}

export const useHomeSectionStore = create<HomeSectionState>()(
  persist(
    (set) => ({
      projectSectionOverrides: {},
      collapsedNodeKeys: {},
      archived: {},
      userSections: {},
      sectionParents: {},
      names: {},
      itemContainers: {},
      userLooseItems: {},
      renamingKey: null,
      showAllKeys: {},
      setShowAll: (projectKey, showAll) =>
        set((state) => ({
          showAllKeys: withEntry(state.showAllKeys, projectKey, showAll ? true : undefined),
        })),
      moveProject: (projectKey, sectionId) =>
        set((state) => ({
          projectSectionOverrides: withEntry(state.projectSectionOverrides, projectKey, sectionId),
        })),
      moveSection: (sectionId, parentId) =>
        set((state) =>
          sectionId in state.userSections
            ? {
                userSections: {
                  ...state.userSections,
                  [sectionId]: { ...state.userSections[sectionId]!, parentId },
                },
              }
            : { sectionParents: { ...state.sectionParents, [sectionId]: parentId } },
        ),
      moveItem: (itemKey, containerKey) =>
        set((state) => ({
          itemContainers: withEntry(state.itemContainers, itemKey, containerKey),
        })),
      setNodeExpanded: (nodeKey, expanded) =>
        set((state) => {
          if ((state.collapsedNodeKeys[nodeKey] === true) !== expanded) return state;
          return {
            collapsedNodeKeys: withEntry(
              state.collapsedNodeKeys,
              nodeKey,
              expanded ? undefined : true,
            ),
          };
        }),
      setArchived: (key, entry) =>
        set((state) => ({ archived: withEntry(state.archived, key, entry ?? undefined) })),
      rename: (nodeKey, name) =>
        set((state) => {
          const trimmed = name.trim();
          if (!trimmed) return { renamingKey: null };
          const sectionId = nodeKey.startsWith("section:") ? nodeKey.slice(8) : null;
          if (sectionId && sectionId in state.userSections) {
            return {
              renamingKey: null,
              userSections: {
                ...state.userSections,
                [sectionId]: { ...state.userSections[sectionId]!, name: trimmed },
              },
            };
          }
          return { renamingKey: null, names: { ...state.names, [nodeKey]: trimmed } };
        }),
      setRenaming: (nodeKey) => set({ renamingKey: nodeKey }),
      createSection: (parentId) => {
        const id = `user-${Date.now().toString(36)}`;
        set((state) => ({
          userSections: { ...state.userSections, [id]: { name: "New section", parentId } },
          renamingKey: `section:${id}`,
          collapsedNodeKeys: parentId
            ? withEntry(state.collapsedNodeKeys, `section:${parentId}`, undefined)
            : state.collapsedNodeKeys,
        }));
        return id;
      },
    }),
    {
      name: "t3code:sidebar:home-sections:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        projectSectionOverrides: state.projectSectionOverrides,
        collapsedNodeKeys: state.collapsedNodeKeys,
        archived: state.archived,
        userSections: state.userSections,
        sectionParents: state.sectionParents,
        names: state.names,
        itemContainers: state.itemContainers,
        userLooseItems: state.userLooseItems,
      }),
    },
  ),
);

export function useHomeNodeExpanded(nodeKey: string): boolean {
  return useHomeSectionStore((state) => state.collapsedNodeKeys[nodeKey] !== true);
}

/** Hides something from your sidebar only, with an Undo toast. */
export function archiveInHome(
  key: string,
  label: string,
  kind: string,
  options: { sharedWithOthers?: boolean } = {},
) {
  const { setArchived } = useHomeSectionStore.getState();
  setArchived(key, { label, kind, archivedAt: new Date().toISOString() });
  toastManager.add({
    id: `home-archive-${key}`,
    type: "success",
    title: `Archived ${label}`,
    ...(options.sharedWithOthers ? { description: "Hidden for you. Others still see it." } : {}),
    timeout: 5000,
    actionProps: { children: "Undo", onClick: () => setArchived(key, null) },
  });
}

/**
 * Registers a new unfiled chat or task so it shows at the top of Home › Chats
 * right away (and resolves at `/shared/<id>` via `findLooseItem`). Persisted
 * locally; calling again with the same id updates its title and kind.
 */
export function addLooseItem(item: {
  readonly id: string;
  readonly title: string;
  readonly kind: "chat" | "task";
  readonly createdAt: string;
}) {
  useHomeSectionStore.setState((state) => ({
    userLooseItems: {
      ...state.userLooseItems,
      [item.id]: { title: item.title, kind: item.kind, createdAt: item.createdAt },
    },
  }));
}
