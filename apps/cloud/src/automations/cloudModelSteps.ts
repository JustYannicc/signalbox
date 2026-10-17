import { AutomationModelSteps } from "@signalbox/automations/host";
import { TransientFailure } from "@signalbox/automations/stepPolicy";
import { isRetryableStatus } from "@signalbox/automations/steps";
import { AutomationError, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ModelCompletion } from "../models/ModelCompletion.ts";
import { poolObjectName } from "../pool/PoolDirectory.ts";
import { currentProjectIds, folderOfProject, poolResolver } from "../user/folderTree.ts";
import { UserFolders } from "../user/UserFolders.ts";
import { UserStore } from "../user/UserStore.ts";

const isAutomationError = Schema.is(AutomationError);

/** Model steps act as the automation owner on the project's current pool chain. */
export const layer = Layer.effect(
  AutomationModelSteps,
  Effect.gen(function* () {
    const folders = yield* UserFolders;
    const store = yield* UserStore;
    const models = yield* ModelCompletion;
    return AutomationModelSteps.of({
      complete: ({ projectId, modelSelection, prompt }) =>
        Effect.gen(function* () {
          const profile = yield* store.profile;
          if (profile === null)
            return yield* new AutomationError({ message: "This account has no profile." });
          const { tree, contexts } = yield* folders.state;
          const project = ProjectId.make(projectId);
          if (!currentProjectIds(contexts).includes(project))
            return yield* new AutomationError({
              message: "You no longer have access to this folder.",
            });
          const home = folderOfProject(tree, project);
          const pool = poolResolver(tree)(home);
          if (pool === null)
            return yield* new AutomationError({
              message: "This folder needs a pool. Choose one for it or a folder above it.",
            });
          return yield* models.complete({
            pool: {
              objectName: poolObjectName(profile.id, pool.poolId),
              userId: profile.id,
            },
            modelSelection,
            prompt,
          });
        }).pipe(
          Effect.mapError((cause) => {
            if (isAutomationError(cause)) return cause;
            const retryable =
              cause._tag === "ModelCompletionError" &&
              (cause.code === "pool-unavailable" ||
                (cause.code === "http-error" &&
                  cause.status !== undefined &&
                  isRetryableStatus(cause.status)));
            return new AutomationError({
              message: cause.message,
              cause: retryable
                ? new TransientFailure(cause.message, { cause, retryAfterMs: cause.retryAfterMs })
                : cause,
            });
          }),
        ),
    });
  }),
);
