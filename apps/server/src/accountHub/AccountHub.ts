/**
 * AccountHub — the CLIProxyAPI instance Signalbox runs for the user.
 *
 * It pools the user's subscription accounts so Codex and Claude can use
 * several of them, and it is only ever reachable on loopback. Signalbox
 * owns it end to end: the pinned binary, its config, its keys, and its
 * process. Nobody hosts or configures it by hand.
 *
 * The hub starts when something needs it (adding an account) or at boot when
 * accounts already exist, and restarts with backoff if it exits. Accounts
 * live as credential files in its auth directory; that directory is the only
 * state the hub keeps, so there is no separate "enabled" setting to drift.
 *
 * @module accountHub/AccountHub
 */
import type { UsageLimitSourceConfig, UsageLimitSourceId } from "@t3tools/contracts";
import {
  ACCOUNT_HUB_SOURCE_ID,
  type AccountPoolAddApiKeyInput,
  type AccountHubConnection,
  type AccountHubImportInput,
  type AccountHubImportResult,
  type AccountHubSetConnectionInput,
} from "@t3tools/contracts/accountHub";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { isProcessAlive } from "../serverRuntimeState.ts";
import * as Management from "./accountHubManagement.ts";
import {
  addApiKey as addHubApiKey,
  apiKeySections,
  type ApiKeyInstanceKind,
} from "./hubApiKeys.ts";
import {
  AccountHubError,
  type AccountHubEndpoint,
  isAccountHubError,
  normalizeHubUrl,
} from "./accountHubManagement.ts";
import {
  ACCOUNT_HUB_VERSION,
  AccountHubInstallError,
  installAccountHub,
} from "./AccountHubRelease.ts";

/** A login in progress inside the hub. */
export interface AccountHubOAuthLogin {
  readonly url: string;
  /** Set for device flows: the code to enter at `url`. */
  readonly userCode?: string;
  /** Finishes a login whose redirect could not reach the hub, from the pasted URL. */
  readonly complete: (redirectUrl: string) => Effect.Effect<void, AccountHubError>;
  /** Resolves once the hub saved the account. */
  readonly await: Effect.Effect<void, AccountHubError>;
  readonly cancel: Effect.Effect<void>;
}

export type AccountHubStatus =
  | { readonly phase: "off" }
  | { readonly phase: "starting" }
  | { readonly phase: "running"; readonly version: string }
  | { readonly phase: "failed"; readonly detail: string };

