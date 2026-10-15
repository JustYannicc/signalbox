import { SECRET_MASK } from "@signalbox/runner-protocol/SecretsProtocol";
import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";

/**
 * What keeps a folder's secrets on the machine (#395): every value the Runner
 * loaded, replaced by `***` wherever it shows up in what the Runner sends
 * (frames to the thread, session rows) or logs, the way CI masks secrets in
 * its logs and `op run` masks them in a command's output. Values only ever
 * join: a value swapped out may still sit in a transcript from before.
 *
 * Values of `MIN_MASKED_LENGTH - 1` characters or fewer are left alone: masking
 * `1` or `true` would garble every transcript and hides nothing.
 */
export interface SecretMask {
  readonly add: (values: Iterable<string>) => void;
  /** `text` with every value masked. */
  readonly text: (text: string) => string;
  /** Every string in plain objects and arrays masked; anything else is left as it is. */
  readonly value: <A>(value: A) => A;
  /** A JSON text with every string in it masked, still the same JSON otherwise. */
  readonly json: (text: string) => string;
}

export const MIN_MASKED_LENGTH = 7;

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export const makeSecretMask = (): SecretMask => {
  const values = new Set<string>();
  /** Longest first, so a value that contains another is masked whole. */
  let ordered: ReadonlyArray<string> = [];
  /** Each value as JSON text writes it: a quote, backslash or newline comes escaped. */
  let escaped: ReadonlyArray<string> = [];

  const add = (added: Iterable<string>) => {
    let grew = false;
    for (const value of added) {
      if (value.length < MIN_MASKED_LENGTH || values.has(value)) continue;
      values.add(value);
      grew = true;
    }
    if (!grew) return;
    ordered = [...values].toSorted((left, right) => right.length - left.length);
    escaped = ordered.map((value) => JSON.stringify(value).slice(1, -1));
  };

  const text = (input: string) => {
    let output = input;
    for (const value of ordered) {
      if (output.includes(value)) output = output.replaceAll(value, SECRET_MASK);
    }
    return output;
  };

  const walk = (input: unknown): unknown => {
    if (typeof input === "string") return text(input);
    if (typeof input !== "object" || input === null) return input;
    if (Array.isArray(input)) {
      let changed = false;
      const output = input.map((item) => {
        const masked = walk(item);
        changed ||= masked !== item;
        return masked;
      });
      return changed ? output : input;
    }
    if (!isPlainObject(input)) return input;
    let changed = false;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      const masked = walk(item);
      changed ||= masked !== item;
      output[key] = masked;
    }
    return changed ? output : input;
  };

  const appearsIn = (input: string) =>
    ordered.some((value) => input.includes(value)) ||
    escaped.some((value) => input.includes(value));

  const json = (input: string) => {
    if (!appearsIn(input)) return input;
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return text(input);
    }
    return JSON.stringify(walk(parsed));
  };

  return {
    add,
    text,
    value: <A>(input: A) => (ordered.length === 0 ? input : (walk(input) as A)),
    json,
  };
};

/** `inner` with every secret masked, failures written out as text so theirs are masked too. */
export const maskingLogger = (
  mask: SecretMask,
  inner: Logger.Logger<unknown, unknown> = Logger.defaultLogger,
) =>
  Logger.make((options) =>
    inner.log({
      ...options,
      message: mask.value(
        options.cause.reasons.length === 0
          ? options.message
          : [options.message, Cause.pretty(options.cause)],
      ),
      cause: Cause.empty,
    }),
  );
