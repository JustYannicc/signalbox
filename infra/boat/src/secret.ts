import * as Redacted from "effect/Redacted";

/** A secret as the SDK and resource props accept it. */
export type SecretInput = string | Redacted.Redacted<string>;

/** The plain value of a secret, for comparison or a request body. */
export const reveal = (value: SecretInput): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** Wrap a secret the API returned so it stays `Redacted` in state and logs. */
export const redact = (value: SecretInput): Redacted.Redacted<string> =>
  Redacted.isRedacted(value) ? value : Redacted.make(value);
