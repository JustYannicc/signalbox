import {
  claudeCapability,
  claudeConfiguration,
  type ClaudeFacetEnvironment,
} from "./claudeRuntimeEnvironment.ts";
export {
  claudeCapability,
  claudeConfiguration,
  type ClaudeFacetEnvironment,
} from "./claudeRuntimeEnvironment.ts";
import { readRpcData } from "../../../../src/rpc/Resources.ts";
// @effect-diagnostics cryptoRandomUUID:off - Snapshot IDs are local qualification evidence.
import { claudeQualificationToolObservation } from "./claudeToolObservation.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import { HarnessRequestFacetError } from "../../../../src/harness/HarnessRequestFacet.ts";
import type { ProductClaudeKernelHostOptions } from "../../../../src/harness/ProductClaudeKernelHost.ts";
import {
  serializeHarnessFailure,
  type HarnessCheckpoint,
} from "../../../../src/harness/Harness.ts";
import type { HarnessFilesStoreResult } from "../../../../src/harness/HarnessFilesStore.ts";
import type { HarnessReleaseArtifact } from "../../../../src/harnessReleases/HarnessReleaseLedger.ts";
import type { LoadHarnessReleaseOptions } from "../../../../src/harness/HarnessReleaseLoader.ts";
import { facetState } from "./facetState.ts";
import { assert } from "./common.ts";
import {
  loadClaudeQualificationRelease,
  readClaudeQualificationInputs,
  type ClaudeQualificationInputs,
} from "./claudeConfiguration.ts";
import { claudeNodeRuntimeIdentity, claudeSeedPaths, claudeSystemIdentity } from "./claudeSeed.ts";
import {
  createClaudeContinuationPublisher,
  type ClaudeContinuationCapability,
} from "./claudeContinuations.ts";
import { sameClaudeReleaseArtifact } from "../../../../src/harnessReleases/ClaudeReleaseVariants.ts";
import { claudeGatewayEnvironment } from "../../../../src/harness/ClaudeGatewayAccess.ts";

type SelectedRelease = {
  readonly artifact: HarnessReleaseArtifact;
  readonly release: LoadHarnessReleaseOptions;
};
type ClaudeProviderOptions = Omit<
  ProductClaudeKernelHostOptions<unknown>,
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
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new HarnessRequestFacetError("Claude product host options could not be built.", { cause }),
  });

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

export const buildClaudeFacetHostOptions = (input: ClaudeFacetBuildInput) =>
  Effect.gen(function* () {
    const { claude, processEnvironment } = yield* attempt(() => claudeConfiguration(input.env));
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
      readRpcData(
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
      ),
    );
    const gatewayAccess = yield* attempt(() =>
      readRpcData(cap.claudeGatewayAccess({ incarnation: input.facetNonce, variant })),
    );
    const gatewayEnvironment = yield* Effect.try({
      try: () => claudeGatewayEnvironment(gatewayAccess),
      catch: (cause) =>
        new HarnessRequestFacetError("Claude model gateway access is invalid", { cause }),
    });
    const selectedRelease = yield* attempt(() =>
      loadClaudeQualificationRelease(inputs, input.selectedRelease.artifact),
    );
    const plan = selectedRelease.plan;

    const state = facetState(input.ctx, cap, input.facetNonce);
    const paths = claudeSeedPaths(claude.seed);
    const systemIdentity = claudeSystemIdentity(turn.threadId);

    const observation = claudeQualificationToolObservation({
      variant,
      incarnation: input.facetNonce,
      capability: cap,
      state,
    });
    assert(
      claude.workingSet !== undefined,
      "Claude sync working-set policy must be supplied before launch",
    );
    const native: ProductClaudeKernelHostOptions<unknown>["native"] = {
      ...(observation === undefined ? {} : { toolObservation: observation }),
      sdkHost: input.env.CLAUDE_SDK_HOST,
      cliHost: input.env.CLAUDE_CLI,
      workingSet: claude.workingSet,
      reportCliStartupFailure: (cause) =>
        state.queue(() =>
          readRpcData(
            cap.append("claude-cli-startup-failure", {
              incarnation: input.facetNonce,
              failure: serializeHarnessFailure(cause),
            }),
          ),
        ),
      process: {
        systemIdentity,
        identity: claudeNodeRuntimeIdentity(paths.home),
        env: {
          HOME: paths.home,
          PATH: "/bin:/usr/bin",
          TMPDIR: "/tmp",
          LANG: "C",
          LC_ALL: "C",
          ...processEnvironment,
          ...gatewayEnvironment,
        },
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
        rootMetadata: state.files.rootMetadata,
        posix: state.files.posix,
        cwd: paths.cwd,
        assetMode: state.files.assetMode,
      },
      sessionKey: input.facetNonce,
      ...(nativeSessionId === undefined || nativeSessionId === null ? {} : { nativeSessionId }),
      kernel: input.env.CLAUDE_KERNEL,
      commands: input.env.COMPUTER_EXECUTION,
      admission: { limit: 2, path: ["/bin", "/usr/bin"] },
    } satisfies ClaudeProviderOptions;
  });
