// @effect-diagnostics cryptoRandomUUIDInEffect:off - the controlled peer assigns its UUID inside the request lifetime.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
import { createHarnessRequestFacetClass } from "../../HarnessRequestFacetObject.ts";
import {
  HarnessRequestFacetError,
  type HarnessFacetRequestRuntime,
  type HarnessRequestFacetCreationEvidence,
  type HarnessRequestFacet,
  type HarnessRequestFacetOptions,
  type HarnessRequestFacetPreparationEvidence,
  type HarnessRequestFacetPreparationRequest,
} from "../../HarnessRequestFacet.ts";
import type { HarnessProcessExecutionResumeFacetEnvironment } from "../../HarnessProcessPlacement.ts";
import type { HarnessRequestCheckpoint } from "../../HarnessRunStore.ts";
import type { HarnessRunStoreObject } from "../../HarnessRunStoreObject.ts";
import type { HarnessFilesStoreObject } from "../../HarnessFilesStoreObject.ts";
import type { HarnessThreadSupervisorObject } from "../../HarnessThreadSupervisorObject.ts";
import type { HarnessFilesCheckpoint } from "../../HarnessFilesStore.ts";
import type { HarnessRunArtifact } from "../../HarnessRunStore.ts";
import type { HarnessProcessResumePreparedRelease } from "../../HarnessProcessResume.ts";
import { prepareHarnessFilesCheckpoint as prepareCheckpoint } from "../../HarnessFilesStore.ts";
import { loadControlledCodexRelease } from "./controlledRelease.fixture.ts";
import type { ControlledCreationStore } from "./controlledCreationStore.fixture.ts";

type ControlledCreationFacetEnvironment = HarnessProcessExecutionResumeFacetEnvironment & {
  readonly HARNESS_C_PRODUCT_CAPABILITIES?: Readonly<Record<string, Fetcher>>;
  readonly HARNESS_C_PRODUCT_BOOTSTRAP?: {
    readonly provider: "codex";
    readonly preparedReleaseId: string;
    readonly restoreMode: "same-variant-serialized-checkpoint" | "cross-variant-fresh-boot";
  };
  readonly HARNESS_C_TARGET_PREPARED_RELEASE?: HarnessProcessResumePreparedRelease;
  readonly HARNESS_PROCESS_ID: string;
  readonly HARNESS_PROCESS_SHARD_OWNER: string;
  readonly HARNESS_PROCESS_LOADER_ID: string;
  readonly HARNESS_PROCESS_FACET_KEY: string;
};

type StoreClient = Pick<
  ControlledCreationStore,
  | "stageCheckpoint"
  | "putArtifact"
  | "verifyArtifact"
  | "nativeCheckpoint"
  | "record"
  | "recordLoadedRelease"
  | "consumeExactFacetDisposalFailure"
>;
type RunStoreClient = Pick<HarnessRunStoreObject, "execute">;
type FilesStoreClient = Pick<HarnessFilesStoreObject, "execute">;
type SupervisorClient = Pick<HarnessThreadSupervisorObject, "execute">;

const failed = (message: string, cause?: unknown) =>
  new HarnessRequestFacetError(message, cause === undefined ? undefined : { cause });
const call = <A>(run: () => Promise<A>, message: string) =>
  Effect.tryPromise({ try: run, catch: (cause) => failed(message, cause) });

function fixtureStore(env: ControlledCreationFacetEnvironment): StoreClient {
  const store = env.HARNESS_C_PRODUCT_CAPABILITIES?.["cold-creation-store"];
  if (store === undefined) throw failed("The controlled creation store is missing.");
  return store as unknown as StoreClient;
}

