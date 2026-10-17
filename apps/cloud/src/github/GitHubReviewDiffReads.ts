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
const DIFF_PAGE_LIMIT = 10_000;
const FILE_CONTENT_LIMIT = 1_048_576;
const DIFF_OUTPUT_LIMIT = 8 * FILE_CONTENT_LIMIT;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const COMMIT_SHA = /^[0-9a-f]{7,64}$/iu;
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu;

const DiffFile = Schema.Struct({
  filename: Schema.String,
  status: Schema.optional(Schema.NullOr(Schema.String)),
  previous_filename: Schema.optional(Schema.NullOr(Schema.String)),
  additions: Schema.optional(Schema.NullOr(Schema.Int)),
  deletions: Schema.optional(Schema.NullOr(Schema.Int)),
});

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
  head_commit: Schema.Struct({ sha: Schema.String }),
  merge_base_commit: Schema.Struct({ sha: Schema.String }),
  changed_files: Schema.optional(Schema.Int),
  files: Schema.optional(Schema.NullOr(Schema.Array(DiffFile))),
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
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeBaseSha: string;
  readonly page: number;
  readonly changedFiles: number | null;
  readonly filesRead: number;
}

interface ResolvedDiff {
  readonly revision: PullRequestDiffRevision;
  readonly mergeBaseSha: string;
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

const resolvePullRequestDiff = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
): Effect.Effect<ResolvedDiff, import("./GitHubApi.ts").GitHubError> =>
  Effect.gen(function* () {
    const root = pathRoot(repository);
    if (root === null) return yield* fail("pullRequestDiff");
    const pullText = yield* api.rest("pullRequestDiffRefs", token, `${root}/pulls/${number}`);
    if (pullText === null) return yield* fail("pullRequestDiff");
    const pull = yield* decodeOrFail("pullRequestDiff", decodePullRequestRevisions(pullText));
    const { baseSha, headSha } = { baseSha: pull.base.sha, headSha: pull.head.sha };
    if (!validFullSha(baseSha) || !validFullSha(headSha)) return yield* fail("pullRequestDiff");
    const compareText = yield* api.rest(
      "pullRequestDiffMergeBase",
      token,
      `${root}/compare/${baseSha}...${headSha}`,
    );
    if (compareText === null) return yield* fail("pullRequestDiff");
    const compare = yield* decodeOrFail("pullRequestDiff", decodeCompareRevisions(compareText));
    if (
      compare.base_commit.sha.toLowerCase() !== baseSha.toLowerCase() ||
      compare.head_commit.sha.toLowerCase() !== headSha.toLowerCase() ||
      !validFullSha(compare.merge_base_commit.sha)
    ) {
      return yield* fail("pullRequestDiff");
    }
    return {
      revision: { baseSha: compare.merge_base_commit.sha, headSha },
      mergeBaseSha: compare.merge_base_commit.sha,
      changedFiles: pull.changed_files ?? null,
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
      revision: { baseSha: parent, headSha: decoded.sha },
      mergeBaseSha: parent,
      changedFiles: null,
    };
  });

