import type { ReadContext, TransactionContext, WriteContext } from "@signalbox/sync/definition";
import type { Row } from "@signalbox/sync/table";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { catalogAccessResolver, type CatalogBaseline } from "./adapters/catalogRootPolicy.ts";
import { type CatalogHome, CatalogPersonId, catalogHomeKey } from "./catalogHome.ts";
import { CatalogRootHome } from "./catalogHomeSchema.ts";
import {
  CatalogRoleSlugs,
  type catalogOrganizationTables,
  normalizeRoleSlugs,
} from "./catalogOrganizationTables.ts";
import {
  CatalogPolicyActor,
  CatalogPolicyFailure,
  CatalogPolicyTarget,
  type CatalogRole,
} from "./catalogPolicy.ts";

type OrganizationRoot = typeof CatalogRootHome.Type & {
  readonly owner: Extract<CatalogHome["owner"], { readonly _tag: "organization" }>;
};

/** One canonical tree per organization; legacy per-user copies stay outside it (#871). */
export const CatalogOrganizationRoot = CatalogRootHome.pipe(
  Schema.refine(
    (home): home is OrganizationRoot =>
      home.owner._tag === "organization" && home.legacySource === undefined,
    { identifier: "CatalogOrganizationRoot" },
  ),
);

type Tables = typeof catalogOrganizationTables;
type Actor = typeof CatalogPolicyActor.Type;
type Home = typeof CatalogOrganizationRoot.Type;
export type CatalogOrganizationReadContext = ReadContext<Tables, Actor, Home>;
export type CatalogOrganizationWriteContext = TransactionContext<Tables, Actor, Home>;
export type CatalogOrganizationProjectionContext = WriteContext<Tables, Home>;

const denied = () => Effect.fail(new CatalogPolicyFailure({ reason: "denied" }));
const invalidState = () => Effect.fail(new CatalogPolicyFailure({ reason: "invalid_state" }));

const adminSlugs = new Set(["admin", "owner"]);

/** Organization ownership is never a person's: the strongest membership baseline is Admin. */
export const membershipRole = (
  roleSlugs: ReadonlyArray<string> | null,
): Extract<CatalogRole, "Admin" | "Viewer"> | null =>
  roleSlugs === null ? null : roleSlugs.some((slug) => adminSlugs.has(slug)) ? "Admin" : "Viewer";

/** Current membership is required even for direct grants; grants only add to its baseline. */
export const resolveOrganizationAccess = catalogAccessResolver<CatalogOrganizationReadContext>({
  owner: "organization",
  baseline: (ctx, state) =>
    Effect.gen(function* () {
      const membership = yield* ctx.tables.memberships.get(ctx.actor.userId);
      if (Option.isNone(membership)) return yield* denied();
      const row = membership.value;
      if (row.personId !== ctx.actor.userId || row.incarnation !== state.level.incarnation) {
        return yield* invalidState();
      }
      const floor = membershipRole(row.roleSlugs);
      if (floor === null) return yield* denied();
      return { _tag: "Grants", floor } satisfies CatalogBaseline;
    }),
});

const Incarnation = CatalogPolicyTarget.fields.incarnation;

export const CatalogOrganizationBootstrap = Schema.Struct({ incarnation: Incarnation });
export const CatalogMembershipDelivery = Schema.Struct({
  incarnation: Incarnation,
  personId: CatalogPersonId,
  // Monotonic per person, issued by the membership authority (WorkOS webhook projection).
  sourceRevision: Incarnation,
  // Null removes the person from the organization.
  roleSlugs: Schema.NullOr(CatalogRoleSlugs),
});

const readRoot = (ctx: CatalogOrganizationProjectionContext) =>
  Effect.gen(function* () {
    const state = yield* ctx.tables.state.get("state");
    const root = yield* ctx.tables.root.get("root");
    return { state: Option.getOrUndefined(state), root: Option.getOrUndefined(root) };
  });

