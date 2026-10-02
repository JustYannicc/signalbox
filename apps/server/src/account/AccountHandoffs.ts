import type { AccountHandoffRequest, AccountProfile } from "@t3tools/contracts/account";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { timingSafeEqualBase64Url } from "../auth/utils.ts";
import { pkceChallenge, randomToken } from "./AccountFlow.ts";
import { makeExpiringStore } from "./ExpiringStore.ts";

/**
 * Native sign-in handoffs: the callback parks the signed-in profile here, and
 * only the client holding the PKCE verifier for the challenge it sent to
 * `authorize` can collect it. No credential exists until a redeem succeeds, so
 * an abandoned handoff leaves nothing in the Connections list. Single use;
 * five wrong verifiers burn it.
 */

const HANDOFF_TTL = Duration.minutes(5);
const MAX_HANDOFFS = 1_000;
const MAX_FAILURES = 5;

export class AccountHandoffNotFoundError extends Schema.TaggedError<AccountHandoffNotFoundError>()(
  "AccountHandoffNotFoundError",
  {},
) {
  override get message(): string {
    return "The sign-in handoff does not exist or has expired.";
  }
}

export class AccountHandoffRejectedError extends Schema.TaggedError<AccountHandoffRejectedError>()(
  "AccountHandoffRejectedError",
  {},
) {
  override get message(): string {
    return "The sign-in handoff verifier does not match.";
  }
}

interface PendingHandoff {
  readonly account: AccountProfile;
  readonly challenge: string;
  readonly failures: number;
}

export const makeAccountHandoffs = () => {
  const store = makeExpiringStore<PendingHandoff>({ ttl: HANDOFF_TTL, maxEntries: MAX_HANDOFFS });

  /** Parks `account` for the client that owns `challenge`; returns the handoff id. */
  const issue = (input: { readonly account: AccountProfile; readonly challenge: string }) => {
    const id = randomToken();
    return store.put(id, { ...input, failures: 0 }).pipe(Effect.as(id));
  };

  const redeem = Effect.fn("AccountHandoffs.redeem")(function* (request: AccountHandoffRequest) {
    const challenge = pkceChallenge(request.verifier);
    const outcome = yield* store.modify<PendingHandoff | "missing" | "rejected">(
      request.handoff,
      (pending) => {
        if (!pending) return ["missing", undefined];
        if (timingSafeEqualBase64Url(challenge, pending.challenge)) return [pending, undefined];
        const failures = pending.failures + 1;
        return ["rejected", failures >= MAX_FAILURES ? undefined : { ...pending, failures }];
      },
    );
    if (outcome === "missing") return yield* new AccountHandoffNotFoundError();
    if (outcome === "rejected") return yield* new AccountHandoffRejectedError();
    return outcome.account;
  });

  return { issue, redeem };
};
