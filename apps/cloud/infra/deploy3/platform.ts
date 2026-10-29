import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

class Deploy3OperationFailed extends Data.TaggedError("Deploy3OperationFailed")<{
  readonly message: string;
}> {}

export const isoAt = (milliseconds: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(milliseconds));
export const clockMillis = () => Effect.runSync(Clock.currentTimeMillis);

export function boundedOperation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
) {
  return Effect.runPromise(
    Effect.tryPromise({
      try: operation,
      catch: () => new Deploy3OperationFailed({ message: "Deploy3 operation failed" }),
    }).pipe(Effect.timeout(milliseconds)),
  );
}
