import type { CollaborationInput } from "@t3tools/contracts/signalboxCollaboration";
import type { ThreadId } from "@t3tools/contracts";
import { providerChildTasks } from "@t3tools/shared/providerChildTasks";
import * as Effect from "effect/Effect";

import { makePoolModelCatalog } from "../pool/poolModelCatalog.ts";
import { forThread } from "../thread/turnPool.ts";
import { UserPools } from "../user/UserPools.ts";
import type { CollaborationAccess } from "./access.ts";
import { CollaborationError } from "./errors.ts";

export const makeCapabilities = (access: CollaborationAccess) =>
  Effect.gen(function* () {
    const pools = yield* UserPools;
    const poolModelCatalog = yield* makePoolModelCatalog;
    const capabilities = (source: ThreadId, _input: CollaborationInput<"capabilities">) =>
      Effect.gen(function* () {
        const caller = yield* access.source(source);
        const { thread } = caller.projection;
        const chain = yield* access.folders
          .turn({ threadId: source, projectId: thread.projectId })
          .pipe(
            Effect.catchTags({
              ThreadHomeTrashedError: (cause) =>
                Effect.fail(
                  new CollaborationError({
                    code: "thread_not_found",
                    message: "Thread not found.",
                    operation: "read_model_home",
                    cause,
                  }),
                ),
              SqlError: (cause) =>
                Effect.fail(CollaborationError.unavailable("read_model_home", cause)),
            }),
          );
        const poolId = forThread(chain.pools, thread.projectId);
        const state = (yield* pools.state(caller.actor).pipe(
          Effect.catchTags({
            AccountHubRpcError: (cause) =>
              Effect.fail(CollaborationError.unavailable("read_model_pools", cause)),
          }),
        )).filter((entry) => entry.pool.id === poolId);
        const { providers } = yield* poolModelCatalog(state);
        return {
          parentThreadId: source,
          inheritedProviderInstanceId: thread.providerInstanceId,
          inheritedModel: thread.modelSelection.model,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          providers: providers.map((provider) => {
            const availability = providerChildTasks(provider);
            return {
              providerInstanceId: provider.instanceId,
              driverKind: provider.driver,
              displayName: provider.displayName ?? null,
              models: provider.models.map((model) => ({
                id: model.slug,
                label: model.name,
                ...(model.capabilities?.optionDescriptors === undefined
                  ? {}
                  : { options: model.capabilities.optionDescriptors }),
              })),
              runtimeModes: ["full-access" as const],
              canRunChildTask: availability.canRun,
              canRunCrossProviderChildTask: availability.canRun,
              constraints: [
                ...availability.constraints,
                "Cloud children have their own branch and inherit their parent's folder.",
              ],
            };
          }),
          features: {
            appOwnedSubagents: true,
            asyncPolling: true,
            cancellation: true,
            batchThreadCreation: false,
            threadManagement: true,
            incrementalThreadRead: true,
            scheduledTasks: true,
            maxBatchThreads: 1,
          },
        };
      });
    return capabilities;
  });
