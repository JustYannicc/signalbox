import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import {
  createProductCodexHarnessSessionHost,
  type ProductCodexHarnessHostOptions,
} from "../../ProductCodexHarnessSessionHost.ts";
import { ChildWorkerCapacity } from "../../../computer/ChildWorkerCapacity.ts";
import { createMemoryFilePersistencePorts } from "../../../kernel/MemoryFilePersistencePorts.ts";
import type { codexFixture } from "../../releaseLoader/tests/artifactFixtures.ts";
import {
  adapterOptions,
  session as codexSession,
} from "../../codex/tests/preinitializedFixture.ts";
import { echoEngine } from "../../codex/tests/wasm.ts";
import { hostSqlite } from "../hostSqlite.ts";
import { commandLoader, programFixture } from "./commands.ts";

type ReleaseOptions = Awaited<ReturnType<typeof codexFixture>>["options"];

export const productOptions = (release: ReleaseOptions, home = "/home/product-codex") =>
  Effect.gen(function* () {
    const database = yield* Effect.acquireRelease(Effect.sync(hostSqlite), (value) =>
      Effect.sync(() => value.dispose()),
    );
    const programs = yield* Effect.promise(programFixture);
    const adapter = yield* adapterOptions();
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    let fallbackCalls = 0;
    let modelCalls = 0;
    const commands = commandLoader();
    const options: ProductCodexHarnessHostOptions<unknown> = {
      threadId: codexSession.threadId,
      release,
      programs: { codes: programs.codes, seed: programs.seed },
      files: {
        identity: "product-codex-computer",
        database: database.open().storage,
        nowNs: () => 0n,
        persistencePorts: createMemoryFilePersistencePorts(),
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
        capacity: new ChildWorkerCapacity(2, {
          owner: "test/src-harness-tests-producthost-codex-1",
        }),
        machine: () => ({
          async spawn() {
            throw new Error("Unexpected forwarded command");
          },
        }),
      },
      modelTransport: async () => {
        modelCalls++;
        return new Response("product model transport");
      },
      executor: { forward: async () => new Response("executor") },
      save: async () => ({ commit: "unused" }),
      port: async () => ({ fetch: async () => new Response("port") }),
      native: {
        harness: "codex",
        process: {
          engine: echoEngine(),
          environment: { HOME: home, CODEX_EXEC_SERVER_URL: "ws://exec.test/session" },
          bootstrap: {
            type: "bootstrap",
            codex_home: "/separate/config/codex",
            cwd: "/workspace",
            overrides: {},
          },
          environmentInfo: {
            cwd: "/workspace",
            platformOs: "linux",
            shell: { name: "bash", path: "/bin/bash" },
            executorVersion: "test",
          },
          fetch: async () => {
            fallbackCalls++;
            return new Response("fallback fetch");
          },
          lifetime: { waitUntil: () => undefined },
        },
        adapter,
        mcpSessions,
        modelOrigins: ["https://models.product.test"],
      },
      hydrate: async () => {},
    };
    const host = yield* createProductCodexHarnessSessionHost(options);
    yield* Effect.addFinalizer(() => Effect.orDie(host.dispose));
    yield* host.seed("assets");
    yield* host.seed("programs");
    return {
      host,
      options,
      get fallbackCalls() {
        return fallbackCalls;
      },
      get modelCalls() {
        return modelCalls;
      },
    };
  });
