import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { GitHubError, makeGitHubApi } from "./GitHubApi.ts";

const token = "github-blob-range-secret-canary";
const repository = "acme/source";
const sha = "f5db4be048abf9a41e6c42454a4f03f65f56185d";

const responseClient = (
  body: BodyInit | null,
  status = 206,
  headers: Record<string, string> = {},
) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status, headers }))),
  );

it.effect("reads consecutive raw byte ranges with the usual authenticated headers", () => {
  const requests: Array<Record<string, string | undefined>> = [];
  const content = new Uint8Array([0, 128, 255, 3, 4, 5, 6]);
  const client = HttpClient.make((request) => {
    requests.push({ url: request.url, ...request.headers });
    const offset = (requests.length - 1) * 3;
    const end = Math.min(offset + 2, content.byteLength - 1);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(content.slice(offset, end + 1), {
          status: 206,
          headers: { "content-range": `bytes ${offset}-${end}/${content.byteLength}` },
        }),
      ),
    );
  });
  return Effect.gen(function* () {
    const api = makeGitHubApi(client);
    for (const offset of [0, 3, 6]) {
      const result = yield* api.blobRange(token, repository, sha, offset, 3);
      expect(result).toEqual({
        bytes: content.slice(offset, offset + 3),
        size: 7,
        complete: offset === 6,
      });
    }
    expect(requests.map((request) => request.range)).toEqual([
      "bytes=0-2",
      "bytes=3-5",
      "bytes=6-8",
    ]);
    for (const request of requests) {
      expect(request).toMatchObject({
        url: `https://api.github.com/repos/${repository}/git/blobs/${sha}`,
        accept: "application/vnd.github.raw+json",
        authorization: `Bearer ${token}`,
        "user-agent": "signalbox-cloud",
        "x-github-api-version": "2022-11-28",
      });
    }
  });
});

it.effect.each([3, 16])("keeps an unknown total incomplete for a %i-byte range", (length) =>
  Effect.gen(function* () {
    const bytes = new Uint8Array(length).fill(127);
    const api = makeGitHubApi(
      responseClient(bytes, 206, {
        "content-range": `bytes 0-${length - 1}/*`,
      }),
    );
    expect(yield* api.blobRange(token, repository, sha, 0, 16)).toEqual({
      bytes,
      size: null,
      complete: false,
    });
  }),
);

it.effect("joins streamed chunks without decoding the raw bytes", () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([255]));
      controller.enqueue(new Uint8Array([0, 128]));
      controller.close();
    },
  });
  return Effect.gen(function* () {
    const api = makeGitHubApi(responseClient(body, 206, { "content-range": "bytes 4-6/7" }));
    expect(yield* api.blobRange(token, repository, sha, 4, 3)).toEqual({
      bytes: new Uint8Array([255, 0, 128]),
      size: 7,
      complete: true,
    });
  });
});

it.effect.each([
  { offset: 7, size: 7 },
  { offset: 9, size: 7 },
  { offset: 0, size: 0 },
  { offset: Number.MAX_SAFE_INTEGER, size: 51173 },
])("accepts a verified 416 EOF at $offset for size $size", ({ offset, size }) =>
  Effect.gen(function* () {
    const api = makeGitHubApi(responseClient(null, 416, { "content-range": `bytes */${size}` }));
    expect(yield* api.blobRange(token, repository, sha, offset, 16)).toEqual({
      bytes: new Uint8Array(0),
      size,
      complete: true,
    });
  }),
);

it.effect.each([
  { status: 206, header: undefined },
  { status: 206, header: "items 4-6/7" },
  { status: 206, header: "bytes 3-5/7" },
  { status: 206, header: "bytes 4-3/7" },
  { status: 206, header: "bytes 4-7/8" },
  { status: 206, header: "bytes 4-6/6" },
  { status: 206, header: "bytes 4-6/0" },
  { status: 206, header: "bytes 4-6/-1" },
  { status: 206, header: "bytes 4-6/9007199254740992" },
  { status: 206, header: "bytes 4-6/7 trailing" },
  { status: 206, header: "bytes 4-6/7, bytes 4-6/7" },
  { status: 206, header: "bytes */7" },
  { status: 416, header: undefined },
  { status: 416, header: "bytes */*" },
  { status: 416, header: "bytes */5" },
  { status: 416, header: "bytes */9007199254740992" },
  { status: 416, header: "bytes */-1" },
  { status: 416, header: "bytes 4-6/7" },
])("rejects an invalid $status Content-Range $header", ({ status, header }) =>
  Effect.gen(function* () {
    const api = makeGitHubApi(
      responseClient(
        new Uint8Array(3),
        status,
        header === undefined ? {} : { "content-range": header },
      ),
    );
    const error = yield* api.blobRange(token, repository, sha, 4, 3).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "GitHubError", operation: "blobRange", status });
  }),
);

