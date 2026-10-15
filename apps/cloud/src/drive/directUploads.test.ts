// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalTimersInEffect:off - real git and a file-backed bucket on temp dirs, memory sampled while committing.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Platform from "../platform.ts";
import { DriveDirectory } from "./DriveDirectory.ts";
import { drivePackKey, type PackBucket } from "./DrivePacks.ts";
import { type DirectStorage, incomingKey, makeDirectUploads } from "./directUploads.ts";
import { makeMemoryDrives, makeRepo } from "./driveTesting.ts";
import type { Bytes } from "./git/gitObjects.ts";

const DRIVE = "my/personal/user_1";
const MANAGER = { userId: "user_1", email: "a@b.c", name: null, role: "manager" } as const;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Storage as S3 gives it: a presigned URL names the key; copying stays in the bucket. */
const storageOver = (bucket: PackBucket, copy?: (from: string, to: string) => Promise<void>) =>
  ({
    presignPut: async (key) => `https://storage.test/${key}?X-Amz-Signature=fake`,
    copy:
      copy ??
      (async (from, to) => {
        const object = await bucket.get(from);
        if (object === null) throw new Error(`no ${from}`);
        await bucket.put(to, new Uint8Array(await object.arrayBuffer()));
      }),
  }) satisfies DirectStorage;

/** What the machine does with an offered URL: puts the bytes at its key. */
const keyOf = (url: string) => new URL(url).pathname.slice(1);

