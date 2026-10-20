import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import {
  CLAUDE_PROVIDER,
  type ClaudeAdapterV2Options,
} from "@signalbox/provider-claude/ClaudeAdapter";
import { queryRunnerError } from "@signalbox/provider-claude/ClaudeSdkQueryRunner";
import type {
  ClaudeAgentSdkMcpServers,
  ClaudeAgentSdkQuerySession,
} from "@signalbox/provider-claude/ClaudeQueryRunner";
import {
  makeClaudeIsolateAdapter,
  type ClaudeIsolateAdapterOptions,
} from "./ClaudeIsolateAdapter.ts";
import { HarnessError, type HarnessOpenInput } from "./Harness.ts";
import type {
  NativeHostBinding,
  NativeMcpConfiguration,
  NativeThreadLoad,
} from "./HarnessSessionHost.ts";
import {
  claudeNativeLoadKey,
  claudeNativeSettingsKey,
  matchesRequestedClaudeThread,
  requestedClaudeThread,
  sameClaudeThread,
  toClaudeMcpServers,
} from "./ClaudeNativeHostBindingSupport.ts";
import { mcpAborted } from "./host/mcp.ts";

type NativeRuntime = ProviderAdapter.ProviderAdapterV2SessionRuntime;
type McpRoute = {
  readonly origin: string;
  readonly fetch: (request: Request) => Promise<Response>;
};
type PreparedThread = {
  readonly epoch: number;
  readonly signal: AbortSignal;
  readonly servers: ClaudeAgentSdkMcpServers;
  readonly key: string;
  readonly settings: string;
  readonly thread: OrchestrationV2ProviderThread;
  initialRead: boolean;
  handoffUsed: boolean;
  started: boolean;
};

export interface ClaudeNativeHostBindingOptions extends Omit<
  ClaudeIsolateAdapterOptions,
  "adapter" | "nativeMcp"
> {
  readonly adapter: Omit<ClaudeAdapterV2Options, "queryRunner" | "environment" | "initialSnapshot">;
  readonly mcp: McpRoute;
}

