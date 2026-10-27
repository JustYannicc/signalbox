// @effect-diagnostics cryptoRandomUUID:off - Save commits use opaque fixture-local IDs.
import C_CODEX_ENGINE from "./codex-engine.wasm";
import { CodexSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { HarnessRequestFacetError } from "../../../HarnessRequestFacet.ts";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { CODEX_DEFAULT_INSTANCE_ID } from "@signalbox/provider-codex/defaults";
import * as Schema from "effect/Schema";
import { createHarnessCProductCodexFacetClass } from "../../../ProductCodexHarnessRequestFacet.ts";
import { createNodeFs } from "../../../../isolate/NodeFs.ts";
import { ChildWorkerCapacity } from "../../../../computer/ChildWorkerCapacity.ts";
import type { ProductCodexHarnessHostOptions } from "../../../ProductCodexHarnessSessionHost.ts";
import { dataForDriver } from "../../../adapter/tests/data.ts";
import { services } from "../../../tests/productHost/adapter.ts";
import { commandLoader } from "../../../tests/productHost/commands.ts";
import { systemIdentityForThread } from "@t3tools/contracts/systemIdentity";
import { emptyMachineFilesFixture } from "../../../../computer/machineInventoryTesting.ts";
import {
  fixture,
  makeTurnBindings,
  openInput,
  productExecutor,
  storageFor,
} from "./productFacet.common.fixture.ts";
import type { ProductFixtureEnv, ProductFixtureGrant } from "./productFacet.common.fixture.ts";
import { createMemoryFilePersistencePorts } from "../../../../kernel/MemoryFilePersistencePorts.ts";

const fixtureLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
);
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

export class CodexFacet extends createHarnessCProductCodexFacetClass<
  ProductFixtureEnv,
  ProductFixtureGrant
>({
  buildHostOptions: ({ env, ctx }) =>
    Effect.gen(function* () {
      const deps = yield* services;
      const data = yield* dataForDriver(ProviderDriverKind.make("codex"));
      const identity = systemIdentityForThread(data.threadId, {
        release: "fixture-kernel",
        version: "#1 fixture",
        machine: "x86_64",
        hostnamePolicy: "thread",
        verification: "measured",
      });
      const adapter = yield* Effect.gen(function* () {
        const settings = yield* decodeCodexSettings({});
        return {
          defaultCwd: "/workspace",
          instanceId: CODEX_DEFAULT_INSTANCE_ID,
          settings,
          crypto: yield* Crypto.Crypto,
          fileSystem: yield* FileSystem.FileSystem,
          idAllocator: deps.idAllocator,
          attachmentsDir: "/workspace/attachments",
          attachments: {
            resolvePath: () => null,
            resolvePathById: () => null,
            snapshotMcpApp: () => Effect.succeed(undefined),
          },
          clientInfo: { name: "signalbox-workerd-product-fixture", version: "1" },
        };
      }).pipe(Effect.provide(fixtureLayer));
      const fixtureService = fixture(env);
      yield* Effect.promise(() =>
        fixtureService.observe("bootstrap:codex", env.HARNESS_C_PRODUCT_BOOTSTRAP),
      );
      const native: ProductCodexHarnessHostOptions<ProductFixtureGrant>["native"] = {
        harness: "codex",
        adapter,
        mcpSessions: deps.mcpSessions,
        modelOrigins: ["https://models.product.workerd.test"],
        process: {
          engine: C_CODEX_ENGINE,
          environment: { HOME: "/home/codex", CODEX_EXEC_SERVER_URL: "ws://exec.fixture/session" },
          bootstrap: {
            type: "bootstrap",
            codex_home: "/home/codex/.codex",
            cwd: "/workspace",
            overrides: {},
          },
          environmentInfo: {
            cwd: "/workspace",
            platformOs: "linux",
            shell: { name: "bash", path: "/bin/bash" },
            executorVersion: "workerd-fixture",
          },
          fetch: async () => new Response("codex fallback"),
          lifetime: { waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise) },
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
      const commands = commandLoader();
      return {
        threadId: data.threadId,
        native,
        files,
        commands: {
          loader: commands.loader,
          capacity: new ChildWorkerCapacity(2),
          systemIdentity: identity,
          machine: () => ({
            files: emptyMachineFilesFixture(),
            async spawn() {
              throw new Error("Unexpected Codex command spawn.");
            },
          }),
        },
        hydrate: async ({
          files: filesystem,
        }: {
          readonly files: import("../../../../kernel/KernelFileSystem.ts").KernelFileSystem;
        }) => {
          const fs = createNodeFs(filesystem).fs;
          fs.writeFileSync("/workspace/codex-turn.txt", "codex facet hydrated\n");
          await fixtureService.observe("codex-host-hydrated", true);
        },
        save: async () => ({ commit: `codex-${crypto.randomUUID()}` }),
        port: async () => ({ fetch: async () => new Response("machine service") }),
        modelTransport: (request: Request) => fixtureService.fetchModel(request),
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
      const data = yield* dataForDriver(ProviderDriverKind.make("codex"));
      const canonical = fixture(env);
      yield* Effect.promise(() => canonical.observe("open:codex", sessionId));
      return openInput({
        threadId: data.threadId,
        providerSessionId: data.providerSessionId,
        modelSelection: data.modelSelection,
        nativeSessionId: sessionId,
      });
    }),
  buildTurnBindings: ({ env, ctx }) => Effect.succeed(makeTurnBindings(env, ctx)),
}) {}
