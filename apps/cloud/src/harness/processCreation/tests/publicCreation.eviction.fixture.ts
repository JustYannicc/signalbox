import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createControlledCreationFacetClass } from "./controlledCreationFacet.fixture.ts";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
import type { HarnessFilesCheckpoint } from "../../HarnessFilesStore.ts";
import type { HarnessFacetRequestRuntime } from "../../HarnessRequestFacet.ts";
import { HarnessRequestFacetError } from "../../HarnessRequestFacet.ts";
import type { HarnessFilesStoreObject } from "../../HarnessFilesStoreObject.ts";
import type { ControlledCreationStore } from "./controlledCreationStore.fixture.ts";

type StoreClient = Pick<
  ControlledCreationStore,
  "stageCheckpoint" | "nativeCheckpoint" | "material" | "record"
>;
type FilesStoreClient = Pick<HarnessFilesStoreObject, "execute">;
type FacetEnvironment = {
  readonly HARNESS_C_PRODUCT_CAPABILITIES?: Readonly<Record<string, Fetcher>>;
};

interface RestoredState {
  readonly native: Record<string, unknown> & {
    readonly nativeSessionId: string;
    readonly conversation: readonly string[];
    readonly userTurns: number;
  };
  readonly workspace: string;
  readonly sourceCheckpointId: string;
}

function storeFor(env: FacetEnvironment): StoreClient {
  const store = env.HARNESS_C_PRODUCT_CAPABILITIES?.["cold-creation-store"];
  if (store === undefined)
    throw new HarnessRequestFacetError("The controlled creation store is missing.");
  return store as unknown as StoreClient;
}

function call<A>(run: () => Promise<A>, message: string) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new HarnessRequestFacetError(message, { cause }),
  });
}

function withRestoredState(input: {
  readonly runtime: HarnessFacetRequestRuntime;
  readonly store: StoreClient;
  readonly state: RestoredState;
  readonly facetNonce: string;
}): HarnessFacetRequestRuntime {
  return {
    run: (request, context) =>
      Effect.gen(function* () {
        const completed = yield* input.runtime.run(request, context);
        const material = yield* call(
          () => input.store.material(context.requestId),
          "The controlled checkpoint material could not be read.",
        );
        const conversation = [...input.state.native.conversation, `request:${context.requestId}`];
        const workspace = `${input.state.workspace}request:${context.requestId}\n`;
        const nativeBytes = new TextEncoder().encode(
          encodeJson({
            ...input.state.native,
            conversation,
            userTurns: input.state.native.userTurns + 1,
            lastRequestId: context.requestId,
            sourceFacetNonce: input.facetNonce,
            input: request.id,
          }),
        );
        const filesCheckpoint: HarnessFilesCheckpoint = {
          ...material,
          files: [
            ...material.files.filter(
              (file) => file.path !== "native.json" && file.path !== "workspace.txt",
            ),
            { path: "native.json", mode: 0o600, bytes: nativeBytes },
            { path: "workspace.txt", mode: 0o644, bytes: new TextEncoder().encode(workspace) },
          ],
        };
        const checkpoint = yield* call(
          () => input.store.stageCheckpoint(context.requestId, filesCheckpoint, nativeBytes),
          "The restored conversation and workspace could not be checkpointed.",
        );
        yield* call(
          () =>
            input.store.record("creation-eviction-request", {
              facetNonce: input.facetNonce,
              nativeSessionId: input.state.native.nativeSessionId,
              sourceCheckpointId: input.state.sourceCheckpointId,
              requestId: context.requestId,
              conversationBefore: input.state.native.conversation,
              workspaceBefore: input.state.workspace,
              conversationAfter: conversation,
              workspaceAfter: workspace,
            }),
          "The restored request observation could not be stored.",
        );
        return { ...completed, checkpoint };
      }),
  };
}

function nativeState(
  bytes: Uint8Array | undefined,
  requireConversation = false,
): RestoredState["native"] {
  if (bytes === undefined)
    throw new HarnessRequestFacetError("The creation checkpoint has no native bytes.");
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  const conversation = value.conversation;
  const userTurns = value.userTurns;
  if (
    typeof value.nativeSessionId !== "string" ||
    (conversation !== undefined &&
      (!Array.isArray(conversation) ||
        !conversation.every((entry) => typeof entry === "string"))) ||
    (requireConversation && conversation === undefined) ||
    (userTurns !== undefined && typeof userTurns !== "number")
  )
    throw new HarnessRequestFacetError("The creation checkpoint lost its conversation state.");
  return {
    ...value,
    conversation: (conversation ?? []) as readonly string[],
    userTurns: (userTurns ?? 0) as number,
  } as RestoredState["native"];
}