const matchesHome = (
  ctx: CatalogOrganizationProjectionContext,
  state: Row<Tables["state"]>,
  incarnation: number,
) =>
  catalogHomeKey(state.level.home) === catalogHomeKey(ctx.home) &&
  state.level.incarnation === incarnation;

/**
 * Trusted, idempotent root initialization. It never adopts or overwrites existing rows,
 * and repeating it on a retired root leaves the root retired.
 */
export const bootstrapOrganizationRoot = (
  ctx: CatalogOrganizationProjectionContext,
  input: typeof CatalogOrganizationBootstrap.Type,
) =>
  Effect.gen(function* () {
    const { state, root } = yield* readRoot(ctx);
    if (state !== undefined && root !== undefined) {
      if (!matchesHome(ctx, state, input.incarnation)) return yield* invalidState();
      return { changed: false };
    }
    if (state !== undefined || root !== undefined) return yield* invalidState();
    const folders = yield* ctx.tables.folders.page("byParent", { limit: 1 });
    const grants = yield* ctx.tables.grants.page("byPerson", { limit: 1 });
    const memberships = yield* ctx.tables.memberships.page("byIncarnation", { limit: 1 });
    if (folders.rows.length > 0 || grants.rows.length > 0 || memberships.rows.length > 0) {
      return yield* invalidState();
    }

    yield* ctx.tables.state.insert({
      key: "state",
      level: { home: ctx.home, incarnation: input.incarnation },
      revision: 0,
      storageState: "open",
    });
    yield* ctx.tables.root.insert({ key: "root", topologyRevision: 0, authEpoch: 0 });
    return { changed: true };
  });

const sameSlugs = (a: ReadonlyArray<string> | null, b: ReadonlyArray<string> | null) =>
  a === null || b === null
    ? a === b
    : a.length === b.length && a.every((slug, at) => slug === b[at]);

/**
 * Applies one membership delivery. Older revisions are ignored, a conflicting replay of the
 * same revision is corrupt, and any change to the effective role fences the root.
 */
export const syncOrganizationMembership = (
  ctx: CatalogOrganizationProjectionContext,
  input: typeof CatalogMembershipDelivery.Type,
) =>
  Effect.gen(function* () {
    const { state, root } = yield* readRoot(ctx);
    if (state === undefined || root === undefined) return yield* invalidState();
    if (!matchesHome(ctx, state, input.incarnation)) return yield* invalidState();
    // A retired root no longer accepts authority; its rows stay as they were.
    if (state.storageState !== "open") return yield* invalidState();

    const roleSlugs = input.roleSlugs === null ? null : normalizeRoleSlugs(input.roleSlugs);
    const existing = Option.getOrUndefined(yield* ctx.tables.memberships.get(input.personId));
    if (existing !== undefined) {
      if (
        existing.personId !== input.personId ||
        existing.incarnation !== state.level.incarnation
      ) {
        return yield* invalidState();
      }
      if (input.sourceRevision < existing.sourceRevision) return { changed: false };
      if (input.sourceRevision === existing.sourceRevision) {
        if (!sameSlugs(existing.roleSlugs, roleSlugs)) return yield* invalidState();
        return { changed: false };
      }
    }

    const changesAccess = membershipRole(existing?.roleSlugs ?? null) !== membershipRole(roleSlugs);
    if (
      state.revision === Number.MAX_SAFE_INTEGER ||
      (changesAccess && root.authEpoch === Number.MAX_SAFE_INTEGER)
    ) {
      return yield* invalidState();
    }

    const row = {
      personId: input.personId,
      incarnation: state.level.incarnation,
      sourceRevision: input.sourceRevision,
      roleSlugs,
    };
    yield* existing === undefined
      ? ctx.tables.memberships.insert(row)
      : ctx.tables.memberships.replace(input.personId, row);
    yield* ctx.tables.state.patch("state", { revision: state.revision + 1 });
    if (changesAccess) {
      const epoch = root.authEpoch + 1;
      yield* ctx.tables.root.patch("root", { authEpoch: epoch });
      yield* ctx.requireAuthorizationFence({ scope: catalogHomeKey(ctx.home), epoch });
    }
    return { changed: true };
  });
