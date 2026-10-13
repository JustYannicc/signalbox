import * as Schema from "effect/Schema";

/** A schema's JSON text encoding, as plain sync functions: how frames and request bodies travel. */
export const jsonCodec = <
  S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
>(
  schema: S,
) => {
  const codec = Schema.fromJsonString(Schema.toCodecJson(schema));
  return {
    encode: Schema.encodeSync(codec) as (value: S["Type"]) => string,
    decode: Schema.decodeUnknownSync(codec) as (frame: unknown) => S["Type"],
  };
};
