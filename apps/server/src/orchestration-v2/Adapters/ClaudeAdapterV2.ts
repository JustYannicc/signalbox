import {
  makeClaudeAgentSdkQueryRunner,
  queryRunnerError,
} from "@signalbox/provider-claude/ClaudeSdkQueryRunner";
import type { ClaudeAgentSdkProtocolLogger } from "@signalbox/provider-claude/ClaudeQueryProtocol";

import { readWorkflowAgentAnswers } from "../workflowAgentAnswers.ts";

// @effect-diagnostics-next-line nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import * as NodeChildProcess from "node:child_process";

import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  ClaudeSettings,
  type OrchestrationV2ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";

import * as Crypto from "effect/Crypto";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as Path from "effect/Path";

import * as Schema from "effect/Schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { resolveClaudeSdkExecutablePath } from "../../provider/Drivers/ClaudeExecutable.ts";

import { discoverClaudeSkills } from "../../provider/Drivers/ClaudeSkills.ts";

import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";
import {
  claudeSignedOutMessage,
  makeClaudeEnvironment,
} from "../../provider/Drivers/ClaudeHome.ts";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../../provider/ClaudeModelCatalog.ts";
import {
  boundProviderEventForLogging,
  shouldPersistProviderEvent,
} from "../../provider/EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";

import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";

import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

import {
  forkSession as forkClaudeSession,
  getSubagentMessages,
  query,
  type SpawnOptions as ClaudeSpawnOptions,
  type SpawnedProcess as ClaudeSpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAdapterHost } from "@signalbox/provider-claude/ClaudeAdapterHost";
import {
  CLAUDE_PROVIDER,
  CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
  CLAUDE_DEFAULT_INSTANCE_ID,
  type ClaudeAdapterV2Options,
  makeClaudeAdapterV2,
} from "@signalbox/provider-claude/ClaudeAdapter";
import { ClaudeAgentSdkQueryRunner } from "@signalbox/provider-claude/ClaudeQueryRunner";

/** Claude Code's per-user temp root, or none where it has no uid (Windows). */
export function claudeTaskOutputRoot(
  environment: Readonly<Record<string, string | undefined>> | undefined,
  path: Path.Path,
): string | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  const base = environment?.CLAUDE_CODE_TMPDIR?.trim() || "/tmp";
  return path.join(base, `claude-${uid}`);
}

export const claudeNativeHost: ClaudeAdapterHost = {
  cwd: () => process.cwd(),
  taskOutputRoot: claudeTaskOutputRoot,
  resolveAttachmentPath,
  discoverSkills: discoverClaudeSkills,
  readWorkflowAgentAnswers,
  signedOutMessage: claudeSignedOutMessage,
};

const DEFAULT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
// Entry extensions the Claude SDK runs through node instead of executing.
const CLAUDE_SCRIPT_EXTENSIONS = [".js", ".mjs", ".tsx", ".ts", ".jsx"];

/**
 * When the CLI exits it stops the MCP servers it started, but not their children: a plugin's
 * `bun run start` wrapper dies and its `bun server.ts` keeps running, writing to a pipe nobody
 * reads (#3089). Those stay in the CLI's group, so the rest of the group gets SIGKILL once the
 * CLI exits for any reason.
 */
function spawnClaudeProcessGroup(options: ClaudeSpawnOptions): ClaudeSpawnedProcess {
  const child = NodeChildProcess.spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "ignore"],
    detached: true,
  });
  child.once("exit", () => {
    try {
      signalProcessGroup(child.pid ?? 0, "SIGKILL");
    } catch {}
  });
  return child;
}

export function makeClaudeAgentSdkProtocolLogger(input: {
  readonly nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger | undefined;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}): ClaudeAgentSdkProtocolLogger | undefined {
  const { nativeEventLogger } = input;
  if (nativeEventLogger === undefined) {
    return undefined;
  }

  return (event) => {
    if (!shouldPersistProviderEvent("native", event)) return Effect.void;
    return nativeEventLogger
      .write(
        {
          provider: CLAUDE_PROVIDER,
          protocol: CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
          kind: "protocol",
          providerSessionId: input.providerSessionId,
          event: boundProviderEventForLogging(event),
        },
        input.threadId,
      )
      .pipe(Effect.ignore);
  };
}

