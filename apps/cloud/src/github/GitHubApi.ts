import type { PullRequestMergeMethod } from "@t3tools/contracts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";
import { retryAtFromHeader } from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClientError from "effect/http/HttpClientError";
import { type HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

/**
 * The GitHub calls Signalbox Cloud makes: a few REST and GraphQL reads, opening pull requests, and git's
 * smart HTTP. Every call takes the user's token it acts with; nothing here
 * keeps one. Only the fields used are decoded.
 */

export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  operation: Schema.String,
  /** HTTP status, or 0 when no answer arrived. */
  status: Schema.Number,
  message: Schema.String,
  /** The protocol used for the request that produced this answer. */
  requestKind: Schema.optional(Schema.Literals(["rest", "graphql", "git"])),
  /** A short, sanitized excerpt of the response body, when an answer arrived. */
  responseExcerpt: Schema.optional(Schema.String),
  /** Sanitized response headers that help identify malformed GitHub answers. */
  responseContentType: Schema.optional(Schema.String),
  responseContentLength: Schema.optional(Schema.String),
  /** GitHub's bounded rate-limit headers, when present on an answer. */
  responseRateLimits: Schema.optional(
    Schema.Struct({
      remaining: Schema.optional(Schema.String),
      reset: Schema.optional(Schema.String),
      resource: Schema.optional(Schema.String),
      used: Schema.optional(Schema.String),
      retryAfter: Schema.optional(Schema.String),
    }),
  ),
  /** When GitHub's rate limit lets the caller ask again (epoch ms), when it said. */
  retryAt: Schema.optional(Schema.Number),
}) {}

type GitHubRequestKind = "rest" | "graphql" | "git";

/** An answer GitHub sent that doesn't decode as expected. */
export const unreadable = (operation: string) =>
  new GitHubError({
    operation,
    status: 200,
    message: "GitHub sent an answer Signalbox does not understand.",
  });

/**
 * When a refused request may be retried: `retry-after` (secondary limits), or
 * the window's reset once none are left. Undefined for any other refusal.
 */
const rateLimitRetryAt = (response: HttpClientResponse.HttpClientResponse, now: number) => {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const retryAfter = retryAtFromHeader(response.headers["retry-after"], now);
  if (retryAfter !== undefined) return retryAfter;
  if (response.headers["x-ratelimit-remaining"] !== "0") return undefined;
  const reset = Number(response.headers["x-ratelimit-reset"]);
  return Number.isFinite(reset) ? reset * 1_000 : now + 60_000;
};

export interface GitHubEndpoints {
  /** Where OAuth and git live, e.g. `https://github.com`. */
  readonly web: string;
  /** The REST API, e.g. `https://api.github.com`. */
  readonly api: string;
}

const GITHUB_ENDPOINTS: GitHubEndpoints = {
  web: "https://github.com",
  api: "https://api.github.com",
};

const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;

const Viewer = Schema.Struct({
  login: Schema.String,
  id: Schema.Number,
  /** The display name the user set on their profile; null when they set none. */
  name: Schema.optional(Schema.NullOr(Schema.String)),
});

const Repository = Schema.Struct({
  id: Schema.Number,
  full_name: Schema.String,
  name: Schema.String,
  default_branch: Schema.String,
  html_url: Schema.String,
  clone_url: Schema.String,
  ssh_url: Schema.String,
});
export type GitHubRepository = typeof Repository.Type;

const PullBody = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  html_url: Schema.String,
  state: Schema.String,
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.Boolean),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  base: Schema.Struct({ ref: Schema.String }),
  head: Schema.Struct({ ref: Schema.String }),
});

export interface GitHubPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft: boolean;
  readonly updatedAt: string | null;
  readonly baseRef: string;
  readonly headRef: string;
}

const toPull = (body: typeof PullBody.Type): GitHubPullRequest => ({
  number: body.number,
  title: body.title,
  url: body.html_url,
  state: body.merged_at ? "merged" : body.state === "open" ? "open" : "closed",
  isDraft: body.draft === true,
  updatedAt: body.updated_at ?? null,
  baseRef: body.base.ref,
  headRef: body.head.ref,
});