describe("direct uploads", () => {
  it.effect(
    "checks an upload from storage, keeps it with the drive's packs and drops the upload",
    () =>
      Effect.gen(function* () {
        const drives = makeMemoryDrives();
        const repo = makeRepo();
        cleanups.push(repo.cleanup);
        repo.write("notes.md", "hello\n");
        const head = repo.commit("first");
        const packed = repo.pack([head]);
        const handle = (yield* DriveDirectory).forDrive(DRIVE);
        yield* handle.setup({ name: "Mine", members: [MANAGER] });
        const uploads = makeDirectUploads({
          bucket: drives.bucket,
          storage: storageOver(drives.bucket),
        });

        const offer = yield* uploads.offer(DRIVE, {
          packSize: packed.pack.length,
          idxSize: packed.idx.length,
        });
        if (offer._tag !== "direct") return expect.unreachable();
        yield* Effect.promise(() => drives.bucket.put(keyOf(offer.pack), packed.pack));
        yield* Effect.promise(() => drives.bucket.put(keyOf(offer.idx), packed.idx));
        const committed = yield* uploads.commit({
          driveId: DRIVE,
          threadId: "t1",
          uploadId: offer.uploadId,
        });
        expect(committed).toMatchObject({ _tag: "ok", name: packed.name });
        expect((yield* handle.locate([head])).length).toBe(1);
        expect(drives.bucket.keys()).toContain(drivePackKey(DRIVE, packed.name, "pack"));
        expect(drives.bucket.keys().some((key) => key.includes("incoming/"))).toBe(false);

        // An upload that isn't what its index says is refused, and dropped all the same.
        const second = yield* uploads.offer(DRIVE, {
          packSize: packed.pack.length,
          idxSize: packed.idx.length,
        });
        if (second._tag !== "direct") return expect.unreachable();
        const tampered = packed.pack.slice();
        tampered[tampered.length - 1]! ^= 0xff;
        yield* Effect.promise(() => drives.bucket.put(keyOf(second.pack), tampered));
        yield* Effect.promise(() => drives.bucket.put(keyOf(second.idx), packed.idx));
        expect(
          yield* uploads.commit({ driveId: DRIVE, threadId: "t1", uploadId: second.uploadId }),
        ).toMatchObject({ _tag: "refused" });
        expect(drives.bucket.keys().some((key) => key.includes("incoming/"))).toBe(false);
        // Another drive's upload is not this drive's to commit.
        const theirs = yield* uploads.offer("my/personal/user_2", {
          packSize: packed.pack.length,
          idxSize: packed.idx.length,
        });
        if (theirs._tag !== "direct") return expect.unreachable();
        yield* Effect.promise(() => drives.bucket.put(keyOf(theirs.pack), packed.pack));
        yield* Effect.promise(() => drives.bucket.put(keyOf(theirs.idx), packed.idx));
        expect(
          yield* uploads.commit({ driveId: DRIVE, threadId: "t1", uploadId: theirs.uploadId }),
        ).toEqual({ _tag: "refused", reason: "Nothing was uploaded there." });
        // Nothing uploaded: nothing to commit.
        expect(
          yield* uploads.commit({
            driveId: DRIVE,
            threadId: "t1",
            uploadId: "00000000-0000-4000-8000-000000000000",
          }),
        ).toEqual({ _tag: "refused", reason: "Nothing was uploaded there." });
        expect(yield* uploads.offer(DRIVE, { packSize: 6 * 1024 ** 3, idxSize: 0 })).toEqual({
          _tag: "too_large",
        });
      }).pipe(Effect.provide(Layer.mergeAll(makeMemoryDrives().layer, Platform.layerCrypto))),
  );

  // `SIGNALBOX_BIG_FOLDER_MB=1200 vp test run …`: a folder that size with one file of half of it.
  const bigMb = Number(process.env.SIGNALBOX_BIG_FOLDER_MB ?? 0);
  it.effect.skipIf(bigMb === 0)(
    "takes a native folder's big save in one pack, holding little of it",
    () =>
      Effect.gen(function* () {
        const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "direct-big-"));
        cleanups.push(() => NodeFS.rmSync(root, { recursive: true, force: true }));
        // A bucket on disk, streamed both ways like R2's.
        const fileOf = (key: string) => NodePath.join(root, "bucket", key);
        const bucket: PackBucket = {
          put: async (key, value) => {
            NodeFS.mkdirSync(NodePath.dirname(fileOf(key)), { recursive: true });
            NodeFS.writeFileSync(fileOf(key), value);
          },
          get: async (key) => {
            if (!NodeFS.existsSync(fileOf(key))) return null;
            return {
              size: NodeFS.statSync(fileOf(key)).size,
              body: NodeStream.Readable.toWeb(
                NodeFS.createReadStream(fileOf(key)),
              ) as ReadableStream<Bytes>,
              arrayBuffer: async () => new Uint8Array(NodeFS.readFileSync(fileOf(key))).buffer,
            };
          },
          delete: async (keys) => {
            for (const key of keys) NodeFS.rmSync(fileOf(key), { force: true });
          },
        };
        const storage = storageOver(bucket, async (from, to) => {
          NodeFS.mkdirSync(NodePath.dirname(fileOf(to)), { recursive: true });
          NodeFS.copyFileSync(fileOf(from), fileOf(to));
        });
        const repo = makeRepo();
        cleanups.push(repo.cleanup);
        const write = (name: string, mb: number) => {
          const fd = NodeFS.openSync(NodePath.join(repo.dir, name), "w");
          for (let i = 0; i < mb; i++) NodeFS.writeSync(fd, NodeCrypto.randomBytes(1024 * 1024));
          NodeFS.closeSync(fd);
        };
        write("big.bin", bigMb / 2);
        for (let i = 0; i < 10; i++) write(`part-${i}.bin`, bigMb / 20);
        const head = repo.commit("big");
        const out = NodePath.join(root, "pack");
        NodeFS.mkdirSync(out);
        const name = NodeChildProcess.execFileSync(
          "git",
          ["pack-objects", "--revs", NodePath.join(out, "pack")],
          {
            cwd: repo.dir,
            input: `${head}\n`,
            encoding: "utf8",
            env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
          },
        ).trim();
        const packFile = NodePath.join(out, `pack-${name}.pack`);
        const handle = (yield* DriveDirectory).forDrive(DRIVE);
        yield* handle.setup({ name: "Mine", members: [MANAGER] });
        const uploads = makeDirectUploads({ bucket, storage });
        const packBytes = NodeFS.statSync(packFile).size;
        const offer = yield* uploads.offer(DRIVE, { packSize: packBytes, idxSize: 0 });
        if (offer._tag !== "direct") return expect.unreachable();
        // The machine's PUT: straight from its disk.
        NodeFS.mkdirSync(NodePath.dirname(fileOf(keyOf(offer.pack))), { recursive: true });
        NodeFS.copyFileSync(packFile, fileOf(keyOf(offer.pack)));
        NodeFS.copyFileSync(NodePath.join(out, `pack-${name}.idx`), fileOf(keyOf(offer.idx)));

        const before = process.memoryUsage();
        let peak = 0;
        const sample = setInterval(() => {
          const now = process.memoryUsage();
          peak = Math.max(peak, now.heapUsed + now.arrayBuffers);
        }, 5);
        const started = performance.now();
        const committed = yield* uploads.commit({
          driveId: DRIVE,
          threadId: "t1",
          uploadId: offer.uploadId,
        });
        const seconds = (performance.now() - started) / 1000;
        clearInterval(sample);
        expect(committed).toMatchObject({ _tag: "ok", name });
        // The kept pack is the one git wrote, whole: a machine restores from it.
        const kept = fileOf(drivePackKey(DRIVE, name, "pack"));
        NodeChildProcess.execFileSync(
          "git",
          ["index-pack", "-o", NodePath.join(root, "check.idx"), kept],
          {
            cwd: repo.dir,
          },
        );
        expect(NodeFS.existsSync(fileOf(incomingKey(DRIVE, offer.uploadId, "pack")))).toBe(false);
        const added = peak - (before.heapUsed + before.arrayBuffers);
        NodeFS.writeFileSync(
          "/tmp/signalbox-direct-big.json",
          JSON.stringify({ packBytes, verifySeconds: seconds, addedBytes: added }),
        );
        expect(added).toBeLessThan(96 * 1024 * 1024);
      }).pipe(Effect.provide(Layer.mergeAll(makeMemoryDrives().layer, Platform.layerCrypto))),
    1_800_000,
  );
});
