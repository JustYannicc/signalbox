/**
 * Native logins: provider instances that sign in on the server machine itself
 * (Claude Code's and Codex's own logins, Signalbox's own ChatGPT and Cursor
 * sign-ins, and API keys set in an instance's environment). Each reads into
 * the credentials a pool holds, so `AccountPools` can move it into a pool.
 *
 * A login is moved, not copied: refresh tokens rotate, so two places
 * refreshing one login sign each other out. Signalbox's own stored sign-ins
 * are cleared once the pool has them; the instance is turned off either way.
 *
 * @module accountHub/nativeLogins
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Claude Code's keychain service name hashes synchronously.
import * as NodeCrypto from "node:crypto";

import {
  ClaudeSettings,
  CodexSettings,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type { PoolApiKeyProvider, PoolInstanceKind } from "@t3tools/contracts/accountHub";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { decodeJwt } from "jose";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { claudeAccountConfigPath } from "../provider/claudeResetCredits.ts";
import { makeCodexChatGptAuth } from "../provider/CodexChatGptAuth.ts";
import { makeCursorCredentialStore } from "@t3tools/provider-cursor/server/credentialStore";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { AccountHubError } from "./accountHubManagement.ts";
import {
  chatGptCredentialFile,
  claudeCredentialFile,
  codexCredentialFile,
} from "./hubCredentials.ts";

/** What one native login becomes in a pool. */
export type PoolCredential =
  | {
      readonly kind: "file";
      readonly name: string;
      readonly content: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "apiKey";
      readonly provider: Exclude<PoolApiKeyProvider, "cursor">;
      readonly apiKey: string;
    }
  | {
      readonly kind: "cursor";
      readonly apiKey: string;
      readonly email?: string | undefined;
      readonly backendUrl?: string | undefined;
      readonly apiKeyExpiresAtMs?: number | undefined;
    };

export interface NativeLogin {
  readonly credentials: ReadonlyArray<PoolCredential>;
  /** The pool provider that runs these credentials. */
  readonly kind: Extract<PoolInstanceKind, "claude" | "codex" | "cursor">;
  /** Clears what Signalbox itself stored, once the pool holds the login. */
  readonly release: Effect.Effect<void>;
}

const notFound = (what: string) =>
  new AccountHubError({ detail: `No ${what} login was found for this provider.` });

/** Variables set on the instance itself; the server's own environment is not the instance's login. */
const instanceVariable = (instance: ProviderInstanceConfig, name: string) =>
  instance.environment?.find((variable) => variable.name === name)?.value.trim() || undefined;

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const DEFAULT_CODEX_SETTINGS = Schema.decodeUnknownSync(CodexSettings)({});

const isoFromMillis = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const readJson = <A>(path: string, decode: (input: unknown) => Option.Option<A>) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(path)),
    Effect.map(decode),
    Effect.orElseSucceed(() => Option.none<A>()),
  );

const ClaudeCredentials = Schema.fromJsonString(
  Schema.Struct({
    claudeAiOauth: Schema.Struct({
      accessToken: Schema.String,
      refreshToken: Schema.String,
      expiresAt: Schema.optional(Schema.Number),
    }),
  }),
);
const decodeClaudeCredentials = Schema.decodeUnknownOption(ClaudeCredentials);
const decodeClaudeAccount = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      oauthAccount: Schema.Struct({
        emailAddress: Schema.optional(Schema.String),
        accountUuid: Schema.optional(Schema.String),
        organizationUuid: Schema.optional(Schema.String),
        organizationName: Schema.optional(Schema.String),
      }),
    }),
  ),
);

/**
 * Claude Code keeps its login in the macOS keychain, under a name that
 * carries a hash of the config directory when one is set explicitly.
 * Reading it may ask the user to allow access on the server machine.
 */
