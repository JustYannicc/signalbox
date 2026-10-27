import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { createHarnessRequestFacetClass } from "../../HarnessRequestFacetObject.ts";
import {
  HarnessRequestFacetError,
  type HarnessFacetRequestRuntime,
} from "../../HarnessRequestFacet.ts";
import type { HarnessCProductCapabilityEnvironment } from "../../HarnessProcessPlacement.ts";
import type { HarnessRunStoreObject } from "../../HarnessRunStoreObject.ts";
import type {
  HarnessThreadSupervisorControlClaim,
  HarnessThreadSupervisorPublisher,
} from "../../HarnessThreadSupervisor.ts";
import type {
  HarnessCProductBootstrapDescriptor,
  HarnessProcessResumePreparedRelease,
} from "../../HarnessProcessResume.ts";
import type { HarnessRequestPublisher } from "../../HarnessRunStore.ts";
import type { ProofFilesStore } from "./publicResumeStores.fixture.ts";
import { loadMaterial, jsonBytes, reference } from "./releaseMaterial.ts";

declare const PLAIN_VARIANT: string;
declare const C_TRANSPORT_WASM: WebAssembly.Module;
const wasmAnswer = new WebAssembly.Instance(C_TRANSPORT_WASM).exports.answer;
if (typeof wasmAnswer !== "function") throw new Error("The transported Wasm export is missing.");
const transportedWasmAnswer = Number(wasmAnswer());
interface Env extends HarnessCProductCapabilityEnvironment {
  readonly HARNESS_RESUME_RUN_STORE: Pick<HarnessRunStoreObject, "execute">;
  readonly HARNESS_RESUME_FILES_STORE: Pick<
    ProofFilesStore,
    "execute" | "configuration" | "observe" | "fetch" | "callback" | "produce"
  >;
  readonly HARNESS_RESUME_RUN_ID: string;
  readonly HARNESS_RESUME_CONTROL: HarnessThreadSupervisorControlClaim;
  readonly HARNESS_RESUME_PUBLISHER: HarnessThreadSupervisorPublisher;
  readonly HARNESS_C_PRODUCT_BOOTSTRAP?: HarnessCProductBootstrapDescriptor;
  readonly HARNESS_C_TARGET_PREPARED_RELEASE?: HarnessProcessResumePreparedRelease;
  readonly HARNESS_PROCESS_ID: string;
  readonly HARNESS_PROCESS_SHARD_OWNER: string;
  readonly HARNESS_PROCESS_LOADER_ID: string;
  readonly HARNESS_PROCESS_FACET_KEY: string;
  readonly HARNESS_REQUEST_PUBLISHER?: Pick<HarnessRequestPublisher, "generation" | "publisherKey">;
}
const call = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new HarnessRequestFacetError("Plain process fixture dependency failed.", { cause }),
  });
