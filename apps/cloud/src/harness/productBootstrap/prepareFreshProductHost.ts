import { validateInitialCheckpoint } from "./initialCheckpoint.ts";
import { createSeededProductHost } from "./seededHost.ts";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { HarnessReleaseArtifact } from "../../harnessReleases/HarnessReleaseLedger.ts";
import type { HarnessRequestFacetCreationEvidence } from "../HarnessRequestFacet.ts";
import type { HarnessProcessResumePreparedRelease } from "../HarnessProcessResume.ts";
import type { HarnessThreadSupervisorPublisher } from "../HarnessThreadSupervisor.ts";
import type { HarnessError } from "../Harness.ts";
import type { HostOpenInput } from "../HarnessSessionHost.ts";
import type { ProductHostOptions, ProductHarnessSessionHost } from "../host/product.ts";
import { prepareCheckpoint } from "../durableState/files/content.ts";
import { HarnessRequestFacetError } from "../HarnessRequestFacet.ts";
import { createHarnessCProductRequestRuntime } from "./requestRuntime.ts";
import { productReleaseBindings } from "./capabilities.ts";
import { selectHarnessCProductRelease } from "./selectedArtifact.ts";
import { validateHarnessCProductFiles } from "./filesCheckpoint.ts";
import type {
  HarnessCProductFacetEnvironment,
  HarnessCProductFreshHostPreparationInput,
  PreparedFreshHarnessCProductHost,
} from "./facetContracts.ts";

type ProductOptions<G, Native> = ProductHostOptions<G, Native> & {
  readonly processResumeArtifact?: HarnessReleaseArtifact;
};
type ProductHost<G> = ProductHarnessSessionHost<G> & {
  readonly loadedPreparedRelease: () => HarnessProcessResumePreparedRelease;
};

/** Retains the session opened by the provider's first native create for subsequent turns. */
export function prepareFreshHarnessCProductHost<
  Env extends HarnessCProductFacetEnvironment,
  G,
  Native,
  Options extends ProductOptions<G, Native>,
  Host extends ProductHost<G>,
