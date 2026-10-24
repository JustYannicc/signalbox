import * as Effect from "effect/Effect";
import { HarnessRequestFacetError } from "../HarnessRequestFacet.ts";
import { createHarnessRequestFacetClass } from "../HarnessRequestFacetObject.ts";
import { HarnessRunStoreObject } from "../HarnessRunStoreObject.ts";
import type {
  HarnessRequestCheckpoint,
  HarnessRequestPublisher,
  HarnessRunArtifact,
  HarnessRunStoreResult,
} from "../HarnessRunStore.ts";

export interface RunStoreFacetEnvironment {
  readonly HARNESS_RUN_STORES: DurableObjectNamespace<
    HarnessRunStoreObject & Rpc.DurableObjectBranded
  >;
  readonly HARNESS_THREAD_SUPERVISOR: DurableObjectNamespace<
    {
      holdRequestRuntime(): Promise<void>;
    } & Rpc.DurableObjectBranded
  >;
}

export const processFacetArtifact: HarnessRunArtifact = {
  id: "process-facet-proof-artifact",
  bytes: 1,
  sha256: "a".repeat(64),
};
export const processFacetCheckpoint: HarnessRequestCheckpoint = {
  native: processFacetArtifact,
  filesystem: processFacetArtifact,
};
export const processFacetNativeSessionId = "production-native-session";
export const invocationReplyLossRunId = "process-invocation-reply-loss-run";
export const invocationReplyLossControlKey =
  "fixture-run-control-key-00000000000000000000000000000000";
export const invocationReplyLossSupervisorKey =
  "fixture-run-supervisor-key-00000000000000000000000000000000";
export const invocationReplyLossCheckpoint: HarnessRequestCheckpoint = {
  native: { id: "invocation-next-native", bytes: 1, sha256: "b".repeat(64) },
  filesystem: { id: "invocation-next-filesystem", bytes: 1, sha256: "c".repeat(64) },
};

const RunStoreRequestFacet = createHarnessRequestFacetClass<RunStoreFacetEnvironment>((input) => {
  const storeObject = input.env.HARNESS_RUN_STORES.getByName(invocationReplyLossRunId);
  const recordStoreAction = async (action: string) => {
    const previous = (await input.ctx.storage.get<readonly string[]>("run-store-actions")) ?? [];
    await input.ctx.storage.put("run-store-actions", [...previous, action]);
  };
  const store = {
    async execute(command: unknown): Promise<HarnessRunStoreResult> {
      const commandType =
        typeof command === "object" && command !== null && "type" in command
          ? String(command.type)
          : "unknown";
      const result = await storeObject.execute(command);
      await recordStoreAction(`${commandType}:${result.action}`);
      return result;
    },
  };
  return Effect.succeed({
    runId: invocationReplyLossRunId,
    facetNonce: input.facetNonce,
    store,
    verify: () => Effect.void,
    prepareInert: (request) =>
      Effect.gen(function* () {
        const observed = yield* Effect.tryPromise({
          try: () => store.execute({ type: "read", runId: invocationReplyLossRunId }),
          catch: (cause) =>
            new HarnessRequestFacetError("Fixture could not read its committed checkpoint.", {
              cause,
            }),
        });
        const checkpoint = observed.snapshot.requests?.checkpoint;
        if (
          checkpoint === undefined ||
          checkpoint.native.id !== request.checkpointId ||
          checkpoint.filesystem.sha256 !== request.manifestRevision
        )
          return yield* Effect.fail(
            new HarnessRequestFacetError("Fixture RunStore has another committed checkpoint."),
          );
        const previousPrepareCalls = yield* Effect.tryPromise({
          try: () => input.ctx.storage.get<number>("prepare-inert-calls"),
          catch: (cause) =>
            new HarnessRequestFacetError("Fixture preparation count could not be read.", {
              cause,
            }),
        });
        const prepareCalls = previousPrepareCalls ?? 0;
        yield* Effect.tryPromise({
          try: () => input.ctx.storage.put("prepare-inert-calls", prepareCalls + 1),
          catch: (cause) =>
            new HarnessRequestFacetError("Fixture preparation count could not be stored.", {
              cause,
            }),
        });
        yield* Effect.addFinalizer(() =>
          Effect.tryPromise({
            try: () => input.ctx.storage.put("prepared-runtime-closed", true),
            catch: (cause) =>
              new HarnessRequestFacetError("Fixture prepared runtime could not close.", {
                cause,
              }),
          }).pipe(Effect.orDie),
        );
        return {
          facetNonce: input.facetNonce,
          nativeSessionId: request.nativeSessionId,
          checkpoint,
          manifestRevision: checkpoint.filesystem.sha256,
          joined: { invocationRpc: true, fetch: true, ports: true },
          runtime: {
            run: () =>
              Effect.gen(function* () {
                const previousInvocationCount = yield* Effect.tryPromise({
                  try: () => input.ctx.storage.get<number>("runtime-invocation-count"),
                  catch: (cause) =>
                    new HarnessRequestFacetError("Fixture invocation count could not be read.", {
                      cause,
                    }),
                });
                const invocationCount = previousInvocationCount ?? 0;
                yield* Effect.tryPromise({
                  try: () => input.ctx.storage.put("runtime-invocation-count", invocationCount + 1),
                  catch: (cause) =>
                    new HarnessRequestFacetError("Fixture invocation count could not be stored.", {
                      cause,
                    }),
                });
                const supervisor = input.env.HARNESS_THREAD_SUPERVISOR.getByName(
                  "process-invocation-reply-loss-run",
                );
                yield* Effect.tryPromise({
                  try: () => supervisor.holdRequestRuntime(),
                  catch: (cause) =>
                    new HarnessRequestFacetError("Fixture runtime barrier failed.", { cause }),
                });
                return {
                  status: "completed" as const,
                  result: processFacetArtifact,
                  checkpoint: invocationReplyLossCheckpoint,
                };
              }),
          },
        };
      }),
    open: () => Effect.die("A retained prepared runtime must not reopen from the RunStore."),
  });
});

export class TestHarnessProcessRunStoreRequestFacetObject extends RunStoreRequestFacet {
  override async run(input: {
    readonly publisher: HarnessRequestPublisher;
    readonly requestId: string;
  }): Promise<HarnessRunStoreResult> {
    const attempts = (await this.ctx.storage.get<number>("request-run-attempts")) ?? 0;
    await this.ctx.storage.put("request-run-attempts", attempts + 1);
    return await super.run(input);
  }

  override async dispose(expectedFacetNonce: string) {
    const attempts = (await this.ctx.storage.get<number>("dispose-attempts")) ?? 0;
    await this.ctx.storage.put("dispose-attempts", attempts + 1);
    await super.dispose(expectedFacetNonce);
    await this.ctx.storage.put("disposed", true);
  }

  async lifecycleObserved() {
    return {
      prepareCalls: (await this.ctx.storage.get<number>("prepare-inert-calls")) ?? 0,
      runtimeInvocationCount: (await this.ctx.storage.get<number>("runtime-invocation-count")) ?? 0,
      preparedRuntimeClosed:
        (await this.ctx.storage.get<boolean>("prepared-runtime-closed")) === true,
      disposeAttempts: (await this.ctx.storage.get<number>("dispose-attempts")) ?? 0,
      disposed: (await this.ctx.storage.get<boolean>("disposed")) === true,
      runStoreActions: (await this.ctx.storage.get<readonly string[]>("run-store-actions")) ?? [],
      runAttempts: (await this.ctx.storage.get<number>("request-run-attempts")) ?? 0,
    };
  }
}
