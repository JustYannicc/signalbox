import { logProviderEventLatency } from "@t3tools/provider-core/server/ProviderEventLatencyTrace";
import type {
  Query as ClaudeQuery,
  ForkSessionOptions,
  ForkSessionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as LogLevel from "effect/LogLevel";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { createClaudeSdkStreamId, recordClaudeSdkYield } from "./ClaudeEventLatencyTrace.ts";
import {
  ClaudeAgentSdkQueryRunner,
  ClaudeAgentSdkQueryRunnerError,
  type ClaudeAgentSdkMcpServers,
  type ClaudeAgentSdkQueryOpenInput,
  type ClaudeAgentSdkQuerySession,
  type ClaudeAgentSdkSessionForkInput,
  type ClaudeAgentSdkSubagentLookupInput,
} from "./ClaudeQueryRunner.ts";
import {
  loggedClaudeQueryOptions,
  type ClaudeAgentSdkProtocolLogEvent,
  type ClaudeAgentSdkProtocolLogger,
} from "./ClaudeQueryProtocol.ts";

export type ClaudeSdkQuery = Pick<
  ClaudeQuery,
  | "next"
  | "return"
  | "throw"
  | "close"
  | "setMcpServers"
  | "setModel"
  | "applyFlagSettings"
  | "setPermissionMode"
  | "stopTask"
  | "backgroundTasks"
  | "interrupt"
>;

type ClaudeSdkLaunchOptions = Omit<ClaudeAgentSdkQueryOpenInput["options"], "mcpServers">;

export interface ClaudeSdkQueryRunnerOptions {
  /** Opt in to fail-closed initial MCP registration for native host bindings. */
  readonly requireMcpServerRegistration?: boolean;
  /** Replace provider-derived servers at the native Query.open boundary. */
  readonly resolveMcpServers?: (
    input: ClaudeAgentSdkQueryOpenInput,
  ) => Effect.Effect<
    { readonly servers: ClaudeAgentSdkMcpServers; readonly signal: AbortSignal },
    ClaudeAgentSdkQueryRunnerError
  >;
  /** The native host retains the real Query session for later MCP epochs. */
  readonly onQuerySessionOpened?: (session: ClaudeAgentSdkQuerySession) => void;
  readonly onQuerySessionClosed?: (session: ClaudeAgentSdkQuerySession) => void;
  readonly prepareQuery?: (
    options: ClaudeSdkLaunchOptions,
    input: ClaudeAgentSdkQueryOpenInput,
  ) => Effect.Effect<ClaudeSdkLaunchOptions, ClaudeAgentSdkQueryRunnerError>;
  readonly allocateSessionId: Effect.Effect<string, ClaudeAgentSdkQueryRunnerError>;
  readonly query: (
    query: {
      readonly prompt: AsyncIterable<SDKUserMessage>;
      readonly options: ClaudeSdkLaunchOptions;
    },
    input: ClaudeAgentSdkQueryOpenInput,
  ) => Effect.Effect<ClaudeSdkQuery, ClaudeAgentSdkQueryRunnerError>;
  readonly forkSession: (
    sessionId: string,
    options: ForkSessionOptions,
  ) => Promise<ForkSessionResult>;
  readonly subagentLaunchToolUseId: (
    input: ClaudeAgentSdkSubagentLookupInput,
  ) => Promise<string | null>;
  readonly protocolLogger?: (
    input: Pick<ClaudeAgentSdkQueryOpenInput, "threadId" | "providerSessionId">,
  ) => ClaudeAgentSdkProtocolLogger | undefined;
}

// The SDK has no control deadline. Each MCP server can take 30 seconds to connect.
const CLAUDE_MCP_REGISTRATION_TIMEOUT = "90 seconds";

const isClaudeAgentSdkQueryRunnerError = Schema.is(ClaudeAgentSdkQueryRunnerError);
export function queryRunnerError(cause: unknown, method: string): ClaudeAgentSdkQueryRunnerError {
  return isClaudeAgentSdkQueryRunnerError(cause)
    ? cause
    : new ClaudeAgentSdkQueryRunnerError({ cause, method });
}

const mcpSignalAborted = (signal: AbortSignal) =>
  Effect.callback<never, ClaudeAgentSdkQueryRunnerError>((resume) => {
    const abort = () =>
      resume(
        Effect.fail(
          queryRunnerError(
            signal.reason ?? new Error("Claude MCP setup aborted."),
            "setMcpServers",
          ),
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });

function closeClaudeQuery(queryRuntime: ClaudeSdkQuery) {
  return Effect.try({
    try: () => queryRuntime.close(),
    catch: (cause) => queryRunnerError(cause, "close"),
  });
}

function installMcpServers(
  queryRuntime: ClaudeSdkQuery,
  servers: ClaudeAgentSdkMcpServers,
  signal?: AbortSignal,
) {
  return Effect.tryPromise({
    try: async () => {
      signal?.throwIfAborted();
      const installation = queryRuntime.setMcpServers(servers);
      const result =
        signal === undefined
          ? await installation
          : await new Promise<Awaited<typeof installation>>((resolve, reject) => {
              const abort = () =>
                reject(signal.reason ?? new DOMException("MCP setup aborted", "AbortError"));
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
              void installation.then(resolve, reject).finally(() => {
                signal.removeEventListener("abort", abort);
              });
            });
      signal?.throwIfAborted();
      const failed = Object.keys(result.errors);
      if (failed.length > 0) {
        throw new Error(`Claude Code rejected MCP servers: ${failed.join(", ")}`, {
          cause: result.errors,
        });
      }
    },
    catch: (cause) => queryRunnerError(cause, "setMcpServers"),
  }).pipe(
    Effect.timeoutOrElse({
      duration: CLAUDE_MCP_REGISTRATION_TIMEOUT,
      orElse: () =>
        Effect.fail(
          queryRunnerError(
            "Claude Code did not answer the MCP server registration.",
            "setMcpServers",
          ),
        ),
    }),
  );
}

// Iterate the Query itself, not query[Symbol.asyncIterator]() (the raw
// sdkMessages generator). The raw generator's return() queues behind the
// in-flight read of the next CLI message and never settles while the CLI is
// idle, deadlocking stream interruption (and with it, session scope close).
export function claudeQueryMessages(queryRuntime: ClaudeSdkQuery): AsyncIterable<SDKMessage, void> {
  return { [Symbol.asyncIterator]: () => queryRuntime };
}

export function makeClaudeAgentSdkQueryRunner(options: ClaudeSdkQueryRunnerOptions) {
  return ClaudeAgentSdkQueryRunner.of({
    allocateSessionId: options.allocateSessionId,
    open: Effect.fn("ClaudeAgentSdkQueryRunner.open")(function* (
      input: ClaudeAgentSdkQueryOpenInput,
    ) {
      const protocolLogger = options.protocolLogger?.(input);
      const logProtocolEvent = (event: ClaudeAgentSdkProtocolLogEvent) =>
        protocolLogger === undefined ? Effect.void : protocolLogger(event);
      const eventLatencyTracingEnabled = yield* LogLevel.isEnabled("Debug");
      const sdkStreamId = eventLatencyTracingEnabled
        ? createClaudeSdkStreamId(input.providerSessionId)
        : undefined;
      let sdkStreamOrdinal = 0;
      const { mcpServers: providerMcpServers, ...queryOptions } = input.options;
      const nativeMcp =
        options.resolveMcpServers === undefined
          ? undefined
          : yield* options.resolveMcpServers(input);
      const mcpServers = nativeMcp?.servers ?? providerMcpServers;
      const mcpSignal = nativeMcp?.signal;
      if (mcpSignal?.aborted)
        return yield* Effect.fail(
          queryRunnerError(
            mcpSignal.reason ?? new Error("Claude MCP setup aborted."),
            "setMcpServers",
          ),
        );
      if (options.requireMcpServerRegistration === true && mcpServers === undefined) {
        return yield* Effect.fail(
          queryRunnerError("Claude MCP configuration was not supplied.", "setMcpServers"),
        );
      }
      const prepared =
        options.prepareQuery === undefined
          ? queryOptions
          : yield* options.prepareQuery(queryOptions, input);
      const promptQueue = yield* Queue.unbounded<SDKUserMessage>();
      const prompt = Stream.fromQueue(promptQueue).pipe(
        Stream.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
        ),
        Stream.toAsyncIterable,
      );
      // The SDK would pass `mcpServers` as an inline `--mcp-config` argument,
      // which every local user can read. They go over the CLI's stdin control
      // channel instead, so header credentials stay out of its argv and out
      // of the environment every command the agent runs inherits.
      let mcpConfigured = options.requireMcpServerRegistration !== true;
      let mcpConfigurationInFlight = false;
      let mcpFailed = false;
      let queryClosing = false;
      let queryClosed = false;
      let openedQuery: ClaudeSdkQuery | undefined;
      const cleanupOpenedQuery = () =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const queueExit = yield* Effect.exit(Queue.shutdown(promptQueue));
            const queryExit =
              openedQuery === undefined
                ? Exit.void
                : yield* Effect.exit(closeClaudeQuery(openedQuery));
            let cleanupCause: Cause.Cause<ClaudeAgentSdkQueryRunnerError> | undefined;
            if (Exit.isFailure(queueExit)) cleanupCause = queueExit.cause;
            if (Exit.isFailure(queryExit))
              cleanupCause =
                cleanupCause === undefined
                  ? queryExit.cause
                  : Cause.combine(cleanupCause, queryExit.cause);
            if (cleanupCause !== undefined) return yield* Effect.failCause(cleanupCause);
          }),
        );
      const queryOpen = Effect.uninterruptibleMask((restore) =>
        // A cancelled acquisition must still hand its Query to cleanup before open returns.
        options.query({ prompt, options: prepared }, input).pipe(
          Effect.tap((queryRuntime) =>
            Effect.sync(() => {
              openedQuery = queryRuntime;
            }),
          ),
          Effect.tap((queryRuntime) =>
            restore(
              Effect.gen(function* () {
                if (mcpServers !== undefined) {
                  if (options.requireMcpServerRegistration === true) {
                    yield* installMcpServers(queryRuntime, mcpServers, mcpSignal);
                    mcpConfigured = true;
                  } else {
                    // Default provider sessions keep their established warning-only policy.
                    // Error texts and mcp_status can echo headers, so only server names are logged.
                    const failed = yield* Effect.tryPromise(() =>
                      queryRuntime.setMcpServers(mcpServers),
                    ).pipe(
                      Effect.map((result) => Object.keys(result.errors)),
                      Effect.orElseSucceed(() => Object.keys(mcpServers)),
                      Effect.timeoutOrElse({
                        duration: CLAUDE_MCP_REGISTRATION_TIMEOUT,
                        orElse: () =>
                          Effect.fail(
                            queryRunnerError(
                              "Claude Code did not answer the MCP server registration.",
                              "setMcpServers",
                            ),
                          ),
                      }),
                    );
                    if (failed.length > 0) {
                      yield* Effect.logWarning("orchestration-v2.claude-mcp-servers-unavailable", {
                        threadId: input.threadId,
                        servers: failed,
                      });
                    }
                  }
                }
                yield* logProtocolEvent({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: {
                    type: "query.open",
                    options: loggedClaudeQueryOptions(input.options),
                  },
                });
              }),
            ),
          ),
        ),
      );
      const closeAfterOpenFailure = (cause: Cause.Cause<ClaudeAgentSdkQueryRunnerError>) =>
        cleanupOpenedQuery().pipe(
          Effect.exit,
          Effect.flatMap((cleanup) =>
            Effect.failCause(Exit.isFailure(cleanup) ? Cause.combine(cause, cleanup.cause) : cause),
          ),
        );
      const queryRuntime = yield* (
        mcpSignal === undefined
          ? queryOpen
          : queryOpen.pipe(Effect.raceFirst(mcpSignalAborted(mcpSignal)))
      ).pipe(Effect.catchCause(closeAfterOpenFailure));
      const mcpLock = yield* Semaphore.make(1);
      let session: ClaudeAgentSdkQuerySession | undefined;
      const closeQuery = () =>
        Effect.suspend(() => {
          queryClosing = true;
          return mcpLock.withPermits(1)(
            Effect.suspend(() => {
              if (queryClosed) return Effect.void;
              return Effect.gen(function* () {
                const closeExit = yield* Effect.exit(closeClaudeQuery(queryRuntime));
                queryClosed = true;
                const releaseExit = yield* Effect.exit(
                  Effect.try({
                    try: () => {
                      if (session !== undefined) options.onQuerySessionClosed?.(session);
                    },
                    catch: (cause) => queryRunnerError(cause, "onQuerySessionClosed"),
                  }),
                );
                if (Exit.isFailure(closeExit) && Exit.isFailure(releaseExit))
                  return yield* Effect.failCause(Cause.combine(closeExit.cause, releaseExit.cause));
                if (Exit.isFailure(closeExit)) return yield* Effect.failCause(closeExit.cause);
                if (Exit.isFailure(releaseExit)) return yield* Effect.failCause(releaseExit.cause);
              });
            }),
          );
        });
      const closeSessionResources = () =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            queryClosing = true;
            const queueExit = yield* Effect.exit(Queue.shutdown(promptQueue));
            const queryExit = yield* Effect.exit(closeQuery());
            let cleanupCause: Cause.Cause<ClaudeAgentSdkQueryRunnerError> | undefined;
            if (Exit.isFailure(queueExit)) cleanupCause = queueExit.cause;
            if (Exit.isFailure(queryExit))
              cleanupCause =
                cleanupCause === undefined
                  ? queryExit.cause
                  : Cause.combine(cleanupCause, queryExit.cause);
            if (cleanupCause !== undefined) return yield* Effect.failCause(cleanupCause);
          }),
        );

      session = {
        messages: Stream.fromAsyncIterable(claudeQueryMessages(queryRuntime), (cause) =>
          queryRunnerError(cause, "fromAsyncIterable"),
        ).pipe(
          Stream.tap((message) =>
            Effect.gen(function* () {
              if (sdkStreamId !== undefined) {
                const trace = yield* Effect.sync(() =>
                  recordClaudeSdkYield(message, sdkStreamId, ++sdkStreamOrdinal),
                );
                const { yieldedAtMs, ...fields } = trace;
                yield* logProviderEventLatency("sdk.yield", fields, yieldedAtMs);
              }
              yield* logProtocolEvent({
                direction: "incoming",
                stage: "decoded",
                payload: message,
              });
            }),
          ),
        ),
        offer: (message) =>
          Effect.suspend(() =>
            queryClosing || queryClosed || mcpFailed
              ? Effect.fail(queryRunnerError("Claude query is closed or failed.", "offer"))
              : mcpConfigurationInFlight || !mcpConfigured
                ? Effect.fail(
                    queryRunnerError(
                      "Claude MCP configuration must precede prompts.",
                      "setMcpServers",
                    ),
                  )
                : Queue.offer(promptQueue, message).pipe(
                    Effect.asVoid,
                    Effect.tap(() =>
                      logProtocolEvent({
                        direction: "outgoing",
                        stage: "decoded",
                        payload: {
                          type: "prompt.offer",
                          message,
                        },
                      }),
                    ),
                  ),
          ),
        configureMcp: (servers, signal) =>
          Effect.suspend(() => {
            if (queryClosing || queryClosed || mcpFailed)
              return Effect.fail(
                queryRunnerError("Claude query is closed or failed.", "setMcpServers"),
              );
            if (mcpConfigurationInFlight) {
              mcpFailed = true;
              mcpConfigured = false;
              return Effect.fail(
                queryRunnerError(
                  "Claude MCP configuration is already in progress.",
                  "setMcpServers",
                ),
              );
            }
            mcpConfigurationInFlight = true;
            mcpConfigured = false;
            return Effect.uninterruptibleMask((restore) =>
              mcpLock
                .withPermits(1)(
                  restore(installMcpServers(queryRuntime, servers, signal)).pipe(
                    Effect.andThen(
                      Effect.suspend(() =>
                        mcpFailed
                          ? Effect.fail(
                              queryRunnerError(
                                "Concurrent Claude MCP configuration failed.",
                                "setMcpServers",
                              ),
                            )
                          : Effect.sync(() => {
                              mcpConfigured = true;
                            }),
                      ),
                    ),
                  ),
                )
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.sync(() => {
                      mcpFailed = true;
                      mcpConfigured = false;
                    }).pipe(
                      Effect.andThen(
                        closeSessionResources().pipe(
                          Effect.exit,
                          Effect.flatMap((cleanup) =>
                            Effect.failCause(
                              Exit.isFailure(cleanup) ? Cause.combine(cause, cleanup.cause) : cause,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                  Effect.ensuring(
                    Effect.sync(() => {
                      mcpConfigurationInFlight = false;
                    }),
                  ),
                ),
            );
          }),
        setModel: (model) =>
          Effect.tryPromise({
            try: () => queryRuntime.setModel(model),
            catch: (cause) => queryRunnerError(cause, "setModel"),
          }).pipe(
            Effect.tap(() =>
              logProtocolEvent({
                direction: "outgoing",
                stage: "decoded",
                payload: {
                  type: "query.set_model",
                  model,
                },
              }),
            ),
          ),
        applyFlagSettings: (settings) =>
          Effect.tryPromise({
            try: () => queryRuntime.applyFlagSettings(settings),
            catch: (cause) => queryRunnerError(cause, "applyFlagSettings"),
          }).pipe(
            Effect.tap(() =>
              logProtocolEvent({
                direction: "outgoing",
                stage: "decoded",
                payload: {
                  type: "query.apply_flag_settings",
                  settings,
                },
              }),
            ),
          ),
        setPermissionMode: (mode) =>
          Effect.tryPromise({
            try: () => queryRuntime.setPermissionMode(mode),
            catch: (cause) => queryRunnerError(cause, "setPermissionMode"),
          }).pipe(
            Effect.tap(() =>
              logProtocolEvent({
                direction: "outgoing",
                stage: "decoded",
                payload: {
                  type: "query.set_permission_mode",
                  mode,
                },
              }),
            ),
          ),
        stopTask: (taskId) =>
          Effect.tryPromise({
            try: () => queryRuntime.stopTask(taskId),
            catch: (cause) => queryRunnerError(cause, "stopTask"),
          }).pipe(
            Effect.tap(() =>
              logProtocolEvent({
                direction: "outgoing",
                stage: "decoded",
                payload: { type: "query.stop_task", taskId },
              }),
            ),
          ),
        backgroundTasks: (toolUseId) =>
          Effect.tryPromise({
            try: () => queryRuntime.backgroundTasks(toolUseId),
            catch: (cause) => queryRunnerError(cause, "backgroundTasks"),
          }).pipe(
            Effect.tap(() =>
              logProtocolEvent({
                direction: "outgoing",
                stage: "decoded",
                payload: { type: "query.background_tasks", toolUseId },
              }),
            ),
          ),
        interrupt: Effect.tryPromise({
          try: () => queryRuntime.interrupt(),
          catch: (cause) => queryRunnerError(cause, "interrupt"),
        }).pipe(
          Effect.tap(() =>
            logProtocolEvent({
              direction: "outgoing",
              stage: "decoded",
              payload: {
                type: "query.interrupt",
              },
            }),
          ),
        ),
        close: closeSessionResources().pipe(
          Effect.tap(() =>
            logProtocolEvent({
              direction: "outgoing",
              stage: "decoded",
              payload: {
                type: "query.close",
              },
            }),
          ),
        ),
      } satisfies ClaudeAgentSdkQuerySession;
      yield* Effect.try({
        try: () => options.onQuerySessionOpened?.(session),
        catch: (cause) => queryRunnerError(cause, "onQuerySessionOpened"),
      }).pipe(
        Effect.catchCause((cause) =>
          closeSessionResources().pipe(
            Effect.exit,
            Effect.flatMap((cleanup) =>
              Effect.failCause(
                Exit.isFailure(cleanup) ? Cause.combine(cause, cleanup.cause) : cause,
              ),
            ),
          ),
        ),
      );
      return session;
    }),
    forkSession: Effect.fn("ClaudeAgentSdkQueryRunner.forkSession")(function* (
      input: ClaudeAgentSdkSessionForkInput,
    ) {
      const protocolLogger = options.protocolLogger?.(input);
      const logProtocolEvent = (event: ClaudeAgentSdkProtocolLogEvent) =>
        protocolLogger === undefined ? Effect.void : protocolLogger(event);
      yield* logProtocolEvent({
        direction: "outgoing",
        stage: "decoded",
        payload: {
          type: "session.fork",
          sessionId: input.sessionId,
          options: input.options,
        },
      });
      const result = yield* Effect.tryPromise({
        try: () => options.forkSession(input.sessionId, input.options),
        catch: (cause) => queryRunnerError(cause, "forkSession"),
      });
      yield* logProtocolEvent({
        direction: "incoming",
        stage: "decoded",
        payload: {
          type: "session.forked",
          sessionId: result.sessionId,
        },
      });
      return result;
    }),
    subagentLaunchToolUseId: Effect.fn("ClaudeAgentSdkQueryRunner.subagentLaunchToolUseId")(
      function* (input: ClaudeAgentSdkSubagentLookupInput) {
        const protocolLogger = options.protocolLogger?.(input);
        const logProtocolEvent = (event: ClaudeAgentSdkProtocolLogEvent) =>
          protocolLogger === undefined ? Effect.void : protocolLogger(event);
        yield* logProtocolEvent({
          direction: "outgoing",
          stage: "decoded",
          payload: {
            type: "subagent.lookup",
            sessionId: input.sessionId,
            agentId: input.agentId,
          },
        });
        const toolUseId = yield* Effect.tryPromise({
          try: () => options.subagentLaunchToolUseId(input),
          catch: (cause) => queryRunnerError(cause, "getSubagentMessages"),
        });
        yield* logProtocolEvent({
          direction: "incoming",
          stage: "decoded",
          payload: { type: "subagent.found", toolUseId },
        });
        return toolUseId;
      },
    ),
    assertComplete: Effect.void,
  });
}
