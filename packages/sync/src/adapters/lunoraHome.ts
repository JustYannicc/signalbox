import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { DatabaseReader, DatabaseWriter, Scheduler } from "lunorash/server";

import {
  AuthorizationFence,
  SyncFailure,
  SyncReceipt,
  SyncCursor,
  tableErrorToSyncFailure,
  type Commit,
  type HomeBinding,
  type Input,
  type Output,
  type SyncSchema,
} from "../definition.ts";
import { TableReadError, TableWriteError, type TableMap } from "../table.ts";
import {
  decode,
  decodeJson,
  decodeStored,
  encode,
  encodeWire,
  makeCursor,
  type RuntimeSchema,
} from "./lunoraHomeCodec.ts";
import { asLunoraSyncError, commitOutput, writeWire } from "./lunoraHomeWire.ts";
import { canonicalJson, encodeWireValue, wireValueSchema } from "./lunoraWireValue.ts";
import { makeLunoraReadTables, makeLunoraWriteTables } from "./lunoraTables.ts";
import {
  acknowledgeFenceReceipt,
  findReceipt,
  pendingFenceReceipts,
  saveReceipt,
  type PendingFencePage,
} from "./lunoraReceipts.ts";

type AnyOperation = {
  readonly input: RuntimeSchema;
  readonly output: RuntimeSchema;
  readonly failure: RuntimeSchema;
  readonly run: (context: never, input: never) => Effect.Effect<unknown, unknown>;
};
interface Definition {
  readonly actor: RuntimeSchema;
  readonly home: RuntimeSchema;
  readonly tables: TableMap;
  readonly views: Readonly<Record<string, AnyOperation & { readonly kind: "view" }>>;
  readonly changes: Readonly<Record<string, AnyOperation & { readonly kind: "change" }>>;
  readonly projections: Readonly<Record<string, AnyOperation & { readonly kind: "projection" }>>;
}
type ReadCtx = { readonly db: DatabaseReader };
type WriteCtx = { readonly db: DatabaseWriter; readonly scheduler?: Pick<Scheduler, "runAfter"> };
type Arguments<Actor, Op extends AnyOperation & { readonly kind: string }> = {
  readonly actor: Actor;
  readonly input: Op["input"]["Type"];
};
type RuntimeWireValue<S extends SyncSchema> =
  | { readonly defined: false }
  | { readonly defined: true; readonly value: S["Encoded"] };
type WireObservation<Output extends SyncSchema, Failure extends SyncSchema> =
  | {
      readonly _tag: "Value";
      readonly value: RuntimeWireValue<Output>;
      readonly cursor: SyncCursor;
    }
  | { readonly _tag: "Failure"; readonly failure: RuntimeWireValue<Failure> };
type RuntimeWireCommit<Output extends SyncSchema> = Commit<RuntimeWireValue<Output>>;

const isTableError = Schema.is(Schema.Union([TableReadError, TableWriteError]));
async function runOutcome<Op extends AnyOperation>(op: Op, context: unknown, input: unknown) {
  // The definition factories checked the context and input at authoring time.
  const run = op.run as (context: unknown, input: unknown) => Effect.Effect<unknown, unknown>;
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off - The declared failure schema validates this erased handler boundary below.
  const result = await Effect.runPromise(Effect.result(run(context, input)));
  if (result._tag === "Failure") {
    if (isTableError(result.failure)) throw tableErrorToSyncFailure(result.failure);
    return { _tag: "Failure" as const, failure: decode(op.failure, result.failure, "unavailable") };
  }
  return { _tag: "Success" as const, value: decode(op.output, result.success, "unavailable") };
}

async function runOperation<Op extends AnyOperation>(
  op: Op,
  context: unknown,
  input: unknown,
): Promise<Op["output"]["Type"]> {
  const outcome = await runOutcome(op, context, input);
  if (outcome._tag === "Failure") throw outcome.failure;
  return outcome.value;
}

