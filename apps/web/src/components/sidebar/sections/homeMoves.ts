/**
 * Moving things around Home, by drag or by "Move to…": items go to any
 * container, projects to any section, sections under any other section (never
 * into themselves) or to the top level. Local only; a toast confirms.
 */
import {
  createContext,
  useContext,
  useState,
  type DragEvent as ReactDragEvent,
  type HTMLAttributes,
} from "react";

import { toastManager } from "../../ui/toast";
import { isSectionWithin } from "./sectionModel";
import { ROOT_CONTAINER_KEY, useHomeSectionStore } from "./sectionStore";
import type { MoveDestination } from "./useHomeSectionTree";

export type HomeMovable =
  | { readonly kind: "item"; readonly key: string; readonly label: string }
  /** `projectKey` for real projects, `team-project:<id>` for team projects. */
  | { readonly kind: "project"; readonly key: string; readonly label: string }
  | { readonly kind: "section"; readonly id: string; readonly label: string };

const DRAG_MIME: Record<HomeMovable["kind"], string> = {
  item: "application/x-t3code-home-item",
  project: "application/x-t3code-home-project",
  section: "application/x-t3code-home-section",
};

export function startHomeDrag(event: ReactDragEvent, movable: HomeMovable) {
  event.stopPropagation();
  event.dataTransfer.setData(DRAG_MIME[movable.kind], JSON.stringify(movable));
  event.dataTransfer.setData("text/plain", movable.label);
  event.dataTransfer.effectAllowed = "move";
}

/** Which kinds a container accepts: sections take everything, projects take items. */
export function acceptedKinds(containerKey: string): readonly HomeMovable["kind"][] {
  if (containerKey === ROOT_CONTAINER_KEY || containerKey.startsWith("section:")) {
    return ["item", "project", "section"];
  }
  return ["item"];
}

export function draggedKind(event: ReactDragEvent, containerKey: string) {
  return acceptedKinds(containerKey).find((kind) =>
    event.dataTransfer.types.includes(DRAG_MIME[kind]),
  );
}

export function readHomeDrag(event: ReactDragEvent, containerKey: string): HomeMovable | null {
  const kind = draggedKind(event, containerKey);
  if (!kind) return null;
  try {
    return JSON.parse(event.dataTransfer.getData(DRAG_MIME[kind])) as HomeMovable;
  } catch {
    return null;
  }
}

/** Applies a move; returns false when the destination doesn't take it. */
export function moveTo(movable: HomeMovable, destination: MoveDestination): boolean {
  const store = useHomeSectionStore.getState();
  const sectionId = destination.key.startsWith("section:") ? destination.key.slice(8) : null;
  if (movable.kind === "item") {
    store.moveItem(movable.key, destination.key);
  } else if (movable.kind === "project") {
    if (!sectionId) return false;
    store.moveProject(movable.key, sectionId);
  } else {
    if (destination.kind === "project") return false;
    if (sectionId && isSectionWithin(sectionId, movable.id)) return false;
    store.moveSection(movable.id, sectionId);
  }
  toastManager.add({
    id: "home-move",
    type: "success",
    title: `Moved ${movable.label} to ${destination.label}`,
    timeout: 2000,
  });
  return true;
}

/** Destinations a thing can go, for its "Move to…" list. */
export function destinationsFor(
  movable: HomeMovable,
  all: readonly MoveDestination[],
): readonly MoveDestination[] {
  if (movable.kind === "item") return all;
  if (movable.kind === "project")
    return all.filter((destination) => destination.kind === "section");
  return all.filter(
    (destination) =>
      destination.kind === "root" ||
      (destination.kind === "section" && !isSectionWithin(destination.key.slice(8), movable.id)),
  );
}

export const HomeDestinationsContext = createContext<readonly MoveDestination[]>([]);

export function useHomeDestinations() {
  return useContext(HomeDestinationsContext);
}

/** Drop wiring for a node row; `null` makes the row inert. */
export function useHomeDropTarget(destination: MoveDestination | null): {
  dropActive: boolean;
  dropProps: HTMLAttributes<HTMLElement>;
} {
  const [dropActive, setDropActive] = useState(false);
  if (!destination) return { dropActive: false, dropProps: {} };
  return {
    dropActive,
    dropProps: {
      onDragOver: (event) => {
        if (!draggedKind(event, destination.key)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDropActive(true);
      },
      onDragLeave: (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
      },
      onDrop: (event) => {
        setDropActive(false);
        const movable = readHomeDrag(event, destination.key);
        if (!movable) return;
        event.preventDefault();
        event.stopPropagation();
        moveTo(movable, destination);
      },
    },
  };
}