>(
  input: HarnessCProductFreshHostPreparationInput<Env, G, Native, Options, Host>,
): Effect.Effect<PreparedFreshHarnessCProductHost<Host>, HarnessRequestFacetError, Scope.Scope> {
  return Effect.gen(function* () {
    const provider = input.factory.provider;
    const driver = provider === "claude-code" ? "claudeAgent" : "codex";
    if (
      input.descriptor.provider !== provider ||
      input.expected.artifact.provider !== provider ||
      input.descriptor.preparedReleaseId !== input.expected.artifact.releaseId
    )
      return yield* Effect.fail(
        new HarnessRequestFacetError(
          "Fresh product host provider does not match the selected release.",
        ),
      );

    const buildFreshHostOptions = input.factory.fresh?.buildHostOptions;
    const buildFreshOpenInput = input.factory.fresh?.buildOpenInput;
    const writeInitialCheckpoint = input.turnBindings.writeInitialCheckpoint;
    const resolveFreshAccess = input.capabilities.access.resolveFreshAccess;
    if (
      buildFreshHostOptions === undefined ||
      buildFreshOpenInput === undefined ||
      writeInitialCheckpoint === undefined ||
      resolveFreshAccess === undefined
    )
      return yield* Effect.fail(
        new HarnessRequestFacetError("Fresh product host creation bindings are incomplete."),
      );
    if (
      input.operationId.length === 0 ||
      input.targetFacetNonce.length === 0 ||
      input.publisherKey.length < 32 ||
      input.publisherKey.length > 128
    )
      return yield* Effect.fail(
        new HarnessRequestFacetError("Fresh product host creation identity is invalid."),
      );

    const publisher: HarnessThreadSupervisorPublisher = {
      generation: 1,
      facetNonce: input.targetFacetNonce,
      publisherKey: input.publisherKey,
    };
    const releaseBindings = yield* Effect.tryPromise({
      try: () => productReleaseBindings(input.factory.provider, input.capabilities.release),
      catch: (cause) =>
        new HarnessRequestFacetError("The product release source could not be prepared.", {
          cause,
        }),
    });
    const selected = yield* Effect.tryPromise({
      try: () =>
        selectHarnessCProductRelease({
          provider: input.factory.provider,
          preparedReleaseId: input.descriptor.preparedReleaseId,
          expected: input.expected,
          bindings: releaseBindings,
        }),
      catch: (cause) =>
        new HarnessRequestFacetError("The selected product release could not be prepared.", {
          cause,
        }),
    });
    const providerOptions = yield* buildFreshHostOptions({
      env: input.env,
      ctx: input.ctx,
      facetNonce: input.targetFacetNonce,
      capabilities: input.capabilities,
      selectedRelease: selected,
    });
    const { host, threadId } = yield* createSeededProductHost<G, Native, Options, Host>({
      input,
      selected,
      providerOptions,
      createHost: input.factory.createHost,
    });

    const open = yield* buildFreshOpenInput({ env: input.env, operationId: input.operationId });
    const creation = open.creation;
    if (
      creation === undefined ||
      creation.providerThread.nativeThreadRef !== null ||
      open.session.initialNativeThreadId !== undefined ||
      open.session.resumeFromSession !== undefined ||
      open.session.threadId !== threadId ||
      creation.providerThread.appThreadId !== threadId ||
      creation.providerThread.providerSessionId !== open.session.providerSessionId ||
      creation.providerThread.providerInstanceId !== open.session.modelSelection.instanceId ||
      creation.providerThread.driver !== driver ||
      open.bootAttemptId.length === 0
    )
      return yield* Effect.fail(
        new HarnessRequestFacetError(
          "Fresh product open input must contain an unbound thread for the selected provider.",
        ),
      );

    // Resolve authority using the provider session identity before native open creates its UUID.
    const access = yield* Effect.tryPromise({
      try: () =>
        resolveFreshAccess({
          threadId,
          providerSessionId: open.session.providerSessionId,
          operationId: input.operationId,
        }),
      catch: (cause) =>
        new HarnessRequestFacetError("Fresh product access could not be resolved.", { cause }),
    });
    const session = yield* host
      .open({
        ...open,
        creation,
        initialAccess: { ...access, signal: input.signal },
      } satisfies HostOpenInput<G>)
      .pipe(
        Effect.mapError(
          (cause: HarnessError) =>
            new HarnessRequestFacetError("The fresh product session could not be opened.", {
              cause,
            }),
        ),
      );
    yield* session.retireCheckpointAccess.pipe(
      Effect.mapError(
        (cause) =>
          new HarnessRequestFacetError(
            "Initial access could not be retired after fresh native creation.",
            { cause },
          ),
      ),
    );
    const checkpoint = yield* session.export().pipe(
      Effect.mapError(
        (cause) =>
          new HarnessRequestFacetError("The initial native checkpoint could not be exported.", {
            cause,
          }),
      ),
    );
    const nativeSessionId = yield* Effect.try({
      try: () =>
        validateInitialCheckpoint({
          checkpoint,
          session,
          provider: input.factory.provider,
          threadId,
          providerSessionId: open.session.providerSessionId,
          providerInstanceId: open.session.modelSelection.instanceId,
          creationThread: creation.providerThread,
        }),
      catch: (cause) =>
        new HarnessRequestFacetError("The initial native checkpoint identity is invalid.", {
          cause,
        }),
    });
    const written = yield* writeInitialCheckpoint(checkpoint, {
      operationId: input.operationId,
      publisher,
      signal: input.signal,
    });
    if (
      written.checkpoint.native.id !== written.filesCheckpoint.checkpointId ||
      written.filesCheckpoint.parentCheckpointId !== null
    )
      return yield* Effect.fail(
        new HarnessRequestFacetError(
          "Initial native and filesystem checkpoint identities do not match.",
        ),
      );
    yield* Effect.try({
      try: () => validateHarnessCProductFiles(written.filesCheckpoint.files),
      catch: (cause) =>
        new HarnessRequestFacetError("The initial filesystem checkpoint is invalid.", { cause }),
    });
    const preparedFiles = yield* Effect.tryPromise({
      try: () => prepareCheckpoint(written.filesCheckpoint),
      catch: (cause) =>
        new HarnessRequestFacetError("The initial filesystem checkpoint could not be verified.", {
          cause,
        }),
    });
    if (preparedFiles.manifestSha256 !== written.checkpoint.filesystem.sha256)
      return yield* Effect.fail(
        new HarnessRequestFacetError(
          "The initial filesystem bytes differ from the committed artifact reference.",
        ),
      );
    yield* input.turnBindings.verify(written.checkpoint.native, "native");
    yield* input.turnBindings.verify(written.checkpoint.filesystem, "filesystem");

    const runtime = yield* createHarnessCProductRequestRuntime({
      runId: input.runId,
      threadId,
      capabilities: input.capabilities,
      turnBindings: input.turnBindings,
      session,
    });
    const evidence: HarnessRequestFacetCreationEvidence = {
      facetNonce: input.targetFacetNonce,
      nativeSessionId,
      checkpoint: written.checkpoint,
      filesCheckpoint: written.filesCheckpoint,
      manifestRevision: written.checkpoint.filesystem.sha256,
      joined: { invocationRpc: true, fetch: true, ports: true },
      runtime,
    };
    return { host, runtime, evidence };
  });
}
