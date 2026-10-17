import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { PreviewService } from "@signalbox/runner-protocol/PreviewServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as RunnerPreviewServiceCommands from "./RunnerPreviewServiceCommands.ts";
import * as RunnerPreviewServices from "./RunnerPreviewServices.ts";
import { RunnerConnectionError } from "./RunnerSession.ts";

const service = (port: number): PreviewService => ({ port, command: `dev-${port}`, cwd: "." });

const makeServices = Effect.gen(function* () {
  const spawned: Array<string> = [];
  const stopped: Array<string> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand") throw new Error("Expected a process command.");
    spawned.push(command.command);
    let running = true;
    return Effect.acquireRelease(
      Effect.sync(() =>
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(spawned.length),
          exitCode: Effect.never,
          isRunning: Effect.sync(() => running),
          kill: () =>
            Effect.sync(() => {
              running = false;
              stopped.push(command.command);
            }),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
      (handle) => handle.kill().pipe(Effect.ignore),
    );
  });
  const fs = yield* FileSystem.FileSystem;
  const drive = yield* fs.makeTempDirectoryScoped({ prefix: "preview-service-commands-" });
  const services = yield* RunnerPreviewServices.makePreviewServices({ cwd: drive }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
  );
  return { services, spawned, stopped };
});

describe("RunnerPreviewServiceCommands", () => {
  it.effect("retries a stopped service's deletion after persistence fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { services, stopped } = yield* makeServices;
        const saved = service(4173);
        yield* services.restore([saved]);
        let persisted: ReadonlyArray<PreviewService> = [saved];
        let attempts = 0;
        const failure = new RunnerConnectionError({ message: "The connection closed." });
        const commands = yield* RunnerPreviewServiceCommands.RunnerPreviewServiceCommands.pipe(
          Effect.provide(
            RunnerPreviewServiceCommands.layer({
              persist: (next) =>
                Effect.suspend(() => {
                  attempts++;
                  if (attempts === 1) return Effect.fail(failure);
                  persisted = next;
                  return Effect.void;
                }),
            }),
          ),
          Effect.provideService(RunnerPreviewServices.RunnerPreviewServices, services),
        );

        expect(yield* Effect.flip(commands.stop(saved.port))).toBe(failure);
        expect(yield* services.list).toEqual([]);
        expect(stopped).toEqual([saved.command]);
        expect(persisted).toEqual([saved]);

        yield* commands.stop(saved.port);
        expect(persisted).toEqual([]);
        expect(attempts).toBe(2);
        expect(stopped).toEqual([saved.command]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("serializes readiness, mutations, and saves while preserving restored services", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { services, spawned, stopped } = yield* makeServices;
        const saved = service(3000);
        const first = service(4173);
        const second = service(5173);
        const readyEntered = yield* Deferred.make<void>();
        const readyRelease = yield* Deferred.make<void>();
        const persistEntered = yield* Deferred.make<void>();
        const persistRelease = yield* Deferred.make<void>();
        const persisted: Array<ReadonlyArray<PreviewService>> = [];
        let readyCalls = 0;
        const commands = yield* RunnerPreviewServiceCommands.RunnerPreviewServiceCommands.pipe(
          Effect.provide(
            RunnerPreviewServiceCommands.layer({
              ready: Effect.sync(() => readyCalls++).pipe(
                Effect.andThen(Deferred.succeed(readyEntered, undefined)),
                Effect.andThen(Deferred.await(readyRelease)),
                Effect.asVoid,
              ),
              persist: (next) =>
                Effect.gen(function* () {
                  if (persisted.length === 0) {
                    yield* Deferred.succeed(persistEntered, undefined);
                    yield* Deferred.await(persistRelease);
                  }
                  persisted.push(next);
                }),
            }),
          ),
          Effect.provideService(RunnerPreviewServices.RunnerPreviewServices, services),
        );

        const startingFirst = yield* commands.start(first).pipe(Effect.forkChild);
        yield* Deferred.await(readyEntered);
        const stoppingSaved = yield* commands
          .stop(saved.port)
          .pipe(Effect.forkChild({ startImmediately: true }));
        const startingSecond = yield* commands
          .start(second)
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect(readyCalls).toBe(1);
        expect(spawned).toEqual([]);
        expect(persisted).toEqual([]);

        yield* services.restore([saved]);
        yield* Deferred.succeed(readyRelease, undefined);
        yield* Deferred.await(persistEntered);
        expect(yield* services.list).toEqual([saved, first]);
        expect(readyCalls).toBe(1);
        expect(spawned).toEqual([saved.command, first.command]);
        expect(stopped).toEqual([]);
        expect(persisted).toEqual([]);

        yield* Deferred.succeed(persistRelease, undefined);
        yield* Fiber.join(startingFirst);
        yield* Fiber.join(stoppingSaved);
        yield* Fiber.join(startingSecond);
        expect(readyCalls).toBe(3);
        expect(persisted).toEqual([[saved, first], [first], [first, second]]);
        expect(yield* services.list).toEqual([first, second]);
        expect(spawned).toEqual([saved.command, first.command, second.command]);
        expect(stopped).toEqual([saved.command]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
