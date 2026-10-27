import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { HarnessReleaseArtifact } from "../../harnessReleases/HarnessReleaseLedger.ts";
import type { HarnessRequestFacetPreparationEvidence } from "../HarnessRequestFacet.ts";
import type { HarnessRequestCheckpoint } from "../HarnessRunStore.ts";
import type { HarnessRequestTurnOptions } from "../HarnessRequestTurn.ts";
import type { HarnessProcessResumePreparedRelease } from "../HarnessProcessResume.ts";
import type { HarnessThreadSupervisorPublisher } from "../HarnessThreadSupervisor.ts";
import type { HarnessError } from "../Harness.ts";
import type { HostOpenInput } from "../HarnessSessionHost.ts";
import type { ProductHostOptions, ProductHarnessSessionHost } from "../host/product.ts";
import { HarnessRequestFacetError } from "../HarnessRequestFacet.ts";
import { createHarnessRequestTurnRuntime } from "../HarnessRequestTurn.ts";
import { readHarnessCProductFilesCheckpoint } from "./filesCheckpoint.ts";
import { materializeHarnessCProductFiles } from "./materializeFiles.ts";
import { decodeHarnessCProductNativeCheckpoint } from "./nativeCheckpoint.ts";
import {
  productMachineInventory,
  productModelTransport,
  productProgramBindings,
  productReleaseBindings,
} from "./capabilities.ts";
import { productExecutor } from "./executor.ts";
import { selectHarnessCProductRelease } from "./selectedArtifact.ts";
import type {
  HarnessCProductFacetEnvironment,
  HarnessCProductHostPreparationInput,
  PreparedHarnessCProductHost,
} from "./facetContracts.ts";

type OpenInput<
  Env extends HarnessCProductFacetEnvironment,
  G,
  Native,
  Options extends ProductHostOptions<G, Native> & {
    readonly processResumeArtifact?: HarnessReleaseArtifact;
  },
  Host extends ProductHarnessSessionHost<G> & {
    readonly loadedPreparedRelease: () => HarnessProcessResumePreparedRelease;
  },
> = HarnessCProductHostPreparationInput<Env, G, Native, Options, Host> & {
  readonly checkpointRefs: HarnessRequestCheckpoint;
  readonly publisher: HarnessThreadSupervisorPublisher;
  readonly checkpointId: string;
  readonly manifestRevision: string;
  readonly nativeSessionId: string;
  readonly signal: AbortSignal;
};

export function prepareHarnessCProductHost<
  Env extends HarnessCProductFacetEnvironment,
  G,
  Native,
  Options extends ProductHostOptions<G, Native> & {
    readonly processResumeArtifact?: HarnessReleaseArtifact;
  },
  Host extends ProductHarnessSessionHost<G> & {
    readonly loadedPreparedRelease: () => HarnessProcessResumePreparedRelease;
  },
