import {
  type PullRequestDiffFileContentsInput,
  type PullRequestDiffFileContentsResult,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
  type PullRequestDiffRevision,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  decodeCommitFilesJson,
  decodePullRequestFilesJson,
  type GitHubPullRequestFilesPatch,
} from "@t3tools/source-control-github/server/gitHubPullRequestJson";

import { type GitHubApi, unreadable } from "./GitHubApi.ts";

const DIFF_PAGE_SIZE = 100;
const DIFF_FILE_LIMIT = 3_000;
const DIFF_PAGE_LIMIT = DIFF_FILE_LIMIT / DIFF_PAGE_SIZE;
const FILE_CONTENT_LIMIT = 1_048_576;
const DIFF_OUTPUT_LIMIT = 8 * FILE_CONTENT_LIMIT;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const COMMIT_SHA = /^[0-9a-f]{7,64}$/iu;
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu;

const PullRequestRevisions = Schema.Struct({
  base: Schema.Struct({ sha: Schema.String }),
  head: Schema.Struct({ sha: Schema.String }),
  changed_files: Schema.optional(Schema.Int),
});
const CommitRevisions = Schema.Struct({
  sha: Schema.String,
  parents: Schema.Array(Schema.Struct({ sha: Schema.String })),
});
const CompareRevisions = Schema.Struct({
  base_commit: Schema.Struct({ sha: Schema.String }),
  merge_base_commit: Schema.Struct({ sha: Schema.String }),
  changed_files: Schema.optional(Schema.Int),
});
const ContentFile = Schema.Struct({
  type: Schema.String,
  encoding: Schema.String,
  size: Schema.Int,
  content: Schema.String,
});

const decodePullRequestRevisions = Schema.decodeUnknownOption(
  Schema.fromJsonString(PullRequestRevisions),
);
const decodeCommitRevisions = Schema.decodeUnknownOption(Schema.fromJsonString(CommitRevisions));
const decodeCompareRevisions = Schema.decodeUnknownOption(Schema.fromJsonString(CompareRevisions));
const decodeContentFile = Schema.decodeUnknownOption(Schema.fromJsonString(ContentFile));

interface DiffCursor {
  readonly kind: "pull-request" | "commit";
  /** The mutable pull-request base, or a commit's first parent. */
  readonly sourceBaseSha: string;
  /** The merge base shown to the user, or the commit's first parent. */
  readonly baseSha: string;
  readonly headSha: string;
  readonly page: number;
  readonly changedFiles: number | null;
  readonly filesRead: number;
}

interface ResolvedDiff {
  readonly sourceBaseSha: string;
  readonly revision: PullRequestDiffRevision;
  readonly changedFiles: number | null;
}

interface PullRequestRefs {
  readonly baseSha: string;
  readonly headSha: string;
  readonly changedFiles: number | null;
}

const validSha = (value: string) => COMMIT_SHA.test(value);
const validFullSha = (value: string) => FULL_SHA.test(value);

const repositoryPath = (repository: string) => {
  const parts = repository.trim().split("/");
  return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9._-]+$/u.test(part))
    ? parts.map(encodeURIComponent).join("/")
    : null;
};

const pathRoot = (repository: string) => {
  const path = repositoryPath(repository);
  return path === null ? null : `/repos/${path}`;
};

const fail = (operation: string) => unreadable(operation);

const decodeOrFail = <A>(
  operation: string,
  decode: Option.Option<A>,
): Effect.Effect<A, import("./GitHubApi.ts").GitHubError> =>
  Option.isSome(decode) ? Effect.succeed(decode.value) : fail(operation);

const readPullRequestRefs = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
): Effect.Effect<PullRequestRefs, import("./GitHubApi.ts").GitHubError> =>
  Effect.gen(function* () {
    const root = pathRoot(repository);
    if (root === null) return yield* fail("pullRequestDiff");
    const pullText = yield* api.rest("pullRequestDiffRefs", token, `${root}/pulls/${number}`);
    if (pullText === null) return yield* fail("pullRequestDiff");
    const pull = yield* decodeOrFail("pullRequestDiff", decodePullRequestRevisions(pullText));
    if (!validFullSha(pull.base.sha) || !validFullSha(pull.head.sha)) {
      return yield* fail("pullRequestDiff");
    }
    return {
      baseSha: pull.base.sha,
      headSha: pull.head.sha,
      changedFiles: pull.changed_files ?? null,
    };
  });

