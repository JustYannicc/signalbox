import type { ClaudeAgentSdkQueryOptions } from "@signalbox/provider-claude/ClaudeQueryRunner";
import type { ClaudeSdkQuery } from "@signalbox/provider-claude/ClaudeSdkQueryRunner";
import type { HarnessRuntimeReporter } from "../HarnessProcessLifetime.ts";

type Report = NonNullable<HarnessRuntimeReporter["turnMilestone"]>;

/** Observe the messages endpoint, excluding token counting and MCP setup traffic. */
export function observeClaudeModelTransport(
  transport: (request: Request) => Promise<Response>,
  report: Report,
) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/v1/messages"))
      return transport(request);
    request.signal.throwIfAborted();
    report("model-request-sent");
    const response = await transport(request);
    if (response.body === null) return response;
    const reader = response.body.getReader();
    let observed = false;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              return;
            }
            if (!observed && next.value.byteLength > 0) {
              observed = true;
              report("first-model-byte");
            }
            controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
          }
        },
        cancel: (reason) => reader.cancel(reason),
      },
      { highWaterMark: 0 },
    );
    const wrapped = new Response(body, response);
    Object.defineProperties(wrapped, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    return wrapped;
  };
}

/** Keep permission decisions and existing hook results owned by the original callbacks. */
export function observeClaudeQueryOptions<
  O extends Pick<ClaudeAgentSdkQueryOptions, "hooks" | "canUseTool">,
>(options: O, report: Report) {
  const before: NonNullable<
    NonNullable<ClaudeAgentSdkQueryOptions["hooks"]>["PreToolUse"]
  >[number] = {
    hooks: [
      async () => {
        report("pre-tool-gate-entered");
        return {};
      },
    ],
  };
  const after: typeof before = {
    hooks: [
      async (input) => {
        // A short call may finish before the SDK's execution heartbeat.
        if (
          input.hook_event_name === "PostToolUse" ||
          (input.hook_event_name === "PostToolUseFailure" && input.duration_ms !== undefined)
        ) {
          report("tool-call-started");
          report("tool-call-ended");
        }
        return {};
      },
    ],
  };
  const canUseTool = options.canUseTool;
  return {
    ...options,
    hooks: {
      ...options.hooks,
      PreToolUse: [...(options.hooks?.PreToolUse ?? []), before],
      PostToolUse: [...(options.hooks?.PostToolUse ?? []), after],
      PostToolUseFailure: [...(options.hooks?.PostToolUseFailure ?? []), after],
    },
    ...(canUseTool === undefined
      ? {}
      : {
          canUseTool: async (...args: Parameters<typeof canUseTool>) => {
            report("tool-permission-requested");
            const result = await canUseTool(...args);
            report("tool-permission-resolved");
            return result;
          },
        }),
  };
}

/** SDK execution progress is emitted after dispatch; pre-tool and permission hooks are earlier. */
export function observeClaudeSdkMessage(
  message: Exclude<Awaited<ReturnType<ClaudeSdkQuery["next"]>>["value"], void>,
  report: Report,
) {
  if (message.type === "tool_progress") report("tool-call-started");
}