export class AccountHub extends Context.Service<
  AccountHub,
  {
    /** Installs and starts the hub when needed; resolves once its management API answers. */
    readonly ensureRunning: Effect.Effect<AccountHubEndpoint, AccountHubError>;
    /** The running hub, without starting it. */
    readonly endpoint: Effect.Effect<Option.Option<AccountHubEndpoint>>;
    /** Where the hub answers once started, without starting it. */
    readonly plannedEndpoint: Effect.Effect<AccountHubEndpoint, AccountHubError>;
    /** The current status followed by every change. */
    readonly statusChanges: Stream.Stream<AccountHubStatus>;
    /** Fires after accounts were added, paused, resumed, or removed. */
    readonly accountChanges: Stream.Stream<void>;
    /** Announces an account change made through the hub's management API. */
    readonly markAccountsChanged: Effect.Effect<void>;
    /** Saves an account's credential file into the hub, starting the hub if needed. */
    readonly saveCredential: (
      name: string,
      credential: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void, AccountHubError>;
    /** Starts a provider OAuth login that the hub completes and saves. */
    readonly startOAuthLogin: (
      provider: Management.AccountHubOAuthProvider,
      options: { readonly localCallback: boolean },
    ) => Effect.Effect<AccountHubOAuthLogin, AccountHubError>;
    /**
     * Adds an API key the hub routes alongside its logins, starting the hub if
     * needed. Resolves to the pool provider kind that uses it.
     */
    readonly addApiKey: (
      input: Omit<AccountPoolAddApiKeyInput, "poolId" | "provider"> & {
        readonly provider: Exclude<AccountPoolAddApiKeyInput["provider"], "cursor">;
      },
    ) => Effect.Effect<ApiKeyInstanceKind, AccountHubError>;
    /** One credential file's content, for accounts the hub keeps but does not route (Cursor). */
    readonly readCredential: (name: string) => Effect.Effect<string, AccountHubError>;
    /** Removes one account's credential file from the hub. */
    readonly removeCredential: (name: string) => Effect.Effect<void, AccountHubError>;
    /** Accounts in the running hub. Empty when the hub is off. */
    readonly accounts: Effect.Effect<ReadonlyArray<Management.AccountHubAccount>, AccountHubError>;
    /** Which hub pooled accounts go through: this one, or one the user runs. */
    readonly connection: Effect.Effect<AccountHubConnection>;
    /** Switches hubs. An external hub is checked with both keys before it is saved. */
    readonly setConnection: (
      input: AccountHubSetConnectionInput,
    ) => Effect.Effect<AccountHubConnection, AccountHubError>;
    /** Copies (or moves) every account of another CLIProxyAPI into this hub. */
    readonly importAccounts: (
      input: AccountHubImportInput,
    ) => Effect.Effect<AccountHubImportResult, AccountHubError>;
    /** The running hub as a usage limit source, so its accounts report limits. */
    readonly usageLimitSource: Effect.Effect<
      Option.Option<readonly [UsageLimitSourceId, UsageLimitSourceConfig]>
    >;
  }
>()("t3/accountHub/AccountHub") {}

/**
 * Where one hub keeps its files, keys, and usage source. The personal pool's
 * hub uses today's names, so existing installs need no migration; every other
 * pool gets its own directory and key names.
 */
export interface AccountHubPlacement {
  /** Under the server state directory. */
  readonly directory: string;
  /** Prefix for this hub's secret names. */
  readonly secretPrefix: string;
  readonly sourceId: UsageLimitSourceId;
}

/** Every secret a hub keeps, so removing a pool removes exactly these. */
export const hubSecretNames = (placement: AccountHubPlacement) => ({
  management: `${placement.secretPrefix}-management-key`,
  client: `${placement.secretPrefix}-client-key`,
  externalManagement: `${placement.secretPrefix}-external-management-key`,
  externalClient: `${placement.secretPrefix}-external-client-key`,
});

// Every pool's hub installs into the same tools directory; one install at a time.
const installLock = Semaphore.makeUnsafe(1);

export const PERSONAL_HUB: AccountHubPlacement = {
  directory: "account-hub",
  secretPrefix: "account-hub",
  sourceId: ACCOUNT_HUB_SOURCE_ID,
};
const StoredConnection = Schema.Struct({ mode: Schema.Literal("external"), url: Schema.String });
const decodeStoredConnection = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredConnection));
const encodeStoredConnection = Schema.encodeEffect(Schema.fromJsonString(StoredConnection));
// A hub that exits before this long counts as a crash loop and backs off.
const STABLE_UPTIME = Duration.seconds(30);
const RESTART_BACKOFF_MIN = Duration.seconds(1);
const RESTART_BACKOFF_MAX = Duration.minutes(2);
const backoff = (previous: Duration.Duration) =>
  Duration.min(Duration.max(RESTART_BACKOFF_MIN, Duration.times(previous, 2)), RESTART_BACKOFF_MAX);

const isAccountHubInstallError = Schema.is(AccountHubInstallError);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeCredentialFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
// JSON strings are valid YAML double-quoted scalars, so paths and keys need no escaping rules.
const yamlString = (value: string) => JSON.stringify(value);

