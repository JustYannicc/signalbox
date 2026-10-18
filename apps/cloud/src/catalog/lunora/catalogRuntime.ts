import { decodeWireValue } from "@signalbox/sync/adapters/lunoraWireValue";
import { toLunoraReadContext } from "@signalbox/sync/adapters/lunoraContext";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { LunoraError } from "lunorash/errors";

import { catalogHomeKey } from "../catalogHome.ts";
import { nativeCatalogScope } from "../catalogObjects.ts";
import { CatalogPersonalRoot, CatalogPolicyActor } from "../catalogPolicy.ts";
import { catalogPersonalRuntime } from "../catalogRuntimeDefinition.ts";
import { resolveCatalogRuntimePolicy } from "../catalogRuntimePolicy.ts";
import { runtimePorts } from "./env.ts";
import { internalQuery, v } from "./_generated/server.js";

const decodeHome = Schema.decodeUnknownSync(CatalogPersonalRoot);
const decodeActor = Schema.decodeUnknownSync(CatalogPolicyActor);

/** Native delivery checks re-read committed policy; only the physical object's private caller uses this. */
export const deliveryPermit = internalQuery
  .input({ userId: v.string(), functionPath: v.string(), args: v.any() })
  .output(v.object({ scope: v.string(), epoch: v.number() }))
  .query(async ({ ctx, args }) => {
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
    const { epoch } = await Effect.runPromise(
      resolveCatalogRuntimePolicy(
        toLunoraReadContext(ctx).db,
        home,
        decodeActor({ userId: args.userId }),
        { operation, input },
      ),
    );
    return { scope: await nativeCatalogScope(catalogHomeKey(home)), epoch };
  });