const resolvePullRequestDiffFromRefs = (
  api: GitHubApi,
  token: string,
  repository: string,
  refs: PullRequestRefs,
): Effect.Effect<ResolvedDiff, import("./GitHubApi.ts").GitHubError> =>
  Effect.gen(function* () {
    const root = pathRoot(repository);
    if (root === null) return yield* fail("pullRequestDiff");
    const compareText = yield* api.rest(
      "pullRequestDiffMergeBase",
      token,
      `${root}/compare/${refs.baseSha}...${refs.headSha}`,
      { per_page: "1", page: "2" },
    );
    if (compareText === null) return yield* fail("pullRequestDiff");
    const compare = yield* decodeOrFail("pullRequestDiff", decodeCompareRevisions(compareText));
    if (
      compare.base_commit.sha.toLowerCase() !== refs.baseSha.toLowerCase() ||
      !validFullSha(compare.merge_base_commit.sha)
    ) {
      return yield* fail("pullRequestDiff");
    }
    return {
      sourceBaseSha: refs.baseSha,
      revision: { baseSha: compare.merge_base_commit.sha, headSha: refs.headSha },
      changedFiles: refs.changedFiles,
    };
  });

const resolveCommitDiff = (
  api: GitHubApi,
  token: string,
  repository: string,
  commit: string,
): Effect.Effect<ResolvedDiff, import("./GitHubApi.ts").GitHubError> =>
  Effect.gen(function* () {
    const root = pathRoot(repository);
    if (root === null || !validSha(commit)) return yield* fail("pullRequestDiff");
    const text = yield* api.rest("pullRequestDiffCommit", token, `${root}/commits/${commit}`);
    if (text === null) return yield* fail("pullRequestDiff");
    const decoded = yield* decodeOrFail("pullRequestDiff", decodeCommitRevisions(text));
    if (!validFullSha(decoded.sha) || !decoded.sha.toLowerCase().startsWith(commit.toLowerCase())) {
      return yield* fail("pullRequestDiff");
    }
    const parent = decoded.parents[0]?.sha ?? EMPTY_TREE_SHA;
    if (!validFullSha(parent)) return yield* fail("pullRequestDiff");
    return {
      sourceBaseSha: parent,
      revision: { baseSha: parent, headSha: decoded.sha },
      changedFiles: null,
    };
  });

const parseCursor = (cursor: string): DiffCursor | null => {
  const [
    version,
    kind,
    sourceBaseSha,
    baseSha,
    headSha,
    pageText,
    changedFilesText,
    filesReadText,
  ] = cursor.split(":");
  if (version !== "ghrd2" || (kind !== "pull-request" && kind !== "commit")) return null;
  if (
    sourceBaseSha === undefined ||
    baseSha === undefined ||
    headSha === undefined ||
    pageText === undefined ||
    changedFilesText === undefined ||
    filesReadText === undefined
  )
    return null;
  if (
    ![sourceBaseSha, baseSha, headSha].every(validFullSha) ||
    !/^[1-9][0-9]{0,5}$/u.test(pageText) ||
    !/^(?:-|0|[1-9][0-9]*)$/u.test(changedFilesText) ||
    !/^(?:0|[1-9][0-9]*)$/u.test(filesReadText)
  )
    return null;
  const page = Number(pageText);
  const changedFiles = changedFilesText === "-" ? null : Number(changedFilesText);
  const filesRead = Number(filesReadText);
  return page <= DIFF_PAGE_LIMIT &&
    Number.isSafeInteger(filesRead) &&
    (changedFiles === null || Number.isSafeInteger(changedFiles)) &&
    filesRead === (page - 1) * DIFF_PAGE_SIZE
    ? { kind, sourceBaseSha, baseSha, headSha, page, changedFiles, filesRead }
    : null;
};

const cursorFor = (cursor: DiffCursor) =>
  `ghrd2:${cursor.kind}:${cursor.sourceBaseSha}:${cursor.baseSha}:${cursor.headSha}:${cursor.page}:${cursor.changedFiles ?? "-"}:${cursor.filesRead}`;

const pullRequestFilesPage = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
  page: number,
) => {
  const root = pathRoot(repository);
  if (root === null) return fail("pullRequestDiff");
  return api
    .rest("pullRequestDiff", token, `${root}/pulls/${number}/files`, {
      per_page: String(DIFF_PAGE_SIZE),
      page: String(page),
    })
    .pipe(
      Effect.flatMap((text) => {
        if (text === null) return fail("pullRequestDiff");
        const result = decodePullRequestFilesJson(text);
        return Result.isSuccess(result) ? Effect.succeed(result.success) : fail("pullRequestDiff");
      }),
    );
};

