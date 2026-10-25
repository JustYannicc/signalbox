import * as Schema from "effect/Schema";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import {
  decodeWireValue,
  encodeWireValue,
  validateWireValue,
  wireValueCodec,
  wireValueSchema,
} from "@signalbox/sync/adapters/lunoraWireValue";

const readDate = Schema.decodeSync(Schema.DateFromString);
const roundTrip = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("Lunora JSON wire values", () => {
  it("keeps Void, undefined and null distinct through actual JSON serialization", async () => {
    const absent = await encodeWireValue(Schema.Void, undefined);
    const explicitUndefined = await encodeWireValue(Schema.Undefined, undefined);
    const presentNull = await encodeWireValue(Schema.Null, null);
    expect(absent).toEqual({ defined: false });
    expect(explicitUndefined).toEqual(absent);
    expect(presentNull).toEqual({ defined: true, value: null });
    expect(await decodeWireValue(Schema.Void, roundTrip(absent))).toBeUndefined();
    expect(await decodeWireValue(Schema.Undefined, roundTrip(explicitUndefined))).toBeUndefined();
    expect(await decodeWireValue(Schema.Null, roundTrip(presentNull))).toBeNull();
    await expect(decodeWireValue(Schema.Void, presentNull)).rejects.toMatchObject({
      reason: "unavailable",
    });
    await expect(decodeWireValue(Schema.Null, absent)).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("round trips Date codecs while exposing only their encoded JSON type", async () => {
    const value = readDate("2026-10-17T00:00:00.000Z");
    const encoded = await encodeWireValue(Schema.DateFromString, value);
    expect(encoded).toEqual({ defined: true, value: "2026-10-17T00:00:00.000Z" });
    if (encoded.defined) expectTypeOf(encoded.value).toEqualTypeOf<string>();
    const decoded = await decodeWireValue(Schema.DateFromString, roundTrip(encoded));
    expectTypeOf(decoded).toEqualTypeOf<Date>();
    expect(decoded).toEqual(value);
    const codec = wireValueCodec(Schema.DateFromString);
    expect(Schema.decodeUnknownSync(codec)(roundTrip(encoded))).toEqual(value);
    expect(Schema.encodeSync(codec)(value)).toEqual(encoded);
    expect(Schema.is(wireValueSchema(Schema.DateFromString))(encoded)).toBe(true);
  });

  it("refines a wire envelope to the schema's exact presence branch", async () => {
    const absent = await validateWireValue(Schema.Void, { defined: false });
    expect(absent).toEqual({ defined: false });
    expectTypeOf(absent).toEqualTypeOf<{ readonly defined: false }>();

    const presentNull = await validateWireValue(Schema.Null, { defined: true, value: null });
    expect(presentNull).toEqual({ defined: true, value: null });
    if (presentNull.defined) expectTypeOf(presentNull.value).toEqualTypeOf<null>();

    const date = await validateWireValue(Schema.DateFromString, {
      defined: true,
      value: "2026-10-17T00:00:00.000Z",
    });
    expect(date).toEqual({ defined: true, value: "2026-10-17T00:00:00.000Z" });
    if (date.defined) expectTypeOf(date.value).toEqualTypeOf<string>();
    await expect(validateWireValue(Schema.Null, { defined: false })).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("rejects missing presence tags and undefined present values", async () => {
    for (const malformed of [
      {},
      { defined: true },
      { defined: true, value: undefined },
      { defined: false, value: null },
    ]) {
      await expect(decodeWireValue(Schema.Void, malformed, "invalid_input")).rejects.toMatchObject({
        reason: "invalid_input",
      });
    }
    await expect(decodeWireValue(Schema.String, { defined: false })).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("rejects values that cannot be represented by the declared JSON encoding", async () => {
    await expect(encodeWireValue(Schema.BigInt, 1n, "invalid_input")).rejects.toMatchObject({
      reason: "invalid_input",
    });
    await expect(encodeWireValue(Schema.Unknown, Number.NaN)).rejects.toMatchObject({
      reason: "unavailable",
    });
    await expect(encodeWireValue(Schema.Unknown, new Map())).rejects.toMatchObject({
      reason: "unavailable",
    });
    await expect(encodeWireValue(Schema.Unknown, { value: undefined })).rejects.toMatchObject({
      reason: "unavailable",
    });
    await expect(encodeWireValue(Schema.Unknown, [undefined])).rejects.toMatchObject({
      reason: "unavailable",
    });
  });
});
