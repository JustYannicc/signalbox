import { makeLunoraReadTables } from "@signalbox/sync/adapters/lunoraTables";
import { SyncFailure } from "@signalbox/sync/definition";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DatabaseReader } from "lunorash/server";

import { resolveCatalogAccess } from "./adapters/catalogRootPolicy.ts";
import { catalogPersonalRoot } from "./catalogPersonalRoot.ts";
import { CatalogPersonalRoot, CatalogPolicyActor, CatalogPolicyTarget } from "./catalogPolicy.ts";

const decodeTarget = Schema.decodeUnknownEffect(CatalogPolicyTarget);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Policy reads use the handler's native database, including its staged mutation writes. */
export const resolveCatalogRuntimePolicy = (
  db: DatabaseReader,
  home: typeof CatalogPersonalRoot.Type,
  actor: typeof CatalogPolicyActor.Type,
  request: { readonly operation: string; readonly input: unknown },
) =>
  Effect.gen(function* () {
    const operation = request.operation;
    if (operation !== "access" && !Object.hasOwn(catalogPersonalRoot.changes, operation)) {
      return yield* Effect.fail(new SyncFailure({ reason: "denied" }));
    }
    const input = request.input;
    const target = yield* decodeTarget(
      operation === "access" ? input : isRecord(input) ? input.target : undefined,
    ).pipe(Effect.mapError(() => new SyncFailure({ reason: "invalid_input" })));
    const access = yield* resolveCatalogAccess(
      { actor, home, tables: makeLunoraReadTables(catalogPersonalRoot.tables, db) },
      target,
    ).pipe(
      Effect.mapError(
        (error) =>
          new SyncFailure({
            reason: error._tag === "CatalogPolicyFailure" ? error.reason : "unavailable",
          }),
      ),
    );
    if (operation !== "access" && access.role !== "Owner" && access.role !== "Admin") {
      return yield* Effect.fail(new SyncFailure({ reason: "denied" }));
    }
    return { epoch: access.root.authEpoch };
  });
