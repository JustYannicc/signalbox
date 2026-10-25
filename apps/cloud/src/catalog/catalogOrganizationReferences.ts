import type { ReadContext, TransactionContext, WriteContext } from "@signalbox/sync/definition";
import type { ReadTable, Row } from "@signalbox/sync/table";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveCatalogAccess } from "./adapters/catalogRootPolicy.ts";
import { catalogHomeKey } from "./catalogHome.ts";
import type { CatalogLevelRef } from "./catalogHomeSchema.ts";
import {
  CatalogOrganizationReferenceRow,
  CatalogOrganizationTopRef,
  CatalogPersonalLevelRef,
  type catalogPersonalTables,
} from "./catalogPersonalTables.ts";
import {
  type CatalogPersonalRoot,
  type CatalogPolicyActor,
  CatalogPolicyFailure,
  CatalogPolicyTarget,
} from "./catalogPolicy.ts";

type Tables = typeof catalogPersonalTables;
type Actor = typeof CatalogPolicyActor.Type;
type Home = typeof CatalogPersonalRoot.Type;
export type CatalogPersonalReadContext = ReadContext<Tables, Actor, Home>;
export type CatalogPersonalWriteContext = TransactionContext<Tables, Actor, Home>;
export type CatalogPersonalProjectionContext = WriteContext<Tables, Home>;

const OrganizationId = CatalogOrganizationReferenceRow.fields.organizationId;
const Placement = Schema.Struct({
  target: CatalogOrganizationTopRef,
  filedUnder: CatalogPersonalLevelRef,
});

/** `after` is the last organization of the previous page. */
export const CatalogListReferencePlacements = Schema.Struct({
  after: Schema.NullOr(OrganizationId),
});
export const CatalogReferencePlacements = Schema.Struct({
  placements: Schema.Array(Placement),
  next: Schema.NullOr(OrganizationId),
});
// The target pins the organization incarnation the caller's org policy check approved.
export const CatalogMoveOrganizationReference = Placement;
export const CatalogEnsureOrganizationReference = Schema.Struct({
  // The member's personal root incarnation the membership authority delivers into.
  incarnation: CatalogPolicyTarget.fields.incarnation,
  target: CatalogOrganizationTopRef,
});

const PAGE_SIZE = 100;
const denied = () => Effect.fail(new CatalogPolicyFailure({ reason: "denied" }));
const invalidState = () => Effect.fail(new CatalogPolicyFailure({ reason: "invalid_state" }));

type LevelRef = typeof CatalogLevelRef.Type;
type Reference = Row<Tables["organizationReferences"]>;
type ReferenceReader = {
  readonly home: Home;
  readonly tables: {
    readonly organizationReferences: ReadTable<Tables["organizationReferences"]>;
  };
};

const sameLevel = (a: LevelRef, b: LevelRef) =>
  a.incarnation === b.incarnation && catalogHomeKey(a.home) === catalogHomeKey(b.home);

const isCorrupt = (ctx: ReferenceReader, row: Reference, rootIncarnation: number) =>
  row.incarnation !== rootIncarnation || row.filedUnder.home.owner.id !== ctx.home.owner.id;

const readReference = (
  ctx: ReferenceReader,
  organizationId: Reference["organizationId"],
  rootIncarnation: number,
) =>
  Effect.gen(function* () {
    const found = yield* ctx.tables.organizationReferences.get(organizationId);
    if (Option.isNone(found)) return undefined;
    if (found.value.organizationId !== organizationId) return yield* invalidState();
    if (isCorrupt(ctx, found.value, rootIncarnation)) return yield* invalidState();
    return found.value;
  });

/** Only the personal root's owner files references, and only into a live level of that root. */
const resolveOwner = (
  ctx: CatalogPersonalReadContext,
  level: typeof CatalogPersonalLevelRef.Type,
) =>
  Effect.gen(function* () {
    if (level.home.owner.id !== ctx.home.owner.id) return yield* denied();
    const access = yield* resolveCatalogAccess(ctx, {
      folderId: level.home.level._tag === "top" ? null : level.home.level.id,
      incarnation: level.incarnation,
    });
    if (access.role !== "Owner") return yield* denied();
    return access;
  });

