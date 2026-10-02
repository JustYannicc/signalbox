/**
 * Which space is open. A space is a Home section (Work › Northwind team,
 * Personal) with everything nested under it, or All: every section Focus
 * leaves in sight. The last-used one persists so the rail and /pull-requests
 * keep it; All is the default.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import { focusModeInfo, useFocusMode, type FocusMode } from "../sidebar/focus/focusStore";
import {
  HOME_SECTIONS,
  rootSectionIdOf,
  sectionPathLabel,
  type HomeSection,
} from "../sidebar/sections/sectionModel";

export const ALL_SPACE_ID = "all";

export interface Space {
  /** A Home section id, or `all`. */
  readonly id: string;
  readonly name: string;
  /** "Work › Northwind team"; "All" for the combined space. */
  readonly label: string;
  /** Sections whose items and sources this space shows. */
  readonly sectionIds: ReadonlySet<string>;
  /** Where "New page" lands. */
  readonly newNoteSectionId: string;
  /** Just Files root, e.g. `/spaces/work/northwind-team` or `/spaces`. */
  readonly root: string;
}

interface SpacesPlaceState {
  sectionId: string;
  /** Set by the sidebar's search button; the page focuses its field and clears it. */
  searchFocusPending: boolean;
  setSectionId: (sectionId: string) => void;
  requestSearchFocus: () => void;
  clearSearchFocus: () => void;
}

export const useSpacesPlace = create<SpacesPlaceState>()(
  persist(
    (set) => ({
      sectionId: ALL_SPACE_ID,
      searchFocusPending: false,
      setSectionId: (sectionId) => set({ sectionId }),
      requestSearchFocus: () => set({ searchFocusPending: true }),
      clearSearchFocus: () => set({ searchFocusPending: false }),
    }),
    {
      name: "t3code:spaces:section:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ sectionId: state.sectionId }),
    },
  ),
);

export function visibleSections(mode: FocusMode): readonly HomeSection[] {
  const hidden = new Set(focusModeInfo(mode).hiddenRootSectionIds);
  return HOME_SECTIONS.filter((section) => !hidden.has(rootSectionIdOf(section.id)));
}

/** The section and every section nested in it. */
function descendantIds(sectionId: string): Set<string> {
  const ids = new Set([sectionId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const section of HOME_SECTIONS) {
      if (section.parentId && ids.has(section.parentId) && !ids.has(section.id)) {
        ids.add(section.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** A single section as a space, visible or not (notes know their section). */
export function sectionSpace(sectionId: string): Space | undefined {
  const section = HOME_SECTIONS.find((entry) => entry.id === sectionId);
  if (!section) return undefined;
  return {
    id: section.id,
    name: section.name,
    label: sectionPathLabel(section.id),
    sectionIds: descendantIds(section.id),
    newNoteSectionId: section.id,
    root: spaceRootPath(section.id),
  };
}

function allSpace(sections: readonly HomeSection[]): Space {
  const ids = new Set(sections.map((section) => section.id));
  return {
    id: ALL_SPACE_ID,
    name: "All",
    label: "All",
    sectionIds: ids,
    newNoteSectionId: ids.has("personal") ? "personal" : (sections[0]?.id ?? "personal"),
    root: "/spaces",
  };
}

/**
 * The open space (falling back to All when Focus hides the saved one), the
 * switcher's choices, and the visible sections a note can move to.
 */
export function useCurrentSpace(): {
  space: Space;
  spaces: readonly Space[];
  sections: readonly HomeSection[];
} {
  const mode = useFocusMode();
  const sectionId = useSpacesPlace((state) => state.sectionId);
  return useMemo(() => {
    const sections = visibleSections(mode);
    const spaces = [
      allSpace(sections),
      ...sections.flatMap((section) => sectionSpace(section.id) ?? []),
    ];
    const space = spaces.find((entry) => entry.id === sectionId) ?? spaces[0]!;
    return { space, spaces, sections };
  }, [mode, sectionId]);
}

const slug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** `/spaces/work/northwind-team`: the folder a section's files live in. */
export function spaceRootPath(sectionId: string): string {
  return `/spaces/${sectionPathLabel(sectionId).split(" › ").map(slug).join("/")}`;
}

export function sectionName(sectionId: string): string | undefined {
  return HOME_SECTIONS.find((section) => section.id === sectionId)?.name;
}
