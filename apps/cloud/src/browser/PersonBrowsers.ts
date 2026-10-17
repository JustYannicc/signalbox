import type { BrowserSessionAnswer } from "@signalbox/runner-protocol/BrowserProtocol";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import type { SqlError } from "effect/sql/SqlError";

import { hashSecret } from "../auth/hashedSecrets.ts";
import { makeProfileId } from "../user/profileId.ts";
import { makeTraced } from "../user/tracing.ts";
import {
  browserRequest,
  mayAttachProfile,
  OWNER_ONLY,
  profileNameOf,
  refusalFor,
  writesProfile,
} from "./browserPolicy.ts";
import { makeBrowserSessions, type SessionRow } from "./browserSessions.ts";
import { type KernelApi, type KernelApiError, makeKernelApi } from "./KernelApi.ts";

/**
 * The person's browser (#574): one Kernel profile per person, signed in to
 * the real sites their threads' agents open, in headless Kernel browsers.
 * Lives in the person's object, which holds the sessions their threads
 * opened, so only that object ever hands out a session's CDP endpoint, and
 * only to the thread's machine.
 *
 * A thread keeps one session while it runs. Opening goes through one permit,
 * because Kernel lets only one browser write a profile back at a time: the
 * first open session writes, the others load it read-only. Deleting a
 * session saves its profile; Kernel deletes one nobody ended
 * `BROWSER_TIMEOUT_SECONDS` after it went idle, which saves it the same way.
 *
 * Without `KERNEL_API_KEY` there is no person's browser, and the machine
 * opens real sites in its own (`unconfigured`). CDP URLs are credentials:
 * stored, never logged or traced.
 */

export class PersonBrowsers extends Context.Service<
  PersonBrowsers,
  {
    /** The thread's open session, or a new one; a refusal in words for the agent. */
    readonly open: (input: {
      readonly threadId: string;
      readonly requester: string;
    }) => Effect.Effect<BrowserSessionAnswer, SqlError>;
    /** Deletes the thread's session, which saves the profile when it writes it. */
    readonly end: (input: {
      readonly threadId: string;
      readonly sessionId: string;
    }) => Effect.Effect<void, SqlError>;
    /** Whether this account has access to its one managed profile. */
    readonly profileStatus: Effect.Effect<{ readonly available: boolean }, SqlError>;
    /**
     * Ends the profile writer and this thread's session, then holds the
     * session lock for the complete Managed Auth operation.
     */
    readonly withSignIn: <A, E, R>(input: {
      readonly threadId: string | null;
      readonly run: (profileName: string) => Effect.Effect<A, E, R>;
    }) => Effect.Effect<A, E | SqlError | KernelApiError | PersonBrowserUnavailableError, R>;
    /** Closes every session, forgets automatic re-login state, then deletes the profile. */
    readonly clearProfile: (
      forgetSignInRecords: () => Effect.Effect<void, SqlError>,
    ) => Effect.Effect<void, SqlError | KernelApiError | PersonBrowserUnavailableError>;
  }
>()("@signalbox/cloud/browser/PersonBrowsers") {}

export class PersonBrowserUnavailableError extends Schema.TaggedError<PersonBrowserUnavailableError>()(
  "PersonBrowserUnavailableError",
  {},
) {
  override get message(): string {
    return "The cloud browser profile is unavailable.";
  }
}

/** Worker secrets the person's browser reads. Deploys pass an unset secret as empty. */
export interface PersonBrowsersEnv {
  readonly KERNEL_API_KEY?: string;
}

const opens = Metric.counter("signalbox_cloud_person_browser_opens_total", {
  description: "Person's browser session requests from threads' machines, by outcome.",
});
const countOpen = (outcome: "reused" | "created" | "refused" | "unconfigured") =>
  Metric.update(Metric.withAttributes(opens, { outcome }), 1);

