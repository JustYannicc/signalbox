import { catalogPersonalRuntime as syncDefinition } from "../catalogRuntimeDefinition.ts";
import { bind as bindHome, bindProjection as bindProjectionHome } from "./binding.ts";
import * as Schema from "effect/Schema";
import {
  decodeWireValue,
  validateWireValue,
  type WireValue,
} from "@signalbox/sync/adapters/lunoraWireValue";
import { asLunoraSyncError } from "@signalbox/sync/adapters/lunoraHomeWire";
import { SyncFailure, SyncCursor, type SyncSchema } from "@signalbox/sync/definition";
import { toLunoraReadContext, toLunoraWriteContext } from "@signalbox/sync/adapters/lunoraContext";
import type { QueryCtx, MutationCtx } from "./_generated/server.js";
import { query, mutation, internalMutation, v } from "./_generated/server.js";

const isSyncFailure = Schema.is(SyncFailure);
const mapSyncFailure = async <A>(run: () => Promise<A>): Promise<A> => {
  try {
    return await run();
  } catch (error) {
    if (isSyncFailure(error)) throw asLunoraSyncError(error);
    throw error;
  }
};
const decodeInput = <S extends SyncSchema>(schema: S, value: unknown): Promise<S["Type"]> =>
  mapSyncFailure(() => decodeWireValue(schema, value, "invalid_input"));
const validateOutput = <S extends SyncSchema>(schema: S, value: unknown): Promise<WireValue<S>> =>
  mapSyncFailure(() => validateWireValue(schema, value));

const readContext = (ctx: QueryCtx) => toLunoraReadContext(ctx);

const writeContext = (ctx: MutationCtx) => toLunoraWriteContext(ctx);

export const view_access = query
  .input({
    input: v.object({
      defined: v.literal(true),
      value: v.object({
        folderId: v.union(v.string(), v.null()),
        incarnation: v.number(),
      }),
    }),
    resume: v.optional(v.string()),
  })
  .output(
    v.union(
      v.object({
        _tag: v.literal("Value"),
        value: v.object({
          defined: v.literal(true),
          value: v.object({
            role: v.union(
              v.literal("Owner"),
              v.literal("Admin"),
              v.literal("Member"),
              v.literal("Viewer"),
            ),
          }),
        }),
        cursor: v.string(),
      }),
      v.object({
        _tag: v.literal("Failure"),
        failure: v.object({
          defined: v.literal(true),
          value: v.object({
            _tag: v.literal("CatalogPolicyFailure"),
            reason: v.union(v.literal("denied"), v.literal("invalid_state")),
          }),
        }),
      }),
    ),
  )
  .query(async ({ ctx, args }) => {
    const { runtime, actor } = await bindHome(ctx);
    const input = await decodeInput(syncDefinition.views["access"].input, args.input);
    const result = await runtime.observeWire("access")({
      ctx: readContext(ctx),
      args: {
        actor,
        input,
        ...(args.resume === undefined ? {} : { resume: SyncCursor.make(args.resume) }),
      },
    });
    if (result._tag === "Value")
      return {
        ...result,
        value: await validateOutput(syncDefinition.views["access"].output, result.value),
      };
    if (result._tag === "Failure")
      return {
        ...result,
        failure: await validateOutput(syncDefinition.views["access"].failure, result.failure),
      };
    throw asLunoraSyncError(new SyncFailure({ reason: "invalid_state" }));
  });

