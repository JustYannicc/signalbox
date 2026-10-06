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
import { ACCOUNT_HUB_SOURCE_ID } from "@t3tools/contracts/accountHub";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
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
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Management from "./accountHubManagement.ts";
import { AccountHubError, type AccountHubEndpoint } from "./accountHubManagement.ts";
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
    /** Accounts in the running hub. Empty when the hub is off. */
    readonly accounts: Effect.Effect<ReadonlyArray<Management.AccountHubAccount>, AccountHubError>;
    /** The running hub as a usage limit source, so its accounts report limits. */
    readonly usageLimitSource: Effect.Effect<
      Option.Option<readonly [UsageLimitSourceId, UsageLimitSourceConfig]>
    >;
  }
>()("t3/accountHub/AccountHub") {}

const MANAGEMENT_KEY_SECRET = "account-hub-management-key";
const CLIENT_KEY_SECRET = "account-hub-client-key";
// A hub that exits before this long counts as a crash loop and backs off.
const STABLE_UPTIME = Duration.seconds(30);
const RESTART_BACKOFF_MIN = Duration.seconds(1);
const RESTART_BACKOFF_MAX = Duration.minutes(2);
const backoff = (previous: Duration.Duration) =>
  Duration.min(Duration.max(RESTART_BACKOFF_MIN, Duration.times(previous, 2)), RESTART_BACKOFF_MAX);

const isAccountHubError = Schema.is(AccountHubError);
const isAccountHubInstallError = Schema.is(AccountHubInstallError);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
// JSON strings are valid YAML double-quoted scalars, so paths and keys need no escaping rules.
const yamlString = (value: string) => JSON.stringify(value);

