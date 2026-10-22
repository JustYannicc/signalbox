// @effect-diagnostics nodeBuiltinImport:off - Controlled native modules run in an isolated test realm.
import * as NodeAssert from "node:assert/strict";
import * as NodeBuffer from "node:buffer";
import * as NodeConstants from "node:constants";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as Yaml from "yaml";
import { ProviderDriverKind, ProviderInstanceId, ProviderSessionId } from "@t3tools/contracts";
import type { RunnerItem } from "@signalbox/runner-protocol/RunnerProtocol";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import { machineFixture, type Scenario } from "./machine.ts";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import { HarnessError } from "../../Harness.ts";
import { createProductClaudeHarnessSessionHost } from "../../ProductClaudeHarnessSessionHost.ts";
import type { HarnessOwnedProcess } from "../../HarnessProcessLifetime.ts";
import { ChildWorkerCapacity } from "../../../computer/ChildWorkerCapacity.ts";
import { CHILD_PROGRAM_PATHS } from "../../../computer/ChildProgramSet.ts";
import { createMemoryFilePersistencePorts } from "../../../kernel/MemoryFilePersistencePorts.ts";
import { createNodeFs } from "../../../isolate/NodeFs.ts";
import { hostSqlite } from "../hostSqlite.ts";
import { claudeFixture } from "../../releaseLoader/tests/artifactFixtures.ts";
import { data } from "../../adapter/tests/data.ts";
import { commandLoader, programFixture } from "./commands.ts";
import { nativeFixture } from "./native.ts";
import { adapter, services } from "./adapter.ts";

