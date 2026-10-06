/**
 * A Codex instance whose requests go through the account hub, so every
 * ChatGPT account added to it is pooled.
 *
 * Accounts are added with Sign in with ChatGPT, the same flow managed Codex
 * uses. After sign-in the tokens move into the hub and are cleared here: the
 * hub becomes their only refresher, because refresh tokens rotate and two
 * refreshers would invalidate each other. The saved registration stays, so an
 * expired account can be signed in again without registering a new connection.
 *
 * @module accountHub/HubCodexProvider
 */
import {
  ProviderDriverKind,
  ProviderSetupError,
  TextGenerationError,
  type CodexSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { createCodexAdapterV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { makeCodexChatGptAuth } from "../provider/CodexChatGptAuth.ts";
import { CodexInstallation } from "../provider/CodexInstallation.ts";
import { resolveManagedCodexHomeLayout } from "../provider/CodexManagedHome.ts";
import type { CodexEffectiveRuntime } from "../provider/CodexManagedRuntime.ts";
import {
  codexContinuationIdentity,
  materializeCodexShadowHome,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { withInstanceIdentity } from "../provider/Drivers/instanceIdentity.ts";
import { ProviderDriverError } from "../provider/Errors.ts";
import {
  checkCodexProviderStatus,
  makePendingCodexProvider,
  probeCodexSkillsForCwd,
} from "../provider/CodexProvider.ts";
import { makeManagedServerProvider } from "../provider/makeManagedServerProvider.ts";
import * as ProviderAuthFlow from "../provider/ProviderAuthFlow.ts";
import { reauthAccountName, reauthMethods } from "./hubReauth.ts";
import { runHubLogin, runHubReauth } from "./hubSignIn.ts";
import type { ProviderDriverCreateInput, ProviderInstance } from "../provider/ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeCodexTextGeneration } from "../textGeneration/CodexTextGeneration.ts";
import * as AccountHub from "./AccountHub.ts";
import { ACCOUNT_HUB_CHATGPT_TYPE, chatGptCredentialFile } from "./hubCredentials.ts";

const DRIVER = ProviderDriverKind.make("codex");

/** Codex talks Responses to the hub with the hub's client key, like any OpenAI-compatible endpoint. */
export function hubCodexLaunchArgs(baseUrl: string): string {
  return [
    'model_provider="signalbox_hub"',
    'model_providers.signalbox_hub.name="Signalbox account hub"',
    `model_providers.signalbox_hub.base_url="${baseUrl}/v1"`,
    `model_providers.signalbox_hub.model_catalog_url="${baseUrl}/v1/models"`,
    'model_providers.signalbox_hub.env_key="ACCESS_TOKEN"',
    'model_providers.signalbox_hub.wire_api="responses"',
    "model_providers.signalbox_hub.requires_openai_auth=false",
    "model_providers.signalbox_hub.supports_websockets=false",
    "features.api_key_model_discovery=true",
  ]
    .map((value) => `-c '${value}'`)
    .join(" ");
}

export const makeHubCodexProvider = Effect.fn("makeHubCodexProvider")(function* (
  input: ProviderDriverCreateInput<CodexSettings>,
) {
  const { instanceId, enabled, displayName, accentColor, config } = input;
  const hub = yield* AccountHub.AccountHub;
  const installation = yield* CodexInstallation;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environmentIdentity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const hostId = `urn:uuid:${yield* environmentIdentity.getEnvironmentId}`;
  const baseEnvironment = mergeProviderInstanceEnvironment(input.environment);

  const homeLayout = yield* resolveManagedCodexHomeLayout(
    serverConfig.stateDir,
    instanceId,
    config,
  );
  const homePath = homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath;
  const setupError = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId, operation, detail });

  const resolve = Effect.gen(function* () {
    const executable = yield* installation
      .acquire()
      .pipe(
        Effect.mapError(() => setupError("install", "Set up Codex before starting a session.")),
      );
    const endpoint = yield* hub.ensureRunning.pipe(
      Effect.mapError((error) => setupError("runtime", error.detail)),
    );
    yield* materializeCodexShadowHome(homeLayout).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) => setupError("runtime", cause.message)),
    );
    yield* fs
      .makeDirectory(homePath, { recursive: true })
      .pipe(Effect.mapError(() => setupError("runtime", "Could not prepare the Codex home.")));
    // The hub key is the only credential Codex sees; account tokens stay in the hub.
    const environment: NodeJS.ProcessEnv = {
      ...baseEnvironment,
      ACCESS_TOKEN: endpoint.clientKey,
      CODEX_HOME: homePath,
    };
    delete environment.T3CODE_CODEX_LAUNCH_ARGS;
    delete environment.OPENAI_API_KEY;
    delete environment.OPENAI_BASE_URL;
    return {
      config: {
        ...config,
        enabled,
        setupMode: "hub",
        binaryPath: executable.executablePath,
        homePath,
        launchArgs: hubCodexLaunchArgs(endpoint.baseUrl),
      },
      environment,
      revision: endpoint.baseUrl,
    } satisfies CodexEffectiveRuntime;
  });

  // Sign in with ChatGPT runs here; its tokens are handed to the hub right after.
  const chatGpt = yield* makeCodexChatGptAuth({
    instanceId,
    defaultReturnUrl: new URL(
      "/settings/providers",
      serverConfig.devUrl ?? `http://localhost:${serverConfig.port}`,
    ).toString(),
  });
  const controller = yield* ProviderAuthFlow.make({
    instanceId,
    credentialBinding: { owner: "t3", key: `account-hub:${instanceId}` },
    refreshMethodsAfterAuth: true,
    defaultMethodId: "chatgpt-change-account",
    // Each sign-in registers a fresh connection. A dead Codex login is signed in
    // again through the hub's own Codex login, which works on any hub.
    methods: reauthMethods(hub, ["codex", ACCOUNT_HUB_CHATGPT_TYPE]).pipe(
      Effect.map((reauth) => [
        {
          id: "chatgpt-change-account",
          name: "Add a ChatGPT account",
          description: "Sign in to ChatGPT. The account joins this pool.",
          type: "agent" as const,
        },
        ...reauth,
      ]),
    ),
    authenticate: (method, context) =>
      Effect.gen(function* () {
        const accountName = reauthAccountName(method);
        if (!accountName) {
          // The hub's own Codex login: works on any CLIProxyAPI, no plugin needed, and the
          // desktop app finishes it in one click.
          return yield* runHubLogin({
            instanceId,
            context,
            start: (login) => hub.startOAuthLogin("codex", login),
          });
        }
        if (!accountName.startsWith(`${ACCOUNT_HUB_CHATGPT_TYPE}-`)) {
          return yield* runHubReauth({ hub, instanceId, accountName, context });
        }
        // Accounts added with Sign in with ChatGPT sign in the same way again; the file is
        // named by email, so the new login replaces the dead one.
        yield* chatGpt.authenticate("chatgpt-change-account", context);
        const profile = yield* chatGpt.exportProfile;
        const credential = chatGptCredentialFile(profile, hostId);
        yield* hub
          .saveCredential(credential.name, credential.content)
          .pipe(Effect.mapError((error) => setupError("save", error.detail)));
        yield* chatGpt.revoke;
      }),
    logout: Effect.succeed("Accounts stay in the pool. Remove or pause them from Usage → Limits."),
  });

  const continuationIdentity = codexContinuationIdentity(homeLayout);
  const stamp = withInstanceIdentity({
    instanceId,
    driverKind: DRIVER,
    displayName,
    accentColor,
    continuationGroupKey: continuationIdentity.continuationKey,
  });
  const setup = { canAuthenticate: true, canInstall: true };
  const runtimePaths = { homePath: homeLayout.sharedHomePath, shadowHomePath: homePath };
  const pending = makePendingCodexProvider({ ...config, customModels: [] }).pipe(
    Effect.map((draft) => stamp({ ...draft, models: [], setup, runtimePaths })),
  );
  const check = Effect.gen(function* () {
    const base = yield* pending;
    if (!enabled) return base;
    const executable = yield* installation.resolve().pipe(Effect.option);
    if (executable._tag === "None") {
      // Nothing to choose here: install the same Codex managed instances use.
      yield* installation.start.pipe(Effect.ignore);
      return { ...base, installed: false, message: "Installing Codex." };
    }
    if (Option.isNone(yield* hub.endpoint)) {
      yield* hub.ensureRunning.pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
      return {
        ...base,
        installed: true,
        version: executable.value.version,
        message: "Starting the account hub.",
      };
    }
    const accounts = yield* hub.accounts.pipe(Effect.orElseSucceed(() => []));
    // Paused accounts serve nothing, so a pool of only paused accounts is not signed in.
    const chatGptAccounts = accounts.filter(
      // Sign in with ChatGPT accounts, and Codex logins a hub imported or already held.
      (account) =>
        (account.type === ACCOUNT_HUB_CHATGPT_TYPE || account.type === "codex") &&
        !account.disabled,
    );
    if (chatGptAccounts.length === 0) {
      return {
        ...base,
        installed: true,
        version: executable.value.version,
        message: "Add a ChatGPT account to use Codex through the pool.",
        auth: { status: "unauthenticated" as const },
      };
    }
    const auth = {
      status: "authenticated" as const,
      type: "chatgpt",
      label:
        chatGptAccounts.length === 1
          ? "1 ChatGPT account"
          : `${chatGptAccounts.length} ChatGPT accounts`,
    };
    return yield* resolve.pipe(
      Effect.flatMap((effective) =>
        checkCodexProviderStatus(effective.config, undefined, effective.environment, auth),
      ),
      Effect.map((draft) =>
        stamp({
          ...draft,
          auth,
          version: draft.version ?? executable.value.version,
          setup,
          runtimePaths,
        }),
      ),
      Effect.catch(() =>
        Effect.succeed({
          ...base,
          installed: true,
          version: executable.value.version,
          auth,
          message: "Could not reach the account hub. Retry in a moment.",
        }),
      ),
      Effect.scoped,
    );
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

  const snapshot = yield* makeManagedServerProvider({
    resolveMaintenance: () => Effect.succeed({ provider: DRIVER, packageName: null, update: null }),
    getSettings: settings.getSettings,
    streamSettings: settings.streamChanges,
    haveSettingsChanged: () => false,
    initialSnapshot: () => pending,
    checkProvider: check,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail: "Could not prepare Codex for the account hub.",
          cause,
        }),
    ),
  );

  // Re-check when the hub comes up and whenever accounts are added, paused, or removed.
  yield* Stream.merge(
    hub.statusChanges.pipe(
      Stream.map((status) => status.phase === "running"),
      Stream.changes,
      Stream.drop(1),
    ),
    hub.accountChanges,
  ).pipe(
    // A sign-in that replaces a file, or an import, changes accounts in a burst.
    Stream.debounce("300 millis"),
    Stream.runForEach(() => snapshot.refresh.pipe(Effect.ignoreCause({ log: true }))),
    Effect.forkScoped,
  );

  const orchestrationAdapter = yield* createCodexAdapterV2(input, {
    onUsageLimits: (update) => snapshot.applyUsageLimits(update),
    resolveRuntime: resolve,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: DRIVER,
          instanceId,
          detail: "Failed to build Codex orchestration adapter.",
          cause,
        }),
    ),
  );
  const nativeGeneration = yield* makeCodexTextGeneration(
    config,
    undefined,
    snapshot.getSnapshot.pipe(Effect.map((value) => value.models)),
    resolve,
  );
  const protect = <A>(operation: string, effect: Effect.Effect<A, TextGenerationError>) =>
    effect.pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "detail" in cause ? cause.detail : "Codex text generation failed.",
          }),
      ),
    );

  return {
    instanceId,
    driverKind: DRIVER,
    continuationIdentity,
    displayName,
    accentColor,
    enabled,
    snapshot,
    orchestrationAdapter,
    textGeneration: {
      generateCommitMessage: (value) =>
        protect("generateCommitMessage", nativeGeneration.generateCommitMessage(value)),
      generatePrContent: (value) =>
        protect("generatePrContent", nativeGeneration.generatePrContent(value)),
      generateBranchName: (value) =>
        protect("generateBranchName", nativeGeneration.generateBranchName(value)),
      generateThreadTitle: (value) =>
        protect("generateThreadTitle", nativeGeneration.generateThreadTitle(value)),
    },
    auth: controller,
    snapshotForCwd: (cwd: string) =>
      enabled
        ? resolve.pipe(
            Effect.flatMap((effective) =>
              probeCodexSkillsForCwd({
                binaryPath: effective.config.binaryPath,
                homePath: effective.config.homePath,
                launchArgs: effective.config.launchArgs,
                cwd,
                environment: effective.environment,
              }),
            ),
            Effect.flatMap((skills) =>
              snapshot.getSnapshot.pipe(Effect.map((draft) => ({ ...draft, skills }))),
            ),
            Effect.scoped,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.catch(() => snapshot.getSnapshot),
          )
        : snapshot.getSnapshot,
  } satisfies ProviderInstance;
});