export const view_children = query
  .input({
    input: v.object({
      defined: v.literal(true),
      value: v.object({
        parent: v.object({
          folderId: v.union(v.string(), v.null()),
          incarnation: v.number(),
        }),
        after: v.union(
          v.object({
            folderId: v.string(),
            incarnation: v.number(),
          }),
          v.null(),
        ),
      }),
    }),
    resume: v.optional(v.string()),
  })
  .output(
    v.union(
      v.object({
        _tag: v.literal("Value"),
        value: v.object({
          defined: v.literal(true),
          value: v.object({
            children: v.array(
              v.object({
                level: v.object({
                  home: v.object({
                    owner: v.union(
                      v.object({
                        _tag: v.literal("person"),
                        id: v.string(),
                      }),
                      v.object({
                        _tag: v.literal("organization"),
                        id: v.string(),
                      }),
                    ),
                    level: v.union(
                      v.object({
                        _tag: v.literal("top"),
                      }),
                      v.object({
                        _tag: v.literal("folder"),
                        id: v.string(),
                      }),
                    ),
                    legacySource: v.optional(v.string()),
                  }),
                  incarnation: v.number(),
                }),
                name: v.string(),
              }),
            ),
            next: v.union(
              v.object({
                folderId: v.string(),
                incarnation: v.number(),
              }),
              v.null(),
            ),
          }),
        }),
        cursor: v.string(),
      }),
      v.object({
        _tag: v.literal("Failure"),
        failure: v.object({
          defined: v.literal(true),
          value: v.object({
            _tag: v.literal("CatalogPolicyFailure"),
            reason: v.union(v.literal("denied"), v.literal("invalid_state")),
          }),
        }),
      }),
    ),
  )
  .query(async ({ ctx, args }) => {
    const { runtime, actor } = await bindHome(ctx);
    const input = await decodeInput(syncDefinition.views["children"].input, args.input);
    const result = await runtime.observeWire("children")({
      ctx: readContext(ctx),
      args: {
        actor,
        input,
        ...(args.resume === undefined ? {} : { resume: SyncCursor.make(args.resume) }),
      },
    });
    if (result._tag === "Value")
      return {
        ...result,
        value: await validateOutput(syncDefinition.views["children"].output, result.value),
      };
    if (result._tag === "Failure")
      return {
        ...result,
        failure: await validateOutput(syncDefinition.views["children"].failure, result.failure),
      };
    throw asLunoraSyncError(new SyncFailure({ reason: "invalid_state" }));
  });

export const view_referencePlacements = query
  .input({
    input: v.object({
      defined: v.literal(true),
      value: v.object({
        after: v.union(v.string(), v.null()),
      }),
    }),
    resume: v.optional(v.string()),
  })
  .output(
    v.union(
      v.object({
        _tag: v.literal("Value"),
        value: v.object({
          defined: v.literal(true),
          value: v.object({
            placements: v.array(
              v.object({
                target: v.object({
                  home: v.object({
                    owner: v.union(
                      v.object({
                        _tag: v.literal("person"),
                        id: v.string(),
                      }),
                      v.object({
                        _tag: v.literal("organization"),
                        id: v.string(),
                      }),
                    ),
                    level: v.union(
                      v.object({
                        _tag: v.literal("top"),
                      }),
                      v.object({
                        _tag: v.literal("folder"),
                        id: v.string(),
                      }),
                    ),
                    legacySource: v.optional(v.string()),
                  }),
                  incarnation: v.number(),
                }),
                filedUnder: v.object({
                  home: v.object({
                    owner: v.union(
                      v.object({
                        _tag: v.literal("person"),
                        id: v.string(),
                      }),
                      v.object({
                        _tag: v.literal("organization"),
                        id: v.string(),
                      }),
                    ),
                    level: v.union(
                      v.object({
                        _tag: v.literal("top"),
                      }),
                      v.object({
                        _tag: v.literal("folder"),
                        id: v.string(),
                      }),
                    ),
                    legacySource: v.optional(v.string()),
                  }),
                  incarnation: v.number(),
                }),
              }),
            ),
            next: v.union(v.string(), v.null()),
          }),
        }),
        cursor: v.string(),
      }),
      v.object({
        _tag: v.literal("Failure"),
        failure: v.object({
          defined: v.literal(true),
          value: v.object({
            _tag: v.literal("CatalogPolicyFailure"),
            reason: v.union(v.literal("denied"), v.literal("invalid_state")),
          }),
        }),
      }),
    ),
  )
  .query(async ({ ctx, args }) => {
    const { runtime, actor } = await bindHome(ctx);
    const input = await decodeInput(syncDefinition.views["referencePlacements"].input, args.input);
    const result = await runtime.observeWire("referencePlacements")({
      ctx: readContext(ctx),
      args: {
        actor,
        input,
        ...(args.resume === undefined ? {} : { resume: SyncCursor.make(args.resume) }),
      },
    });
    if (result._tag === "Value")
      return {
        ...result,
        value: await validateOutput(
          syncDefinition.views["referencePlacements"].output,
          result.value,
        ),
      };
    if (result._tag === "Failure")
      return {
        ...result,
        failure: await validateOutput(
          syncDefinition.views["referencePlacements"].failure,
          result.failure,
        ),
      };
    throw asLunoraSyncError(new SyncFailure({ reason: "invalid_state" }));
  });

