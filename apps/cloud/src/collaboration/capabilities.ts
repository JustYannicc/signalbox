import type { CollaborationInput } from "@t3tools/contracts/signalboxCollaboration";
import { providerChildTasks } from "@t3tools/shared/providerChildTasks";
import * as Effect from "effect/Effect";

import { poolModelCatalog } from "../pool/poolModelCatalog.ts";
import { forThread } from "../thread/turnPool.ts";
import { UserPools } from "../user/UserPools.ts";
import { collaborationFailure, type CollaborationAccess } from "./access.ts";
import type { CollaborationService } from "./CloudCollaboration.ts";

export const makeCapabilities = (access: CollaborationAccess) =>
  Effect.gen(function* () {
    const pools = yield* UserPools;
    const capabilities: CollaborationService["capabilities"] = (
      source,
      _input: CollaborationInput<"capabilities">,
    ) =>
      Effect.gen(function* () {
        const caller = yield* access.source(source);
        const { thread } = caller.projection;
        const chain = yield* access.folders.turn({ threadId: source, projectId: thread.projectId });
        const poolId = forThread(chain.pools, thread.projectId);
        const state = (yield* pools.state(caller.actor)).filter(
          (entry) => entry.pool.id === poolId,
        );
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
      }).pipe(Effect.mapError(collaborationFailure));
    return capabilities;
  });