const readClaudeKeychain = (configDir: string | undefined) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const service = configDir
      ? `Claude Code-credentials-${NodeCrypto.createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`
      : "Claude Code-credentials";
    const output = yield* spawner
      .spawn(
        ChildProcess.make("security", ["find-generic-password", "-s", service, "-w"], {
          shell: false,
        }),
      )
      .pipe(
        Effect.flatMap((child) => child.stdout.pipe(Stream.decodeText(), Stream.mkString)),
        Effect.scoped,
        Effect.timeout("60 seconds"),
        Effect.orElseSucceed(() => ""),
      );
    return decodeClaudeCredentials(output.trim());
  });

const readClaude = (instance: ProviderInstanceConfig) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const settings = decodeClaudeSettings(instance.config ?? {});
    const homePath = Option.isSome(settings) ? settings.value.homePath : "";
    const inheritedDir = instanceVariable(instance, "CLAUDE_CONFIG_DIR");
    const resolvedDir = yield* resolveClaudeHomePath(
      { homePath },
      inheritedDir ? { CLAUDE_CONFIG_DIR: inheritedDir } : {},
    );
    // Like the Claude driver: only a directory set on purpose moves the account and keychain names.
    const configDir = homePath.trim() || inheritedDir ? resolvedDir : undefined;
    const fromFile = yield* readJson(
      path.join(resolvedDir, ".credentials.json"),
      decodeClaudeCredentials,
    );
    const platform = yield* HostProcess.Platform;
    const oauth = Option.isSome(fromFile)
      ? fromFile
      : platform === "darwin"
        ? yield* readClaudeKeychain(configDir)
        : Option.none();
    const account = yield* readJson(yield* claudeAccountConfigPath(configDir), decodeClaudeAccount);
    const credentials: PoolCredential[] = [];
    if (Option.isSome(oauth)) {
      const token = oauth.value.claudeAiOauth;
      const info = Option.isSome(account) ? account.value.oauthAccount : undefined;
      const file = claudeCredentialFile({
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt === undefined ? undefined : isoFromMillis(token.expiresAt),
        lastRefresh: DateTime.formatIso(yield* DateTime.now),
        email: info?.emailAddress,
        accountUuid: info?.accountUuid,
        organizationUuid: info?.organizationUuid,
        organizationName: info?.organizationName,
      });
      credentials.push({ kind: "file", ...file });
    }
    const apiKey = instanceVariable(instance, "ANTHROPIC_API_KEY");
    if (apiKey) credentials.push({ kind: "apiKey", provider: "anthropic", apiKey });
    if (credentials.length === 0) return yield* notFound("Claude");
    return { credentials, kind: "claude", release: Effect.void } satisfies NativeLogin;
  });

const decodeCodexAuth = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      OPENAI_API_KEY: Schema.optional(Schema.NullOr(Schema.String)),
      tokens: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            id_token: Schema.String,
            access_token: Schema.String,
            refresh_token: Schema.String,
            account_id: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
      last_refresh: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
);

/** A JWT's claims, without verifying it: the token only travels to the hub that issued use of it. */
const jwtClaims = (token: string): Record<string, unknown> => {
  try {
    return decodeJwt(token);
  } catch {
    return {};
  }
};

/** The Codex CLI's own login, from `auth.json` in the home it runs with. */
const readCodexCli = (instance: ProviderInstanceConfig) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const settings = Option.getOrElse(
      decodeCodexSettings(instance.config ?? {}),
      () => DEFAULT_CODEX_SETTINGS,
    );
    const codexHome = instanceVariable(instance, "CODEX_HOME");
    const layout = yield* resolveCodexHomeLayout(
      settings.homePath.trim() || !codexHome ? settings : { ...settings, homePath: codexHome },
    );
    const directory = layout.effectiveHomePath ?? layout.sharedHomePath;
    const auth = yield* readJson(path.join(directory, "auth.json"), decodeCodexAuth);
    const credentials: PoolCredential[] = [];
    const tokens = Option.isSome(auth) ? auth.value.tokens : undefined;
    if (tokens) {
      const email = jwtClaims(tokens.id_token).email;
      const expiresAt = jwtClaims(tokens.access_token).exp;
      const file = codexCredentialFile({
        idToken: tokens.id_token,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accountId: tokens.account_id ?? undefined,
        lastRefresh: (Option.isSome(auth) && auth.value.last_refresh) || undefined,
        email: typeof email === "string" ? email : undefined,
        expiresAt: typeof expiresAt === "number" ? isoFromMillis(expiresAt * 1000) : undefined,
      });
      credentials.push({ kind: "file", ...file });
    }
    const apiKey =
      (Option.isSome(auth) ? auth.value.OPENAI_API_KEY?.trim() : undefined) ||
      instanceVariable(instance, "OPENAI_API_KEY");
    if (apiKey) credentials.push({ kind: "apiKey", provider: "openai", apiKey });
    if (credentials.length === 0) return yield* notFound("Codex");
    return { credentials, kind: "codex", release: Effect.void } satisfies NativeLogin;
  });

