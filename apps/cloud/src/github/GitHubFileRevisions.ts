import { PullRequestOperationError, type PullRequestDiffRevision } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { decodeGraphqlData } from "./GitHubGraphql.ts";
import type { GitHubApi, GitHubError } from "./GitHubApi.ts";
import type { PullRequestDiffFile, PullRequestFileRevisionTarget } from "./PullRequestDiffFiles.ts";
import type { PullRequestReadError } from "./CloudPullRequestsService.ts";

const MAX_FILES = 500;
const FILES_PER_QUERY = 50;

const FileObject = Schema.Struct({
  __typename: Schema.String,
  oid: Schema.String,
});
const FileObjects = Schema.Struct({
  repository: Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(FileObject))),
});
const decodeFileObjects = decodeGraphqlData(FileObjects);

const operationError = (detail: string, cause?: unknown) =>
  new PullRequestOperationError({
    operation: "filesViewed",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const apiError = (error: GitHubError) =>
  new PullRequestOperationError({
    operation: "filesViewed",
    detail:
      error.retryAt === undefined
        ? "GitHub could not provide the changed file revisions. Try again."
        : "GitHub's rate limit is reached. Retry after the indicated time.",
    ...(error.retryAt === undefined
      ? {}
      : { reason: "rate-limit" as const, retryAt: error.retryAt }),
    cause: error,
  });

interface ObjectRequest {
  readonly alias: string;
  readonly variable: string;
  readonly expression: string;
}

const queryFor = (objects: ReadonlyArray<ObjectRequest>) => {
  const definitions = objects.map((object) => `$${object.variable}: String!`).join(", ");
  const fields = objects
    .map((object) => `${object.alias}: object(expression: $${object.variable}) { __typename oid }`)
    .join("\n");
  return `query PullRequestFileRevisions($owner: String!, $name: String!, ${definitions}) {
    repository(owner: $owner, name: $name) {
      ${fields}
    }
  }`;
};

const oidFrom = (
  answer: Readonly<Record<string, typeof FileObject.Type | null>>,
  alias: string,
) => {
  if (!Object.hasOwn(answer, alias)) return null;
  const file = answer[alias];
  return file?.__typename === "Blob" ? file.oid : null;
};

const readChunk = (
  api: GitHubApi,
  target: PullRequestFileRevisionTarget,
  revision: PullRequestDiffRevision,
  files: ReadonlyArray<PullRequestDiffFile>,
) =>
  Effect.gen(function* () {
    const repository = target.repository.split("/");
    const owner = repository[0];
    const name = repository[1];
    if (owner === undefined || name === undefined || repository.length !== 2)
      return yield* operationError("The authorized GitHub repository could not be verified.");

    const objects: ObjectRequest[] = [];
    const requested = files.map((file, index) => {
      const oldAlias = file.oldPath === null ? null : `old${index}`;
      const newAlias = file.newPath === null ? null : `new${index}`;
      if (oldAlias !== null)
        objects.push({
          alias: oldAlias,
          variable: `expr${objects.length}`,
          expression: `${revision.baseSha}:${file.oldPath}`,
        });
      if (newAlias !== null)
        objects.push({
          alias: newAlias,
          variable: `expr${objects.length}`,
          expression: `${revision.headSha}:${file.newPath}`,
        });
      return { file, oldAlias, newAlias };
    });

    const variables: Record<string, string> = { owner, name };
    for (const object of objects) variables[object.variable] = object.expression;
    const text = yield* api
      .graphql("pullRequestFileRevisions", target.token, queryFor(objects), variables)
      .pipe(Effect.mapError(apiError));
    if (text === null)
      return yield* operationError("GitHub could not provide the changed file revisions.");
    const decoded = decodeFileObjects(text);
    if (Option.isNone(decoded) || decoded.value.repository === null)
      return yield* operationError("GitHub could not provide the changed file revisions.");

    const answer = decoded.value.repository;
    const revisions = new Map<string, string>();
    for (const { file, oldAlias, newAlias } of requested) {
      const oldOid = oldAlias === null ? null : oidFrom(answer, oldAlias);
      const newOid = newAlias === null ? null : oidFrom(answer, newAlias);
      if ((oldAlias !== null && oldOid === null) || (newAlias !== null && newOid === null))
        return yield* operationError("GitHub could not verify a changed file's blob revision.");
      revisions.set(
        file.path,
        [file.path, file.oldPath ?? "", oldOid ?? "", file.newPath ?? "", newOid ?? ""].join(
          "\u0000",
        ),
      );
    }
    return revisions;
  });

/** Reads exact before/after blob OIDs for the verified immutable diff. */
export const makePullRequestFileRevisions =
  (api: GitHubApi) =>
  (
    target: PullRequestFileRevisionTarget,
    revision: PullRequestDiffRevision,
    files: ReadonlyArray<PullRequestDiffFile>,
  ): Effect.Effect<ReadonlyMap<string, string>, PullRequestReadError> => {
    if (files.length > MAX_FILES)
      return Effect.fail(operationError("Too many changed files were requested."));
    if (files.length === 0) return Effect.succeed(new Map());

    return Effect.gen(function* () {
      const revisions = new Map<string, string>();
      for (let offset = 0; offset < files.length; offset += FILES_PER_QUERY) {
        const page = yield* readChunk(
          api,
          target,
          revision,
          files.slice(offset, offset + FILES_PER_QUERY),
        );
        for (const [path, value] of page) revisions.set(path, value);
      }
      return revisions;
    });
  };
