import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { FunctionReference, LunoraClient } from "lunorash/client";

import type {
  Failure,
  HomeOperations,
  Input,
  Output,
  SyncCursor,
  SyncSchema,
  SyncViewSource,
  ViewFrame,
} from "../definition.ts";
import { SyncCursor as SyncCursorSchema, SyncFailure } from "../definition.ts";
import { decodeWireValue, encodeWireValue, type WireValue } from "./lunoraWireValue.ts";

const isSyncFailure = Schema.is(SyncFailure);
const revocationCodes = new Set([
  "FORBIDDEN",
  "FORBIDDEN_SHARD",
  "UNAUTHORIZED",
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
  "IDENTITY_MISMATCH",
  "OFFLINE_IDENTITY_CHANGED",
]);

type ObserveResult<OutputValue extends SyncSchema, FailureValue extends SyncSchema> =
  | {
      readonly _tag: "Value";
      readonly value: WireValue<OutputValue>;
      readonly cursor: string;
    }
  | { readonly _tag: "Failure"; readonly failure: WireValue<FailureValue> };

interface ObserveInput<S extends SyncSchema> {
  readonly input: WireValue<S>;
  readonly resume?: string;
}

type ViewOperationShape = {
  readonly input: SyncSchema;
  readonly output: SyncSchema;
  readonly failure: SyncSchema;
};

type ObserveReference<Op extends ViewOperationShape> = FunctionReference<
  "query",
  ObserveInput<Op["input"]>,
  ObserveResult<Op["output"], Op["failure"]>
>;

type ViewReferences<Views extends HomeOperations["views"]> = {
  readonly [K in keyof Views]: ObserveReference<Views[K]>;
};

const boundClientShards = new WeakMap<object, string>();

/** Client-safe reads only; Lunora references stay captured inside the adapter. */
export type LunoraSyncViewClient<Views extends HomeOperations["views"]> = SyncViewSource<Views>;

/** Bind a client dedicated to one bound home without exposing raw RPC methods. */
export function makeLunoraSyncViewClient<Views extends HomeOperations["views"]>(
  client: LunoraClient,
  operations: Views,
  references: ViewReferences<Views>,
  options: { readonly shardKey: string },
): LunoraSyncViewClient<Views> {
  const previousShard = boundClientShards.get(client as object);
  if (previousShard !== undefined && previousShard !== options.shardKey) {
    throw new Error("A Lunora sync view client must be dedicated to one bound home shard.");
  }
  boundClientShards.set(client as object, options.shardKey);

  const view = <K extends keyof Views & string>(
    operation: K,
    input: Input<Views[K]>,
    resume?: SyncCursor,
  ): Stream.Stream<ViewFrame<Output<Views[K]>>, Failure<Views[K]> | SyncFailure> => {
    const reference = references[operation];
    const definition = operations[operation];
    if (!reference || !definition) {
      return Stream.fail(new SyncFailure({ reason: "invalid_input" }));
    }
    return Stream.unwrap(
      Effect.tryPromise({
        try: () => encodeWireValue(definition.input, input, "invalid_input"),
        catch: () => new SyncFailure({ reason: "invalid_input" }),
      }).pipe(
        Effect.map((encodedInput) =>
          subscribeView(
            client,
            definition,
            reference,
            encodedInput as WireValue<Views[K]["input"]>,
            resume,
            options.shardKey,
          ),
        ),
      ),
    );
  };

  return Object.freeze({ view });
}

