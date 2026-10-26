import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { createHarnessRequestFacetClass } from "../../HarnessRequestFacetObject.ts";
import {
  HarnessRequestFacetError,
  type HarnessFacetRequestRuntime,
} from "../../HarnessRequestFacet.ts";
import type { HarnessRunStoreObject } from "../../HarnessRunStoreObject.ts";
import type { HarnessThreadSupervisorPublisher } from "../../HarnessThreadSupervisor.ts";
import type { HarnessProcessResumePreparedRelease } from "../../HarnessProcessResume.ts";
import type { ProofFilesStore } from "./publicResumeStores.fixture.ts";
import { loadMaterial, jsonBytes, reference } from "./releaseMaterial.ts";

declare const PLAIN_VARIANT: string;
interface Env {
  readonly HARNESS_RESUME_RUN_STORE: Pick<HarnessRunStoreObject, "execute">;
  readonly HARNESS_RESUME_FILES_STORE: Pick<
    ProofFilesStore,
    "execute" | "configuration" | "observe" | "fetch" | "callback" | "produce"
  >;
  readonly HARNESS_RESUME_RUN_ID: string;
  readonly HARNESS_RESUME_PUBLISHER: HarnessThreadSupervisorPublisher;
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
                const transcript = [
                  ...restored.transcript,
                  `${PLAIN_VARIANT}:${context.requestId}:${fetchResult}:${callback}`,
                ];
                const nextFiles = checkpoint.files.map((file) =>
                  file.path === "native.json"
                    ? {
                        ...file,
                        bytes: jsonBytes({ nativeSessionId: restored.nativeSessionId, transcript }),
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
            const observed = await ctx.storage.get<HarnessProcessResumePreparedRelease>(
              "observed-release",
            );
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
