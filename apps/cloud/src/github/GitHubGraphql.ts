import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Decodes GraphQL data only when GitHub did not return partial data alongside errors. */
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
          : Option.none(),
      ),
    );
};