const parseCursor = (cursor: string): DiffCursor | null => {
  const [version, kind, baseSha, headSha, mergeBaseSha, pageText, changedFilesText, filesReadText] =
    cursor.split(":");
  if (version !== "ghrd1" || (kind !== "pull-request" && kind !== "commit")) return null;
  if (
    baseSha === undefined ||
    headSha === undefined ||
    mergeBaseSha === undefined ||
    pageText === undefined ||
    changedFilesText === undefined ||
    filesReadText === undefined
  )
    return null;
  if (
    ![baseSha, headSha, mergeBaseSha].every(validFullSha) ||
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
    ? { kind, baseSha, headSha, mergeBaseSha, page, changedFiles, filesRead }
    : null;
};

const cursorFor = (cursor: DiffCursor) =>
  `ghrd1:${cursor.kind}:${cursor.baseSha}:${cursor.headSha}:${cursor.mergeBaseSha}:${cursor.page}:${cursor.changedFiles ?? "-"}:${cursor.filesRead}`;

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

const checkPullRequestRefs = (
  api: GitHubApi,
  token: string,
  repository: string,
  number: number,
  revision: PullRequestDiffRevision,
) =>
  Effect.gen(function* () {
    const root = pathRoot(repository);
    if (root === null) return yield* fail("pullRequestDiff");
    const text = yield* api.rest("pullRequestDiffRefs", token, `${root}/pulls/${number}`);
    if (text === null) return yield* fail("pullRequestDiff");
    const pull = yield* decodeOrFail("pullRequestDiff", decodePullRequestRevisions(text));
    const compareText = yield* api.rest(
      "pullRequestDiffMergeBase",
      token,
      `${root}/compare/${pull.base.sha}...${pull.head.sha}`,
    );
    if (compareText === null) return yield* fail("pullRequestDiff");
    const compare = yield* decodeOrFail("pullRequestDiff", decodeCompareRevisions(compareText));
    return (
      compare.base_commit.sha.toLowerCase() === pull.base.sha.toLowerCase() &&
      compare.head_commit.sha.toLowerCase() === pull.head.sha.toLowerCase() &&
      compare.merge_base_commit.sha.toLowerCase() === revision.baseSha.toLowerCase() &&
      pull.head.sha.toLowerCase() === revision.headSha.toLowerCase()
    );
  });

const asSlice = (
  files: GitHubPullRequestFilesPatch,
  cursor: DiffCursor,
  revision: PullRequestDiffRevision,
  changedFiles: number | null,
): PullRequestDiffResult => {
  const filesRead = cursor.filesRead + files.rawCount;
  const hasMore =
    files.rawCount === DIFF_PAGE_SIZE && (changedFiles === null || filesRead < changedFiles);
  return {
    revision,
    patch: files.patch,
    truncated: files.truncated,
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
    if (suppliedCursor !== null) {
      if (kind === "commit") {
        const commit = input.commit;
        if (commit === undefined) return yield* fail(operation);
        resolved = yield* resolveCommitDiff(api, token, repository, commit);
        if (
          resolved.revision.headSha.toLowerCase() !== suppliedCursor.headSha.toLowerCase() ||
          resolved.revision.baseSha.toLowerCase() !== suppliedCursor.baseSha.toLowerCase()
        ) {
          return yield* fail(operation);
        }
      } else {
        resolved = {
          revision: { baseSha: suppliedCursor.baseSha, headSha: suppliedCursor.headSha },
          mergeBaseSha: suppliedCursor.mergeBaseSha,
          changedFiles: suppliedCursor.changedFiles,
        };
      }
      page = suppliedCursor.page;
    } else {
      resolved =
        input.commit === undefined
          ? yield* resolvePullRequestDiff(api, token, repository, number)
          : yield* resolveCommitDiff(api, token, repository, input.commit);
    }

    if (input.commit === undefined) {
      if (!(yield* checkPullRequestRefs(api, token, repository, number, resolved.revision))) {
        return yield* fail(operation);
      }
    }
    const cursor: DiffCursor = {
      kind,
      baseSha: resolved.revision.baseSha,
      headSha: resolved.revision.headSha,
      mergeBaseSha: resolved.mergeBaseSha,
      page,
      changedFiles: resolved.changedFiles,
      filesRead: suppliedCursor?.filesRead ?? 0,
    };
    const files =
      input.commit === undefined
        ? yield* pullRequestFilesPage(api, token, repository, number, page)
        : yield* commitFilesPage(api, token, repository, resolved.revision.headSha, page);
    if (new TextEncoder().encode(files.patch).length > DIFF_OUTPUT_LIMIT)
      return yield* fail(operation);
    if (
      input.commit === undefined &&
      !(yield* checkPullRequestRefs(api, token, repository, number, resolved.revision))
    ) {
      return yield* fail(operation);
    }
    const filesRead = cursor.filesRead + files.rawCount;
    if (
      resolved.changedFiles !== null &&
      (filesRead > resolved.changedFiles ||
        (files.rawCount < DIFF_PAGE_SIZE && filesRead !== resolved.changedFiles))
    ) {
      return yield* fail(operation);
    }
    const result = asSlice(files, cursor, resolved.revision, resolved.changedFiles);
    if (result.nextCursor !== null && result.nextCursor === input.cursor)
      return yield* fail(operation);
    return result;
  });

type DiffFileMetadata = typeof DiffFile.Type;

const pathMatches = (
  file: DiffFileMetadata,
  input: Pick<PullRequestDiffFileContentsInput, "changeType" | "oldPath" | "newPath">,
) => {
  const status = file.status?.toLowerCase();
  switch (input.changeType) {
    case "new":
      return status === "added" && file.filename === input.newPath;
    case "deleted":
      return status === "removed" && file.filename === input.oldPath;
    case "change":
      return (
        (status === "modified" || status === "changed") &&
        file.filename === input.newPath &&
        input.oldPath === input.newPath
      );
    case "rename-pure":
      return (
        status === "renamed" &&
        file.previous_filename === input.oldPath &&
        file.filename === input.newPath &&
        (file.additions ?? 0) + (file.deletions ?? 0) === 0
      );
    case "rename-changed":
      return (
        status === "renamed" &&
        file.previous_filename === input.oldPath &&
        file.filename === input.newPath &&
        (file.additions ?? 0) + (file.deletions ?? 0) > 0
      );
  }
};

const verifyCompareFile = (
  api: GitHubApi,
  token: string,
  repository: string,
  revision: PullRequestDiffRevision,
  input: Pick<PullRequestDiffFileContentsInput, "changeType" | "oldPath" | "newPath">,
) =>
  Effect.gen(function* () {
    const root = pathRoot(repository);
    if (root === null) return yield* fail("pullRequestDiffFileContents");
    const text = yield* api.rest(
      "pullRequestDiffFileContentsMetadata",
      token,
      `${root}/compare/${revision.baseSha}...${revision.headSha}`,
      { per_page: "300", page: "1" },
    );
    if (text === null) return yield* fail("pullRequestDiffFileContents");
    const compare = decodeCompareRevisions(text);
    if (
      Option.isNone(compare) ||
      compare.value.files == null ||
      compare.value.base_commit.sha.toLowerCase() !== revision.baseSha.toLowerCase() ||
      compare.value.head_commit.sha.toLowerCase() !== revision.headSha.toLowerCase() ||
      compare.value.merge_base_commit.sha.toLowerCase() !== revision.baseSha.toLowerCase() ||
      !compare.value.files.some((file) => pathMatches(file, input))
    ) {
      return yield* fail("pullRequestDiffFileContents");
    }
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
    const resolved = yield* resolvePullRequestDiff(api, token, repository, number);
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
    yield* verifyCompareFile(api, token, repository, revision, input);
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
