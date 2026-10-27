import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { createNodeFs } from "../../isolate/NodeFs.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { createMemoryFilePersistencePorts } from "../../kernel/MemoryFilePersistencePorts.ts";
import { createFacetFilePersistence } from "../../kernel/FacetFilePersistence.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { createHarnessFilesStore } from "../HarnessFilesStore.ts";
import type { HarnessFilesStoreFile } from "../HarnessFilesStore.ts";
import {
  captureHarnessCProductFiles,
  materializeHarnessCProductFiles,
} from "../HarnessCProductCheckpoint.ts";
import { hostSqlite } from "../tests/hostSqlite.ts";

const threadId = "file-kind-roundtrip";
const control = {
  ownerId: "owner",
  incarnationId: "owner-one",
  epoch: 1,
  controlKey: "control-key-".repeat(4),
};
const publisher = {
  generation: 1,
  facetNonce: "facet-one",
  publisherKey: "publisher-key-".repeat(4),
};

const database = () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(Effect.sync(hostSqlite), (value) =>
      Effect.sync(() => value.dispose()),
    );
    return yield* Effect.acquireRelease(
      Effect.sync(() => db.open()),
      (value) => Effect.sync(() => value.close()),
    );
  });

const filesystem = () =>
  Effect.gen(function* () {
    const connection = yield* database();
    const files = {
      identity: "checkpoint-file-kinds",
      database: connection.storage,
      nowNs: () => 0n,
      persistencePorts: createMemoryFilePersistencePorts(),
      rootMetadata: { mode: 0o755, uid: 1000, gid: 1000 },
      posix: {
        credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
        umask: 0o022,
      },
      assetMode: 0o644,
      cwd: "/workspace",
    };
    captureHarnessCProductFiles({ files, threadId, paths: [] });
    const wakes = yield* Effect.acquireRelease(
      Effect.sync(() => new KernelWakeRegistry()),
      (value) => Effect.sync(() => value.dispose()),
    );
    const persistence = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createFacetFilePersistence(connection.storage, files.nowNs, {
          wakes,
          ports: files.persistencePorts,
        }),
      ),
      (value) => Effect.sync(() => value.dispose()),
    );
    const kernelFiles = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new KernelFileSystem({
            mounts: [{ path: "/", storage: persistence.storage }],
            posix: files.posix,
          }),
      ),
      (value) => Effect.sync(() => value.dispose()),
    );
    const fs = createNodeFs(kernelFiles).fs;
    fs.mkdirSync(files.cwd, { recursive: true });
    kernelFiles.chdir(files.cwd);
    return { files, kernelFiles, fs };
  });

const persist = (files: readonly HarnessFilesStoreFile[]) =>
  Effect.gen(function* () {
    const durable = yield* database();
    yield* createHarnessFilesStore(durable.storage, threadId).execute({
      type: "initialize",
      runId: threadId,
      control,
      publisher,
      checkpoint: { checkpointId: "checkpoint", parentCheckpointId: null, files },
    });
    return yield* createHarnessFilesStore(durable.storage, threadId).execute({
      type: "readCheckpoint",
      runId: threadId,
      publisher,
      checkpointId: "checkpoint",
    });
  });

