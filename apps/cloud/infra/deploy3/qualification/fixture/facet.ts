import { calibrateComputer } from "./calibrationComputer.ts";
import ENGINE from "./codex-engine.wasm";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import { layerCrypto } from "../../../../src/platform.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { CodexSettings } from "@t3tools/contracts";
import { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import { CODEX_DEFAULT_INSTANCE_ID } from "@signalbox/provider-codex/defaults";
import { createHarnessCProductCodexFacetClass } from "../../../../src/harness/ProductCodexHarnessRequestFacet.ts";
import type { HarnessCProductFacetEnvironment } from "../../../../src/harness/HarnessCProductFacet.ts";
import type { ProductCodexHarnessHostOptions } from "../../../../src/harness/ProductCodexHarnessSessionHost.ts";
import { HarnessRequestFacetError } from "../../../../src/harness/HarnessRequestFacet.ts";
import { ChildWorkerCapacity } from "../../../../src/computer/ChildWorkerCapacity.ts";
import { materializeHarnessCProductFiles } from "../../../../src/harness/HarnessCProductCheckpoint.ts";
import type { ChildWorkerLoaderPort } from "../../../../src/computer/WorkerLoaderDispatch.ts";
import type { QualifierCapabilities } from "./capabilities.ts";
import { HARNESS_C_PRODUCT_CAPABILITY_KEYS } from "../../../../src/harness/HarnessCProductCapabilities.ts";
import { facetState } from "./facetState.ts";
import { turnBindings } from "./facetBindings.ts";
import { capture, compareBeforeReadiness } from "./snapshot.ts";
import { assert, HOME, CODEX_HOME, MODEL_ORIGIN, jsonBytes, sha256, toBase64 } from "./common.ts";
import {
  assertQualifierCodexFacetConfiguration,
  type QualifierCodexFacetConfiguration,
} from "../facetEnvironmentContract.ts";

type Env = HarnessCProductFacetEnvironment & typeof QualifierCodexFacetConfiguration.Type;
function capability(env: Env) {
  const supplied = env.HARNESS_C_PRODUCT_CAPABILITIES?.[HARNESS_C_PRODUCT_CAPABILITY_KEYS.release];
  assert(
    supplied &&
      typeof Reflect.get(supplied, "hostConfiguration") === "function" &&
      typeof Reflect.get(supplied, "append") === "function",
    "Qualifier capability methods are missing",
  );
  return supplied as unknown as QualifierCapabilities;
}
function commandLoader(env: Env) {
  const supplied = env.HARNESS_C_PRODUCT_CAPABILITIES?.["qualifierCommands"];
  assert(
    supplied && typeof Reflect.get(supplied, "run") === "function",
    "Actual program loader capability is missing",
  );
  return supplied as unknown as ChildWorkerLoaderPort;
}
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const decodeTurn = Schema.decodeSync(Schema.fromJsonString(Schema.toCodecJson(RunnerTurn)));
const layer = Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, layerCrypto);
const buildOptions = (
  input: { env: Env; ctx: DurableObjectState; facetNonce: string },
  restored?: Parameters<typeof compareBeforeReadiness>[1],
) =>
  Effect.gen(function* () {
    const { env, ctx, facetNonce } = input;
    assertQualifierCodexFacetConfiguration(env);
    const cap = capability(env);
    const config = yield* Effect.promise(() => cap.hostConfiguration());
    yield* Effect.promise(() =>
      cap.prepareModelIncarnation({
        incarnation: facetNonce,
        loaderId: env.HARNESS_PROCESS_LOADER_ID,
        restored: restored !== undefined,
      }),
    );
    const state = facetState(ctx, cap, facetNonce);
    const initial = decodeTurn(config.turnJson[0]!);
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    const settings = yield* decodeCodexSettings({});
    let commandOrdinal = 0;
    const loader: ChildWorkerLoaderPort = {
      async run(invocation, target) {
        const ordinal = ++commandOrdinal;
        const phase = `command-${ordinal}:${invocation.command.executable}:${invocation.command.argv.slice(1).join(" ")}`;
        const before = state.reads.snapshot().length;
        state.reads.phase(phase);
        await cap.append("command-entered", {
          incarnation: facetNonce,
          ordinal,
          command: invocation.command,
          loaderId: invocation.loaderId,
          phase,
        });
        const result = await commandLoader(env).run(invocation, target);
        await cap.append("command-terminal", {
          incarnation: facetNonce,
          ordinal,
          command: invocation.command,
          loaderId: invocation.loaderId,
          result,
          reads: state.reads.snapshot().slice(before),
        });
        state.reads.phase("outside-command");
        return result;
      },
    };
    yield* Effect.promise(() =>
      cap.append("product-options-prepared", {
        incarnation: facetNonce,
        restored: restored !== undefined,
        seedKind: restored ? "committed-files" : "fresh-real-git",
      }),
    );
    const options: Omit<
      ProductCodexHarnessHostOptions<unknown>,
      | "release"
      | "processResumeArtifact"
      | "programs"
      | "machineInventory"
      | "modelTransport"
      | "executor"
    > = {
      threadId: initial.threadId,
      files: state.files,
      commands: {
        loader,
        capacity: new ChildWorkerCapacity(2, {
          owner: `qualifier/${config.runId}/${facetNonce}`,
          RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
        }),
        machine: () => ({
          files: {
            current: () => ({
              generation: null,
              generationAbsent: true,
              pristine: true,
              imageDigest: config.imageDigest,
            }),
            markExecuted: async () => {
              throw new Error("This qualifier owns no machine generation");
            },
            lookup: async () => {
              throw new Error("Live machine file access is outside this qualifier");
            },
          },
          spawn: async () => {
            throw new Error("Machine command forwarding is outside this qualifier");
          },
        }),
      },
      observeInput: (bytes) => state.raw("native-stdin", bytes),
      observeOutput: (fd, bytes) => state.raw(fd === 1 ? "native-stdout" : "native-stderr", bytes),
      hydrate: async ({ files }) => {
        state.boundFiles = files;
        state.threadId = initial.threadId;
        const seed = restored === undefined ? await cap.seedCheckpoint() : undefined;
        const expected = restored ?? seed!.files;
        if (seed)
          materializeHarnessCProductFiles({
            files: state.files,
            threadId: initial.threadId,
            checkpoint: seed,
          });
        const proof = await compareBeforeReadiness(files, expected);
        for (const entry of expected)
          if (entry.kind !== "symlink")
            state.reads.register(entry.path, files.resolve(`/workspace/${entry.path}`).inode);
        state.reads.phase("repository-readiness");
        await cap.append("files-before-readiness", {
          incarnation: facetNonce,
          restored: restored !== undefined,
          proof,
        });
      },
      save: async () => {
        await state.flush();
        if (!state.boundFiles || !state.threadId)
          throw new Error("The product filesystem is not bound before save");
        const files = await Promise.all(
          capture(state.files, state.threadId, state.boundFiles).map(async (file) => ({
            path: file.path,
            kind: file.kind ?? "file",
            mode: file.mode,
            bytes: file.bytes.byteLength,
            sha256: await sha256(file.bytes),
            contentBase64: toBase64(file.bytes),
          })),
        );
        const transcriptPaths = files
          .filter((file) => file.path.includes("/.codex/sessions/") && file.path.endsWith(".jsonl"))
          .map((file) => file.path);
        // @effect-diagnostics-next-line cryptoRandomUUID:off - The product save callback assigns an immutable capture ID outside the request Effect.
        const captureId = crypto.randomUUID();
        const artifact = await cap.artifact(
          `before-export-${facetNonce}-${captureId}`,
          jsonBytes({
            schema: "sb1070/pre-export-computer-files/v1",
            incarnation: facetNonce,
            threadId: state.threadId,
            restored: restored !== undefined,
            files,
            transcriptPaths,
          }),
        );
        await cap.append("before-export-computer-files-captured", {
          incarnation: facetNonce,
          artifact,
          fileCount: files.length,
          transcriptPaths,
        });
        return { commit: `qualifier-snapshot-${facetNonce}` };
      },
      port: async () => {
        throw new Error("Opening network ports is outside this qualifier");
      },
      native: {
        harness: "codex",
        adapter: {
          defaultCwd: "/workspace",
          instanceId: CODEX_DEFAULT_INSTANCE_ID,
          settings,
          crypto: yield* Crypto.Crypto,
          fileSystem: FileSystem.makeNoop({}),
          idAllocator,
          attachmentsDir: "/workspace/.attachments",
          attachments: {
            resolvePath: () => null,
            resolvePathById: () => null,
            snapshotMcpApp: () => Effect.succeed(undefined),
          },
          clientInfo: { name: "signalbox-combined-qualifier", version: "1" },
        },
        mcpSessions,
        modelOrigins: [MODEL_ORIGIN],
        processObserver: {
          started(process) {
            state.queue(() =>
              cap.append("native-process-started", {
                incarnation: facetNonce,
                startup: process.startup?.() ?? null,
              }),
            );
          },
          abandoned(cause) {
            state.queue(() =>
              cap.append("native-process-abandoned", {
                incarnation: facetNonce,
                cause: String(cause),
              }),
            );
          },
        },
        process: {
          engine: ENGINE,
          environment: {
            HOME,
            CODEX_HOME,
            CODEX_EXEC_SERVER_URL: "ws://127.0.0.1:10270/exec",
            PATH: "/bin:/usr/bin",
            LANG: "C",
            LC_ALL: "C",
          },
          bootstrap: {
            type: "bootstrap",
            codex_home: CODEX_HOME,
            cwd: "/workspace",
            host_capabilities: { standard_form_input: true },
            overrides: {
              check_for_update_on_startup: false,
              "analytics.enabled": false,
              "feedback.enabled": false,
              model: initial.modelSelection.model,
              model_provider: "proof",
              "model_providers.proof": {
                name: "Controlled websocket peer",
                base_url: `${MODEL_ORIGIN}/v1`,
                wire_api: "responses",
                requires_openai_auth: false,
                supports_websockets: true,
                request_max_retries: 0,
                stream_max_retries: 0,
                stream_idle_timeout_ms: 120000,
              },
              "features.shell_snapshot": false,
              "features.unified_exec": true,
              "features.respect_system_proxy": true,
            },
          },
          environmentInfo: {
            cwd: "file:///workspace",
            userHomeDir: `file://${HOME}`,
            tempDir: "file:///tmp",
            capabilities: { tty: false },
            platformOs: "linux",
            shell: { name: "bash", path: "/bin/bash" },
            executorVersion: "combined-qualifier",
          },
          fetch: async (request) => {
            throw new Error(`Undeclared native network request: ${request.method} ${request.url}`);
          },
          lifetime: { waitUntil: (promise) => ctx.waitUntil(promise) },
        },
      },
    };
    return options;
  }).pipe(
    Effect.provide(layer),
    Effect.mapError(
      (cause) =>
        new HarnessRequestFacetError("Qualifier product options could not be prepared", { cause }),
    ),
  );

