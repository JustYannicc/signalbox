import {
  SIGN_IN_EVERYWHERE,
  SIGNALBOX_SIGN_IN_WS_METHODS,
  type SignInAnswer,
  type SignInGrant,
  type SignInGrants,
} from "@t3tools/contracts/signalboxSignIn";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  type AtomCommandResult,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "./runtime.ts";

/**
 * A Signalbox Cloud person's standing sign-in grants (#575), for one
 * environment. Only environments advertising `capabilities.signInGrants`
 * serve them.
 */
export function createSignalboxSignInAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    grants: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:signalbox-sign-in:grants",
      tag: SIGNALBOX_SIGN_IN_WS_METHODS.subscribe,
    }),
    grant: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-sign-in:grant",
      tag: SIGNALBOX_SIGN_IN_WS_METHODS.grant,
    }),
    revoke: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-sign-in:revoke",
      tag: SIGNALBOX_SIGN_IN_WS_METHODS.revoke,
    }),
    check: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-sign-in:check",
      tag: SIGNALBOX_SIGN_IN_WS_METHODS.check,
    }),
  };
}

/** The person's own grants as Settings shows them: the everywhere switch, then each site. */
export function personalSignIn(list: SignInGrants): {
  readonly everywhere: SignInGrant | null;
  readonly sites: ReadonlyArray<SignInGrant>;
} {
  const own = list.grants.filter((grant) => grant.source._tag === "person");
  return {
    everywhere: own.find((grant) => grant.site === SIGN_IN_EVERYWHERE) ?? null,
    sites: own.filter((grant) => grant.site !== SIGN_IN_EVERYWHERE),
  };
}

/** A check's answer in words, the same on every client. */
export function describeSignInAnswer(host: string, answer: SignInAnswer): string {
  switch (answer._tag) {
    case "allowed":
      return answer.grant.site === SIGN_IN_EVERYWHERE
        ? `Agents sign in to ${host} without asking: you allowed every site.`
        : `Agents sign in to ${host} without asking: you allowed ${answer.grant.site}.`;
    case "ask":
      return `Agents ask you first: “Let agents sign in to ${answer.site}?”`;
    case "not-owner":
      return "Only your own turns sign in with your 1Password. Anyone else's asks you first.";
  }
}

/** Null when a grant change worked or was cut off; else the server's reason, written for the person. */
export function signInFailureMessage<A, E>(result: AtomCommandResult<A, E>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : "Something went wrong. Try again.";
}

/** What "Try a site" shows for a check's result; null when it was cut off. */
export function signInCheckShown(
  host: string,
  result: AtomCommandResult<SignInAnswer, unknown>,
): { readonly text: string; readonly failed: boolean } | null {
  if (result._tag === "Success") {
    return { text: describeSignInAnswer(host, result.value), failed: false };
  }
  const failure = signInFailureMessage(result);
  return failure === null ? null : { text: failure, failed: true };
}
