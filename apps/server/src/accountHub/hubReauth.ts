/**
 * Signing a dead hub account in again. The hub runs the provider's own login
 * for that account's type. Afterwards the result is checked against the
 * accounts from before the login:
 *
 * - The hub rewrote the same file, as it does when the same account signs in
 *   again: done.
 * - It wrote a new file for the same email (a changed plan, or a file imported
 *   from elsewhere): the dead file is removed.
 * - Someone else signed in: that account stays in the pool, and the dead one
 *   is still reported, so nothing is silently "fixed".
 *
 * @module accountHub/hubReauth
 */
import type { ProviderAuthMethod } from "@t3tools/contracts";
import { HUB_REAUTH_METHOD_PREFIX, hubReauthMethodId } from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import type * as AccountHub from "./AccountHub.ts";
import {
  AccountHubError,
  type AccountHubAccount,
  isHubLoginProvider,
} from "./accountHubManagement.ts";

/** The account a sign-in method signs in again, or null for an ordinary sign-in. */
export const reauthAccountName = (methodId: string) =>
  methodId.startsWith(HUB_REAUTH_METHOD_PREFIX)
    ? methodId.slice(HUB_REAUTH_METHOD_PREFIX.length)
    : null;

/** One "Sign in to … again" method per dead account of `types`, which the caller can sign in. */
export const reauthMethods = (
  hub: AccountHub.AccountHub["Service"],
  types: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<ProviderAuthMethod>> =>
  hub.accounts.pipe(
    Effect.map((accounts) =>
      accounts
        .filter((account) => account.signedOut && !account.disabled && types.includes(account.type))
        .map((account) => ({
          id: hubReauthMethodId(account.name),
          name: `Sign in to ${account.email ?? account.name} again`,
          description: "Its login expired. Sign in with the same account to fix it.",
          ...(account.email ? { accountEmail: account.email } : {}),
          type: "agent" as const,
        })),
    ),
    Effect.orElseSucceed(() => []),
  );

class NotYetUpdated extends Schema.TaggedError<NotYetUpdated>()("NotYetUpdated", {}) {}
const isNotYetUpdated = Schema.is(NotYetUpdated);

// The hub saves before it reports success, but its list can trail by a moment.
const settle = <A, E, R>(effect: Effect.Effect<A, E | NotYetUpdated, R>) =>
  effect.pipe(
    Effect.retry({
      while: isNotYetUpdated,
      schedule: Schedule.spaced("1 second"),
      times: 5,
    }),
    Effect.catchTags({
      NotYetUpdated: () =>
        Effect.fail(
          new AccountHubError({
            detail:
              "The sign-in finished, but this account is still signed out. Make sure you sign in with the same account; another account already in the pool only gets refreshed.",
          }),
        ),
    }),
  );

const sameEmail = (a: AccountHubAccount, b: AccountHubAccount) =>
  a.email !== null && b.email !== null && a.email.toLowerCase() === b.email.toLowerCase();

const reconcile = (
  hub: AccountHub.AccountHub["Service"],
  before: ReadonlyArray<AccountHubAccount>,
  target: AccountHubAccount,
) =>
  settle(
    Effect.gen(function* () {
      const after = yield* hub.accounts;
      const label = target.email ?? target.name;
      const added = after.filter(
        (account) =>
          account.type === target.type &&
          !before.some((previous) => previous.name === account.name),
      );
      const rewritten = after.find((account) => account.name === target.name);
      if (rewritten && !rewritten.signedOut) return;
      // A new file for the same account: the hub named it differently (a changed plan,
      // or a file imported from elsewhere). The same email in another workspace is not it.
      const replacement = added.find(
        (account) =>
          sameEmail(account, target) &&
          (account.workspaceId === null ||
            target.workspaceId === null ||
            account.workspaceId === target.workspaceId),
      );
      if (replacement) return yield* hub.removeCredential(target.name);
      const other = added[0];
      if (other) {
        return yield* new AccountHubError({
          detail: sameEmail(other, target)
            ? `That signed in to another workspace of ${label}; it was added, and this one is still signed out.`
            : `You signed in as ${other.email ?? "another account"}, not ${label}. That account was added; this one is still signed out.`,
        });
      }
      return yield* new NotYetUpdated();
    }),
  );

/** Starts the login that signs `accountName` in again. */
export const startReauth = (
  hub: AccountHub.AccountHub["Service"],
  accountName: string,
  options: { readonly localCallback: boolean },
): Effect.Effect<AccountHub.AccountHubOAuthLogin, AccountHubError> =>
  Effect.gen(function* () {
    // Started first, so a hub that is just restarting still lists the account.
    yield* hub.ensureRunning;
    const before = yield* hub.accounts;
    const target = before.find((account) => account.name === accountName);
    if (!target || !isHubLoginProvider(target.type)) {
      return yield* new AccountHubError({
        detail: "That account can no longer be signed in again.",
      });
    }
    const login = yield* hub.startOAuthLogin(target.type, options);
    return { ...login, await: login.await.pipe(Effect.andThen(reconcile(hub, before, target))) };
  });
