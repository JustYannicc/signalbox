import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class RunnerImageMismatch extends Data.TaggedError("RunnerImageMismatch")<{
  readonly reference: string;
}> {
  override get message() {
    return `${this.reference} does not name the Runner image that passed the smoke test.`;
  }
}

const publication = Schema.Struct({
  references: Schema.NonEmptyArray(
    Schema.String.check(
      Schema.isPattern(/^ghcr\.io\/justyannicc\/signalbox-runner:[\w][\w.-]{0,127}$/),
    ),
  ),
  imageId: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
});

/** Validate every tag before Alchemy can publish any of them. */
export const verifyRunnerPublication = <E, R>(
  input: unknown,
  inspect: (reference: string) => Effect.Effect<{ readonly Id: string }, E, R>,
) =>
  Effect.gen(function* () {
    const { references, imageId } = yield* Schema.decodeUnknownEffect(publication)(input);
    for (const reference of references) {
      const image = yield* inspect(reference);
      if (image.Id !== imageId) {
        return yield* new RunnerImageMismatch({ reference });
      }
    }
    return references.map((reference) => {
      const separator = reference.lastIndexOf(":");
      return { name: reference.slice(0, separator), tag: reference.slice(separator + 1) };
    });
  });