function runtimeFor(input: {
  readonly runId: string;
  readonly facetNonce: string;
  readonly nativeSessionId: string;
  readonly checkpoint: HarnessRequestCheckpoint;
  readonly store: StoreClient;
  readonly runStore: RunStoreClient;
}): HarnessFacetRequestRuntime {
  return {
    run: (request, context) =>
      Effect.gen(function* () {
        yield* context.check;
        const current = yield* call(
          () => input.runStore.execute({ type: "read", runId: input.runId }),
          "The controlled request could not read its RunStore checkpoint.",
        );
        const parent = current.snapshot.requests?.checkpoint;
        if (parent === undefined || parent.native.id !== input.checkpoint.native.id)
          return yield* Effect.fail(
            failed("The controlled runtime lost its exact parent checkpoint."),
          );
        const nativeBytes = new TextEncoder().encode(
          encodeJson({
            nativeSessionId: input.nativeSessionId,
            requestId: context.requestId,
            sourceFacetNonce: input.facetNonce,
            input: request.id,
          }),
        );
        const filesCheckpoint: HarnessFilesCheckpoint = {
          checkpointId: `cold-request-${context.requestId}`,
          parentCheckpointId: parent.native.id,
          files: [{ path: "native.json", mode: 0o600, bytes: nativeBytes }],
        };
        const result = yield* call(
          () =>
            input.store.putArtifact(
              `cold-result-${context.requestId}`,
              new TextEncoder().encode(`completed:${context.requestId}`),
            ),
          "The controlled request result could not be stored.",
        );
        const checkpoint = yield* call(
          () => input.store.stageCheckpoint(context.requestId, filesCheckpoint, nativeBytes),
          "The controlled request checkpoint could not be stored.",
        );
        yield* call(
          () =>
            input.store.record("request-runtime-run", {
              requestId: context.requestId,
              facetNonce: input.facetNonce,
              nativeSessionId: input.nativeSessionId,
              inputArtifactId: request.id,
            }),
          "The controlled request observation could not be stored.",
        );
        return { status: "completed" as const, result, checkpoint };
      }),
  };
}

async function preparedRuntime(input: {
  readonly env: ControlledCreationFacetEnvironment;
  readonly facetNonce: string;
  readonly request: HarnessRequestFacetPreparationRequest;
  readonly store: StoreClient;
}): Promise<HarnessRequestFacetPreparationEvidence> {
  const env = input.env;
  const runId = env.HARNESS_RESUME_RUN_ID;
  const runStore = env.HARNESS_RESUME_RUN_STORE as unknown as RunStoreClient;
  const filesStore = env.HARNESS_RESUME_FILES_STORE as unknown as FilesStoreClient;
  const supervisor = env.HARNESS_RESUME_SUPERVISOR as unknown as SupervisorClient;
  const publisher = env.HARNESS_RESUME_PUBLISHER;
  if (publisher === undefined) throw new Error("Strict restore requires the prior publisher.");
  const current = await supervisor.execute({
    type: "read",
    runId,
    control: env.HARNESS_RESUME_CONTROL,
  });
  const journal = await runStore.execute({ type: "read", runId });
  const checkpoint = journal.snapshot.requests?.checkpoint;
  if (
    checkpoint === undefined ||
    checkpoint.native.id !== input.request.checkpointId ||
    checkpoint.filesystem.sha256 !== input.request.manifestRevision ||
    current.snapshot.nativeSessionId !== input.request.nativeSessionId ||
    current.snapshot.checkpoint.checkpointId !== input.request.checkpointId ||
    current.snapshot.checkpoint.manifestSha256 !== input.request.manifestRevision
  )
    throw new Error("Strict restore did not retain the bound native UUID and initial checkpoint.");
  const files = await filesStore.execute({
    type: "readCheckpoint",
    runId,
    publisher,
    checkpointId: input.request.checkpointId,
  });
  const nativeBytes = await input.store.nativeCheckpoint(input.request.checkpointId);
  const nativeFile = files.files.find((file) => file.path === "native.json");
  if (
    files.checkpoint.checkpointId !== input.request.checkpointId ||
    files.checkpoint.manifestSha256 !== input.request.manifestRevision ||
    nativeBytes === undefined ||
    nativeFile === undefined ||
    JSON.parse(new TextDecoder().decode(nativeBytes)).nativeSessionId !==
      input.request.nativeSessionId ||
    JSON.parse(new TextDecoder().decode(nativeFile.bytes)).nativeSessionId !==
      input.request.nativeSessionId
  )
    throw new Error("Strict restore could not read the exact stored initial snapshot.");
  await input.store.record("inert-restore", {
    facetNonce: input.facetNonce,
    nativeSessionId: input.request.nativeSessionId,
    checkpointId: input.request.checkpointId,
    manifestRevision: input.request.manifestRevision,
    priorFacetNonce: input.request.priorFacetNonce,
    expectedFacetGeneration: input.request.expectedFacetGeneration,
  });
  return {
    facetNonce: input.facetNonce,
    nativeSessionId: input.request.nativeSessionId,
    checkpoint,
    manifestRevision: input.request.manifestRevision,
    joined: { invocationRpc: true, fetch: true, ports: true },
    runtime: runtimeFor({
      runId,
      facetNonce: input.facetNonce,
      nativeSessionId: input.request.nativeSessionId,
      checkpoint,
      store: input.store,
      runStore,
    }),
  };
}

