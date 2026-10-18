import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { LunoraError } from "lunorash/errors";

import { makeLunoraHome } from "@signalbox/sync/adapters/lunoraHome";
import { SyncFailure, type HomeBinding } from "@signalbox/sync/definition";

import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import { counterDefinition } from "../home.js";

type Actor = Schema.Schema.Type<typeof counterDefinition.actor>;
type Home = Schema.Schema.Type<typeof counterDefinition.home>;
type Permit = { readonly actorId: string; readonly epoch: 1; readonly levelId: string };

const levelFrom = (value: unknown): string | undefined =>
  typeof value === "object" &&
  value !== null &&
  "levelId" in value &&
  typeof value.levelId === "string"
    ? value.levelId
    : undefined;

const bindingFor = (levelId: string): HomeBinding<Actor, Home, never, Permit> => {
  const home: Home = { owner: "probe", levelId };
  return {
    home,
    authorization: {
      authorize: (actor, request) =>
        actor.levelId === home.levelId && levelFrom(request.input) === home.levelId
          ? Effect.succeed({ actorId: actor.userId, epoch: 1, levelId: home.levelId })
          : Effect.fail(new SyncFailure({ reason: "denied" })),
      isCurrent: (permit) => permit.levelId === home.levelId && permit.epoch === 1,
    },
    authorizeIngress: () => Effect.fail(new SyncFailure({ reason: "denied" })),
    // This probe has no revocation authority; any future fence remains closed.
    completion: { install: () => Effect.fail(new SyncFailure({ reason: "unavailable" })) },
  };
};

const runtimeFor = (levelId: string) =>
  makeLunoraHome(counterDefinition, bindingFor(levelId), {
    actorKey: (actor) => JSON.stringify([actor.userId, actor.levelId]),
    ingressKey: () => "probe",
    permitKey: (permit) => JSON.stringify([permit.actorId, permit.levelId, permit.epoch]),
  });

/** Derive actor and physical home only from Lunora's verified request identity. */
export const bind = async (ctx: QueryCtx | MutationCtx) => {
  const userId = ctx.auth.userId;
  const identity = await ctx.auth.getIdentity();
  if (userId === null || identity === null || typeof identity.levelId !== "string") {
    throw new LunoraError("FORBIDDEN", "A verified probe identity is required.");
  }

  const actor: Actor = { userId, levelId: identity.levelId };
  return { runtime: runtimeFor(identity.levelId), actor };
};
