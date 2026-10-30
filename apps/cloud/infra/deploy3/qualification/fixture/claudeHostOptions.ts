// @effect-diagnostics cryptoRandomUUID:off - Snapshot IDs are local qualification evidence.
import { claudeQualificationToolObservation } from "./claudeToolObservation.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import { ChildWorkerCapacity } from "../../../../src/computer/ChildWorkerCapacity.ts";
import type { ChildWorkerLoaderPort } from "../../../../src/computer/WorkerLoaderDispatch.ts";
import { HarnessRequestFacetError } from "../../../../src/harness/HarnessRequestFacet.ts";
import type { ProductClaudeHarnessHostOptions } from "../../../../src/harness/ProductClaudeHarnessSessionHost.ts";
import type { HarnessCheckpoint } from "../../../../src/harness/Harness.ts";
import type { HarnessCProductFacetEnvironment } from "../../../../src/harness/HarnessCProductFacet.ts";
import { HARNESS_C_PRODUCT_CAPABILITY_KEYS } from "../../../../src/harness/HarnessCProductCapabilities.ts";
import { DEFAULT_NODE_NATIVE_MODULES } from "../../../../src/harness/NodeNativeModules.ts";
import type { HarnessFilesStoreResult } from "../../../../src/harness/HarnessFilesStore.ts";
import { createMemoryFilePersistencePorts } from "../../../../src/kernel/MemoryFilePersistencePorts.ts";
import type { HarnessReleaseArtifact } from "../../../../src/harnessReleases/HarnessReleaseLedger.ts";
import type { LoadHarnessReleaseOptions } from "../../../../src/harness/HarnessReleaseLoader.ts";
import { QualifierCapabilities } from "./capabilities.ts";
import { facetState } from "./facetState.ts";
import { assert } from "./common.ts";
import type { QualifierEnvironment } from "./environment.ts";
import { readConfiguration } from "./configuration.ts";
import {
  decodeClaudeFacetConfiguration,
  loadClaudeQualificationRelease,
  readClaudeQualificationInputs,
  type ClaudeQualificationInputs,
} from "./claudeConfiguration.ts";
import { buildClaudeAdapter } from "./claudeAdapter.ts";
import { createClaudePreparedImports } from "./claudePreparedModules.ts";
import { claudeNodeRuntimeIdentity, claudeSeedPaths, claudeSystemIdentity } from "./claudeSeed.ts";
import {
  createClaudeContinuationPublisher,
  type ClaudeContinuationCapability,
} from "./claudeContinuations.ts";
import { hydrateClaudeFiles } from "./claudeFiles.ts";
import { sameClaudeReleaseArtifact } from "../../../../src/harnessReleases/ClaudeReleaseVariants.ts";

import type { ClaudeAuthorityBindings } from "./claudeAuthorities.ts";

export type ClaudeFacetEnvironment = QualifierEnvironment &
  ClaudeAuthorityBindings &
  HarnessCProductFacetEnvironment & {
    readonly HARNESS_PROCESS_LOADER_ID: string;
    readonly QUALIFIER_CLAUDE_VARIANT?: unknown;
  };

type Capability = QualifierCapabilities;
type SelectedRelease = {
  readonly artifact: HarnessReleaseArtifact;
  readonly release: LoadHarnessReleaseOptions;
};
type ClaudeProviderOptions = Omit<
  ProductClaudeHarnessHostOptions<unknown>,
  | "release"
  | "processResumeArtifact"
  | "programs"
  | "machineInventory"
  | "modelTransport"
  | "executor"
>;

export interface ClaudeFacetBuildInput {
  readonly env: ClaudeFacetEnvironment;
  readonly ctx: DurableObjectState;
  readonly facetNonce: string;
  readonly selectedRelease: SelectedRelease;
  readonly checkpoint?: HarnessCheckpoint;
  readonly filesCheckpoint?: HarnessFilesStoreResult;
}

const decodeTurn = Schema.decodeSync(Schema.fromJsonString(Schema.toCodecJson(RunnerTurn)));
const mcpLayer = McpProviderSessions.layer;
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new HarnessRequestFacetError("Claude product host options could not be built.", { cause }),
  });

export function claudeCapability(env: ClaudeFacetEnvironment): Capability {
  const supplied = env.HARNESS_C_PRODUCT_CAPABILITIES?.[HARNESS_C_PRODUCT_CAPABILITY_KEYS.release];
  assert(
    supplied &&
      typeof Reflect.get(supplied, "hostConfiguration") === "function" &&
      typeof Reflect.get(supplied, "append") === "function" &&
      typeof Reflect.get(supplied, "prepareClaudeIncarnation") === "function",
    "Claude qualification capability methods are missing",
  );
  return supplied as unknown as Capability;
}

