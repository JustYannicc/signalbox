import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { FunctionReference, LunoraClient } from "lunorash/client";

import {
  SyncFailure,
  SyncReceipt,
  type Commit,
  type Failure,
  type HomeOperations,
  type Input,
  type Output,
  type SyncHome,
  type SyncSchema,
  type SyncCursor,
} from "../definition.ts";
import { makeLunoraSyncViewClient } from "./lunoraClient.ts";
import type { WireCommit } from "./lunoraHomeWire.ts";
import { decodeWireValue, encodeWireValue, type WireValue } from "./lunoraWireValue.ts";

type Operation<
  InputSchema extends SyncSchema = SyncSchema,
  OutputSchema extends SyncSchema = SyncSchema,
  FailureSchema extends SyncSchema = SyncSchema,
> = {
  readonly input: InputSchema;
  readonly output: OutputSchema;
  readonly failure: FailureSchema;
};

type ObserveResult<Op extends Operation> =
  | {
      readonly _tag: "Value";
      readonly value: WireValue<Op["output"]>;
      readonly cursor: string;
    }
  | { readonly _tag: "Failure"; readonly failure: WireValue<Op["failure"]> };

type ObserveArgs<Op extends Operation> = {
  readonly input: WireValue<Op["input"]>;
  readonly resume?: string;
};
type WriteArgs<Op extends Operation> = {
  readonly input: WireValue<Op["input"]>;
  readonly operationKey: string;
};

const boundClientShards = new WeakMap<object, string>();
const isSyncFailure = Schema.is(SyncFailure);
const decodeSyncFailure = Schema.decodeUnknownSync(SyncFailure);
const decodeSyncReceipt = Schema.decodeUnknownSync(SyncReceipt);

type HomeReferences<Definitions extends HomeOperations> = {
  readonly views: {
    readonly [K in keyof Definitions["views"]]: FunctionReference<
      "query",
      ObserveArgs<Definitions["views"][K]>,
      ObserveResult<Definitions["views"][K]>
    >;
  };
  readonly changes: {
    readonly [K in keyof Definitions["changes"]]: FunctionReference<
      "mutation",
      WriteArgs<Definitions["changes"][K]>,
      WireCommit<Definitions["changes"][K]["output"]>
    >;
  };
  readonly projections: {
    readonly [K in keyof Definitions["projections"]]: FunctionReference<
      "mutation",
      WriteArgs<Definitions["projections"][K]>,
      WireCommit<Definitions["projections"][K]["output"]>
    >;
  };
};

export interface LunoraSyncSession {
  /** Authenticated for the actor supplied to `sessionFor`; never returned by the facade. */
  readonly client: LunoraClient;
  /** The client is already bound to exactly one home shard. */
  readonly shardKey: string;
}

type ProjectionReference = FunctionReference<"mutation", unknown, unknown>;

/** Server-only seam for dispatching a trusted ingress to an internal mutation. */
export type TrustedProjectionDispatch<Ingress> = (
  ingress: Ingress,
  reference: ProjectionReference,
  args: WriteArgs<Operation>,
  shardKey: string,
) => Promise<unknown>;

export interface LunoraSyncHomeOptions<Actor, Ingress> {
  readonly shardKey: string;
  /** Resolve the authenticated, home-bound client from trusted server identity. */
  readonly sessionFor: (actor: Actor) => LunoraSyncSession;
  /** Captured by the server constructor; never exposed to a client caller. */
  readonly dispatchProjection: TrustedProjectionDispatch<Ingress>;
}

/** Bind typed home definitions and generated references to a single Lunora shard. */
export function makeLunoraSyncHome<
  Ingress,
  const Definitions extends HomeOperations & { readonly actor: SyncSchema },
