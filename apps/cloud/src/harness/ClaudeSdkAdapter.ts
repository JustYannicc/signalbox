import {
  makeClaudeAdapterV2,
  type ClaudeAdapterV2Options,
} from "@signalbox/provider-claude/ClaudeAdapter";
import {
  makeClaudeAgentSdkQueryRunner,
  queryRunnerError,
  type ClaudeSdkQueryPreCleanupDiagnostic,
} from "@signalbox/provider-claude/ClaudeSdkQueryRunner";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import type { ClaudeNativeAdapterFactory, ClaudeNativeMcpBridge } from "./ClaudeNativeAdapter.ts";
import type { PreparedClaudeSdk, SdkSpawnOptions } from "./claude/SdkTypes.ts";
import type { NodeHarnessProcess } from "./NodeHarnessProcess.ts";
import type { ClaudeToolObservation } from "./ClaudeToolObservation.ts";
import { createSdkProcess } from "./node/SdkProcess.ts";
import { claudeKernelSearchTools } from "./ClaudeKernelSearch.ts";
import { gateClaudeSdkResults } from "./claude/SdkCompatibility.ts";
import { observeClaudeQueryOptions, observeClaudeSdkMessage } from "./claude/TurnProgress.ts";

export interface ClaudeSdkAdapterOptions {
  readonly adapter: Omit<ClaudeAdapterV2Options, "queryRunner" | "environment" | "initialSnapshot">;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpSessions: McpProviderSessions.McpProviderSessions["Service"];
  readonly loadSdk: (signal: AbortSignal) => Promise<PreparedClaudeSdk>;
  readonly process: NodeHarnessProcess;
  readonly launch: (request: SdkSpawnOptions) => Promise<void>;
  readonly nativeMcp: ClaudeNativeMcpBridge;
  readonly toolObservation?: ClaudeToolObservation;
  readonly onQueryPreCleanupDiagnostic?: (diagnostic: ClaudeSdkQueryPreCleanupDiagnostic) => void;
}

/** SDK objects and callbacks stay in the host; only ordinary process I/O crosses RPC. */
export function makeClaudeSdkAdapter(
  options: ClaudeSdkAdapterOptions,
): ReturnType<ClaudeNativeAdapterFactory> {
  return {
    open: (input, reporter) =>
      Effect.gen(function* () {
        const lifetime = new AbortController();
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            lifetime.abort(new Error("Claude SDK session scope closed"));
            await options.process.dispose();
          }),
        );
        let sdk: Promise<PreparedClaudeSdk> | undefined;
        let spawned = false;
        const getSdk = () => (sdk ??= options.loadSdk(lifetime.signal));
        const report = reporter.turnMilestone ?? (() => undefined);
        const queryRunner = makeClaudeAgentSdkQueryRunner({
          allocateSessionId: options.adapter.crypto
            .randomUUIDv4()
            .pipe(Effect.mapError((cause) => queryRunnerError(cause, "allocateSessionId"))),
          query: ({ prompt, options: queryOptions }) =>
            Effect.tryPromise({
              try: async () => {
                const loaded = await getSdk();
                const observedOptions = {
                  ...queryOptions,
                  tools: claudeKernelSearchTools(queryOptions.tools),
                  ...(options.toolObservation === undefined
                    ? {}
                    : {
                        hooks: options.toolObservation.withHooks(queryOptions.hooks),
                      }),
                  spawnClaudeCodeProcess: (request: SdkSpawnOptions) => {
                    if (spawned) throw new Error("This host already owns a Claude CLI process");
                    request.signal.throwIfAborted();
                    spawned = true;
                    const child = createSdkProcess(
                      options.process,
                      queryOptions.stderr ?? (() => undefined),
                    );
                    const abort = () => {
                      void options.process.abort(request.signal.reason).catch(() => undefined);
                    };
                    request.signal.addEventListener("abort", abort, { once: true });
                    void options.process.exited
                      .finally(() => request.signal.removeEventListener("abort", abort))
                      .catch(() => undefined);
                    // The SDK spawn callback is synchronous. Its preconnected pipes apply
                    // backpressure while the remote owner acknowledges the launch request.
                    void options.launch(request).catch((cause: unknown) => {
                      void options.process.abort(cause).catch(() => undefined);
                    });
                    return child;
                  },
                };
                return gateClaudeSdkResults(
                  loaded.query({
                    prompt,
                    options:
                      reporter.turnMilestone === undefined
                        ? observedOptions
                        : observeClaudeQueryOptions(observedOptions, report),
                  }),
                  async () => {
                    report("runtime-compatibility-checking");
                    await options.process.assertCompatibility();
                    report("runtime-compatibility-confirmed");
                  },
                  reporter.turnMilestone === undefined
                    ? undefined
                    : (message) => observeClaudeSdkMessage(message, report),
                );
              },
              catch: (cause) => queryRunnerError(cause, "query"),
            }),
          forkSession: async (sessionId, forkOptions) =>
            (await getSdk()).forkSession(sessionId, forkOptions),
          subagentLaunchToolUseId: async (lookup) => {
            const messages = await (
              await getSdk()
            ).getSubagentMessages(lookup.sessionId, lookup.agentId, {
              ...(lookup.dir === null ? {} : { dir: lookup.dir }),
              limit: 1,
            });
            return messages[0]?.parent_tool_use_id ?? null;
          },
          onProgress: report,
          ...(options.onQueryPreCleanupDiagnostic === undefined
            ? {}
            : { onPreCleanupDiagnostic: options.onQueryPreCleanupDiagnostic }),
          requireMcpServerRegistration: true,
          resolveMcpServers: options.nativeMcp.resolveMcpServers,
          onQuerySessionOpened: options.nativeMcp.opened,
          onQuerySessionClosed: options.nativeMcp.closed,
        });
        const adapter = yield* makeClaudeAdapterV2({
          ...options.adapter,
          environment: options.environment,
          queryRunner,
          ...(input.checkpoint === undefined ? {} : { initialSnapshot: input.checkpoint.snapshot }),
        }).pipe(
          Effect.provideService(McpProviderSessions.McpProviderSessions, options.mcpSessions),
        );
        return yield* adapter.openSession(input.session);
      }),
  };
}
