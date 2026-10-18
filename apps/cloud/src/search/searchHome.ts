import type { SearchHome } from "./SearchIndex.ts";

/** Existing cloud homes have globally named drive/folder ids. Only Scratch is person-local. */
export const searchHomeForThread = (
  ownerUserId: string,
  contextId: string,
  projectId: string,
): SearchHome => ({
  ownerId: projectId === "scratch" ? ownerUserId : contextId,
  projectId,
});