>(
  definitions: Definitions,
  references: HomeReferences<Definitions>,
  options: LunoraSyncHomeOptions<Definitions["actor"]["Type"], Ingress>,
): SyncHome<Ingress, Definitions> {
  const sessionFor = (actor: Definitions["actor"]["Type"]) => {
    const session = options.sessionFor(actor);
    if (session.shardKey !== options.shardKey) {
      throw new SyncFailure({ reason: "invalid_state" });
    }
    const previousShard = boundClientShards.get(session.client as object);
    if (previousShard !== undefined && previousShard !== options.shardKey) {
      throw new SyncFailure({ reason: "invalid_state" });
    }
    boundClientShards.set(session.client as object, options.shardKey);
    return session;
  };

  const view = <K extends keyof Definitions["views"] & string>(
    actor: Definitions["actor"]["Type"],
    operation: K,
    input: Input<Definitions["views"][K]>,
    resume?: SyncCursor,
  ) => {
    try {
      const { client, shardKey } = sessionFor(actor);
      return makeLunoraSyncViewClient(client, definitions.views, references.views, {
        shardKey,
      }).view(operation, input, resume);
    } catch (error) {
      return Stream.fail(isSyncFailure(error) ? error : new SyncFailure({ reason: "unavailable" }));
    }
  };

  const change = <K extends keyof Definitions["changes"] & string>(
    actor: Definitions["actor"]["Type"],
    operation: K,
    input: Input<Definitions["changes"][K]>,
    operationKey: string,
  ): Effect.Effect<
    Commit<Output<Definitions["changes"][K]>>,
    Failure<Definitions["changes"][K]> | SyncFailure
  > =>
    write<Definitions["changes"][K]>(
      definitions.changes[operation] as Definitions["changes"][K],
      operationKey,
      async (encodedInput: WireValue<Definitions["changes"][K]["input"]>) => {
        const { client, shardKey } = sessionFor(actor);
        const reference = references.changes[operation] as FunctionReference<
          "mutation",
          WriteArgs<Definitions["changes"][K]>,
          WireCommit<Definitions["changes"][K]["output"]>
        >;
        return client.mutation(reference, { input: encodedInput, operationKey }, { shardKey });
      },
      input,
    );

  const project = <K extends keyof Definitions["projections"] & string>(
    ingress: Ingress,
    operation: K,
    delivery: Input<Definitions["projections"][K]>,
    deliveryKey: string,
  ): Effect.Effect<
    Commit<Output<Definitions["projections"][K]>>,
    Failure<Definitions["projections"][K]> | SyncFailure
  > =>
    write<Definitions["projections"][K]>(
      definitions.projections[operation] as Definitions["projections"][K],
      deliveryKey,
      (encodedInput: WireValue<Definitions["projections"][K]["input"]>) =>
        options.dispatchProjection(
          ingress,
          references.projections[operation] as ProjectionReference,
          { input: encodedInput, operationKey: deliveryKey },
          options.shardKey,
        ),
      delivery,
    );

  return Object.freeze({ view, change, project });
}

function write<Op extends Operation>(
  operation: Op,
  operationKey: string,
  dispatch: (encodedInput: WireValue<Op["input"]>) => Promise<unknown>,
  input: Op["input"]["Type"],
): Effect.Effect<Commit<Op["output"]["Type"]>, Op["failure"]["Type"] | SyncFailure> {
  return Effect.gen(function* () {
    if (operationKey.length === 0) return yield* new SyncFailure({ reason: "invalid_input" });

    const encodedInput = yield* encodeInput<Op["input"]>(operation.input, input);
    const result = yield* Effect.result(
      Effect.tryPromise({
        try: () => dispatch(encodedInput),
        catch: (cause) => new MutationDispatchError(cause),
      }),
    );

    if (result._tag === "Failure") {
      const failure = yield* Effect.tryPromise({
        try: () => mapTransportFailure(operation, result.failure, operationKey),
        catch: () => new SyncFailure({ reason: "unavailable" }),
      });
      return failure._tag === "Pending" ? failure : yield* Effect.fail(failure.error);
    }

    return yield* Effect.tryPromise({
      try: () => decodeCommit(operation.output, result.success, operationKey),
      catch: () => new SyncFailure({ reason: "unavailable" }),
    });
  });
}

function encodeInput<InputSchema extends SyncSchema>(
  schema: InputSchema,
  input: InputSchema["Type"],
): Effect.Effect<WireValue<InputSchema>, SyncFailure> {
  return Effect.tryPromise({
    try: () => encodeWireValue(schema, input, "invalid_input"),
    catch: () => new SyncFailure({ reason: "invalid_input" }),
  });
}

async function decodeCommit<OutputSchema extends SyncSchema>(
  output: OutputSchema,
  value: unknown,
  operationKey: string,
): Promise<Commit<OutputSchema["Type"]>> {
  if (!isRecord(value)) throw new Error("Malformed sync mutation result");
  if (value._tag === "Pending") {
    if (value.operationKey !== operationKey) throw new Error("Mismatched pending operation key");
    return { _tag: "Pending", operationKey };
  }
  if (value._tag !== "Committed") throw new Error("Malformed sync mutation result");
  return {
    _tag: "Committed",
    value: await decodeWireValue(output, value.value),
    receipt: decodeSyncReceipt(value.receipt),
  };
}

