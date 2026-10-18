// @effect-diagnostics nodeBuiltinImport:off - runs a real shell against a temporary project-local command.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { PreviewService } from "@signalbox/runner-protocol/PreviewServices";
import { machineLayout, runnerEnvironments } from "./RunnerModelAccess.ts";
import { makePreviewServices } from "./RunnerPreviewServices.ts";

const service = (command: string, cwd = "."): PreviewService => ({ port: 4173, command, cwd });

describe("RunnerPreviewServices", () => {
  it.effect("runs project-local tools in preview commands with the filtered tool environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "preview-local-tool-"));
        try {
          const drive = NodePath.join(root, "drive");
          const cwd = NodePath.join(drive, "apps", "web");
          const bin = NodePath.join(drive, "node_modules", ".bin");
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const layout = machineLayout(path, NodePath.join(root, "machine"));
          const home = layout.home;
          const marker = NodePath.join(home, "preview-vp-ran");
          NodeFS.mkdirSync(cwd, { recursive: true });
          NodeFS.mkdirSync(bin, { recursive: true });
          NodeFS.mkdirSync(home, { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(bin, "vp"),
            `#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(process.env.PREVIEW_MARKER, JSON.stringify({cwd: process.cwd(), pwd: process.env.PWD, home: process.env.HOME, path: process.env.PATH, secret: process.env.PREVIEW_SECRET}));\nconsole.log("vp preview ok");\n`,
            { mode: 0o755 },
          );
          const environment = runnerEnvironments(
            {
              PATH: process.env.PATH,
              HOME: "/host/home",
              HOST_ONLY_SECRET: "must-not-pass",
            },
            layout,
            "http://127.0.0.1:8788",
            {},
            drive,
            { PREVIEW_MARKER: marker, PREVIEW_SECRET: "folder-secret" },
          ).toolEnvironment;
          const results: Array<{ status: number | null; stdout: string }> = [];
          const spawner = ChildProcessSpawner.make((command) => {
            if (command._tag !== "StandardCommand") throw new Error("Expected a process command.");
            const result = NodeChildProcess.spawnSync(command.command, command.args, {
              cwd: command.options.cwd,
              env: command.options.env,
              shell: command.options.shell,
              encoding: "utf8",
            });
            if (result.error !== undefined) throw result.error;
            results.push({ status: result.status, stdout: result.stdout });
            let running = true;
            return Effect.acquireRelease(
              Effect.sync(() =>
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(results.length),
                  exitCode: Effect.never,
                  isRunning: Effect.sync(() => running),
                  kill: () =>
                    Effect.sync(() => {
                      running = false;
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
          const checkedDrive = yield* fs.realPath(drive);
          const services = yield* makePreviewServices({
            cwd: checkedDrive,
            environment: () => environment,
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

          yield* services.start(service("vp --version", "apps/web"));

          expect(results).toEqual([{ status: 0, stdout: "vp preview ok\n" }]);
          const ran = JSON.parse(NodeFS.readFileSync(marker, "utf8")) as {
            cwd: string;
            pwd: string;
            home: string;
            path: string;
            secret: string | undefined;
          };
          expect(NodeFS.realpathSync(ran.cwd)).toBe(NodeFS.realpathSync(cwd));
          expect(NodeFS.realpathSync(ran.pwd)).toBe(NodeFS.realpathSync(cwd));
          expect(ran.home).toBe(home);
          expect(ran.secret).toBe("folder-secret");
          expect(ran.path.split(NodePath.delimiter)[0]).toBe(
            NodePath.join(drive, "node_modules", ".bin"),
          );
          expect(environment.HOST_ONLY_SECRET).toBeUndefined();
        } finally {
          NodeFS.rmSync(root, { recursive: true, force: true });
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

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
          const services = yield* makePreviewServices({
            cwd: drive,
            environment: () => ({ PATH: process.env.PATH }),
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

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
          makePreviewServices({ cwd: drive, environment: () => ({ PATH: process.env.PATH }) }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        );
        yield* previous.restore([service("pnpm dev")]);
        yield* Scope.close(previousScope, Exit.void);

        const nextScope = yield* Scope.make();
        const next = yield* Scope.provide(nextScope)(
          makePreviewServices({ cwd: drive, environment: () => ({ PATH: process.env.PATH }) }).pipe(
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
