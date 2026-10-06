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
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import type { ProviderInstanceConfig, ProviderInstanceId } from "@t3tools/contracts";
import type { PoolApiKeyProvider } from "@t3tools/contracts/accountHub";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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
import { makeCodexChatGptAuth } from "../provider/CodexChatGptAuth.ts";
import { makeCursorCredentialStore } from "../provider/CursorCredentialStore.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { AccountHubError } from "./accountHubManagement.ts";
import { chatGptCredentialFile } from "./hubCredentials.ts";

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
  /** The pool provider kind (`poolInstanceId`) that runs these credentials. */
  readonly kind: "claude" | "codex" | "cursor";
  /** Clears what Signalbox itself stored, once the pool holds the login. */
  readonly release: Effect.Effect<void>;
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9@.+-]+/gu, "-")
    .replace(/^[.-]+|-+$/gu, "")
    .slice(0, 96);

const fingerprint = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 12);

const notFound = (what: string) =>
  new AccountHubError({ detail: `No ${what} login was found for this provider.` });

/** Variables set on the instance itself; the server's own environment is not the instance's login. */
const instanceVariable = (instance: ProviderInstanceConfig, name: string) =>
  instance.environment?.find((variable) => variable.name === name)?.value.trim() || undefined;

const configString = (config: unknown, key: string) =>
  config !== null &&
  typeof config === "object" &&
  key in config &&
  typeof (config as Record<string, unknown>)[key] === "string"
    ? ((config as Record<string, unknown>)[key] as string).trim()
    : "";

const readJson = (path: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(path)),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
    Effect.option,
  );

const ClaudeCredentials = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAt: Schema.optional(Schema.Number),
  }),
});
const decodeClaudeCredentials = Schema.decodeUnknownOption(ClaudeCredentials);
const decodeClaudeCredentialsJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudeCredentials),
);
const ClaudeAccount = Schema.Struct({
  oauthAccount: Schema.Struct({
    emailAddress: Schema.optional(Schema.String),
    accountUuid: Schema.optional(Schema.String),
    organizationUuid: Schema.optional(Schema.String),
    organizationName: Schema.optional(Schema.String),
  }),
});
const decodeClaudeAccount = Schema.decodeUnknownOption(ClaudeAccount);

/**
 * Claude Code keeps its login in the macOS keychain, under a name that
 * carries a hash of the config directory when it is not the default one.
 * Reading it may ask the user to allow access on the server machine.
 */
