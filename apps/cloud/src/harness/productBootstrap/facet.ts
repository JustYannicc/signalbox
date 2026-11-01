import { readRpcData } from "../../rpc/Resources.ts";
import * as Effect from "effect/Effect";
import type {
  HarnessCProductBootstrapDescriptor,
  HarnessProcessResumePreparedRelease,
} from "../HarnessProcessResume.ts";
import type { HarnessFilesStoreObject } from "../HarnessFilesStoreObject.ts";
import type { HarnessRequestFacetOptions } from "../HarnessRequestFacet.ts";
import type { HarnessRequestCheckpoint } from "../HarnessRunStore.ts";
import type { HarnessRunStoreObject } from "../HarnessRunStoreObject.ts";
import type { HarnessThreadSupervisorPublisher } from "../HarnessThreadSupervisor.ts";
import type { HarnessThreadSupervisorObject } from "../HarnessThreadSupervisorObject.ts";
import { HarnessRequestFacetError } from "../HarnessRequestFacet.ts";
import { narrowHarnessCProductCapabilities } from "./capabilities.ts";
import type {
  HarnessCProductFacetEnvironment,
  HarnessCProductFacetFactory,
  HarnessCProductResumeBindings,
} from "./facetContracts.ts";
import { prepareHarnessCProductHost } from "./prepareProductHost.ts";
import { prepareFreshHarnessCProductHost } from "./prepareFreshProductHost.ts";

/** Builds the facet-local product bootstrap behind one provider-specific public entry. */
export function composeHarnessCProductFacetOptions<
  Env extends HarnessCProductFacetEnvironment,
  G,
  Native,
  Options extends import("../host/product.ts").ProductHostOptions<G, Native> & {
    readonly processResumeArtifact?: import("../../harnessReleases/HarnessReleaseLedger.ts").HarnessReleaseArtifact;
  },
  Host extends import("../host/product.ts").ProductHarnessSessionHost<G> & {
    readonly loadedPreparedRelease: () => HarnessProcessResumePreparedRelease;
  },
