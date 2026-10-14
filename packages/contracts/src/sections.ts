import * as Schema from "effect/Schema";

import { AccountPoolId } from "./accountHub.ts";
import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type SectionId = typeof SectionId.Type;

const SectionName = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

/**
 * The Signalbox Cloud context (Personal or a work organization) a section
 * organizes. Subsections share their parent's. Absent on self-hosted servers,
 * which have no contexts.
 */
const SectionContextId = TrimmedNonEmptyString;

export const Section = Schema.Struct({
  id: SectionId,
  name: SectionName,
  parentId: Schema.NullOr(SectionId),
  position: NonNegativeInt,
  /**
   * The pool placed at this section. Absent inherits from above. Signalbox
   * Cloud runs every thread on the nearest pool on its chain (`pools`); a
   * self-hosted server only starts new threads in the section on it.
   */
  defaultPoolId: Schema.optional(AccountPoolId),
  contextId: Schema.optionalKey(SectionContextId),
});
export type Section = typeof Section.Type;

export const ProjectSectionPlacement = Schema.Struct({
  projectId: ProjectId,
  sectionId: Schema.NullOr(SectionId),
  position: NonNegativeInt,
});
export type ProjectSectionPlacement = typeof ProjectSectionPlacement.Type;

/** A level a pool can be placed at: the top level, a section, or a project. */
export const PoolLevel = Schema.Union([
  Schema.TaggedStruct("top", {}),
  Schema.TaggedStruct("section", { sectionId: SectionId }),
  Schema.TaggedStruct("project", { projectId: ProjectId }),
]);
export type PoolLevel = typeof PoolLevel.Type;

/** The pool a level runs on, and the level it's placed at. */
export const ResolvedPool = Schema.Struct({ poolId: AccountPoolId, from: PoolLevel });
export type ResolvedPool = typeof ResolvedPool.Type;

/**
 * What every level runs on, as the server resolves it: the nearest pool on
 * its chain (itself, then each section above, then the top level). One pool
 * supplies every harness. Null: no pool on the chain, so its threads need one.
 */
export const SectionsPools = Schema.Struct({
  top: Schema.NullOr(ResolvedPool),
  sections: Schema.Array(
    Schema.Struct({ sectionId: SectionId, pool: Schema.NullOr(ResolvedPool) }),
  ),
  projects: Schema.Array(
    Schema.Struct({ projectId: ProjectId, pool: Schema.NullOr(ResolvedPool) }),
  ),
});
export type SectionsPools = typeof SectionsPools.Type;

/** The current organization tree and project placements for one environment. */
export const SectionsSnapshot = Schema.Struct({
  /** Increases on every committed change and is persisted across restarts. */
  revision: NonNegativeInt,
  sections: Schema.Array(Section),
  /** Explicit placements only. Projects without a row belong to root in project-list order. */
  projectPlacements: Schema.Array(ProjectSectionPlacement),
  /** Only from servers that run threads on pools by hierarchy (Signalbox Cloud). */
  pools: Schema.optionalKey(SectionsPools),
});
export type SectionsSnapshot = typeof SectionsSnapshot.Type;

/** The project's direct section and its parents, nearest parent first, root last. */
export const ProjectSectionChain = Schema.Struct({
  section: Schema.NullOr(Section),
  ancestors: Schema.Array(Section),
});
export type ProjectSectionChain = typeof ProjectSectionChain.Type;

export const SectionCreateInput = Schema.Struct({
  name: SectionName,
  parentId: Schema.NullOr(SectionId),
  beforeId: Schema.optional(SectionId),
  /**
   * The context a top-level section organizes; servers with contexts use their
   * default one when absent, and other servers ignore it.
   */
  contextId: Schema.optionalKey(SectionContextId),
});
export type SectionCreateInput = typeof SectionCreateInput.Type;

/** Changes the given fields; `defaultPoolId: null` makes the section inherit its pool from above. */
export const SectionUpdateInput = Schema.Struct({
  id: SectionId,
  name: Schema.optional(SectionName),
  defaultPoolId: Schema.optional(Schema.NullOr(AccountPoolId)),
});
export type SectionUpdateInput = typeof SectionUpdateInput.Type;

export const SectionMoveInput = Schema.Struct({
  id: SectionId,
  parentId: Schema.NullOr(SectionId),
  beforeId: Schema.optional(SectionId),
});
export type SectionMoveInput = typeof SectionMoveInput.Type;

export const SectionDeleteInput = Schema.Struct({ id: SectionId });
export type SectionDeleteInput = typeof SectionDeleteInput.Type;

export const SectionProjectMoveInput = Schema.Struct({
  projectId: ProjectId,
  sectionId: Schema.NullOr(SectionId),
  beforeProjectId: Schema.optional(ProjectId),
});
export type SectionProjectMoveInput = typeof SectionProjectMoveInput.Type;

export const SectionProjectChainInput = Schema.Struct({ projectId: ProjectId });
export type SectionProjectChainInput = typeof SectionProjectChainInput.Type;

export const SectionsRpcErrorCode = Schema.Literals([
  "section-not-found",
  "invalid-move",
  "invalid-name",
  "project-not-found",
  "storage-failed",
]);
export type SectionsRpcErrorCode = typeof SectionsRpcErrorCode.Type;

/** Safe error returned over RPC; underlying storage causes stay on the server. */
export class SectionsRpcError extends Schema.TaggedError<SectionsRpcError>()("SectionsRpcError", {
  code: SectionsRpcErrorCode,
  detail: TrimmedNonEmptyString,
  sectionId: Schema.optional(SectionId),
  parentId: Schema.optional(Schema.NullOr(SectionId)),
  projectId: Schema.optional(ProjectId),
}) {
  override get message(): string {
    return this.detail;
  }
}