/** Signalbox's own Sign in with ChatGPT, kept per instance in the secret store. */
const readCodexManaged = (instanceId: ProviderInstanceId) =>
  Effect.gen(function* () {
    const chatGpt = yield* makeCodexChatGptAuth({ instanceId });
    const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
    const hostId = `urn:uuid:${yield* environment.getEnvironmentId}`;
    const profile = yield* chatGpt.exportProfile.pipe(Effect.mapError(() => notFound("ChatGPT")));
    const file = chatGptCredentialFile(profile, hostId);
    return {
      credentials: [{ kind: "file", name: file.name, content: file.content }],
      kind: "codex",
      // The pool refreshes it from now on; this instance must not.
      release: chatGpt.revoke.pipe(Effect.ignoreCause({ log: true })),
    } satisfies NativeLogin;
  });

/** Signalbox's own Cursor sign-in, or a Cursor key set on the instance. */
const readCursor = (instanceId: ProviderInstanceId, instance: ProviderInstanceConfig) =>
  Effect.gen(function* () {
    const configured = instanceVariable(instance, "CURSOR_API_KEY");
    if (configured) {
      return {
        credentials: [{ kind: "cursor", apiKey: configured }],
        kind: "cursor",
        release: Effect.void,
      } satisfies NativeLogin;
    }
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    // The same store, and legacy file, the Cursor driver opens for this instance.
    const stored = yield* makeCursorCredentialStore(
      instanceId,
      path.join(stateDir, "provider-auth", encodeURIComponent(instanceId), "cursor.json"),
    ).pipe(Effect.mapError(() => notFound("Cursor")));
    const credential = yield* Effect.tryPromise(() => stored.store.load()).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (!credential) return yield* notFound("Cursor");
    return {
      credentials: [
        {
          kind: "cursor",
          apiKey: credential.apiKey,
          email: credential.email,
          backendUrl: credential.backendUrl,
          apiKeyExpiresAtMs: credential.apiKeyExpiresAtMs,
        },
      ],
      kind: "cursor",
      release: Effect.tryPromise(() => stored.store.clear()).pipe(
        Effect.ignoreCause({ log: true }),
      ),
    } satisfies NativeLogin;
  });

/** Reads what a native instance signs in with, ready to move into a pool. */
export const readNativeLogin = (
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig,
): Effect.Effect<
  NativeLogin,
  AccountHubError,
  | Effect.Services<ReturnType<typeof readClaude>>
  | Effect.Services<ReturnType<typeof readCodexCli>>
  | Effect.Services<ReturnType<typeof readCodexManaged>>
  | Effect.Services<ReturnType<typeof readCursor>>
> => {
  switch (instance.driver) {
    case "claudeAgent":
      return readClaude(instance);
    case "codex":
      return decodeCodexSettings(instance.config ?? {}).pipe(
        Option.exists((settings) => settings.setupMode === "managed"),
      )
        ? readCodexManaged(instanceId)
        : readCodexCli(instance);
    case "cursor":
      return readCursor(instanceId, instance);
    default:
      return Effect.fail(
        new AccountHubError({ detail: "This provider's login can't move into a pool yet." }),
      );
  }
};
