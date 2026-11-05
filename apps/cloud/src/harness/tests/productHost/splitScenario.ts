// @effect-diagnostics nodeBuiltinImport:off - Controlled native bytes run in an isolated Node realm.
import * as NodeAssert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { dataForDriver } from "../../adapter/tests/data.ts";
import { ProviderDriverKind } from "@t3tools/contracts";
import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";
import { createProductClaudeKernelHost } from "../../ProductClaudeKernelHost.ts";
import { ClaudeKernelSession } from "../../ClaudeKernelSession.ts";
import { ComputerExecutionObject } from "../../../computer/ComputerExecutionObject.ts";
import { hostSqlite } from "../hostSqlite.ts";
import { continuationHostInputs } from "./continuationHost.ts";
import { exerciseContinuation } from "./continuationScenario.ts";
import { write } from "./commands.ts";
import type { createNodeFs } from "../../../isolate/NodeFs.ts";
import type { createNodeChildProcess } from "../../../isolate/NodeChildProcess.ts";
import type { KernelFileSystem } from "../../../kernel/KernelFileSystem.ts";
import {
  KernelFileTransfer,
  kernelFileTransferManifest,
  readKernelFileTransfer,
} from "../../../kernel/KernelFileTransfer.ts";

export const run = (mode: "turns" | "cancel-prepare" = "turns") =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const input = yield* continuationHostInputs;
        const database = yield* Effect.acquireRelease(Effect.sync(hostSqlite), (value) =>
          Effect.sync(() => value.dispose()),
        );
        const original = input.hostOptions;
        const loader = original.commands.loader;
        if (!("run" in loader))
          throw new Error("Controlled fixture requires its actual command loader");
        const slots = new Map<string, unknown>();
        const childStorage = {
          get: async <T>(key: string) => structuredClone(slots.get(key)) as T | undefined,
          put: async <T>(key: string, value: T) => {
            slots.set(key, structuredClone(value));
          },
        };
        const rgCalls: string[][] = [];
        const owner = new ComputerExecutionObject(
          { id: "controlled-computer-do", storage: childStorage } as unknown as DurableObjectState,
          {
            RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
            CHILD_WORKERS: {
              async run(invocation, target) {
                if (invocation.command.executable !== "/bin/rg")
                  return await loader.run(invocation, target);
                if (
                  !("host" in target) ||
                  typeof target.host !== "function" ||
                  !("stopped" in target) ||
                  typeof target.stopped !== "function"
                )
                  throw new Error("Grep requires admitted syscall and stop capabilities");
                const port = await target.host();
                rgCalls.push([...invocation.command.argv]);
                try {
                  await write(port, 1, "file.txt:1:before\n");
                  return { exitCode: 0, signal: 0, coreDumped: false };
                } finally {
                  await target.stopped();
                }
              },
            },
          },
        );
        let canonical: KernelFileSystem | undefined;
        const preparing = Promise.withResolvers<void>();
        const cancelled = Promise.withResolvers<void>();
        const releasePreparation = Promise.withResolvers<void>();
        const read = Promise.withResolvers<string>();
        const grep = Promise.withResolvers<string>();
        let launches = 0;
        const kernel = new ClaudeKernelSession(() => ({
          files: {
            database: database.open().storage,
            nowNs: original.files.nowNs,
            persistencePorts: original.files.persistencePorts,
          },
          native: () => ({
            ...original.native.process,
            loadRelease: async (bridge, signal) => {
              const release = await original.native.process.loadRelease(bridge, signal);
              if (typeof release !== "object" || release === null)
                throw new Error("Controlled release must be an object");
              return {
                ...release,
                async launch() {
                  launches++;
                  const fs = bridge.require("node:fs") as ReturnType<typeof createNodeFs>["fs"];
                  const text = String(fs.readFileSync("/workspace/file.txt", "utf8"));
                  read.resolve(text);
                  const children = bridge.require("node:child_process") as ReturnType<
                    typeof createNodeChildProcess
                  >;
                  const child = children.spawn("/bin/rg", ["--line-number", "before", "file.txt"], {
                    cwd: "/workspace",
                  });
                  const chunks: string[] = [];
                  child.stdout?.on("data", (bytes) => chunks.push(String(bytes)));
                  await new Promise<void>((resolve, reject) => {
                    child.once("error", reject);
                    child.once("close", (code) =>
                      code === 0 ? resolve() : reject(new Error(`Grep exited ${code}`)),
                    );
                  });
                  grep.resolve(chunks.join(""));
                  const launch = Reflect.get(release, "launch");
                  if (typeof launch !== "function")
                    throw new Error("Controlled release omitted launch");
                  return await Reflect.apply(launch, release, []);
                },
              };
            },
          }),
          machine: original.commands.machine,
          hydrate: async (binding) => {
            canonical = binding.files;
            if (mode === "cancel-prepare") {
              binding.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
              preparing.resolve();
              await releasePreparation.promise;
              binding.files.stat("/bin/bash");
              binding.signal.throwIfAborted();
            }
            await original.hydrate?.(binding);
          },
          save: original.save,
          port: original.port,
        }));
        const host = yield* createProductClaudeKernelHost({
          threadId: original.threadId,
          sessionKey: "controlled-product-incarnation",
          release: original.release,
          releaseVariants: original.releaseVariants,
          programs: original.programs,
          machineInventory: original.machineInventory,
          files: {
            identity: original.files.identity,
            database: original.files.database,
            rootMetadata: original.files.rootMetadata,
            posix: original.files.posix,
            cwd: original.files.cwd,
            assetMode: original.files.assetMode,
          },
          modelTransport: original.modelTransport,
          executor: original.executor,
          continuations: original.continuations,
          kernel,
          commands: owner,
          admission: { limit: 2, path: ["/bin", "/usr/bin"] },
          native: {
            sdkHost: original.native.sdkHost,
            process: {
              identity: original.native.process.identity,
              env: original.native.process.env,
              bun: original.native.process.bun,
              ...(original.commands.systemIdentity === undefined
                ? {}
                : {
                    systemIdentity: systemIdentityForThread(
                      original.threadId,
                      original.commands.systemIdentity,
                    ),
                  }),
            },
          },
        });
        yield* Effect.addFinalizer(() => host.dispose.pipe(Effect.orDie));
        yield* host.seed("assets");
        yield* host.seed("programs");
        const identity = yield* Effect.promise(() => kernel.kernelIdentity());
        if (mode === "cancel-prepare") {
          const opening = yield* host
            .open({ session: input.sessionInput, bootAttemptId: "cancelled-prepare" })
            .pipe(Effect.forkScoped);
          yield* Effect.promise(() => preparing.promise);
          const interrupting = yield* Fiber.interrupt(opening).pipe(Effect.forkScoped);
          yield* Effect.promise(() => cancelled.promise);
          NodeAssert.ok(canonical!.stat("/bin/bash"));
          releasePreparation.resolve();
          yield* Fiber.join(interrupting);
          yield* host.dispose;
          NodeAssert.throws(() => canonical!.stat("/bin/bash"), /disposed/);
          return;
        }
        const prior = yield* dataForDriver(ProviderDriverKind.make("claudeAgent"));
        const session = yield* host.open({
          session: input.sessionInput,
          bootAttemptId: "split-continuation",
          checkpoint: {
            release: host.release,
            providerSession: {
              ...prior.providerSession,
              id: input.sessionInput.providerSessionId,
              providerInstanceId: input.sessionInput.modelSelection.instanceId,
              model: input.sessionInput.modelSelection.model,
            },
            snapshot: {
              providerThread: input.turn.providerThread,
              providerTurns: [],
              messages: [],
              runtimeRequests: [],
            },
            revision: { commit: "previous-fixture-checkpoint" },
          },
          initialAccess: input.access,
        });
        yield* session.retireCheckpointAccess;
        yield* exerciseContinuation({ ...input, session });
        NodeAssert.equal(yield* Effect.promise(() => read.promise), "before\n");
        NodeAssert.equal(yield* Effect.promise(() => grep.promise), "file.txt:1:before\n");
        NodeAssert.equal(launches, 1);
        NodeAssert.deepEqual(rgCalls, [["/bin/rg", "--line-number", "before", "file.txt"]]);
        NodeAssert.deepEqual(yield* Effect.promise(() => kernel.kernelIdentity()), identity);
        NodeAssert.equal(typeof host.computer.files, "string");
        NodeAssert.notEqual(host.computer.files, canonical);
        const captured = yield* Effect.promise(() => kernel.capture(["file.txt"]));
        const checkpoint = yield* Effect.promise(() =>
          readKernelFileTransfer(captured.manifest, captured.source),
        );
        NodeAssert.equal(new TextDecoder().decode(checkpoint[0]!.bytes), "after\n");
        const exported = yield* session.export();
        NodeAssert.equal(
          exported.snapshot.providerThread.nativeThreadRef?.nativeId,
          input.nativeId,
        );
        NodeAssert.equal(exported.snapshot.providerTurns.length, 2);
        yield* host.dispose;
        yield* Effect.promise(async () => {
          await NodeAssert.rejects(
            kernel.exec(
              "late",
              { executable: "/bin/rg", argv: ["/bin/rg"], env: {}, cwd: "/workspace" },
              false,
            ),
          );
        });
        NodeAssert.throws(() => canonical!.stat("/workspace/file.txt"), /disposed/);
        // Restore is a bounded immutable payload transfer into a new single kernel owner.
        const restoredDatabase = yield* Effect.acquireRelease(Effect.sync(hostSqlite), (value) =>
          Effect.sync(() => value.dispose()),
        );
        const restored = new ClaudeKernelSession(() => ({
          files: {
            database: restoredDatabase.open().storage,
            nowNs: original.files.nowNs,
            persistencePorts: original.files.persistencePorts,
          },
          native: () => original.native.process,
          machine: original.commands.machine,
          save: original.save,
          port: original.port,
        }));
        yield* Effect.promise(() =>
          restored.initialize({
            threadId: original.threadId,
            sessionKey: "replacement",
            process: {
              systemIdentity: systemIdentityForThread(
                original.threadId,
                original.commands.systemIdentity,
              ),
              identity: original.native.process.identity,
              env: original.native.process.env,
              bun: original.native.process.bun,
            },
            files: {
              identity: "replacement-files",
              rootMetadata: original.files.rootMetadata,
              posix: original.files.posix,
              cwd: original.files.cwd,
              assetMode: original.files.assetMode,
            },
            machineInventory: original.machineInventory,
          }),
        );
        const transfer = new KernelFileTransfer(checkpoint);
        yield* Effect.promise(() =>
          restored.materialize(kernelFileTransferManifest(checkpoint), transfer),
        );
        yield* Effect.promise(() => restored.close());
      }),
    ),
  );