export function renderAccountHubConfig(options: {
  readonly port: number;
  readonly managementKey: string;
  readonly clientKey: string;
  readonly authDir: string;
  readonly pluginsDir: string;
}): string {
  return [
    "# Written by Signalbox on every start. Edits here are overwritten.",
    "config-version: 8",
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

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const net = yield* NetService.NetService;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const environment = yield* HostProcessEnvironment;
  const serviceScope = yield* Effect.scope;
  const installContext = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient
    | ChildProcessSpawner.ChildProcessSpawner
  >();

  const toolsDirectory = path.join(config.baseDir, "tools", "cliproxyapi");
  const hubDirectory = path.join(config.stateDir, "account-hub");
  const authDir = path.join(hubDirectory, "auths");
  const pluginsDir = path.join(hubDirectory, "plugins");
  const configPath = path.join(hubDirectory, "config.yaml");

  const status = yield* SubscriptionRef.make<AccountHubStatus>({ phase: "off" });
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
      .pipe(Effect.map(Encoding.encodeHex)),
    clientKey: secrets
      .getOrCreateRandom(CLIENT_KEY_SECRET, 32)
      .pipe(Effect.map(Encoding.encodeHex)),
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
        HttpClientRequest.get(`${endpoint.baseUrl}/v8/management/config`).pipe(
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
    yield* Effect.sync(() => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    });
    yield* Effect.sleep("500 millis");
  });

  const spawn = Effect.gen(function* () {
    const executable = yield* installAccountHub({ toolsDirectory, platform, arch }).pipe(
      Effect.provideContext(installContext),
    );
    const { managementKey, clientKey } = yield* keys;
    const port = yield* stablePort;
    yield* fs.makeDirectory(authDir, { recursive: true });
    yield* fs.makeDirectory(pluginsDir, { recursive: true });
    yield* fs.writeFileString(
      configPath,
      renderAccountHubConfig({ port, managementKey, clientKey, authDir, pluginsDir }),
      { mode: 0o600 },
    );
    const endpoint: AccountHubEndpoint = {
      baseUrl: `http://127.0.0.1:${port}`,
      managementKey,
      clientKey,
    };
    // MANAGEMENT_PASSWORD would add a second key and open management to the network.
    yield* stopPreviousHub;
    const { MANAGEMENT_PASSWORD: _ignored, ...childEnvironment } = environment;
    const scope = yield* Scope.make("sequential");
    const child = yield* spawner
      .spawn(
        ChildProcess.make(executable, ["--config", configPath, "-local-model"], {
          cwd: hubDirectory,
          env: childEnvironment,
          shell: false,
          detached: false,
          stdout: "pipe",
          stderr: "pipe",
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.tapError(() => Scope.close(scope, Exit.void)),
      );
    yield* fs.writeFileString(pidPath, `${Number(child.pid)}\n`);
    // Drain output so a chatty hub never blocks on a full pipe.
    yield* Effect.forkIn(
      Stream.merge(child.stdout, child.stderr).pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Effect.logDebug("account hub", { line })),
      ),
      scope,
    );
    // Stop waiting as soon as the hub exits (bad config, taken port) instead of timing out.
    const ready = yield* Effect.raceFirst(
      probe(endpoint).pipe(Effect.retry(Schedule.spaced("150 millis")), Effect.as(true)),
      child.exitCode.pipe(
        Effect.as(false),
        Effect.orElseSucceed(() => false),
      ),
    ).pipe(Effect.timeoutOption("30 seconds"));
    if (Option.isNone(ready) || !ready.value) {
      yield* Scope.close(scope, Exit.void);
      return yield* new AccountHubError({
        detail: Option.isNone(ready)
          ? "The account hub did not start in time."
          : "The account hub stopped while starting.",
      });
    }
    return { endpoint, scope, child };
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

  const ensureRunning = gate.withPermit(
    Ref.get(running).pipe(
      Effect.flatMap((current) =>
        Option.isSome(current) ? Effect.succeed(current.value.endpoint) : start,
      ),
    ),
  );

  yield* Effect.addFinalizer(() =>
    Ref.get(running).pipe(
      Effect.flatMap((current) =>
        Option.isSome(current) ? Scope.close(current.value.scope, Exit.void) : Effect.void,
      ),
      Effect.andThen(Ref.set(running, Option.none())),
    ),
  );

  // Accounts already exist: bring the hub back with the server, in the background.
  const hasAccounts = yield* fs.readDirectory(authDir).pipe(
    Effect.map((entries) => entries.some((entry) => entry.endsWith(".json"))),
    Effect.orElseSucceed(() => false),
  );
  if (hasAccounts) {
    yield* ensureRunning.pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(serviceScope));
  }

  const endpoint = Ref.get(running).pipe(Effect.map(Option.map((current) => current.endpoint)));
  const plannedEndpoint = gate
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
  const withHttp = Effect.provideService(HttpClient.HttpClient, http);

  const saveCredential = Effect.fn("AccountHub.saveCredential")(
    function* (name: string, credential: Readonly<Record<string, unknown>>) {
      if (!/^[\w.@+-]+\.json$/u.test(name) || name.startsWith(".")) {
        return yield* new AccountHubError({ detail: "Invalid account file name." });
      }
      yield* ensureRunning;
      // Write beside the auth directory and rename in, so the hub never reads half a file.
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: hubDirectory,
        prefix: ".staging-",
      });
      const file = path.join(staging, name);
      yield* fs.writeFileString(file, yield* encodeJson(credential), { mode: 0o600 });
      yield* fs.rename(file, path.join(authDir, name));
      yield* markAccountsChanged;
    },
    Effect.scoped,
    Effect.mapError((cause) =>
      isAccountHubError(cause)
        ? cause
        : new AccountHubError({ detail: "Could not save the account to the hub.", cause }),
    ),
  );

  const startOAuthLogin = Effect.fn("AccountHub.startOAuthLogin")(function* (
    provider: Management.AccountHubOAuthProvider,
    options: { readonly localCallback: boolean },
  ) {
    const hub = yield* ensureRunning;
    const login = yield* withHttp(Management.startOAuthLogin(hub, provider, options.localCallback));
    return {
      url: login.url,
      ...(login.flow === "device" && login.user_code ? { userCode: login.user_code } : {}),
      complete: (redirectUrl: string) =>
        withHttp(Management.completeOAuthLogin(hub, provider, redirectUrl)),
      await: withHttp(Management.awaitOAuthLogin(hub, login.state)).pipe(
        Effect.tap(() => markAccountsChanged),
      ),
      cancel: withHttp(Management.cancelOAuthLogin(hub, login.state)),
    } satisfies AccountHubOAuthLogin;
  });

  return AccountHub.of({
    ensureRunning,
    endpoint,
    saveCredential,
    startOAuthLogin,
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
              ACCOUNT_HUB_SOURCE_ID,
              {
                kind: "cliproxy",
                label: "Signalbox",
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

export const layer = Layer.effect(AccountHub, make);
