import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { randomToken } from "@signalbox/account/AccountFlow";
import { makeExpiringStore } from "./ExpiringStore.ts";
import * as WorkOSClient from "@signalbox/account/WorkOSClient";

/**
 * Sign-ins paused for email verification. WorkOS emailed the user a code; the
 * sign-in page posts it back with the id the callback redirected to. The entry
 * keeps the original attempt so the sign-in finishes exactly as the callback
 * would have. Wrong codes keep it open, five of them burn it.
 */

const VERIFICATION_TTL = Duration.minutes(10);
const MAX_VERIFICATIONS = 1_000;
const MAX_FAILURES = 5;

export class AccountVerificationExpiredError extends Schema.TaggedError<AccountVerificationExpiredError>()(
  "AccountVerificationExpiredError",
  {},
) {
  override get message(): string {
    return "The email verification does not exist or has expired.";
  }
}

export class AccountVerificationCodeRejectedError extends Schema.TaggedError<AccountVerificationCodeRejectedError>()(
  "AccountVerificationCodeRejectedError",
  {},
) {
  override get message(): string {
    return "WorkOS rejected the email verification code.";
  }
}

interface PendingVerification<Attempt> {
  readonly pendingToken: Redacted.Redacted<string>;
  readonly email: string;
  readonly attempt: Attempt;
  readonly failures: number;
}

export const makeAccountVerifications = <Attempt>() => {
  const store = makeExpiringStore<PendingVerification<Attempt>>({
    ttl: VERIFICATION_TTL,
    maxEntries: MAX_VERIFICATIONS,
  });

  /** Parks a paused sign-in; returns the id the sign-in page posts back. */
  const issue = (input: {
    readonly pendingToken: Redacted.Redacted<string>;
    readonly email: string;
    readonly attempt: Attempt;
  }) => {
    const id = randomToken();
    return store.put(id, { ...input, failures: 0 }).pipe(Effect.as(id));
  };

  /** Exchanges `code` through `exchange` and, on success, closes the pause. */
  const verify = Effect.fn("AccountVerifications.verify")(function* (
    id: string,
    exchange: (
      pendingToken: Redacted.Redacted<string>,
    ) => Effect.Effect<WorkOSClient.WorkOSUser, WorkOSClient.WorkOSGrantError>,
  ) {
    const pending = yield* store.modify(id, (entry) => [entry, entry] as const);
    if (!pending) return yield* new AccountVerificationExpiredError();
    const outcome = yield* exchange(pending.pendingToken).pipe(
      Effect.map((user) => ({ _tag: "Verified", user }) as const),
      Effect.catch((error) => Effect.succeed({ _tag: "Failed", error } as const)),
    );
    if (outcome._tag === "Verified") {
      yield* store.take(id);
      return { user: outcome.user, attempt: pending.attempt };
    }
    const error = outcome.error;
    const kind = WorkOSClient.classifyEmailVerificationFailure(error);
    if (kind === "failed" && error._tag === "WorkOSAuthenticateError") return yield* error;
    if (kind === "expired") {
      yield* store.take(id);
      return yield* new AccountVerificationExpiredError();
    }
    yield* store.modify(id, (entry) => {
      const failures = (entry?.failures ?? MAX_FAILURES) + 1;
      return [undefined, entry && failures < MAX_FAILURES ? { ...entry, failures } : undefined];
    });
    return yield* new AccountVerificationCodeRejectedError();
  });

  return { issue, verify };
};