function claudeContinuationCapability(env: ClaudeFacetEnvironment): ClaudeContinuationCapability {
  const supplied = env.HARNESS_C_PRODUCT_CAPABILITIES?.["claudeContinuationPublisher"];
  const candidate = supplied as unknown as
    | { readonly authority?: unknown; readonly publishContinuation?: unknown }
    | undefined;
  assert(
    typeof candidate?.publishContinuation === "function",
    "The disposable Claude continuation fixture is required",
  );
  return supplied as unknown as ClaudeContinuationCapability;
}

function assertClaudeMcpAuthorities(env: ClaudeFacetEnvironment) {
  const access = env.CLAUDE_ACCESS as unknown as Record<string, unknown> | undefined;
  const executor = env.CLAUDE_EXECUTOR as unknown as Record<string, unknown> | undefined;
  assert(
    typeof access?.resolveInitialAccess === "function" &&
      typeof access.resolveTurnAccess === "function",
    "The disposable Claude access fixture is required for MCP",
  );
  assert(typeof executor?.forward === "function", "The local Claude MCP fixture is required");
}

function commandLoader(env: ClaudeFacetEnvironment): ChildWorkerLoaderPort {
  const supplied = env.HARNESS_C_PRODUCT_CAPABILITIES?.["qualifierCommands"];
  assert(
    supplied && typeof Reflect.get(supplied, "run") === "function",
    "Actual command loader is missing",
  );
  return supplied as unknown as ChildWorkerLoaderPort;
}

export async function claudeConfiguration(env: ClaudeFacetEnvironment) {
  const cap = claudeCapability(env);
  const host = await cap.hostConfiguration();
  const assets = env.PROGRAM_ASSETS;
  assert(assets, "Claude qualification has no public program asset binding");
  const raw = await readConfiguration(assets, env.CONFIG_SHA256);
  const variant: unknown = env.QUALIFIER_CLAUDE_VARIANT;
  assert(variant === "baseline" || variant === "hooks", "Claude runtime variant is missing");
  const runtime = raw.claude.runtime;
  const claude = decodeClaudeFacetConfiguration({
    ...runtime,
    turnJson: runtime.turnJson[variant],
    seed: runtime.seed,
  });
  assert(host.runId === env.RUN_ID, "Claude qualifier run identity changed");
  return { host, claude };
}

