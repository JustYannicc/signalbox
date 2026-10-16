import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { kernelWords } from "../browser/browserPolicy.ts";
import { KernelApiError } from "../browser/KernelApi.ts";
import type { AuthSubmission, KernelAuth } from "../browser/KernelAuth.ts";
import type {
  ExecutorLoginError,
  ExecutorLogins,
  LoginKind,
  LoginSummary,
  LoginTurn,
  ResolvedLogin,
} from "./ExecutorLogins.ts";
import { emptyFlow, kindsOf, nextStep, withAnswered } from "./loginPolicy.ts";

/**
 * One Kernel Managed Auth login, driven to its end (#576): the profile's
 * connection for the site, made to save no credentials, a started login, and
 * every pause answered from 1Password by `loginPolicy.ts`. Kernel has no
 * webhooks, so the connection is read until the flow ends. Values are read
 * for one submit and dropped; a refused submit is reported by Kernel's code
 * only, since its words could repeat what was sent.
 */

export interface Backends {
  readonly kernel: KernelAuth;
  readonly executor: ExecutorLogins;
}

/**
 * How a login ended: signed in, stopped on something only the person can
 * answer, or unreachable for now (Kernel or 1Password didn't answer), which
 * a later try may get past.
 */
export type Outcome =
  | { readonly _tag: "signed-in"; readonly connectionId: string }
  | { readonly _tag: "stop"; readonly reason: string }
  | { readonly _tag: "unreachable"; readonly reason: string };

/** Kernel waits 10 minutes for input; a tool call shouldn't wait nearly that long. */
export const LOGIN_BUDGET = Duration.minutes(4);

type Stop = Extract<Outcome, { readonly _tag: "stop" }>;
const stop = (reason: string): Stop => ({ _tag: "stop", reason });

const valueOf = (login: ResolvedLogin, kind: LoginKind): string | null => {
  switch (kind) {
    case "username":
      return login.username ?? null;
    case "password":
      return login.password === undefined ? null : Redacted.value(login.password);
    case "totp":
      return login.totp === undefined ? null : Redacted.value(login.totp);
  }
};

type Sent = { readonly _tag: "sent" } | { readonly _tag: "moved" } | Stop;

/** Submits one answer; a pause that moved on meanwhile is just read again. */
const submit = (
  kernel: KernelAuth,
  connectionId: string,
  answer: AuthSubmission,
): Effect.Effect<Sent, KernelApiError> =>
  kernel.submit(connectionId, answer).pipe(
    Effect.as<Sent>({ _tag: "sent" }),
    Effect.catch((error) =>
      error.status >= 400 && error.status < 500 && error.status !== 404
        ? Effect.map(kernel.getConnection(connectionId), (now): Sent =>
            now?.interaction_id === answer.interaction_id
              ? stop(`Kernel refused the answer ${kernelWords(error, { codeOnly: true })}`)
              : { _tag: "moved" },
          )
        : Effect.fail(
            new KernelApiError({
              operation: error.operation,
              status: error.status,
              code: error.code,
              message: "Kernel didn't take the answer.",
            }),
          ),
    ),
  );

const follow = (
  { kernel, executor }: Backends,
  connectionId: string,
  input: {
    readonly turn: LoginTurn;
    readonly login: LoginSummary;
    readonly pause: Effect.Effect<void>;
  },
): Effect.Effect<Outcome, KernelApiError | ExecutorLoginError> =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(LOGIN_BUDGET);
    let flow = emptyFlow;
    while ((yield* Clock.currentTimeMillis) <= deadline) {
      const state = yield* kernel.getConnection(connectionId);
      if (state === null) return stop("Kernel no longer has this site's connection");
      const step = nextStep(state, flow, input.login);
      switch (step._tag) {
        case "wait":
          yield* input.pause;
          continue;
        case "signed-in":
          return { _tag: "signed-in", connectionId };
        case "stop":
          return step;
        case "choose": {
          const sent = yield* submit(kernel, connectionId, {
            interaction_id: step.interactionId,
            selected_choice_id: step.choiceId,
          });
          if (sent._tag === "stop") return sent;
          if (sent._tag === "sent") flow = withAnswered(flow, step.interactionId, []);
          continue;
        }
        case "fill": {
          const kinds = kindsOf(step.fields);
          const resolved = yield* executor.resolve({
            ...input.turn,
            kinds,
            item: input.login.item,
          });
          // The values, for this one submit only.
          const fieldValues: Record<string, string> = {};
          for (const { id, kind } of step.fields) {
            const value = valueOf(resolved, kind);
            if (value === null) {
              return stop(`the 1Password login “${input.login.title}” has no ${kind}`);
            }
            fieldValues[id] = value;
          }
          const sent = yield* submit(kernel, connectionId, {
            interaction_id: step.interactionId,
            field_values: fieldValues,
          });
          if (sent._tag === "stop") return sent;
          if (sent._tag === "sent") flow = withAnswered(flow, step.interactionId, kinds);
        }
      }
    }
    return stop(`the login took longer than ${Duration.format(LOGIN_BUDGET)}`);
  });

/** One login on the profile's connection for `site`, `connectionId` when it's known. */
export const runLogin = (
  backends: Backends,
  input: {
    readonly site: string;
    readonly profileName: string;
    readonly connectionId: string | null;
    readonly turn: LoginTurn;
    readonly login: LoginSummary;
    readonly pause: Effect.Effect<void>;
  },
): Effect.Effect<Outcome> =>
  Effect.gen(function* () {
    const { kernel } = backends;
    const known =
      input.connectionId === null ? null : yield* kernel.getConnection(input.connectionId);
    const connection =
      known ??
      (yield* kernel.ensureConnection({
        domain: input.site,
        profile_name: input.profileName,
        save_credentials: false,
        allowed_domains: [input.site],
        health_checks: true,
        record_session: false,
      }));
    if (connection.save_credentials) yield* kernel.stopSavingCredentials(connection.id);
    yield* kernel.login(connection.id);
    return yield* follow(backends, connection.id, input);
  }).pipe(
    Effect.catchTags({
      KernelApiError: (error: KernelApiError): Effect.Effect<Outcome> =>
        Effect.succeed(
          error.status === 0 || error.status >= 500
            ? { _tag: "unreachable", reason: `Kernel is unreachable: ${kernelWords(error)}` }
            : stop(`Kernel said: ${kernelWords(error)}`),
        ),
      ExecutorLoginError: (error: ExecutorLoginError): Effect.Effect<Outcome> =>
        Effect.succeed(
          error.reason === "unavailable"
            ? { _tag: "unreachable", reason: `1Password didn't answer: ${error.message}` }
            : stop(`1Password's login couldn't be read (${error.reason})`),
        ),
    }),
  );