export const change_createFolder = mutation
  .input({
    input: v.object({
      defined: v.literal(true),
      value: v.object({
        parent: v.object({
          folderId: v.union(v.string(), v.null()),
          incarnation: v.number(),
        }),
        folderId: v.string(),
        name: v.string(),
      }),
    }),
    operationKey: v.string(),
  })
  .output(
    v.union(
      v.object({
        _tag: v.literal("Committed"),
        value: v.object({
          defined: v.literal(true),
          value: v.object({
            level: v.object({
              home: v.object({
                owner: v.union(
                  v.object({
                    _tag: v.literal("person"),
                    id: v.string(),
                  }),
                  v.object({
                    _tag: v.literal("organization"),
                    id: v.string(),
                  }),
                ),
                level: v.union(
                  v.object({
                    _tag: v.literal("top"),
                  }),
                  v.object({
                    _tag: v.literal("folder"),
                    id: v.string(),
                  }),
                ),
                legacySource: v.optional(v.string()),
              }),
              incarnation: v.number(),
            }),
          }),
        }),
        receipt: v.string(),
      }),
      v.object({ _tag: v.literal("Pending"), operationKey: v.string() }),
    ),
  )
  .mutation(async ({ ctx, args }) => {
    const { runtime, actor } = await bindHome(ctx);
    const input = await decodeInput(syncDefinition.changes["createFolder"].input, args.input);
    const result = await runtime.changeWire("createFolder")({
      ctx: writeContext(ctx),
      args: { actor, input, operationKey: args.operationKey },
    });
    if (result._tag === "Committed") {
      return {
        ...result,
        value: await validateOutput(syncDefinition.changes["createFolder"].output, result.value),
      };
    }
    return result;
  });

export const change_moveFolder = mutation
  .input({
    input: v.object({
      defined: v.literal(true),
      value: v.object({
        target: v.object({
          folderId: v.string(),
          incarnation: v.number(),
        }),
        parent: v.object({
          folderId: v.union(v.string(), v.null()),
          incarnation: v.number(),
        }),
        before: v.union(
          v.object({
            folderId: v.string(),
            incarnation: v.number(),
          }),
          v.null(),
        ),
      }),
    }),
    operationKey: v.string(),
  })
  .output(
    v.union(
      v.object({
        _tag: v.literal("Committed"),
        value: v.object({
          defined: v.literal(true),
          value: v.object({
            changed: v.boolean(),
          }),
        }),
        receipt: v.string(),
      }),
      v.object({ _tag: v.literal("Pending"), operationKey: v.string() }),
    ),
  )
  .mutation(async ({ ctx, args }) => {
    const { runtime, actor } = await bindHome(ctx);
    const input = await decodeInput(syncDefinition.changes["moveFolder"].input, args.input);
    const result = await runtime.changeWire("moveFolder")({
      ctx: writeContext(ctx),
      args: { actor, input, operationKey: args.operationKey },
    });
    if (result._tag === "Committed") {
      return {
        ...result,
        value: await validateOutput(syncDefinition.changes["moveFolder"].output, result.value),
      };
    }
    return result;
  });

