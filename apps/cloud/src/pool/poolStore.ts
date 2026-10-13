import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * The pool's credential store: the slice of the S3 API that CLIProxyAPI's
 * object-store backend (minio-go, path-style) uses, served from the pool
 * object's own SQLite. CLIProxyAPI keeps `config/config.yaml` and
 * `auths/*.json` here, pulls them once when it starts and writes through on
 * every change, token refreshes included, so a container that sleeps or
 * restarts keeps its accounts.
 *
 * Only the pool's own container reaches it (see `PoolContainer.ts`), so no
 * pool can read another pool's credentials. The access key is checked too,
 * but it is not the boundary.
 *
 * Objects are UTF-8 text: CLIProxyAPI only stores YAML and JSON.
 */

/** The one bucket each pool's container is configured with. */
export const POOL_STORE_BUCKET = "pool";

/** The store object CLIProxyAPI reads its config from. */
export const CONFIG_KEY = "config/config.yaml";

export interface StoredObject {
  readonly key: string;
  readonly body: string;
  readonly etag: string;
  readonly updatedAt: number;
}

export class PoolStore extends Context.Service<
  PoolStore,
  {
    readonly get: (key: string) => Effect.Effect<StoredObject | null, SqlError>;
    readonly put: (key: string, body: string) => Effect.Effect<StoredObject, SqlError>;
    readonly remove: (key: string) => Effect.Effect<void, SqlError>;
    readonly list: (prefix: string) => Effect.Effect<ReadonlyArray<StoredObject>, SqlError>;
  }
>()("@signalbox/cloud/pool/poolStore") {}

/** Part of the pool object's first migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE store_objects (
    key TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    etag TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`;
});

interface ObjectRow {
  readonly key: string;
  readonly body: string;
  readonly etag: string;
  readonly updated_at: number;
}

const fromRow = (row: ObjectRow): StoredObject => ({
  key: row.key,
  body: row.body,
  etag: row.etag,
  updatedAt: row.updated_at,
});

export const layer = Layer.effect(
  PoolStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const etagOf = (body: string) =>
      crypto.digest("SHA-256", new TextEncoder().encode(body)).pipe(
        Effect.map((digest) => Hex.encode(digest.slice(0, 16))),
        Effect.orDie,
      );
    return PoolStore.of({
      get: (key) =>
        sql<ObjectRow>`SELECT key, body, etag, updated_at FROM store_objects WHERE key = ${key}`.pipe(
          Effect.map(([row]) => (row ? fromRow(row) : null)),
        ),
      put: (key, body) =>
        Effect.gen(function* () {
          const etag = yield* etagOf(body);
          const updatedAt = yield* Clock.currentTimeMillis;
          yield* sql`INSERT INTO store_objects (key, body, etag, updated_at)
            VALUES (${key}, ${body}, ${etag}, ${updatedAt})
            ON CONFLICT (key) DO UPDATE SET body = excluded.body, etag = excluded.etag,
              updated_at = excluded.updated_at`;
          return { key, body, etag, updatedAt };
        }),
      remove: (key) => Effect.asVoid(sql`DELETE FROM store_objects WHERE key = ${key}`),
      list: (prefix) =>
        sql<ObjectRow>`SELECT key, body, etag, updated_at FROM store_objects
          WHERE substr(key, 1, ${prefix.length}) = ${prefix} ORDER BY key`.pipe(
          Effect.map((rows) => rows.map(fromRow)),
        ),
    });
  }),
);

const S3_NS = "http://s3.amazonaws.com/doc/2006-03-01/";

const escapeXml = (value: string) =>
  value.replace(/[<>&'"]/gu, (char) => `&#${char.charCodeAt(0)};`);

const xml = (body: string, status = 200) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    status,
    headers: { "content-type": "application/xml" },
  });

const s3Error = (method: string, status: number, code: string, message: string) =>
  method === "HEAD"
    ? new Response(null, { status })
    : xml(`<Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`, status);

const objectHeaders = (object: StoredObject, size: number) => ({
  etag: `"${object.etag}"`,
  "content-length": String(size),
  "content-type": "application/octet-stream",
  "last-modified": DateTime.toDateUtc(DateTime.makeUnsafe(object.updatedAt)).toUTCString(),
});

/** The access key in a SigV4 `Authorization` header (`Credential=<key>/<scope>`). */
const accessKeyOf = (authorization: string | null) =>
  /Credential=([^/,\s]+)\//u.exec(authorization ?? "")?.[1] ?? null;

/**
 * The payload of an `aws-chunked` upload, which minio-go sends for every PUT
 * over plain HTTP: `<hex size>;chunk-signature=…\r\n<bytes>\r\n`, repeated,
 * ending with a zero-size chunk and optional trailers. Chunk signatures are
 * not checked: only the pool's own container reaches the store.
 */