/** Bind canonical MCP access to one real Claude SDK query and its owned Node process. */
export function makeClaudeNativeHostBinding(
  options: ClaudeNativeHostBindingOptions,
): NativeHostBinding {
  const { mcp, ...isolateInput } = options;
  let opened = false;
  let native: NativeRuntime | undefined;
  let harness: HarnessOpenInput | undefined;
  let query: ClaudeAgentSdkQuerySession | undefined;
  let installation: PreparedThread | undefined;
  let initialMcpRead = false;
  let startedAnyTurn = false;
  let configuring = false;
  let lastEpoch = 0;

  const unavailable = (cause?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CLAUDE_PROVIDER,
      detail: "Claude thread does not match the installed MCP binding.",
      cause,
    });
  const nativeMcp = {
    resolveMcpServers: () =>
      Effect.try({
        try: () => {
          const current = installation;
          if (
            current === undefined ||
            current.initialRead ||
            current.signal.aborted ||
            initialMcpRead
          )
            throw new Error("Claude MCP map is unavailable for the first native query.");
          current.initialRead = true;
          initialMcpRead = true;
          return { servers: current.servers, signal: current.signal };
        },
        catch: (cause) => queryRunnerError(cause, "setMcpServers"),
      }),
    opened: (session: ClaudeAgentSdkQuerySession) => {
      if (installation === undefined || !installation.initialRead || query !== undefined)
        throw new Error("Claude native query session ownership conflicts.");
      query = session;
    },
    closed: (session: ClaudeAgentSdkQuerySession) => {
      if (query === session) query = undefined;
    },
  };
  const isolate = makeClaudeIsolateAdapter({ ...isolateInput, nativeMcp });

  const handoff = (load: NativeThreadLoad) =>
    Effect.gen(function* () {
      const ready = installation;
      const key = yield* Effect.try({ try: () => claudeNativeLoadKey(load), catch: unavailable });
      if (ready === undefined || ready.signal.aborted || ready.handoffUsed || key !== ready.key)
        return yield* Effect.fail(unavailable());
      ready.handoffUsed = true;
      return ready.thread;
    });

  const configure = (
    configuration: NativeMcpConfiguration,
    signal: AbortSignal,
    load: NativeThreadLoad,
  ) =>
    Effect.gen(function* () {
      const runtime = native;
      const input = harness;
      if (runtime === undefined || input === undefined || signal.aborted)
        return yield* Effect.fail(
          new HarnessError({
            operation: "turn",
            message: "Claude MCP installation is unavailable.",
          }),
        );
      if (!Number.isSafeInteger(configuration.epoch) || configuration.epoch <= lastEpoch)
        return yield* Effect.fail(
          new HarnessError({ operation: "turn", message: "Claude MCP epoch is invalid." }),
        );

      const requested = requestedClaudeThread(load);
      if (
        (load.input.threadId ?? requested?.appThreadId) !== input.session.threadId ||
        (load.method === "ensureThread" &&
          load.input.providerSessionId !== undefined &&
          load.input.providerSessionId !== input.session.providerSessionId) ||
        (requested !== undefined &&
          (requested.appThreadId !== input.session.threadId ||
            requested.providerSessionId !== input.session.providerSessionId ||
            requested.providerInstanceId !== runtime.instanceId ||
            requested.driver !== CLAUDE_PROVIDER)) ||
        (input.checkpoint !== undefined &&
          (load.method !== "resumeThread" ||
            requested?.id !== input.checkpoint.snapshot.providerThread.id ||
            requested?.nativeThreadRef?.nativeId !==
              input.checkpoint.snapshot.providerThread.nativeThreadRef?.nativeId))
      )
        return yield* Effect.fail(
          new HarnessError({
            operation: "turn",
            message: "Claude native setup belongs to another thread.",
          }),
        );

      const { key, settings, servers, thread } = yield* Effect.try({
        try: () => ({
          key: claudeNativeLoadKey(load),
          settings: claudeNativeSettingsKey(load.input.modelSelection, load.input.runtimePolicy),
          servers: toClaudeMcpServers(configuration, mcp.origin),
        }),
        catch: (cause) =>
          new HarnessError({
            operation: "turn",
            message: "Claude native setup is invalid.",
            cause,
          }),
      }).pipe(
        Effect.flatMap((validated) =>
          (load.method === "ensureThread"
            ? runtime.ensureThread(load.input)
            : runtime.resumeThread(load.input)
          ).pipe(
            Effect.mapError(
              (cause) =>
                new HarnessError({
                  operation: "turn",
                  message: "Claude native thread load failed.",
                  cause,
                }),
            ),
            Effect.raceFirst(mcpAborted(signal)),
            Effect.map((thread) => ({ ...validated, thread })),
          ),
        ),
      );
      if (
        signal.aborted ||
        thread.driver !== CLAUDE_PROVIDER ||
        thread.appThreadId !== input.session.threadId ||
        thread.providerSessionId !== input.session.providerSessionId ||
        thread.providerInstanceId !== runtime.instanceId ||
        thread.nativeThreadRef?.strength !== "strong" ||
        (requested !== undefined && !matchesRequestedClaudeThread(thread, requested))
      )
        return yield* Effect.fail(
          new HarnessError({
            operation: "turn",
            message: "Claude native setup did not preserve the thread identity.",
          }),
        );

      const prepared: PreparedThread = {
        epoch: configuration.epoch,
        signal,
        servers,
        key,
        settings,
        thread,
        initialRead: false,
        handoffUsed: false,
        started: false,
      };
      const retainedQuery = query;
      if (retainedQuery !== undefined) {
        if (retainedQuery.configureMcp === undefined)
          return yield* Effect.fail(
            new HarnessError({
              operation: "turn",
              message: "Claude native MCP control is unavailable.",
            }),
          );
        yield* retainedQuery.configureMcp(servers, signal).pipe(
          Effect.mapError(
            (cause) =>
              new HarnessError({
                operation: "turn",
                message: "Claude native MCP installation failed.",
                cause,
              }),
          ),
          Effect.raceFirst(mcpAborted(signal)),
        );
      } else if (initialMcpRead) {
        return yield* Effect.fail(
          new HarnessError({
            operation: "turn",
            message: "Claude native query closed before its next MCP installation.",
          }),
        );
      }
      installation = prepared;
      lastEpoch = configuration.epoch;
    });

  const baseFactory = {
    open: (input: HarnessOpenInput) =>
      Effect.suspend(() => {
        if (opened)
          return Effect.fail(
            new HarnessError({
              operation: "open",
              message: "This Claude binding already owns a native session.",
            }),
          );
        opened = true;
        harness = input;
        const routedInput = {
          ...input,
          modelTransport: (request: Request) =>
            new URL(request.url).origin === mcp.origin
              ? mcp.fetch(request)
              : input.modelTransport(request),
        };
        return isolate.open(routedInput).pipe(
          Effect.map((runtime): NativeRuntime => {
            native = runtime;
            return {
              ...runtime,
              get providerSession() {
                return runtime.providerSession;
              },
              ensureThread: (threadInput) =>
                handoff({ method: "ensureThread", input: threadInput }),
              resumeThread: (threadInput) =>
                handoff({ method: "resumeThread", input: threadInput }),
              startTurn: (turnInput) =>
                Effect.gen(function* () {
                  const ready = installation;
                  const settings = yield* Effect.try({
                    try: () =>
                      claudeNativeSettingsKey(turnInput.modelSelection, turnInput.runtimePolicy),
                    catch: unavailable,
                  });
                  if (
                    ready === undefined ||
                    ready.signal.aborted ||
                    ready.started ||
                    settings !== ready.settings ||
                    !sameClaudeThread(turnInput.providerThread, ready.thread) ||
                    turnInput.threadId !== input.session.threadId ||
                    turnInput.appThread.id !== turnInput.threadId ||
                    (!startedAnyTurn && input.checkpoint === undefined && !ready.handoffUsed)
                  )
                    return yield* Effect.fail(unavailable());
                  ready.started = true;
                  startedAnyTurn = true;
                  return yield* runtime.startTurn(turnInput);
                }),
            };
          }),
        );
      }),
  };

  return {
    factory: baseFactory,
    configureMcp: (configuration, signal, load) =>
      Effect.suspend(() => {
        if (configuring)
          return Effect.fail(
            new HarnessError({
              operation: "turn",
              message: "Claude MCP configuration is already in progress.",
            }),
          );
        configuring = true;
        return configure(configuration, signal, load).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              configuring = false;
            }),
          ),
        );
      }),
  };
}
