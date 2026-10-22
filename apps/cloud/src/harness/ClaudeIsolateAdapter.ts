import {
  makeClaudeAdapterV2,
  type ClaudeAdapterV2Options,
} from "@signalbox/provider-claude/ClaudeAdapter";
import {
  makeClaudeAgentSdkQueryRunner,
  queryRunnerError,
} from "@signalbox/provider-claude/ClaudeSdkQueryRunner";
import type {
  ClaudeAgentSdkMcpServers,
  ClaudeAgentSdkQueryRunnerError,
  ClaudeAgentSdkQuerySession,
} from "@signalbox/provider-claude/ClaudeQueryRunner";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type {
  ProviderAdapterV2Error,
  ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import type { NodeBridge } from "../isolate/NodeBridge.ts";
import { HarnessError, type HarnessOpenInput } from "./Harness.ts";
import { launchNodeHarnessProcess, type NodeHarnessProcessInput } from "./NodeHarnessProcess.ts";
import { createSdkProcess } from "./node/SdkProcess.ts";
import { abortableValue, applySdkLaunch } from "./claude/SdkRelease.ts";

import type { PreparedClaudeSdk, SdkSpawnOptions } from "./claude/SdkTypes.ts";
export type { PreparedClaudeSdk, SdkSpawnOptions, SdkSpawnedProcess } from "./claude/SdkTypes.ts";
import type { HarnessProcessObserver, HarnessRuntimeReporter } from "./HarnessProcessLifetime.ts";

export interface ClaudeIsolateNativeMcpBridge {
  readonly resolveMcpServers: () => Effect.Effect<
    { readonly servers: ClaudeAgentSdkMcpServers; readonly signal: AbortSignal },
    ClaudeAgentSdkQueryRunnerError
  >;
  readonly opened: (session: ClaudeAgentSdkQuerySession) => void;
  readonly closed: (session: ClaudeAgentSdkQuerySession) => void;
}

export interface ClaudeIsolateAdapterOptions {
  readonly process: Omit<NodeHarnessProcessInput, "signal">;
  readonly adapter: Omit<ClaudeAdapterV2Options, "queryRunner" | "environment" | "initialSnapshot">;
  readonly mcpSessions: McpProviderSessions.McpProviderSessions["Service"];
  readonly loadSdk: (bridge: NodeBridge, signal: AbortSignal) => Promise<PreparedClaudeSdk>;
  readonly nativeMcp?: ClaudeIsolateNativeMcpBridge;
  readonly processObserver?: HarnessProcessObserver;
}

/** The prepared SDK and CLI share the installed Node personality and Computer files. */
export function makeClaudeIsolateAdapter(options: ClaudeIsolateAdapterOptions): {
  readonly open: (
    input: HarnessOpenInput,
    reporter: HarnessRuntimeReporter,
  ) => Effect.Effect<
    ProviderAdapterV2SessionRuntime,
    HarnessError | ProviderAdapterV2Error,
    Scope.Scope
  >;
} {
  return {
    open: (input, reporter) =>
      Effect.gen(function* () {
        const loadedRelease = input.loadedRelease ?? options.process.loadedRelease;
        if (
          input.release.harness !== "claude-code" ||
          input.computer !== options.process.computer ||
          (loadedRelease !== undefined &&
            loadedRelease.plan.release.manifestSha256 !== input.release.manifestSha256)
        )
          return yield* Effect.fail(
            new HarnessError({
              operation: "open",
              message: "Claude host does not own this release or Computer",
            }),
          );
        const lifetime = new AbortController();
        const sdkReady = abortableValue<PreparedClaudeSdk>();
        const launch = abortableValue<SdkSpawnOptions>();
        let bridge: NodeBridge | undefined;
        let spawned = false;
        const processInput: NodeHarnessProcessInput = {
          ...options.process,
          ...(loadedRelease === undefined ? {} : { loadedRelease }),
          modelTransport: input.modelTransport,
          reportReleaseChunkOmitted: reporter.releaseChunkOmitted,
          signal: lifetime.signal,
          loadRelease: async (installed, signal) => {
            bridge = installed;
            try {
              sdkReady.resolve(await options.loadSdk(installed, signal));
              const request = await launch.wait(signal);
              applySdkLaunch(installed, processInput, request);
              return await options.process.loadRelease(installed, signal);
            } catch (error) {
              sdkReady.reject(error);
              throw error;
            }
          },
        };
        const process = yield* Effect.acquireRelease(
          Effect.try({
            try: () => launchNodeHarnessProcess(processInput),
            catch: (cause) =>
              new HarnessError({
                operation: "open",
                message: "Claude personality could not be installed",
                cause,
              }),
          }),
          (process) =>
            Effect.promise(async () => {
              lifetime.abort(new Error("Claude session scope closed"));
              await process.dispose();
            }),
        );
        yield* Effect.try({
          try: () => options.processObserver?.started(process),
          catch: (cause) =>
            new HarnessError({
              operation: "open",
              message: "Claude process ownership could not be recorded.",
              cause,
            }),
        });
        // Package loading can exit before loadRelease owns SDK readiness.
        void process.exited.then(
          (status) =>
            sdkReady.reject(
              new Error("Claude process exited before SDK readiness", { cause: status }),
            ),
          (cause: unknown) => sdkReady.reject(cause),
        );
        const getSdk = () => sdkReady.wait(lifetime.signal);
        const queryRunner = makeClaudeAgentSdkQueryRunner({
          allocateSessionId: options.adapter.crypto
            .randomUUIDv4()
            .pipe(Effect.mapError((cause) => queryRunnerError(cause, "allocateSessionId"))),
          query: ({ prompt, options: queryOptions }) =>
            Effect.tryPromise({
              try: async () => {
                const sdk = await getSdk();
                return sdk.query({
                  prompt,
                  options: {
                    ...queryOptions,
                    spawnClaudeCodeProcess: (request) => {
                      if (spawned || bridge === undefined)
                        throw new Error("This facet already owns a Claude CLI process");
                      request.signal.throwIfAborted();
                      spawned = true;
                      const child = createSdkProcess(
                        process,
                        queryOptions.stderr ?? (() => undefined),
                      );
                      request.signal.addEventListener(
                        "abort",
                        () => {
                          void process.abort(request.signal.reason).catch(() => undefined);
                        },
                        { once: true },
                      );
                      launch.resolve(request);
                      return child;
                    },
                  },
                });
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
          ...(options.nativeMcp === undefined
            ? {}
            : {
                requireMcpServerRegistration: true,
                resolveMcpServers: options.nativeMcp.resolveMcpServers,
                onQuerySessionOpened: options.nativeMcp.opened,
                onQuerySessionClosed: options.nativeMcp.closed,
              }),
        });
        const adapter = yield* makeClaudeAdapterV2({
          ...options.adapter,
          environment: options.process.env,
          queryRunner,
          ...(input.checkpoint === undefined ? {} : { initialSnapshot: input.checkpoint.snapshot }),
        }).pipe(
          Effect.provideService(McpProviderSessions.McpProviderSessions, options.mcpSessions),
        );
        return yield* adapter.openSession(input.session);
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Effect.sync(() => options.processObserver?.abandoned(exit.cause))
            : Effect.void,
        ),
      ),
  };
}