export const buildClaudeFacetHostOptions = (input: ClaudeFacetBuildInput) =>
  Effect.gen(function* () {
    const { host, claude } = yield* attempt(() => claudeConfiguration(input.env));
    const restored = input.filesCheckpoint?.files;
    assert(
      (input.checkpoint === undefined) === (restored === undefined),
      "Claude native and file restore inputs must be supplied together",
    );
    assert(
      restored === undefined || restored.length > 0,
      "Claude restored files checkpoint is empty",
    );
    assert(claude.turnJson[0], "Claude qualification turn input is missing");
    const turn = decodeTurn(claude.turnJson[0]);
    assert(
      turn.providerThread.nativeThreadRef === null,
      "Claude qualification templates must be unbound until public creation",
    );
    const nativeSessionId = input.checkpoint?.snapshot.providerThread.nativeThreadRef?.nativeId;
    assert(
      input.checkpoint === undefined || nativeSessionId,
      "Claude restored checkpoint has no native identity",
    );
    assert(
      turn.providerThread.driver === "claudeAgent" &&
        turn.modelSelection.model === claude.workload.model,
      "Claude workload provider or model differs from its turn input",
    );
    assert(
      input.selectedRelease.artifact.provider === "claude-code",
      "Claude host selected another provider",
    );
    assertClaudeMcpAuthorities(input.env);
    const cap = claudeCapability(input.env);
    const inputs: ClaudeQualificationInputs = yield* attempt(() =>
      readClaudeQualificationInputs(claude, input.env.PROGRAM_ASSETS!),
    );
    const variant = sameClaudeReleaseArtifact(
      inputs.releaseVariants.catalog.baseline.fullArtifact,
      input.selectedRelease.artifact,
    )
      ? "baseline"
      : sameClaudeReleaseArtifact(
            inputs.releaseVariants.catalog.hooks.fullArtifact,
            input.selectedRelease.artifact,
          )
        ? "hooks"
        : undefined;
    assert(variant, "Claude host selected a release outside the frozen pair");
    yield* attempt(() =>
      cap.prepareClaudeIncarnation({
        incarnation: input.facetNonce,
        loaderId: input.env.HARNESS_PROCESS_LOADER_ID,
        ...(nativeSessionId && input.filesCheckpoint
          ? {
              kind: "restored" as const,
              nativeSessionId,
              checkpointId: input.filesCheckpoint.checkpoint.checkpointId,
              manifestSha256: input.filesCheckpoint.checkpoint.manifestSha256,
            }
          : { kind: "fresh" as const }),
        variant,
      }),
    );
    const selectedRelease = yield* attempt(() =>
      loadClaudeQualificationRelease(inputs, input.selectedRelease.artifact),
    );
    const plan = selectedRelease.plan;

    const state = facetState(input.ctx, cap, input.facetNonce);
    const paths = claudeSeedPaths(claude.seed);
    const imports = createClaudePreparedImports();
    const mcpSessions = yield* Effect.gen(function* () {
      return yield* McpProviderSessions.McpProviderSessions;
    }).pipe(Effect.provide(mcpLayer));
    const systemIdentity = claudeSystemIdentity(turn.threadId);
    const machine = () => ({
      files: {
        current: () => ({
          generation: null,
          generationAbsent: true as const,
          pristine: true,
          imageDigest: host.imageDigest,
        }),
        markExecuted: async () => {
          throw new Error("Claude qualifier has no machine generation");
        },
        lookup: async () => {
          throw new Error("Claude qualifier excludes live machine file access");
        },
      },
      spawn: async () => {
        throw new Error("Claude qualifier excludes machine command forwarding");
      },
    });
    const preparedModuleCount = Object.keys(plan.preparedModules).length;

    const observation = claudeQualificationToolObservation({
      variant,
      incarnation: input.facetNonce,
      capability: cap,
      state,
    });
    const native: ProductClaudeHarnessHostOptions<unknown>["native"] = {
      harness: "claude-code",
      ...(observation === undefined ? {} : { toolObservation: observation }),
      adapter: ({ harness }) =>
        buildClaudeAdapter({
          files: harness.computer.files,
          instanceId: harness.session.modelSelection.instanceId,
          attachmentsDir: `${paths.home}/.attachments`,
        }),
      mcpSessions,
      loadSdk: async (_bridge, signal) => await imports.loadSdk(plan, signal),
      process: {
        identity: claudeNodeRuntimeIdentity(paths.home),
        env: { HOME: paths.home, PATH: "/bin:/usr/bin", TMPDIR: "/tmp", LANG: "C", LC_ALL: "C" },
        nativeModules: DEFAULT_NODE_NATIVE_MODULES,
        loadPackages: async (_bridge, signal) => await imports.loadPackages(plan, signal),
        loadRelease: async (_bridge, signal) => await imports.loadRelease(plan, signal),
        bun: {
          main: `/release/${plan.main.module}`,
          version: plan.cli.version,
          revision: input.selectedRelease.artifact.sourceIdentity,
        },
      },
    };

    return {
      threadId: turn.threadId,
      continuations: createClaudeContinuationPublisher(claudeContinuationCapability(input.env)),
      releaseVariants: inputs.releaseVariants,
      native,
      files: {
        identity: state.files.identity,
        database: state.files.database,
        nowNs: state.files.nowNs,
        persistencePorts: createMemoryFilePersistencePorts(),
        rootMetadata: state.files.rootMetadata,
        posix: state.files.posix,
        cwd: paths.cwd,
        assetMode: state.files.assetMode,
      },
      commands: {
        loader: commandLoader(input.env),
        capacity: new ChildWorkerCapacity(2, {
          owner: `qualifier/claude/${host.runId}/${input.facetNonce}`,
          RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
        }),
        systemIdentity,
        machine,
      },
      observeInput: (bytes: Uint8Array) => state.raw("native-stdin", bytes),
      observeOutput: (fd: number, bytes: Uint8Array) =>
        state.raw(fd === 1 ? "native-stdout" : "native-stderr", bytes),
      hydrate: hydrateClaudeFiles({
        state,
        cap,
        paths,
        turn,
        restored,
        nativeSessionId,
        incarnation: input.facetNonce,
        preparedModuleCount,
        artifactHash: input.selectedRelease.artifact.artifactHash,
      }),
      save: async () => ({ commit: `claude-snapshot-${input.facetNonce}` }),
      port: async () => {
        throw new Error("Claude qualifier excludes network ports");
      },
    } satisfies ClaudeProviderOptions;
  });