const readClaudeKeychain = (configDir: string, isDefault: boolean) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const service = isDefault
      ? "Claude Code-credentials"
      : `Claude Code-credentials-${NodeCrypto.createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
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
    return decodeClaudeCredentialsJson(output.trim());
  });

const readClaude = (instance: ProviderInstanceConfig) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const homePath = configString(instance.config, "homePath");
    const inheritedDir = instanceVariable(instance, "CLAUDE_CONFIG_DIR");
    const configDir = yield* resolveClaudeHomePath(
      { homePath },
      inheritedDir ? { CLAUDE_CONFIG_DIR: inheritedDir } : {},
    );
    const defaultDir = path.resolve(path.join(NodeOS.homedir(), ".claude"));
    const isDefault = configDir === defaultDir;
    const fromFile = (yield* readJson(path.join(configDir, ".credentials.json"))).pipe(
      Option.flatMap(decodeClaudeCredentials),
    );
    const platform = yield* HostProcessPlatform;
    const oauth = Option.isSome(fromFile)
      ? fromFile
      : platform === "darwin"
        ? yield* readClaudeKeychain(configDir, isDefault)
        : Option.none();
    const account = (yield* readJson(
      isDefault
        ? path.join(NodeOS.homedir(), ".claude.json")
        : path.join(configDir, ".claude.json"),
    )).pipe(Option.flatMap(decodeClaudeAccount));
    const credentials: PoolCredential[] = [];
    if (Option.isSome(oauth)) {
      const token = oauth.value.claudeAiOauth;
      const info = Option.isSome(account) ? account.value.oauthAccount : undefined;
      const email = info?.emailAddress;
      const now = DateTime.formatIso(yield* DateTime.now);
      credentials.push({
        kind: "file",
        name: `claude-${(email && slug(email)) || fingerprint(token.refreshToken)}.json`,
        content: {
          type: "claude",
          access_token: token.accessToken,
          refresh_token: token.refreshToken,
          last_refresh: now,
          ...(token.expiresAt === undefined
            ? {}
            : { expired: DateTime.formatIso(DateTime.makeUnsafe(token.expiresAt)) }),
          ...(email ? { email } : {}),
          ...(info?.accountUuid ? { account_uuid: info.accountUuid } : {}),
          ...(info?.organizationUuid ? { organization_uuid: info.organizationUuid } : {}),
          ...(info?.organizationName ? { organization_name: info.organizationName } : {}),
        },
      });
    }
    const apiKey = instanceVariable(instance, "ANTHROPIC_API_KEY");
    if (apiKey) credentials.push({ kind: "apiKey", provider: "anthropic", apiKey });
    if (credentials.length === 0) return yield* notFound("Claude");
    return { credentials, kind: "claude", release: Effect.void } satisfies NativeLogin;
  });

const CodexAuth = Schema.Struct({
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
});
const decodeCodexAuth = Schema.decodeUnknownOption(CodexAuth);

const jwtClaim = (token: string, read: (claims: Record<string, unknown>) => unknown) => {
  try {
    return read(decodeJwt(token) as Record<string, unknown>);
  } catch {
    return undefined;
  }
};

/** The Codex CLI's own login, from `auth.json` in the home it runs with. */
const readCodexCli = (instance: ProviderInstanceConfig) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const shadow = configString(instance.config, "shadowHomePath");
    const home =
      configString(instance.config, "homePath") ||
      instanceVariable(instance, "CODEX_HOME") ||
      path.join(NodeOS.homedir(), ".codex");
    const directory = path.resolve(expandHomePath(shadow || home));
    const auth = (yield* readJson(path.join(directory, "auth.json"))).pipe(
      Option.flatMap(decodeCodexAuth),
    );
    const credentials: PoolCredential[] = [];
    const tokens = Option.isSome(auth) ? auth.value.tokens : undefined;
    if (tokens) {
      const email = jwtClaim(tokens.id_token, (claims) =>
        typeof claims.email === "string" ? claims.email : undefined,
      ) as string | undefined;
      const expiresAt = jwtClaim(tokens.access_token, (claims) =>
        typeof claims.exp === "number" ? claims.exp : undefined,
      ) as number | undefined;
      const accountId = tokens.account_id ?? undefined;
      credentials.push({
        kind: "file",
        name: `codex-${(email && slug(email)) || (accountId && slug(accountId)) || fingerprint(tokens.refresh_token)}.json`,
        content: {
          type: "codex",
          id_token: tokens.id_token,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          ...(accountId ? { account_id: accountId } : {}),
          ...(Option.isSome(auth) && auth.value.last_refresh
            ? { last_refresh: auth.value.last_refresh }
            : {}),
          ...(email ? { email } : {}),
          ...(expiresAt === undefined
            ? {}
            : { expired: DateTime.formatIso(DateTime.makeUnsafe(expiresAt * 1000)) }),
        },
      });
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
> =>
  instance.driver === "claudeAgent"
    ? readClaude(instance)
    : instance.driver === "codex"
      ? configString(instance.config, "setupMode") === "managed"
        ? readCodexManaged(instanceId)
        : readCodexCli(instance)
      : instance.driver === "cursor"
        ? readCursor(instanceId, instance)
        : Effect.fail(
            new AccountHubError({ detail: "This provider's login can't move into a pool yet." }),
          );
