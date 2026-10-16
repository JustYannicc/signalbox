import type { BrowserSignInAnswer } from "@signalbox/runner-protocol/BrowserProtocol";
import type { SignInSource } from "@t3tools/contracts/signalboxSignIn";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/http";
import type { SqlError } from "effect/sql/SqlError";

import { hashSecret } from "../auth/hashedSecrets.ts";
import { profileNameOf } from "../browser/browserPolicy.ts";
import { type KernelAuth, makeKernelAuth } from "../browser/KernelAuth.ts";
import * as PersonBrowsers from "../browser/PersonBrowsers.ts";
import { makeProfileId } from "../user/profileId.ts";
import { makeTraced } from "../user/tracing.ts";
import {
  type CredentialScope,
  type ExecutorLoginReason,
  type ExecutorLogins,
  type ExecutorLoginsEnv,
  executorLoginsFromEnv,
  type LoginSummary,
  type LoginTurn,
} from "./ExecutorLogins.ts";
import { type Backends, type Outcome, runLogin } from "./loginFlow.ts";
import { SignInGrants, sourceKey, sourceOf } from "./SignInGrants.ts";
import { makeSignInLogins } from "./signInLogins.ts";
import { askSiteOf, hostOf, urlOf } from "./signInSites.ts";
import { makeThreadSources } from "./signInSource.ts";

/**
 * Agents sign in with one call (#576). The login service, in the person's
 * object, signs their Kernel profile in to a site with a login from
 * 1Password, under one of their standing grants (#575), and answers only a
 * status: the model never sees a value, and neither does any log, span,
 * table or answer here. Values live in memory for the one submit they're for.
 *
 * Kernel's Managed Auth runs the login in its own browser, on a connection
 * that saves no credentials; this service answers its pauses from Executor
 * (`ExecutorLogins.ts`) by the policy in `loginPolicy.ts`. Kernel's health
 * checks flip a logged-out connection to `NEEDS_AUTH`, and since Kernel holds
 * no credentials to log in again, the sweep does: on the object's alarm, with
 * nobody asked, while the grant still covers the site. What it can't finish
 * stays stopped until an agent's next sign-in, which tells the person why.
 */

/** The object's alarm, which goes off no later than asked. */
export class LoginAlarm extends Context.Service<
  LoginAlarm,
  { readonly armBy: (atMs: number) => Effect.Effect<void> }
>()("@signalbox/cloud/signIn/LoginService/LoginAlarm") {}

export class LoginService extends Context.Service<
  LoginService,
  {
    /** Signs the thread's agent in to `site`, a page or site address, for a turn `requester` asked for. */
    readonly signIn: (input: {
      readonly threadId: string;
      readonly requester: string;
      readonly site: string;
    }) => Effect.Effect<BrowserSignInAnswer, SqlError>;
    /** Logs in again, with nobody asked, wherever Kernel found the person's profile logged out. */
    readonly sweep: Effect.Effect<void, SqlError>;
  }
>()("@signalbox/cloud/signIn/LoginService") {}

/** How often a kept site is read; Kernel's own checks run every 6 hours on the free plan. */
const SWEEP_EVERY = Duration.hours(1);

const NOT_A_SITE = "Pass a site's address, like example.com.";
const NOT_REAL =
  "sign_in signs in to real sites; this machine's own pages and local addresses have no saved logins.";

const signIns = Metric.counter("signalbox_cloud_sign_ins_total", {
  description: "Sign-ins the login service ran, by outcome and what started them.",
});

const notOwner = (site: string) =>
  `Only the person whose 1Password this is signs agents in with it, in turns they asked for. Ask them to sign in to ${site} or to ask you from their own thread.`;

/** What Executor's refusal means for the agent, before any login started. */
const refusalOf = (
  site: string,
  reason: ExecutorLoginReason,
  message = "",
): BrowserSignInAnswer => {
  switch (reason) {
    case "not-linked":
      return {
        _tag: "no_saved_login",
        site,
        message: `The person hasn't linked their 1Password to Signalbox, so there's no saved login for ${site}. Ask them to link it, or to sign in themselves.`,
      };
    case "no-folder-source":
      return {
        _tag: "no_saved_login",
        site,
        message: `This folder has no 1Password of its own, so agents working here can't sign in to ${site} yet. Ask the person.`,
      };
    case "no-match":
      return {
        _tag: "no_saved_login",
        site,
        message: `No 1Password login matches ${site}. Ask the person to save one, or to sign in themselves.`,
      };
    case "not-owner":
      return { _tag: "not_allowed", site, message: notOwner(site) };
    case "unavailable":
      return {
        _tag: "failed",
        site,
        message: `1Password couldn't be read right now: ${message}. Try again later.`,
      };
  }
};