>(
  input: OpenInput<Env, G, Native, Options, Host>,
): Effect.Effect<PreparedHarnessCProductHost<Host>, HarnessRequestFacetError, Scope.Scope> {
  return Effect.gen(function* () {
    const { checkpointRefs, publisher, checkpointId, manifestRevision, nativeSessionId } = input;
    if (
      checkpointRefs.native.id !== checkpointId ||
      checkpointRefs.filesystem.sha256 !== manifestRevision
    )
      return yield* Effect.fail(
        failed("Request checkpoint differs from the C checkpoint identity."),
      );
    const releaseBindings = yield* Effect.tryPromise({
      try: () => productReleaseBindings(input.factory.provider, input.capabilities.release),
      catch: (cause) => failed("The product release source could not be prepared.", cause),
    });
    const selected = yield* Effect.tryPromise({
      try: () =>
        selectHarnessCProductRelease({
          provider: input.factory.provider,
          preparedReleaseId: input.descriptor.preparedReleaseId,
          expected: input.expected,
          bindings: releaseBindings,
        }),
      catch: (cause) => failed("The selected product release could not be prepared.", cause),
    });
    const nativeBytes = yield* Effect.tryPromise({
      try: () => input.capabilities.nativeCheckpoint.read(checkpointRefs.native),
      catch: (cause) => failed("A's native checkpoint bytes could not be read.", cause),
    });
    const native = yield* Effect.tryPromise({
      try: () =>
        decodeHarnessCProductNativeCheckpoint({
          reference: checkpointRefs.native,
          expectedNativeSessionId: nativeSessionId,
          bytes: nativeBytes,
        }),
      catch: (cause) => failed("A's native checkpoint is invalid.", cause),
    });
    const files = yield* Effect.tryPromise({
      try: () =>
        readHarnessCProductFilesCheckpoint({
          store: input.resume.filesStore,
          runId: input.runId,
          publisher,
          checkpointId,
          manifestRevision,
        }),
      catch: (cause) => failed("A's committed files checkpoint could not be read.", cause),
    });
    const programs = yield* Effect.tryPromise({
      try: () => productProgramBindings(input.factory.provider, input.capabilities.programs),
      catch: (cause) => failed("The provider program seed could not be prepared.", cause),
    });
    const machineInventory = yield* Effect.tryPromise({
      try: () => productMachineInventory(input.factory.provider, input.capabilities.machine),
      catch: (cause) => failed("The provider machine inventory could not be prepared.", cause),
    });
    const providerOptions = yield* input.factory.buildHostOptions({
      env: input.env,
      ctx: input.ctx,
      facetNonce: input.facetNonce,
      capabilities: input.capabilities,
      selectedRelease: selected,
      checkpoint: native.checkpoint,
      filesCheckpoint: files,
    });
    const built = {
      ...providerOptions,
      programs: { codes: programs.codes, seed: programs.seed },
      machineInventory,
      modelTransport: productModelTransport(input.capabilities.model),
      executor: productExecutor(input.capabilities.executor),
    } as Omit<Options, "release" | "processResumeArtifact">;
    if (built.threadId.length === 0)
      return yield* Effect.fail(failed("Product host thread identity is missing."));
    const threadId = ThreadId.make(built.threadId);
    yield* Effect.try({
      try: () =>
        materializeHarnessCProductFiles({
          files: built.files,
          threadId: built.threadId,
          checkpoint: files,
        }),
      catch: (cause) => failed("A's filesystem checkpoint could not be materialized.", cause),
    });
    const options = {
      ...built,
      release: selected.release,
      processResumeArtifact: selected.artifact,
    } as Options;
    const host = yield* input.factory
      .createHost(options)
      .pipe(
        Effect.mapError((cause: HarnessError) =>
          failed("The product host could not be constructed.", cause),
        ),
      );
    yield* Effect.addFinalizer(() =>
      host.dispose.pipe(
        Effect.catchCause((cause) =>
          Effect.die(failed("The product host could not close.", cause)),
        ),
      ),
    );
    yield* host
      .seed("assets")
      .pipe(
        Effect.mapError((cause: HarnessError) =>
          failed("Product assets could not be seeded.", cause),
        ),
      );
    yield* host
      .seed("programs")
      .pipe(
        Effect.mapError((cause: HarnessError) =>
          failed("Product programs could not be seeded.", cause),
        ),
      );
    const open = yield* input.factory.buildOpenInput({
      env: input.env,
      checkpoint: native.checkpoint,
      nativeSessionId,
      restoreMode: input.descriptor.restoreMode,
    });
    if (
      open.session.threadId !== threadId ||
      open.session.initialNativeThreadId !== nativeSessionId
    )
      return yield* Effect.fail(
        failed("The product open input changes the committed session identity."),
      );
    let openInput: HostOpenInput<G> = open;
    if (input.descriptor.restoreMode === "same-variant-serialized-checkpoint") {
      if (native.checkpoint.release.harness !== input.factory.provider)
        return yield* Effect.fail(failed("Serialized checkpoint belongs to another provider."));
      const access = yield* Effect.tryPromise({
        try: () =>
          input.capabilities.access.resolveInitialAccess({
            threadId,
            providerSessionId: native.checkpoint.providerSession.id,
            nativeSessionId,
          }),
        catch: (cause) => failed("Initial product access could not be resolved.", cause),
      });
      openInput = {
        ...open,
        checkpoint: native.checkpoint,
        initialAccess: { ...access, signal: input.signal },
      };
    }
    const session = yield* host
      .open(openInput)
      .pipe(
        Effect.mapError((cause: HarnessError) =>
          failed("The product session could not be opened inertly.", cause),
        ),
      );
    const requestTurnOptions: Omit<HarnessRequestTurnOptions<G>, "restore"> = {
      readInput: (reference, context) =>
        Effect.gen(function* () {
          const turn = yield* input.turnBindings.readTurn(reference, context);
          const access = yield* Effect.tryPromise({
            try: () =>
              input.capabilities.access.resolveTurnAccess({
                threadId,
                runId: input.runId,
                requestId: context.requestId,
              }),
            catch: (cause) => failed("Turn access could not be resolved.", cause),
          });
          return { turn, access: { ...access, signal: context.signal } };
        }),
      onEvent: input.turnBindings.onEvent,
      writeResult: input.turnBindings.writeResult,
      writeCheckpoint: input.turnBindings.writeCheckpoint,
      verify: input.turnBindings.verify,
    };
    const runtime = yield* createHarnessRequestTurnRuntime(requestTurnOptions, session);
    const evidence: HarnessRequestFacetPreparationEvidence = {
      facetNonce: input.facetNonce,
      nativeSessionId,
      checkpoint: checkpointRefs,
      manifestRevision,
      joined: { invocationRpc: true, fetch: true, ports: true },
      runtime,
    };
    return { host, evidence, runtime };
  });
}

function failed(message: string, cause?: unknown) {
  return new HarnessRequestFacetError(message, cause === undefined ? undefined : { cause });
}
