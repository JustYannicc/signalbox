import type { SystemIdentity } from "@t3tools/contracts/systemIdentity";
import type { ClaudeSdkQuery } from "@signalbox/provider-claude/ClaudeSdkQueryRunner";
import type { PreparedClaudeSdk } from "../../ClaudeIsolateAdapter.ts";
import type { NodeBridge } from "../../../isolate/NodeBridge.ts";
import { nativeFixture } from "./native.ts";

type Message = Exclude<Awaited<ReturnType<ClaudeSdkQuery["next"]>>["value"], void>;
type ProcessedFrame =
  | "task-started"
  | "initial-result"
  | "task-notification"
  | "batch-user"
  | "buffered-assistant"
  | "buffered-result";

const frameIds: ReadonlyArray<ProcessedFrame> = [
  "task-started",
  "initial-result",
  "task-notification",
  "batch-user",
  "buffered-assistant",
  "buffered-result",
];

/** Controls only the SDK frame order; the product host and Claude adapter remain real. */
export function continuationNativeFixture(
  nativeId: string,
  identity: SystemIdentity,
  record?: (message: Message) => void,
  batch = false,
  opaque = false,
) {
  let selectedNativeId = nativeId;
  const native = nativeFixture(nativeId, identity, undefined, () => selectedNativeId);
  const releaseWake = Promise.withResolvers<void>();
  const processed = new Map(frameIds.map((id) => [id, Promise.withResolvers<void>()] as const));
  let userPromptCount = 0;
  const queryIdentities: string[] = [];

  const taskStarted = {
    type: "system",
    subtype: "task_started",
    task_id: "background-task-1",
    description: "Background lookup",
    task_type: "background_task",
    tool_use_id: "toolu_background_task_1",
    session_id: nativeId,
    uuid: "00000000-0000-4000-8000-000000000002",
  } satisfies Message;
  const taskNotification = {
    type: "system",
    subtype: "task_notification",
    task_id: "background-task-1",
    status: "completed",
    output_file: "/workspace/background-task.txt",
    summary: "Background lookup finished.",
    tool_use_id: "toolu_background_task_1",
    session_id: nativeId,
    uuid: "00000000-0000-4000-8000-000000000003",
  } satisfies Message;
  const batchUuid = "00000000-0000-4000-8000-000000000006";
  const batchTasks = [1, 2, 3].map((index) => ({
    taskId: `background-task-${index}`,
    callId: `toolu_background_task_${index}`,
  }));
  const batchBlocks = batchTasks.map(({ taskId, callId }, index) => ({
    type: "text" as const,
    text: `<system-reminder>\n<task-notification><task-id>${taskId}</task-id><tool-use-id>${callId}</tool-use-id><result>  Exact completion ${index + 1}.\r\n✓\n</result></task-notification>\n</system-reminder>`,
    ...(index === 2 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
  const bufferedAssistant = {
    type: "assistant",
    uuid: "00000000-0000-4000-8000-000000000004",
    session_id: nativeId,
    parent_tool_use_id: null,
    message: {
      id: "msg_buffered_background_result",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "Buffered background task result.", citations: null }],
      container: null,
      context_management: null,
      stop_details: null,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: "standard",
        inference_geo: "",
        iterations: [],
        speed: "standard",
      },
    },
  } satisfies Message;

  const loadSdk = async (bridge: NodeBridge, _signal: AbortSignal): Promise<PreparedClaudeSdk> => {
    const sdk = await native.loadSdk(bridge);
    return {
      ...sdk,
      query(input) {
        selectedNativeId = input.options.resume ?? input.options.sessionId ?? "";
        queryIdentities.push(input.options.resume ?? input.options.sessionId ?? "");
        const observedPrompt = (async function* () {
          for await (const message of input.prompt) {
            if (message.type === "user") userPromptCount++;
            yield message;
          }
        })();
        const query = sdk.query({ ...input, prompt: observedPrompt });
        const nextNativeMessage = query.next.bind(query);
        const idle = Promise.withResolvers<IteratorResult<Message, void>>();
        let phase = 0;
        let initialResult: Extract<Message, { type: "result"; subtype: "success" }> | undefined;
        const queued: Array<readonly [ProcessedFrame, Message]> = [];
        let pending: ProcessedFrame | undefined;

        const acknowledgePrevious = () => {
          if (pending === undefined) return;
          processed.get(pending)!.resolve();
          pending = undefined;
        };
        const deliver = (id: ProcessedFrame, value: Message) => {
          const frame = { ...value, session_id: selectedNativeId };
          record?.(frame);
          pending = id;
          return { done: false as const, value: frame };
        };
        const next = async (): Promise<IteratorResult<Message, void>> => {
          acknowledgePrevious();
          if (phase === 0) {
            const first = await nextNativeMessage();
            if (
              first.done ||
              first.value === undefined ||
              first.value.type !== "result" ||
              first.value.subtype !== "success"
            ) {
              throw new Error("Controlled Claude query expected its initial result frame");
            }
            initialResult = first.value;
            phase = 1;
            if (batch && opaque) {
              phase = 2;
              return deliver("initial-result", initialResult);
            }
            if (batch) {
              for (const [index, task] of batchTasks.entries())
                queued.push([
                  "task-started",
                  {
                    ...taskStarted,
                    ...(opaque ? { task_type: "local_bash" } : {}),
                    task_id: task.taskId,
                    tool_use_id: task.callId,
                    uuid: `00000000-0000-4000-8000-00000000001${index}`,
                  },
                ]);
              const firstStarted = queued.shift()!;
              return deliver(...firstStarted);
            }
            return deliver("task-started", taskStarted);
          }
          if (queued.length > 0) return deliver(...queued.shift()!);
          if (phase === 1) {
            phase = 2;
            return deliver("initial-result", initialResult!);
          }
          if (phase === 2) {
            phase = 3;
            await releaseWake.promise;
            if (batch) {
              if (opaque)
                for (const [index, task] of batchTasks.entries())
                  queued.push([
                    "task-started",
                    {
                      ...taskStarted,
                      task_type: "local_bash",
                      task_id: task.taskId,
                      tool_use_id: task.callId,
                      uuid: `00000000-0000-4000-8000-00000000001${index}`,
                    },
                  ]);
              for (const [index, task] of batchTasks.entries())
                queued.push([
                  "task-notification",
                  {
                    ...taskNotification,
                    task_id: task.taskId,
                    tool_use_id: task.callId,
                    uuid: `00000000-0000-4000-8000-00000000002${index}`,
                  },
                ]);
              queued.push([
                "batch-user",
                {
                  type: "user",
                  uuid: batchUuid,
                  session_id: selectedNativeId,
                  parent_tool_use_id: null,
                  message: { role: "user", content: batchBlocks },
                } satisfies Message,
              ]);
              return deliver(...queued.shift()!);
            }
            return deliver("task-notification", taskNotification);
          }
          if (phase === 3) {
            phase = 4;
            return deliver("buffered-assistant", bufferedAssistant);
          }
          if (phase === 4) {
            phase = 5;
            return deliver("buffered-result", {
              ...initialResult!,
              result: "Buffered background task result.",
              uuid: "00000000-0000-4000-8000-000000000005",
            } satisfies Message);
          }
          return idle.promise;
        };

        let controlled!: ClaudeSdkQuery;
        controlled = new Proxy(query, {
          get(target, property) {
            if (property === "next") return next;
            if (property === Symbol.asyncIterator) return () => controlled;
            const value: unknown = Reflect.get(target, property, target);
            if (
              (property === "return" || property === "throw" || property === "close") &&
              typeof value === "function"
            )
              return (...args: unknown[]) => {
                idle.resolve({ done: true, value: undefined });
                return Reflect.apply(value, target, args);
              };
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return controlled;
      },
    };
  };

  return {
    ...native,
    get sdkIdentity() {
      return native.sdkIdentity;
    },
    loadSdk,
    releaseWake() {
      releaseWake.resolve();
    },
    waitUntilProcessed(id: ProcessedFrame) {
      return processed.get(id)!.promise;
    },
    get userPromptCount() {
      return userPromptCount;
    },
    get queryIdentities() {
      return [...queryIdentities];
    },
    batchUuid,
    batchBlocks,
    batchCalls: batchTasks.map((task) => task.callId),
  };
}
