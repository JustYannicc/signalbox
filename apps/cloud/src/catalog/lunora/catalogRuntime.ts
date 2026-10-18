import { decodeWireValue } from "@signalbox/sync/adapters/lunoraWireValue";
import { toLunoraReadContext } from "@signalbox/sync/adapters/lunoraContext";
import type { SyncSchema } from "@signalbox/sync/definition";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { asLunoraSyncError } from "@signalbox/sync/adapters/lunoraHomeWire";
import { LunoraError } from "lunorash/errors";

import { catalogHomeKey } from "../catalogHome.ts";
import { nativeCatalogScope } from "../catalogObjects.ts";
import { CatalogPolicyActor } from "../catalogPolicy.ts";
import {
  catalogOrganizationRuntime,
  catalogPersonalRuntime,
  CatalogRuntimeHomeSchema,
} from "../catalogRuntimeDefinition.ts";
import { resolveCatalogRuntimePolicy } from "../catalogRuntimePolicy.ts";
import { runtimePorts } from "./env.ts";
import { query, v } from "./_generated/server.js";

const decodeActor = Schema.decodeUnknownSync(CatalogPolicyActor);
const decodeRuntimeHome = Schema.decodeUnknownSync(CatalogRuntimeHomeSchema);

interface PermitOperation {
  readonly operation: string;
  readonly input: SyncSchema;
}

const personalPermitOperations: Readonly<Record<string, PermitOperation>> = {
  "personal:view_access": {
    operation: "access",
    input: catalogPersonalRuntime.views.access.input,
  },
  "personal:view_children": {
    operation: "children",
    input: catalogPersonalRuntime.views.children.input,
  },
  "personal:view_referencePlacements": {
    operation: "referencePlacements",
    input: catalogPersonalRuntime.views.referencePlacements.input,
  },
  "personal:change_createFolder": {
    operation: "createFolder",
    input: catalogPersonalRuntime.changes.createFolder.input,
  },
  "personal:change_retireFolder": {
    operation: "retireFolder",
    input: catalogPersonalRuntime.changes.retireFolder.input,
  },
  "personal:change_reopenFolder": {
    operation: "reopenFolder",
    input: catalogPersonalRuntime.changes.reopenFolder.input,
  },
  "personal:change_renameFolder": {
    operation: "renameFolder",
    input: catalogPersonalRuntime.changes.renameFolder.input,
  },
  "personal:change_moveFolder": {
    operation: "moveFolder",
    input: catalogPersonalRuntime.changes.moveFolder.input,
  },
  "personal:change_setGrant": {
    operation: "setGrant",
    input: catalogPersonalRuntime.changes.setGrant.input,
  },
  "personal:change_moveOrganizationReference": {
    operation: "moveOrganizationReference",
    input: catalogPersonalRuntime.changes.moveOrganizationReference.input,
  },
};

const organizationPermitOperations: Readonly<Record<string, PermitOperation>> = {
  "organization:view_access": {
    operation: "access",
    input: catalogOrganizationRuntime.views.access.input,
  },
  "organization:view_children": {
    operation: "children",
    input: catalogOrganizationRuntime.views.children.input,
  },
  "organization:change_createFolder": {
    operation: "createFolder",
    input: catalogOrganizationRuntime.changes.createFolder.input,
  },
  "organization:change_retireFolder": {
    operation: "retireFolder",
    input: catalogOrganizationRuntime.changes.retireFolder.input,
  },
  "organization:change_reopenFolder": {
    operation: "reopenFolder",
    input: catalogOrganizationRuntime.changes.reopenFolder.input,
  },
  "organization:change_renameFolder": {
    operation: "renameFolder",
    input: catalogOrganizationRuntime.changes.renameFolder.input,
  },
  "organization:change_moveFolder": {
    operation: "moveFolder",
    input: catalogOrganizationRuntime.changes.moveFolder.input,
  },
  "organization:change_setGrant": {
    operation: "setGrant",
    input: catalogOrganizationRuntime.changes.setGrant.input,
  },
};

const permitOperationFor = (home: ReturnType<typeof decodeRuntimeHome>, functionPath: string) =>
  home.owner._tag === "person"
    ? personalPermitOperations[functionPath]
    : organizationPermitOperations[functionPath];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Native in-object policy reads use the matching owner definition and never call the namespace. */
export const deliveryPermit = query
  .input({ userId: v.string(), functionPath: v.string(), args: v.any() })
  .output(v.object({ scope: v.string(), epoch: v.number() }))
  .query(async ({ ctx, args }) => {
    if (ctx.auth.userId !== args.userId)
      throw new LunoraError("FORBIDDEN", "Catalog actor mismatch.");
    const home = decodeRuntimeHome(await runtimePorts(ctx.env).home());
    const operation = permitOperationFor(home, args.functionPath);
    if (operation === undefined || !isRecord(args.args) || !Object.hasOwn(args.args, "input")) {
      throw new LunoraError("FORBIDDEN", "Unknown Catalog operation.");
    }
    const input = await decodeWireValue(operation.input, args.args.input, "invalid_input").catch(
      (error: unknown) => {
        throw asLunoraSyncError(error);
      },
    );
    const result = await Effect.runPromise(
      Effect.result(
        resolveCatalogRuntimePolicy(
          toLunoraReadContext(ctx).db,
          home,
          decodeActor({ userId: args.userId }),
          { operation: operation.operation, input },
        ),
      ),
    );
    if (Result.isFailure(result)) throw asLunoraSyncError(result.failure);
    return { scope: await nativeCatalogScope(catalogHomeKey(home)), epoch: result.success.epoch };
  });
