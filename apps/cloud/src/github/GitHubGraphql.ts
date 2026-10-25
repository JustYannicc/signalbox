import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const isNotFoundError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  !Array.isArray(error) &&
  Object.hasOwn(error, "type") &&
  "type" in error &&
  error.type === "NOT_FOUND";

/** Decodes data without GraphQL errors, or when every error marks the lookup as missing. */
export const decodeGraphqlData = <A>(schema: Schema.Codec<A, unknown>) => {
  const decode = Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Struct({
        data: schema,
        errors: Schema.optional(Schema.Array(Schema.Unknown)),
      }),
    ),
  );

  return (text: string) =>
    decode(text).pipe(
      Option.flatMap((answer) =>
        answer.errors === undefined || answer.errors.length === 0
          ? Option.some(answer.data)
          : answer.errors.every(isNotFoundError)
            ? Option.some(answer.data)
            : Option.none(),
      ),
    );
};