const decodePlainNative = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      nativeSessionId: Schema.String,
      transcript: Schema.Array(Schema.String),
    }),
  ),
);
const createPlainProcess = (exposeLoadedRelease: boolean) =>
  createHarnessRequestFacetClass<Env>(({ ctx, env, facetNonce }) => {
    const files = env.HARNESS_RESUME_FILES_STORE;
    const store = env.HARNESS_RESUME_RUN_STORE;
    return Effect.succeed({
      runId: env.HARNESS_RESUME_RUN_ID,
      facetNonce,
      store,
      verify: () => Effect.void,
      open: () => Effect.die("This plain process must use its retained inert preparation."),
      prepareInert: (request) =>
        Effect.gen(function* () {
          const config = yield* call(() => files.configuration());
          const material = config.artifacts[PLAIN_VARIANT];
          if (material === undefined)
            return yield* Effect.fail(
              new HarnessRequestFacetError("The selected plain process artifact is absent."),
            );
          const observedRelease = yield* call(() => loadMaterial(material));
          const capability = env.HARNESS_C_PRODUCT_CAPABILITIES?.["proof-platform"];
          const capabilityResult =
            capability === undefined
              ? null
              : yield* call(async () => {
                  const response = await capability.fetch(
                    new Request("https://product-capability/product-bootstrap-transport"),
                  );
                  return response.text();
                });
          yield* call(() =>
            files.observe(`facet-transport:${facetNonce}`, {
              wasmAnswer: transportedWasmAnswer,
              productBootstrap: env.HARNESS_C_PRODUCT_BOOTSTRAP ?? null,
              targetPreparedRelease: env.HARNESS_C_TARGET_PREPARED_RELEASE ?? null,
              productCapability: capabilityResult,
              resumeRunId: env.HARNESS_RESUME_RUN_ID,
              resumeControl: env.HARNESS_RESUME_CONTROL,
              resumePublisher: env.HARNESS_RESUME_PUBLISHER,
              processIdentity: {
                processId: env.HARNESS_PROCESS_ID,
                shardOwner: env.HARNESS_PROCESS_SHARD_OWNER,
                loaderId: env.HARNESS_PROCESS_LOADER_ID,
                facetKey: env.HARNESS_PROCESS_FACET_KEY,
              },
              requestPublisher: env.HARNESS_REQUEST_PUBLISHER ?? null,
            }),
          );
          const checkpoint = yield* call(() =>
            files.execute({
              type: "readCheckpoint",
              runId: env.HARNESS_RESUME_RUN_ID,
              publisher: env.HARNESS_RESUME_PUBLISHER,
              checkpointId: request.checkpointId,
            }),
          );
          const journal = yield* call(() =>
            store.execute({ type: "read", runId: env.HARNESS_RESUME_RUN_ID }),
          );
          const native = checkpoint.files.find((file) => file.path === "native.json");
          if (native === undefined || journal.snapshot.requests === undefined)
            return yield* Effect.fail(
              new HarnessRequestFacetError("Plain process durable material is missing."),
            );
          const restored = yield* decodePlainNative(new TextDecoder().decode(native.bytes)).pipe(
            Effect.mapError(
              (cause) =>
                new HarnessRequestFacetError("The stored plain session is malformed.", { cause }),
            ),
          );
          let transcript = [...restored.transcript];
          const nativeRef = yield* call(() =>
            reference(checkpoint.checkpoint.checkpointId, native.bytes),
          );
          if (
            restored.nativeSessionId !== request.nativeSessionId ||
            checkpoint.checkpoint.manifestSha256 !== request.manifestRevision ||
            nativeRef.sha256 !== journal.snapshot.requests.checkpoint.native.sha256 ||
            nativeRef.bytes !== journal.snapshot.requests.checkpoint.native.bytes ||
            checkpoint.checkpoint.manifestSha256 !==
              journal.snapshot.requests.checkpoint.filesystem.sha256
          )
            return yield* Effect.fail(
              new HarnessRequestFacetError(
                "The plain process did not restore the actual checkpoint bytes.",
              ),
            );
          yield* call(() => ctx.storage.put("observed-release", observedRelease));
          yield* call(() =>
            files.observe(`prepared:${facetNonce}`, {
              variant: PLAIN_VARIANT,
              checkpointId: checkpoint.checkpoint.checkpointId,
              manifestSha256: checkpoint.checkpoint.manifestSha256,
              nativeSessionId: restored.nativeSessionId,
              transcript: restored.transcript,
              sourceIdentity: observedRelease.plan.sourceIdentity,
            }),
          );
          yield* Effect.addFinalizer(() =>
            call(async () => {
              if (config.failDispose) throw new Error("Injected unjoined plain process scope.");
              await files.observe(`disposed:${facetNonce}`);
            }).pipe(Effect.orDie),
          );
          let currentCheckpoint = journal.snapshot.requests.checkpoint;
          return {
            facetNonce,
            nativeSessionId: restored.nativeSessionId,
            checkpoint: currentCheckpoint,
            manifestRevision: checkpoint.checkpoint.manifestSha256,
            joined: { invocationRpc: true, fetch: true, ports: true },
            runtime: {
              run: (_input, context) =>
                Effect.gen(function* () {
                  yield* context.check;
                  yield* call(() =>
                    files.observe(`invoked:${context.requestId}`, {
                      facetNonce,
                      variant: PLAIN_VARIANT,
                    }),
                  );
                  if (config.invocationFailure === "reject")
                    return yield* Effect.fail(
                      new HarnessRequestFacetError("Injected plain invocation rejection."),
                    );
                  const response = yield* call(() =>
                    files.fetch(new Request(`https://plain-fixture/${context.requestId}`)),
                  );
                  const fetchResult = yield* call(() => response.text());
                  const callback = yield* call(() => files.callback(context.requestId));
                  yield* context.check;
                  transcript = [
                    ...transcript,
                    `${PLAIN_VARIANT}:${context.requestId}:${fetchResult}:${callback}`,
                  ];
                  const nextFiles = checkpoint.files.map((file) =>
                    file.path === "native.json"
                      ? {
                          ...file,
                          bytes: jsonBytes({
                            nativeSessionId: restored.nativeSessionId,
                            transcript,
                          }),
                        }
                      : file.path === "workspace.txt"
                        ? { ...file, bytes: new TextEncoder().encode(transcript.join("\n")) }
                        : file,
                  );
                  const produced = yield* call(() =>
                    files.produce(context.requestId, {
                      checkpointId: `${context.requestId}-native`,
                      parentCheckpointId: currentCheckpoint.native.id,
                      files: nextFiles,
                    }),
                  );
                  currentCheckpoint = produced.reference;
                  const result = yield* call(() =>
                    reference(`result:${context.requestId}`, jsonBytes(transcript)),
                  );
                  return {
                    status:
                      config.invocationFailure === "failed-finish"
                        ? ("failed" as const)
                        : ("completed" as const),
                    result,
                    checkpoint: produced.reference,
                  };
                }),
            } satisfies HarnessFacetRequestRuntime,
          };
        }).pipe(
          Effect.tapCause((cause) =>
            call(async () => {
              let error: unknown = Cause.squash(cause);
              const messages: string[] = [];
              for (let index = 0; index < 5 && error instanceof Error; index++) {
                messages.push(error.message);
                error = error.cause;
              }
              await files.observe("prepare-error", messages);
            }),
          ),
        ),
      ...(exposeLoadedRelease
        ? {
            loadedPreparedRelease: async () => {
              const observed =
                await ctx.storage.get<HarnessProcessResumePreparedRelease>("observed-release");
              if (observed === undefined)
                throw new Error("The plain artifact has not been loaded and verified.");
              await files.observe("observed-release-returned", observed);
              return observed;
            },
          }
        : {}),
    });
  });

const PlainProcess = createPlainProcess(false);
const ObservedProcess = createPlainProcess(true);
export class PlainFacet extends PlainProcess {}
export class ObservedPlainFacet extends ObservedProcess {}
