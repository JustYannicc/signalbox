import { makeSecretScrubber, type SecretValue, secretPlaceholder } from "./SecretScrubber.ts";

/**
 * Where a folder secret's placeholder is filled in (#592). The agent writes
 * `{{secret:NAME}}`, never a value: the scrubber turns every value back into
 * it on the way to the model (`SecretScrubber.ts`), and these fill it in
 * again at the boundary, deterministically, outside the model:
 *
 * - on the machine, in what the agent writes or runs (a file, a command),
 *   before the harness runs the tool (`RunnerSecretFill.ts`);
 * - at the machine's egress, in what a program sends, once the person let the
 *   secret go to that host (`thread/egress/` in the cloud).
 *
 * Spaces inside the braces are allowed, as in `op inject`. A bare
 * `secret:NAME` without braces is never touched.
 */

/** What a secret's name may be: an environment variable's. */
export const SECRET_NAME = "[A-Za-z_][A-Za-z0-9_]*";

const PLACEHOLDER = new RegExp(`\\{\\{\\s*secret:(${SECRET_NAME})\\s*\\}\\}`, "g");

/** A placeholder a URL or form encoder percent-encoded; its name is the group. */
export const ENCODED_PLACEHOLDER = new RegExp(
  `%7B%7B(?:\\s|%20|\\+)*secret(?::|%3A)(${SECRET_NAME})(?:\\s|%20|\\+)*%7D%7D`,
  "gi",
);

/** Names in a sentence, sorted: "A, B, C". */
export const listedNames = (names: Iterable<string>) => [...names].toSorted().join(", ");

/** The secret names `text` holds placeholders for. */
export const placeholderNames = (text: string): ReadonlySet<string> =>
  new Set(Array.from(text.matchAll(PLACEHOLDER), (match) => match[1]!));

export interface Filled {
  readonly text: string;
  /** Names whose placeholder was filled in. */
  readonly used: ReadonlySet<string>;
  /** Names with a placeholder but no value: left as they are. */
  readonly unknown: ReadonlySet<string>;
}

/** `text` with each placeholder whose name `values` has replaced by its value. */
export const fillPlaceholders = (text: string, values: ReadonlyMap<string, string>): Filled => {
  const used = new Set<string>();
  const unknown = new Set<string>();
  const filled = text.replace(PLACEHOLDER, (placeholder, name: string) => {
    const value = values.get(name);
    if (value === undefined) {
      unknown.add(name);
      return placeholder;
    }
    used.add(name);
    return value;
  });
  return { text: filled, used, unknown };
};

/**
 * Every secret `text` uses, by placeholder or by value in any form the
 * scrubber knows (`secretForms`): what a send would let go, whichever way the
 * program got it.
 */
export const secretsIn = (
  text: string,
  scrubber: { readonly text: (text: string) => string },
): ReadonlySet<string> => {
  const named = placeholderNames(text);
  const scrubbed = placeholderNames(scrubber.text(text));
  return new Set([...named, ...scrubbed]);
};

/** A scrubber and the name-to-value map for one set of secrets, built once. */
export const makeSecretLookup = (secrets: ReadonlyArray<SecretValue>) => ({
  scrubber: makeSecretScrubber(secrets),
  values: new Map(secrets.map(({ name, value }) => [name, value])) as ReadonlyMap<string, string>,
});

export { secretPlaceholder };