/** A login's end, as the agent hears it. */
const answerOf = (site: string, login: LoginSummary, outcome: Outcome): BrowserSignInAnswer => {
  switch (outcome._tag) {
    case "signed-in":
      return { _tag: "signed_in", site, item: login.title, username: login.username };
    case "stop":
      return {
        _tag: "failed",
        site,
        message: `Couldn't sign in to ${site}: ${outcome.reason}. Tell the person; don't retry.`,
      };
    case "unreachable":
      return {
        _tag: "failed",
        site,
        message: `Couldn't sign in to ${site} right now: ${outcome.reason}. Try again later.`,
      };
  }
};

const make = (options: {
  readonly kernel: KernelAuth | null;
  readonly executor: ExecutorLogins | null;
  readonly pollInterval?: Duration.Duration;
}) =>
  Effect.gen(function* () {
    const { kernel, executor } = options;
    const backends: Backends | null =
      kernel !== null && executor !== null ? { kernel, executor } : null;
    const grants = yield* SignInGrants;
    const browsers = yield* PersonBrowsers.PersonBrowsers;
    const alarm = yield* LoginAlarm;
    const crypto = yield* Crypto.Crypto;
    const owner = yield* makeProfileId;
    const sourceOfThread = yield* makeThreadSources;
    const kept = yield* makeSignInLogins;
    /** Spans carry ids and outcomes, never a site: which sites a person uses is theirs (#285). */
    const traced = makeTraced(owner);
    const poll = options.pollInterval ?? Duration.seconds(1);
    const pause = Duration.isZero(poll) ? Effect.yieldNow : Effect.sleep(poll);
    /** One login at a time: each ends the profile's writing session, and two would race on it. */
    const oneLogin = yield* Semaphore.make(1);
    /** When the sweep next has something due; undefined until read. */
    let nextDue: number | null | undefined;

    const count = (outcome: BrowserSignInAnswer["_tag"], trigger: "agent" | "sweep") =>
      Metric.update(Metric.withAttributes(signIns, { outcome, trigger }), 1);

    /** A person's 1Password answers only their own turns; a folder's source, any of the folder's. */
    const scopeOf = (source: SignInSource, ownerId: string): CredentialScope =>
      source._tag === "person"
        ? { kind: "person", person: ownerId }
        : { kind: "folder", folder: source.folderId };

    /**
     * Logs the profile in to `site`. The thread's session and the one writing
     * the profile back end first, saving it, so neither saves over the login.
     */
    const login = (
      ready: Backends,
      input: {
        readonly site: string;
        readonly ownerId: string;
        readonly turn: LoginTurn;
        readonly login: LoginSummary;
        readonly connectionId: string | null;
        readonly threadId: string | null;
      },
    ) =>
      Effect.gen(function* () {
        yield* browsers.endForSignIn(input.threadId);
        const profileName = profileNameOf(yield* hashSecret(crypto, input.ownerId));
        return yield* runLogin(ready, { ...input, profileName, pause });
      }).pipe(oneLogin.withPermits(1));

    /** Records a login's end; a signed-in site is kept signed in from now on. */
    const record = (row: Parameters<typeof kept.signedIn>[0], outcome: Outcome) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        switch (outcome._tag) {
          case "signed-in": {
            const nextCheckAt = now + Duration.toMillis(SWEEP_EVERY);
            yield* kept.signedIn(
              { ...row, connection_id: outcome.connectionId, next_check_at: nextCheckAt },
              now,
            );
            nextDue = nextDue == null ? nextCheckAt : Math.min(nextDue, nextCheckAt);
            return yield* alarm.armBy(nextCheckAt);
          }
          case "stop":
            return yield* kept.failed(row.site, outcome.reason);
          case "unreachable":
            return yield* kept.checked(row.site, now + Duration.toMillis(SWEEP_EVERY));
        }
      });

    const signIn: LoginService["Service"]["signIn"] = (input) =>
      Effect.gen(function* () {
        const host = hostOf(input.site);
        const url = urlOf(input.site);
        if (host === null || url === null) {
          return { _tag: "failed", site: input.site, message: NOT_A_SITE } as const;
        }
        const site = askSiteOf(host);
        if (site === null) return { _tag: "failed", site: host, message: NOT_REAL } as const;
        if (backends === null) {
          const message =
            kernel === null
              ? "This Signalbox has no cloud browser to sign in with."
              : "This Signalbox can't read 1Password logins yet.";
          return { _tag: "failed", site, message } as const;
        }
        const origin = url.origin;
        const source = yield* sourceOfThread(input.threadId);
        yield* Effect.annotateCurrentSpan("sign_in.source", source._tag);
        const check = yield* grants.check({ requester: input.requester, source, origin });
        switch (check._tag) {
          case "refused":
            return { _tag: "failed", site, message: check.message } as const;
          case "not-owner":
            return { _tag: "not_allowed", site, message: notOwner(site) } as const;
          case "ask":
            return {
              _tag: "not_allowed",
              site,
              message: `Agents need the person's permission to sign in to ${check.site}. Stop and ask them: they can allow it in Settings → Sign-in, for ${check.site} or everywhere, and then ask you to try again.`,
            } as const;
        }
        const ownerId = (yield* owner) ?? input.requester;
        const turn: LoginTurn = {
          requester: input.requester,
          scope: scopeOf(source, ownerId),
          origin,
        };
        const found = yield* backends.executor.logins(turn).pipe(Effect.result);
        if (found._tag === "Failure") {
          return refusalOf(site, found.failure.reason, found.failure.message);
        }
        // The login it signed in with before, while 1Password still matches it; else the best match.
        const before = yield* kept.ofSite(site);
        const chosen =
          found.success.find((each) => each.item === before?.item_id) ?? found.success[0];
        if (chosen === undefined) return refusalOf(site, "no-match");
        const outcome = yield* login(backends, {
          site,
          ownerId,
          turn,
          login: chosen,
          connectionId: before?.connection_id ?? null,
          threadId: input.threadId,
        });
        yield* record(
          {
            site,
            origin,
            connection_id: before?.connection_id ?? "",
            source: sourceKey(source),
            item_id: chosen.item,
            item_title: chosen.title,
            username: chosen.username,
            next_check_at: 0,
          },
          outcome,
        );
        return answerOf(site, chosen, outcome);
      }).pipe(
        Effect.tap((answer) =>
          Effect.all([
            Effect.annotateCurrentSpan("sign_in.outcome", answer._tag),
            count(answer._tag, "agent"),
          ]),
        ),
        traced("LoginService.signIn", {
          "thread.id": input.threadId,
          "requester.id": input.requester,
        }),
      );

    /** Arms the alarm for the next due site, soon after now at the earliest. */
    const rearm = Effect.gen(function* () {
      nextDue = yield* kept.nextCheck;
      const now = yield* Clock.currentTimeMillis;
      if (nextDue !== null) yield* alarm.armBy(Math.max(nextDue, now + 1000));
    }).pipe(
      Effect.catchCause((cause) => Effect.logError("arming the re-login sweep failed", { cause })),
    );

    /**
     * Reads every due site's connection, and logs one Kernel found logged out
     * in again, at most one per run: a login takes up to minutes, and the
     * next due site gets the alarm a second later.
     */
    const sweep: LoginService["Service"]["sweep"] = Effect.gen(function* () {
      const ownerId = yield* owner;
      const now = yield* Clock.currentTimeMillis;
      if (backends === null || ownerId === null) return;
      if (nextDue === null || (nextDue !== undefined && now < nextDue)) return;
      for (const row of yield* kept.due(now)) {
        const later = (yield* Clock.currentTimeMillis) + Duration.toMillis(SWEEP_EVERY);
        const connection = yield* backends.kernel
          .getConnection(row.connection_id)
          .pipe(Effect.orElseSucceed(() => undefined));
        // Kernel didn't answer: read it again next time.
        if (connection === undefined) {
          yield* kept.checked(row.site, later);
          continue;
        }
        if (connection === null) {
          yield* kept.forget(row.site);
          continue;
        }
        if (connection.status !== "NEEDS_AUTH" || connection.flow_status === "IN_PROGRESS") {
          yield* kept.checked(row.site, later);
          continue;
        }
        const source = sourceOf(row.source);
        const check = yield* grants.check({ requester: ownerId, source, origin: row.origin });
        if (check._tag !== "allowed") {
          yield* kept.failed(row.site, "no grant covers this site anymore");
          yield* count("not_allowed", "sweep");
          continue;
        }
        const chosen = { item: row.item_id, title: row.item_title, username: row.username };
        const outcome = yield* login(backends, {
          site: row.site,
          ownerId,
          turn: { requester: ownerId, scope: scopeOf(source, ownerId), origin: row.origin },
          login: chosen,
          connectionId: row.connection_id,
          threadId: null,
        });
        yield* record(row, outcome);
        if (outcome._tag !== "signed-in") {
          yield* Effect.logWarning("an unattended re-login didn't finish", {
            connection: row.connection_id,
            outcome: outcome._tag,
          });
        }
        yield* count(answerOf(row.site, chosen, outcome)._tag, "sweep");
        break;
      }
    }).pipe(Effect.ensuring(rearm), traced("LoginService.sweep", {}));

    return LoginService.of({ signIn, sweep });
  });

/** On `kernel` and `executor`; without either, every sign-in says why it can't. */
export const layer = (options: Parameters<typeof make>[0]) =>
  Layer.effect(LoginService, make(options));

/** Worker settings the login service reads. Deploys pass an unset one as empty. */
export interface LoginServiceEnv extends ExecutorLoginsEnv {
  readonly KERNEL_API_KEY?: string;
}

/** Kernel and Executor with this cloud's keys. */
export const layerFromEnv = (env: LoginServiceEnv) =>
  Layer.effect(
    LoginService,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const key = env.KERNEL_API_KEY?.trim();
      return yield* make({
        kernel: key ? makeKernelAuth(client, { apiKey: Redacted.make(key) }) : null,
        executor: executorLoginsFromEnv(client, env),
      });
    }),
  );
