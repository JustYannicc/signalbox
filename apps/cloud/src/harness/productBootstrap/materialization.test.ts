import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { createMemoryFilePersistencePorts } from "../../kernel/MemoryFilePersistencePorts.ts";
import { hostSqlite } from "../tests/hostSqlite.ts";
import type { HarnessThreadSupervisorPublisher } from "../HarnessThreadSupervisor.ts";
import type { HarnessFilesStoreObject } from "../HarnessFilesStoreObject.ts";
import type { HarnessFilesStoreResult } from "../HarnessFilesStore.ts";
import {
  readHarnessCProductFilesCheckpoint,
  validateHarnessCProductFiles,
} from "../HarnessCProductCheckpoint.ts";
import { materializeHarnessCProductFiles } from "../HarnessCProductCheckpoint.ts";
import { prepareFilesCheckpoint } from "./tests/artifacts.fixture.ts";
import { captureHarnessCProductFiles } from "../HarnessCProductCheckpoint.ts";

const publisher: HarnessThreadSupervisorPublisher = {
  generation: 1,
  facetNonce: "facet-a",
  publisherKey: "publisher-a-".repeat(4),
};

const checkpointResult = (files: HarnessFilesStoreResult["files"]): HarnessFilesStoreResult => ({
  action: "read",
  checkpoint: { checkpointId: "checkpoint-a", manifestSha256: "manifest-a" },
  parentCheckpointId: null,
  activeStepId: null,
  admissionResolution: null,
  publication: null,
  files,
});

describe("facet-local product checkpoint materialization", () => {
  it("reads A's file checkpoint with A's publisher and returns detached file bytes", async () => {
    const bytes = new Uint8Array([0, 255, 20, 10]);
    const files = [{ path: ".claude/index", mode: 0o600, bytes }];
    const manifest = await prepareFilesCheckpoint({
      checkpointId: "checkpoint-a",
      parentCheckpointId: null,
      files,
    });
    let command: unknown;
    const store = {
      execute: async (input: unknown) => {
        command = input;
        return {
          ...checkpointResult(files),
          checkpoint: { checkpointId: "checkpoint-a", manifestSha256: manifest.manifestSha256 },
        };
      },
    } as Pick<HarnessFilesStoreObject, "execute">;

    const restored = await readHarnessCProductFilesCheckpoint({
      store,
      runId: "run-a",
      publisher,
      checkpointId: "checkpoint-a",
      manifestRevision: manifest.manifestSha256,
    });

    expect(command).toEqual({
      type: "readCheckpoint",
      runId: "run-a",
      publisher,
      checkpointId: "checkpoint-a",
    });
    expect(restored.files[0]?.bytes).not.toBe(bytes);
    bytes[0] = 90;
    expect([...restored.files[0]!.bytes]).toEqual([0, 255, 20, 10]);
  });

  it("rejects a changed checkpoint identity and unsafe file entries", async () => {
    const store = {
      execute: async () => ({
        ...checkpointResult([]),
        checkpoint: { checkpointId: "another", manifestSha256: "manifest-a" },
      }),
    } as unknown as Pick<HarnessFilesStoreObject, "execute">;

    await expect(
      readHarnessCProductFilesCheckpoint({
        store,
        runId: "run-a",
        publisher,
        checkpointId: "checkpoint-a",
        manifestRevision: "manifest-a",
      }),
    ).rejects.toThrow("does not match");
    expect(() =>
      validateHarnessCProductFiles([
        { path: "/workspace/../secret", mode: 0o600, bytes: new Uint8Array([1]) },
      ]),
    ).toThrow("invalid or duplicate");
  });

  it("rejects changed file bytes, kinds and modes under an unchanged manifest", async () => {
    const files = [{ path: "workspace.txt", mode: 0o600, bytes: new Uint8Array([1, 2, 3]) }];
    const manifest = await prepareFilesCheckpoint({
      checkpointId: "checkpoint-a",
      parentCheckpointId: null,
      files,
    });
    for (const changed of [
      [{ ...files[0]!, bytes: new Uint8Array([1, 2, 4]) }],
      [{ ...files[0]!, mode: 0o644 }],
      [{ ...files[0]!, kind: "symlink" }] satisfies HarnessFilesStoreResult["files"],
    ]) {
      const store = {
        execute: async () => ({
          ...checkpointResult(changed),
          checkpoint: { checkpointId: "checkpoint-a", manifestSha256: manifest.manifestSha256 },
        }),
      } as Pick<HarnessFilesStoreObject, "execute">;
      await expect(
        readHarnessCProductFilesCheckpoint({
          store,
          runId: "run-a",
          publisher,
          checkpointId: "checkpoint-a",
          manifestRevision: manifest.manifestSha256,
        }),
      ).rejects.toThrow("bytes, kinds or modes changed");
    }
    expect(() =>
      validateHarnessCProductFiles([
        { path: "parent", mode: 0o600, bytes: new Uint8Array() },
        { path: "parent/child", mode: 0o600, bytes: new Uint8Array() },
      ]),
    ).toThrow("needs a directory");
  });

  it.effect("writes A's exact bytes and mode before host seeding", () =>
    Effect.gen(function* () {
      const database = yield* Effect.acquireRelease(Effect.sync(hostSqlite), (value) =>
        Effect.sync(() => value.dispose()),
      );
      const connection = database.open();
      yield* Effect.addFinalizer(() => Effect.sync(() => connection.close()));
      const files = {
        identity: "product-bootstrap-files",
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
      const path = ".claude/projects/thread/transcript.jsonl";
      const bytes = new Uint8Array([123, 0, 255, 10]);
      materializeHarnessCProductFiles({
        files,
        threadId: "thread-a",
        checkpoint: checkpointResult([{ path, mode: 0o600, bytes }]),
      });

      const restored = captureHarnessCProductFiles({ files, threadId: "thread-a", paths: [path] });
      expect(restored).toEqual([{ path, mode: 0o600, bytes }]);
    }).pipe(Effect.scoped),
  );
});