const commitFilesPage = (
  api: GitHubApi,
  token: string,
  repository: string,
  commit: string,
  page: number,
) => {
  const root = pathRoot(repository);
  if (root === null) return fail("pullRequestDiff");
  return api
    .rest("pullRequestDiff", token, `${root}/commits/${commit}`, {
      per_page: String(DIFF_PAGE_SIZE),
      page: String(page),
    })
    .pipe(
      Effect.flatMap((text) => {
        if (text === null) return fail("pullRequestDiff");
        const result = decodeCommitFilesJson(text);
        return Result.isSuccess(result) ? Effect.succeed(result.success) : fail("pullRequestDiff");
      }),
    );
};

const sameRefs = (left: Pick<PullRequestRefs, "baseSha" | "headSha">, right: DiffCursor) =>
  left.baseSha.toLowerCase() === right.sourceBaseSha.toLowerCase() &&
  left.headSha.toLowerCase() === right.headSha.toLowerCase();

const asSlice = (
  files: GitHubPullRequestFilesPatch,
  cursor: DiffCursor,
  revision: PullRequestDiffRevision,
  changedFiles: number | null,
): PullRequestDiffResult => {
  const filesRead = cursor.filesRead + files.rawCount;
  const capped =
    cursor.page === DIFF_PAGE_LIMIT && (changedFiles === null || filesRead < changedFiles);
  const hasMore =
    cursor.page < DIFF_PAGE_LIMIT &&
    files.rawCount === DIFF_PAGE_SIZE &&
    (changedFiles === null || filesRead < changedFiles);
  return {
    revision,
    patch: files.patch,
    truncated: files.truncated || capped,
    nextCursor: hasMore ? cursorFor({ ...cursor, page: cursor.page + 1, filesRead }) : null,
    ...(files.omittedFileStats.length === 0 ? {} : { omittedFileStats: files.omittedFileStats }),
  };
};

export const pullRequestDiff = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
  input: PullRequestDiffInput,
): Effect.Effect<PullRequestDiffResult | null, import("./GitHubApi.ts").GitHubError> =>
  Effect.gen(function* () {
    const operation = "pullRequestDiff";
    const suppliedCursor = input.cursor === undefined ? null : parseCursor(input.cursor);
    if (input.cursor !== undefined && suppliedCursor === null) return yield* fail(operation);
    const kind = input.commit === undefined ? "pull-request" : "commit";
    if (input.commit !== undefined && !validSha(input.commit)) return yield* fail(operation);
    if (suppliedCursor !== null && suppliedCursor.kind !== kind) return yield* fail(operation);

    let resolved: ResolvedDiff;
    let page = 1;
    let filesRead = 0;

    if (kind === "pull-request") {
      if (suppliedCursor !== null) {
        const beforeRefs = yield* readPullRequestRefs(api, token, repository, number);
        if (sameRefs(beforeRefs, suppliedCursor)) {
          resolved = {
            sourceBaseSha: suppliedCursor.sourceBaseSha,
            revision: { baseSha: suppliedCursor.baseSha, headSha: suppliedCursor.headSha },
            changedFiles: suppliedCursor.changedFiles,
          };
          page = suppliedCursor.page;
          filesRead = suppliedCursor.filesRead;
        } else {
          // A cursor whose PR moved starts a new first slice so clients can discard stale pages.
          resolved = yield* resolvePullRequestDiffFromRefs(api, token, repository, beforeRefs);
        }
      } else {
        const beforeRefs = yield* readPullRequestRefs(api, token, repository, number);
        resolved = yield* resolvePullRequestDiffFromRefs(api, token, repository, beforeRefs);
      }
    } else {
      const commit = input.commit;
      if (commit === undefined) return yield* fail(operation);
      resolved = yield* resolveCommitDiff(api, token, repository, commit);
      if (suppliedCursor !== null) {
        if (
          resolved.revision.headSha.toLowerCase() !== suppliedCursor.headSha.toLowerCase() ||
          resolved.revision.baseSha.toLowerCase() !== suppliedCursor.baseSha.toLowerCase() ||
          resolved.sourceBaseSha.toLowerCase() !== suppliedCursor.sourceBaseSha.toLowerCase()
        ) {
          return yield* fail(operation);
        }
        page = suppliedCursor.page;
        filesRead = suppliedCursor.filesRead;
      }
    }

    const activeCursor: DiffCursor = {
      kind,
      sourceBaseSha: resolved.sourceBaseSha,
      baseSha: resolved.revision.baseSha,
      headSha: resolved.revision.headSha,
      page,
      changedFiles: resolved.changedFiles,
      filesRead,
    };
    const files =
      kind === "pull-request"
        ? yield* pullRequestFilesPage(api, token, repository, number, activeCursor.page)
        : yield* commitFilesPage(api, token, repository, resolved.revision.headSha, page);
    if (new TextEncoder().encode(files.patch).length > DIFF_OUTPUT_LIMIT)
      return yield* fail(operation);

    if (kind === "pull-request") {
      const afterRefs = yield* readPullRequestRefs(api, token, repository, number);
      if (!sameRefs(afterRefs, activeCursor)) return yield* fail(operation);
    }
    const totalFilesRead = activeCursor.filesRead + files.rawCount;
    if (
      resolved.changedFiles !== null &&
      (totalFilesRead > resolved.changedFiles ||
        (activeCursor.page < DIFF_PAGE_LIMIT &&
          files.rawCount < DIFF_PAGE_SIZE &&
          totalFilesRead !== resolved.changedFiles))
    ) {
      return yield* fail(operation);
    }
    const result = asSlice(files, activeCursor, resolved.revision, resolved.changedFiles);
    if (result.nextCursor !== null && result.nextCursor === input.cursor)
      return yield* fail(operation);
    return result;
  });

