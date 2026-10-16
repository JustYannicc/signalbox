import type { SignInFill, SignInFillInput } from "@t3tools/contracts/signalboxSignIn";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import { HttpClient } from "effect/http";
import type { SqlError } from "effect/sql/SqlError";

import { makeProfileId } from "../user/profileId.ts";
import { makeTraced } from "../user/tracing.ts";
import {
  type ExecutorLoginError,
  type ExecutorLogins,
  type ExecutorLoginsEnv,
  executorLoginsFromEnv,
  type LoginTurn,
} from "./ExecutorLogins.ts";
import { SignInGrants } from "./SignInGrants.ts";
import { makeSignInLogins } from "./signInLogins.ts";
import { askSiteOf, hostOf, urlOf } from "./signInSites.ts";
import { makeThreadSources } from "./signInSource.ts";

/**
 * A person's own devices signing their tabs in (#586). Each engine (the
 * desktop panel, the phone's WebView) keeps its own session, so a site signed
 * in on one asks again on the next; the device asks here once a tab is in
 * front of the person, and fills the form itself. The same rules as agents'
 * sign-ins (#576): the thread's home decides whose credentials answer, and a
 * standing grant has to cover the site.
 *
 * Values come from Executor for exactly the kinds the form asks for and go
 * straight back in the answer, to the device that asked: nothing here logs,
 * stores or traces one.
 */
export class DeviceSignIn extends Context.Service<
  DeviceSignIn,
  {
    /** The values one step of a login form at `origin` asks for, for a tab of `requester`'s. */
    readonly step: (
      input: SignInFillInput & { readonly requester: string },
    ) => Effect.Effect<SignInFill, SqlError>;
  }
>()("@signalbox/cloud/signIn/DeviceSignIn") {}

const fills = Metric.counter("signalbox_cloud_device_sign_ins_total", {
  description: "Login form steps people's devices asked to fill, by outcome.",
});

/** What Executor's refusal means for the device. */
const refusalOf = (error: ExecutorLoginError): SignInFill => {
  switch (error.reason) {
    case "not-linked":
    case "no-match":
    case "no-folder-source":
      return { _tag: "no-login", reason: error.reason };
    case "not-owner":
      return { _tag: "not-owner" } as const;
    case "unavailable":
      return { _tag: "unavailable", message: error.message };
  }
};

const make = (options: { readonly executor: ExecutorLogins | null }) =>
  Effect.gen(function* () {
    const { executor } = options;
    const grants = yield* SignInGrants;
    const sourceOfThread = yield* makeThreadSources;
    const kept = yield* makeSignInLogins;
    /** Spans carry ids and outcomes, never a site: which sites a person uses is theirs (#285). */
    const traced = makeTraced(yield* makeProfileId);

    const step: DeviceSignIn["Service"]["step"] = (input) =>
      Effect.gen(function* () {
        const url = urlOf(input.origin);
        const host = hostOf(input.origin);
        const site = host === null ? null : askSiteOf(host);
        if (url === null || site === null)
          return { _tag: "no-login", reason: "not-a-site" } as const;
        if (executor === null) {
          return {
            _tag: "unavailable",
            message: "This Signalbox can't read 1Password logins yet.",
          } as const;
        }
        const origin = url.origin;
        const source = yield* sourceOfThread(input.threadId);
        yield* Effect.annotateCurrentSpan("sign_in.source", source._tag);
        const check = yield* grants.check({ requester: input.requester, source, origin });
        switch (check._tag) {
          case "refused":
            return { _tag: "no-login", reason: "not-a-site" } as const;
          case "not-owner":
            return { _tag: "not-owner" } as const;
          case "ask":
            return { _tag: "ask", site: check.site } as const;
        }
        // A person's own 1Password answers only their own requests; grants checked that already.
        const turn: LoginTurn = {
          requester: input.requester,
          scope:
            source._tag === "person"
              ? { kind: "person", person: input.requester }
              : { kind: "folder", folder: source.folderId },
          origin,
        };
        const found = yield* executor.logins(turn).pipe(Effect.result);
        if (found._tag === "Failure") return refusalOf(found.failure);
        // The step before's login, then the one agents sign in with, then the best match.
        const before = yield* kept.ofSite(site);
        const chosen =
          found.success.find((login) => login.item === input.item) ??
          found.success.find((login) => login.item === before?.item_id) ??
          found.success[0];
        if (chosen === undefined) return { _tag: "no-login", reason: "no-match" } as const;
        const resolved = yield* executor
          .resolve({ ...turn, kinds: input.kinds, item: chosen.item })
          .pipe(Effect.result);
        if (resolved._tag === "Failure") return refusalOf(resolved.failure);
        const values = resolved.success;
        const asked = new Set(input.kinds);
        const username = values.username ?? chosen.username ?? undefined;
        const answer: SignInFill = {
          _tag: "filled",
          item: chosen.item,
          title: chosen.title,
          ...(asked.has("username") && username !== undefined ? { username } : {}),
          ...(asked.has("password") && values.password ? { password: values.password } : {}),
          ...(asked.has("totp") && values.totp ? { totp: values.totp } : {}),
        };
        return answer;
      }).pipe(
        Effect.tap((answer) =>
          Effect.all([
            Effect.annotateCurrentSpan("sign_in.outcome", answer._tag),
            Metric.update(Metric.withAttributes(fills, { outcome: answer._tag }), 1),
          ]),
        ),
        traced("DeviceSignIn.fill", {
          "thread.id": input.threadId,
          "requester.id": input.requester,
          "sign_in.kinds": input.kinds.join(","),
        }),
      );

    return DeviceSignIn.of({ step });
  });

/** On `executor`; without one, every fill says 1Password can't be read. */
export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(DeviceSignIn, make(options));

/** Executor with this cloud's login service credential. */
export const layerFromEnv = (env: ExecutorLoginsEnv) =>
  Layer.effect(
    DeviceSignIn,
    Effect.gen(function* () {
      return yield* make({ executor: executorLoginsFromEnv(yield* HttpClient.HttpClient, env) });
    }),
  );