/*
 * Raw filing, internal to the catalog. A personal home cannot see organization authority, so a
 * stored reference proves nothing about access: the public Catalog service must check the
 * organization root's policy on every list, open and move, and hide denied or stale targets.
 * Placements under a retired folder stay as stored; the public view hides them, never moves them.
 */

const referencePlacements = (
  ctx: CatalogPersonalReadContext,
  input: typeof CatalogListReferencePlacements.Type,
) =>
  Effect.gen(function* () {
    const state = yield* ctx.tables.state.get("state");
    if (Option.isNone(state)) return yield* invalidState();
    const access = yield* resolveCatalogAccess(ctx, {
      folderId: null,
      incarnation: state.value.level.incarnation,
    });
    if (access.role !== "Owner") return yield* denied();
    const incarnation = access.state.level.incarnation;
    const page = yield* ctx.tables.organizationReferences.page("byIncarnation", {
      prefix: [incarnation],
      ...(input.after === null ? {} : { range: { from: input.after } }),
      limit: PAGE_SIZE,
    });
    const placements: Array<typeof Placement.Type> = [];
    for (const row of page.rows) {
      if (isCorrupt(ctx, row, incarnation)) return yield* invalidState();
      if (row.organizationId === input.after) continue;
      placements.push({ target: row.target, filedUnder: row.filedUnder });
    }
    const last = page.rows.at(-1);
    return {
      placements,
      next: page.after === undefined || last === undefined ? null : last.organizationId,
    };
  });

const moveOrganizationReference = (
  ctx: CatalogPersonalWriteContext,
  input: typeof CatalogMoveOrganizationReference.Type,
) =>
  Effect.gen(function* () {
    const access = yield* resolveOwner(ctx, input.filedUnder);
    const existing = yield* readReference(
      ctx,
      input.target.home.owner.id,
      access.state.level.incarnation,
    );
    // Only the membership authority creates references or advances their target.
    if (existing === undefined || !sameLevel(existing.target, input.target)) {
      return yield* denied();
    }
    if (sameLevel(existing.filedUnder, input.filedUnder)) return { changed: false };
    if (access.state.revision === Number.MAX_SAFE_INTEGER) return yield* invalidState();
    // Filing changes nobody's access: no topology revision, auth epoch or fence.
    yield* ctx.tables.organizationReferences.patch(existing.organizationId, {
      filedUnder: input.filedUnder,
    });
    yield* ctx.tables.state.patch("state", { revision: access.state.revision + 1 });
    return { changed: true };
  });

/**
 * Trusted membership fan-in. Repeats and older organization incarnations are no-ops; a newer
 * one keeps the member's filing. Removal never calls this, so a rejoin finds its old placement.
 */
const ensureOrganizationReference = (
  ctx: CatalogPersonalProjectionContext,
  input: typeof CatalogEnsureOrganizationReference.Type,
) =>
  Effect.gen(function* () {
    const stateResult = yield* ctx.tables.state.get("state");
    const rootResult = yield* ctx.tables.root.get("root");
    if (Option.isNone(stateResult) || Option.isNone(rootResult)) return yield* invalidState();
    const state = stateResult.value;
    if (
      catalogHomeKey(state.level.home) !== catalogHomeKey(ctx.home) ||
      state.level.incarnation !== input.incarnation ||
      state.storageState !== "open"
    ) {
      return yield* invalidState();
    }

    const organizationId = input.target.home.owner.id;
    const existing = yield* readReference(ctx, organizationId, state.level.incarnation);
    if (existing !== undefined && input.target.incarnation <= existing.target.incarnation) {
      return { changed: false };
    }
    if (state.revision === Number.MAX_SAFE_INTEGER) return yield* invalidState();

    const row: Reference = {
      organizationId,
      incarnation: state.level.incarnation,
      target: input.target,
      filedUnder: existing?.filedUnder ?? { home: ctx.home, incarnation: state.level.incarnation },
    };
    yield* existing === undefined
      ? ctx.tables.organizationReferences.insert(row)
      : ctx.tables.organizationReferences.replace(organizationId, row);
    yield* ctx.tables.state.patch("state", { revision: state.revision + 1 });
    return { changed: true };
  });

export const catalogOrganizationReferences = {
  referencePlacements,
  moveOrganizationReference,
  ensureOrganizationReference,
};
