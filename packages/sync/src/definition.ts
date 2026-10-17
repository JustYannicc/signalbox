import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

import type { ReadTable, TableError, TableMap, WriteTable } from "./table.ts";

export const SyncCursor = Schema.String.pipe(Schema.brand("SyncCursor"));
export type SyncCursor = typeof SyncCursor.Type;
export const SyncReceipt = Schema.String.pipe(Schema.brand("SyncReceipt"));
export type SyncReceipt = typeof SyncReceipt.Type;

export class SyncFailure extends Schema.TaggedError<SyncFailure>()("SyncFailure", {
  reason: Schema.Literals([
    "denied",
    "unavailable",
    "operation_conflict",
    "invalid_input",
    "invalid_cursor",
  ]),
}) {}

export type ViewFrame<A> =
  | {
      readonly _tag: "Snapshot" | "Update" | "Reset";
      readonly value: A;
      readonly cursor: SyncCursor;
    }
  | { readonly _tag: "Revoked" };

/** Pending includes an unknown commit and committed policy awaiting its delivery barrier. */
export type Commit<A> =
  | { readonly _tag: "Committed"; readonly value: A; readonly receipt: SyncReceipt }
  | { readonly _tag: "Pending"; readonly operationKey: string };

export const AuthorizationFence = Schema.Struct({ scope: Schema.String, epoch: Schema.Int });
export type AuthorizationFence = typeof AuthorizationFence.Type;

export interface ReadContext<Tables extends TableMap, Actor, Home> {
  readonly actor: Actor;
  readonly home: Home;
  readonly tables: { readonly [K in keyof Tables]: ReadTable<Tables[K]> };
}

/** All writes, their receipt, and any pending delivery fence share one transaction. */
export interface WriteContext<Tables extends TableMap, Home> {
  readonly home: Home;
  readonly tables: { readonly [K in keyof Tables]: WriteTable<Tables[K]> };
  /** Records durable post-commit fence work; completion stays Pending until installation succeeds. */
  readonly requireAuthorizationFence: (
    fence: AuthorizationFence,
  ) => Effect.Effect<void, TableError>;
}

export interface TransactionContext<Tables extends TableMap, Actor, Home> extends WriteContext<
  Tables,
  Home
> {
  readonly actor: Actor;
}

export interface Operation<
  Kind extends string,
  Input extends Schema.Constraint,
  Output extends Schema.Constraint,
  Failure extends Schema.Constraint,
  Context,
> {
  readonly kind: Kind;
  readonly input: Input;
  readonly output: Output;
  readonly failure: Failure;
  readonly run: (
    context: Context,
    input: Input["Type"],
  ) => Effect.Effect<Output["Type"], Failure["Type"] | TableError>;
}

type OperationConfig<
  Input extends Schema.Constraint,
  Output extends Schema.Constraint,
  Failure extends Schema.Constraint,
  Context,
> = Omit<Operation<string, Input, Output, Failure, Context>, "kind">;

export const view = <
  Input extends Schema.Constraint,
  Output extends Schema.Constraint,
  Failure extends Schema.Constraint,
  Context,
>(
  config: OperationConfig<Input, Output, Failure, Context>,
) => Object.freeze({ ...config, kind: "view" as const });

export const change = <
  Input extends Schema.Constraint,
  Output extends Schema.Constraint,
  Failure extends Schema.Constraint,
  Context,
>(
  config: OperationConfig<Input, Output, Failure, Context>,
) => Object.freeze({ ...config, kind: "change" as const });

export const projection = <
  Input extends Schema.Constraint,
  Output extends Schema.Constraint,
  Failure extends Schema.Constraint,
  Context,
>(
  config: OperationConfig<Input, Output, Failure, Context>,
) => Object.freeze({ ...config, kind: "projection" as const });

type Factory<Kind extends string, Context> = <
  Input extends Schema.Constraint,
  Output extends Schema.Constraint,
  Failure extends Schema.Constraint,
