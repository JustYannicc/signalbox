import {
  makeSecretScrubber,
  MIN_SCRUBBED_LENGTH,
  type SecretValue,
} from "@signalbox/runner-protocol/SecretScrubber";
import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";

/**
 * What keeps a folder's secrets on the machine (#395): every value the Runner
 * loaded, in every form a tool prints it in, replaced by its placeholder
 * `{{secret:NAME}}` wherever it shows up in what the Runner sends (frames to
 * the thread, session rows) or logs. The scrubber is the one the ModelGateway
 * uses on model requests (`SecretScrubber.ts`, #591), so a transcript reads
 * the same as what the model saw. Values only ever join: a value swapped out
 * may still sit in a transcript from before.
 */
export interface SecretMask {
  readonly add: (secrets: Iterable<SecretValue>) => void;
  /** `text` with every value masked. */
  readonly text: (text: string) => string;
  /** Every string in plain objects and arrays masked; anything else is left as it is. */
  readonly value: <A>(value: A) => A;
  /** A JSON text with every string in it masked, still the same JSON otherwise. */
  readonly json: (text: string) => string;
}

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export const makeSecretMask = (): SecretMask => {
  /** Each value, under the name it first came with. */
  const secrets = new Map<string, string>();
  let scrubber = makeSecretScrubber([]);

  const add = (added: Iterable<SecretValue>) => {
    let grew = false;
    for (const { name, value } of added) {
      if (value.length < MIN_SCRUBBED_LENGTH || secrets.has(value)) continue;
      secrets.set(value, name);
      grew = true;
    }
    if (!grew) return;
    scrubber = makeSecretScrubber(Array.from(secrets, ([value, name]) => ({ name, value })));
  };

  const text = (input: string) => scrubber.text(input);

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

  const json = (input: string) => {
    // The scrubber knows JSON's escaped forms, so it finds a value in the text as it is.
    const scrubbed = text(input);
    if (scrubbed === input) return input;
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return scrubbed;
    }
    // Once more over the text, for a value in an object's key.
    return text(JSON.stringify(walk(parsed)));
  };

  return {
    add,
    text,
    value: <A>(input: A) => (scrubber.empty ? input : (walk(input) as A)),
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
