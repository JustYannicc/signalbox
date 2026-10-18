import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { LunoraError } from "lunorash/errors";

import { makeLunoraHome } from "@signalbox/sync/adapters/lunoraHome";
import type { HomeBinding } from "@signalbox/sync/definition";

import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { counterDefinition } from "./home.js";

type Actor = Schema.Schema.Type<typeof counterDefinition.actor>;
type Home = Schema.Schema.Type<typeof counterDefinition.home>;
type Permit = { readonly userId: string };

const bindingFor = (actor: Actor, home: Home): HomeBinding<Actor, Home, string, Permit> => ({
  home,
  authorization: {
    authorize: (currentActor) => Effect.succeed({ userId: currentActor.userId }),
    isCurrent: (permit) => permit.userId === actor.userId,
  },
  authorizeIngress: () => Effect.void,
  completion: { install: () => Effect.void },
});

const runtimeFor = (actor: Actor, home: Home) =>
  makeLunoraHome(counterDefinition, bindingFor(actor, home), {
    actorKey: (value) => value.userId,
    ingressKey: (value) => value,
    permitKey: (value) => value.userId,
  });

const actorFor = async (ctx: QueryCtx | MutationCtx): Promise<Actor> => {
  const userId = ctx.auth.userId;
  if (userId === null) throw new LunoraError("FORBIDDEN", "Sign in first");
  return { userId };
};

export async function bind(ctx: QueryCtx | MutationCtx) {
  const actor = await actorFor(ctx);
  const home = { id: `home:${actor.userId}` };
  return { runtime: runtimeFor(actor, home), actor };
}

export async function bindProjection(ctx: MutationCtx) {
  const actor = await actorFor(ctx);
  const home = { id: `home:${actor.userId}` };
  return { runtime: runtimeFor(actor, home), ingress: `user:${actor.userId}` };
}
