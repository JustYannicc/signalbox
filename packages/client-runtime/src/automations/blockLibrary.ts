/**
 * Settings → Block library as plain data: the levels a person can look from,
 * and what `automations.listBlocks` answers grouped by the level each block
 * comes from. Pure; web and mobile draw it.
 */
import type { AutomationBlockLibraryEntry, EnvironmentId, ProjectId } from "@t3tools/contracts";
import type {
  SignalboxContextId,
  SignalboxContextsSnapshot,
} from "@t3tools/contracts/signalboxContexts";
import type { SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";

import {
  folderDestinations,
  folderPath,
  ownerFilesProject,
  ownerLevelName,
} from "../state/foldersModel.ts";

export const BLOCK_LIBRARY_INTRO =
  "Blocks are automations other automations can call by name. When two levels have a block with the same name, the one nearest this folder is used.";

export const BLOCK_LIBRARY_DISCONNECTED =
  "Connect to Signalbox Cloud to see the blocks your automations can call.";

export const BLOCK_LIBRARY_NO_TARGET =
  "Blocks live in a folder's files. Give a folder files of its own to see what its automations can call.";

export const BLOCK_LIBRARY_EMPTY =
  "No blocks here. Automations saved in this folder or the levels above it show up here.";

export const BLOCK_LIBRARY_STALE_TARGET =
  "That folder isn't available anymore: it was moved out of reach, lost its files, or was deleted. Choose another one.";

/** A level above the one being looked from whose blocks it can use. */
export interface BlockLibraryAncestor {
  readonly projectId: ProjectId;
  readonly label: string;
  readonly kind: "folder" | "top";
}

/**
 * A level the library can look from. Only levels with files of their own:
 * automations live in a project, so a folder without files has none.
 */
export interface BlockLibraryTarget {
  /** The page's `level` search value. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly ownerId: SignalboxContextId;
  readonly ownerName: string;
  /** Owner, then the folder path: "Top level / Work / Clients", "Acme". */
  readonly label: string;
  /** Nearest first: folders above it with files, then its owner's top level. */
  readonly ancestors: ReadonlyArray<BlockLibraryAncestor>;
}

/**
 * Every level in an environment the library can look from: each owner's top
 * level, then its folders with files, in tree order.
 */
export function blockLibraryTargets(
  environmentId: EnvironmentId,
  contexts: SignalboxContextsSnapshot,
  snapshot: SignalboxFoldersSnapshot,
): ReadonlyArray<BlockLibraryTarget> {
  const targets: Array<BlockLibraryTarget> = [];
  for (const context of contexts.contexts) {
    const ownerName = ownerLevelName(context);
    const topProjectId = ownerFilesProject(context);
    const top: ReadonlyArray<BlockLibraryAncestor> =
      topProjectId === null ? [] : [{ projectId: topProjectId, label: ownerName, kind: "top" }];
    if (topProjectId !== null) {
      targets.push({
        key: `${environmentId}:top:${context.id}`,
        environmentId,
        projectId: topProjectId,
        ownerId: context.id,
        ownerName,
        label: ownerName,
        ancestors: [],
      });
    }
    const destinations = folderDestinations(snapshot, context.id);
    const labels = new Map(
      destinations.map((destination) => [
        destination.folder.id,
        `${ownerName} / ${destination.label}`,
      ]),
    );
    for (const { folder } of destinations) {
      if (folder.files === undefined) continue;
      // Nearest first; folders without files hold no blocks, so they're skipped.
      const above: Array<BlockLibraryAncestor> = [];
      const path = folderPath(snapshot, folder.parentId);
      for (let index = path.length - 1; index >= 0; index--) {
        const ancestor = path[index]!;
        if (ancestor.files === undefined) continue;
        above.push({
          projectId: ancestor.files.projectId,
          label: labels.get(ancestor.id) ?? ownerName,
          kind: "folder",
        });
      }
      targets.push({
        key: `${environmentId}:folder:${folder.id}`,
        environmentId,
        projectId: folder.files.projectId,
        ownerId: context.id,
        ownerName,
        label: labels.get(folder.id)!,
        ancestors: [...above, ...top],
      });
    }
  }
  return targets;
}

export type BlockLibraryGroupKind = "here" | "folder" | "top" | "builtin" | "unknown";

export interface BlockLibraryGroup {
  readonly key: string;
  readonly kind: BlockLibraryGroupKind;
  readonly title: string;
  readonly blocks: ReadonlyArray<AutomationBlockLibraryEntry>;
}

const byName = (left: AutomationBlockLibraryEntry, right: AutomationBlockLibraryEntry) =>
  left.name.localeCompare(right.name);

/**
 * The winners grouped by where they come from, nearest first: this level, the
 * folders above it, its owner's top level, then built-ins. A saved block from
 * a project this tree doesn't place still shows, under "Other levels".
 */
export function groupBlockLibrary(
  target: Pick<BlockLibraryTarget, "projectId" | "label" | "ancestors">,
  blocks: ReadonlyArray<AutomationBlockLibraryEntry>,
): ReadonlyArray<BlockLibraryGroup> {
  const levels: ReadonlyArray<{
    projectId: ProjectId;
    title: string;
    kind: BlockLibraryGroupKind;
  }> = [
    { projectId: target.projectId, title: target.label, kind: "here" },
    ...target.ancestors.map((ancestor) => ({
      projectId: ancestor.projectId,
      title: ancestor.label,
      kind: ancestor.kind,
    })),
  ];
  const group = (key: string, kind: BlockLibraryGroupKind, title: string) => ({
    key,
    kind,
    title,
    blocks: [] as Array<AutomationBlockLibraryEntry>,
  });
  const groups = levels.map((level) =>
    group(`project:${level.projectId}`, level.kind, level.title),
  );
  const byProject = new Map<ProjectId, (typeof groups)[number]>();
  // A project twice on the chain (folders sharing files) belongs to the nearest.
  levels.forEach((level, index) => {
    if (!byProject.has(level.projectId)) byProject.set(level.projectId, groups[index]!);
  });
  const builtIn = group("builtin", "builtin", "Built-in");
  const unknown = group("unknown", "unknown", "Other levels");
  for (const block of blocks) {
    if (block.source.type === "builtin") builtIn.blocks.push(block);
    else (byProject.get(block.source.projectId) ?? unknown).blocks.push(block);
  }
  // Hermes (mobile) has no Array#toSorted; each group's array is already its own.
  return [...groups, builtIn, unknown]
    .filter((entry) => entry.blocks.length > 0)
    .map((entry) => ({ ...entry, blocks: entry.blocks.sort(byName) }));
}

/** What a block runs as, given the client's label for its fixed mode; null inherits the caller's. */
export function blockPermissionsLabel(modeLabel: string | null): string {
  return modeLabel === null ? "Runs with the caller's permissions" : `Runs with ${modeLabel}`;
}

/**
 * Why the block a name resolves to won't start right now. The nearest block
 * wins even when it can't run, so nothing here suggests a farther one.
 */
export function blockLibraryStatuses(
  availability: AutomationBlockLibraryEntry["availability"],
): ReadonlyArray<"Paused" | "Not published"> {
  return [
    ...(availability.enabled ? [] : ["Paused" as const]),
    ...(availability.hasLiveVersion ? [] : ["Not published" as const]),
  ];
}
