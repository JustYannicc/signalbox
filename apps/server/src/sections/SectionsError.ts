import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type SectionStorageOperation =
  | "read-snapshot"
  | "create"
  | "update"
  | "move-section"
  | "delete"
  | "move-project"
  | "project-chain"
  | "generate-id";

export class SectionStorageError extends Schema.TaggedError<SectionStorageError>()(
  "SectionStorageError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The sections store failed during ${this.operation}.`;
  }
}

export class SectionNotFoundError extends Schema.TaggedError<SectionNotFoundError>()(
  "SectionNotFoundError",
  { sectionId: Schema.String },
) {
  override get message(): string {
    return "That section no longer exists.";
  }
}

export class SectionInvalidNameError extends Schema.TaggedError<SectionInvalidNameError>()(
  "SectionInvalidNameError",
  { reason: Schema.Literals(["empty", "too-long", "invalid-type"]) },
) {
  override get message(): string {
    return "Section names must contain between 1 and 128 characters.";
  }
}

export class SectionInvalidMoveError extends Schema.TaggedError<SectionInvalidMoveError>()(
  "SectionInvalidMoveError",
  {
    reason: Schema.Literals(["cycle", "anchor-not-sibling"]),
    sectionId: Schema.optional(Schema.String),
    parentId: Schema.optional(Schema.NullOr(Schema.String)),
    projectId: Schema.optional(ProjectId),
    anchorId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason === "cycle"
      ? "A section cannot be moved into itself or one of its descendants."
      : "The insertion point must be a sibling in the destination.";
  }
}

export class SectionProjectNotFoundError extends Schema.TaggedError<SectionProjectNotFoundError>()(
  "SectionProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "That project no longer exists.";
  }
}

export const SectionError = Schema.Union([
  SectionNotFoundError,
  SectionInvalidNameError,
  SectionInvalidMoveError,
  SectionProjectNotFoundError,
  SectionStorageError,
]);
export type SectionError = typeof SectionError.Type;

const isSectionError = Schema.is(SectionError);

export const mapSectionStorageError =
  (operation: SectionStorageOperation) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, SectionError, R> =>
    effect.pipe(
      Effect.mapError((cause) =>
        isSectionError(cause) ? cause : new SectionStorageError({ operation, cause }),
      ),
    );
