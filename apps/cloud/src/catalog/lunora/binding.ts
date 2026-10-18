import { makeLunoraHome } from "@signalbox/sync/adapters/lunoraHome";
import { toLunoraReadContext } from "@signalbox/sync/adapters/lunoraContext";
import { SyncFailure } from "@signalbox/sync/definition";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { LunoraError } from "lunorash/errors";

import { makeCatalogHomeBinding } from "../catalogBinding.ts";
import { catalogHomeKey } from "../catalogHome.ts";
import {
  catalogOrganizationRuntime,
  catalogPersonalRuntime,
  CatalogOrganizationRoot,
  CatalogPersonalRoot,
} from "../catalogRuntimeDefinition.ts";
import { resolveCatalogRuntimePolicy } from "../catalogRuntimePolicy.ts";
import type { MutationCtx, QueryCtx, ActionCtx } from "./_generated/server.js";
import { runtimePorts } from "./env.ts";

const decodePersonalHome = Schema.decodeUnknownSync(CatalogPersonalRoot);
const decodeOrganizationHome = Schema.decodeUnknownSync(CatalogOrganizationRoot);
const decodeActor = Schema.decodeUnknownSync(catalogPersonalRuntime.actor);

type RuntimeDefinition = typeof catalogPersonalRuntime | typeof catalogOrganizationRuntime;
type RuntimeContext = QueryCtx | MutationCtx | ActionCtx;

const runtimeForDefinition = async <Definition extends RuntimeDefinition>(
  ctx: RuntimeContext,
  home: Definition["home"]["Type"],
  definition: Definition,
  recoveryTarget: string,
) => {
  const ports = runtimePorts(ctx.env);
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
  const runtime = makeLunoraHome(definition, binding, {
    actorKey: (actor) => actor.userId,
    ingressKey: () => "catalog-runtime",
    permitKey: (permit) =>
      JSON.stringify([permit.scope, permit.actorId, permit.localEpoch, permit.target]),
    recoveryTarget,
  });
  return { runtime, ingress, home, client: ports.client() };
};

const requireVerifiedActor = async (
  ctx: QueryCtx | MutationCtx,
  home: typeof CatalogPersonalRoot.Type | typeof CatalogOrganizationRoot.Type,
) => {
  const identity = await ctx.auth.getIdentity();
  if (ctx.auth.userId === null || identity?.catalogHomeKey !== catalogHomeKey(home)) {
    throw new LunoraError("FORBIDDEN", "A verified Catalog caller is required.");
  }
  return decodeActor({ userId: ctx.auth.userId });
};

/** Only verified namespace callers supply the actor; generated RPC arguments never contain it. */
export const bind = async (ctx: QueryCtx | MutationCtx) => {
  const home = decodePersonalHome(await runtimePorts(ctx.env).home());
  const result = await runtimeForDefinition(
    ctx,
    home,
    catalogPersonalRuntime,
    "personalRecovery:sync_recoverFences",
  );
  return { ...result, actor: await requireVerifiedActor(ctx, home) };
};

/** Generated functions for the canonical organization root use the same native binding. */
export const bindOrganization = async (ctx: QueryCtx | MutationCtx) => {
  const home = decodeOrganizationHome(await runtimePorts(ctx.env).home());
  const result = await runtimeForDefinition(
    ctx,
    home,
    catalogOrganizationRuntime,
    "organizationRecovery:sync_recoverFences",
  );
  return { ...result, actor: await requireVerifiedActor(ctx, home) };
};

// Trusted projections are emitted as internal mutations and never receive a user actor.
export const bindProjection = async (ctx: MutationCtx) => {
  const home = decodePersonalHome(await runtimePorts(ctx.env).home());
  return runtimeForDefinition(
    ctx,
    home,
    catalogPersonalRuntime,
    "personalRecovery:sync_recoverFences",
  );
};

export const bindOrganizationProjection = async (ctx: MutationCtx) => {
  const home = decodeOrganizationHome(await runtimePorts(ctx.env).home());
  return runtimeForDefinition(
    ctx,
    home,
    catalogOrganizationRuntime,
    "organizationRecovery:sync_recoverFences",
  );
};

export const bindRecovery = async (ctx: RuntimeContext, requestedHome: unknown) => {
  const home = decodePersonalHome(await runtimePorts(ctx.env).home());
  if (catalogHomeKey(decodePersonalHome(requestedHome)) !== catalogHomeKey(home)) {
    throw new LunoraError("FORBIDDEN", "Catalog recovery must remain in its bound home.");
  }
  return runtimeForDefinition(
    ctx,
    home,
    catalogPersonalRuntime,
    "personalRecovery:sync_recoverFences",
  );
};

export const bindOrganizationRecovery = async (ctx: RuntimeContext, requestedHome: unknown) => {
  const home = decodeOrganizationHome(await runtimePorts(ctx.env).home());
  if (catalogHomeKey(decodeOrganizationHome(requestedHome)) !== catalogHomeKey(home)) {
    throw new LunoraError("FORBIDDEN", "Catalog recovery must remain in its bound home.");
  }
  return runtimeForDefinition(
    ctx,
    home,
    catalogOrganizationRuntime,
    "organizationRecovery:sync_recoverFences",
  );
};