/** Server-only handlers. Resolve actor/ingress from authenticated server context before calling. */
export function makeLunoraHome<const D extends Definition, Ingress, Permit>(
  definition: D,
  binding: HomeBinding<D["actor"]["Type"], D["home"]["Type"], Ingress, Permit>,
  options: {
    readonly permitKey: (permit: Permit) => string;
    readonly actorKey: (actor: D["actor"]["Type"]) => string;
    readonly ingressKey: (ingress: Ingress) => string;
    readonly maxPageSize?: number;
    readonly recoveryTarget?: Parameters<Scheduler["runAfter"]>[1];
  },
) {
  if (Object.hasOwn(definition.tables, "syncReceipts"))
    throw new Error("syncReceipts is reserved for the sync adapter");
  const home = decode(definition.home, binding.home, "invalid_input");
  const homeKey = () => encode(definition.home, home, "invalid_input").then(canonicalJson);
  const current = (permit: Permit) => {
    if (!binding.authorization.isCurrent(permit)) throw new SyncFailure({ reason: "denied" });
  };
  const authorize = (
    actor: D["actor"]["Type"],
    kind: "view" | "change" | "receipt",
    operation: string,
    input: unknown,
  ) => Effect.runPromise(binding.authorization.authorize(actor, { home, kind, operation, input }));
  const operation = <
    Ops extends Readonly<Record<string, AnyOperation>>,
    K extends keyof Ops & string,
  >(
    ops: Ops,
    name: K,
  ): Ops[K] => {
    if (!Object.hasOwn(ops, name)) throw new SyncFailure({ reason: "invalid_input" });
    return ops[name]!;
  };
  const scheduleRecovery = async (ctx: WriteCtx, delayMs: number, after: string | null = null) => {
    if (options.recoveryTarget === undefined || ctx.scheduler === undefined)
      throw new SyncFailure({ reason: "unavailable" });
    try {
      // Native deferred scheduling takes durable custody in this mutation transaction.
      return await ctx.scheduler.runAfter(
        delayMs,
        options.recoveryTarget,
        { home: await encodeWire(definition.home, home, "unavailable"), after },
        { retry: { forever: true } },
      );
    } catch {
      throw new SyncFailure({ reason: "unavailable" });
    }
  };
  const write = async <Op extends AnyOperation>(
    ctx: WriteCtx,
    op: Op,
    name: string,
    input: Op["input"]["Type"],
    operationKey: string,
    scope: string,
    authority: { readonly actor: D["actor"]["Type"]; readonly permit: Permit } | undefined,
    verifyIngress?: () => Promise<void>,
  ): Promise<Commit<Op["output"]["Type"]>> => {
    if (operationKey.length === 0) throw new SyncFailure({ reason: "invalid_input" });
    const payload = canonicalJson([name, await encode(op.input, input, "invalid_input")]);
    const previous = await findReceipt(ctx.db, scope, operationKey);
    if (previous !== null) {
      if (previous.payload !== payload) throw new SyncFailure({ reason: "operation_conflict" });
      if (authority !== undefined)
        current(await authorize(authority.actor, "receipt", name, input));
      if (previous.pending) {
        if (verifyIngress !== undefined) await verifyIngress();
        return { _tag: "Pending", operationKey };
      }
      const value = await decodeStored(op.output, decodeJson(previous.value));
      if (authority !== undefined)
        current(await authorize(authority.actor, "receipt", name, input));
      if (verifyIngress !== undefined) await verifyIngress();
      return { _tag: "Committed", value, receipt: SyncReceipt.make(previous._id) };
    }
    const fences: AuthorizationFence[] = [];
    const context = {
      home,
      tables: makeLunoraWriteTables(definition.tables, ctx.db, options.maxPageSize),
      ...(authority === undefined ? {} : { actor: authority.actor }),
      requireAuthorizationFence: (fence: AuthorizationFence) =>
        Effect.try({
          try: () => {
            fences.push(decode(AuthorizationFence, fence, "invalid_input"));
          },
          catch: () => new TableWriteError({ table: "syncReceipts", reason: "invalid_row" }),
        }),
    };
    const value = await runOperation(op, context, input);
    if (authority !== undefined) current(authority.permit);
    const receipt = await saveReceipt(ctx.db, {
      scope,
      operationKey,
      payload,
      value: await encode(op.output, value, "unavailable").then(canonicalJson),
      fences,
      pending: fences.length !== 0,
    });
    if (fences.length !== 0) await scheduleRecovery(ctx, 0);
    if (verifyIngress !== undefined) await verifyIngress();
    if (authority !== undefined) current(authority.permit);
    return fences.length === 0
      ? { _tag: "Committed", value, receipt }
      : { _tag: "Pending", operationKey };
  };
  const handlers = {
    query:
      <K extends keyof D["views"] & string>(name: K) =>
      async ({
        ctx,
        args,
      }: {
        readonly ctx: ReadCtx;
        readonly args: Arguments<D["actor"]["Type"], D["views"][K]>;
      }): Promise<Output<D["views"][K]>> => {
        const op = operation(definition.views, name);
        const actor = decode(definition.actor, args.actor, "invalid_input");
        const input = decode(op.input, args.input, "invalid_input");
        const permit = await authorize(actor, "view", name, input);
        const value = await runOperation(
          op,
          {
            actor,
            home,
            tables: makeLunoraReadTables(definition.tables, ctx.db, options.maxPageSize),
          },
          input,
        );
        current(permit);
        return value;
      },
    observeOutput: <K extends keyof D["views"] & string>(
      name: K,
    ): Schema.Schema<WireObservation<D["views"][K]["output"], D["views"][K]["failure"]>> => {
      const op = operation(definition.views, name);
      return Schema.Union([
        Schema.TaggedStruct("Value", { value: wireValueSchema(op.output), cursor: SyncCursor }),
        Schema.TaggedStruct("Failure", { failure: wireValueSchema(op.failure) }),
      ]);
    },
    observe:
      <K extends keyof D["views"] & string>(name: K) =>
      async ({
        ctx,
        args,
      }: {
        readonly ctx: ReadCtx;
        readonly args: Arguments<D["actor"]["Type"], D["views"][K]> & {
          readonly resume?: SyncCursor;
        };
      }): Promise<WireObservation<D["views"][K]["output"], D["views"][K]["failure"]>> => {
        const op = operation(definition.views, name);
        const actor = decode(definition.actor, args.actor, "invalid_input");
        const input = decode(op.input, args.input, "invalid_input");
        const permit = await authorize(actor, "view", name, input);
        const cursor = await makeCursor(
          [
            await homeKey(),
            options.actorKey(actor),
            name,
            await encode(op.input, input, "invalid_input"),
          ],
          options.permitKey(permit),
          args.resume,
        );
        const outcome = await runOutcome(
          op,
          {
            actor,
            home,
            tables: makeLunoraReadTables(definition.tables, ctx.db, options.maxPageSize),
          },
          input,
        );
        const result =
          outcome._tag === "Failure"
            ? {
                _tag: "Failure" as const,
                failure: await encodeWireValue(op.failure, outcome.failure, "unavailable"),
              }
            : {
                _tag: "Value" as const,
                value: await encodeWireValue(op.output, outcome.value, "unavailable"),
                cursor,
              };
        current(permit);
        return result;
      },
    change:
      <K extends keyof D["changes"] & string>(name: K) =>
      async ({
        ctx,
        args,
      }: {
        readonly ctx: WriteCtx;
        readonly args: Arguments<D["actor"]["Type"], D["changes"][K]> & {
          readonly operationKey: string;
        };
      }): Promise<Commit<Output<D["changes"][K]>>> => {
        const op = operation(definition.changes, name);
        const actor = decode(definition.actor, args.actor, "invalid_input");
        const input = decode(op.input, args.input, "invalid_input");
        const permit = await authorize(actor, "change", name, input);
        current(permit);
        return write(
          ctx,
          op,
          name,
          input,
          args.operationKey,
          canonicalJson([await homeKey(), "change", options.actorKey(actor)]),
          { actor, permit },
        );
      },
    projection:
      <K extends keyof D["projections"] & string>(name: K) =>
      async ({
        ctx,
        args,
      }: {
        readonly ctx: WriteCtx;
        readonly args: {
          readonly ingress: Ingress;
          readonly input: Input<D["projections"][K]>;
          readonly operationKey: string;
        };
      }): Promise<Commit<Output<D["projections"][K]>>> => {
        const op = operation(definition.projections, name);
        const input = decode(op.input, args.input, "invalid_input");
        await Effect.runPromise(binding.authorizeIngress(args.ingress));
        return write(
          ctx,
          op,
          name,
          input,
          args.operationKey,
          canonicalJson([await homeKey(), "projection", options.ingressKey(args.ingress)]),
          undefined,
          () => Effect.runPromise(binding.authorizeIngress(args.ingress)),
        );
      },
    /** Bind to an internal mutation so the native outbox retains custody if scheduler RPC fails. */
    scheduleFenceRecovery: ({
      ctx,
      after,
    }: {
      readonly ctx: WriteCtx;
      readonly after?: string | null;
    }) => scheduleRecovery(ctx, 30_000, after),
    pendingFences: ({
      ctx,
      limit,
      after,
    }: {
      readonly ctx: ReadCtx;
      readonly limit?: number;
      readonly after?: string | null;
    }) => pendingFenceReceipts(ctx.db, limit, after),
    acknowledgeFence: ({
      ctx,
      receipt,
    }: {
      readonly ctx: WriteCtx;
      readonly receipt: SyncReceipt;
    }) => acknowledgeFenceReceipt(ctx.db, receipt),
    /** Dispatch through generated internal query/mutation functions, after the original commit. */
    recoverFences: async (
      dispatch: {
        readonly pending: (after: string | null) => Promise<PendingFencePage>;
        readonly scheduleNext: (after: string | null) => Promise<string>;
        readonly acknowledge: (receipt: SyncReceipt) => Promise<void>;
      },
      after: string | null = null,
    ) => {
      let page = await dispatch.pending(after);
      if (page.receipts.length === 0 && after !== null) page = await dispatch.pending(null);
      if (page.receipts.length === 0) return { _tag: "Drained" as const };
      // Commit the next bounded page before installing; failed scopes cannot monopolize the first page.
      await dispatch.scheduleNext(page.after);
      let failed = false;
      for (const pending of page.receipts) {
        try {
          for (const fence of pending.fences)
            await Effect.runPromise(binding.completion.install(fence));
          await dispatch.acknowledge(pending.receipt);
        } catch {
          // The successor owns retries; throwing would also retry this native job.
          failed = true;
        }
      }
      if (failed || page.after !== null || (await dispatch.pending(null)).receipts.length !== 0)
        return { _tag: "Pending" as const };
      return { _tag: "Drained" as const };
    },
  };
  return {
    ...handlers,
    observeWire: <K extends keyof D["views"] & string>(name: K) => {
      const handler = handlers.observe(name);
      return async (request: Parameters<typeof handler>[0]) => {
        try {
          const result = await handler(request);
          current(await authorize(request.args.actor, "view", name, request.args.input));
          return result;
        } catch (error) {
          throw asLunoraSyncError(error);
        }
      };
    },
    changeOutput: <K extends keyof D["changes"] & string>(
      name: K,
    ): Schema.Schema<RuntimeWireCommit<D["changes"][K]["output"]>> => {
      return commitOutput(operation(definition.changes, name).output);
    },
    projectionOutput: <K extends keyof D["projections"] & string>(
      name: K,
    ): Schema.Schema<RuntimeWireCommit<D["projections"][K]["output"]>> => {
      return commitOutput(operation(definition.projections, name).output);
    },
    changeWire: <K extends keyof D["changes"] & string>(name: K) => {
      const handler = handlers.change(name);
      const op = operation(definition.changes, name);
      return (
        request: Parameters<typeof handler>[0],
      ): Promise<RuntimeWireCommit<D["changes"][K]["output"]>> =>
        writeWire(
          op.output,
          op.failure,
          () => handler(request),
          async () => {
            const permit = await authorize(request.args.actor, "receipt", name, request.args.input);
            return () => current(permit);
          },
        );
    },
    projectionWire: <K extends keyof D["projections"] & string>(name: K) => {
      const handler = handlers.projection(name);
      const op = operation(definition.projections, name);
      return (
        request: Parameters<typeof handler>[0],
      ): Promise<RuntimeWireCommit<D["projections"][K]["output"]>> =>
        writeWire(
          op.output,
          op.failure,
          () => handler(request),
          async () => {
            await Effect.runPromise(binding.authorizeIngress(request.args.ingress));
            return () => {};
          },
        );
    },
  };
}
