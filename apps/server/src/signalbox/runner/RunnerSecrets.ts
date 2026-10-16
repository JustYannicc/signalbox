import type { SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import type { OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import {
  type SecretsAccess,
  type SecretsRegistration,
  secretsJson,
} from "@signalbox/runner-protocol/SecretsProtocol";
import { SESSION_PATHS } from "@signalbox/runner-protocol/SessionProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { routesHarness } from "./RunnerGatewayPins.ts";
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
 * model access) is never replaced, and neither is one that could take the
 * harness off the gateway (`routesHarness`, #600): the turn says which ones it
 * skipped.
 *
 * The model must not see them either (#591): before the harness gets a new
 * set, the masked values are registered with the thread, which the
 * ModelGateway scrubs every model request with. A registration that fails
 * stops the turn, since the gateway serves none of its requests until then.
 *
 * The same values fill the agent's `{{secret:NAME}}` placeholders (#592,
 * `RunnerSecretFill.ts`), only on a machine whose sends the thread checks.
 */

export class SecretsRegisterError extends Schema.TaggedError<SecretsRegisterError>()(
  "SecretsRegisterError",
  { message: Schema.String },
) {}

export interface SecretsReport {
  /** Something the thread's transcript should say: what didn't load. */
  readonly notice: (message: string) => Effect.Effect<void>;
  /** A line for the turn's diagnostics. */
  readonly info: (message: string) => Effect.Effect<void>;
  /** Hands the thread every value to hide from the model, and where each came from (`SecretsProtocol.ts`). */
  readonly register: (
    registration: SecretsRegistration,
  ) => Effect.Effect<void, SecretsRegisterError>;
}

/** The name the 1Password service account token is masked under: 1Password's own variable. */
const TOKEN_NAME = "OP_SERVICE_ACCOUNT_TOKEN";

export interface RunnerSecrets {
  /**
   * Brings the variables in line with `access`; answers their version. Fails
   * when they couldn't be registered: the gateway then serves none of the
   * turn's model requests, and the harness has none of them.
   */
  readonly load: (
    access: SecretsAccess | null,
    report: SecretsReport,
  ) => Effect.Effect<number, SecretsRegisterError>;
  /** The variables, for a harness session as it opens. */
  readonly environment: () => Readonly<Record<string, string>>;
  /** `text` with every secret masked, for text that is cut short before it's sent. */
  readonly mask: (text: string) => string;
  /**
   * What the agent's placeholders fill with: the hidden values by name, and
   * whether this machine's sends are checked (`SecretsAccess.guarded`).
   */
  readonly fillable: () => SecretFillable;
}

export interface SecretFillable {
  readonly values: ReadonlyMap<string, string>;
  readonly guarded: boolean;
}

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

const listed = (names: ReadonlySet<string>) => [...names].toSorted().join(", ");

export const makeRunnerSecrets = (input: {
  readonly onePassword: OnePassword;
  readonly mask: SecretMask;
  /** What the harness environment sets, never replaced; read at each load. */
  readonly reserved: () => ReadonlySet<string>;
}): RunnerSecrets => {
  let variables: Readonly<Record<string, string>> = {};
  let version = 0;
  let fillable: SecretFillable = { values: new Map(), guarded: false };
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
      const guarded = access?.guarded === true;
      fillable = { ...fillable, guarded };
      if (environments.length === 0) {
        read = null;
        use({});
        fillable = { values: new Map(), guarded };
        return version;
      }
      const token = access?.token ?? null;
      if (token === null) {
        read = null;
        use({});
        fillable = { values: new Map(), guarded };
        yield* report.notice(
          "This folder's secrets come from 1Password, but no 1Password service account is connected, so none loaded. Connect one in the folder's Secrets.",
        );
        // None to hide, which the gateway waits to hear before it serves the turn.
        yield* report.register({ secrets: [], sources: [] });
        return version;
      }
      if (read !== null && read.token === token && sameStrings(read.environments, environments)) {
        return version;
      }
      input.mask.add([{ name: TOKEN_NAME, value: token }]);
      const failures: Array<string> = [];
      const next: Record<string, string> = {};
      const hidden: Array<SecretValue> = [];
      const skipped = new Set<string>();
      const routing = new Set<string>();
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
                  Effect.map((variables) => ({ environmentId, variables })),
                  Effect.catchTags({
                    OnePasswordError: (error) => {
                      failures.push(`Environment ${environmentId}: ${error.message}`);
                      return Effect.succeed({ environmentId, variables: [] });
                    },
                  }),
                ),
              // In parallel, kept in order.
              { concurrency: "unbounded" },
            );
      // Top level first: a nearer folder's variable replaces one from above.
      const sources = new Map<string, OnePasswordEnvironmentId>();
      /** Each name's nearest value: what placeholders fill with. */
      const current = new Map<string, string>();
      for (const { environmentId, variables } of found) {
        for (const variable of variables) {
          if (!VARIABLE_NAME.test(variable.name)) continue;
          if (reserved.has(variable.name)) {
            skipped.add(variable.name);
            continue;
          }
          if (routesHarness(variable.name)) {
            routing.add(variable.name);
            continue;
          }
          next[variable.name] = variable.value;
          sources.set(variable.name, environmentId);
          current.set(variable.name, variable.value);
          if (variable.masked) hidden.push({ name: variable.name, value: variable.value });
        }
      }
      input.mask.add(hidden);
      // The model must never see them, so the harness gets none the gateway doesn't know.
      yield* report
        .register({
          secrets: hidden,
          // Only the hidden ones are asked about before they leave: the others aren't secret.
          sources: [...new Set(hidden.map(({ name }) => name))].flatMap((name) => {
            const environment = sources.get(name);
            return environment === undefined ? [] : [{ name, environment }];
          }),
        })
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              read = null;
              use({});
              fillable = { values: new Map(), guarded };
            }),
          ),
        );
      read = failures.length === 0 ? { token, environments } : null;
      use(next);
      fillable = { values: current, guarded };
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
          `Skipped ${listed(skipped)} from 1Password: Signalbox sets ${skipped.size === 1 ? "it" : "them"} for the agent's own harness.`,
        );
      }
      if (routing.size > 0) {
        yield* report.notice(
          `Skipped ${listed(routing)} from 1Password: ${routing.size === 1 ? "it" : "they"} could send the agent's model requests, or copies of them, around the gateway that keeps secrets out of them.`,
        );
      }
      return version;
    });

  return {
    load,
    environment: () => variables,
    mask: input.mask.text,
    fillable: () => fillable,
  };
};

/**
 * Registers a machine's secrets with its thread (`SESSION_PATHS.secrets`)
 * with the turn's session token. Needs an `HttpClient`. Errors never quote
 * the request.
 */
export const makeSecretsRegistrar = Effect.fn("makeSecretsRegistrar")(function* (cloudUrl: string) {
  const http = yield* HttpClient.HttpClient;
  const url = `${cloudUrl.replace(/\/+$/, "")}${SESSION_PATHS.secrets}`;
  return (token: string, registration: SecretsRegistration) =>
    Effect.gen(function* () {
      // An HTTP error names the method and URL, never the body.
      const notSent = (error: { readonly message: string }) =>
        new SecretsRegisterError({ message: error.message });
      const response = yield* http
        .execute(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.bodyText(
              secretsJson.registration.encode(registration),
              "application/json",
            ),
          ),
        )
        .pipe(Effect.mapError(notSent));
      if (response.status === 200) return;
      const answer = yield* response.text.pipe(Effect.mapError(notSent));
      return yield* new SecretsRegisterError({
        message: `the cloud answered HTTP ${response.status}: ${answer.slice(0, 200)}`,
      });
    });
});
