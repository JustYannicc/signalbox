import * as Schema from "effect/Schema";

import { SecretValue } from "./SecretScrubber.ts";

/** Shorter byte patterns collide with ordinary binary downloads. Text redaction has no such floor. */
export const MIN_BINARY_SECRET_BYTES = 8;

export const SecretProtectionWarning = Schema.Struct({
  name: SecretValue.fields.name,
  code: Schema.Literal("binary_secret_too_short"),
});
export type SecretProtectionWarning = typeof SecretProtectionWarning.Type;

const utf8 = new TextEncoder();

/** Names only: callers may return these warnings without exposing a loaded value. */
export const binaryProtectionWarnings = (
  secrets: Iterable<SecretValue>,
): ReadonlyArray<SecretProtectionWarning> =>
  [
    ...new Set(
      [...secrets]
        .filter(({ value }) => utf8.encode(value).byteLength < MIN_BINARY_SECRET_BYTES)
        .map(({ name }) => name),
    ),
  ]
    .toSorted()
    .map((name) => ({ name, code: "binary_secret_too_short" }));
