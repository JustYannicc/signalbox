import { resolveAttachmentPath, resolveAttachmentPathById } from "../../attachmentStore.ts";
import { snapshotMcpApp } from "../../mcpApps/McpAppSnapshot.ts";
import {
  buildCodexInitializeParams,
  codexAppServerEnvironment,
} from "../../provider/CodexProvider.ts";
import { CodexSettings } from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type { OrchestrationV2ProviderSession, ThreadId } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "../../provider/Drivers/CodexHomeLayout.ts";
import {
  boundProviderEventForLogging,
  shouldPersistProviderEvent,
} from "../../provider/EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "../../provider/codexLaunchArgs.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  CODEX_PROVIDER,
  CODEX_DRIVER_KIND,
  DEFAULT_CODEX_SETTINGS,
} from "@signalbox/provider-codex/defaults";
import { type CodexAppServerClientFactoryShape } from "@signalbox/provider-codex/clientFactory";
import { type CodexAdapterV2Options, makeCodexAdapterV2 } from "@signalbox/provider-codex/runtime";

export class CodexAppServerClientFactory extends Context.Service<
  CodexAppServerClientFactory,
  CodexAppServerClientFactoryShape
>()("t3/orchestration-v2/Adapters/CodexAdapterV2/CodexAppServerClientFactory") {}

export const makeCodexAppServerSpawnCommand = Effect.fn(
  "CodexAdapterV2.makeCodexAppServerSpawnCommand",
)(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly extendEnv?: boolean | undefined;
  readonly threadId?: string | undefined;
}) {
  const launch = yield* (yield* AgentScope).wrap({
    command: input.command,
    args: input.args,
    name: "codex",
    threadId: input.threadId,
    env: input.env,
  });
  const spawnCommand = yield* resolveSpawnCommand(launch.command, launch.args, {
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.extendEnv === undefined ? {} : { extendEnv: input.extendEnv }),
  });
  return ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.extendEnv === undefined ? {} : { extendEnv: input.extendEnv }),
    shell: spawnCommand.shell,
  });
});

export function makeCodexAppServerProtocolLogger(input: {
  readonly nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger | undefined;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}): CodexClient.CodexAppServerClientOptions["logger"] | undefined {
  const { nativeEventLogger } = input;
  if (nativeEventLogger === undefined) {
    return undefined;
  }

  return (event) => {
    if (!shouldPersistProviderEvent("native", event)) return Effect.void;
    return nativeEventLogger
      .write(
        {
          provider: CODEX_PROVIDER,
          protocol: "codex.app-server",
          kind: "protocol",
          providerSessionId: input.providerSessionId,
          event: redactCodexProtocolValue(boundProviderEventForLogging(event)),
        },
        input.threadId,
      )
      .pipe(Effect.ignore);
  };
}

function redactCodexProtocolValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactCodexProtocolValue);
  }
  if (value === null || typeof value !== "object") {
    if (typeof value !== "string") {
      return value;
    }
    if (/^Bearer\s+/i.test(value)) {
      return "[REDACTED]";
    }
    const trimmed = value.trim();
    if (
      !(
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      )
    ) {
      return value;
    }
    try {
      return JSON.stringify(
        redactCodexProtocolValue(boundProviderEventForLogging(JSON.parse(trimmed) as unknown)),
      );
    } catch {
      return value;
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      isSensitiveCodexProtocolKey(key) ? "[REDACTED]" : redactCodexProtocolValue(nested),
    ]),
  );
}

function isSensitiveCodexProtocolKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    normalized.endsWith("authorization") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret")
  );
}

export const layerAppServerClientFactory: Layer.Layer<
  CodexAppServerClientFactory,
  never,
  ChildProcessSpawner.ChildProcessSpawner | ProviderEventLoggers.ProviderEventLoggers
> = Layer.effect(
  CodexAppServerClientFactory,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { native: nativeEventLogger } = yield* ProviderEventLoggers.ProviderEventLoggers;
    const agentScope = yield* AgentScope;

    return CodexAppServerClientFactory.of({
      open: (input) =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope;
          const environment = {
            ...codexAppServerEnvironment(input.environment),
            ...(input.settings.homePath ? { CODEX_HOME: input.settings.homePath } : {}),
          };
          const command = yield* makeCodexAppServerSpawnCommand({
            command: input.settings.binaryPath || "codex",
            args: codexAppServerArgs(
              resolveCodexLaunchArgs(input.settings.launchArgs, input.environment),
            ),
            env: environment,
            threadId: input.threadId,
          }).pipe(Effect.provideService(AgentScope, agentScope));
          const handle = yield* spawner.spawn(command).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: CODEX_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
            ),
          );
          const protocolLogger = makeCodexAppServerProtocolLogger({
            nativeEventLogger,
            threadId: input.threadId,
            providerSessionId: input.providerSessionId,
          });
          const clientOptions: CodexClient.CodexAppServerClientOptions =
            protocolLogger === undefined
              ? {}
              : {
                  logIncoming: true,
                  logOutgoing: true,
                  logger: protocolLogger,
                };
          const context = yield* Layer.build(CodexClient.layerChildProcess(handle, clientOptions));
          return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.provide(context),
          );
        }),
    });
  }),
);

export type CodexAdapterV2DriverEnv =
  | CodexAppServerClientFactory
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | Path.Path
  | ServerConfig;

export const createCodexAdapterV2 = (
  { instanceId, environment, enabled, config }: ProviderAdapterDriverCreateInput<CodexSettings>,
  hooks: Pick<CodexAdapterV2Options, "onUsageLimits" | "resolveRuntime"> = {},
) =>
  Effect.gen(function* () {
    const clientFactory = yield* CodexAppServerClientFactory;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const hostEnvironment = yield* HostProcess.Environment;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const serverConfig = yield* ServerConfig;
    const homeLayout = yield* resolveCodexHomeLayout(config);

    yield* materializeCodexShadowHome(homeLayout).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: CODEX_DRIVER_KIND,
            instanceId,
            detail: "Failed to materialize the Codex shadow home.",
            cause,
          }),
      ),
    );

    const settings = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
      homePath: homeLayout.effectiveHomePath ?? "",
    } satisfies CodexSettings;

    return yield* makeCodexAdapterV2({
      defaultCwd: yield* HostProcess.WorkingDirectory,
      instanceId,
      settings,
      environment: yield* mergeProviderInstanceEnvironment(environment, hostEnvironment),
      clientFactory,
      crypto,
      fileSystem,
      idAllocator,
      attachmentsDir: serverConfig.attachmentsDir,
      attachments: {
        resolvePath: resolveAttachmentPath,
        resolvePathById: resolveAttachmentPathById,
        snapshotMcpApp,
      },
      clientInfo: buildCodexInitializeParams().clientInfo,
      continuationRequests,
      ...hooks,
    });
  });

export const CodexAdapterV2Driver: ProviderAdapterDriver<CodexSettings, CodexAdapterV2DriverEnv> = {
  driverKind: CODEX_DRIVER_KIND,
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => DEFAULT_CODEX_SETTINGS,
  create: createCodexAdapterV2,
};
