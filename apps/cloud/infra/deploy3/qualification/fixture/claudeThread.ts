import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RunnerTurn } from "@signalbox/runner-protocol/RunnerProtocol";
import {
  narrowHarnessCProductCapabilities,
  productExecutor,
  productProgramBindings,
  productReleaseBindings,
} from "../../../../src/harness/HarnessCProductCapabilities.ts";
import { HarnessError, serializeHarnessFailure } from "../../../../src/harness/Harness.ts";
import { selectHarnessCProductRelease } from "../../../../src/harness/HarnessCProductRelease.ts";
import {
  createLocalClaudeThreadObject,
  type LocalClaudeThreadMachineFactory,
} from "../../../../src/thread/LocalClaudeThreadObject.ts";
import type { ProductClaudeThreadMachine } from "../../../../src/thread/ProductClaudeThreadHost.ts";
import { readRpcData } from "../../../../src/rpc/Resources.ts";
import { createQualifierClaudeFacetEnvironment } from "../claudeFacetEnvironment.ts";
import { createQualifierShardEnvironment } from "../shardEnvironment.ts";
import { requireClaudeAuthorities } from "./claudeAuthorities.ts";
import { readClaudeQualificationInputs } from "./claudeConfiguration.ts";
import { readMachineInventory } from "./configuration.ts";
import {
  CLAUDE_OWNER_COMPATIBILITY,
  claudeOwnerCode,
  claudeOwnerRuntime,
  openClaudeOwnerRelease,
} from "./claudeOwnerCode.ts";
import { assertQualifierClaudeOwnerConfiguration } from "../facetEnvironmentContract.ts";
import { claudeCapability, claudeOwnerConfiguration } from "./claudeRuntimeEnvironment.ts";
import { claudeNodeRuntimeIdentity, claudeSeedPaths, claudeSystemIdentity } from "./claudeSeed.ts";
import { claudeQualificationToolObservation } from "./claudeToolObservation.ts";
import { assert } from "./common.ts";
import { proof, type QualifierEnvironment } from "./environment.ts";
import { facetState } from "./facetState.ts";

export const CLAUDE_THREAD_VARIANT = "baseline";
const decodeTurn = Schema.decodeSync(Schema.fromJsonString(Schema.toCodecJson(RunnerTurn)));
const attempt = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new HarnessError({ operation: "open", message, cause }),
  });

/** The template turn fixes the thread and model the qualifier's seed and model peer expect. */
export function claudeThreadTemplate(inputs: {
  readonly runtime: { readonly turnJson: Record<typeof CLAUDE_THREAD_VARIANT, readonly string[]> };
}) {
  const template = inputs.runtime.turnJson[CLAUDE_THREAD_VARIANT][0];
  assert(template, "Claude qualification turn input is missing");
  return decodeTurn(template);
}

/**
 * The product's own thread machine inputs. Owners are this thread's facets, built by its own
 * loader: no owner stub is ever placed in another Worker's environment.
 */
const claudeThreadMachine: LocalClaudeThreadMachineFactory<
  QualifierEnvironment,
  unknown,
  HarnessError