export function run(scenario: Scenario | "hydrate" | "start-failure" = "turn") {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const database = yield* Effect.acquireRelease(Effect.sync(hostSqlite), (db) =>
          Effect.sync(() => db.dispose()),
        );
        const nativeId = "12345678-1234-4234-8234-123456789abc";
        const deps = yield* services;
        const d = yield* data;
        const instanceId = ProviderInstanceId.make("recorded-claude");
        const driver = ProviderDriverKind.make("claudeAgent");
        const providerSessionId = ProviderSessionId.make("original-recorded-session");
        const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
        const turn = {
          ...d.turn,
          modelSelection,
          providerThread: {
            ...d.turn.providerThread,
            driver,
            providerInstanceId: instanceId,
            providerSessionId,
            nativeThreadRef: { driver, nativeId, strength: "strong" as const },
          },
          appThread: { ...d.turn.appThread, modelSelection, providerInstanceId: instanceId },
        };
        const sessionInput = {
          threadId: d.threadId,
          providerSessionId,
          modelSelection,
          initialNativeThreadId: nativeId,
          runtimePolicy: {
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            cwd: "/workspace",
          },
        };
        const native = nativeFixture(nativeId);
        const commands = commandLoader();
        const capacity = new ChildWorkerCapacity(2);
        const persistencePorts = createMemoryFilePersistencePorts();
        const at = { repository: "product-test", fork: "thread", commit: "base" };
        persistencePorts.seedFile(at, "/workspace/file.txt", new TextEncoder().encode("before\n"));
        const modelRequests: string[] = [];
        let files: KernelFileSystem | undefined;
        let retainedFd: number | undefined;
        let nativeBindingClosed = false;
        const hydrateEntered = Promise.withResolvers<void>();
        const hydrateCancelled = Promise.withResolvers<void>();
        const hydrateReleased = Promise.withResolvers<void>();
        const machine = machineFixture(
          scenario === "hydrate" || scenario === "start-failure" ? "turn" : scenario,
          () => {
            NodeAssert.ok(files !== undefined);
            if (retainedFd !== undefined) files.fstat(retainedFd);
            else files.stat("/workspace/file.txt");
          },
        );
        yield* Effect.addFinalizer(() => Effect.sync(machine.release));
        const observed: Uint8Array[] = [];
        let nativeProcess: HarnessOwnedProcess | undefined;
        let hydrated = false;
        let saveCalls = 0;
        const release = yield* Effect.promise(() => claudeFixture());
        const programs = yield* Effect.promise(programFixture);
        const host = yield* createProductClaudeHarnessSessionHost({
          threadId: d.threadId,
          release: release.options,
          programs,
          files: {
            identity: "recorded-files",
            database: database.open().storage,
            nowNs: () => 0n,
            persistencePorts,
            rootMetadata: { mode: 0o755, uid: 1000, gid: 1000 },
            posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
            cwd: "/workspace",
            assetMode: 0o644,
          },
          commands: {
            loader: commands.loader,
            capacity,
            hostname: "recorded-host",
            machine: machine.port,
          },
          hydrate: async ({ files: canonical, signal }) => {
            files = canonical;
            if (scenario === "hydrate") {
              retainedFd = canonical.open("/bin/bash", 0);
              signal.addEventListener("abort", () => hydrateCancelled.resolve(), { once: true });
              hydrateEntered.resolve();
              await hydrateReleased.promise;
              canonical.fstat(retainedFd);
              signal.throwIfAborted();
            }
            NodeAssert.equal(native.launched, false);
            const fs = createNodeFs(canonical).fs;
            fs.mkdirSync("/home/recorded", { recursive: true });
            fs.mkdirSync("/recorded/git", { recursive: true });
            fs.writeFileSync("/workspace/.git", "gitdir: /recorded/git\n");
            fs.writeFileSync("/workspace/file.txt", "before\n");
            fs.writeFileSync("/home/recorded/session", nativeId);
            fs.symlinkSync("/workspace", "/source-alias");
            hydrated = true;
          },
          save: async ({ files, persistence, signal }) => {
            saveCalls++;
            const result = await persistence.commitTurn({
              at,
              turnId: turn.runId,
              signal,
              changedInodes: [
                {
                  inode: files.resolve("/workspace/file.txt").inode,
                  paths: ["/workspace/file.txt"],
                  removedPaths: [],
                },
              ],
            });
            if (result.status !== "ok") throw new Error(result.error.message);
            return result.value;
          },
          port: async () => ({ fetch: async () => new Response("machine service") }),
          modelTransport: async (request) => {
            modelRequests.push(request.url);
            NodeAssert.ok(request.url.startsWith("https://recorded.invalid/"));
            return new Response(request.url.endsWith("/root") ? "root response" : "child response");
          },
          executor: { forward: async () => new Response("executor") },
          observeOutput: (fd, bytes) => {
            if (fd === 1) observed.push(bytes);
          },
          native: {
            adapter: ({ harness }) =>
              Effect.gen(function* () {
                NodeAssert.equal(hydrated, true);
                if (scenario === "start-failure") {
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      nativeBindingClosed = true;
                    }),
                  );
                  return yield* new HarnessError({
                    operation: "open",
                    message: "Controlled native acquisition failure",
                  });
                }
                return adapter(harness.computer.files, deps, instanceId);
              }),
            mcpSessions: deps.mcpSessions,
            loadSdk: native.loadSdk,
            processObserver: {
              started(process) {
                nativeProcess = process;
              },
              abandoned(cause) {
                throw new Error("Native acquisition abandoned", { cause });
              },
            },
            process: {
              identity: {
                version: "v24.21.0",
                versions: { node: "24.21.0", bun: "1.3.11" },
                platform: "linux",
                arch: "x64",
                type: "Linux",
                endianness: "LE",
                availableParallelism: 1,
                user: { username: "recorded", uid: 1000, gid: 1000, shell: "/bin/bash" },
                homedir: "/home/recorded",
                tmpdir: "/tmp",
                pid: 1,
                ppid: 0,
                execPath: "/runtime/claude",
                argv0: "claude",
                argv: ["claude"],
              },
              env: { HOME: "/home/recorded", PATH: "/bin:/usr/bin" },
              nativeModules: {
                buffer: NodeBuffer,
                constants: NodeConstants,
                fs: NodeFS,
                child_process: NodeChildProcess,
              },
              loadPackages: async () => ({ yaml: Yaml }),
              loadRelease: native.loadRelease,
              bun: { main: "/release/cli", version: "1.3.11", revision: "controlled" },
            },
          },
        });
        yield* host.seed("assets");
        yield* host.seed("programs");
        if (scenario === "hydrate") {
          let closed = false;
          const opening = yield* host
            .open({ session: sessionInput, bootAttemptId: "recorded-boot" })
            .pipe(
              Effect.onExit(() =>
                Effect.sync(() => {
                  closed = true;
                }),
              ),
              Effect.forkScoped,
            );
          yield* Effect.promise(() => hydrateEntered.promise);
          const interrupted = yield* Fiber.interrupt(opening).pipe(Effect.forkScoped);
          yield* Effect.promise(() => hydrateCancelled.promise);
          NodeAssert.equal(closed, false);
          NodeAssert.equal(native.launched, false);
          NodeAssert.ok(files !== undefined && retainedFd !== undefined);
          files.fstat(retainedFd);
          hydrateReleased.resolve();
          yield* Fiber.join(interrupted);
          NodeAssert.equal(Exit.isFailure(yield* Fiber.await(opening)), true);
          yield* host.dispose;
          NodeAssert.equal(files.descriptors.has(retainedFd), false);
          NodeAssert.equal(capacity.active, 0);
          return;
        }
        if (scenario === "start-failure") {
          const outcome = yield* host
            .open({ session: sessionInput, bootAttemptId: "failed-boot" })
            .pipe(Effect.exit);
          NodeAssert.equal(Exit.isFailure(outcome), true);
          NodeAssert.equal(nativeBindingClosed, true);
          NodeAssert.equal(native.launched, false);
          NodeAssert.equal(capacity.active, 0);
          NodeAssert.throws(() => host.computer.files.stat("/bin/bash"), /disposed/);
          yield* host.dispose;
          yield* host.dispose;
          return;
        }
        const session = yield* host.open({ session: sessionInput, bootAttemptId: "recorded-boot" });
        files = host.computer.files;
        NodeAssert.equal(session.providerSession.id, providerSessionId);
        for (const executable of [
          ...Object.keys(CHILD_PROGRAM_PATHS),
          ...Object.values(CHILD_PROGRAM_PATHS),
        ])
          NodeAssert.equal(host.commands.host.resolve(executable).status, "ok");
        const terminal = yield* Deferred.make<void>();
        const events: RunnerItem[] = [];
        yield* session.events.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              events.push(event);
              if (event.kind === "provider" && event.event.type === "turn.terminal")
                yield* Deferred.succeed(terminal, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        yield* session.turn({
          turn,
          access: {
            grant: "recorded-grant",
            signal: new AbortController().signal,
            connections: { servers: [] },
          },
        });
        if (scenario !== "turn") {
          yield* Effect.promise(() => machine.started);
          retainedFd = files.open("/workspace/file.txt", 0);
          let stopped = false;
          const stopping = yield* (
            scenario === "dispose"
              ? host.dispose
              : session.control({
                  type: "interrupt",
                  runId: turn.runId,
                  preparationGeneration: turn.preparationGeneration,
                })
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                stopped = true;
              }),
            ),
            Effect.forkScoped,
          );
          yield* Effect.promise(() => machine.cancelled);
          yield* Effect.promise(() => machine.cleaning);
          NodeAssert.equal(stopped, false);
          NodeAssert.equal(machine.clean, false);
          NodeAssert.ok(host.commands.processes.size > 0);
          files.fstat(retainedFd);
          machine.release();
          yield* Fiber.join(stopping);
          if (scenario === "interrupt") {
            yield* Deferred.await(terminal);
            NodeAssert.ok(
              events.some(
                (event) =>
                  event.kind === "provider" &&
                  event.event.type === "turn.terminal" &&
                  event.event.status === "interrupted",
              ),
            );
            yield* host.dispose;
          }
          NodeAssert.equal(machine.clean, true);
          NodeAssert.equal(machine.cleanupCount, 1);
          NodeAssert.equal(host.commands.processes.size, 0);
          NodeAssert.equal(capacity.active, 0);
          NodeAssert.equal(files.descriptors.has(retainedFd), false);
          return;
        }
        yield* Deferred.await(terminal);
        if (native.failure !== undefined) throw native.failure;
        NodeAssert.deepEqual(commands.commands, ["/usr/bin/git", "/bin/sed"]);
        NodeAssert.deepEqual(machine.requests, ["/usr/bin/machine-tool"]);
        NodeAssert.deepEqual(native.outputs, [" M file.txt\n", "", "machine output\n"]);
        NodeAssert.equal(
          createNodeFs(host.computer.files).fs.readFileSync("/workspace/file.txt", "utf8"),
          "after\n",
        );
        NodeAssert.equal(native.sdkIdentity, nativeId);
        NodeAssert.equal(native.consumed, 1);
        NodeAssert.ok(
          new TextDecoder().decode(Buffer.concat(observed)).includes("commands complete"),
        );
        NodeAssert.deepEqual(modelRequests, [
          "https://recorded.invalid/root",
          "https://recorded.invalid/child",
        ]);
        NodeAssert.ok(commands.identities[0]!.pid > 1);
        NodeAssert.ok(commands.identities[0]!.parentPid > 1);
        NodeAssert.notEqual(commands.identities[0]!.pid, commands.identities[0]!.parentPid);
        NodeAssert.equal(saveCalls, 1);
        NodeAssert.equal(
          new TextDecoder().decode(
            persistencePorts.committedTurns[0]!.tree["/workspace/file.txt"]!.data!,
          ),
          "after\n",
        );
        NodeAssert.ok(
          events.some((event) => event.kind === "provider" && event.event.type === "turn.terminal"),
        );
        yield* Effect.promise(() => host.commands.drain());
        NodeAssert.equal(capacity.active, 0);
        const processTable = host.commands.processes;
        yield* host.dispose;
        NodeAssert.equal(processTable.size, 0);
        yield* Effect.promise(() =>
          NodeAssert.rejects(host.computer.port(8080, new AbortController().signal)),
        );
        yield* Effect.promise(() =>
          NodeAssert.rejects(host.computer.save(new AbortController().signal)),
        );
        NodeAssert.equal(saveCalls, 1);
        NodeAssert.ok(nativeProcess);
        NodeAssert.equal((yield* Effect.promise(() => nativeProcess!.exited)).signal, 15);
      }),
    ),
  );
}
