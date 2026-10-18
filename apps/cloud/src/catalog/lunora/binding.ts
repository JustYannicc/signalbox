import { makeLunoraHome } from "@signalbox/sync/adapters/lunoraHome";
import { toLunoraReadContext } from "@signalbox/sync/adapters/lunoraContext";
import { SyncFailure } from "@signalbox/sync/definition";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { LunoraError } from "lunorash/errors";

import { makeCatalogHomeBinding } from "../catalogBinding.ts";
import { catalogHomeKey } from "../catalogHome.ts";
import { CatalogPersonalRoot, CatalogPolicyActor } from "../catalogPolicy.ts";
import { catalogPersonalRuntime } from "../catalogRuntimeDefinition.ts";
import { resolveCatalogRuntimePolicy } from "../catalogRuntimePolicy.ts";
import type { MutationCtx, QueryCtx, ActionCtx } from "./_generated/server.js";
import { runtimePorts } from "./env.ts";

const decodeHome = Schema.decodeUnknownSync(CatalogPersonalRoot);
const decodeActor = Schema.decodeUnknownSync(CatalogPolicyActor);

const runtimeFor = async (ctx: QueryCtx | MutationCtx | ActionCtx) => {
  const ports = runtimePorts(ctx.env);
  const home = decodeHome(await ports.home());
  const { binding, ingress } = makeCatalogHomeBinding({
    home,
    resolvePolicy: (actor, request) =>
      "db" in ctx
        ? resolveCatalogRuntimePolicy(toLunoraReadContext(ctx).db, home, actor, request)
        : Effect.fail(new SyncFailure({ reason: "denied" })),
    isLocalEpochCurrent: (_scope, epoch) => epoch >= ports.currentEpoch(),
    installFence: (fence) =>
      Effect.tryPromise({
        try: () => ports.install(fence),
        catch: () => new SyncFailure({ reason: "unavailable" }),
      }),
  });
  const runtime = makeLunoraHome(catalogPersonalRuntime, binding, {
    actorKey: (actor) => actor.userId,
    ingressKey: () => "catalog-runtime",
    permitKey: (permit) =>
      JSON.stringify([permit.scope, permit.actorId, permit.localEpoch, permit.target]),
    recoveryTarget: "personalRecovery:sync_recoverFences",
  });
  return { runtime, ingress, home, client: ports.client() };
};

/** Only verified namespace callers supply the actor; generated RPC arguments never contain it. */
export const bind = async (ctx: QueryCtx | MutationCtx) => {
  const result = await runtimeFor(ctx);
  const identity = await ctx.auth.getIdentity();
  if (ctx.auth.userId === null || identity?.catalogHomeKey !== catalogHomeKey(result.home)) {
    throw new LunoraError("FORBIDDEN", "A verified Catalog caller is required.");
  }
  return { ...result, actor: decodeActor({ userId: ctx.auth.userId }) };
};

// This binder is imported only by generated internal mutations.
export const bindProjection = (ctx: MutationCtx) => runtimeFor(ctx);

export const bindRecovery = async (
  ctx: QueryCtx | MutationCtx | ActionCtx,
  requestedHome: unknown,
) => {
  const result = await runtimeFor(ctx);
  if (catalogHomeKey(decodeHome(requestedHome)) !== catalogHomeKey(result.home)) {
    throw new LunoraError("FORBIDDEN", "Catalog recovery must remain in its bound home.");
  }
  return result;
};
