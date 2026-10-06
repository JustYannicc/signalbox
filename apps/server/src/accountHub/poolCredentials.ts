/**
 * Putting credentials into a pool: API keys the user pastes, and native
 * logins moved off the server machine. Everything lands in the pool's hub,
 * whatever its backing, so a pool looks the same to everyone who uses it.
 *
 * @module accountHub/poolCredentials
 */
import type { ProviderInstanceConfig, ProviderInstanceId } from "@t3tools/contracts";
import {
  type AccountPoolAddApiKeyInput,
  type AccountPoolMoveNativeLoginsResult,
  type PoolInstanceKind,
  hubInstancePoolId,
} from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";

import type * as AccountHub from "./AccountHub.ts";
import { saveCursorAccount, verifyCursorApiKey } from "./hubCursor.ts";
import { type NativeLogin, type PoolCredential, readNativeLogin } from "./nativeLogins.ts";

type Hub = AccountHub.AccountHub["Service"];

const save = (hub: Hub, credential: PoolCredential) =>
  credential.kind === "file"
    ? hub.saveCredential(credential.name, credential.content)
    : credential.kind === "apiKey"
      ? hub.addApiKey({ provider: credential.provider, apiKey: credential.apiKey })
      : saveCursorAccount(hub, credential);

/** Adds a pasted API key. Resolves to the pool provider kind that uses it. */
export const addApiKey = (
  hub: Hub,
  input: Omit<AccountPoolAddApiKeyInput, "poolId">,
): Effect.Effect<PoolInstanceKind, Effect.Error<ReturnType<Hub["addApiKey"]>>> =>
  input.provider === "cursor"
    ? verifyCursorApiKey(input.apiKey).pipe(
        Effect.flatMap(({ email }) =>
          saveCursorAccount(hub, { apiKey: input.apiKey.trim(), email }),
        ),
        Effect.as("cursor" as const),
      )
    : hub.addApiKey({ ...input, provider: input.provider });

type Failure = AccountPoolMoveNativeLoginsResult["failed"][number];

/**
 * Reads each native login, one instance at a time so one failure leaves the
 * others readable. Run inside a scope that outlives `saveNativeLogins`: a
 * login's `release` needs it.
 */
export const readNativeLogins = Effect.fn("poolCredentials.readNativeLogins")(function* (
  instances: Readonly<Record<string, ProviderInstanceConfig>>,
  instanceIds: ReadonlyArray<ProviderInstanceId>,
) {
  const logins: Array<{ readonly instanceId: ProviderInstanceId; readonly login: NativeLogin }> =
    [];
  const failed: Failure[] = [];
  for (const instanceId of instanceIds) {
    const instance = instances[instanceId];
    if (!instance || hubInstancePoolId(instance.config) !== null) {
      failed.push({ instanceId, reason: "That provider no longer signs in on its own." });
      continue;
    }
    const login = yield* readNativeLogin(instanceId, instance).pipe(Effect.result);
    if (login._tag === "Success") logins.push({ instanceId, login: login.success });
    else failed.push({ instanceId, reason: login.failure.detail });
  }
  return { logins, failed };
});

/**
 * Saves read logins into the pool's hub, then clears what Signalbox itself
 * kept of each. The caller turns the moved instances off and adds the pool
 * providers named in `kinds`.
 */
export const saveNativeLogins = Effect.fn("poolCredentials.saveNativeLogins")(function* (
  hub: Hub,
  logins: ReadonlyArray<{ readonly instanceId: ProviderInstanceId; readonly login: NativeLogin }>,
) {
  const moved: ProviderInstanceId[] = [];
  const failed: Failure[] = [];
  const kinds = new Set<PoolInstanceKind>();
  for (const { instanceId, login } of logins) {
    const saved = yield* Effect.forEach(login.credentials, (credential) => save(hub, credential), {
      discard: true,
    }).pipe(Effect.result);
    if (saved._tag === "Failure") {
      failed.push({ instanceId, reason: saved.failure.detail });
      continue;
    }
    yield* login.release;
    moved.push(instanceId);
    kinds.add(login.kind);
  }
  return { moved, failed, kinds };
});
