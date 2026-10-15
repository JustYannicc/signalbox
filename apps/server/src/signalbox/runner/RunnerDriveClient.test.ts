// @effect-diagnostics nodeBuiltinImport:off - a real HTTP server stands in for the cloud and storage.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DRIVE_PATHS } from "@signalbox/runner-protocol/DriveProtocol";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";

import { makeDriveClient } from "./RunnerDriveClient.ts";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly length: string | undefined;
  readonly bytes: number;
  readonly auth: string | undefined;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** The cloud's drive routes and storage on one local server; `direct` says whether it offers direct uploads. */
const serve = (direct: boolean) =>
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly seen: Array<Seen> }>((resolve) => {
        const seen: Array<Seen> = [];
        const server = NodeHttp.createServer((request, response) => {
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const path = new URL(request.url ?? "/", "http://local").pathname;
            const body = Buffer.concat(chunks);
            seen.push({
              method: request.method ?? "",
              path,
              length: request.headers["content-length"],
              bytes: body.length,
              auth: request.headers.authorization,
            });
            const json = (value: unknown) => {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify(value));
            };
            if (path === DRIVE_PATHS.directUpload) {
              if (!direct) {
                response.writeHead(404);
                response.end("Unknown path.");
                return;
              }
              const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
              json({
                _tag: "direct",
                uploadId: "00000000-0000-4000-8000-000000000000",
                pack: `${origin}/storage/pack?X-Amz-Signature=fake`,
                idx: `${origin}/storage/idx?X-Amz-Signature=fake`,
              });
            } else if (path.startsWith("/storage/")) {
              // Storage refuses a PUT whose length it isn't told, as S3 does.
              response.writeHead(request.headers["content-length"] === undefined ? 411 : 200);
              response.end();
            } else if (path === DRIVE_PATHS.directCommit || path === DRIVE_PATHS.packs) {
              json({ name: "a".repeat(40), objects: 3 });
            } else {
              response.writeHead(404);
              response.end();
            }
          });
        });
        server.listen(0, "127.0.0.1", () => {
          cleanups.push(() => server.close());
          const { port } = server.address() as { port: number };
          resolve({ origin: `http://127.0.0.1:${port}`, seen });
        });
      }),
  );

const packFiles = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "drive-client-"));
  cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  NodeFS.writeFileSync(NodePath.join(dir, "pack"), Buffer.alloc(300_000, 1));
  NodeFS.writeFileSync(NodePath.join(dir, "idx"), Buffer.alloc(2_000, 2));
  return { pack: NodePath.join(dir, "pack"), idx: NodePath.join(dir, "idx") };
};

const access = { driveId: "drive-1", token: "drive-token", remoteToken: null };

describe("the drive client's uploads", () => {
  it.effect(
    "puts a pack straight to storage, with its length and no drive token, then commits it",
    () =>
      Effect.gen(function* () {
        const cloud = yield* serve(true);
        const client = yield* makeDriveClient({ cloudUrl: cloud.origin, access });
        const files = packFiles();
        expect(yield* client.uploadPack(files)).toEqual({ name: "a".repeat(40), objects: 3 });
        const puts = cloud.seen.filter((request) => request.method === "PUT");
        expect(puts.map((put) => [put.path, put.length, put.bytes, put.auth]).toSorted()).toEqual([
          ["/storage/idx", "2000", 2000, undefined],
          ["/storage/pack", "300000", 300000, undefined],
        ]);
        expect(cloud.seen.at(-1)?.path).toBe(DRIVE_PATHS.directCommit);
      }).pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer))),
  );

  it.effect("uploads in a request's body to a cloud from before direct uploads", () =>
    Effect.gen(function* () {
      const cloud = yield* serve(false);
      const client = yield* makeDriveClient({ cloudUrl: cloud.origin, access });
      expect(yield* client.uploadPack(packFiles())).toEqual({ name: "a".repeat(40), objects: 3 });
      expect(cloud.seen.at(-1)).toMatchObject({
        method: "POST",
        path: DRIVE_PATHS.packs,
        bytes: 302_000,
      });
    }).pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer))),
  );
});
