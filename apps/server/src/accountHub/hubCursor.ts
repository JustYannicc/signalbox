/**
 * Cursor accounts in a pool. CLIProxyAPI cannot route Cursor, but it keeps
 * any credential file it is given, so a pool's Cursor accounts are `cursor`
 * files in its hub like every other account: they list, pause, move, and go
 * with the pool whatever its backing. The pool's Cursor instance hands each
 * new session the next account in turn, and never reads a Cursor login on the
 * server machine.
 *
 * @module accountHub/hubCursor
 */
import type { SdkCredentialStore, StoredSdkCredentials } from "@cursor/sdk";
import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { Cursor } from "../provider/cursorSdk.ts";
import { liveProbes as cursorProbes } from "../provider/CursorSdkCatalog.ts";
import * as ProviderAuthFlow from "../provider/ProviderAuthFlow.ts";
import type * as AccountHub from "./AccountHub.ts";
import { AccountHubError, isAccountHubError } from "./accountHubManagement.ts";
import {
  CURSOR_CREDENTIAL_TYPE,
  CursorCredentialFile,
  cursorCredentialFile,
} from "./hubCredentials.ts";

type Hub = AccountHub.AccountHub["Service"];

const DEFAULT_BACKEND_URL = "https://api2.cursor.sh";

const decodeCursorFile = Schema.decodeUnknownEffect(Schema.fromJsonString(CursorCredentialFile));

/**
 * The credential store a pool's Cursor instance reads instead of its own.
 * Cursor's driver uses it when present (a `signalbox` hook line).
 */
export class CursorPoolCredentials extends Context.Service<
  CursorPoolCredentials,
  {
    readonly store: SdkCredentialStore;
    readonly binding: { readonly owner: "t3"; readonly key: string };
  }
>()("t3/accountHub/hubCursor/CursorPoolCredentials") {}

/** Saves one Cursor key into the pool, named by its account so adding it again replaces it. */
export const saveCursorAccount = (
  hub: Hub,
  credential: Omit<Parameters<typeof cursorCredentialFile>[0], "createdAtMs">,
) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((createdAtMs) => {
      const file = cursorCredentialFile({ ...credential, createdAtMs });
      return hub.saveCredential(file.name, file.content);
    }),
  );

/** Checks a pasted Cursor API key and finds whose it is. */
export const verifyCursorApiKey = (apiKey: string) =>
  cursorProbes.readUser(apiKey).pipe(
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () => Effect.fail(new AccountHubError({ detail: "Cursor did not answer in time." })),
    }),
    Effect.mapError((cause) =>
      isAccountHubError(cause)
        ? cause
        : new AccountHubError({
            detail: cause.authenticationFailure
              ? "Cursor did not accept that API key."
              : "Could not reach Cursor to check the key. Try again.",
            cause,
          }),
    ),
    Effect.map((user) => ({ email: user.userEmail?.trim() || undefined })),
  );

/**
 * The pool's Cursor accounts as the SDK's credentials. `store` is what status
 * checks and one-off text generation read; `next` moves on to the next account
 * and is taken once per session, so sessions spread across the pool. Paused,
 * expired, and unreadable accounts are skipped. Files are read once and kept
 * until the pool's accounts change.
 */
