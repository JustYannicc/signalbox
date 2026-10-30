import { assert, describe, it } from "@effect/vitest";
import {
  DesktopCaptureDestination,
  DesktopCaptureId,
  DesktopPendingCapture,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({
  app: { on: () => undefined, removeListener: () => undefined },
  globalShortcut: { register: () => true, unregister: () => undefined },
}));

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as CaptureQueue from "./CaptureQueue.ts";
import * as DesktopCaptureShutdown from "./DesktopCaptureShutdown.ts";
import * as DesktopQuickCapture from "./DesktopQuickCapture.ts";

const makeLayer = (queue: CaptureQueue.CaptureQueue["Service"]) =>
  DesktopQuickCapture.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: "darwin",
          isDevelopment: false,
          preloadPath: "/repo/preload.js",
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        Layer.succeed(CaptureQueue.CaptureQueue, queue),
        DesktopCaptureShutdown.layer,
        Layer.succeed(DesktopClientSettings.DesktopClientSettings, {
          get: Effect.succeed(Option.none()),
          set: () => Effect.void,
        }),
        Layer.succeed(DesktopWindow.DesktopWindow, {
          activate: Effect.void,
          dispatchCaptureEvent: () => Effect.void,
        } as unknown as DesktopWindow.DesktopWindow["Service"]),
        Layer.succeed(
          ElectronWindow.ElectronWindow,
          {} as unknown as ElectronWindow.ElectronWindow["Service"],
        ),
        Layer.succeed(
          DesktopSnapShot.DesktopSnapShot,
          {} as unknown as DesktopSnapShot.DesktopSnapShot["Service"],
        ),
      ),
    ),
  );

describe("DesktopQuickCapture", () => {
  it.effect(
    "keeps invalidated destination owners cleared and returns only bounded owner previews",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ownerA = {
            environmentId: EnvironmentId.make("environment-a"),
            ownerProjectId: ProjectId.make("owner-a"),
          };
          const ownerB = {
            environmentId: EnvironmentId.make("environment-b"),
            ownerProjectId: ProjectId.make("owner-b"),
          };
          const destinationA = {
            key: "environment-a:home",
            ...ownerA,
            folderId: null,
            label: "A top level",
            detail: null,
            inPlace: "at the top level",
          } satisfies typeof DesktopCaptureDestination.Type;
          const captureA = {
            id: DesktopCaptureId.make("aaaa"),
            owner: ownerA,
            text: "a".repeat(160),
            files: [],
            destinationKey: destinationA.key,
            source: "quick-capture" as const,
            capturedAt: 1,
            open: false,
            deliveryError: null,
          } satisfies typeof DesktopPendingCapture.Type;
          const captureB = {
            ...captureA,
            id: DesktopCaptureId.make("bbbb"),
            owner: ownerB,
            text: "private to account B",
            destinationKey: "environment-b:home",
          } satisfies typeof DesktopPendingCapture.Type;
          const destinationsRef = yield* Ref.make<
            ReadonlyArray<typeof DesktopCaptureDestination.Type>
          >([]);
          const pendingRef = yield* Ref.make<ReadonlyArray<typeof DesktopPendingCapture.Type>>([
            captureA,
            captureB,
          ]);
          const writeStarted = yield* Deferred.make<void>();
          const allowWrite = yield* Deferred.make<void>();
          const queue = CaptureQueue.CaptureQueue.of({
            destinations: Ref.get(destinationsRef),
            setDestinations: (destinations) =>
              Deferred.succeed(writeStarted, undefined).pipe(
                Effect.andThen(Deferred.await(allowWrite)),
                Effect.andThen(Ref.set(destinationsRef, destinations)),
              ),
            listPending: Ref.get(pendingRef),
            submit: () => Effect.die("unused in this test"),
            retryAtOwnerTop: () => Effect.die("unused in this test"),
            read: () => Effect.die("unused in this test"),
            acknowledge: () => Effect.void,
            reportFailure: () => Effect.void,
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const capture = yield* DesktopQuickCapture.DesktopQuickCapture;
              const staleSync = yield* capture
                .setDestinations([destinationA])
                .pipe(Effect.forkChild);
              yield* Deferred.await(writeStarted);
              assert.isFalse(yield* Deferred.isDone(allowWrite));

              yield* capture.beginDestinationSync;
              const duringWrite = yield* capture.getState;
              assert.deepEqual(duringWrite.destinations, []);
              assert.deepEqual(duringWrite.pending, []);

              yield* Deferred.succeed(allowWrite, undefined);
              yield* Fiber.join(staleSync);
              const afterStaleSync = yield* capture.getState;
              assert.deepEqual(afterStaleSync.destinations, []);
              assert.deepEqual(afterStaleSync.pending, []);

              yield* capture.setDestinations([destinationA]);
              const currentState = yield* capture.getState;
              assert.deepEqual(
                currentState.pending.map(({ id }) => id),
                [captureA.id],
              );
              assert.equal(currentState.pending[0]?.text, "a".repeat(120));
              assert.equal(currentState.pending[0]?.text?.length, 120);
            }).pipe(Effect.provide(makeLayer(queue))),
          );
        }),
      ),
  );
});
