// @effect-diagnostics cryptoRandomUUID:off - generated throwaway credentials and a local in-memory storage transport.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Platform from "../../platform.ts";
import { DriveDirectory } from "../../drive/DriveDirectory.ts";
import { makeDirectUploads, s3Storage } from "../../drive/directUploads.ts";
import { makeMemoryDrives, makeRepo } from "../../drive/driveTesting.ts";
import { makePlatformUpload } from "./egressUpload.ts";
import { serveWithFakeNetwork as serveEgress } from "./egressTestKit.ts";

const DRIVE = "my/personal/upload-test";
const MANAGER = {
  userId: "upload-test",
  email: "test@example.test",
  name: null,
  role: "manager",
} as const;
const value = `sk-test-${crypto.randomUUID()}`;
const env = {
  DRIVE_PACKS_S3_ACCESS_KEY_ID: `test-${crypto.randomUUID()}`,
  DRIVE_PACKS_S3_SECRET_ACCESS_KEY: crypto.randomUUID(),
  DRIVE_PACKS_S3_ENDPOINT: "https://storage.example.test",
  DRIVE_PACKS_BUCKET_NAME: "private-drive-packs",
};

const registration = {
  registered: 1,
  registeredRunId: "test-run",
  revision: 1,
  current: [{ name: "KEY", value }],
  values: [{ name: "KEY", value }],
};

describe("platform drive upload through guarded egress", () => {
  it.effect("uploads and commits the real direct-upload request while secrets are loaded", () => {
    const drives = makeMemoryDrives();
    return Effect.gen(function* () {
      const repo = makeRepo();
      try {
        repo.write("notes.md", "a guarded turn still saves its work\n");
        const head = repo.commit("first");
        const packed = repo.pack([head]);
        const handle = (yield* DriveDirectory).forDrive(DRIVE);
        yield* handle.setup({ name: "Upload test", members: [MANAGER] });
        const signer = s3Storage(env)!;
        const uploads = makeDirectUploads({
          bucket: drives.bucket,
          storage: {
            presignPut: signer.presignPut,
            copy: async (from, to) => {
              const object = await drives.bucket.get(from);
              if (object === null) throw new Error("Missing test upload.");
              await drives.bucket.put(to, new Uint8Array(await object.arrayBuffer()));
            },
          },
        });
        const offer = yield* uploads.offer(DRIVE, {
          packSize: packed.pack.byteLength,
          idxSize: packed.idx.byteLength,
        });
        if (offer._tag !== "direct") return expect.unreachable();
        let approvals = 0;
        const send = async (request: Request) => {
          const key = decodeURIComponent(new URL(request.url).pathname).slice(
            `/${env.DRIVE_PACKS_BUCKET_NAME}/`.length,
          );
          await drives.bucket.put(key, new Uint8Array(await request.arrayBuffer()));
          return new Response(null, { status: 200 });
        };
        for (const [url, bytes] of [
          [offer.pack, packed.pack],
          [offer.idx, packed.idx],
        ] as const) {
          const response = yield* Effect.promise(() =>
            serveEgress(
              new Request(url, {
                method: "PUT",
                headers: {
                  "content-type": "application/octet-stream",
                  "content-length": String(bytes.byteLength),
                },
                body: bytes,
              }),
              {
                ownHosts: new Set(["cloud.example.test", "gateway.example.test"]),
                platformUpload: makePlatformUpload({ env, drive: async () => DRIVE, send }),
                thread: {
                  secrets: async () => registration,
                  authorize: async () => {
                    approvals++;
                    return { _tag: "refused", message: "not a secret send" };
                  },
                },
                send,
              },
            ),
          );
          expect(response.status).toBe(200);
        }
        expect(approvals).toBe(0);
        expect(
          yield* uploads.commit({
            driveId: DRIVE,
            threadId: "thread-upload",
            uploadId: offer.uploadId,
          }),
        ).toMatchObject({ _tag: "ok", name: packed.name });
        expect((yield* handle.locate([head])).length).toBe(1);
      } finally {
        repo.cleanup();
      }
    }).pipe(Effect.provide(Layer.mergeAll(drives.layer, Platform.layerCrypto)));
  });
});