>(
  config: OperationConfig<Input, Output, Failure, Context>,
) => Operation<Kind, Input, Output, Failure, Context>;

type OperationShape = {
  readonly kind: string;
  readonly input: Schema.Constraint;
  readonly output: Schema.Constraint;
  readonly failure: Schema.Constraint;
  readonly run: (context: never, input: never) => Effect.Effect<unknown, unknown>;
};
type Operations<Kind extends string> = Readonly<
  Record<string, OperationShape & { readonly kind: Kind }>
>;

export interface HomeOperations {
  readonly views: Operations<"view">;
  readonly changes: Operations<"change">;
  readonly projections: Operations<"projection">;
}

/** Builds metadata only. An adapter binds it to one server-resolved home and its authorization guard. */
export const defineHome = <
  Actor extends Schema.Constraint,
  Home extends Schema.Constraint,
  const Tables extends TableMap,
  const Definitions extends HomeOperations,
>(
  config: { readonly actor: Actor; readonly home: Home; readonly tables: Tables },
  build: (operations: {
    readonly view: Factory<"view", ReadContext<Tables, Actor["Type"], Home["Type"]>>;
    readonly change: Factory<"change", TransactionContext<Tables, Actor["Type"], Home["Type"]>>;
    readonly projection: Factory<"projection", WriteContext<Tables, Home["Type"]>>;
  }) => Definitions,
) => Object.freeze({ ...config, ...build({ view, change, projection }) });

export type Input<Op extends OperationShape> = Op["input"]["Type"];
export type Output<Op extends OperationShape> = Op["output"]["Type"];
export type Failure<Op extends OperationShape> = Op["failure"]["Type"];

/** Trusted ingress is a server capability supplied by the owning module, never public request data. */
export interface SyncHome<Actor, Ingress, Definitions extends HomeOperations> {
  readonly view: <K extends keyof Definitions["views"] & string>(
    actor: Actor,
    operation: K,
    input: Input<Definitions["views"][K]>,
    resume?: SyncCursor,
  ) => Stream.Stream<
    ViewFrame<Output<Definitions["views"][K]>>,
    Failure<Definitions["views"][K]> | SyncFailure
  >;
  /** Key replay reauthorizes the actor before returning any stored output. */
  readonly change: <K extends keyof Definitions["changes"] & string>(
    actor: Actor,
    operation: K,
    input: Input<Definitions["changes"][K]>,
    operationKey: string,
  ) => Effect.Effect<
    Commit<Output<Definitions["changes"][K]>>,
    Failure<Definitions["changes"][K]> | SyncFailure
  >;
  readonly project: <K extends keyof Definitions["projections"] & string>(
    ingress: Ingress,
    operation: K,
    delivery: Input<Definitions["projections"][K]>,
    deliveryKey: string,
  ) => Effect.Effect<
    Commit<Output<Definitions["projections"][K]>>,
    Failure<Definitions["projections"][K]> | SyncFailure
  >;
}

/** The catalog supplies current authority; the adapter supplies its local send fence. */
export interface AuthorizationGuard<Actor, Home, Permit> {
  readonly authorize: (
    actor: Actor,
    request: {
      readonly home: Home;
      readonly kind: "view" | "change" | "receipt";
      readonly operation: string;
      readonly input: unknown;
    },
  ) => Effect.Effect<Permit, SyncFailure>;
  /** Must run immediately at enqueue, with no intervening await. */
  readonly isCurrent: (permit: Permit) => boolean;
}

/** Adapter-only durable outbox seam. Installing a fence never grants access. */
export interface FenceCompletion {
  readonly install: (fence: AuthorizationFence) => Effect.Effect<void, SyncFailure>;
}

export interface HomeBinding<Actor, Home, Ingress, Permit> {
  readonly home: Home;
  readonly authorization: AuthorizationGuard<Actor, Home, Permit>;
  readonly authorizeIngress: (ingress: Ingress) => Effect.Effect<void, SyncFailure>;
  readonly completion: FenceCompletion;
}
