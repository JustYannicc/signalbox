import { makeLunoraReadTables } from "@signalbox/sync/adapters/lunoraTables";
import { SyncFailure, tableErrorToSyncFailure, type SyncSchema } from "@signalbox/sync/definition";
import type { TableReadError } from "@signalbox/sync/table";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { DatabaseReader } from "lunorash/server";

import { resolveCatalogAccess } from "./adapters/catalogRootPolicy.ts";
import { catalogHomeKey } from "./catalogHome.ts";
import { CatalogPersonalLevelRef } from "./catalogPersonalTables.ts";
import { catalogOrganizationRoot } from "./catalogOrganizationRoot.ts";
import {
  CatalogOrganizationRoot as CatalogOrganizationRootSchema,
  resolveOrganizationAccess,
} from "./catalogOrganizationPolicy.ts";
import { catalogPersonalRoot } from "./catalogPersonalRoot.ts";
import { type CatalogRuntimeHome, CatalogRuntimeHomeSchema } from "./catalogRuntimeDefinition.ts";
import {
  CatalogPersonalRoot as CatalogPersonalRootSchema,
  CatalogPolicyActor,
  CatalogPolicyTarget,
  CatalogPolicyFailure,
} from "./catalogPolicy.ts";
import type { CatalogAccess } from "./adapters/catalogRootPolicy.ts";

type Actor = typeof CatalogPolicyActor.Type;
type Target = typeof CatalogPolicyTarget.Type;
type OperationShape = { readonly input: SyncSchema };
type OperationMap = Readonly<Record<string, OperationShape>>;
type FolderRow = typeof import("./catalogHomeSchema.ts").CatalogFolderRow.Type;
type FolderId = FolderRow["id"];
type ReadPolicy = (target: Target) => Effect.Effect<CatalogAccess, SyncFailure>;
type FolderLookup = (id: FolderId) => Effect.Effect<Option.Option<FolderRow>, SyncFailure>;
type RootTarget = () => Effect.Effect<Target, SyncFailure>;

const decodeTarget = Schema.decodeUnknownEffect(CatalogPolicyTarget);
const decodeRuntimeHome = Schema.decodeUnknownEffect(CatalogRuntimeHomeSchema);
const decodePersonalLevelRef = Schema.decodeUnknownEffect(CatalogPersonalLevelRef);
const isPolicyFailure = Schema.is(CatalogPolicyFailure);
const decodePersonalHome = Schema.decodeUnknownEffect(CatalogPersonalRootSchema);
const decodeOrganizationHome = Schema.decodeUnknownEffect(CatalogOrganizationRootSchema);
const decodeInput = (schema: SyncSchema, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => new SyncFailure({ reason: "invalid_input" })),
  );
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const denied = () => new SyncFailure({ reason: "denied" });
const invalidState = () => new SyncFailure({ reason: "invalid_state" });
const invalidInput = () => new SyncFailure({ reason: "invalid_input" });

const policyFailure = (error: unknown): SyncFailure => {
  if (isPolicyFailure(error)) return new SyncFailure({ reason: error.reason });
  return new SyncFailure({ reason: "unavailable" });
};

const readFailure = (error: TableReadError) => tableErrorToSyncFailure(error);

const requiredField = (input: unknown, field: string) =>
  isRecord(input) && Object.hasOwn(input, field) ? input[field] : undefined;

const operationInput = (views: OperationMap, changes: OperationMap, operation: string) => {
  if (Object.hasOwn(views, operation))
    return { kind: "view" as const, schema: views[operation]!.input };
  if (Object.hasOwn(changes, operation))
    return { kind: "change" as const, schema: changes[operation]!.input };
  return undefined;
};

const managerRole = (access: CatalogAccess) => access.role === "Owner" || access.role === "Admin";

