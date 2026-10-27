// @effect-diagnostics nodeBuiltinImport:off - This facet uses controlled SDK inputs behind the public Claude host options.
// @effect-diagnostics cryptoRandomUUID:off - Save commits use opaque fixture-local IDs.
import * as NodeBuffer from "node:buffer";
import * as NodeConstants from "node:constants";
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as Yaml from "yaml";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HarnessRequestFacetError } from "../../../HarnessRequestFacet.ts";
import { createHarnessCProductClaudeFacetClass } from "../../../ProductClaudeHarnessRequestFacet.ts";
import { createNodeFs } from "../../../../isolate/NodeFs.ts";
import { ChildWorkerCapacity } from "../../../../computer/ChildWorkerCapacity.ts";
import { createMemoryFilePersistencePorts } from "../../../../kernel/MemoryFilePersistencePorts.ts";
import type { ProductClaudeHarnessHostOptions } from "../../../ProductClaudeHarnessSessionHost.ts";
import { dataForDriver } from "../../../adapter/tests/data.ts";
import { adapter, services } from "../../../tests/productHost/adapter.ts";
import { commandLoader } from "../../../tests/productHost/commands.ts";
import { machineFixture } from "../../../tests/productHost/machine.ts";
import { nativeFixture } from "../../../tests/productHost/native.ts";
import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";
import {
  fixture,
  makeTurnBindings,
  nativeSessionId,
  openInput,
  productExecutor,
  storageFor,
} from "./productFacet.common.fixture.ts";
import type { ProductFixtureEnv, ProductFixtureGrant } from "./productFacet.common.fixture.ts";

export class ClaudeFacet extends createHarnessCProductClaudeFacetClass<
  ProductFixtureEnv,
  ProductFixtureGrant
>({
  buildHostOptions: ({ env, ctx }) =>
    Effect.gen(function* () {
      const deps = yield* services;
      const data = yield* dataForDriver(ProviderDriverKind.make("claudeAgent"));
      const commands = commandLoader();
      const machine = machineFixture("turn", () => {});
      const identity = systemIdentityForThread(data.threadId, {
        release: "fixture-kernel",
        version: "#1 fixture",
        machine: "x86_64",
        hostnamePolicy: "thread",
        verification: "measured",
      });
      const native = nativeFixture(nativeSessionId, identity);
      const access = fixture(env);
      yield* Effect.promise(() =>
        access.observe("bootstrap:claude", env.HARNESS_C_PRODUCT_BOOTSTRAP),
      );
      const nativeOptions: ProductClaudeHarnessHostOptions<ProductFixtureGrant>["native"] = {
        harness: "claude-code",
        adapter: ({ harness }) =>
          Effect.succeed(adapter(harness.computer.files, deps, data.instanceId)),
        mcpSessions: deps.mcpSessions,
        loadSdk: async (bridge) => {
          const sdk = await native.loadSdk(bridge);
          return {
            ...sdk,
            query(input) {
              const query = sdk.query(input);
              const next = query.next.bind(query);
              let checkedExecutor = false;
              let executorUrl: string | undefined;
              const setMcpServers = query.setMcpServers.bind(query);
              query.setMcpServers = async (servers) => {
                const executor = servers.executor;
                if (executor !== undefined && "url" in executor) executorUrl = executor.url;
                return await setMcpServers(servers);
              };
              query.next = async (...args) => {
                if (!checkedExecutor) {
                  checkedExecutor = true;
                  if (executorUrl === undefined)
                    throw new Error("Native Executor MCP route is missing.");
                  // @effect-diagnostics-next-line globalFetch:off - This uses the native SDK's installed MCP URL through the Node personality.
                  const response = await globalThis.fetch(executorUrl, {
                    method: "POST",
                    body: "native-executor-request",
                  });
                  if (
                    response.status !== 200 ||
                    (await response.text()) !== "fixture executor response"
                  )
                    throw new Error("Native Executor MCP response changed.");
                }
                const result = await next(...args);
                if (!result.done && result.value.type === "result") {
                  const fs = bridge.require("node:fs") as ReturnType<typeof createNodeFs>["fs"];
                  await fs.promises.writeFile(
                    "/workspace/.claude/projects/-workspace/product-native-session.jsonl",
                    `${JSON.stringify(result.value)}\n`,
                  );
                }
                return result;
              };
              return query;
            },
          };
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
      };
      const files = {
        identity: "product-workerd-files",
        database: storageFor(ctx),
        nowNs: () => 0n,
        persistencePorts: createMemoryFilePersistencePorts(),
        rootMetadata: { mode: 0o755, uid: 1000, gid: 1000 },
        posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
        cwd: "/workspace",
        assetMode: 0o644,
      };
      return {
        threadId: data.threadId,
        continuations: { publish: () => Effect.die(new Error("Unexpected fixture continuation.")) },
        native: nativeOptions,
        files,
        commands: {
          loader: commands.loader,
          capacity: new ChildWorkerCapacity(2, {
            owner: `test/product-facet-claude/${data.threadId}`,
            RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
          }),
          systemIdentity: identity,
          machine: () => machine.port,
        },
        hydrate: async ({
          files: filesystem,
        }: {
          readonly files: import("../../../../kernel/KernelFileSystem.ts").KernelFileSystem;
        }) => {
          const fs = createNodeFs(filesystem).fs;
          fs.mkdirSync("/home/recorded", { recursive: true });
          fs.mkdirSync("/recorded/git", { recursive: true });
          fs.writeFileSync("/workspace/.git", "gitdir: /recorded/git\n");
          fs.writeFileSync("/workspace/file.txt", "before\n");
          fs.writeFileSync("/home/recorded/session", nativeSessionId);
          fs.mkdirSync("/home/recorded/.claude/projects/-workspace", { recursive: true });
          fs.mkdirSync("/workspace/.claude/projects/-workspace", { recursive: true });
          fs.symlinkSync("/workspace", "/source-alias");
          await access.observe("claude-host-hydrated", true);
        },
        save: async () => ({ commit: `claude-${crypto.randomUUID()}` }),
        port: async () => ({ fetch: async () => new Response("machine service") }),
        modelTransport: (request: Request) => access.fetchModel(request),
        executor: productExecutor(env),
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new HarnessRequestFacetError("Fixture host options could not be built.", { cause }),
      ),
    ),
  buildOpenInput: ({ env, nativeSessionId: sessionId }) =>
    Effect.gen(function* () {
      const data = yield* dataForDriver(ProviderDriverKind.make("claudeAgent"));
      const canonical = fixture(env);
      yield* Effect.promise(() => canonical.observe("open:claude", sessionId));
      return openInput({
        threadId: data.threadId,
        providerSessionId: data.providerSessionId,
        modelSelection: data.modelSelection,
        nativeSessionId: sessionId,
      });
    }),
  buildTurnBindings: ({ env, ctx }) => Effect.succeed(makeTurnBindings(env, ctx)),
}) {}