function subscribeView<Op extends ViewOperationShape>(
  client: LunoraClient,
  definition: Op,
  reference: ObserveReference<Op>,
  input: WireValue<Op["input"]>,
  resume: SyncCursor | undefined,
  shardKey: string,
): Stream.Stream<ViewFrame<Op["output"]["Type"]>, Op["failure"]["Type"] | SyncFailure> {
  const decodeCursor = decoder(SyncCursorSchema);
  const args: ObserveInput<Op["input"]> = {
    input,
    ...(resume === undefined ? {} : { resume: String(resume) }),
  };

  return Stream.callback<ViewFrame<Op["output"]["Type"]>, Op["failure"]["Type"] | SyncFailure>(
    (queue) =>
      Effect.acquireRelease(
        Effect.try({
          try: () => {
            let stopped = false;
            let firstValue = true;
            let resetNext = resume !== undefined;
            let wasConnected = client.connectionStatus() === "connected";
            let unsubscribeQuery: (() => void) | undefined;
            let released = false;
            let pendingResult: ObserveResult<Op["output"], Op["failure"]> | undefined;
            let decoding = false;
            let terminalPending = false;

            const stopQuery = () => {
              if (unsubscribeQuery) {
                unsubscribeQuery();
                unsubscribeQuery = undefined;
              }
            };
            const revoke = () => {
              if (stopped) return;
              stopped = true;
              pendingResult = undefined;
              Queue.offerUnsafe(queue, { _tag: "Revoked" });
              Queue.endUnsafe(queue);
              stopQuery();
            };
            const fail = (failure: Op["failure"]["Type"] | SyncFailure) => {
              if (stopped) return;
              stopped = true;
              pendingResult = undefined;
              Queue.failCauseUnsafe(queue, Cause.fail(failure));
              Queue.endUnsafe(queue);
              stopQuery();
            };
            const processNext = () => {
              if (stopped || decoding || pendingResult === undefined) return;
              const result = pendingResult;
              pendingResult = undefined;
              decoding = true;

              void (async () => {
                try {
                  if (result._tag === "Failure") {
                    const failure = await decodeWireValue(
                      definition.failure,
                      result.failure,
                      "unavailable",
                    );
                    if (stopped) return;
                    fail(failure);
                    return;
                  }

                  const value = await decodeWireValue(
                    definition.output,
                    result.value,
                    "unavailable",
                  );
                  if (stopped) return;

                  let cursor: SyncCursor;
                  try {
                    cursor = decodeCursor(result.cursor);
                  } catch {
                    fail(new SyncFailure({ reason: "invalid_cursor" }));
                    return;
                  }

                  if (stopped) return;
                  let frame: ViewFrame<Op["output"]["Type"]>;
                  if (resetNext) {
                    frame = { _tag: "Reset", value, cursor };
                    resetNext = false;
                  } else if (firstValue) {
                    frame = { _tag: "Snapshot", value, cursor };
                  } else {
                    frame = { _tag: "Update", value, cursor };
                  }
                  firstValue = false;
                  Queue.offerUnsafe(queue, frame);
                } catch {
                  if (!stopped) fail(new SyncFailure({ reason: "unavailable" }));
                } finally {
                  decoding = false;
                  if (!stopped) processNext();
                }
              })();
            };

            const receive = (result: ObserveResult<Op["output"], Op["failure"]>) => {
              if (stopped || terminalPending) return;
              if (result._tag === "Failure") terminalPending = true;
              pendingResult = result;
              processNext();
            };

            const unsubscribeStatus = client.onConnectionStatus((status) => {
              if (wasConnected && status !== "connected") resetNext = true;
              if (status === "connected") wasConnected = true;
            });

            try {
              unsubscribeQuery = client.subscribe(reference, args, receive, {
                onError: (error) => {
                  if (revocationCodes.has(error.code ?? "")) {
                    revoke();
                    return;
                  }
                  fail(
                    new SyncFailure({
                      reason: error.code === "INVALID_CURSOR" ? "invalid_cursor" : "unavailable",
                    }),
                  );
                },
                shardKey,
              });
              if (stopped) stopQuery();
            } catch {
              unsubscribeStatus();
              throw new SyncFailure({ reason: "unavailable" });
            }

            return () => {
              if (released) return;
              released = true;
              stopped = true;
              pendingResult = undefined;
              stopQuery();
              unsubscribeStatus();
            };
          },
          catch: (error) =>
            isSyncFailure(error) ? error : new SyncFailure({ reason: "unavailable" }),
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      ).pipe(Effect.asVoid),
    { bufferSize: 1, strategy: "sliding" },
  );
}

function decoder<S extends Schema.Constraint>(schema: S): (value: unknown) => S["Type"] {
  return Schema.decodeUnknownSync(schema as unknown as Schema.ConstraintDecoder<S["Type"]>, {
    onExcessProperty: "error",
  });
}