const logKernelError = (what: string) => (error: KernelApiError) =>
  Effect.logWarning(what, { operation: error.operation, status: error.status, code: error.code });

const make = (kernel: KernelApi | null) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const sessions = yield* makeBrowserSessions;
    const owner = yield* makeProfileId;
    const traced = makeTraced(owner);
    const opening = yield* Semaphore.make(1);

    /**
     * Whether Kernel still runs a session; one it deleted is forgotten. A
     * failed check keeps it: holding the writer slot a while longer is safer
     * than two writers.
     */
    const stillRuns = (api: KernelApi, row: SessionRow) =>
      api.getBrowser(row.session_id).pipe(
        Effect.flatMap((browser) =>
          browser === null
            ? Effect.as(sessions.ended(row.session_id), false)
            : Effect.succeed(true),
        ),
        Effect.catchTags({
          KernelApiError: (error: KernelApiError) =>
            logKernelError("checking a person's browser failed")(error).pipe(Effect.as(true)),
        }),
      );

    /** The person's open sessions Kernel still runs, checked together. */
    const liveSessions = (api: KernelApi) =>
      Effect.flatMap(sessions.open, (rows) =>
        Effect.filter(rows, (row) => stillRuns(api, row), { concurrency: "unbounded" }),
      );

    // Asked on every new session, so a profile Kernel lost is made again.
    const profileName = (ownerId: string) => Effect.map(hashSecret(crypto, ownerId), profileNameOf);

    const ensureProfile = (api: KernelApi, ownerId: string) =>
      Effect.gen(function* () {
        const name = yield* profileName(ownerId);
        yield* api.ensureProfile(name);
        return name;
      });

    const create = (
      api: KernelApi,
      threadId: string,
      ownerId: string,
      live: ReadonlyArray<SessionRow>,
    ) =>
      Effect.gen(function* () {
        const profileName = yield* ensureProfile(api, ownerId);
        const writer = writesProfile(live);
        const browser = yield* api.createBrowser(browserRequest({ profileName, writer, threadId }));
        yield* sessions.record(threadId, browser, writer);
        yield* Effect.annotateCurrentSpan({ "browser.writer": writer });
        return {
          _tag: "ready",
          sessionId: browser.session_id,
          cdpWsUrl: browser.cdp_ws_url,
        } as const;
      });

    const open: PersonBrowsers["Service"]["open"] = ({ threadId, requester }) =>
      Effect.gen(function* () {
        if (kernel === null) {
          yield* countOpen("unconfigured");
          return { _tag: "unconfigured" } as const;
        }
        const ownerId = yield* owner;
        if (ownerId === null || !mayAttachProfile(requester, ownerId)) {
          yield* countOpen("refused");
          return { _tag: "refused", message: OWNER_ONLY } as const;
        }
        const answer: BrowserSessionAnswer = yield* opening.withPermits(1)(
          Effect.gen(function* () {
            // Reconnecting after an idle drop checks only the thread's own session.
            const current = yield* sessions.ofThread(threadId);
            if (current !== null && (yield* stillRuns(kernel, current))) {
              yield* countOpen("reused");
              return {
                _tag: "ready",
                sessionId: current.session_id,
                cdpWsUrl: current.cdp_ws_url,
              } as const;
            }
            const created = yield* create(kernel, threadId, ownerId, yield* liveSessions(kernel));
            yield* countOpen("created");
            return created;
          }).pipe(
            Effect.catchTags({
              KernelApiError: (error: KernelApiError) =>
                logKernelError("Kernel refused a person's browser")(error).pipe(
                  Effect.andThen(countOpen("refused")),
                  Effect.as({ _tag: "refused", message: refusalFor(error) } as const),
                ),
            }),
          ),
        );
        yield* Effect.annotateCurrentSpan({ "browser.outcome": answer._tag });
        return answer;
      }).pipe(traced("PersonBrowsers.open", { "thread.id": threadId }));

    /** Deletes a session, which saves its profile; one Kernel didn't delete stays recorded. */
    const remove = (api: KernelApi, sessionId: string) =>
      api.deleteBrowser(sessionId).pipe(
        Effect.andThen(sessions.ended(sessionId)),
        // Still open, it keeps counting as the writer until Kernel's timeout deletes it.
        Effect.catchTags({
          KernelApiError: (error: KernelApiError) =>
            logKernelError("ending a person's browser failed")(error),
        }),
      );

    /** Used before Managed Auth and profile deletion; a failure must leave the writer intact. */
    const removeStrict = (api: KernelApi, sessionId: string) =>
      api.deleteBrowser(sessionId).pipe(Effect.andThen(sessions.ended(sessionId)));

    const end: PersonBrowsers["Service"]["end"] = ({ threadId, sessionId }) =>
      Effect.gen(function* () {
        if (kernel === null) return;
        // Only the thread's own session; another thread's id ends nothing.
        if ((yield* sessions.ofThread(threadId))?.session_id !== sessionId) return;
        yield* remove(kernel, sessionId);
      }).pipe(
        // Under the same permit as opening, so an open never hands out a session being deleted.
        opening.withPermits(1),
        traced("PersonBrowsers.end", { "thread.id": threadId }),
      );

    const profileStatus: PersonBrowsers["Service"]["profileStatus"] = Effect.map(
      owner,
      (ownerId) => ({ available: kernel !== null && ownerId !== null }),
    );

    const withSignIn: PersonBrowsers["Service"]["withSignIn"] = ({ threadId, run }) =>
      Effect.gen(function* () {
        if (kernel === null) return yield* Effect.fail(new PersonBrowserUnavailableError({}));
        const ownerId = yield* owner;
        if (ownerId === null) return yield* Effect.fail(new PersonBrowserUnavailableError({}));
        const ending = (yield* sessions.open).filter(
          (row) => row.writer || row.thread_id === threadId,
        );
        yield* Effect.forEach(ending, (row) => removeStrict(kernel, row.session_id), {
          discard: true,
          concurrency: 1,
        });
        const name = yield* ensureProfile(kernel, ownerId);
        return yield* run(name);
      }).pipe(opening.withPermits(1), traced("PersonBrowsers.withSignIn", {}));

    const clearProfile: PersonBrowsers["Service"]["clearProfile"] = (forgetSignInRecords) =>
      Effect.gen(function* () {
        if (kernel === null) return yield* Effect.fail(new PersonBrowserUnavailableError({}));
        const ownerId = yield* owner;
        if (ownerId === null) return yield* Effect.fail(new PersonBrowserUnavailableError({}));
        const name = yield* profileName(ownerId);
        const open = yield* sessions.open;
        yield* Effect.forEach(open, (row) => removeStrict(kernel, row.session_id), {
          discard: true,
          concurrency: 1,
        });
        // Clearing this first prevents the hourly sweep from restoring sign-ins after deletion.
        yield* forgetSignInRecords();
        yield* kernel.deleteProfile(name);
      }).pipe(opening.withPermits(1), traced("PersonBrowsers.clearProfile", {}));

    return PersonBrowsers.of({ open, end, profileStatus, withSignIn, clearProfile });
  });

/** On `kernel`, or with no person's browser when it's null. */
export const layer = (kernel: KernelApi | null) => Layer.effect(PersonBrowsers, make(kernel));

/** Kernel with this cloud's key, or no person's browser without one. */
export const layerFromEnv = (env: PersonBrowsersEnv) =>
  Layer.effect(
    PersonBrowsers,
    Effect.gen(function* () {
      const key = env.KERNEL_API_KEY?.trim();
      const kernel = key
        ? makeKernelApi(yield* HttpClient.HttpClient, { apiKey: Redacted.make(key) })
        : null;
      return yield* make(kernel);
    }),
  );
