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

  it("returns mutable nested arrays from encoding and validation without adding absent fields", async () => {
    const children = Schema.Struct({
      children: Schema.Array(
        Schema.Struct({
          placements: Schema.Array(Schema.String),
          note: Schema.optional(Schema.String),
        }),
      ),
    });
    const frozenValue = Object.freeze({
      children: Object.freeze([Object.freeze({ placements: Object.freeze(["top"]) })]),
    });

    const encoded = await encodeWireValue(children, frozenValue);
    expect(encoded).toEqual({
      defined: true,
      value: { children: [{ placements: ["top"] }] },
    });
    if (encoded.defined) {
      expectTypeOf(encoded.value.children[0]!.placements).toEqualTypeOf<string[]>();
      expectTypeOf(encoded.value.children[0]!.note).toEqualTypeOf<string | undefined>();
      expect(Object.isFrozen(encoded.value.children)).toBe(false);
      expect(Object.isFrozen(encoded.value.children[0]!.placements)).toBe(false);
      expect(Object.hasOwn(encoded.value.children[0]!, "note")).toBe(false);
      encoded.value.children[0]!.placements.push("nested");
      encoded.value.children.push({ placements: [] });
    }

    const brandedString = Schema.String.pipe(Schema.brand("WireString"));
    const brandedNumber = Schema.Number.pipe(Schema.brand("WireNumber"));
    const stringId = Schema.decodeSync(brandedString)("folder_1");
    const numericId = Schema.decodeSync(brandedNumber)(1);
    const stringWire = await encodeWireValue(Schema.toType(brandedString), stringId);
    const numberWire = await encodeWireValue(Schema.toType(brandedNumber), numericId);
    if (stringWire.defined) expectTypeOf(stringWire.value).toEqualTypeOf<typeof stringId>();
    if (numberWire.defined) expectTypeOf(numberWire.value).toEqualTypeOf<typeof numericId>();

    const frozenWire = Object.freeze({
      defined: true as const,
      value: Object.freeze({
        children: Object.freeze([Object.freeze({ placements: Object.freeze(["wire"]) })]),
      }),
    });
    const validated = await validateWireValue(children, frozenWire);
    expect(validated).toEqual({
      defined: true,
      value: { children: [{ placements: ["wire"] }] },
    });
    if (validated.defined) {
      expect(Object.isFrozen(validated.value.children)).toBe(false);
      expect(Object.isFrozen(validated.value.children[0]!.placements)).toBe(false);
      expect(Object.hasOwn(validated.value.children[0]!, "note")).toBe(false);
      validated.value.children[0]!.placements.push("validated");
    }
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
