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
  | "buffered-assistant"
  | "buffered-result";

const frameIds: ReadonlyArray<ProcessedFrame> = [
  "task-started",
  "initial-result",
  "task-notification",
  "buffered-assistant",
  "buffered-result",
];

/** Controls only the SDK frame order; the product host and Claude adapter remain real. */
export function continuationNativeFixture(nativeId: string, identity: SystemIdentity) {
  const native = nativeFixture(nativeId, identity);
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
        let pending: ProcessedFrame | undefined;

        const acknowledgePrevious = () => {
          if (pending === undefined) return;
          processed.get(pending)!.resolve();
          pending = undefined;
        };
        const deliver = (id: ProcessedFrame, value: Message) => {
          pending = id;
          return { done: false as const, value };
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
            return deliver("task-started", taskStarted);
          }
          if (phase === 1) {
            phase = 2;
            return deliver("initial-result", initialResult!);
          }
          if (phase === 2) {
            phase = 3;
            await releaseWake.promise;
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
  };
}