const RefBody = Schema.Struct({ object: Schema.Struct({ sha: Schema.String }) });
const RefsBody = Schema.Array(Schema.Struct({ ref: Schema.String, ...RefBody.fields }));
const CommitBody = Schema.Struct({ sha: Schema.String });
const CompareBody = Schema.Struct({
  ahead_by: Schema.Number,
  behind_by: Schema.Number,
  merge_base_commit: Schema.Struct({ sha: Schema.String }),
});
const MergeBody = Schema.Struct({ merged: Schema.Boolean });
const TreeBody = Schema.Struct({
  tree: Schema.Array(
    Schema.Struct({
      sha: Schema.String,
      type: Schema.String,
      size: Schema.optional(Schema.Number),
    }),
  ),
  truncated: Schema.Boolean,
});
const DefaultHeadBody = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        defaultBranchRef: Schema.NullOr(
          Schema.Struct({ name: Schema.String, target: Schema.Struct({ oid: Schema.String }) }),
        ),
      }),
    ),
  }),
});
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.Struct({ message: Schema.optional(Schema.String) }),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isGraphQlRateLimit = (body: unknown) =>
  isRecord(body) &&
  Array.isArray(body.errors) &&
  body.errors.some((error) => {
    if (!isRecord(error)) return false;
    if (error.type === "RATE_LIMITED") return true;
    if (error.type !== "RATE_LIMIT") return false;
    const code = error.code ?? (isRecord(error.extensions) ? error.extensions.code : undefined);
    return code === "graphql_rate_limit";
  });

const graphqlRateLimitRetryAt = (response: HttpClientResponse.HttpClientResponse, now: number) => {
  const retryAfter = retryAtFromHeader(response.headers["retry-after"], now);
  if (retryAfter !== undefined) return retryAfter;
  const reset = Number(response.headers["x-ratelimit-reset"]) * 1_000;
  return Number.isFinite(reset) && reset > now ? reset : now + 60_000;
};

/** git's credential for a token over HTTPS. */
export const gitAuthorization = (token: string) =>
  `Basic ${Base64.encode(`x-access-token:${token}`)}`;