function workspaceText(checkpoint: HarnessFilesCheckpoint) {
  const file = checkpoint.files.find((entry) => entry.path === "workspace.txt");
  if (file === undefined)
    throw new HarnessRequestFacetError("The creation checkpoint has no workspace file.");
  return new TextDecoder().decode(file.bytes);
}

export class PublicCreationEvictionFacet extends createControlledCreationFacetClass(
  (options, environment, facetNonce) => {
    const startFresh = options.startFresh;
    const prepareInert = options.prepareInert;
    if (startFresh === undefined || prepareInert === undefined)
      throw new Error("The controlled creation fixture lacks its native lifecycle hooks.");
    return {
      ...options,
      startFresh: (request) =>
        Effect.gen(function* () {
          const created = yield* startFresh(request);
          const store = storeFor(environment);
          const conversation = ["prior: saved conversation"];
          const workspace = "saved workspace\n";
          const priorNative = nativeState(
            yield* call(
              () => store.nativeCheckpoint(created.checkpoint.native.id),
              "The initial native checkpoint could not be read.",
            ),
          );
          const nativeBytes = new TextEncoder().encode(
            encodeJson({ ...priorNative, conversation }),
          );
          const filesCheckpoint: HarnessFilesCheckpoint = {
            ...created.filesCheckpoint,
            files: [
              ...created.filesCheckpoint.files.filter((file) => file.path !== "native.json"),
              { path: "native.json", mode: 0o600, bytes: nativeBytes },
              { path: "workspace.txt", mode: 0o644, bytes: new TextEncoder().encode(workspace) },
            ],
          };
          const checkpoint = yield* call(
            () =>
              store.stageCheckpoint(`initial-${request.operationId}`, filesCheckpoint, nativeBytes),
            "The seeded creation checkpoint could not be stored.",
          );
          return {
            ...created,
            checkpoint,
            filesCheckpoint,
            manifestRevision: checkpoint.filesystem.sha256,
            runtime: withRestoredState({
              runtime: created.runtime,
              store,
              state: {
                native: { ...priorNative, conversation },
                workspace,
                sourceCheckpointId: checkpoint.native.id,
              },
              facetNonce,
            }),
          };
        }),
      prepareInert: (request) =>
        Effect.gen(function* () {
          const prepared = yield* prepareInert(request);
          const store = storeFor(environment);
          const filesStore = environment.HARNESS_RESUME_FILES_STORE as unknown as FilesStoreClient;
          const native = nativeState(
            yield* call(
              () => store.nativeCheckpoint(request.checkpointId),
              "The committed native creation checkpoint could not be read.",
            ),
            true,
          );
          const files = yield* call(
            () =>
              filesStore.execute({
                type: "readCheckpoint",
                runId: environment.HARNESS_RESUME_RUN_ID,
                publisher: environment.HARNESS_RESUME_PUBLISHER,
                checkpointId: request.checkpointId,
              }),
            "The committed creation files could not be read.",
          );
          const workspace = workspaceText({
            checkpointId: files.checkpoint.checkpointId,
            parentCheckpointId: files.parentCheckpointId,
            files: files.files,
          });
          if (
            files.checkpoint.checkpointId !== request.checkpointId ||
            files.checkpoint.manifestSha256 !== request.manifestRevision ||
            native.nativeSessionId !== request.nativeSessionId
          )
            return yield* Effect.fail(
              new HarnessRequestFacetError(
                "The restored creation checkpoint changed before the first request.",
              ),
            );
          yield* call(
            () =>
              store.record("creation-eviction-restored", {
                facetNonce,
                nativeSessionId: native.nativeSessionId,
                sourceCheckpointId: request.checkpointId,
                priorFacetNonce: request.priorFacetNonce,
                expectedFacetGeneration: request.expectedFacetGeneration,
                conversation: native.conversation,
                workspace,
              }),
            "The restored creation observation could not be recorded.",
          );
          return {
            ...prepared,
            runtime: withRestoredState({
              runtime: prepared.runtime,
              store,
              state: { native, workspace, sourceCheckpointId: request.checkpointId },
              facetNonce,
            }),
          };
        }),
    };
  },
) {}

export { PublicCreationEvictionFacet as ControlledCreationFacet };
