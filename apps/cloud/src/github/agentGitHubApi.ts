import { PR_IMAGE_LIMIT } from "@signalbox/runner-protocol/PullRequestTools";
import { retryAtFromHeader } from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { type HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import {
  defaultGitHubEndpoints,
  GitHubError,
  type GitHubEndpoints,
  unreadable,
} from "./GitHubApiSupport.ts";

const PAGE_LIMIT = 10;
const PER_PAGE = 100;
const MANUAL_REDIRECT: RequestInit = { redirect: "manual" };
const JSON_ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const ImageUploadBody = Schema.Struct({ url: Schema.String });
const RepositoryUploadBody = Schema.Struct({
  id: Schema.Number,
  permissions: Schema.optional(
    Schema.Struct({
      admin: Schema.optional(Schema.Boolean),
      maintain: Schema.optional(Schema.Boolean),
      push: Schema.optional(Schema.Boolean),
    }),
  ),
});
const ListBody = Schema.fromJsonString(Schema.Array(Schema.Unknown));
const encodeComments = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      issueComments: Schema.Array(Schema.Unknown),
      reviewComments: Schema.Array(Schema.Unknown),
      reviews: Schema.Array(Schema.Unknown),
    }),
  ),
);
const decodeImageUpload = Schema.decodeUnknownOption(Schema.fromJsonString(ImageUploadBody));
const decodeRepositoryUpload = Schema.decodeUnknownOption(
  Schema.fromJsonString(RepositoryUploadBody),
);
const decodeList = Schema.decodeUnknownOption(ListBody);

const repositoryPath = (operation: string, repository: string) => {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    return Effect.fail(
      new GitHubError({ operation, status: 0, message: "GitHub repository is invalid." }),
    );
  }
  return Effect.succeed(`/repos/${parts.map(encodeURIComponent).join("/")}`);
};

const retryTime = (response: HttpClientResponse.HttpClientResponse, now: number) => {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const retryAfter = retryAtFromHeader(response.headers["retry-after"], now);
  if (retryAfter !== undefined) return retryAfter;
  if (response.headers["x-ratelimit-remaining"] !== "0") return undefined;
  const reset = Number(response.headers["x-ratelimit-reset"]);
  return Number.isFinite(reset) ? reset * 1_000 : now + 60_000;
};

const githubError = (operation: string, status: number, retryAt?: number) =>
  new GitHubError({
    operation,
    status,
    message: `GitHub ${operation} failed (HTTP ${status}).`,
    ...(retryAt === undefined ? {} : { retryAt }),
  });

