import { decodeWireValue } from "@signalbox/sync/adapters/lunoraWireValue";
import { toLunoraReadContext } from "@signalbox/sync/adapters/lunoraContext";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { asLunoraSyncError } from "@signalbox/sync/adapters/lunoraHomeWire";
import * as Schema from "effect/Schema";
import { LunoraError } from "lunorash/errors";

import { catalogHomeKey } from "../catalogHome.ts";
import { nativeCatalogScope } from "../catalogObjects.ts";
import { CatalogPersonalRoot, CatalogPolicyActor } from "../catalogPolicy.ts";
import { catalogPersonalRuntime } from "../catalogRuntimeDefinition.ts";
import { resolveCatalogRuntimePolicy } from "../catalogRuntimePolicy.ts";
import { runtimePorts } from "./env.ts";
import { query, v } from "./_generated/server.js";

const decodeHome = Schema.decodeUnknownSync(CatalogPersonalRoot);
const decodeActor = Schema.decodeUnknownSync(CatalogPolicyActor);

/** Native delivery checks re-read committed policy; only the physical object's private caller uses this. */
export const deliveryPermit = query
  .input({ userId: v.string(), functionPath: v.string(), args: v.any() })
  .output(v.object({ scope: v.string(), epoch: v.number() }))
  .query(async ({ ctx, args }) => {
    if (ctx.auth.userId !== args.userId)
      throw new LunoraError("FORBIDDEN", "Catalog actor mismatch.");
    const home = decodeHome(await runtimePorts(ctx.env).home());
    const operation = args.functionPath.startsWith("personal:view_")
      ? args.functionPath.slice("personal:view_".length)
      : args.functionPath.startsWith("personal:change_")
        ? args.functionPath.slice("personal:change_".length)
        : undefined;
    const op =
      operation === "access"
        ? catalogPersonalRuntime.views.access
        : operation === "setGrant"
          ? catalogPersonalRuntime.changes.setGrant
          : operation === "renameFolder"
            ? catalogPersonalRuntime.changes.renameFolder
            : operation === "moveFolder"
              ? catalogPersonalRuntime.changes.moveFolder
              : undefined;
    if (
      op === undefined ||
      operation === undefined ||
      typeof args.args !== "object" ||
      args.args === null ||
      !("input" in args.args)
    ) {
      throw new LunoraError("FORBIDDEN", "Unknown Catalog operation.");
    }
    const input = await decodeWireValue(op.input, args.args.input, "invalid_input");
    const result = await Effect.runPromise(
      Effect.result(
        resolveCatalogRuntimePolicy(
          toLunoraReadContext(ctx).db,
          home,
          decodeActor({ userId: args.userId }),
          { operation, input },
        ),
      ),
    );
    if (Result.isFailure(result)) throw asLunoraSyncError(result.failure);
    return { scope: await nativeCatalogScope(catalogHomeKey(home)), epoch: result.success.epoch };
  });
