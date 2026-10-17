import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { PreviewService } from "@signalbox/runner-protocol/PreviewServices";
import { makePreviewServices } from "./RunnerPreviewServices.ts";

const service = (command: string, cwd = "."): PreviewService => ({ port: 4173, command, cwd });

describe("RunnerPreviewServices", () => {
  it.effect(
    "starts one service per port, replaces it explicitly, and stops it with its declaration",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const spawned: Array<{ command: string; cwd: string }> = [];
          const stopped: Array<string> = [];
          const spawner = ChildProcessSpawner.make((command) => {
            if (command._tag !== "StandardCommand") throw new Error("Expected a process command.");
            const input = { command: command.command, cwd: command.options.cwd ?? "" };
            spawned.push(input);
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
                      stopped.push(input.command);
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
          const root = yield* FileSystem.FileSystem;
          const drive = yield* root.makeTempDirectoryScoped({ prefix: "preview-services-drive-" });
          yield* root.makeDirectory(`${drive}/apps/web`, { recursive: true });
          const services = yield* makePreviewServices({ cwd: drive }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );

          yield* services.start(service("pnpm dev", "apps/web"));
          yield* services.start(service("pnpm dev", "apps/web"));
          expect(spawned).toHaveLength(1);
          expect(spawned[0]!.command).toBe("pnpm dev");
          expect(spawned[0]!.cwd.endsWith("/apps/web")).toBe(true);

          yield* services.start(service("npm run dev", "apps/web"));
          expect(spawned).toHaveLength(2);
          expect(stopped).toEqual(["pnpm dev"]);

          yield* services.stop(4173);
          expect(stopped).toEqual(["pnpm dev", "npm run dev"]);
          expect(yield* services.list).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "restores declared services on a new Runner scope and stops them when that Runner ends",
    () =>
      Effect.gen(function* () {
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
        const drive = yield* fs.makeTempDirectoryScoped({ prefix: "preview-services-restore-" });
        const previousScope = yield* Scope.make();
        const previous = yield* Scope.provide(previousScope)(
          makePreviewServices({ cwd: drive }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        );
        yield* previous.restore([service("pnpm dev")]);
        yield* Scope.close(previousScope, Exit.void);

        const nextScope = yield* Scope.make();
        const next = yield* Scope.provide(nextScope)(
          makePreviewServices({ cwd: drive }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        );
        yield* next.restore([service("pnpm dev")]);
        expect(spawned).toEqual(["pnpm dev", "pnpm dev"]);
        expect(stopped).toEqual(["pnpm dev"]);
        yield* Scope.close(nextScope, Exit.void);
        expect(stopped).toEqual(["pnpm dev", "pnpm dev"]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