export const makeAgentGitHubApi = (
  client: HttpClient.HttpClient,
  endpoints: GitHubEndpoints = defaultGitHubEndpoints,
) => {
  const api = endpoints.api.replace(/\/+$/, "");
  const uploads = (endpoints.uploads ?? "https://uploads.github.com").replace(/\/+$/, "");

  const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request.pipe(HttpClientRequest.setHeader("user-agent", "signalbox-cloud"))).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("GitHub request failed", {
          operation,
          reason: error.reason._tag,
        }),
      ),
      Effect.mapError(
        () => new GitHubError({ operation, status: 0, message: "GitHub did not answer." }),
      ),
      Effect.provideService(FetchHttpClient.RequestInit, MANUAL_REDIRECT),
    );

  const asUser = (request: HttpClientRequest.HttpClientRequest, token: string) =>
    request.pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${token}`,
        accept: JSON_ACCEPT,
        "x-github-api-version": API_VERSION,
      }),
    );

  const responseText = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
    response.text.pipe(
      Effect.mapError(
        () =>
          new GitHubError({
            operation,
            status: response.status,
            message: "GitHub's answer was cut off.",
          }),
      ),
    );

  const handleResponse = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
    Effect.gen(function* () {
      const text = yield* responseText(operation, response);
      if (response.status === 404) return null;
      if (response.status < 200 || response.status >= 300) {
        const retryAt = retryTime(response, yield* Clock.currentTimeMillis);
        return yield* githubError(operation, response.status, retryAt);
      }
      return text;
    });

  const rest = (
    operation: string,
    token: string,
    path: string,
    params: Readonly<Record<string, string>> = {},
  ) => {
    const url = new URL(`${api}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return send(operation, asUser(HttpClientRequest.get(url), token)).pipe(
      Effect.flatMap((response) => handleResponse(operation, response)),
      Effect.scoped,
    );
  };

  const allPages = (operation: string, token: string, path: string) =>
    Effect.gen(function* () {
      const items: Array<unknown> = [];
      for (let page = 1; page <= PAGE_LIMIT; page += 1) {
        const text = yield* rest(operation, token, path, {
          per_page: String(PER_PAGE),
          page: String(page),
        });
        if (text === null) return null;
        const decoded = decodeList(text);
        if (Option.isNone(decoded)) return yield* unreadable(operation);
        items.push(...decoded.value);
        if (decoded.value.length < PER_PAGE) return items;
      }
      return yield* new GitHubError({
        operation,
        status: 200,
        message: "GitHub returned more pages than Signalbox can read completely.",
      });
    });

  const agentPull = (token: string, repository: string, number: number) =>
    Effect.gen(function* () {
      const path = yield* repositoryPath("agentPull", repository);
      return yield* rest("agentPull", token, `${path}/pulls/${encodeURIComponent(String(number))}`);
    });

  const agentComments = (token: string, repository: string, number: number) =>
    Effect.gen(function* () {
      const path = yield* repositoryPath("agentComments", repository);
      const pull = encodeURIComponent(String(number));
      const [issueComments, reviewComments, reviews] = yield* Effect.all(
        [
          allPages("agentComments.issueComments", token, `${path}/issues/${pull}/comments`),
          allPages("agentComments.reviewComments", token, `${path}/pulls/${pull}/comments`),
          allPages("agentComments.reviews", token, `${path}/pulls/${pull}/reviews`),
        ],
        { concurrency: 3 },
      );
      if (issueComments === null || reviewComments === null || reviews === null) return null;
      return yield* encodeComments({ issueComments, reviewComments, reviews }).pipe(
        Effect.mapError(() => unreadable("agentComments")),
      );
    });

  const jsonWrite = (
    operation: string,
    method: "POST" | "PATCH",
    token: string,
    path: string,
    body: unknown,
  ) =>
    send(
      operation,
      asUser(
        HttpClientRequest.make(method)(`${api}${path}`).pipe(
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
        token,
      ),
    ).pipe(
      Effect.flatMap((response) => handleResponse(operation, response)),
      Effect.scoped,
    );

  const agentEdit = (token: string, repository: string, number: number, body: string) =>
    Effect.gen(function* () {
      const path = yield* repositoryPath("agentEdit", repository);
      return yield* jsonWrite(
        "agentEdit",
        "PATCH",
        token,
        `${path}/pulls/${encodeURIComponent(String(number))}`,
        { body },
      );
    });

  const agentComment = (token: string, repository: string, number: number, body: string) =>
    Effect.gen(function* () {
      const path = yield* repositoryPath("agentComment", repository);
      return yield* jsonWrite(
        "agentComment",
        "POST",
        token,
        `${path}/issues/${encodeURIComponent(String(number))}/comments`,
        { body },
      );
    });

  const agentReply = (
    token: string,
    repository: string,
    number: number,
    commentId: string,
    body: string,
  ) =>
    Effect.gen(function* () {
      const path = yield* repositoryPath("agentReply", repository);
      return yield* jsonWrite(
        "agentReply",
        "POST",
        token,
        `${path}/pulls/${encodeURIComponent(String(number))}/comments/${encodeURIComponent(commentId)}/replies`,
        { body },
      );
    });

  const agentImage = (
    token: string,
    repository: string,
    name: string,
    mimeType: string,
    bytes: Uint8Array,
  ) =>
    Effect.gen(function* () {
      const path = yield* repositoryPath("agentImage", repository);
      const fileName = name.split(/[\\/]/).at(-1) ?? "";
      const expectedMime = IMAGE_TYPES[fileName.slice(fileName.lastIndexOf(".")).toLowerCase()];
      const contentType = mimeType.trim().toLowerCase();
      if (
        fileName.length === 0 ||
        expectedMime === undefined ||
        expectedMime !== contentType ||
        bytes.byteLength === 0 ||
        bytes.byteLength > PR_IMAGE_LIMIT
      ) {
        return yield* new GitHubError({
          operation: "agentImage",
          status: 0,
          message: "The image type, name, or size is unsupported.",
        });
      }

      const repositoryText = yield* rest("agentImage.repository", token, path);
      if (repositoryText === null) return null;
      const repositoryBody = decodeRepositoryUpload(repositoryText);
      if (
        Option.isNone(repositoryBody) ||
        !Number.isSafeInteger(repositoryBody.value.id) ||
        repositoryBody.value.id <= 0
      ) {
        return yield* unreadable("agentImage.repository");
      }
      const permissions = repositoryBody.value.permissions;
      if (
        permissions === undefined ||
        !(permissions.admin === true || permissions.maintain === true || permissions.push === true)
      ) {
        return yield* new GitHubError({
          operation: "agentImage",
          status: 403,
          message: "Attaching files requires write access to the repository.",
        });
      }

      const url = new URL(`${uploads}/user-attachments/assets`);
      url.searchParams.set("name", fileName);
      url.searchParams.set("content_type", contentType);
      url.searchParams.set("repository_id", String(repositoryBody.value.id));
      const request = HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders({
          authorization: `token ${token}`,
          accept: JSON_ACCEPT,
        }),
        HttpClientRequest.bodyUint8Array(bytes, "application/octet-stream"),
      );
      return yield* Effect.gen(function* () {
        const response = yield* send("agentImage", request);
        const text = yield* responseText("agentImage", response);
        if (response.status === 404) return null;
        if (response.status < 200 || response.status >= 300) {
          const retryAt = retryTime(response, yield* Clock.currentTimeMillis);
          return yield* githubError("agentImage", response.status, retryAt);
        }
        const decoded = decodeImageUpload(text);
        if (Option.isNone(decoded)) return yield* unreadable("agentImage");
        let asset: URL;
        try {
          asset = new URL(decoded.value.url);
        } catch {
          return yield* new GitHubError({
            operation: "agentImage",
            status: response.status,
            message: "GitHub returned an unsupported attachment URL.",
          });
        }
        if (
          asset.origin !== "https://github.com" ||
          asset.username !== "" ||
          asset.password !== "" ||
          !/^\/user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            asset.pathname,
          ) ||
          asset.search !== "" ||
          asset.hash !== ""
        ) {
          return yield* new GitHubError({
            operation: "agentImage",
            status: response.status,
            message: "GitHub returned an unsupported attachment URL.",
          });
        }
        return { url: asset.toString() };
      }).pipe(Effect.scoped);
    });

  return { agentPull, agentComments, agentEdit, agentComment, agentReply, agentImage };
};
