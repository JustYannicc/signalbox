/**
 * A space is the slice of synced items and notes a place page reads from: one
 * Home section with everything nested under it, or Everything (each section
 * Focus leaves in sight) when /spaces opens without a place. Which place is
 * open lives in the URL; see `spacesPlace.ts`.
 */
import {
  HOME_SECTIONS,
  sectionPathLabel,
  type HomeSection,
} from "../sidebar/sections/sectionModel";
import { isSectionInFocus } from "../sidebar/focus/focusLevels";
import type { LevelKey } from "../levels/levels";

export interface Space {
  /** A Home section id, or `everything`. */
  readonly id: string;
  readonly name: string;
  /** "Work › Northwind team"; "Everything" for the combined space. */
  readonly label: string;
  /** Sections whose items and sources this space shows. */
  readonly sectionIds: ReadonlySet<string>;
  /** Just Files root, e.g. `/spaces/work/northwind-team` or `/spaces`. */
  readonly root: string;
}

export function visibleSections(focused: LevelKey): readonly HomeSection[] {
  return HOME_SECTIONS.filter((section) => isSectionInFocus(section.id, focused));
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

/** A single section as a space, visible or not (notes and accounts know their section). */
export function sectionSpace(sectionId: string): Space | undefined {
  const section = HOME_SECTIONS.find((entry) => entry.id === sectionId);
  if (!section) return undefined;
  return {
    id: section.id,
    name: section.name,
    label: sectionPathLabel(section.id),
    sectionIds: descendantIds(section.id),
    root: spaceRootPath(section.id),
  };
}

export function everythingSpace(sections: readonly HomeSection[]): Space {
  return {
    id: "everything",
    name: "Everything",
    label: "Everything",
    sectionIds: new Set(sections.map((section) => section.id)),
    root: "/spaces",
  };
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
