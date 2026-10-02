/**
 * Route search, filtering and labels for the Spaces prototype. Everything here
 * reads the placeholder fixtures; swap the imports when Executor sources exist.
 */
import * as Schema from "effect/Schema";

import {
  SPACES_ITEMS,
  SPACES_SOURCES,
  type SpacesConnector,
  type SpacesItemFixture,
  type SpacesItemType,
  type SpacesSourceFixture,
} from "./spacesFixtures";
import type { Space } from "./spacesSpace";

export const SPACES_KINDS = ["documents", "files", "messages", "issues", "links"] as const;
export type SpacesKind = (typeof SPACES_KINDS)[number];

export const SPACES_KIND_LABEL: Record<SpacesKind, string> = {
  documents: "Documents",
  files: "Files",
  messages: "Messages",
  issues: "Issues & to-dos",
  links: "Links",
};

const KIND_BY_TYPE: Record<SpacesItemType, SpacesKind> = {
  doc: "documents",
  sheet: "documents",
  slides: "documents",
  page: "documents",
  note: "documents",
  pdf: "files",
  image: "files",
  album: "files",
  issue: "issues",
  task: "issues",
  message: "messages",
  email: "messages",
  link: "links",
};

export const SPACES_TYPE_LABEL: Record<SpacesItemType, string> = {
  doc: "Document",
  sheet: "Spreadsheet",
  slides: "Presentation",
  page: "Page",
  note: "Note",
  pdf: "PDF",
  image: "Image",
  album: "Album",
  issue: "Issue",
  task: "Task",
  message: "Message",
  email: "Email",
  link: "Link",
};

/** The open space itself is not in the URL; see `spacesSpace.ts`. */
export interface SpacesSearch {
  readonly kind?: SpacesKind;
  readonly source?: string;
  /** The item open in the preview panel, or the selected file in Just Files. */
  readonly item?: string;
  /** A native note open in the editor; replaces the library while set. */
  readonly note?: string;
  /** `files` shows the space as Just Files, the tree agents read and write. */
  readonly lens?: "files";
}

const isSpacesKind = Schema.is(Schema.Literals(SPACES_KINDS));
const isSearchToken = Schema.is(Schema.NonEmptyString);

/** Unknown or malformed params drop out instead of failing the route. */
export function validateSpacesSearch(raw: Record<string, unknown>): SpacesSearch {
  const token = (value: unknown) =>
    isSearchToken(value) && value.length <= 100 ? value : undefined;
  const source = token(raw.source);
  const item = token(raw.item);
  const note = token(raw.note);
  return {
    ...(isSpacesKind(raw.kind) ? { kind: raw.kind } : {}),
    ...(source === undefined ? {} : { source }),
    ...(item === undefined ? {} : { item }),
    ...(note === undefined ? {} : { note }),
    ...(raw.lens === "files" ? { lens: "files" as const } : {}),
  };
}

/** Merges into the current search; an `undefined` value removes that key. */
export function patchSpacesSearch(
  previous: SpacesSearch,
  patch: { readonly [Key in keyof SpacesSearch]?: SpacesSearch[Key] | undefined },
): SpacesSearch {
  const merged: Record<string, unknown> = { ...previous, ...patch };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return validateSpacesSearch(merged);
}

export function spaceSources(space: Space): readonly SpacesSourceFixture[] {
  return SPACES_SOURCES.filter((source) => space.sectionIds.has(source.space));
}

export function findSource(sourceId: string | undefined): SpacesSourceFixture | undefined {
  return SPACES_SOURCES.find((source) => source.id === sourceId);
}

/** Where opening an item goes: native notes open the editor, the rest preview. */
export function openItemSearch(previous: SpacesSearch, item: SpacesItemFixture): SpacesSearch {
  return item.type === "note"
    ? patchSpacesSearch(previous, { note: item.id, item: undefined })
    : patchSpacesSearch(previous, { item: item.id, note: undefined });
}

export function itemKind(item: SpacesItemFixture): SpacesKind {
  return KIND_BY_TYPE[item.type];
}

/** Synced items only, newest first. `useSpaceItems` adds the native notes. */
export function spaceItems(space: Space): readonly SpacesItemFixture[] {
  return SPACES_ITEMS.filter((item) => space.sectionIds.has(item.space)).toSorted((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

export function countBy<T>(
  items: readonly SpacesItemFixture[],
  key: (item: SpacesItemFixture) => T,
) {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

export function matchesQuery(item: SpacesItemFixture, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [item.name, item.location, item.owner, item.excerpt].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

/** Compact age for dense rows: 12m, 3h, 2d, 3w, 2mo, 1y. */
export function formatAge(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function describeSync(source: SpacesSourceFixture): string {
  if (source.sync === "syncing") return "Syncing";
  if (source.sync === "error") return "Needs reconnecting";
  const age = formatAge(source.lastSyncedAt);
  return age === "now" ? "Synced just now" : `Synced ${age} ago`;
}

export function itemConnector(item: SpacesItemFixture): SpacesConnector {
  return findSource(item.source)?.connector ?? "notes";
}