const sanitizeGitHubDiagnostic = (value: string, token: string) => {
  let sanitized = value;
  if (token.length > 0) {
    sanitized = sanitized.replaceAll(token, "[redacted]");
    sanitized = sanitized.replaceAll(gitAuthorization(token), "[redacted]");
    sanitized = sanitized.replaceAll(Base64.encode(`x-access-token:${token}`), "[redacted]");
  }
  return sanitized
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi, "[redacted]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{16,}/gi, "[redacted]")
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|token)["']?\s*[:=]\s*["']?)[^"'&,\s}]+/gi,
      "$1[redacted]",
    )
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const boundedDiagnostic = (value: string, token: string, maxLength: number) => {
  const sanitized = sanitizeGitHubDiagnostic(value, token);
  if (sanitized.length === 0) return undefined;
  return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}…` : sanitized;
};

const boundedResponseHeader = (value: string) =>
  value.length > 120 ? `${value.slice(0, 120)}…` : value;

const responseDiagnostics = (
  requestKind: GitHubRequestKind,
  response: HttpClientResponse.HttpClientResponse,
  text: string,
  token: string,
) => {
  const excerpt = boundedDiagnostic(text, token, 240);
  const contentType =
    response.headers["content-type"] === undefined
      ? undefined
      : boundedDiagnostic(response.headers["content-type"], token, 120);
  const contentLength =
    response.headers["content-length"] === undefined
      ? undefined
      : boundedDiagnostic(response.headers["content-length"], token, 120);
  const rateLimitHeaders = {
    ...(response.headers["x-ratelimit-remaining"] === undefined
      ? {}
      : { remaining: boundedResponseHeader(response.headers["x-ratelimit-remaining"]) }),
    ...(response.headers["x-ratelimit-reset"] === undefined
      ? {}
      : { reset: boundedResponseHeader(response.headers["x-ratelimit-reset"]) }),
    ...(response.headers["x-ratelimit-resource"] === undefined
      ? {}
      : { resource: boundedResponseHeader(response.headers["x-ratelimit-resource"]) }),
    ...(response.headers["x-ratelimit-used"] === undefined
      ? {}
      : { used: boundedResponseHeader(response.headers["x-ratelimit-used"]) }),
    ...(response.headers["retry-after"] === undefined
      ? {}
      : { retryAfter: boundedResponseHeader(response.headers["retry-after"]) }),
  };
  return {
    requestKind,
    ...(excerpt === undefined ? {} : { responseExcerpt: excerpt }),
    ...(contentType === undefined ? {} : { responseContentType: contentType }),
    ...(contentLength === undefined ? {} : { responseContentLength: contentLength }),
    ...(Object.keys(rateLimitHeaders).length === 0 ? {} : { responseRateLimits: rateLimitHeaders }),
  };
};

/** `owner/name` from a GitHub URL, or from `owner/name` itself; null for anything else. */
export const parseRepository = (input: string): string | null => {
  const trimmed = input.trim();
  return (
    parseGitHubRepositoryNameWithOwnerFromRemoteUrl(trimmed) ??
    (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed.replace(/\.git$/, "") : null)
  );
};

export const makeGitHubApi = (
  client: HttpClient.HttpClient,
  endpoints: GitHubEndpoints = GITHUB_ENDPOINTS,
) => {
  const web = endpoints.web.replace(/\/+$/, "");
  const api = endpoints.api.replace(/\/+$/, "");

  const send = (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    requestKind: GitHubRequestKind,
  ) =>
    client.execute(request.pipe(HttpClientRequest.setHeader("user-agent", "signalbox-cloud"))).pipe(
      // Requests and underlying errors can contain credentials; log only the failure category.
      Effect.tapError((error) =>
        Effect.logWarning("GitHub request failed", {
          operation,
          requestKind,
          reason: error.reason._tag,
        }),
      ),
      Effect.mapError(
        () =>
          new GitHubError({
            operation,
            status: 0,
            message: "GitHub did not answer.",
            requestKind,
          }),
      ),
    );

  /** `request` as `token`, asking for `accept`. */
  const asUser = (
    request: HttpClientRequest.HttpClientRequest,
    token: string,
    accept = "application/vnd.github+json",
  ) =>
    request.pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeaders({ accept, "x-github-api-version": "2022-11-28" }),
    );

  const logResponseFailure = (error: GitHubError) =>
    Effect.logWarning("GitHub response failed", {
      operation: error.operation,
      requestKind: error.requestKind ?? "unknown",
      status: error.status,
      ...(error.responseExcerpt === undefined ? {} : { responseExcerpt: error.responseExcerpt }),
      ...(error.responseContentType === undefined
        ? {}
        : { responseContentType: error.responseContentType }),
      ...(error.responseContentLength === undefined
        ? {}
        : { responseContentLength: error.responseContentLength }),
      ...(error.responseRateLimits === undefined
        ? {}
        : { responseRateLimits: error.responseRateLimits }),
    });

  const readResponseText = (
    operation: string,
    response: HttpClientResponse.HttpClientResponse,
    requestKind: GitHubRequestKind,
    token: string,
  ) =>
    response.text.pipe(
      Effect.catch(() =>
        Effect.gen(function* () {
          const retryAt = rateLimitRetryAt(response, yield* Clock.currentTimeMillis);
          return yield* new GitHubError({
            operation,
            status: response.status,
            message: "GitHub's answer was cut off.",
            ...responseDiagnostics(requestKind, response, "", token),
            ...(retryAt === undefined ? {} : { retryAt }),
          });
        }),
      ),
      Effect.tapError(logResponseFailure),
    );

  /** A REST or GraphQL call as `token`. Null on 404; any other non-2xx fails with GitHub's message. */
  const json = <A>(
    operation: string,
    schema: Schema.Codec<A, unknown>,
    request: HttpClientRequest.HttpClientRequest,
    token: string,
    requestKind: GitHubRequestKind = "rest",
  ) =>
    send(operation, asUser(request, token), requestKind).pipe(
      Effect.flatMap((response) => decodeOrFail(operation, schema, response, requestKind, token)),
      Effect.scoped,
    );

  /** Like `json`, answering the raw body as bytes. */
  const rawBytes = (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    token: string,
    requestKind: GitHubRequestKind = "rest",
  ) =>
    send(operation, asUser(request, token, "application/vnd.github.raw+json"), requestKind).pipe(
      Effect.flatMap((response) =>
        response.status === 404
          ? Effect.succeed(null)
          : response.status < 200 || response.status >= 300
            ? // Fails with GitHub's message.
              Effect.map(
                decodeOrFail(operation, Schema.Unknown, response, requestKind, token),
                () => null,
              )
            : response.arrayBuffer.pipe(
                Effect.map((bytes) => new Uint8Array(bytes)),
                Effect.mapError(
                  () =>
                    new GitHubError({
                      operation,
                      status: response.status,
                      message: "GitHub's answer was cut off.",
                      ...responseDiagnostics(requestKind, response, "", token),
                    }),
                ),
                Effect.tapError(logResponseFailure),
              ),
      ),
      Effect.scoped,
    );

  /** Fails with GitHub's message, and its rate limit's retry time, for a non-2xx answer. */
  const failUnlessOk = (
    operation: string,
    response: HttpClientResponse.HttpClientResponse,
    body: unknown,
    text: string,
    requestKind: GitHubRequestKind,
    token: string,
  ) =>
    Effect.gen(function* () {
      if (response.status >= 200 && response.status < 300) return;
      const error = decodeErrorBody(body);
      const retryAt = rateLimitRetryAt(response, yield* Clock.currentTimeMillis);
      const failure = new GitHubError({
        operation,
        status: response.status,
        message: sanitizeGitHubDiagnostic(
          (error._tag === "Some" ? error.value.message : undefined) ??
            `GitHub answered ${response.status}.`,
          token,
        ),
        ...responseDiagnostics(requestKind, response, text, token),
        ...(retryAt === undefined ? {} : { retryAt }),
      });
      yield* logResponseFailure(failure);
      return yield* failure;
    });

  /** A call as `token` whose answer the caller decodes: its JSON text, null on 404. */
  const raw = (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    token: string,
    requestKind: GitHubRequestKind = "rest",
  ) =>
    send(
      operation,
      request.pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders({
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        }),
      ),
      requestKind,
    ).pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          const chunks: Uint8Array[] = [];
          let length = 0;
          yield* response.stream.pipe(
            Stream.runForEach((chunk) => {
              length += chunk.byteLength;
              if (length > MAX_JSON_RESPONSE_BYTES) {
                return Effect.fail(
                  new GitHubError({
                    operation,
                    status: response.status,
                    message: "GitHub's answer is too large to read.",
                    ...responseDiagnostics(requestKind, response, "", token),
                  }),
                );
              }
              chunks.push(chunk);
              return Effect.void;
            }),
            Effect.catchIf(
              (error) =>
                HttpClientError.isHttpClientError(error) && error.reason._tag === "EmptyBodyError",
              () => Effect.void,
            ),
            Effect.catch(() =>
              Effect.gen(function* () {
                const retryAt = rateLimitRetryAt(response, yield* Clock.currentTimeMillis);
                return yield* new GitHubError({
                  operation,
                  status: response.status,
                  message: "GitHub's answer could not be read within its size limit.",
                  ...responseDiagnostics(requestKind, response, "", token),
                  ...(retryAt === undefined ? {} : { retryAt }),
                });
              }),
            ),
            Effect.tapError(logResponseFailure),
          );
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const text = new TextDecoder().decode(bytes);
          if (response.status === 404) return null;
          const body = Option.getOrNull(parseJson(text));
          yield* failUnlessOk(operation, response, body, text, requestKind, token);
          // GraphQL answers its own rate limit with a 200 and an error in the body.
          if (response.status === 200 && isGraphQlRateLimit(body)) {
            const now = yield* Clock.currentTimeMillis;
            const failure = new GitHubError({
              operation,
              status: response.status,
              message: "GitHub's API rate limit is used up for now.",
              ...responseDiagnostics(requestKind, response, text, token),
              retryAt: graphqlRateLimitRetryAt(response, now),
            });
            yield* logResponseFailure(failure);
            return yield* failure;
          }
          return text;
        }),
      ),
      Effect.scoped,
    );

  const decodeOrFail = <A>(
    operation: string,
    schema: Schema.Codec<A, unknown>,
    response: HttpClientResponse.HttpClientResponse,
    requestKind: GitHubRequestKind,
    token: string,
  ) =>
    Effect.gen(function* () {
      if (response.status === 404) return null;
      const text = yield* readResponseText(operation, response, requestKind, token);
      const body = Option.getOrNull(parseJson(text));
      yield* failUnlessOk(operation, response, body, text, requestKind, token);
      return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
        // Schema internals can echo response data; keep only the bounded excerpt in diagnostics.
        Effect.mapError(
          () =>
            new GitHubError({
              operation,
              status: response.status,
              message: "GitHub sent an answer Signalbox does not understand.",
              ...responseDiagnostics(requestKind, response, text, token),
            }),
        ),
        Effect.tapError(logResponseFailure),
      );
    });

  return {
    viewer: (token: string) => json("viewer", Viewer, HttpClientRequest.get(`${api}/user`), token),
    repository: (token: string, repository: string) =>
      json("repository", Repository, HttpClientRequest.get(`${api}/repos/${repository}`), token),
    /** The repositories the user can push to, most recently pushed first: one page, enough to pick from. */
    repositories: (token: string) =>
      json(
        "repositories",
        Schema.Array(Repository),
        HttpClientRequest.get(`${api}/user/repos`).pipe(
          HttpClientRequest.setUrlParams({
            sort: "pushed",
            per_page: "100",
            affiliation: "owner,collaborator,organization_member",
          }),
        ),
        token,
      ).pipe(Effect.map((repositories) => repositories ?? [])),
    /** The default branch and its head, as git would fetch `HEAD`. */
    defaultHead: (token: string, repository: string) => {
      const [owner, name] = repository.split("/");
      return json(
        "defaultHead",
        DefaultHeadBody,
        HttpClientRequest.post(`${api}/graphql`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            query:
              "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name target{oid}}}}",
            variables: { owner, name },
          }),
        ),
        token,
        "graphql",
      ).pipe(
        Effect.map((body) => {
          const ref = body?.data.repository?.defaultBranchRef ?? null;
          return ref === null ? null : { branch: ref.name, oid: ref.target.oid };
        }),
      );
    },
    /** Whether `repository` holds commit `sha`. */
    hasCommit: (token: string, repository: string, sha: string) =>
      json(
        "hasCommit",
        CommitBody,
        HttpClientRequest.get(`${api}/repos/${repository}/git/commits/${sha}`),
        token,
      ).pipe(Effect.map((body) => body !== null)),
    branchHead: (token: string, repository: string, branch: string) =>
      json(
        "branchHead",
        RefBody,
        HttpClientRequest.get(
          `${api}/repos/${repository}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
        ),
        token,
      ).pipe(Effect.map((body) => body?.object.sha ?? null)),
    /** Exact commit counts between two GitHub-known commits or refs. */
    compare: (token: string, repository: string, base: string, head: string) =>
      json(
        "compare",
        CompareBody,
        HttpClientRequest.get(
          `${api}/repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
        ),
        token,
      ).pipe(
        Effect.map((body) =>
          body === null
            ? null
            : {
                aheadBy: body.ahead_by,
                behindBy: body.behind_by,
                mergeBase: body.merge_base_commit.sha,
              },
        ),
      ),
    /** All branch refs. GitHub's matching-refs endpoint returns the whole namespace without paging. */
    listRefs: (token: string, repository: string) =>
      json(
        "listRefs",
        RefsBody,
        HttpClientRequest.get(`${api}/repos/${repository}/git/matching-refs/heads/`),
        token,
      ).pipe(
        Effect.catchIf(
          (error) => error.status === 409 && /^Git Repository is empty\.?$/i.test(error.message),
          () => Effect.succeed([]),
        ),
      ),
    /** The newest pull request from `branch` in the same repository, in any state. */
    pullForBranch: (token: string, repository: string, branch: string) => {
      const url = new URL(`${api}/repos/${repository}/pulls`);
      url.searchParams.set("head", `${repository.split("/")[0]}:${branch}`);
      url.searchParams.set("state", "all");
      url.searchParams.set("per_page", "1");
      return json(
        "pullForBranch",
        Schema.Array(PullBody),
        HttpClientRequest.get(url.toString()),
        token,
      ).pipe(Effect.map((pulls) => (pulls?.[0] === undefined ? null : toPull(pulls[0]))));
    },
    createPull: (
      token: string,
      repository: string,
      input: {
        readonly title: string;
        readonly head: string;
        readonly base: string;
        readonly body: string;
        readonly draft?: boolean;
      },
    ) =>
      json(
        "createPull",
        PullBody,
        HttpClientRequest.post(`${api}/repos/${repository}/pulls`).pipe(
          HttpClientRequest.bodyJsonUnsafe(input),
        ),
        token,
      ).pipe(
        Effect.flatMap((body) =>
          body === null
            ? Effect.fail(
                new GitHubError({
                  operation: "createPull",
                  status: 404,
                  message: `${repository} is not reachable.`,
                  requestKind: "rest",
                }),
              )
            : Effect.succeed(toPull(body)),
        ),
      ),
    /**
     * Merges a pull request. With `sha`, GitHub merges only while that is its
     * head and answers 409 otherwise. Null when the pull request isn't there.
     */
    mergePull: (
      token: string,
      repository: string,
      number: number,
      input: { readonly sha?: string; readonly method?: PullRequestMergeMethod },
    ) =>
      json(
        "mergePull",
        MergeBody,
        HttpClientRequest.put(`${api}/repos/${repository}/pulls/${number}/merge`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            ...(input.sha === undefined ? {} : { sha: input.sha }),
            ...(input.method === undefined ? {} : { merge_method: input.method }),
          }),
        ),
        token,
      ),
    /** One `git-receive-pack` request, streamed as `gitPush.ts` builds it; answers the raw result. */
    receivePack: (token: string, repository: string, body: Stream.Stream<Uint8Array, unknown>) =>
      send(
        "receivePack",
        HttpClientRequest.post(`${web}/${repository}.git/git-receive-pack`).pipe(
          HttpClientRequest.setHeaders({
            authorization: gitAuthorization(token),
            accept: "application/x-git-receive-pack-result",
          }),
          // Sent chunked, as `git push` sends a big one.
          HttpClientRequest.bodyStream(body, {
            contentType: "application/x-git-receive-pack-request",
          }),
        ),
        "git",
      ).pipe(
        Effect.flatMap((response) =>
          response.arrayBuffer.pipe(
            Effect.map((bytes) => ({ status: response.status, body: new Uint8Array(bytes) })),
            Effect.mapError(
              () =>
                new GitHubError({
                  operation: "receivePack",
                  status: response.status,
                  message: "GitHub's answer to the push was cut off.",
                  ...responseDiagnostics("git", response, "", token),
                }),
            ),
            Effect.tapError(logResponseFailure),
          ),
        ),
        Effect.scoped,
      ),
    /** A file's bytes by id, or null when `repository` doesn't have it (#406). */
    blob: (token: string, repository: string, sha: string) =>
      rawBytes("blob", HttpClientRequest.get(`${api}/repos/${repository}/git/blobs/${sha}`), token),
    /**
     * Every file's size under commit or tree `sha`, by id. GitHub lists at most
     * 100,000 entries; a bigger tree answers what it listed.
     */
    fileSizes: (token: string, repository: string, sha: string) =>
      json(
        "fileSizes",
        TreeBody,
        HttpClientRequest.get(`${api}/repos/${repository}/git/trees/${sha}`).pipe(
          HttpClientRequest.setUrlParams({ recursive: "1" }),
        ),
        token,
      ).pipe(
        Effect.map(
          (body) =>
            new Map(
              (body?.tree ?? []).flatMap((entry) =>
                entry.type === "blob" && entry.size !== undefined
                  ? [[entry.sha, entry.size] as const]
                  : [],
              ),
            ),
        ),
      ),
    /** A GraphQL query's answer as JSON text, for decoders that read text (upstream's). */
    graphql: (
      operation: string,
      token: string,
      query: string,
      variables: Readonly<Record<string, unknown>>,
    ) =>
      raw(
        operation,
        HttpClientRequest.post(`${api}/graphql`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ query, variables }),
        ),
        token,
        "graphql",
      ),
    /** A REST read's answer as JSON text; null on 404. `path` starts with `/`. */
    rest: (
      operation: string,
      token: string,
      path: string,
      params: Readonly<Record<string, string>> = {},
    ) =>
      raw(
        operation,
        HttpClientRequest.get(`${api}${path}`).pipe(HttpClientRequest.setUrlParams(params)),
        token,
      ),
    /** A REST write with a JSON body; its answer as JSON text, null on 404. `path` starts with `/`. */
    post: (operation: string, token: string, path: string, body: unknown) =>
      raw(
        operation,
        HttpClientRequest.post(`${api}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
        token,
      ),
    /** A REST update with a JSON body; its answer as JSON text, null on 404. */
    patch: (operation: string, token: string, path: string, body: unknown) =>
      raw(
        operation,
        HttpClientRequest.patch(`${api}${path}`).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
        token,
      ),
    /** A REST deletion; its answer as JSON text, null on 404. */
    delete: (operation: string, token: string, path: string) =>
      raw(operation, HttpClientRequest.delete(`${api}${path}`), token),
    /** A download GitHub redirects to storage (logs, artifacts), as bytes; null on 404. */
    download: (operation: string, token: string, path: string) =>
      rawBytes(operation, HttpClientRequest.get(`${api}${path}`), token),
    /** The host links to this GitHub's pull requests name, e.g. `github.com`. */
    host: new URL(web).host.toLowerCase(),
    /** Where git's smart HTTP for `repository` lives, for the drive's fetch proxy. */
    gitUrl: (repository: string, path: string) => `${web}/${repository}.git/${path}`,
  };
};

export type GitHubApi = ReturnType<typeof makeGitHubApi>;
