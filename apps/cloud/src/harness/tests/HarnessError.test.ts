import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { HarnessError } from "../Harness.ts";

it.effect("round-trips public failures into the correct Effect error channel", () =>
  Effect.gen(function* () {
    const codec = Schema.fromJsonString(HarnessError);
    const encoded = yield* Schema.encodeEffect(codec)(
      new HarnessError({
        operation: "open",
        message: "Provider could not be opened.",
        cause: new TypeError("native transport failed", { cause: "socket closed" }),
      }),
    );
    const recovered = yield* Schema.decodeUnknownEffect(codec)(encoded).pipe(
      Effect.flatMap((failure) => Effect.fail(failure)),
      Effect.catchTags({
        HarnessError: (failure) =>
          Effect.succeed({
            operation: failure.operation,
            message: String(failure),
            cause: failure.cause,
          }),
      }),
    );
    expect(recovered.operation).toBe("open");
    expect(recovered.message).toBe("HarnessError: Provider could not be opened.");
    expect(recovered.cause).toBeInstanceOf(Error);
    expect(recovered.cause).toMatchObject({
      name: "TypeError",
      message: "native transport failed",
      cause: "socket closed",
    });

    const validation = yield* Schema.decodeUnknownEffect(codec)(
      '{"_tag":"HarnessError","operation":"control","message":"No turn is active."}',
    );
    const validationMessage = yield* Effect.fail(validation).pipe(
      Effect.catchTags({ HarnessError: (failure) => Effect.succeed(failure.message) }),
    );
    expect(validationMessage).toBe("No turn is active.");
    expect(validation.cause).toBeUndefined();

    const invalidOperation = yield* Schema.decodeUnknownEffect(codec)(
      '{"_tag":"HarnessError","operation":"unknown","message":"No turn is active."}',
    ).pipe(
      Effect.flatMap((failure) => Effect.fail(failure)),
      Effect.catchTags({
        HarnessError: () => Effect.succeed("harness"),
        SchemaError: () => Effect.succeed("schema"),
      }),
    );
    expect(invalidOperation).toBe("schema");
  }),
);