it.effect.each([0, 2, 4])("rejects a %i-byte body for a reported 3-byte range", (length) =>
  Effect.gen(function* () {
    const api = makeGitHubApi(
      responseClient(new Uint8Array(length), 206, {
        "content-range": "bytes 4-6/7",
        "content-length": "3",
      }),
    );
    const error = yield* api.blobRange(token, repository, sha, 4, 3).pipe(Effect.flip);
    expect(error).toMatchObject({ operation: "blobRange", status: 206 });
    expect(error.message).toBe("GitHub sent an invalid or unreadable blob range.");
  }),
);

it.effect.each([0, 2, 3])("accepts a complete %i-byte 200 fallback at offset zero", (length) =>
  Effect.gen(function* () {
    const bytes = new Uint8Array(length).fill(255);
    const api = makeGitHubApi(responseClient(length === 0 ? null : bytes, 200));
    expect(yield* api.blobRange(token, repository, sha, 0, 3)).toEqual({
      bytes,
      size: length,
      complete: true,
    });
  }),
);

it.effect.each([200, 206])(
  "stops and cancels an oversized %i stream despite a false Content-Length",
  (status) => {
    let pulls = 0;
    let canceled = false;
    let signal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(4));
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const client = HttpClient.make((request, _url, requestSignal) => {
      signal = requestSignal;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, {
            status,
            headers: {
              "content-length": "1",
              ...(status === 206 ? { "content-range": "bytes 0-2/*" } : {}),
            },
          }),
        ),
      );
    });
    const api = makeGitHubApi(client);
    return Effect.gen(function* () {
      const error = yield* api.blobRange(token, repository, sha, 0, 3).pipe(Effect.flip);
      expect(error.status).toBe(status);
      expect(pulls).toBe(1);
      expect(canceled).toBe(true);
      expect(signal?.aborted).toBe(true);
    });
  },
);

it.effect(
  "rejects a 200 at a nonzero offset without pulling its body and releases the request",
  () => {
    let pulls = 0;
    let signal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(100));
        },
      },
      { highWaterMark: 0 },
    );
    const client = HttpClient.make((request, _url, requestSignal) => {
      signal = requestSignal;
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
    });
    return Effect.gen(function* () {
      const error = yield* makeGitHubApi(client)
        .blobRange(token, repository, sha, 4, 3)
        .pipe(Effect.flip);
      expect(error.status).toBe(200);
      expect(pulls).toBe(0);
      expect(signal?.aborted).toBe(true);
      expect(body.locked).toBe(false);
    });
  },
);

it.effect.each([
  { offset: -1, length: 1 },
  { offset: 0.5, length: 1 },
  { offset: Number.NaN, length: 1 },
  { offset: Number.POSITIVE_INFINITY, length: 1 },
  { offset: Number.MAX_SAFE_INTEGER + 1, length: 1 },
  { offset: 0, length: 0 },
  { offset: 0, length: -1 },
  { offset: 0, length: 1.5 },
  { offset: 0, length: 65537 },
  { offset: 0, length: Number.NaN },
  { offset: 0, length: Number.POSITIVE_INFINITY },
])("rejects invalid input $offset/$length before calling HTTP", ({ offset, length }) => {
  let calls = 0;
  const client = HttpClient.make((request) => {
    calls += 1;
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null)));
  });
  return Effect.gen(function* () {
    const error = yield* makeGitHubApi(client)
      .blobRange(token, repository, sha, offset, length)
      .pipe(Effect.flip);
    expect(error).toMatchObject({ operation: "blobRange", status: 0 });
    expect(calls).toBe(0);
  });
});

