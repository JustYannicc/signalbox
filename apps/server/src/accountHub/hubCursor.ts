/**
 * Cursor accounts in a pool. CLIProxyAPI cannot route Cursor, but it keeps
 * any credential file it is given, so a pool's Cursor accounts are `cursor`
 * files in its hub like every other account: they list, pause, move, and go
 * with the pool whatever its backing. The pool's Cursor instance takes one per
 * session from the hub, in rotation, and never reads a Cursor login on the
 * server machine.
 *
 * @module accountHub/hubCursor
 */
import type { SdkCredentialStore } from "@cursor/sdk";
import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { Cursor } from "../provider/cursorSdk.ts";
import * as ProviderAuthFlow from "../provider/ProviderAuthFlow.ts";
import type * as AccountHub from "./AccountHub.ts";
import { AccountHubError } from "./accountHubManagement.ts";
import { cursorCredentialFile, CURSOR_CREDENTIAL_TYPE } from "./hubCredentials.ts";

type Hub = AccountHub.AccountHub["Service"];

const DEFAULT_BACKEND_URL = "https://api2.cursor.sh";

const CursorFile = Schema.Struct({
  api_key: Schema.String,
  email: Schema.optional(Schema.String),
  backend_url: Schema.optional(Schema.String),
  created_at_ms: Schema.optional(Schema.Number),
  api_key_expires_at_ms: Schema.optional(Schema.Number),
});
const decodeCursorFile = Schema.decodeUnknownEffect(Schema.fromJsonString(CursorFile));

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
  Effect.tryPromise({
    try: () => Cursor.me({ apiKey }),
    catch: (cause) => new AccountHubError({ detail: "Cursor did not accept that API key.", cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () => Effect.fail(new AccountHubError({ detail: "Cursor did not answer in time." })),
    }),
    Effect.map((user) => ({ email: user.userEmail?.trim() || undefined })),
  );

/**
 * A credential store over the pool's Cursor accounts. Each load hands out the
 * next account that is not paused, so sessions spread across the pool.
 */
export const makeCursorPoolStore = Effect.fn("makeCursorPoolStore")(function* (hub: Hub) {
  const turn = yield* Ref.make(0);
  const next = Effect.gen(function* () {
    const accounts = (yield* hub.accounts).filter(
      (account) => account.type === CURSOR_CREDENTIAL_TYPE && !account.disabled,
    );
    if (accounts.length === 0) return undefined;
    const index = yield* Ref.getAndUpdate(turn, (current) => current + 1);
    const account = accounts[index % accounts.length]!;
    const file = yield* decodeCursorFile(yield* hub.readCredential(account.name));
    return {
      version: 1 as const,
      backendUrl: file.backend_url ?? DEFAULT_BACKEND_URL,
      apiKey: file.api_key,
      createdAtMs: file.created_at_ms ?? 0,
      ...(file.api_key_expires_at_ms === undefined
        ? {}
        : { apiKeyExpiresAtMs: file.api_key_expires_at_ms }),
      ...(file.email ? { email: file.email } : {}),
    };
  });
  const store: SdkCredentialStore = {
    load: () => Effect.runPromise(next),
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
  return store;
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
        const result = yield* Effect.tryPromise({
          try: (signal) =>
            Cursor.auth.login({
              openBrowser: false,
              // Returned only: nothing is written to the machine's Cursor files.
              store: null,
              signal,
              apiKeyName: `Signalbox - ${options.displayName}`,
              onLoginUrl: (url) => {
                Effect.runFork(
                  context.setInteraction({
                    type: "browser",
                    id: context.flowId,
                    url,
                    requiresConsent: false,
                  }),
                );
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