export const decodeAwsChunked = (bytes: Uint8Array): Uint8Array | null => {
  const parts: Array<Uint8Array> = [];
  let offset = 0;
  while (offset < bytes.length) {
    let lineEnd = offset;
    while (lineEnd + 1 < bytes.length && !(bytes[lineEnd] === 13 && bytes[lineEnd + 1] === 10)) {
      lineEnd += 1;
    }
    if (lineEnd + 1 >= bytes.length) return null;
    const header = new TextDecoder().decode(bytes.subarray(offset, lineEnd));
    const size = Number.parseInt(header.split(";")[0] ?? "", 16);
    if (!Number.isFinite(size) || size < 0) return null;
    if (size === 0) break;
    const start = lineEnd + 2;
    if (start + size > bytes.length) return null;
    parts.push(bytes.subarray(start, start + size));
    offset = start + size + 2;
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
};

const isChunkedUpload = (request: Request) =>
  (request.headers.get("x-amz-content-sha256") ?? "").startsWith("STREAMING-") ||
  (request.headers.get("content-encoding") ?? "").includes("aws-chunked");

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The upload's text, or null when it can't be read or isn't UTF-8. */
const readBody = (request: Request) =>
  Effect.tryPromise(async () => {
    const raw = new Uint8Array(await request.arrayBuffer());
    const bytes = isChunkedUpload(request) ? decodeAwsChunked(raw) : raw;
    return bytes === null ? null : utf8.decode(bytes);
  }).pipe(Effect.orElseSucceed(() => null));

const listResult = (prefix: string, objects: ReadonlyArray<StoredObject>, urlEncoded: boolean) => {
  const encodeKey = (key: string) => escapeXml(urlEncoded ? encodeURIComponent(key) : key);
  const contents = objects
    .map(
      (object) =>
        `<Contents><Key>${encodeKey(object.key)}</Key>` +
        `<LastModified>${DateTime.formatIso(DateTime.makeUnsafe(object.updatedAt))}</LastModified>` +
        `<ETag>"${object.etag}"</ETag>` +
        `<Size>${new TextEncoder().encode(object.body).length}</Size>` +
        `<StorageClass>STANDARD</StorageClass></Contents>`,
    )
    .join("");
  return xml(
    `<ListBucketResult xmlns="${S3_NS}"><Name>${POOL_STORE_BUCKET}</Name>` +
      `<Prefix>${encodeKey(prefix)}</Prefix><KeyCount>${objects.length}</KeyCount>` +
      `<MaxKeys>1000</MaxKeys>${urlEncoded ? "<EncodingType>url</EncodingType>" : ""}` +
      `<IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
  );
};

/**
 * Answers one S3 request from the pool's container. `accessKey` is the key the
 * pool configured its container with.
 */
export const handleStoreRequest = (request: Request, accessKey: string) =>
  Effect.gen(function* () {
    const store = yield* PoolStore;
    const { method } = request;
    if (accessKeyOf(request.headers.get("authorization")) !== accessKey) {
      return s3Error(method, 403, "InvalidAccessKeyId", "Unknown access key.");
    }
    const url = new URL(request.url);
    const [bucket = "", ...keyParts] = url.pathname.slice(1).split("/");
    if (decodeURIComponent(bucket) !== POOL_STORE_BUCKET) {
      return s3Error(method, 404, "NoSuchBucket", "No such bucket.");
    }
    const key = keyParts.map(decodeURIComponent).join("/");

    if (key === "") {
      if (method === "HEAD" || method === "PUT") return new Response(null, { status: 200 });
      if (method !== "GET") return s3Error(method, 405, "MethodNotAllowed", "Not supported.");
      if (url.searchParams.has("location")) {
        return xml(`<LocationConstraint xmlns="${S3_NS}"></LocationConstraint>`);
      }
      const prefix = url.searchParams.get("prefix") ?? "";
      return listResult(
        prefix,
        yield* store.list(prefix),
        url.searchParams.get("encoding-type") === "url",
      );
    }

    switch (method) {
      case "GET":
      case "HEAD": {
        const object = yield* store.get(key);
        if (object === null) return s3Error(method, 404, "NoSuchKey", "No such key.");
        const body = new TextEncoder().encode(object.body);
        return new Response(method === "HEAD" ? null : body, {
          headers: objectHeaders(object, body.length),
        });
      }
      case "PUT": {
        const body = yield* readBody(request);
        if (body === null) return s3Error(method, 400, "InvalidRequest", "Unreadable body.");
        const object = yield* store.put(key, body);
        return new Response(null, { headers: { etag: `"${object.etag}"` } });
      }
      case "DELETE":
        yield* store.remove(key);
        return new Response(null, { status: 204 });
      default:
        return s3Error(method, 405, "MethodNotAllowed", "Not supported.");
    }
  });
