import { MIN_SCRUBBED_LENGTH, type SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import { routesHarness } from "@signalbox/runner-protocol/HarnessSecretPolicy";

export interface HookSecretBoundaryOptions {
  /** Recheck the owning host's live attempt before and after every port call. */
  readonly assertCurrent: (signal: AbortSignal) => void | Promise<void>;
  readonly resolveNamedSecret: (name: string, signal: AbortSignal) => Promise<SecretValue>;
  /** Connections owns `op://` lookup and returns every raw value it filled. */
  readonly fillVault: (
    text: string,
    signal: AbortSignal,
  ) => Promise<{ readonly text: string; readonly secrets: ReadonlyArray<SecretValue> }>;
  /** Register values and mark even an empty set ready for this host attempt. */
  readonly register: (secrets: ReadonlyArray<SecretValue>, signal: AbortSignal) => Promise<void>;
  /** Scrub against the host's registered-value snapshot with the existing scrubber. */
  readonly scrub: (text: string, signal: AbortSignal) => string | Promise<string>;
}

export interface HookSecretBoundary {
  /** Fill only for the supplied write, then return its scrubbed result. */
  readonly useWrite: (
    text: string,
    operation: (filled: string, signal: AbortSignal) => Promise<string>,
    signal: AbortSignal,
  ) => Promise<string>;
  /** Fill command environment values, run the command, and return scrubbed output. */
  readonly useEnvironment: (
    environment: Readonly<Record<string, string>>,
    operation: (filled: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<string>,
    signal: AbortSignal,
  ) => Promise<string>;
}

type FailureReason =
  | "cancelled"
  | "stale"
  | "invalid"
  | "resolve"
  | "fill"
  | "register"
  | "operation"
  | "scrub";

/** Error messages never copy values or details from a secret-owning port. */
export class HookSecretBoundaryError extends Error {
  readonly _tag = "HookSecretBoundaryError";
  readonly reason: FailureReason;

  constructor(reason: FailureReason) {
    super("Hook secret boundary failed.");
    this.reason = reason;
  }
}

const failure = (reason: FailureReason) => new HookSecretBoundaryError(reason);
const PLACEHOLDER = /\{\{secret:([A-Za-z_][A-Za-z0-9_]*)\}\}|\{\{op:\/\/[^{}]+\}\}/g;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const validateSecret = (secret: SecretValue): void => {
  if (
    secret === null ||
    typeof secret !== "object" ||
    typeof secret.name !== "string" ||
    !NAME.test(secret.name) ||
    typeof secret.value !== "string" ||
    // The shared scrubber intentionally ignores shorter strings.
    secret.value.length < MIN_SCRUBBED_LENGTH
  ) {
    throw failure("invalid");
  }
};

export function createHookSecretBoundary(ports: HookSecretBoundaryOptions): HookSecretBoundary {
  const assertCurrent = async (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) throw failure("cancelled");
    try {
      await ports.assertCurrent(signal);
    } catch {
      throw failure("stale");
    }
    if (signal.aborted) throw failure("cancelled");
  };

  const call = async <A>(
    signal: AbortSignal,
    reason: FailureReason,
    operation: (signal: AbortSignal) => A | PromiseLike<A>,
  ): Promise<A> => {
    await assertCurrent(signal);
    let result: A;
    try {
      result = await operation(signal);
    } catch {
      if (signal.aborted) throw failure("cancelled");
      throw failure(reason);
    }
    await assertCurrent(signal);
    return result;
  };

  const fill = async (
    input: string,
    signal: AbortSignal,
  ): Promise<{ readonly text: string; readonly secrets: ReadonlyArray<SecretValue> }> => {
    const placeholders = [...input.matchAll(PLACEHOLDER)];
    const unrecognized = input.replace(PLACEHOLDER, "");
    if (unrecognized.includes("{{secret:") || unrecognized.includes("{{op://")) {
      throw failure("invalid");
    }

    let cursor = 0;
    const parts: Array<string> = [];
    const secrets: Array<SecretValue> = [];
    const resolved = new Map<string, SecretValue>();
    const vaultFilled = new Map<string, string>();
    for (const match of placeholders) {
      const at = match.index;
      const token = match[0];
      if (at === undefined) throw failure("invalid");
      parts.push(input.slice(cursor, at));

      const name = match[1];
      if (name !== undefined) {
        if (routesHarness(name)) throw failure("invalid");
        let secret = resolved.get(name);
        if (secret === undefined) {
          secret = await call(signal, "resolve", (current) =>
            ports.resolveNamedSecret(name, current),
          );
          validateSecret(secret);
          if (secret.name !== name || routesHarness(secret.name)) throw failure("invalid");
          resolved.set(name, secret);
          secrets.push(secret);
        }
        parts.push(secret.value);
      } else {
        let value = vaultFilled.get(token);
        if (value === undefined) {
          const result = await call(signal, "fill", (current) => ports.fillVault(token, current));
          if (
            result === null ||
            typeof result !== "object" ||
            typeof result.text !== "string" ||
            !Array.isArray(result.secrets) ||
            result.text.includes("{{op://") ||
            result.text.includes("{{secret:") ||
            (result.text !== token && result.secrets.length === 0)
          ) {
            throw failure("fill");
          }
          for (const secret of result.secrets) {
            validateSecret(secret);
            if (routesHarness(secret.name)) throw failure("invalid");
          }
          secrets.push(...result.secrets);
          value = result.text;
          vaultFilled.set(token, value);
        }
        parts.push(value);
      }
      cursor = at + token.length;
    }
    parts.push(input.slice(cursor));
    return { text: parts.join(""), secrets };
  };

  const run = async (
    secrets: ReadonlyArray<SecretValue>,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<string>,
  ): Promise<string> => {
    await call(signal, "register", (current) => ports.register(secrets, current));
    const output = await call(signal, "operation", operation);
    if (typeof output !== "string") throw failure("operation");
    const scrubbed = await call(signal, "scrub", (current) => ports.scrub(output, current));
    if (typeof scrubbed !== "string" || secrets.some(({ value }) => scrubbed.includes(value))) {
      throw failure("scrub");
    }
    return scrubbed;
  };

  return {
    useWrite: async (text, operation, signal) => {
      const filled = await fill(text, signal);
      return run(filled.secrets, signal, (current) => operation(filled.text, current));
    },
    useEnvironment: async (environment, operation, signal) => {
      for (const name of Object.keys(environment)) {
        if (!NAME.test(name)) throw failure("invalid");
      }

      const entries: Array<readonly [string, string]> = [];
      const secrets: Array<SecretValue> = [];
      for (const [name, value] of Object.entries(environment)) {
        if (typeof value !== "string") throw failure("invalid");
        const filled = await fill(value, signal);
        entries.push([name, filled.text]);
        secrets.push(...filled.secrets);
      }
      const filled: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(entries));
      return run(secrets, signal, (current) => operation(filled, current));
    },
  };
}
