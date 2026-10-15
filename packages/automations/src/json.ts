import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** Plain data in the journal's TEXT columns. Steps only ever pass data that survives JSON. */
const codec = Schema.fromJsonString(Schema.Unknown);
const decode = Schema.decodeSync(codec);
const decodeOption = Schema.decodeOption(codec);

export const toJson: (value: unknown) => string = Schema.encodeSync(codec);

/** Reads a stored column back; SQL NULL stays null. */
export const fromJson = (text: string | null): unknown => (text === null ? null : decode(text));

/** Parses text that may or may not be JSON, such as an HTTP body; returns it unchanged when it isn't. */
export const jsonOrText = (text: string): unknown =>
  Option.getOrElse(decodeOption(text), () => text);

/** A JSON object's fields, or none when the value isn't an object. */
export const asRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  Predicate.isObject(value) ? value : {};
