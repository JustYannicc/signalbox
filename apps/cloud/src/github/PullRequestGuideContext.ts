import { PullRequestOperationError, type ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ModelCatalog from "../models/ModelCatalog.ts";
import { poolKindOfInstance, servesModel } from "../models/ModelRouting.ts";
import { poolObjectName } from "../pool/PoolDirectory.ts";
import {
  currentProjectIds,
  folderOfProject,
  instructionsOf,
  poolResolver,
} from "../user/folderTree.ts";
import * as UserDrives from "../user/UserDrives.ts";
import * as UserFolders from "../user/UserFolders.ts";
import * as UserModelSettings from "../user/UserModelSettings.ts";
import * as UserPools from "../user/UserPools.ts";

const failure = (reason: "permission" | "not-connected", detail: string) =>
  new PullRequestOperationError({ operation: "generateReviewGuide", reason, detail });
const contextError = (cause: unknown) =>
  new PullRequestOperationError({
    operation: "generateReviewGuide",
    detail: "Could not resolve this folder's guide settings and model pool.",
    cause,
  });
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));

export const makePullRequestGuideContext = Effect.gen(function* () {
  const drives = yield* UserDrives.UserDrives;
  const folders = yield* UserFolders.UserFolders;
  const settings = yield* UserModelSettings.UserModelSettings;
  const pools = yield* UserPools.UserPools;
  const catalog = yield* ModelCatalog.ModelCatalog;
  return (projectId: ProjectId) =>
    Effect.gen(function* () {
      const person = yield* drives.userId.pipe(Effect.mapError(contextError));
      if (person === null)
        return yield* failure("permission", "This folder is no longer available.");
      const { tree, contexts } = yield* folders.state.pipe(Effect.mapError(contextError));
      if (!currentProjectIds(contexts).includes(projectId))
        return yield* failure("permission", "This folder is no longer available.");
      const home = folderOfProject(tree, projectId);
      const pool = poolResolver(tree)(home);
      if (pool === null) return yield* failure("not-connected", "This folder needs a model pool.");
      const preference = yield* settings.snapshot.pipe(Effect.mapError(contextError));
      if (!preference.reviewGuidesEnabled)
        return yield* failure("permission", "Review guides are off.");
      const poolState = yield* pools.state({ userId: person }).pipe(Effect.mapError(contextError));
      const modelSelection = yield* catalog.initialSelection({
        pools: poolState,
        checkedAt: iso(yield* Clock.currentTimeMillis),
        poolId: pool.poolId,
        personDefault: preference.reviewGuideModelSelection ?? preference.defaultModelSelection,
      });
      const explicit = preference.reviewGuideModelSelection;
      const selectedKind =
        modelSelection === null ? undefined : poolKindOfInstance(modelSelection.instanceId);
      const destination = poolState.find((entry) => entry.pool.id === pool.poolId);
      if (
        modelSelection === null ||
        selectedKind === undefined ||
        destination === undefined ||
        !servesModel(selectedKind, destination.models, modelSelection.model) ||
        (explicit !== null &&
          (modelSelection.model !== explicit.model ||
            poolKindOfInstance(modelSelection.instanceId) !==
              poolKindOfInstance(explicit.instanceId)))
      ) {
        return yield* failure(
          "not-connected",
          "The review guide model is unavailable on this folder's pool.",
        );
      }

      return {
        modelSelection,
        pool: { objectName: poolObjectName(person, pool.poolId), userId: person },
        instructions: [
          ...instructionsOf(tree, home).map(({ label, text }) => `${label}:\n${text}`),
          preference.reviewGuideInstructions,
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
    });
});