const readFile = (
  api: GitHubApi,
  token: string,
  repository: string,
  ref: string,
  filePath: string,
) =>
  Effect.gen(function* () {
    const root = pathRoot(repository);
    if (root === null || !validFullSha(ref)) return yield* fail("pullRequestDiffFileContents");
    const path = filePath.split("/").map(encodeURIComponent).join("/");
    const text = yield* api.rest("pullRequestDiffFileContents", token, `${root}/contents/${path}`, {
      ref,
    });
    if (text === null) return yield* fail("pullRequestDiffFileContents");
    const decoded = decodeContentFile(text);
    if (
      Option.isNone(decoded) ||
      decoded.value.type !== "file" ||
      decoded.value.encoding !== "base64" ||
      decoded.value.size > FILE_CONTENT_LIMIT
    )
      return yield* fail("pullRequestDiffFileContents");
    const base64 = decoded.value.content.replaceAll(/\s+/g, "");
    const decodedBytes = Base64.decode(base64);
    if (Result.isFailure(decodedBytes)) return yield* fail("pullRequestDiffFileContents");
    const bytes = decodedBytes.success;
    if (bytes.length > FILE_CONTENT_LIMIT || bytes.includes(0))
      return yield* fail("pullRequestDiffFileContents");
    return yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => unreadable("pullRequestDiffFileContents"),
    });
  });

const resolveContentRevision = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
  input: PullRequestDiffFileContentsInput,
) =>
  Effect.gen(function* () {
    if (input.revision !== undefined) return input.revision;
    if (input.commit !== undefined) {
      const resolved = yield* resolveCommitDiff(api, token, repository, input.commit);
      return resolved.revision;
    }
    const refs = yield* readPullRequestRefs(api, token, repository, number);
    const resolved = yield* resolvePullRequestDiffFromRefs(api, token, repository, refs);
    return resolved.revision;
  });

export const pullRequestDiffFileContents = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
  input: PullRequestDiffFileContentsInput,
): Effect.Effect<PullRequestDiffFileContentsResult | null, import("./GitHubApi.ts").GitHubError> =>
  Effect.gen(function* () {
    if (
      input.revision !== undefined &&
      input.commit !== undefined &&
      !input.revision.headSha.toLowerCase().startsWith(input.commit.toLowerCase())
    ) {
      return yield* fail("pullRequestDiffFileContents");
    }
    const revision = yield* resolveContentRevision(api, token, repository, number, input);
    if (!validFullSha(revision.baseSha) || !validFullSha(revision.headSha)) {
      return yield* fail("pullRequestDiffFileContents");
    }
    const oldContents =
      input.changeType === "new"
        ? ""
        : yield* readFile(api, token, repository, revision.baseSha, input.oldPath);
    const newContents =
      input.changeType === "deleted"
        ? ""
        : yield* readFile(api, token, repository, revision.headSha, input.newPath);
    return { oldContents, newContents } satisfies PullRequestDiffFileContentsResult;
  });