>(
  input: { readonly ctx: DurableObjectState; readonly env: Env; readonly facetNonce: string },
  factory: HarnessCProductFacetFactory<Env, G, Native, Options, Host>,
): Effect.Effect<HarnessRequestFacetOptions, HarnessRequestFacetError> {
  return Effect.gen(function* () {
    const env = input.env;
    const runId = env.HARNESS_RESUME_RUN_ID;
    const descriptor = env.HARNESS_C_PRODUCT_BOOTSTRAP;
    const expected = env.HARNESS_C_TARGET_PREPARED_RELEASE;
    if (
      !input.facetNonce ||
      !runId ||
      descriptor === undefined ||
      expected === undefined ||
      descriptor.provider !== factory.provider ||
      !supportedRestoreMode(descriptor) ||
      descriptor.provider !== expected.artifact.provider ||
      descriptor.preparedReleaseId !== expected.artifact.releaseId
    )
      return yield* Effect.fail(
        failed("Product facet identity or bootstrap descriptor is invalid."),
      );

    let capabilities: ReturnType<typeof narrowHarnessCProductCapabilities<G>>;
    let resume: HarnessCProductResumeBindings;
    try {
      capabilities = narrowHarnessCProductCapabilities<G>(env.HARNESS_C_PRODUCT_CAPABILITIES);
      resume = narrowResumeBindings(env);
    } catch (cause) {
      return yield* Effect.fail(failed("Product bootstrap capabilities are incomplete.", cause));
    }
    const turnBindings = yield* factory.buildTurnBindings({ env, ctx: input.ctx, capabilities });
    let retainedHost: Host | undefined;
    const preparedRelease = () => {
      if (retainedHost === undefined) throw failed("Product host has not opened.");
      return retainedHost.loadedPreparedRelease();
    };

    const readNativeSessionId = (control = env.HARNESS_RESUME_CONTROL) =>
      Effect.tryPromise({
        try: async () => {
          const current = await readRpcData(
            resume.supervisor.execute({ type: "read", runId, control }),
          );
          if (!current.snapshot.nativeSessionId)
            throw new Error("The supervisor has no native session ID.");
          return current.snapshot.nativeSessionId;
        },
        catch: (cause) => failed("The active native session ID could not be read.", cause),
      });

    const prepare = (
      checkpointRefs: HarnessRequestCheckpoint,
      publisher: HarnessThreadSupervisorPublisher,
      checkpointId: string,
      manifestRevision: string,
      nativeSessionId: string,
      signal: AbortSignal,
    ) =>
      prepareHarnessCProductHost({
        env,
        ctx: input.ctx,
        facetNonce: input.facetNonce,
        runId,
        descriptor,
        expected,
        capabilities,
        resume,
        turnBindings,
        factory,
        checkpointRefs,
        publisher,
        checkpointId,
        manifestRevision,
        nativeSessionId,
        signal,
      });

    const open: HarnessRequestFacetOptions["open"] = (checkpoint, context) =>
      Effect.gen(function* () {
        const nativeSessionId = yield* readNativeSessionId();
        const opened = yield* prepare(
          checkpoint,
          context.publisher,
          checkpoint.native.id,
          checkpoint.filesystem.sha256,
          nativeSessionId,
          context.signal,
        );
        retainedHost = opened.host;
        return opened.runtime;
      });

    const prepareInert: NonNullable<HarnessRequestFacetOptions["prepareInert"]> = (request) =>
      Effect.gen(function* () {
        const publisher = env.HARNESS_RESUME_PUBLISHER;
        if (publisher === undefined)
          return yield* Effect.fail(failed("Prior publisher is required for inert restoration."));
        const saved = yield* Effect.tryPromise({
          try: () => readRpcData(resume.runStore.execute({ type: "read", runId })),
          catch: (cause) => failed("The committed RunStore checkpoint could not be read.", cause),
        });
        const checkpoint = saved.snapshot.requests?.checkpoint;
        if (
          checkpoint === undefined ||
          checkpoint.native.id !== request.checkpointId ||
          checkpoint.filesystem.sha256 !== request.manifestRevision
        )
          return yield* Effect.fail(
            failed("The RunStore checkpoint differs from inert preparation."),
          );
        const nativeSessionId = yield* readNativeSessionId();
        if (nativeSessionId !== request.nativeSessionId)
          return yield* Effect.fail(
            failed("The supervisor native session differs from inert preparation."),
          );
        const signal = yield* Effect.abortSignal;
        const opened = yield* prepare(
          checkpoint,
          publisher,
          request.checkpointId,
          request.manifestRevision,
          request.nativeSessionId,
          signal,
        );
        retainedHost = opened.host;
        return opened.evidence;
      });

    const startFresh: NonNullable<HarnessRequestFacetOptions["startFresh"]> = (request) =>
      Effect.gen(function* () {
        if (request.targetFacetNonce !== input.facetNonce)
          return yield* Effect.fail(
            failed("Fresh product facet identity does not match its request."),
          );
        const signal = yield* Effect.abortSignal;
        const opened = yield* prepareFreshHarnessCProductHost({
          env,
          ctx: input.ctx,
          targetFacetNonce: request.targetFacetNonce,
          operationId: request.operationId,
          publisherKey: request.publisherKey,
          signal,
          runId,
          descriptor,
          expected,
          capabilities,
          turnBindings,
          factory,
        });
        retainedHost = opened.host;
        return opened.evidence;
      });

    return {
      runId,
      facetNonce: input.facetNonce,
      store: resume.runStore,
      verify: (reference, purpose) => turnBindings.verify(reference, purpose),
      open,
      prepareInert,
      startFresh,
      loadedPreparedRelease: preparedRelease,
    };
  });
}

function narrowResumeBindings(env: HarnessCProductFacetEnvironment): HarnessCProductResumeBindings {
  return {
    runStore: narrowExecute(env.HARNESS_RESUME_RUN_STORE, "HARNESS_RESUME_RUN_STORE") as Pick<
      HarnessRunStoreObject,
      "execute"
    >,
    filesStore: narrowExecute(env.HARNESS_RESUME_FILES_STORE, "HARNESS_RESUME_FILES_STORE") as Pick<
      HarnessFilesStoreObject,
      "execute"
    >,
    supervisor: narrowExecute(env.HARNESS_RESUME_SUPERVISOR, "HARNESS_RESUME_SUPERVISOR") as Pick<
      HarnessThreadSupervisorObject,
      "execute"
    >,
  };
}

function narrowExecute(binding: Fetcher, name: string): object {
  const candidate = (binding as unknown as Record<string, unknown>).execute;
  if (typeof candidate !== "function")
    throw new Error("Required RPC method is missing: " + name + ".execute");
  return binding;
}

function supportedRestoreMode(descriptor: HarnessCProductBootstrapDescriptor): boolean {
  return (
    descriptor.restoreMode === "same-variant-serialized-checkpoint" ||
    descriptor.restoreMode === "cross-variant-fresh-boot"
  );
}

function failed(message: string, cause?: unknown) {
  return new HarnessRequestFacetError(message, cause === undefined ? undefined : { cause });
}