export const layerQueryRunner = Layer.effect(
  ClaudeAgentSdkQueryRunner,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const { native: nativeEventLogger } = yield* ProviderEventLoggers.ProviderEventLoggers;
    const agentScope = yield* AgentScope;
    const platform = yield* HostProcess.Platform;
    return makeClaudeAgentSdkQueryRunner({
      allocateSessionId: crypto
        .randomUUIDv4()
        .pipe(Effect.mapError((cause) => queryRunnerError(cause, "allocateSessionId"))),
      protocolLogger: (input) => makeClaudeAgentSdkProtocolLogger({ nativeEventLogger, ...input }),
      forkSession: forkClaudeSession,
      subagentLaunchToolUseId: async (input) => {
        const messages = await getSubagentMessages(input.sessionId, input.agentId, {
          ...(input.dir === null ? {} : { dir: input.dir }),
          limit: 1,
        });
        return messages[0]?.parent_tool_use_id ?? null;
      },
      prepareQuery: Effect.fn(function* (queryOptions, input) {
        // The SDK spawns a native binary as `path ...executableArgs ...sdkArgs`,
        // which lets the agent scope wrapper go in front of the CLI. The SDK
        // runs a script entry through node instead, so those launch unwrapped.
        const binaryPath = queryOptions.pathToClaudeCodeExecutable;
        const launch =
          binaryPath === undefined ||
          CLAUDE_SCRIPT_EXTENSIONS.some((ext) => binaryPath.endsWith(ext))
            ? undefined
            : yield* agentScope.wrap({
                command: binaryPath,
                args: [],
                name: "claude",
                threadId: input.threadId,
                env: queryOptions.env,
              });
        const options =
          launch === undefined || launch.args.length === 0
            ? queryOptions
            : {
                ...queryOptions,
                pathToClaudeCodeExecutable: launch.command,
                executableArgs: [...launch.args, ...(queryOptions.executableArgs ?? [])],
              };
        // Windows has no process groups, so there the SDK spawns the CLI itself.
        const spawnClaudeCodeProcess =
          options.spawnClaudeCodeProcess ??
          (platform === "win32" ? undefined : spawnClaudeProcessGroup);
        return spawnClaudeCodeProcess === undefined
          ? options
          : { ...options, spawnClaudeCodeProcess };
      }),
      query: ({ prompt, options }) =>
        Effect.try({
          try: () => query({ prompt, options }),
          catch: (cause) => queryRunnerError(cause, "query"),
        }),
    });
  }),
);

export type ClaudeAdapterV2DriverEnv =
  | ClaudeAgentSdkQueryRunner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | Path.Path
  | ServerConfig.ServerConfig;

export const createClaudeAdapterV2 = Effect.fn("ClaudeAdapterV2Driver.create")(
  function* (
    input: ProviderAdapterDriverCreateInput<ClaudeSettings>,
    hooks: Pick<ClaudeAdapterV2Options, "scopedLimitNames" | "onUsageLimits"> = {},
  ) {
    const { instanceId, environment, enabled, config } = input;
    const fileSystem = yield* FileSystem.FileSystem;
    const hostEnvironment = yield* HostProcess.Environment;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const queryRunner = yield* ClaudeAgentSdkQueryRunner;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const baseEnvironment = yield* mergeProviderInstanceEnvironment(environment, hostEnvironment);
    const claudeEnvironment = yield* makeClaudeEnvironment(config, baseEnvironment);
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const binaryPath = yield* resolveClaudeSdkExecutablePath(
      expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
      claudeEnvironment,
    );
    return yield* makeClaudeAdapterV2({
      host: claudeNativeHost,
      modelCatalog: BUNDLED_CLAUDE_MODEL_CATALOG,
      instanceId,
      settings: { ...config, enabled, binaryPath },
      environment: claudeEnvironment,
      attachmentsDir: serverConfig.attachmentsDir,
      fileSystem,
      path,
      crypto,
      idAllocator,
      queryRunner,
      continuationRequests,
      ...hooks,
    });
  },
  (effect, input, _hooks) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: CLAUDE_PROVIDER,
            instanceId: input.instanceId,
            detail: "Failed to create Claude Agent SDK adapter.",
            cause,
          }),
      ),
    ),
);

export const ClaudeAdapterV2Driver: ProviderAdapterDriver<
  ClaudeSettings,
  ClaudeAdapterV2DriverEnv
> = {
  driverKind: CLAUDE_PROVIDER,
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => DEFAULT_CLAUDE_SETTINGS,
  create: (input) => createClaudeAdapterV2(input, {}),
};

const makeDefaultClaudeAdapterV2 = Effect.fn("ClaudeAdapterV2.layer")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const hostEnvironment = yield* HostProcess.Environment;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const queryRunner = yield* ClaudeAgentSdkQueryRunner;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;

  return yield* makeClaudeAdapterV2({
    host: claudeNativeHost,
    modelCatalog: BUNDLED_CLAUDE_MODEL_CATALOG,
    instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
    settings: DEFAULT_CLAUDE_SETTINGS,
    environment: hostEnvironment,
    attachmentsDir: serverConfig.attachmentsDir,
    fileSystem,
    path,
    crypto,
    idAllocator,
    queryRunner,
    continuationRequests,
  });
});

const layer: Layer.Layer<
  ProviderAdapter.ProviderAdapterV2,
  never,
  | ClaudeAgentSdkQueryRunner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | Path.Path
  | ServerConfig.ServerConfig
> = Layer.effect(ProviderAdapter.ProviderAdapterV2, makeDefaultClaudeAdapterV2());
