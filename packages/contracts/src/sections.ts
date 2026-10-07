import * as Schema from "effect/Schema";

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
  contextId: Schema.optionalKey(SectionContextId),
});
export type Section = typeof Section.Type;

export const ProjectSectionPlacement = Schema.Struct({
  projectId: ProjectId,
  sectionId: Schema.NullOr(SectionId),
  position: NonNegativeInt,
});
export type ProjectSectionPlacement = typeof ProjectSectionPlacement.Type;

/** The current organization tree and project placements for one environment. */
export const SectionsSnapshot = Schema.Struct({
  /** Increases on every committed change and is persisted across restarts. */
  revision: NonNegativeInt,
  sections: Schema.Array(Section),
  /** Explicit placements only. Projects without a row belong to root in project-list order. */
  projectPlacements: Schema.Array(ProjectSectionPlacement),
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

export const SectionUpdateInput = Schema.Struct({
  id: SectionId,
  name: SectionName,
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