const authorizeOperation = (options: {
  readonly operation: string;
  readonly rawInput: unknown;
  readonly views: OperationMap;
  readonly changes: OperationMap;
  readonly resolve: ReadPolicy;
  readonly rootTarget: RootTarget;
  readonly folder: FolderLookup;
  readonly referenceViews?: ReadonlySet<string>;
  readonly referenceChanges?: ReadonlySet<string>;
}) =>
  Effect.gen(function* () {
    const found = operationInput(options.views, options.changes, options.operation);
    // Projections are trusted internal ingress and have no user actor permit.
    if (found === undefined) return yield* Effect.fail(denied());
    const input = yield* decodeInput(found.schema, options.rawInput);

    const resolveTarget = (value: unknown) =>
      decodeTarget(value).pipe(Effect.mapError(() => invalidInput()));
    const requireAccess = (target: Target, requirement: "any" | "manager" | "owner") =>
      options.resolve(target).pipe(
        Effect.flatMap((access) => {
          if (
            requirement === "owner"
              ? access.role !== "Owner"
              : requirement === "manager" && !managerRole(access)
          ) {
            return Effect.fail(denied());
          }
          return Effect.succeed(access);
        }),
      );
    const targetField = (field: string) => resolveTarget(requiredField(input, field));
    const parentOf = (target: Target) =>
      Effect.gen(function* () {
        if (target.folderId === null) return yield* Effect.fail(denied());
        const foundFolder = yield* options.folder(target.folderId);
        if (Option.isNone(foundFolder) || foundFolder.value.incarnation !== target.incarnation) {
          return yield* Effect.fail(denied());
        }
        return {
          folderId: foundFolder.value.parentId,
          incarnation: foundFolder.value.parentIncarnation,
        } satisfies Target;
      });

    let access: CatalogAccess;
    if (found.kind === "view") {
      switch (options.operation) {
        case "access":
          access = yield* requireAccess(yield* resolveTarget(input), "any");
          break;
        case "children":
          access = yield* requireAccess(yield* targetField("parent"), "any");
          break;
        case "referencePlacements":
          if (!options.referenceViews?.has(options.operation)) return yield* Effect.fail(denied());
          access = yield* requireAccess(yield* options.rootTarget(), "owner");
          break;
        default:
          return yield* Effect.fail(denied());
      }
    } else {
      switch (options.operation) {
        case "createFolder":
          access = yield* requireAccess(yield* targetField("parent"), "manager");
          break;
        case "retireFolder":
        case "reopenFolder": {
          // Lifecycle handlers authorize through the persisted parent, including reopen of a
          // retired folder whose own target is no longer accessible.
          const target = yield* targetField("target");
          access = yield* requireAccess(yield* parentOf(target), "manager");
          break;
        }
        case "renameFolder":
          access = yield* requireAccess(yield* targetField("target"), "manager");
          break;
        case "moveFolder": {
          const target = yield* targetField("target");
          const parent = yield* targetField("parent");
          const source = yield* requireAccess(target, "manager");
          access = yield* requireAccess(parent, "manager");
          if (target.folderId === null) return yield* Effect.fail(denied());
          const foundFolder = yield* options.folder(target.folderId);
          if (Option.isNone(foundFolder) || foundFolder.value.incarnation !== target.incarnation) {
            return yield* Effect.fail(denied());
          }
          if (
            foundFolder.value.parentId !== parent.folderId ||
            foundFolder.value.parentIncarnation !== parent.incarnation
          ) {
            yield* requireAccess(yield* parentOf(target), "manager");
          }
          access = source;
          break;
        }
        case "setGrant":
          access = yield* requireAccess(yield* targetField("target"), "manager");
          break;
        case "moveOrganizationReference": {
          if (!options.referenceChanges?.has(options.operation))
            return yield* Effect.fail(denied());
          const filedUnder = yield* decodePersonalLevelRef(requiredField(input, "filedUnder")).pipe(
            Effect.mapError(() => invalidInput()),
          );
          const target: Target = {
            folderId: filedUnder.home.level._tag === "top" ? null : filedUnder.home.level.id,
            incarnation: filedUnder.incarnation,
          };
          access = yield* requireAccess(target, "owner");
          break;
        }
        default:
          return yield* Effect.fail(denied());
      }
    }

    return { epoch: access.root.authEpoch };
  });