function renderAccountHubConfig(options: {
  readonly port: number;
  readonly managementKey: string;
  readonly clientKey: string;
  readonly authDir: string;
  readonly pluginsDir: string;
}): string {
  return [
    "# Written by Signalbox on every start. Edits here are overwritten.",
    "config-version: 8",
    // The hub logs to <auth-dir>/logs instead of a pipe; see `spawn`.
    "logging-to-file: true",
    "logs-max-total-size-mb: 20",
    "server:",
    '  host: "127.0.0.1"',
    `  port: ${options.port}`,
    "management:",
    "  allow-remote: false",
    `  secret-key: ${yamlString(options.managementKey)}`,
    "  disable-control-panel: true",
    "access:",
    "  api-keys:",
    `    - ${yamlString(options.clientKey)}`,
    "oauth:",
    `  auth-dir: ${yamlString(options.authDir)}`,
    // Antigravity's API-key mode asks for Flash models without the effort suffix
    // that Antigravity accounts serve them under.
    "  model-alias:",
    "    antigravity:",
    ...["3.7", "3.6", "3.5"].flatMap((version) => [
      `      - name: "gemini-${version}-flash-high"`,
      `        alias: "gemini-${version}-flash"`,
      "        fork: true",
    ]),
    "routing:",
    '  strategy: "round-robin"',
    // A thread keeps one account so cached prompts and encrypted reasoning stay valid.
    "  session-affinity: true",
    "plugins:",
    "  enabled: true",
    `  dir: ${yamlString(options.pluginsDir)}`,
    // Plugins start disabled; this one runs Sign in with ChatGPT accounts (native/cliproxyapi-chatgpt).
    "  configs:",
    "    chatgpt-siwc:",
    "      enabled: true",
    "",
  ].join("\n");
}

