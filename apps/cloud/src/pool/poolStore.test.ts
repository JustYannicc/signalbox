import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PoolStore from "./poolStore.ts";

const ACCESS_KEY = "access-1";
const ORIGIN = "http://store.pool.internal";

const layer = PoolStore.layer.pipe(
  Layer.provideMerge(Layer.effectDiscard(PoolStore.createTables)),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

/** A request as minio-go signs it: SigV4 with the access key in the credential scope. */
const s3 = (method: string, path: string, init: RequestInit = {}, accessKey = ACCESS_KEY) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    ...init,
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/20261008/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=abc`,
      ...init.headers,
    },
  });

const handle = (request: Request) => PoolStore.handleStoreRequest(request, ACCESS_KEY);

/** minio-go's body for a PUT over plain HTTP. */
const awsChunked = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return `${bytes.length.toString(16)};chunk-signature=aaa\r\n${text}\r\n0;chunk-signature=bbb\r\n\r\n`;
};

describe("pool store", () => {
  it.effect("keeps what CLIProxyAPI writes, the way minio-go writes and reads it", () =>
    Effect.gen(function* () {
      const body = JSON.stringify({ type: "claude", email: "a@example.test" });
      const put = yield* handle(
        s3("PUT", "/pool/auths/claude-a.json", {
          body: awsChunked(body),
          headers: { "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD" },
        }),
      );
      expect(put.status).toBe(200);
      expect(put.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/u);

      const get = yield* handle(s3("GET", "/pool/auths/claude-a.json"));
      expect(yield* Effect.promise(() => get.text())).toBe(body);

      const head = yield* handle(s3("HEAD", "/pool/auths/claude-a.json"));
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(body.length));

      const list = yield* handle(s3("GET", "/pool?list-type=2&encoding-type=url&prefix=auths%2F"));
      const xml = yield* Effect.promise(() => list.text());
      expect(xml).toContain("<Key>auths%2Fclaude-a.json</Key>");
      expect(xml).toContain("<KeyCount>1</KeyCount>");

      expect((yield* handle(s3("DELETE", "/pool/auths/claude-a.json"))).status).toBe(204);
      const gone = yield* handle(s3("GET", "/pool/auths/claude-a.json"));
      expect(gone.status).toBe(404);
      expect(yield* Effect.promise(() => gone.text())).toContain("<Code>NoSuchKey</Code>");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists only under the prefix asked for", () =>
    Effect.gen(function* () {
      const store = yield* PoolStore.PoolStore;
      yield* store.put("config/config.yaml", "port: 8317");
      yield* store.put("auths/b.json", "{}");
      const list = yield* handle(s3("GET", "/pool?list-type=2&prefix=auths/"));
      const xml = yield* Effect.promise(() => list.text());
      expect(xml).toContain("<Key>auths/b.json</Key>");
      expect(xml).not.toContain("config.yaml");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("answers the bucket calls minio-go makes before anything else", () =>
    Effect.gen(function* () {
      expect((yield* handle(s3("HEAD", "/pool"))).status).toBe(200);
      const location = yield* handle(s3("GET", "/pool?location="));
      expect(yield* Effect.promise(() => location.text())).toContain("<LocationConstraint");
      expect((yield* handle(s3("HEAD", "/pool/config/config.yaml"))).status).toBe(404);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses another key and another bucket", () =>
    Effect.gen(function* () {
      const store = yield* PoolStore.PoolStore;
      yield* store.put("auths/a.json", "{}");
      expect((yield* handle(s3("GET", "/pool/auths/a.json", {}, "someone-else"))).status).toBe(403);
      expect((yield* handle(s3("GET", "/other/auths/a.json"))).status).toBe(404);
    }).pipe(Effect.provide(layer)),
  );

  it("decodes aws-chunked bodies across several chunks", () => {
    const encoded = new TextEncoder().encode(
      "3;chunk-signature=a\r\nabc\r\n2;chunk-signature=b\r\nde\r\n0;chunk-signature=c\r\nx-amz-checksum-crc32:AAAA\r\n\r\n",
    );
    expect(new TextDecoder().decode(PoolStore.decodeAwsChunked(encoded)!)).toBe("abcde");
    expect(PoolStore.decodeAwsChunked(new TextEncoder().encode("ff;sig\r\nshort"))).toBeNull();
  });
});
