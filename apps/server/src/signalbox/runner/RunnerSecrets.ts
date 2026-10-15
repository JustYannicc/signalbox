import type { SecretsAccess } from "@signalbox/runner-protocol/SecretsProtocol";
import * as Effect from "effect/Effect";

import type { OnePassword } from "./RunnerOnePassword.ts";
import type { SecretMask } from "./secretMask.ts";

/**
 * A thread's secrets on its machine (#395): the variables of the 1Password
 * Environments its folders name, read with the owner's service account and
 * given to every harness session as it opens, so the agent's shell, its dev
 * servers and its tests see them. Nothing is written to disk.
 *
 * The secrets are read when a harness session starts: when what the turn
 * names (the Environments and the token) differs from what this machine last
 * read, or the last read fell short. A changed set of variables gets a new
 * `version`, and the Runner restarts the harness session for it, resuming the
 * thread natively, the way it swaps in changed instructions. A secret changed
 * in 1Password reaches the thread when its next machine starts, or when the
 * folder or token changes; nothing needs restarting.
 *
 * Every value 1Password hides by default joins the machine's mask, and so does
 * the token. A variable Signalbox sets for the harness itself (its home, its
 * model access) is never replaced: the turn says which ones it skipped.
 */

export interface SecretsReport {
  /** Something the thread's transcript should say: what didn't load. */
  readonly notice: (message: string) => Effect.Effect<void>;
  /** A line for the turn's diagnostics. */
  readonly info: (message: string) => Effect.Effect<void>;
}

export interface RunnerSecrets {
  /** Brings the variables in line with `access`; answers their version. */
  readonly load: (access: SecretsAccess | null, report: SecretsReport) => Effect.Effect<number>;
  /** The variables, for a harness session as it opens. */
  readonly environment: () => Readonly<Record<string, string>>;
  /** `text` with every secret masked, for text that is cut short before it's sent. */
  readonly mask: (text: string) => string;
}

/**
 * Credentials that would take a harness off the ModelGateway: Claude Code
 * prefers any of them over the gateway token its `apiKeyHelper` reads.
 */
export const HARNESS_CREDENTIALS: ReadonlyArray<string> = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  // These send Claude Code to a cloud provider instead.
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sameVariables = (
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
) => {
  const names = Object.keys(left);
  return (
    names.length === Object.keys(right).length &&
    names.every((name) => Object.hasOwn(right, name) && right[name] === left[name])
  );
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export const makeRunnerSecrets = (input: {
  readonly onePassword: OnePassword;
  readonly mask: SecretMask;
  /** What the harness environment sets, never replaced; read at each load. */
  readonly reserved: () => ReadonlySet<string>;
}): RunnerSecrets => {
  let variables: Readonly<Record<string, string>> = {};
  let version = 0;
  /** What was last read in full; null after a read that fell short, or none. */
  let read: { readonly token: string; readonly environments: ReadonlyArray<string> } | null = null;

  const use = (next: Readonly<Record<string, string>>) => {
    if (sameVariables(variables, next)) return;
    variables = next;
    version += 1;
  };

  const load: RunnerSecrets["load"] = (access, report) =>
    Effect.gen(function* () {
      const environments = access?.environments ?? [];
      if (environments.length === 0) {
        read = null;
        use({});
        return version;
      }
      const token = access?.token ?? null;
      if (token === null) {
        read = null;
        use({});
        yield* report.notice(
          "This folder's secrets come from 1Password, but no 1Password service account is connected, so none loaded. Connect one in the folder's Secrets.",
        );
        return version;
      }
      if (read !== null && read.token === token && sameStrings(read.environments, environments)) {
        return version;
      }
      input.mask.add([token]);
      const failures: Array<string> = [];
      const next: Record<string, string> = {};
      const skipped = new Set<string>();
      const reserved = input.reserved();
      const client = yield* input.onePassword(token).pipe(
        Effect.catchTags({
          OnePasswordError: (error) => {
            failures.push(`signing in to 1Password failed: ${error.message}`);
            return Effect.succeed(null);
          },
        }),
      );
      const found =
        client === null
          ? []
          : yield* Effect.forEach(
              environments,
              (environmentId) =>
                client.variables(environmentId).pipe(
                  Effect.catchTags({
                    OnePasswordError: (error) => {
                      failures.push(`Environment ${environmentId}: ${error.message}`);
                      return Effect.succeed([]);
                    },
                  }),
                ),
              // In parallel, kept in order.
              { concurrency: "unbounded" },
            );
      // Top level first: a nearer folder's variable replaces one from above.
      for (const variables of found) {
        for (const variable of variables) {
          if (!VARIABLE_NAME.test(variable.name)) continue;
          if (reserved.has(variable.name) || HARNESS_CREDENTIALS.includes(variable.name)) {
            skipped.add(variable.name);
            continue;
          }
          next[variable.name] = variable.value;
          if (variable.masked) input.mask.add([variable.value]);
        }
      }
      read = failures.length === 0 ? { token, environments } : null;
      use(next);
      const count = Object.keys(next).length;
      yield* report.info(
        `loaded ${plural(count, "secret", "secrets")} from ${plural(environments.length, "1Password Environment", "1Password Environments")}`,
      );
      if (failures.length > 0) {
        yield* report.notice(
          input.mask.text(
            `Some of this folder's secrets didn't load from 1Password, so this turn runs without them: ${failures.join("; ")}.`,
          ),
        );
      }
      if (skipped.size > 0) {
        yield* report.notice(
          `Skipped ${[...skipped].toSorted().join(", ")} from 1Password: Signalbox sets ${skipped.size === 1 ? "it" : "them"} for the agent's own harness.`,
        );
      }
      return version;
    });

  return { load, environment: () => variables, mask: input.mask.text };
};