const Base = createHarnessCProductCodexFacetClass<Env, unknown>({
  buildHostOptions: (input) => buildOptions(input, input.filesCheckpoint.files),
  buildOpenInput: ({ env, nativeSessionId }) =>
    Effect.gen(function* () {
      const config = yield* Effect.promise(() => capability(env).hostConfiguration());
      const turn = decodeTurn(config.turnJson[0]!);
      return {
        session: {
          threadId: turn.threadId,
          providerSessionId: turn.providerThread.providerSessionId!,
          modelSelection: turn.modelSelection,
          runtimePolicy: {
            cwd: "/workspace",
            runtimeMode: "full-access",
            interactionMode: "default",
          },
          initialNativeThreadId: nativeSessionId,
        },
        bootAttemptId: "restored-product-open",
      };
    }),
  fresh: {
    buildHostOptions: (input) => buildOptions(input),
    buildOpenInput: ({ env }) =>
      Effect.gen(function* () {
        const config = yield* Effect.promise(() => capability(env).hostConfiguration());
        const turn = decodeTurn(config.turnJson[0]!);
        assert(
          turn.providerThread.nativeThreadRef === null,
          "Cold input already names a native UUID",
        );
        return {
          session: {
            threadId: turn.threadId,
            providerSessionId: turn.providerThread.providerSessionId!,
            modelSelection: turn.modelSelection,
            runtimePolicy: {
              cwd: "/workspace",
              runtimeMode: "full-access",
              interactionMode: "default",
            },
          },
          creation: { providerThread: turn.providerThread },
          bootAttemptId: "fresh-product-open",
        };
      }),
  },
  buildTurnBindings: ({ env, ctx }) => Effect.succeed(turnBindings(ctx, capability(env))),
});
export class CodexFacet extends Base {
  override async loadedPreparedRelease() {
    const observed = await super.loadedPreparedRelease();
    await capability(this.env).append("loaded-prepared-release-observed", {
      incarnation: this.facetNonce,
      loadedPreparedRelease: observed,
      sha256: await sha256(jsonBytes(observed)),
    });
    return observed;
  }
  async observerCalibration(input: { invocationId: string }) {
    const commands = await calibrateComputer(
      this.ctx,
      capability(this.env),
      commandLoader(this.env),
    );
    return {
      incarnation: this.facetNonce,
      invocationId: input.invocationId,
      nativeStarted: false,
      commands,
    };
  }
}
