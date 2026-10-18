import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { CatalogPersonId, catalogHomeKey } from "../catalogHome.ts";
import {
  CatalogGrantRole,
  CatalogPolicyFailure,
  CatalogPolicyTarget,
  type CatalogRootWriteContext,
} from "../catalogPolicy.ts";
import type { CatalogAccessResolver } from "./catalogRootPolicy.ts";

export const CatalogSetGrant = Schema.Struct({
  target: CatalogPolicyTarget,
  personId: CatalogPersonId,
  role: Schema.NullOr(CatalogGrantRole),
});

/** Grants change access, so every effective write advances the root's authorization epoch. */
export const setCatalogGrant =
  <Ctx extends CatalogRootWriteContext>(resolveAccess: CatalogAccessResolver<Ctx>) =>
  (ctx: Ctx, input: typeof CatalogSetGrant.Type) =>
    Effect.gen(function* () {
      const access = yield* resolveAccess(ctx, input.target);
      if (access.role !== "Owner" && access.role !== "Admin") {
        return yield* Effect.fail(new CatalogPolicyFailure({ reason: "denied" }));
      }
      const key = {
        folderId: input.target.folderId,
        incarnation: input.target.incarnation,
        personId: input.personId,
      };
      const existing = yield* ctx.tables.grants.get(key);
      if (
        (input.role === null && Option.isNone(existing)) ||
        (Option.isSome(existing) && existing.value.role === input.role)
      ) {
        return { changed: false };
      }
      if (
        access.root.authEpoch === Number.MAX_SAFE_INTEGER ||
        access.state.revision === Number.MAX_SAFE_INTEGER
      ) {
        return yield* Effect.fail(new CatalogPolicyFailure({ reason: "invalid_state" }));
      }

      if (input.role === null) {
        yield* ctx.tables.grants.delete(key);
      } else {
        const row = { ...key, role: input.role };
        yield* Option.isSome(existing)
          ? ctx.tables.grants.replace(key, row)
          : ctx.tables.grants.insert(row);
      }
      const epoch = access.root.authEpoch + 1;
      yield* ctx.tables.root.patch("root", { authEpoch: epoch });
      yield* ctx.tables.state.patch("state", { revision: access.state.revision + 1 });
      yield* ctx.requireAuthorizationFence({ scope: catalogHomeKey(ctx.home), epoch });
      return { changed: true };
    });