export class ControlledCreationFacet extends createHarnessRequestFacetClass<ControlledCreationFacetEnvironment>(
  ({ env, facetNonce }) => {
    const runId = env.HARNESS_RESUME_RUN_ID;
    const store = fixtureStore(env);
    const runStore = env.HARNESS_RESUME_RUN_STORE as unknown as RunStoreClient;
    const supervisor = env.HARNESS_RESUME_SUPERVISOR as unknown as SupervisorClient;

    const options: HarnessRequestFacetOptions = {
      runId,
      facetNonce,
      store: runStore,
      verify: (artifact: HarnessRunArtifact) =>
        call(() => store.verifyArtifact(artifact), "The controlled artifact reference is invalid."),
      open: (checkpoint) =>
        Effect.gen(function* () {
          yield* call(
            () => store.record("normal-open", { facetNonce, checkpointId: checkpoint.native.id }),
            "The normal-open observation could not be stored.",
          );
          const current = yield* call(
            () => supervisor.execute({ type: "read", runId, control: env.HARNESS_RESUME_CONTROL }),
            "The normal-open supervisor state could not be read.",
          );
          return runtimeFor({
            runId,
            facetNonce,
            nativeSessionId: current.snapshot.nativeSessionId,
            checkpoint,
            store,
            runStore,
          });
        }),
      prepareInert: (request) =>
        Effect.gen(function* () {
          const prepared = yield* Effect.tryPromise({
            try: () => preparedRuntime({ env, facetNonce, request, store }),
            catch: (cause) => failed("The controlled strict restore failed.", cause),
          });
          yield* Effect.addFinalizer(() =>
            call(
              () =>
                store.record("facet-disposed", {
                  facetNonce,
                  nativeSessionId: request.nativeSessionId,
                  checkpointId: request.checkpointId,
                }),
              "The restored facet disposal could not be recorded.",
            ).pipe(Effect.orDie),
          );
          return prepared;
        }),
      startFresh: (request) =>
        Effect.gen(function* () {
          const created = yield* Effect.tryPromise({
            try: async (): Promise<HarnessRequestFacetCreationEvidence> => {
              const nativeSessionId = crypto.randomUUID();
              const checkpointId = `cold-initial-${request.operationId}`;
              const nativeBytes = new TextEncoder().encode(
                encodeJson({
                  nativeSessionId,
                  operationId: request.operationId,
                  userTurns: 0,
                }),
              );
              const filesCheckpoint: HarnessFilesCheckpoint = {
                checkpointId,
                parentCheckpointId: null,
                files: [{ path: "native.json", mode: 0o600, bytes: nativeBytes }],
              };
              const checkpoint = await store.stageCheckpoint(
                `initial-${request.operationId}`,
                filesCheckpoint,
                nativeBytes,
              );
              const prepared = await prepareCheckpoint(filesCheckpoint);
              if (
                checkpoint.native.id !== checkpointId ||
                checkpoint.filesystem.sha256 !== prepared.manifestSha256 ||
                checkpoint.filesystem.bytes !== prepared.byteCount
              )
                throw new Error("The controlled peer's initial checkpoint references disagree.");
              await store.record("peer-thread-start", {
                operationId: request.operationId,
                nativeSessionId,
                facetNonce,
                userTurns: 0,
              });
              return {
                facetNonce,
                nativeSessionId,
                checkpoint,
                filesCheckpoint,
                manifestRevision: checkpoint.filesystem.sha256,
                joined: { invocationRpc: true, fetch: true, ports: true },
                runtime: runtimeFor({
                  runId,
                  facetNonce,
                  nativeSessionId,
                  checkpoint,
                  store,
                  runStore,
                }),
              };
            },
            catch: (cause) =>
              failed("The controlled peer could not create its first thread.", cause),
          });
          yield* Effect.addFinalizer(() =>
            call(
              () =>
                store.record("facet-disposed", {
                  facetNonce,
                  nativeSessionId: created.nativeSessionId,
                  checkpointId: created.checkpoint.native.id,
                }),
              "The fresh facet disposal could not be recorded.",
            ).pipe(Effect.orDie),
          );
          return created;
        }),
      loadedPreparedRelease: async () => {
        const loaded = await loadControlledCodexRelease();
        await store.recordLoadedRelease(loaded);
        return loaded;
      },
    };
    return Effect.succeed(options);
  },
) {
  override async run(input: Parameters<HarnessRequestFacet["run"]>[0]) {
    await fixtureStore(this.env).record("facet-invoked", {
      requestId: input.requestId,
      facetNonce: this.facetNonce,
    });
    return await super.run(input);
  }

  override async dispose(expectedFacetNonce: string) {
    if (await fixtureStore(this.env).consumeExactFacetDisposalFailure(expectedFacetNonce))
      throw new Error("Injected exact facet disposal failure.");
    await super.dispose(expectedFacetNonce);
  }
}
