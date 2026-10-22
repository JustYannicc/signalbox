// @effect-diagnostics nodeBuiltinImport:off - Controlled native modules run in an isolated test realm.
import * as NodeBuffer from "node:buffer";
import * as NodeConstants from "node:constants";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as Yaml from "yaml";
import * as NodeAssert from "node:assert/strict";
import { ProviderDriverKind, ProviderInstanceId, ProviderSessionId } from "@t3tools/contracts";
import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";
import * as Effect from "effect/Effect";
import { ChildWorkerCapacity } from "../../../computer/ChildWorkerCapacity.ts";
import { createMemoryFilePersistencePorts } from "../../../kernel/MemoryFilePersistencePorts.ts";
import { createNodeFs } from "../../../isolate/NodeFs.ts";
import type { HarnessContinuation } from "../../HarnessContinuations.ts";
import { createProductClaudeHarnessSessionHost } from "../../ProductClaudeHarnessSessionHost.ts";
import { claudeFixture } from "../../releaseLoader/tests/artifactFixtures.ts";
import { data } from "../../adapter/tests/data.ts";
import { hostSqlite } from "../hostSqlite.ts";
import { adapter, services } from "./adapter.ts";
import { commandLoader, programFixture } from "./commands.ts";
import { machineFixture } from "./machine.ts";
import { continuationNativeFixture } from "./continuationNative.ts";

export const continuationHostFixture = Effect.gen(function* () {
  const database = yield* Effect.acquireRelease(Effect.sync(hostSqlite), (value) =>
    Effect.sync(() => value.dispose()),
  );
  const deps = yield* services;
  const d = yield* data;
  const instanceId = ProviderInstanceId.make("recorded-claude");
  const driver = ProviderDriverKind.make("claudeAgent");
  const providerSessionId = ProviderSessionId.make("original-recorded-session");
  const nativeId = "12345678-1234-4234-8234-123456789abc";
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
  const systemIdentity = systemIdentityForThread(d.threadId, {
    release: "6.12.8-production",
    version: "#1 SMP_PREEMPT_DYNAMIC",
    machine: "aarch64",
    hostnamePolicy: "thread",
    verification: "measured",
  });
  const native = continuationNativeFixture(nativeId, systemIdentity);
  const commands = commandLoader();
  const machine = machineFixture("turn", () => {});
  const persistencePorts = createMemoryFilePersistencePorts();
  const at = { repository: "product-test", fork: "thread", commit: "base" };
  persistencePorts.seedFile(at, "/workspace/file.txt", new TextEncoder().encode("before\n"));
  const databaseHandle = database.open();
  const publishedRequests: HarnessContinuation[] = [];
  const journalRowsAtPublish: unknown[][] = [];
  let journalReadFailure: unknown;
  const release = yield* Effect.promise(() => claudeFixture());
  const programs = yield* Effect.promise(programFixture);

  const host = yield* createProductClaudeHarnessSessionHost({
    threadId: d.threadId,
    release: release.options,
    programs,
    files: {
      identity: "recorded-claude-files",
      database: databaseHandle.storage,
      nowNs: () => 0n,
      persistencePorts,
      rootMetadata: { mode: 0o755, uid: 1000, gid: 1000 },
      posix: {
        credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 },
        umask: 0o022,
      },
      cwd: "/workspace",
      assetMode: 0o644,
    },
    commands: {
      loader: commands.loader,
      capacity: new ChildWorkerCapacity(2),
      systemIdentity,
      machine: (identity) => {
        NodeAssert.deepEqual(identity, systemIdentity);
        return machine.port;
      },
    },
    hydrate: async ({ files }) => {
      const fs = createNodeFs(files).fs;
      fs.mkdirSync("/home/recorded", { recursive: true });
      fs.mkdirSync("/recorded/git", { recursive: true });
      fs.writeFileSync("/workspace/.git", "gitdir: /recorded/git\n");
      fs.writeFileSync("/workspace/file.txt", "before\n");
      fs.writeFileSync("/home/recorded/session", nativeId);
      fs.symlinkSync("/workspace", "/source-alias");
    },
    save: async ({ files, persistence, signal }) => {
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
    modelTransport: async (request) =>
      new Response(request.url.endsWith("/root") ? "root response" : "child response"),
    executor: { forward: async () => new Response("executor") },
    continuations: {
      publish: (request) =>
        Effect.sync(() => {
          publishedRequests.push(request);
          try {
            journalRowsAtPublish.push(
              databaseHandle.rows(
                "SELECT message_id, request_json, published FROM harness_continuation_requests",
              ),
            );
          } catch (error) {
            journalReadFailure = error;
          }
        }),
    },
    native: {
      adapter: ({ harness }) => Effect.succeed(adapter(harness.computer.files, deps, instanceId)),
      mcpSessions: deps.mcpSessions,
      loadSdk: native.loadSdk,
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
  yield* Effect.addFinalizer(() => host.dispose.pipe(Effect.orDie));
  yield* host.seed("assets");
  yield* host.seed("programs");
  const session = yield* host.open({ session: sessionInput, bootAttemptId: "claude-continuation" });

  return {
    host,
    session,
    turn,
    threadId: d.threadId,
    providerThreadId: d.providerThread.id,
    nativeId,
    native,
    publishedRequests,
    journalRowsAtPublish,
    get journalReadFailure() {
      return journalReadFailure;
    },
    readContinuationRows: () =>
      databaseHandle.rows(
        "SELECT message_id, request_json, published FROM harness_continuation_requests",
      ),
    access: {
      grant: "recorded-grant",
      signal: new AbortController().signal,
      connections: { servers: [] },
    },
  };
});
