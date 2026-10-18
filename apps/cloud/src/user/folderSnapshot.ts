import type { Folder, SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";

import {
  byPosition,
  currentProjectIds,
  filesProjectOf,
  folderOfProject,
  ownPools,
  poolResolver,
} from "./folderTree.ts";
import type { FolderState } from "./UserFolders.ts";

/**
 * The tree as `signalbox.folders.*` sends it: every folder, filed thread,
 * project home, pool, secrets reference and GitHub lend.
 */
export const toSnapshot = (current: FolderState): SignalboxFoldersSnapshot => {
  const { tree } = current;
  const resolve = poolResolver(tree);
  const placed = ownPools(tree);
  const given = new Set(current.drives.map((drive) => drive.driveId));
  const folderIds = new Set(tree.folders.map((folder) => folder.id));
  return {
    revision: current.revision,
    top: {
      ...(tree.topInstructions === null ? {} : { instructions: tree.topInstructions }),
      ...(tree.topSecrets === null ? {} : { secrets: { environmentId: tree.topSecrets } }),
    },
    // When it was connected, never the token.
    ...(current.onePasswordConnectedAt === null
      ? {}
      : { onePassword: { connectedAt: current.onePasswordConnectedAt } }),
    folders: byPosition(tree.folders).map((folder): Folder => {
      const files = filesProjectOf(folder, given);
      const poolId = placed.get(folder.id);
      const githubLend = current.githubLends.get(folder.id);
      return {
        id: folder.id,
        name: folder.name,
        ...(folder.origin == null ? {} : { origin: folder.origin }),
        parentId: folder.parentId,
        position: folder.position,
        ownerId: folder.ownerId,
        ...(files === null ? {} : { files: { projectId: files } }),
        ...(poolId === undefined ? {} : { poolId }),
        ...(folder.instructions === null ? {} : { instructions: folder.instructions }),
        ...(folder.secrets === null ? {} : { secrets: { environmentId: folder.secrets } }),
        ...(folder.phase === null ? {} : { phase: folder.phase }),
        ...(githubLend === undefined ? {} : { githubLend }),
      };
    }),
    threadHomes: [...tree.filed].flatMap(([threadId, folderId]) =>
      folderId === null || folderIds.has(folderId) ? [{ threadId, folderId }] : [],
    ),
    projectHomes: currentProjectIds(current.contexts).map((projectId) => ({
      projectId,
      folderId: folderOfProject(tree, projectId),
    })),
    pools: {
      top: resolve(null),
      folders: tree.folders.map((folder) => ({ folderId: folder.id, pool: resolve(folder.id) })),
    },
  };
};
