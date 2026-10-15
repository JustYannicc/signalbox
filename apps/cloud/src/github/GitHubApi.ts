import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";
import { retryAtFromHeader } from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
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
  /** When GitHub's rate limit lets the caller ask again (epoch ms), when it said. */
  retryAt: Schema.optional(Schema.Number),
}) {}

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

/** git's credential for a token over HTTPS. */
export const gitAuthorization = (token: string) =>
  `Basic ${Base64.encode(`x-access-token:${token}`)}`;

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

  const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request.pipe(HttpClientRequest.setHeader("user-agent", "signalbox-cloud"))).pipe(
      // The request (with tokens or the App's secret) stays out of the error, which gets logged.
      Effect.mapError(
        () => new GitHubError({ operation, status: 0, message: "GitHub did not answer." }),
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

  /** A REST or GraphQL call as `token`. Null on 404; any other non-2xx fails with GitHub's message. */
  const json = <A>(
    operation: string,
    schema: Schema.Codec<A, unknown>,
    request: HttpClientRequest.HttpClientRequest,
    token: string,
  ) =>
    send(operation, asUser(request, token)).pipe(
      Effect.flatMap((response) => decodeOrFail(operation, schema, response)),
      Effect.scoped,
    );

  /** Like `json`, answering the raw body as bytes. */
  const rawBytes = (operation: string, request: HttpClientRequest.HttpClientRequest, token: string) =>
    send(operation, asUser(request, token, "application/vnd.github.raw+json")).pipe(
      Effect.flatMap((response) =>
        response.status === 404
          ? Effect.succeed(null)
          : response.status < 200 || response.status >= 300
            ? // Fails with GitHub's message.
              Effect.flatMap(decodeOrFail(operation, Schema.Unknown, response), () =>
                Effect.succeed(null),
              )
            : response.arrayBuffer.pipe(
                Effect.map((bytes) => new Uint8Array(bytes)),
                Effect.mapError(
                  () =>
                    new GitHubError({
                      operation,
                      status: response.status,
                      message: "GitHub's answer was cut off.",
                    }),
                ),
              ),
      ),
      Effect.scoped,
    );

  /** Fails with GitHub's message, and its rate limit's retry time, for a non-2xx answer. */
  const failUnlessOk = (
    operation: string,
    response: HttpClientResponse.HttpClientResponse,
    body: unknown,
  ) =>
    Effect.gen(function* () {
      if (response.status >= 200 && response.status < 300) return;
      const error = decodeErrorBody(body);
      const retryAt = rateLimitRetryAt(response, yield* Clock.currentTimeMillis);
      return yield* new GitHubError({
        operation,
        status: response.status,
        message:
          (error._tag === "Some" ? error.value.message : undefined) ??
          `GitHub answered ${response.status}.`,
        ...(retryAt === undefined ? {} : { retryAt }),
      });
    });

  /** A call as `token` whose answer the caller decodes: its JSON text, null on 404. */
  const raw = (operation: string, request: HttpClientRequest.HttpClientRequest, token: string) =>
    send(
      operation,
      request.pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders({
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        }),
      ),
    ).pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          if (response.status === 404) return null;
          yield* failUnlessOk(operation, response, Option.getOrNull(parseJson(text)));
          // GraphQL answers its own rate limit with a 200 and an error in the body.
          if (text.includes('"RATE_LIMITED"')) {
            const now = yield* Clock.currentTimeMillis;
            const reset = Number(response.headers["x-ratelimit-reset"]) * 1_000;
            return yield* new GitHubError({
              operation,
              status: response.status,
              message: "GitHub's API rate limit is used up for now.",
              retryAt: Number.isFinite(reset) && reset > now ? reset : now + 60_000,
            });
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
  ) =>
    Effect.gen(function* () {
      const body: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => null));
      if (response.status === 404) return null;
      yield* failUnlessOk(operation, response, body);
      return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
        // A token answer's body holds the tokens, so the decode error stays out of logs.
        Effect.mapError(
          () =>
            new GitHubError({
              operation,
              status: response.status,
              message: "GitHub sent an answer Signalbox does not understand.",
            }),
        ),
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
      ).pipe(
        Effect.map((body) => {
          const ref = body?.data.repository?.defaultBranchRef ?? null;
          return ref === null ? null : { branch: ref.name, oid: ref.target.oid };
        }),
      );
    },
    branchHead: (token: string, repository: string, branch: string) =>
      json(
        "branchHead",
        RefBody,
        HttpClientRequest.get(
          `${api}/repos/${repository}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
        ),
        token,
      ).pipe(Effect.map((body) => body?.object.sha ?? null)),
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
                }),
              )
            : Effect.succeed(toPull(body)),
        ),
      ),
    /** One `git-receive-pack` request (`gitPush.ts` builds it); answers the raw result. */
    receivePack: (token: string, repository: string, body: Uint8Array) =>
      send(
        "receivePack",
        HttpClientRequest.post(`${web}/${repository}.git/git-receive-pack`).pipe(
          HttpClientRequest.setHeaders({
            authorization: gitAuthorization(token),
            accept: "application/x-git-receive-pack-result",
          }),
          HttpClientRequest.bodyUint8Array(body, "application/x-git-receive-pack-request"),
        ),
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
                }),
            ),
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
    /** The host links to this GitHub's pull requests name, e.g. `github.com`. */
    host: new URL(web).host.toLowerCase(),
    /** Where git's smart HTTP for `repository` lives, for the drive's fetch proxy. */
    gitUrl: (repository: string, path: string) => `${web}/${repository}.git/${path}`,
  };
};

export type GitHubApi = ReturnType<typeof makeGitHubApi>;