type TransportFailure<FailureSchema extends SyncSchema> =
  | { readonly _tag: "Pending"; readonly operationKey: string }
  | { readonly _tag: "Failure"; readonly error: FailureSchema["Type"] | SyncFailure };

async function mapTransportFailure<Op extends Operation>(
  operation: Op,
  error: unknown,
  operationKey: string,
): Promise<TransportFailure<Op["failure"]>> {
  if (error instanceof MutationDispatchError) error = error.original;
  if (isSyncFailure(error)) return { _tag: "Failure", error };
  const code = errorCode(error);
  const data = errorData(error);
  if (code === "SYNC_DOMAIN_FAILURE" && isRecord(data) && data._tag === "SyncDomainFailure") {
    try {
      return {
        _tag: "Failure",
        error: await decodeWireValue(operation.failure, data.failure),
      };
    } catch {
      return { _tag: "Failure", error: new SyncFailure({ reason: "unavailable" }) };
    }
  }
  if (code === "SYNC_FAILURE" && isRecord(data) && data._tag === "SyncFailure") {
    try {
      return { _tag: "Failure", error: decodeSyncFailure(data) };
    } catch {
      return { _tag: "Failure", error: new SyncFailure({ reason: "unavailable" }) };
    }
  }

  if (AUTH_FAILURES.has(code ?? "")) {
    return { _tag: "Failure", error: new SyncFailure({ reason: "denied" }) };
  }
  if (INPUT_FAILURES.has(code ?? "")) {
    return { _tag: "Failure", error: new SyncFailure({ reason: "invalid_input" }) };
  }
  if (code === "INVALID_CURSOR") {
    return { _tag: "Failure", error: new SyncFailure({ reason: "invalid_cursor" }) };
  }
  if (code === "DELIVERY_FENCED" || code === "DELIVERY_RECEIPT_FENCED") {
    return { _tag: "Pending", operationKey };
  }
  if (STORAGE_CORRUPTION_FAILURES.has(code ?? "")) {
    return { _tag: "Failure", error: new SyncFailure({ reason: "storage_corrupt" }) };
  }
  if (STORAGE_UNAVAILABLE_FAILURES.has(code ?? "")) {
    return { _tag: "Failure", error: new SyncFailure({ reason: "unavailable" }) };
  }
  if (code === "OFFLINE_PRECONDITION_FAILED") {
    return { _tag: "Failure", error: new SyncFailure({ reason: "invalid_state" }) };
  }
  if (code === "OFFLINE_QUEUE_OVERFLOW" || code === "CLIENT_CLOSED") {
    return { _tag: "Failure", error: new SyncFailure({ reason: "unavailable" }) };
  }
  if (code === "FUNCTION_FAILED") {
    return { _tag: "Failure", error: new SyncFailure({ reason: "unavailable" }) };
  }

  return { _tag: "Pending", operationKey };
}

class MutationDispatchError extends Error {
  readonly _tag = "MutationDispatchError";
  readonly original: unknown;

  constructor(original: unknown) {
    super("Lunora mutation outcome is unknown");
    this.original = original;
  }
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorData(error: unknown): unknown {
  return isRecord(error) ? error.data : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const AUTH_FAILURES = new Set([
  "FORBIDDEN",
  "FORBIDDEN_SHARD",
  "UNAUTHORIZED",
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
  "IDENTITY_MISMATCH",
  "OFFLINE_IDENTITY_CHANGED",
]);
const INPUT_FAILURES = new Set(["BAD_REQUEST", "INVALID_INPUT", "VALIDATION_ERROR"]);
const STORAGE_CORRUPTION_FAILURES = new Set(["STORAGE_CHECKSUM_MISMATCH"]);
const STORAGE_UNAVAILABLE_FAILURES = new Set([
  "SQL_UNAVAILABLE",
  "STORAGE_DELETE_NOT_CONFIGURED",
  "STORAGE_DOWNLOAD_NOT_CONFIGURED",
  "STORAGE_NOT_CONFIGURED",
  "STORAGE_OBJECT_NOT_FOUND",
  "STORAGE_UPLOAD_NOT_CONFIGURED",
  "STORAGE_URL_NOT_CONFIGURED",
]);