const personalPolicy = (
  db: DatabaseReader,
  home: Extract<CatalogRuntimeHome, { readonly owner: { readonly _tag: "person" } }>,
  actor: Actor,
  request: { readonly operation: string; readonly input: unknown },
) => {
  const tables = makeLunoraReadTables(catalogPersonalRoot.tables, db);
  const context = { actor, home, tables };
  const resolve = (target: Target) =>
    resolveCatalogAccess(context, target).pipe(Effect.mapError(policyFailure));
  const rootTarget = () =>
    Effect.gen(function* () {
      const state = yield* tables.state.get("state").pipe(Effect.mapError(readFailure));
      if (Option.isNone(state) || catalogHomeKey(state.value.level.home) !== catalogHomeKey(home)) {
        return yield* Effect.fail(invalidState());
      }
      return { folderId: null, incarnation: state.value.level.incarnation } satisfies Target;
    });
  const folder = (id: FolderId) => tables.folders.get(id).pipe(Effect.mapError(readFailure));
  return authorizeOperation({
    operation: request.operation,
    rawInput: request.input,
    views: catalogPersonalRoot.views,
    changes: catalogPersonalRoot.changes,
    resolve,
    rootTarget,
    folder,
    referenceViews: new Set(["referencePlacements"]),
    referenceChanges: new Set(["moveOrganizationReference"]),
  });
};

const organizationPolicy = (
  db: DatabaseReader,
  home: Extract<CatalogRuntimeHome, { readonly owner: { readonly _tag: "organization" } }>,
  actor: Actor,
  request: { readonly operation: string; readonly input: unknown },
) => {
  const tables = makeLunoraReadTables(catalogOrganizationRoot.tables, db);
  const context = { actor, home, tables };
  const resolve = (target: Target) =>
    resolveOrganizationAccess(context, target).pipe(Effect.mapError(policyFailure));
  const rootTarget = () =>
    Effect.gen(function* () {
      const state = yield* tables.state.get("state").pipe(Effect.mapError(readFailure));
      if (Option.isNone(state) || catalogHomeKey(state.value.level.home) !== catalogHomeKey(home)) {
        return yield* Effect.fail(invalidState());
      }
      return { folderId: null, incarnation: state.value.level.incarnation } satisfies Target;
    });
  const folder = (id: FolderId) => tables.folders.get(id).pipe(Effect.mapError(readFailure));
  return authorizeOperation({
    operation: request.operation,
    rawInput: request.input,
    views: catalogOrganizationRoot.views,
    changes: catalogOrganizationRoot.changes,
    resolve,
    rootTarget,
    folder,
  });
};

/** Policy reads stay in Lunora's native transaction and use its local membership projection. */
export const resolveCatalogRuntimePolicy = (
  db: DatabaseReader,
  home: CatalogRuntimeHome,
  actor: Actor,
  request: { readonly operation: string; readonly input: unknown },
) => {
  const canonicalHome = decodeRuntimeHome(home).pipe(Effect.mapError(() => invalidState()));
  return Effect.gen(function* () {
    const decodedHome = yield* canonicalHome;
    if (decodedHome.owner._tag === "person") {
      const personalHome = yield* decodePersonalHome(decodedHome).pipe(
        Effect.mapError(() => invalidState()),
      );
      return yield* personalPolicy(db, personalHome, actor, request);
    }
    const organizationHome = yield* decodeOrganizationHome(decodedHome).pipe(
      Effect.mapError(() => invalidState()),
    );
    return yield* organizationPolicy(db, organizationHome, actor, request);
  });
};
