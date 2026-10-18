import { PullRequestOperationError, type ProjectId, type PullRequestRef } from "@t3tools/contracts";
import { canWriteDrive } from "@t3tools/contracts/signalboxDrives";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { driveOfProject } from "../user/contextProjects.ts";
import { UserDrives } from "../user/UserDrives.ts";
import type { GitHubApi } from "./GitHubApi.ts";
import { PullRequestRepository } from "./PullRequestRepository.ts";
import { AgentPullRequestError, safeApiError } from "./agentPullRequestError.ts";

const refuse = AgentPullRequestError.forCategory;
const decodeEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.optional(Schema.Unknown),
      errors: Schema.optional(
        Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String) })),
      ),
    }),
  ),
);

export const collaborationError = (operation: string) => (error: AgentPullRequestError) =>
  new PullRequestOperationError({
    operation,
    detail: error.message,
    status: error.status,
    ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
    reason:
      error.retryAt !== undefined
        ? "rate-limit"
        : error.category === "not_found"
          ? "not-found"
          : error.category === "not_connected"
            ? "not-connected"
            : error.category === "conflict"
              ? "operation-conflict"
              : error.category === "github_conflict"
                ? "conflict"
                : error.category === "unavailable"
                  ? undefined
                  : error.category,
  });

export const folderCanWritePullRequests = (drives: UserDrives["Service"], projectId: ProjectId) =>
  Effect.gen(function* () {
    const userId = yield* drives.userId;
    const driveId = userId === null ? null : driveOfProject(projectId, userId);
    return driveId !== null && canWriteDrive(yield* drives.access(driveId));
  }).pipe(Effect.orElseSucceed(() => false));

/** Folder authority is checked anew even when a durable receipt can answer the retry. */
export const makePullRequestWriteAccess = Effect.gen(function* () {
  const repositories = yield* PullRequestRepository;
  const drives = yield* UserDrives;
  return (input: PullRequestRef) =>
    Effect.gen(function* () {
      const target = yield* repositories.resolve(input);
      if (!(yield* folderCanWritePullRequests(drives, input.projectId)))
        return yield* refuse("permission");
      return target;
    });
});

export const makeCollaborationQuery =
  (api: GitHubApi) =>
  <A>(
    token: string,
    document: string,
    variables: Readonly<Record<string, unknown>>,
    schema: Schema.Codec<A, unknown>,
  ) =>
    Effect.gen(function* () {
      const text = yield* api.graphql("pullRequestCollaboration", token, document, variables).pipe(
        Effect.mapError((error) =>
          // GraphQL reports a definite rate-limit refusal inside an HTTP 200.
          safeApiError(error.retryAt === undefined ? error : { ...error, status: 429 }),
        ),
      );
      if (text === null) return yield* refuse("not_found", 404);
      const decoded = decodeEnvelope(text);
      if (Option.isNone(decoded)) return yield* refuse("unavailable", 200);
      const { data, errors } = decoded.value;
      if (errors !== undefined && errors.length > 0) {
        // A mutation may have committed before one of its selected fields failed.
        if (
          data != null &&
          typeof data === "object" &&
          Object.values(data).some((value) => value != null)
        )
          return yield* refuse("unavailable", 200);
        const types = errors.map((error) => error.type);
        if (types.every((type) => type === "FORBIDDEN")) return yield* refuse("permission", 403);
        if (types.every((type) => type === "NOT_FOUND")) return yield* refuse("not_found", 404);
        if (types.every((type) => type === "UNPROCESSABLE"))
          return yield* refuse("github_conflict", 422);
        return yield* refuse("unavailable", 200);
      }
      if (data == null) return yield* refuse("unavailable", 200);
      const result = Schema.decodeUnknownOption(schema)(data);
      return Option.isNone(result) ? yield* refuse("unavailable", 200) : result.value;
    });