describe("public checkpoint file kinds", () => {
  it.effect("roundtrips a product filesystem symlink through the durable files store", () =>
    Effect.gen(function* () {
      const source = yield* filesystem();
      const destination = yield* filesystem();
      source.fs.writeFileSync("target.txt", "checkpoint payload\n", { mode: 0o640 });
      source.fs.symlinkSync("target.txt", "link");
      source.kernelFiles.chmod("link", 0o750, false);
      expect(source.fs.lstatSync("link").isSymbolicLink()).toBe(true);
      const files = captureHarnessCProductFiles({
        files: source.files,
        threadId,
        paths: ["target.txt", "link"],
      });
      const checkpoint = yield* persist(files);
      materializeHarnessCProductFiles({ files: destination.files, threadId, checkpoint });
      expect(destination.fs.lstatSync("link").isSymbolicLink()).toBe(true);
      expect(destination.fs.readlinkSync("link")).toBe("target.txt");
      expect(destination.fs.lstatSync("link").mode & 0o7777).toBe(0o750);
      expect(destination.fs.statSync("target.txt").mode & 0o7777).toBe(0o640);
      expect(destination.fs.readFileSync("link", "utf8")).toBe("checkpoint payload\n");
      expect(checkpoint.files.find((file) => file.path === "link")).toMatchObject({
        kind: "symlink",
        mode: 0o750,
        bytes: new TextEncoder().encode("target.txt"),
      });
    }),
  );

  it.effect("keeps dangling, chained and unresolved link targets without reading them", () =>
    Effect.gen(function* () {
      const source = yield* filesystem();
      const destination = yield* filesystem();
      source.fs.mkdirSync("nested");
      const targets = [
        { path: "dangling", target: "missing" },
        { path: "chain", target: "dangling" },
        { path: "nested/relative", target: "../absent/../missing" },
        { path: "absolute", target: "/outside/missing" },
        { path: "unicode", target: "\uFEFFcafé/文件" },
      ];
      for (const { path, target } of targets) source.fs.symlinkSync(target, path);
      const files = captureHarnessCProductFiles({
        files: source.files,
        threadId,
        paths: targets.map(({ path }) => path),
      });
      const checkpoint = yield* persist(files);
      materializeHarnessCProductFiles({ files: destination.files, threadId, checkpoint });
      for (const { path, target } of targets) {
        expect(destination.fs.lstatSync(path).isSymbolicLink()).toBe(true);
        expect(destination.fs.readlinkSync(path)).toBe(target);
      }
    }),
  );

  it.effect("replaces conflicting entry kinds without writing through old links", () =>
    Effect.gen(function* () {
      const source = yield* filesystem();
      const destination = yield* filesystem();
      source.fs.writeFileSync("regular", "restored", { mode: 0o700 });
      source.fs.symlinkSync("missing", "link");
      destination.fs.writeFileSync("untouched", "keep me", { mode: 0o600 });
      destination.fs.symlinkSync("untouched", "regular");
      destination.fs.writeFileSync("link", "old regular");
      const checkpoint = yield* persist(
        captureHarnessCProductFiles({
          files: source.files,
          threadId,
          paths: ["regular", "link"],
        }),
      );
      materializeHarnessCProductFiles({ files: destination.files, threadId, checkpoint });
      materializeHarnessCProductFiles({ files: destination.files, threadId, checkpoint });
      expect(destination.fs.lstatSync("regular").isFile()).toBe(true);
      expect(destination.fs.readFileSync("regular", "utf8")).toBe("restored");
      expect(destination.fs.statSync("regular").mode & 0o7777).toBe(0o700);
      expect(destination.fs.readlinkSync("link")).toBe("missing");
      expect(destination.fs.readFileSync("untouched", "utf8")).toBe("keep me");
      expect(destination.fs.statSync("untouched").mode & 0o7777).toBe(0o600);
    }),
  );

  it.effect("rejects unrepresentable symlink targets before replacing an existing entry", () =>
    Effect.gen(function* () {
      const destination = yield* filesystem();
      destination.fs.writeFileSync("entry", "keep me");
      for (const bytes of [new Uint8Array(), new Uint8Array([0]), new Uint8Array([255])]) {
        const checkpoint = yield* persist([{ path: "entry", kind: "symlink", mode: 0o777, bytes }]);
        expect(() =>
          materializeHarnessCProductFiles({
            files: destination.files,
            threadId,
            checkpoint,
          }),
        ).toThrow("could not be materialized");
        expect(destination.fs.readFileSync("entry", "utf8")).toBe("keep me");
      }
    }),
  );

  it.effect("rejects a directory selected for file checkpoint capture", () =>
    Effect.gen(function* () {
      const source = yield* filesystem();
      source.fs.mkdirSync("directory");
      expect(() =>
        captureHarnessCProductFiles({
          files: source.files,
          threadId,
          paths: ["directory"],
        }),
      ).toThrow("regular file or symlink");
    }),
  );
});
