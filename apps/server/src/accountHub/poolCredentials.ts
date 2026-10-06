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
  hubInstancePoolId,
} from "@t3tools/contracts/accountHub";
import * as Effect from "effect/Effect";

import type * as AccountHub from "./AccountHub.ts";
import { saveCursorAccount, verifyCursorApiKey } from "./hubCursor.ts";
import { type PoolCredential, readNativeLogin } from "./nativeLogins.ts";
import type { PoolInstanceKind } from "./poolInstances.ts";

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

/**
 * Moves each native login into the pool's hub, one instance at a time so one
 * failure leaves the others moved. The caller turns the moved instances off
 * and adds the pool providers named in `kinds`.
 */
export const moveNativeLogins = Effect.fn("poolCredentials.moveNativeLogins")(function* (
  hub: Hub,
  instances: Readonly<Record<string, ProviderInstanceConfig>>,
  instanceIds: ReadonlyArray<ProviderInstanceId>,
) {
  const moved: ProviderInstanceId[] = [];
  const failed: Array<AccountPoolMoveNativeLoginsResult["failed"][number]> = [];
  const kinds = new Set<PoolInstanceKind>();
  for (const instanceId of instanceIds) {
    const instance = instances[instanceId];
    if (!instance || hubInstancePoolId(instance.config) !== null) {
      failed.push({ instanceId, reason: "That provider no longer signs in on its own." });
      continue;
    }
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const login = yield* readNativeLogin(instanceId, instance);
        yield* Effect.forEach(login.credentials, (credential) => save(hub, credential), {
          discard: true,
        });
        yield* login.release;
        return login.kind;
      }),
    ).pipe(Effect.result);
    if (result._tag === "Success") {
      moved.push(instanceId);
      kinds.add(result.success);
    } else {
      failed.push({ instanceId, reason: result.failure.detail });
    }
  }
  return { moved, failed, kinds };
});