export const change_moveOrganizationReference = mutation
  .input({
    input: v.object({
      defined: v.literal(true),
      value: v.object({
        target: v.object({
          home: v.object({
            owner: v.union(
              v.object({
                _tag: v.literal("person"),
                id: v.string(),
              }),
              v.object({
                _tag: v.literal("organization"),
                id: v.string(),
              }),
            ),
            level: v.union(
              v.object({
                _tag: v.literal("top"),
              }),
              v.object({
                _tag: v.literal("folder"),
                id: v.string(),
              }),
            ),
            legacySource: v.optional(v.string()),
          }),
          incarnation: v.number(),
        }),
        filedUnder: v.object({
          home: v.object({
            owner: v.union(
              v.object({
                _tag: v.literal("person"),
                id: v.string(),
              }),
              v.object({
                _tag: v.literal("organization"),
                id: v.string(),
              }),
            ),
            level: v.union(
              v.object({
                _tag: v.literal("top"),
              }),
              v.object({
                _tag: v.literal("folder"),
                id: v.string(),
              }),
            ),
            legacySource: v.optional(v.string()),
          }),
          incarnation: v.number(),
        }),
      }),
    }),
    operationKey: v.string(),
  })
  .output(
    v.union(
      v.object({
        _tag: v.literal("Committed"),
        value: v.object({
          defined: v.literal(true),
          value: v.object({
            changed: v.boolean(),
          }),
        }),
        receipt: v.string(),
      }),
      v.object({ _tag: v.literal("Pending"), operationKey: v.string() }),
    ),
  )
  .mutation(async ({ ctx, args }) => {
    const { runtime, actor } = await bindHome(ctx);
    const input = await decodeInput(
      syncDefinition.changes["moveOrganizationReference"].input,
      args.input,
    );
    const result = await runtime.changeWire("moveOrganizationReference")({
      ctx: writeContext(ctx),
      args: { actor, input, operationKey: args.operationKey },
    });
    if (result._tag === "Committed") {
      return {
        ...result,
        value: await validateOutput(
          syncDefinition.changes["moveOrganizationReference"].output,
          result.value,
        ),
      };
    }
    return result;
  });

export const change_renameFolder = mutation
  .input({
    input: v.object({
      defined: v.literal(true),
      value: v.object({
        target: v.object({
          folderId: v.string(),
          incarnation: v.number(),
        }),
        name: v.string(),
      }),
    }),
    operationKey: v.string(),
  })
  .output(
    v.union(
      v.object({
        _tag: v.literal("Committed"),
        value: v.object({
          defined: v.literal(true),
          value: v.object({
            changed: v.boolean(),
          }),
        }),
        receipt: v.string(),
      }),
      v.object({ _tag: v.literal("Pending"), operationKey: v.string() }),
    ),
  )
  .mutation(async ({ ctx, args }) => {
    const { runtime, actor } = await bindHome(ctx);
    const input = await decodeInput(syncDefinition.changes["renameFolder"].input, args.input);
    const result = await runtime.changeWire("renameFolder")({
      ctx: writeContext(ctx),
      args: { actor, input, operationKey: args.operationKey },
    });
    if (result._tag === "Committed") {
      return {
        ...result,
        value: await validateOutput(syncDefinition.changes["renameFolder"].output, result.value),
      };
    }
    return result;
  });

export const change_reopenFolder = mutation
  .input({
    input: v.object({
      defined: v.literal(true),
      value: v.object({
        target: v.object({
          folderId: v.string(),
          incarnation: v.number(),
        }),
      }),
    }),
    operationKey: v.string(),
  })
  .output(
    v.union(
      v.object({
        _tag: v.literal("Committed"),
        value: v.object({
          defined: v.literal(true),
          value: v.object({
            changed: v.boolean(),
          }),
        }),
        receipt: v.string(),
      }),
      v.object({ _tag: v.literal("Pending"), operationKey: v.string() }),
    ),
  )
  .mutation(async ({ ctx, args }) => {
    const { runtime, actor } = await bindHome(ctx);
    const input = await decodeInput(syncDefinition.changes["reopenFolder"].input, args.input);
    const result = await runtime.changeWire("reopenFolder")({
      ctx: writeContext(ctx),
      args: { actor, input, operationKey: args.operationKey },
    });
    if (result._tag === "Committed") {
      return {
        ...result,
        value: await validateOutput(syncDefinition.changes["reopenFolder"].output, result.value),
      };
    }
    return result;
  });

export const change_retireFolder = mutation
  .input({
    input: v.object({
      defined: v.literal(true),
      value: v.object({
        target: v.object({
          folderId: v.string(),
          incarnation: v.number(),
        }),
      }),
    }),
    operationKey: v.string(),
  })
  .output(
    v.union(
      v.object({
        _tag: v.literal("Committed"),
        value: v.object({
          defined: v.literal(true),
          value: v.object({
            changed: v.boolean(),
          }),
        }),
        receipt: v.string(),
      }),
      v.object({ _tag: v.literal("Pending"), operationKey: v.string() }),
    ),
  )
  .mutation(async ({ ctx, args }) => {
    const { runtime, actor } = await bindHome(ctx);
    const input = await decodeInput(syncDefinition.changes["retireFolder"].input, args.input);
    const result = await runtime.changeWire("retireFolder")({
      ctx: writeContext(ctx),
      args: { actor, input, operationKey: args.operationKey },
    });
    if (result._tag === "Committed") {
      return {
        ...result,
        value: await validateOutput(syncDefinition.changes["retireFolder"].output, result.value),
      };
    }
    return result;
  });