/** One hub at `placement`. `layer` builds the personal pool's; AccountPools builds the rest. */
export const makeAccountHub = Effect.fn("makeAccountHub")(function* (
  placement: AccountHubPlacement,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const net = yield* NetService.NetService;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const serviceScope = yield* Effect.scope;
  const installContext = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient
    | ChildProcessSpawner.ChildProcessSpawner
  >();

  const toolsDirectory = path.join(config.baseDir, "tools", "cliproxyapi");
  const hubDirectory = path.join(config.stateDir, placement.directory);
  const secretNames = hubSecretNames(placement);
  const MANAGEMENT_KEY_SECRET = secretNames.management;
  const CLIENT_KEY_SECRET = secretNames.client;
  const EXTERNAL_MANAGEMENT_KEY_SECRET = secretNames.externalManagement;
  const EXTERNAL_CLIENT_KEY_SECRET = secretNames.externalClient;
  const authDir = path.join(hubDirectory, "auths");
  const pluginsDir = path.join(hubDirectory, "plugins");
  const configPath = path.join(hubDirectory, "config.yaml");

  const status = yield* SubscriptionRef.make<AccountHubStatus>({ phase: "off" });
  // A hub the user runs replaces the managed one entirely: nothing is spawned.
  const connectionPath = path.join(hubDirectory, "connection.json");
  const external = yield* Ref.make<Option.Option<AccountHubEndpoint>>(Option.none());
  const running = yield* Ref.make<
    Option.Option<{ readonly endpoint: AccountHubEndpoint; readonly scope: Scope.Closeable }>
  >(Option.none());
  const gate = yield* Semaphore.make(1);
  const restartDelay = yield* Ref.make<Duration.Duration>(Duration.zero);
  const accountChanged = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
  const markAccountsChanged = PubSub.publish(accountChanged, undefined).pipe(Effect.asVoid);

  const keys = Effect.all({
    managementKey: secrets
      .getOrCreateRandom(MANAGEMENT_KEY_SECRET, 32)
      .pipe(Effect.map(Hex.encode)),
    clientKey: secrets.getOrCreateRandom(CLIENT_KEY_SECRET, 32).pipe(Effect.map(Hex.encode)),
  });

  // Claude instances bake the hub URL into their environment, so keep the
  // port across restarts and only move when something else took it.
  const portPath = path.join(hubDirectory, "port");
  const stablePort = Effect.gen(function* () {
    const saved = yield* fs.readFileString(portPath).pipe(
      Effect.map((text) => Number.parseInt(text.trim(), 10)),
      Effect.orElseSucceed(() => Number.NaN),
    );
    if (Number.isInteger(saved) && saved > 0 && (yield* net.isPortAvailableOnLoopback(saved))) {
      return saved;
    }
    const port = yield* net.reserveLoopbackPort();
    yield* fs.makeDirectory(hubDirectory, { recursive: true });
    yield* fs.writeFileString(portPath, `${port}\n`);
    return port;
  });

  const probe = (endpoint: AccountHubEndpoint) =>
    http
      .execute(
        HttpClientRequest.get(`${endpoint.baseUrl}/v0/management/config`).pipe(
          HttpClientRequest.bearerToken(endpoint.managementKey),
        ),
      )
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.timeout("2 seconds"));

  // A server that died abruptly (crash, kill -9) leaves its hub running, and
  // CLIProxyAPI has no way to notice its parent is gone. Each start records the
  // hub's pid and stops the previous one, if that pid still runs our config.
  const pidPath = path.join(hubDirectory, "hub.pid");
  const stopPreviousHub = Effect.gen(function* () {
    if (platform === "win32") return;
    const pid = yield* fs.readFileString(pidPath).pipe(
      Effect.map((text) => Number.parseInt(text.trim(), 10)),
      Effect.orElseSucceed(() => Number.NaN),
    );
    if (!Number.isInteger(pid) || pid <= 0) return;
    const command = yield* spawner
      .spawn(ChildProcess.make("ps", ["-o", "command=", "-p", String(pid)], { shell: false }))
      .pipe(
        Effect.flatMap((child) => child.stdout.pipe(Stream.decodeText(), Stream.mkString)),
        Effect.scoped,
        Effect.orElseSucceed(() => ""),
      );
    // A recycled pid belongs to something else; only our own config marks our hub.
    if (!command.includes(configPath)) return;
    yield* Effect.logWarning("stopping account hub left by a previous server", { pid });
    const signal = (name: NodeJS.Signals) =>
      Effect.try(() => process.kill(pid, name)).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false), // Already gone.
      );
    const alive = Effect.sync(() => isProcessAlive(pid));
    if (!(yield* signal("SIGTERM"))) return;
    yield* Effect.sleep("500 millis");
    // A hub stuck in shutdown ignores SIGTERM and keeps a core busy.
    if (yield* alive) {
      yield* Effect.sleep("2 seconds");
      if (yield* alive) yield* signal("SIGKILL");
    }
  });

  const spawn = Effect.gen(function* () {
    const executable = yield* installLock
      .withPermits(1)(installAccountHub({ toolsDirectory, platform, arch }))
      .pipe(Effect.provideContext(installContext));
    const { managementKey, clientKey } = yield* keys;
    // First, so an orphan neither holds the saved port nor sees its config rewritten.
    yield* stopPreviousHub;
    const port = yield* stablePort;
    yield* fs.makeDirectory(authDir, { recursive: true });
    yield* fs.makeDirectory(pluginsDir, { recursive: true });
    // API keys live in the config the hub saves; carry them over the rewrite.
    const previous = yield* fs.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
    yield* fs.writeFileString(
      configPath,
      renderAccountHubConfig({ port, managementKey, clientKey, authDir, pluginsDir }) +
        apiKeySections(previous),
      { mode: 0o600 },
    );
    const endpoint: AccountHubEndpoint = {
      baseUrl: `http://127.0.0.1:${port}`,
      managementKey,
      clientKey,
    };
    // MANAGEMENT_PASSWORD would add a second key and open management to the network.
    const { MANAGEMENT_PASSWORD: _ignored, ...childEnvironment } = environment;
    const scope = yield* Scope.make("sequential");
    // Anything but a started hub (a failure, or an interrupt because the pool was deleted or
    // the server is stopping) closes the scope, which stops the process.
    return yield* Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(executable, ["--config", configPath, "-local-model"], {
            cwd: hubDirectory,
            env: childEnvironment,
            shell: false,
            detached: false,
            // No pipes: with a Go plugin loaded, CLIProxyAPI spins at full CPU forever when
            // its output pipe closes during shutdown. And should it ever hang, SIGKILL.
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            forceKillAfter: "5 seconds",
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));
      yield* fs.writeFileString(pidPath, `${Number(child.pid)}\n`);
      // Stop waiting as soon as the hub exits (bad config, taken port) instead of timing out.
      const ready = yield* Effect.raceFirst(
        probe(endpoint).pipe(Effect.retry(Schedule.spaced("150 millis")), Effect.as(true)),
        child.exitCode.pipe(
          Effect.as(false),
          Effect.orElseSucceed(() => false),
        ),
      ).pipe(Effect.timeoutOption("30 seconds"));
      if (Option.isNone(ready) || !ready.value) {
        return yield* new AccountHubError({
          detail: Option.isNone(ready)
            ? "The account hub did not start in time."
            : "The account hub stopped while starting.",
        });
      }
      return { endpoint, scope, child };
    }).pipe(
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, Exit.void))),
    );
  });

  // Restart on exit. Quick exits and failed restarts back off so a broken binary cannot spin,
  // and the wait happens outside the gate so callers are never stuck behind it.
  const supervise = (
    exitCode: Effect.Effect<unknown, PlatformError>,
    scope: Scope.Closeable,
    startedAt: number,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(exitCode);
      const ours = yield* gate.withPermit(
        Ref.modify(running, (current) =>
          Option.isSome(current) && current.value.scope === scope
            ? [true, Option.none()]
            : [false, current],
        ),
      );
      if (!ours) return;
      yield* Scope.close(scope, Exit.void);
      yield* Effect.logWarning("account hub exited; restarting", { exit });
      yield* SubscriptionRef.set(status, { phase: "starting" });
      const stable =
        (yield* Clock.currentTimeMillis) - startedAt >= Duration.toMillis(STABLE_UPTIME);
      let delay = stable ? RESTART_BACKOFF_MIN : backoff(yield* Ref.get(restartDelay));
      while (true) {
        yield* Ref.set(restartDelay, delay);
        yield* Effect.sleep(delay);
        if ((yield* Effect.result(ensureRunning))._tag === "Success") return;
        delay = backoff(delay);
      }
    });

  const start: Effect.Effect<AccountHubEndpoint, AccountHubError> = Effect.gen(function* () {
    yield* SubscriptionRef.set(status, { phase: "starting" });
    const started = yield* spawn.pipe(
      Effect.mapError((cause) =>
        isAccountHubError(cause)
          ? cause
          : new AccountHubError({
              detail: isAccountHubInstallError(cause)
                ? cause.detail
                : "Could not start the account hub.",
              cause,
            }),
      ),
      Effect.tapError((error) =>
        SubscriptionRef.set(status, { phase: "failed", detail: error.detail }),
      ),
    );
    const startedAt = yield* Clock.currentTimeMillis;
    yield* Ref.set(running, Option.some({ endpoint: started.endpoint, scope: started.scope }));
    yield* SubscriptionRef.set(status, { phase: "running", version: ACCOUNT_HUB_VERSION });
    yield* Effect.logInfo("account hub started", {
      pid: Number(started.child.pid),
      version: ACCOUNT_HUB_VERSION,
    });
    yield* Effect.forkIn(supervise(started.child.exitCode, started.scope, startedAt), serviceScope);
    return started.endpoint;
  });

  // Set when this hub's scope closes (its pool was deleted); it never starts again.
  const closed = yield* Ref.make(false);
  yield* Effect.addFinalizer(() => Ref.set(closed, true));
  const ensureManaged = gate.withPermit(
    Effect.gen(function* () {
      if (yield* Ref.get(closed)) {
        return yield* new AccountHubError({ detail: "That pool no longer exists." });
      }
      const current = yield* Ref.get(running);
      return Option.isSome(current) ? current.value.endpoint : yield* start;
    }),
  );
  const ensureRunning: Effect.Effect<AccountHubEndpoint, AccountHubError> = Ref.get(external).pipe(
    Effect.flatMap((hub) => (Option.isSome(hub) ? Effect.succeed(hub.value) : ensureManaged)),
  );

  yield* Effect.addFinalizer(() =>
    Ref.get(running).pipe(
      Effect.flatMap((current) =>
        Option.isSome(current) ? Scope.close(current.value.scope, Exit.void) : Effect.void,
      ),
      Effect.andThen(Ref.set(running, Option.none())),
    ),
  );

  const savedExternal = yield* Effect.gen(function* () {
    const saved = yield* fs
      .readFileString(connectionPath)
      .pipe(Effect.flatMap(decodeStoredConnection));
    const managementKey = yield* secrets.get(EXTERNAL_MANAGEMENT_KEY_SECRET);
    const clientKey = yield* secrets.get(EXTERNAL_CLIENT_KEY_SECRET);
    if (Option.isNone(managementKey) || Option.isNone(clientKey)) return Option.none();
    const decoder = new TextDecoder();
    return Option.some<AccountHubEndpoint>({
      baseUrl: normalizeHubUrl(saved.url),
      managementKey: decoder.decode(managementKey.value),
      clientKey: decoder.decode(clientKey.value),
    });
  }).pipe(Effect.orElseSucceed(() => Option.none<AccountHubEndpoint>()));
  yield* Ref.set(external, savedExternal);
  if (Option.isSome(savedExternal)) {
    yield* SubscriptionRef.set(status, { phase: "running", version: "external" });
  }

  // Accounts already exist: bring the hub back with the server, in the background.
  const hasAccounts = Option.isSome(savedExternal)
    ? false
    : yield* fs.readDirectory(authDir).pipe(
        Effect.map((entries) => entries.some((entry) => entry.endsWith(".json"))),
        Effect.orElseSucceed(() => false),
      );
  if (hasAccounts) {
    yield* ensureRunning.pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(serviceScope));
  }

  const endpoint = Effect.gen(function* () {
    const hub = yield* Ref.get(external);
    if (Option.isSome(hub)) return hub;
    return Option.map(yield* Ref.get(running), (current) => current.endpoint);
  });
  const plannedManaged = gate
    .withPermit(
      Effect.gen(function* () {
        const current = yield* Ref.get(running);
        if (Option.isSome(current)) return current.value.endpoint;
        const { managementKey, clientKey } = yield* keys;
        const port = yield* stablePort;
        return { baseUrl: `http://127.0.0.1:${port}`, managementKey, clientKey };
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) => new AccountHubError({ detail: "Could not prepare the account hub.", cause }),
      ),
    );
  const plannedEndpoint = Ref.get(external).pipe(
    Effect.flatMap((hub) => (Option.isSome(hub) ? Effect.succeed(hub.value) : plannedManaged)),
  );
  const withHttp = Effect.provideService(HttpClient.HttpClient, http);

  // Writes without announcing it, so a batch (import) announces once.
  const writeCredential = Effect.fn("AccountHub.writeCredential")(
    function* (name: string, credential: Readonly<Record<string, unknown>>) {
      if (!/^[\w.@+-]+\.json$/u.test(name) || name.startsWith(".")) {
        return yield* new AccountHubError({ detail: "Invalid account file name." });
      }
      const hub = yield* ensureRunning;
      if (Option.isSome(yield* Ref.get(external))) {
        yield* withHttp(Management.uploadCredential(hub, name, yield* encodeJson(credential)));
        return;
      }
      // Write beside the auth directory and rename in, so the hub never reads half a file.
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: hubDirectory,
        prefix: ".staging-",
      });
      const file = path.join(staging, name);
      yield* fs.writeFileString(file, yield* encodeJson(credential), { mode: 0o600 });
      yield* fs.rename(file, path.join(authDir, name));
    },
    Effect.scoped,
    Effect.mapError((cause) =>
      isAccountHubError(cause)
        ? cause
        : new AccountHubError({ detail: "Could not save the account to the hub.", cause }),
    ),
  );
  const saveCredential = (name: string, credential: Readonly<Record<string, unknown>>) =>
    writeCredential(name, credential).pipe(Effect.tap(() => markAccountsChanged));

  const startOAuthLogin = Effect.fn("AccountHub.startOAuthLogin")(function* (
    provider: Management.AccountHubOAuthProvider,
    options: { readonly localCallback: boolean },
  ) {
    const hub = yield* ensureRunning;
    // A hub on another machine cannot catch a redirect to this machine's localhost.
    const localCallback = options.localCallback && Option.isNone(yield* Ref.get(external));
    const login = yield* withHttp(Management.startOAuthLogin(hub, provider, localCallback));
    return {
      url: login.url,
      ...(login.flow === "device" && login.user_code ? { userCode: login.user_code } : {}),
      complete: (redirectUrl: string) => withHttp(Management.completeOAuthLogin(hub, redirectUrl)),
      await: withHttp(Management.awaitOAuthLogin(hub, login.state)).pipe(
        Effect.tap(() => markAccountsChanged),
      ),
      cancel: withHttp(Management.cancelOAuthLogin(hub, login.state)),
    } satisfies AccountHubOAuthLogin;
  });

  const stopManaged = gate.withPermit(
    Ref.getAndSet(running, Option.none()).pipe(
      // Cleared first, so the supervisor sees the exit as intended and does not restart it.
      Effect.flatMap((current) =>
        Option.isSome(current) ? Scope.close(current.value.scope, Exit.void) : Effect.void,
      ),
    ),
  );

  const connection = Ref.get(external).pipe(
    Effect.map((hub): AccountHubConnection =>
      Option.isSome(hub) ? { mode: "external", url: hub.value.baseUrl } : { mode: "managed" },
    ),
  );

  const setConnection = Effect.fn("AccountHub.setConnection")(
    function* (input: AccountHubSetConnectionInput) {
      if (input.mode === "managed") {
        yield* fs.remove(connectionPath, { force: true });
        yield* secrets.remove(EXTERNAL_MANAGEMENT_KEY_SECRET);
        yield* secrets.remove(EXTERNAL_CLIENT_KEY_SECRET);
        yield* Ref.set(external, Option.none());
        yield* SubscriptionRef.set(status, { phase: "off" });
        yield* markAccountsChanged;
        return yield* connection;
      }
      const hub: AccountHubEndpoint = {
        baseUrl: normalizeHubUrl(input.url),
        managementKey: input.managementKey,
        clientKey: input.clientKey,
      };
      // Both keys are checked now, so a typo fails here and not on the first turn.
      const [, models] = yield* Effect.all(
        [
          withHttp(Management.listCredentials(hub)),
          http
            .execute(
              HttpClientRequest.get(`${hub.baseUrl}/v1/models`).pipe(
                HttpClientRequest.bearerToken(hub.clientKey),
              ),
            )
            .pipe(Effect.timeout("10 seconds"), Effect.option),
        ],
        { concurrency: 2 },
      );
      if (Option.isNone(models) || models.value.status !== 200) {
        return yield* new AccountHubError({
          detail: "That CLIProxyAPI did not accept the API key. Use one of its access api-keys.",
        });
      }
      const encoder = new TextEncoder();
      yield* secrets.set(EXTERNAL_MANAGEMENT_KEY_SECRET, encoder.encode(hub.managementKey));
      yield* secrets.set(EXTERNAL_CLIENT_KEY_SECRET, encoder.encode(hub.clientKey));
      yield* fs.makeDirectory(hubDirectory, { recursive: true });
      yield* fs.writeFileString(
        connectionPath,
        yield* encodeStoredConnection({ mode: "external", url: hub.baseUrl }),
        { mode: 0o600 },
      );
      yield* stopManaged;
      yield* Ref.set(external, Option.some(hub));
      yield* SubscriptionRef.set(status, { phase: "running", version: "external" });
      yield* markAccountsChanged;
      return yield* connection;
    },
    Effect.mapError((cause) =>
      isAccountHubError(cause)
        ? cause
        : new AccountHubError({ detail: "Could not save the hub connection.", cause }),
    ),
  );

  const importAccounts = Effect.fn("AccountHub.importAccounts")(
    function* (input: AccountHubImportInput) {
      const source = { baseUrl: normalizeHubUrl(input.url), managementKey: input.managementKey };
      const target = yield* ensureRunning;
      if (source.baseUrl === target.baseUrl) {
        return yield* new AccountHubError({
          detail: "That is the hub Signalbox already uses, so there is nothing to import.",
        });
      }
      const [sourceAccounts, targetAccounts] = yield* Effect.all(
        [
          withHttp(Management.listCredentials(source)),
          withHttp(Management.listCredentials(target)),
        ],
        { concurrency: 2 },
      );
      const existing = new Set(targetAccounts.map((account) => account.name));
      const imported: string[] = [];
      const skipped: string[] = [];
      const failed: Array<{ name: string; reason: string }> = [];
      for (const account of sourceAccounts) {
        if (existing.has(account.name)) {
          skipped.push(account.name);
          continue;
        }
        const moved = yield* Effect.gen(function* () {
          const content = yield* withHttp(Management.downloadCredential(source, account.name));
          const credential = yield* decodeCredentialFile(content).pipe(
            Effect.mapError(
              () => new AccountHubError({ detail: `${account.name} is not a credential file.` }),
            ),
          );
          yield* writeCredential(account.name, credential);
          if (input.removeFromSource) {
            yield* withHttp(Management.deleteCredential(source, account.name));
          }
        }).pipe(Effect.result);
        if (moved._tag === "Success") imported.push(account.name);
        else failed.push({ name: account.name, reason: moved.failure.detail });
      }
      if (imported.length > 0) yield* markAccountsChanged;
      return { imported, skipped, failed } satisfies AccountHubImportResult;
    },
    Effect.mapError((cause) =>
      isAccountHubError(cause)
        ? cause
        : new AccountHubError({ detail: "Could not import accounts.", cause }),
    ),
  );

  const addApiKey: AccountHub["Service"]["addApiKey"] = (input) =>
    ensureRunning.pipe(
      Effect.flatMap((hub) => withHttp(addHubApiKey(hub, input))),
      Effect.tap(() => markAccountsChanged),
    );

  return AccountHub.of({
    addApiKey,
    connection,
    setConnection,
    importAccounts,
    ensureRunning,
    endpoint,
    saveCredential,
    startOAuthLogin,
    readCredential: (name) =>
      ensureRunning.pipe(
        Effect.flatMap((hub) => withHttp(Management.downloadCredential(hub, name))),
      ),
    removeCredential: (name) =>
      ensureRunning.pipe(
        Effect.flatMap((hub) => withHttp(Management.deleteCredential(hub, name))),
        Effect.andThen(markAccountsChanged),
      ),
    accounts: endpoint.pipe(
      Effect.flatMap((current) =>
        Option.isNone(current)
          ? Effect.succeed([])
          : withHttp(Management.listCredentials(current.value)),
      ),
    ),
    plannedEndpoint,
    statusChanges: SubscriptionRef.changes(status),
    accountChanges: Stream.fromPubSub(accountChanged),
    markAccountsChanged,
    usageLimitSource: endpoint.pipe(
      Effect.map(
        Option.map(
          (hub) =>
            [
              placement.sourceId,
              {
                kind: "cliproxy",
                label: hub.baseUrl.startsWith("http://127.0.0.1:")
                  ? "Signalbox"
                  : new URL(hub.baseUrl).host,
                url: hub.baseUrl,
                managementKey: hub.managementKey,
                enabled: true,
              },
            ] as const,
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(AccountHub, makeAccountHub(PERSONAL_HUB));