> = (ctx, env, configuration) =>
  Effect.gen(function* () {
    const cap = proof(env);
    const variant = CLAUDE_THREAD_VARIANT;
    const inputs = yield* attempt("The Claude thread inputs are unavailable", () =>
      readRpcData(cap.claudeThreadInputs(variant)),
    );
    const authorities = requireClaudeAuthorities(env);
    // The same product capabilities, with the disposable access and executor fixtures, that C
    // uses. Decoding names any missing capability before an owner or the host relies on it.
    const ownerEnv = yield* Effect.try({
      try: () =>
        assertQualifierClaudeOwnerConfiguration({
          ...createQualifierClaudeFacetEnvironment(
            {
              HARNESS_C_PRODUCT_CAPABILITIES: createQualifierShardEnvironment(env, env.LOADER, cap)
                .HARNESS_C_PRODUCT_CAPABILITIES,
            },
            { RUN_ID: env.RUN_ID, CONFIG_SHA256: env.CONFIG_SHA256, runtime: inputs.runtime },
            variant,
            authorities,
          ),
          HARNESS_C_TARGET_PREPARED_RELEASE: inputs.expected,
        }),
      catch: (cause) =>
        new HarnessError({
          operation: "open",
          message: "The Claude owner environment is incomplete",
          cause,
        }),
    });
    const capability = claudeCapability(ownerEnv);
    const capabilities = narrowHarnessCProductCapabilities<unknown>(
      ownerEnv.HARNESS_C_PRODUCT_CAPABILITIES,
    );
    // Access stays valid while this thread's machine is open, and ends with it.
    const lifetime = yield* Effect.abortSignal;
    let accessAttempts = 0;
    const { claude, processEnvironment } = yield* attempt(
      "The Claude thread configuration is invalid",
      () => claudeOwnerConfiguration(ownerEnv),
    );
    const turn = decodeTurn(claude.turnJson[0]!);
    assert(configuration.threadId === turn.threadId, "The Claude thread differs from its template");
    assert(
      configuration.modelSelection.model === claude.workload.model,
      "The Claude thread model differs from its workload",
    );
    const qualification = yield* attempt("The Claude release variants are unavailable", () =>
      readClaudeQualificationInputs(claude, env.PROGRAM_ASSETS),
    );
    const selected = yield* attempt("The Claude release could not be selected", async () =>
      selectHarnessCProductRelease({
        provider: "claude-code",
        preparedReleaseId: inputs.expected.artifact.releaseId,
        expected: inputs.expected,
        bindings: await productReleaseBindings("claude-code", capabilities.release),
      }),
    );
    const programs = yield* attempt("The Claude program seed is unavailable", () =>
      productProgramBindings("claude-code", capabilities.programs),
    );
    // Deployed, pulling this 16,880-entry inventory from the proof object took about 30 seconds.
    const machineInventory = yield* attempt("The Claude machine inventory is unavailable", () =>
      readMachineInventory(env.PROGRAM_ASSETS, inputs.machineInventory),
    );
    const release = yield* attempt("The Claude owner release could not open", () =>
      openClaudeOwnerRelease(inputs.expected, inputs, env.PROGRAM_ASSETS),
    );
    const incarnation = `thread:${configuration.threadId}`;
    const state = facetState(ctx, capability, incarnation);
    const paths = claudeSeedPaths(claude.seed);
    const code = claudeOwnerCode({
      compatibility: CLAUDE_OWNER_COMPATIBILITY,
      release,
      sources: {
        kernel: () => readRpcData(cap.claudeOwnerSource("kernel")),
        cli: () => readRpcData(cap.claudeOwnerSource("cli")),
        computer: () => readRpcData(cap.claudeOwnerSource("computer")),
        sdk: () => readRpcData(cap.claudeOwnerSource("sdk")),
      },
      kernelEnv: ownerEnv,
      commands: env.QUALIFIER_COMMANDS,
    });
    const observation = claudeQualificationToolObservation({
      variant,
      incarnation,
      capability,
      state,
    });
    const host: ProductClaudeThreadMachine<unknown>["host"] = {
      threadId: configuration.threadId,
      release: selected.release,
      processResumeArtifact: selected.artifact,
      releaseVariants: qualification.releaseVariants,
      programs: { codes: programs.codes, seed: programs.seed },
      machineInventory,
      executor: productExecutor(capabilities.executor),
      // The thread object replaces this with its pool's transport.
      modelTransport: async () => {
        throw new Error("The Claude thread's pool supplies its model transport");
      },
      files: {
        identity: state.files.identity,
        database: state.files.database,
        rootMetadata: state.files.rootMetadata,
        posix: state.files.posix,
        cwd: paths.cwd,
        assetMode: state.files.assetMode,
      },
      admission: { limit: 2, path: ["/bin", "/usr/bin"] },
      runtime: claudeOwnerRuntime({
        loader: env.LOADER,
        facets: ctx.facets,
        code,
        versions: inputs.versions,
        tail: env.QUALIFIER_TAIL,
      }),
      native: {
        ...(observation === undefined ? {} : { toolObservation: observation }),
        workingSet: claude.workingSet,
        reportCliStartupFailure: (cause) =>
          state.queue(() =>
            readRpcData(
              cap.append("claude-cli-startup-failure", {
                incarnation,
                failure: serializeHarnessFailure(cause),
              }),
            ),
          ),
        process: {
          systemIdentity: claudeSystemIdentity(turn.threadId),
          identity: claudeNodeRuntimeIdentity(paths.home),
          // The facet host adds the model gateway's scoped environment per opened machine.
          env: {
            HOME: paths.home,
            PATH: "/bin:/usr/bin",
            TMPDIR: "/tmp",
            LANG: "C",
            LC_ALL: "C",
            ...processEnvironment,
          },
          bun: {
            main: `/release/${release.plan.main.module}`,
            version: release.plan.cli.version,
            revision: inputs.expected.artifact.sourceIdentity,
          },
        },
      },
    };
    return {
      host,
      open: (work) => {
        assert(work.turn, "The Claude thread opened without a turn");
        return {
          session: {
            threadId: work.turn.threadId,
            providerSessionId:
              work.turn.providerThread.providerSessionId ?? turn.providerThread.providerSessionId!,
            modelSelection: work.turn.modelSelection,
            runtimePolicy: {
              cwd: claude.seed.cwd,
              runtimeMode: "full-access" as const,
              interactionMode: "default" as const,
            },
          },
          bootAttemptId: `claude-thread-${work.turn.runId}`,
        };
      },
      access: (work) =>
        Effect.tryPromise({
          try: async () => {
            assert(work.turn, "The Claude thread's access has no turn");
            lifetime.throwIfAborted();
            const access = await readRpcData(
              authorities.access.resolveTurnAccess({
                threadId: work.turn.threadId,
                runId: work.turn.runId,
                requestId: `${work.turn.runId}:access-${++accessAttempts}`,
              }),
            );
            return { ...access, signal: lifetime };
          },
          catch: (cause) =>
            new HarnessError({
              operation: "open",
              message: "The Claude turn access is unavailable",
              cause,
            }),
        }),
    } satisfies ProductClaudeThreadMachine<unknown>;
  });

/** The product's static thread object; the qualifier supplies only its machine inputs. */
export const QualifierClaudeThread = createLocalClaudeThreadObject<QualifierEnvironment, unknown>(
  claudeThreadMachine,
);
