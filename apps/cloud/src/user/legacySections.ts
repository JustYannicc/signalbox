import type { ProjectId } from "@t3tools/contracts";
import {
  type PoolLevel,
  type ProjectSectionPlacement,
  type ResolvedPool,
  type Section,
  type SectionCreateInput,
  type SectionDeleteInput,
  type SectionMoveInput,
  type SectionProjectMoveInput,
  SectionsRpcError,
  type SectionsSnapshot,
  type SectionUpdateInput,
} from "@t3tools/contracts/sections";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId, type FolderResolvedPool } from "@t3tools/contracts/signalboxFolders";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { SqlError } from "effect/sql/SqlError";

import {
  currentProjectIds,
  filesProjectOf,
  folderOfProject,
  levelOf,
  ownPools,
  poolResolver,
  poolTreeOf,
  type TreeFolder,
} from "./folderTree.ts";
import { chainOf } from "./poolChain.ts";
import { type FolderRefusedError, type FolderState, UserFolders } from "./UserFolders.ts";

/**
 * The `sections.*` contract, served from the user's folders for clients from
 * before folders (#227). A folder without files reads as a section; a folder
 * with files reads as its drive's project, placed in the nearest folder above
 * it that reads as a section. Folders inside one with files have no place in
 * that shape, so they show one level up. Every change goes to `UserFolders`.
 */

type Failure = SectionsRpcError | SqlError;

export class LegacySections extends Context.Service<
  LegacySections,
  {
    readonly snapshot: Effect.Effect<SectionsSnapshot, SqlError>;
    readonly changes: Stream.Stream<SectionsSnapshot, SqlError>;
    readonly create: (input: SectionCreateInput) => Effect.Effect<SectionsSnapshot, Failure>;
    readonly update: (input: SectionUpdateInput) => Effect.Effect<SectionsSnapshot, Failure>;
    readonly move: (input: SectionMoveInput) => Effect.Effect<SectionsSnapshot, Failure>;
    readonly delete: (input: SectionDeleteInput) => Effect.Effect<SectionsSnapshot, Failure>;
    readonly moveProject: (
      input: SectionProjectMoveInput,
    ) => Effect.Effect<SectionsSnapshot, Failure>;
  }
>()("@signalbox/cloud/user/legacySections") {}

/** The folders as sections and project placements. */
export const sectionsOf = (current: FolderState): SectionsSnapshot => {
  const { tree } = current;
  const byId = new Map(tree.folders.map((folder) => [folder.id, folder]));
  const given = new Set(current.drives.map((drive) => drive.driveId));
  const pools = poolTreeOf(tree);
  /** The nearest folder above `folder` that reads as a section, or null for the top level. */
  const sectionAbove = (folder: TreeFolder): FolderId | null => {
    const above = chainOf(pools, levelOf(folder.id))
      .slice(1)
      .find((level) => {
        const parent = level._tag === "folder" ? byId.get(level.folderId) : undefined;
        return parent !== undefined && filesProjectOf(parent, given) === null;
      });
    return above?._tag === "folder" ? above.folderId : null;
  };
  const asLevel = (level: FolderResolvedPool["from"]): PoolLevel => {
    if (level._tag === "top") return level;
    const folder = byId.get(level.folderId);
    const files = folder === undefined ? null : filesProjectOf(folder, given);
    return files === null
      ? { _tag: "section", sectionId: level.folderId }
      : { _tag: "project", projectId: files };
  };
  const resolve = poolResolver(tree);
  const asPool = (home: FolderId | null): ResolvedPool | null => {
    const pool = resolve(home);
    return pool === null ? null : { poolId: pool.poolId, from: asLevel(pool.from) };
  };
  const placed = ownPools(tree);
  const sectionFolders = tree.folders.filter((folder) => filesProjectOf(folder, given) === null);
  return {
    revision: current.revision,
    sections: sectionFolders.map((folder): Section => {
      const poolId = placed.get(folder.id);
      return {
        id: folder.id,
        name: folder.name,
        parentId: sectionAbove(folder),
        position: folder.position,
        contextId: folder.ownerId,
        ...(poolId === undefined ? {} : { defaultPoolId: poolId }),
      };
    }),
    projectPlacements: tree.folders.flatMap((folder): Array<ProjectSectionPlacement> => {
      const projectId = filesProjectOf(folder, given);
      return projectId === null
        ? []
        : [{ projectId, sectionId: sectionAbove(folder), position: folder.position }];
    }),
    pools: {
      top: asPool(null),
      sections: sectionFolders.map((folder) => ({
        sectionId: folder.id,
        pool: asPool(folder.id),
      })),
      projects: currentProjectIds(current.contexts).map((projectId) => ({
        projectId,
        pool: asPool(folderOfProject(tree, projectId)),
      })),
    },
  };
};

const asSectionsError = (error: FolderRefusedError) =>
  new SectionsRpcError({
    code: error.reason === "not-found" ? "section-not-found" : "invalid-move",
    detail: error.message,
  });

const make = Effect.gen(function* () {
  const folders = yield* UserFolders;
  const snapshot = Effect.map(folders.state, sectionsOf);
  const applied = (change: Effect.Effect<unknown, FolderRefusedError | SqlError>) =>
    change.pipe(
      Effect.catchTags({ FolderRefusedError: (error) => Effect.fail(asSectionsError(error)) }),
      Effect.andThen(snapshot),
    );
  const folderId = (id: string | null) => (id === null ? null : FolderId.make(id));

  const folderOf = (projectId: ProjectId) =>
    Effect.map(folders.state, (current) => folderOfProject(current.tree, projectId));

  return LegacySections.of({
    snapshot,
    changes: Stream.map(folders.states, sectionsOf),
    create: (input) =>
      applied(
        folders.create({
          name: input.name,
          parentId: folderId(input.parentId),
          ...(input.beforeId === undefined ? {} : { beforeId: FolderId.make(input.beforeId) }),
          ...(input.contextId === undefined
            ? {}
            : { ownerId: SignalboxContextId.make(input.contextId) }),
        }),
      ),
    update: (input) =>
      applied(
        folders.update({
          id: FolderId.make(input.id),
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.defaultPoolId === undefined ? {} : { poolId: input.defaultPoolId }),
        }),
      ),
    move: (input) =>
      applied(
        folders.move({
          id: FolderId.make(input.id),
          parentId: folderId(input.parentId),
          ...(input.beforeId === undefined ? {} : { beforeId: FolderId.make(input.beforeId) }),
        }),
      ),
    delete: (input) => applied(folders.delete({ id: FolderId.make(input.id) })),
    moveProject: (input) =>
      Effect.gen(function* () {
        const id = yield* folderOf(input.projectId);
        if (id === null) {
          return yield* new SectionsRpcError({
            code: "project-not-found",
            detail: "Your own files stay at the top level. Update Signalbox to move threads.",
          });
        }
        const beforeId =
          input.beforeProjectId === undefined ? null : yield* folderOf(input.beforeProjectId);
        return yield* applied(
          folders.move({
            id,
            parentId: folderId(input.sectionId),
            ...(beforeId === null ? {} : { beforeId }),
          }),
        );
      }),
  });
});

export const layer = Layer.effect(LegacySections, make);
