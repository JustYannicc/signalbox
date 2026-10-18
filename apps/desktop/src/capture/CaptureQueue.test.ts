import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PlatformError from "effect/PlatformError";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as CaptureQueue from "./CaptureQueue.ts";

const queueLayer = (homeDirectory: string, fileSystem?: FileSystem.FileSystem) => {
  const environment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: homeDirectory })),
    ),
  );
  const queue = fileSystem
    ? Layer.effect(
        CaptureQueue.CaptureQueue,
        CaptureQueue.make.pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)),
      )
    : CaptureQueue.layer;
  return queue.pipe(Layer.provideMerge(environment), Layer.provideMerge(NodeServices.layer));
};

const queuedCapture = {
  id: "aaaa",
  text: "Keep this",
  destinationKey: "account:home",
  source: "quick-capture" as const,
  open: false,
  files: [
    {
      id: "bbbb",
      name: "note.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      bytes: Uint8Array.of(97, 98, 99),
    },
  ],
};
const queuedDestination = {
  key: queuedCapture.destinationKey,
  environmentId: EnvironmentId.make("environment"),
  ownerProjectId: ProjectId.make("account"),
  folderId: null,
  label: "Top level",
  detail: null,
  inPlace: "at the top level",
};

describe("CaptureQueue", () => {
  it.effect(
    "persists, retries idempotently, keeps failures, and acknowledges only after handoff",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const homeDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "desktop-capture-queue-",
        });
        const id = "11111111-1111-4111-8111-111111111111";
        const fileId = "22222222-2222-4222-8222-222222222222";
        const capture = {
          id,
          text: "Remember the useful detail",
          files: [
            {
              id: fileId,
              name: "note.txt",
              mimeType: "text/plain",
              sizeBytes: 3,
              bytes: Uint8Array.of(97, 98, 99),
            },
          ],
          destinationKey: "environment-1:folder-1",
          source: "quick-capture" as const,
          open: false,
        };
        const destination = {
          key: capture.destinationKey,
          environmentId: EnvironmentId.make("environment-1"),
          folderId: FolderId.make("folder-1"),
          ownerProjectId: ProjectId.make("project-1"),
          label: "Work / Notes",
          detail: null,
          inPlace: "in Work / Notes",
        };

        const first = yield* Effect.gen(function* () {
          const queue = yield* CaptureQueue.CaptureQueue;
          yield* queue.setDestinations([destination]);
          const submitted = yield* queue.submit(capture);
          assert.deepEqual(submitted.owner, {
            environmentId: destination.environmentId,
            ownerProjectId: destination.ownerProjectId,
          });
          return submitted;
        }).pipe(Effect.provide(queueLayer(homeDirectory)));

        yield* Effect.gen(function* () {
          const queue = yield* CaptureQueue.CaptureQueue;
          assert.deepEqual(yield* queue.destinations, [destination]);
          const retry = yield* queue.submit(capture);
          assert.deepEqual(retry, first);
          const restored = yield* queue.read(id);
          assert.deepEqual(restored.files[0]?.bytes, Uint8Array.of(97, 98, 99));

          yield* queue.reportFailure(id, "The draft store was unavailable.");
          assert.equal(
            (yield* queue.listPending)[0]?.deliveryError,
            "The draft store was unavailable.",
          );
          yield* queue.acknowledge(id);
          assert.deepEqual(yield* queue.listPending, []);
        }).pipe(Effect.provide(queueLayer(homeDirectory)));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect(
    "skips malformed metadata, preserves its files, and rejects unavailable destinations",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "capture-corrupt-" });
        yield* Effect.gen(function* () {
          const queue = yield* CaptureQueue.CaptureQueue;
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const valid = {
            id: "aaaa",
            text: "Still available",
            files: [],
            destinationKey: "account-one:home",
            source: "quick-capture" as const,
            open: false,
          };
          const destination = {
            key: valid.destinationKey,
            environmentId: EnvironmentId.make("environment"),
            ownerProjectId: ProjectId.make("account-one"),
            folderId: null,
            label: "Top level",
            detail: null,
            inPlace: "at the top level",
          };
          yield* queue.setDestinations([destination]);
          yield* queue.submit(valid);
          const corruptDirectory = `${environment.stateDir}/captures/bbbb`;
          yield* fs.makeDirectory(corruptDirectory, { recursive: true });
          yield* fs.writeFileString(`${corruptDirectory}/capture.json`, "{broken");
          yield* fs.writeFileString(`${corruptDirectory}/cccc.bin`, "Keep these bytes");
          assert.deepEqual(
            (yield* queue.listPending).map((capture) => capture.id),
            [valid.id],
          );
          yield* fs.writeFileString(`${corruptDirectory}/capture.json`, "{}");
          assert.deepEqual(
            (yield* queue.listPending).map((capture) => capture.id),
            [valid.id],
          );
          yield* queue.acknowledge(valid.id);
          assert.deepEqual(yield* queue.listPending, []);
          assert.equal(
            yield* fs.readFileString(`${corruptDirectory}/cccc.bin`),
            "Keep these bytes",
          );
          assert.equal(yield* fs.readFileString(`${corruptDirectory}/capture.json`), "{}");

          const unassigned = yield* queue
            .submit({ ...valid, id: "dddd", destinationKey: null })
            .pipe(Effect.flip);
          assert.instanceOf(unassigned, CaptureQueue.CaptureDestinationUnavailableError);
          assert.equal(
            unassigned.message,
            "This capture's folder is unavailable. Reconnect its account or pick a folder to save.",
          );
          yield* queue.setDestinations([]);
          const signedOut = yield* queue.submit({ ...valid, id: "eeee" }).pipe(Effect.flip);
          assert.instanceOf(signedOut, CaptureQueue.CaptureDestinationUnavailableError);
          yield* queue.setDestinations([
            {
              ...destination,
              key: "account-two:home",
              ownerProjectId: ProjectId.make("account-two"),
            },
          ]);
          const changedAccount = yield* queue.submit({ ...valid, id: "ffff" }).pipe(Effect.flip);
          assert.instanceOf(changedAccount, CaptureQueue.CaptureDestinationUnavailableError);
          assert.deepEqual(yield* queue.listPending, []);
        }).pipe(Effect.provide(queueLayer(homeDirectory)));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refiles a deleted folder to the same owner's top only when that owner is available", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "capture-owner-retry-" });
      const folderDestination = {
        ...queuedDestination,
        key: "account:work",
        folderId: FolderId.make("folder-work"),
        label: "Work",
        inPlace: "in Work",
      };
      const destinationB = {
        ...queuedDestination,
        key: "account-b:home",
        environmentId: EnvironmentId.make("environment-b"),
        ownerProjectId: ProjectId.make("account-b"),
      };
      yield* Effect.gen(function* () {
        const queue = yield* CaptureQueue.CaptureQueue;
        yield* queue.setDestinations([queuedDestination, folderDestination]);
        const submitted = yield* queue.submit({
          ...queuedCapture,
          destinationKey: folderDestination.key,
        });
        yield* queue.reportFailure(submitted.id, "The folder was removed.");
        yield* queue.setDestinations([queuedDestination]);

        const retried = yield* queue.retryAtOwnerTop(submitted.id);
        assert.equal(retried.destinationKey, queuedDestination.key);
        assert.deepEqual(retried.owner, submitted.owner);
        assert.equal(retried.deliveryError, null);

        yield* queue.setDestinations([destinationB]);
        const unavailable = yield* queue.retryAtOwnerTop(submitted.id).pipe(Effect.flip);
        assert.instanceOf(unavailable, CaptureQueue.CaptureDestinationUnavailableError);
        const preserved = yield* queue.read(submitted.id);
        assert.equal(preserved.destinationKey, queuedDestination.key);
        assert.deepEqual(preserved.files[0]?.bytes, Uint8Array.of(97, 98, 99));
      }).pipe(Effect.provide(queueLayer(homeDirectory)));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("backfills a legacy queue owner's last validated destination before replacing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "capture-legacy-owner-" });
      yield* Effect.gen(function* () {
        const queue = yield* CaptureQueue.CaptureQueue;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const id = "cccc";
        yield* queue.setDestinations([queuedDestination]);
        const entryDirectory = `${environment.stateDir}/captures/${id}`;
        yield* fs.makeDirectory(entryDirectory, { recursive: true });
        yield* fs.writeFileString(
          `${entryDirectory}/capture.json`,
          `${JSON.stringify({
            id,
            text: "Kept from the previous queue format",
            files: [
              {
                id: "dddd",
                name: "note.txt",
                mimeType: "text/plain",
                sizeBytes: 3,
              },
            ],
            destinationKey: queuedDestination.key,
            source: "quick-capture",
            capturedAt: 123,
            open: false,
            deliveryError: "Still waiting.",
          })}\n`,
        );
        yield* fs.writeFile(`${entryDirectory}/dddd.bin`, Uint8Array.of(97, 98, 99));

        yield* queue.setDestinations([
          {
            ...queuedDestination,
            key: "account-b:home",
            environmentId: EnvironmentId.make("environment-b"),
            ownerProjectId: ProjectId.make("account-b"),
          },
        ]);
        const pending = (yield* queue.listPending).find((capture) => capture.id === id);
        assert.deepEqual(pending?.owner, {
          environmentId: queuedDestination.environmentId,
          ownerProjectId: queuedDestination.ownerProjectId,
        });
        const capture = yield* queue.read(id);
        assert.deepEqual(capture.files[0]?.bytes, Uint8Array.of(97, 98, 99));
      }).pipe(Effect.provide(queueLayer(homeDirectory)));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each(["attachment", "metadata"] as const)(
    "removes staged bytes when the %s write fails and permits retry",
    (failAt) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const homeDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "capture-write-failure-",
        });
        let injectFailure = true;
        const failWrite = Effect.suspend(() =>
          injectFailure
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "writeFile",
                }),
              )
            : Effect.void,
        );
        const fileSystem: FileSystem.FileSystem = {
          ...fs,
          writeFile: (filePath, bytes, options) =>
            fs
              .writeFile(filePath, bytes, options)
              .pipe(
                Effect.andThen(
                  filePath.includes(".tmp-") && failAt === "attachment" ? failWrite : Effect.void,
                ),
              ),
          writeFileString: (filePath, text, options) =>
            fs
              .writeFileString(filePath, text, options)
              .pipe(
                Effect.andThen(
                  filePath.includes(".tmp-") && failAt === "metadata" ? failWrite : Effect.void,
                ),
              ),
        };
        yield* Effect.gen(function* () {
          const queue = yield* CaptureQueue.CaptureQueue;
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          yield* queue.setDestinations([queuedDestination]);
          const failed = yield* Effect.exit(queue.submit(queuedCapture));
          assert.equal(failed._tag, "Failure");
          assert.deepEqual(yield* fs.readDirectory(`${environment.stateDir}/captures`), [
            "destinations.json",
          ]);
          assert.deepEqual(yield* queue.listPending, []);
          injectFailure = false;
          yield* queue.submit(queuedCapture);
          assert.deepEqual(
            (yield* queue.read(queuedCapture.id)).files[0]?.bytes,
            Uint8Array.of(97, 98, 99),
          );
          assert.deepEqual(
            (yield* fs.readDirectory(`${environment.stateDir}/captures`)).toSorted(),
            ["aaaa", "destinations.json"],
          );
        }).pipe(Effect.provide(queueLayer(homeDirectory, fileSystem)));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("finishes a pending-list snapshot before acknowledgement can remove its metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "capture-list-ack-" });
      const listed = yield* Deferred.make<void>();
      const resumeList = yield* Deferred.make<void>();
      let pauseList = false;
      const operations: string[] = [];
      const fileSystem: FileSystem.FileSystem = {
        ...fs,
        readDirectory: (directory) =>
          fs
            .readDirectory(directory)
            .pipe(
              Effect.tap(() =>
                pauseList
                  ? Deferred.succeed(listed, undefined).pipe(
                      Effect.andThen(Deferred.await(resumeList)),
                    )
                  : Effect.void,
              ),
            ),
        remove: (filePath, options) =>
          Effect.sync(() => {
            if (filePath.endsWith("/aaaa")) operations.push("remove");
          }).pipe(Effect.andThen(fs.remove(filePath, options))),
      };
      yield* Effect.gen(function* () {
        const queue = yield* CaptureQueue.CaptureQueue;
        yield* queue.setDestinations([queuedDestination]);
        yield* queue.submit(queuedCapture);
        pauseList = true;
        const listing = yield* queue.listPending.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(listed);
        const acknowledging = yield* queue
          .acknowledge(queuedCapture.id)
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.deepEqual(operations, []);
        pauseList = false;
        yield* Deferred.succeed(resumeList, undefined);
        assert.deepEqual(
          (yield* Fiber.join(listing)).map((capture) => capture.id),
          [queuedCapture.id],
        );
        yield* Fiber.join(acknowledging);
        assert.deepEqual(operations, ["remove"]);
        assert.deepEqual(yield* queue.listPending, []);
      }).pipe(Effect.provide(queueLayer(homeDirectory, fileSystem)));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
