import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import * as Platform from "../../../platform.ts";
import { makeMemoryObjects } from "../../../attachments/attachmentTesting.ts";
import { layerAttachments } from "../../../testing.ts";
import { makeMemoryPools } from "../../../pool/testing.ts";
import * as PoolDirectory from "../../../pool/PoolDirectory.ts";
import { ThreadContexts } from "../../../user/threadContexts.ts";
import * as ThreadKindTurns from "../../../thread/ThreadKindTurns.ts";
import * as StandaloneThread from "../../../thread/StandaloneThread.ts";
import { SearchSettings } from "../../../search/searchSettings.ts";

export const threadActor = { userId: "recorded-owner", contextIds: [PERSONAL_CONTEXT_ID] };

export const threadPlatform = Effect.gen(function* () {
  const pools = makeMemoryPools();
  const poolName = PoolDirectory.poolObjectName(threadActor.userId, PERSONAL_POOL_ID);
  const object = pools.objectFor(poolName);
  yield* Effect.addFinalizer(() => Effect.promise(() => object.runtime.dispose()));
  object.cliProxyApi.catalog.claude!.push({
    id: "claude-sonnet-4-6",
    created: 1,
    displayName: "Recorded Claude",
    reasoningEfforts: [],
  });
  const pool = pools.directory.forPool(poolName);
  yield* pool.create({ userId: threadActor.userId }, { name: "Recorded", personal: true });
  const login = yield* pool.startLogin({ userId: threadActor.userId }, "claude");
  yield* pool.completeLogin(
    { userId: threadActor.userId },
    `http://localhost/callback?code=recorded&state=${login.state}`,
  );
  yield* pool.loginStatus({ userId: threadActor.userId }, login.state);
  const platform = Layer.mergeAll(
    Platform.layerCrypto,
    Layer.succeed(PoolDirectory.PoolDirectory, pools.directory),
    layerAttachments(makeMemoryObjects()),
    ThreadKindTurns.layerNone,
    Layer.succeed(SearchSettings, { generation: "recorded", disabled: true }),
    Layer.succeed(StandaloneThread.ThreadDrives, {
      enabled: false,
      writes: () => Effect.succeed(false),
      commitAuthor: () => Effect.succeed(null),
    }),
    Layer.succeed(StandaloneThread.ThreadSecrets, { token: () => Effect.succeed(null) }),
    Layer.succeed(ThreadContexts, {
      initialModelSelection: () => Effect.succeed(null),
      placeOfProject: () =>
        Effect.succeed({
          contextId: PERSONAL_CONTEXT_ID,
          driveId: "recorded-drive",
          remote: false,
        }),
      turn: () =>
        Effect.succeed({
          pools: { top: PERSONAL_POOL_ID, projects: {} },
          instructions: { top: [], projects: {} },
          secrets: { top: [], projects: {} },
        }),
    }),
  );
  return { platform, pool };
});