it.effect("accepts 64 KiB and forms exact range ends near the safe-integer limit", () => {
  const ranges: Array<string | undefined> = [];
  const client = HttpClient.make((request) => {
    ranges.push(request.headers.range);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(new Uint8Array(65536), {
          status: 206,
          headers: { "content-range": "bytes 0-65535/65536" },
        }),
      ),
    );
  });
  return Effect.gen(function* () {
    const api = makeGitHubApi(client);
    const result = yield* api.blobRange(token, repository, sha, 0, 65536);
    expect(result?.bytes.byteLength).toBe(65536);
    expect(result?.complete).toBe(true);
    yield* api.blobRange(token, repository, sha, Number.MAX_SAFE_INTEGER, 3).pipe(Effect.flip);
    expect(ranges).toEqual(["bytes=0-65535", "bytes=9007199254740991-9007199254740993"]);
  });
});

it.effect.each([404, 429, 403])(
  "preserves %i and bounded rate-limit diagnostics without reading error bodies",
  (status) => {
    let pulls = 0;
    let signal: AbortSignal | undefined;
    const logs: Array<string> = [];
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode(token.repeat(1024)));
        },
      },
      { highWaterMark: 0 },
    );
    const client = HttpClient.make((request, _url, requestSignal) => {
      signal = requestSignal;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, {
            status,
            headers: {
              "retry-after": "60",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-resource": "core",
              "content-type": `application/problem+json; token=${token}`,
            },
          }),
        ),
      );
    });
    return Effect.gen(function* () {
      const api = makeGitHubApi(client);
      if (status === 404) {
        expect(yield* api.blobRange(token, repository, sha, 0, 16)).toBeNull();
      } else {
        const now = yield* Clock.currentTimeMillis;
        const error = yield* api.blobRange(token, repository, sha, 0, 16).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "GitHubError",
          operation: "blobRange",
          status,
          requestKind: "rest",
          retryAt: now + 60000,
          responseRateLimits: { remaining: "0", resource: "core", retryAfter: "60" },
        });
        expect(error.message).toBe("GitHub refused the blob range request.");
        expect(error.responseExcerpt).toBeUndefined();
        expect(error.responseContentType).toContain("[redacted]");
        expect(JSON.stringify(error)).not.toContain(token);
      }
      expect(pulls).toBe(0);
      expect(signal?.aborted).toBe(true);
      expect(logs.join("\n")).not.toContain(token);
    }).pipe(
      Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => void logs.push(line))])),
    );
  },
);

it.effect("keeps transport failures typed and their text out of logs", () => {
  const logs: Array<string> = [];
  let cause: HttpClientError.HttpClientError | undefined;
  const client = HttpClient.make((request) => {
    cause = new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, cause: new Error(token) }),
    });
    return Effect.fail(cause);
  });
  return Effect.gen(function* () {
    const error = yield* makeGitHubApi(client)
      .blobRange(token, repository, sha, 0, 16)
      .pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "GitHubError", operation: "blobRange", status: 0 });
    expect(error.message).toBe("GitHub did not answer.");
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.cause).toBe(cause);
    expect(logs.join("\n")).toContain("TransportError");
    expect(logs.join("\n")).not.toContain(token);
  }).pipe(
    Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => void logs.push(line))])),
  );
});

it.effect("preserves the immediate read failure without copying its message", () => {
  const cause = new Error(token);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(cause);
    },
  });
  const api = makeGitHubApi(responseClient(body, 206, { "content-range": "bytes 0-2/3" }));
  return Effect.gen(function* () {
    const error = yield* api.blobRange(token, repository, sha, 0, 3).pipe(Effect.flip);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.message).toBe("GitHub sent an invalid or unreadable blob range.");
    expect(error.cause).toMatchObject({
      _tag: "HttpClientError",
      reason: { _tag: "DecodeError", cause },
    });
  });
});

it.effect("keeps malformed range and rate-limit headers safe in diagnostics", () => {
  const logs: Array<string> = [];
  const api = makeGitHubApi(
    responseClient(null, 206, {
      "content-range": `bytes ${token}`,
      "x-ratelimit-resource": `${token}${"x".repeat(500)}`,
    }),
  );
  return Effect.gen(function* () {
    const error = yield* api.blobRange(token, repository, sha, 0, 3).pipe(Effect.flip);
    expect(error.responseRateLimits?.resource).toContain("[redacted]");
    expect(error.responseRateLimits?.resource?.length).toBeLessThanOrEqual(121);
    expect(JSON.stringify(error) + logs.join("\n")).not.toContain(token);
  }).pipe(
    Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => void logs.push(line))])),
  );
});