export const change_setGrant = mutation
  .input({
    input: v.object({
      defined: v.literal(true),
      value: v.object({
        target: v.object({
          folderId: v.union(v.string(), v.null()),
          incarnation: v.number(),
        }),
        personId: v.string(),
        role: v.union(
          v.union(v.literal("Admin"), v.literal("Member"), v.literal("Viewer")),
          v.null(),
        ),
      }),
    }),
    operationKey: v.string(),
  })
  .output(
    v.union(
      v.object({
        _tag: v.literal("Committed"),
        value: v.object({
          defined: v.literal(true),
          value: v.object({
            changed: v.boolean(),
          }),
        }),
        receipt: v.string(),
      }),
      v.object({ _tag: v.literal("Pending"), operationKey: v.string() }),
    ),
  )
  .mutation(async ({ ctx, args }) => {
    const { runtime, actor } = await bindHome(ctx);
    const input = await decodeInput(syncDefinition.changes["setGrant"].input, args.input);
    const result = await runtime.changeWire("setGrant")({
      ctx: writeContext(ctx),
      args: { actor, input, operationKey: args.operationKey },
    });
    if (result._tag === "Committed") {
      return {
        ...result,
        value: await validateOutput(syncDefinition.changes["setGrant"].output, result.value),
      };
    }
    return result;
  });

export const project_ensureOrganizationReference = internalMutation
  .input({
    input: v.object({
      defined: v.literal(true),
      value: v.object({
        incarnation: v.number(),
        target: v.object({
          home: v.object({
            owner: v.union(
              v.object({
                _tag: v.literal("person"),
                id: v.string(),
              }),
              v.object({
                _tag: v.literal("organization"),
                id: v.string(),
              }),
            ),
            level: v.union(
              v.object({
                _tag: v.literal("top"),
              }),
              v.object({
                _tag: v.literal("folder"),
                id: v.string(),
              }),
            ),
            legacySource: v.optional(v.string()),
          }),
          incarnation: v.number(),
        }),
      }),
    }),
    operationKey: v.string(),
  })
  .output(
    v.union(
      v.object({
        _tag: v.literal("Committed"),
        value: v.object({
          defined: v.literal(true),
          value: v.object({
            changed: v.boolean(),
          }),
        }),
        receipt: v.string(),
      }),
      v.object({ _tag: v.literal("Pending"), operationKey: v.string() }),
    ),
  )
  .mutation(async ({ ctx, args }) => {
    const { runtime, ingress } = await bindProjectionHome(ctx);
    const input = await decodeInput(
      syncDefinition.projections["ensureOrganizationReference"].input,
      args.input,
    );
    const result = await runtime.projectionWire("ensureOrganizationReference")({
      ctx: writeContext(ctx),
      args: { ingress, input, operationKey: args.operationKey },
    });
    if (result._tag === "Committed") {
      return {
        ...result,
        value: await validateOutput(
          syncDefinition.projections["ensureOrganizationReference"].output,
          result.value,
        ),
      };
    }
    return result;
  });

export const project_initialize = internalMutation
  .input({
    input: v.object({
      defined: v.literal(true),
      value: v.object({
        incarnation: v.number(),
      }),
    }),
    operationKey: v.string(),
  })
  .output(
    v.union(
      v.object({
        _tag: v.literal("Committed"),
        value: v.object({
          defined: v.literal(true),
          value: v.object({
            changed: v.boolean(),
          }),
        }),
        receipt: v.string(),
      }),
      v.object({ _tag: v.literal("Pending"), operationKey: v.string() }),
    ),
  )
  .mutation(async ({ ctx, args }) => {
    const { runtime, ingress } = await bindProjectionHome(ctx);
    const input = await decodeInput(syncDefinition.projections["initialize"].input, args.input);
    const result = await runtime.projectionWire("initialize")({
      ctx: writeContext(ctx),
      args: { ingress, input, operationKey: args.operationKey },
    });
    if (result._tag === "Committed") {
      return {
        ...result,
        value: await validateOutput(syncDefinition.projections["initialize"].output, result.value),
      };
    }
    return result;
  });