export const makeCursorPool = Effect.fn("makeCursorPool")(function* (hub: Hub) {
  const turn = yield* Ref.make(0);
  const files = yield* Ref.make(new Map<string, StoredSdkCredentials | null>());
  yield* hub.accountChanges.pipe(
    Stream.runForEach(() => Ref.set(files, new Map())),
    Effect.forkScoped,
  );

  const read = (name: string) =>
    Effect.gen(function* () {
      const cached = (yield* Ref.get(files)).get(name);
      if (cached !== undefined) return cached;
      const credential = yield* hub.readCredential(name).pipe(
        Effect.flatMap(decodeCursorFile),
        Effect.map((file): StoredSdkCredentials => ({
          version: 1,
          backendUrl: file.backend_url ?? DEFAULT_BACKEND_URL,
          apiKey: file.api_key,
          createdAtMs: file.created_at_ms,
          ...(file.api_key_expires_at_ms === undefined
            ? {}
            : { apiKeyExpiresAtMs: file.api_key_expires_at_ms }),
          ...(file.email ? { email: file.email } : {}),
        })),
        Effect.orElseSucceed(() => null),
      );
      yield* Ref.update(files, (current) => new Map(current).set(name, credential));
      return credential;
    });

  const usable = Effect.gen(function* () {
    const names = (yield* hub.accounts.pipe(Effect.orElseSucceed(() => [])))
      .filter((account) => account.type === CURSOR_CREDENTIAL_TYPE && !account.disabled)
      .map((account) => account.name);
    const now = yield* Clock.currentTimeMillis;
    const credentials = yield* Effect.forEach(names, read);
    return credentials.filter(
      (credential): credential is StoredSdkCredentials =>
        credential !== null &&
        (credential.apiKeyExpiresAtMs === undefined || credential.apiKeyExpiresAtMs > now),
    );
  });

  const pick = (advance: boolean) =>
    Effect.gen(function* () {
      const credentials = yield* usable;
      if (credentials.length === 0) return undefined;
      const index = advance
        ? yield* Ref.getAndUpdate(turn, (current) => current + 1)
        : yield* Ref.get(turn);
      return credentials[index % credentials.length];
    });

  const store: SdkCredentialStore = {
    load: () => Effect.runPromise(pick(false)),
    save: (credentials) =>
      Effect.runPromise(
        saveCursorAccount(hub, {
          apiKey: credentials.apiKey,
          email: credentials.email,
          backendUrl: credentials.backendUrl,
          apiKeyExpiresAtMs: credentials.apiKeyExpiresAtMs,
        }),
      ),
    // Accounts leave the pool from Usage → Limits, never through an instance's sign-out.
    clear: () => Promise.resolve(),
  };
  return { store, next: pick(true) };
});

/**
 * Sign-in for a pool's Cursor instance: every sign-in adds one Cursor account
 * to the pool. The login runs on the server, but its key goes into the hub,
 * not into the machine's Cursor configuration.
 */
export const makeCursorPoolSignIn = (options: {
  readonly hub: Hub;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
}) =>
  ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "t3", key: `account-hub:${options.instanceId}` },
    defaultMethodId: "cursor-add-account",
    methods: Effect.succeed([
      {
        id: "cursor-add-account",
        name: "Add a Cursor account",
        description: "Sign in with Cursor. The account joins this pool.",
        type: "agent" as const,
      },
    ]),
    authenticate: (_methodId, context) =>
      Effect.gen(function* () {
        const failed = (detail: string) => (cause: unknown) =>
          new ProviderSetupError({
            instanceId: options.instanceId,
            operation: "start",
            detail,
            cause,
          });
        // The SDK reports the sign-in page from a callback; the flow shows it from its own scope.
        const urls = yield* Queue.unbounded<string>();
        yield* Queue.take(urls).pipe(
          Effect.flatMap((url) =>
            context.setInteraction({
              type: "browser",
              id: context.flowId,
              url,
              requiresConsent: false,
            }),
          ),
          Effect.forever,
          Effect.forkScoped,
        );
        const result = yield* Effect.tryPromise({
          try: (signal) =>
            Cursor.auth.login({
              openBrowser: false,
              // Returned only: nothing is written to the machine's Cursor files.
              store: null,
              signal,
              apiKeyName: `Signalbox - ${options.displayName}`,
              onLoginUrl: (url) => {
                Queue.offerUnsafe(urls, url);
              },
            }),
          catch: failed("Cursor sign-in failed. Start sign-in again."),
        });
        yield* context.verifying;
        yield* saveCursorAccount(options.hub, {
          apiKey: result.apiKey,
          email: result.email,
          apiKeyExpiresAtMs: result.apiKeyExpiresAtMs,
        }).pipe(Effect.mapError((error) => failed(error.detail)(error)));
      }),
    logout: Effect.succeed("Accounts stay in the pool. Remove or pause them from Usage → Limits."),
  });
