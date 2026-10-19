import type {
  Query as ClaudeQuery,
  ForkSessionOptions,
  ForkSessionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  ClaudeAgentSdkQueryRunner,
  ClaudeAgentSdkQueryRunnerError,
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

function closeClaudeQuery(queryRuntime: ClaudeSdkQuery) {
  return Effect.try({
    try: () => queryRuntime.close(),
    catch: (cause) => queryRunnerError(cause, "close"),
  });
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
      const { mcpServers, ...queryOptions } = input.options;
      const prepared =
        options.prepareQuery === undefined
          ? queryOptions
          : yield* options.prepareQuery(queryOptions, input);
      const queryRuntime = yield* Effect.uninterruptibleMask((restore) =>
        options.query({ prompt, options: prepared }, input).pipe(
          Effect.tap((queryRuntime) =>
            restore(
              Effect.gen(function* () {
                if (mcpServers !== undefined) {
                  // Error texts and the CLI's mcp_status response can echo the headers, so
                  // only server names are logged.
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
                yield* logProtocolEvent({
                  direction: "outgoing",
                  stage: "decoded",
                  payload: {
                    type: "query.open",
                    options: loggedClaudeQueryOptions(input.options),
                  },
                });
              }),
            ).pipe(
              Effect.onError(() =>
                Queue.shutdown(promptQueue).pipe(
                  Effect.andThen(closeClaudeQuery(queryRuntime)),
                  Effect.ignore,
                ),
              ),
            ),
          ),
        ),
      );

      return {
        messages: Stream.fromAsyncIterable(claudeQueryMessages(queryRuntime), (cause) =>
          queryRunnerError(cause, "fromAsyncIterable"),
        ).pipe(
          Stream.tap((message) =>
            logProtocolEvent({
              direction: "incoming",
              stage: "decoded",
              payload: message,
            }),
          ),
        ),
        offer: (message) =>
          Queue.offer(promptQueue, message).pipe(
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
        close: Queue.shutdown(promptQueue).pipe(
          Effect.andThen(closeClaudeQuery(queryRuntime)),
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
