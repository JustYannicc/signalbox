import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import type { HarnessReleaseArtifact } from "../../harnessReleases/HarnessReleaseLedger.ts";
import type { HarnessRequestFacetCreationEvidence } from "../HarnessRequestFacet.ts";
import type { HarnessProcessResumePreparedRelease } from "../HarnessProcessResume.ts";
import type { HarnessThreadSupervisorPublisher } from "../HarnessThreadSupervisor.ts";
import type { HarnessError, HarnessCheckpoint } from "../Harness.ts";
import type { HostOpenInput, HarnessHostSession } from "../HarnessSessionHost.ts";
import type { ProductHostOptions, ProductHarnessSessionHost } from "../host/product.ts";
import { prepareCheckpoint } from "../durableState/files/content.ts";
import { HarnessRequestFacetError } from "../HarnessRequestFacet.ts";
import { createHarnessCProductRequestRuntime } from "./requestRuntime.ts";
import {
  productMachineInventory,
  productModelTransport,
  productProgramBindings,
  productReleaseBindings,
} from "./capabilities.ts";
import { productExecutor } from "./executor.ts";
import { productTurnGrantSource } from "./turnGrant.ts";
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

const nativeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opens a Codex thread from its first native create, then retains that same session for turns. */
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
    if (
      input.factory.provider !== "codex" ||
      input.descriptor.provider !== "codex" ||
      input.expected.artifact.provider !== "codex" ||
      input.descriptor.preparedReleaseId !== input.expected.artifact.releaseId
    )
      return yield* Effect.fail(failed("Fresh product host creation is supported only for Codex."));

    const buildFreshHostOptions = input.factory.buildFreshHostOptions;
    const buildFreshOpenInput = input.factory.buildFreshOpenInput;
    const writeInitialCheckpoint = input.turnBindings.writeInitialCheckpoint;
    const resolveFreshAccess = input.capabilities.access.resolveFreshAccess;
    if (
      buildFreshHostOptions === undefined ||
      buildFreshOpenInput === undefined ||
      writeInitialCheckpoint === undefined ||
      resolveFreshAccess === undefined
    )
      return yield* Effect.fail(failed("Fresh product host creation bindings are incomplete."));
    if (
      input.operationId.length === 0 ||
      input.targetFacetNonce.length === 0 ||
      input.publisherKey.length < 32 ||
      input.publisherKey.length > 128
    )
      return yield* Effect.fail(failed("Fresh product host creation identity is invalid."));

    const publisher: HarnessThreadSupervisorPublisher = {
      generation: 1,
      facetNonce: input.targetFacetNonce,
      publisherKey: input.publisherKey,
    };
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
    const programs = yield* Effect.tryPromise({
      try: () => productProgramBindings(input.factory.provider, input.capabilities.programs),
      catch: (cause) => failed("The provider program seed could not be prepared.", cause),
    });
    const machineInventory = yield* Effect.tryPromise({
      try: () => productMachineInventory(input.factory.provider, input.capabilities.machine),
      catch: (cause) => failed("The provider machine inventory could not be prepared.", cause),
    });
    const providerOptions = yield* buildFreshHostOptions({
      env: input.env,
      ctx: input.ctx,
      facetNonce: input.targetFacetNonce,
      capabilities: input.capabilities,
      selectedRelease: selected,
    });
    const built = {
      ...providerOptions,
      programs: { codes: programs.codes, seed: programs.seed },
      machineInventory,
      modelTransport: productModelTransport(input.capabilities.model),
      executor: productExecutor(input.capabilities.executor),
      ...(input.capabilities.turnGrantSource === undefined
        ? {}
        : { turnGrantSource: productTurnGrantSource(input.capabilities.turnGrantSource) }),
    } as Omit<Options, "release" | "processResumeArtifact">;
    if (built.threadId.length === 0)
      return yield* Effect.fail(failed("Product host thread identity is missing."));
    const threadId = ThreadId.make(built.threadId);
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
      creation.providerThread.driver !== "codex" ||
      open.bootAttemptId.length === 0
    )
      return yield* Effect.fail(
        failed("Fresh product open input must contain an unbound Codex thread."),
      );

    // Resolve authority using the provider session identity before native open creates its UUID.
    const access = yield* Effect.tryPromise({
      try: () =>
        resolveFreshAccess({
          threadId,
          providerSessionId: open.session.providerSessionId,
          operationId: input.operationId,
        }),
      catch: (cause) => failed("Fresh product access could not be resolved.", cause),
    });
    const session = yield* host
      .open({
        ...open,
        creation,
        initialAccess: { ...access, signal: input.signal },
      } satisfies HostOpenInput<G>)
      .pipe(
        Effect.mapError((cause: HarnessError) =>
          failed("The fresh product session could not be opened.", cause),
        ),
      );
    yield* session.retireCheckpointAccess.pipe(
      Effect.mapError((cause) =>
        failed("Initial access could not be retired after fresh native creation.", cause),
      ),
    );
    const checkpoint = yield* session
      .export()
      .pipe(
        Effect.mapError((cause) =>
          failed("The initial native checkpoint could not be exported.", cause),
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
      catch: (cause) => failed("The initial native checkpoint identity is invalid.", cause),
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
        failed("Initial native and filesystem checkpoint identities do not match."),
      );
    yield* Effect.try({
      try: () => validateHarnessCProductFiles(written.filesCheckpoint.files),
      catch: (cause) => failed("The initial filesystem checkpoint is invalid.", cause),
    });
    const preparedFiles = yield* Effect.tryPromise({
      try: () => prepareCheckpoint(written.filesCheckpoint),
      catch: (cause) => failed("The initial filesystem checkpoint could not be verified.", cause),
    });
    if (preparedFiles.manifestSha256 !== written.checkpoint.filesystem.sha256)
      return yield* Effect.fail(
        failed("The initial filesystem bytes differ from the committed artifact reference."),
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

function validateInitialCheckpoint<G>(input: {
  readonly checkpoint: HarnessCheckpoint;
  readonly session: HarnessHostSession<G>;
  readonly provider: string;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: string;
  readonly creationThread: HarnessCheckpoint["snapshot"]["providerThread"];
}): string {
  const { checkpoint, session, provider, threadId, providerSessionId, providerInstanceId } = input;
  const thread = checkpoint.snapshot.providerThread;
  const nativeThreadRef = thread.nativeThreadRef;
  if (
    checkpoint.release.harness !== provider ||
    checkpoint.providerSession.id !== providerSessionId ||
    checkpoint.providerSession.id !== session.providerSession.id ||
    checkpoint.providerSession.driver !== provider ||
    checkpoint.providerSession.providerInstanceId !== providerInstanceId ||
    thread.appThreadId !== threadId ||
    thread.providerSessionId !== checkpoint.providerSession.id ||
    thread.providerInstanceId !== providerInstanceId ||
    thread.driver !== checkpoint.providerSession.driver ||
    thread.id !== input.creationThread.id ||
    thread.appThreadId !== input.creationThread.appThreadId ||
    thread.providerSessionId !== input.creationThread.providerSessionId ||
    thread.providerInstanceId !== input.creationThread.providerInstanceId ||
    thread.driver !== input.creationThread.driver ||
    thread.nativeThreadRef?.driver !== thread.driver ||
    nativeThreadRef === null ||
    nativeThreadRef.nativeId === null ||
    !nativeUuid.test(nativeThreadRef.nativeId) ||
    checkpoint.snapshot.providerTurns.length !== 0 ||
    checkpoint.snapshot.messages.length !== 0 ||
    checkpoint.snapshot.runtimeRequests.length !== 0
  )
    throw new Error(
      "The exported checkpoint does not contain this fresh provider session and thread.",
    );
  return nativeThreadRef.nativeId;
}

function failed(message: string, cause?: unknown) {
  return new HarnessRequestFacetError(message, cause === undefined ? undefined : { cause });
}
