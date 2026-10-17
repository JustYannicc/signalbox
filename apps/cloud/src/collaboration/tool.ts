import { ThreadId, OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  COLLABORATION_TOOLS,
  type CollaborationTool,
} from "@t3tools/contracts/signalboxCollaboration";
import type { ToolResult } from "@signalbox/runner-protocol/AutomationProtocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { CloudCollaboration } from "./CloudCollaboration.ts";

export const isCollaborationTool = (name: string): name is CollaborationTool =>
  Object.hasOwn(COLLABORATION_TOOLS, name);

/** The source comes from the running thread's credential, never its tool arguments. */
export const collaborationTool = (threadId: string, name: CollaborationTool, input: unknown) =>
  Effect.gen(function* () {
    const available = yield* Effect.serviceOption(CloudCollaboration);
    if (Option.isNone(available))
      return yield* Effect.fail(
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Cloud thread collaboration is unavailable.",
        }),
      );
    const service = available.value;
    const source = ThreadId.make(threadId);
    const call = <S extends Schema.Top & { readonly DecodingServices: never }, A, E>(
      schema: S,
      run: (value: S["Type"]) => Effect.Effect<A, E>,
    ) => Schema.decodeUnknownEffect(schema)(input).pipe(Effect.flatMap(run));
    switch (name) {
      case "orchestrator_capabilities":
        return yield* call(COLLABORATION_TOOLS[name].input, (value) =>
          service.capabilities(source, value),
        );
      case "t3_thread_list":
        return yield* call(COLLABORATION_TOOLS[name].input, (value) => service.list(source, value));
      case "t3_thread_read":
        return yield* call(COLLABORATION_TOOLS[name].input, (value) => service.read(source, value));
      case "t3_thread_send":
        return yield* call(COLLABORATION_TOOLS[name].input, (value) => service.send(source, value));
      case "t3_thread_wait":
        return yield* call(COLLABORATION_TOOLS[name].input, (value) => service.wait(source, value));
      case "delegate_task":
        return yield* call(COLLABORATION_TOOLS[name].input, (value) =>
          service.delegate(source, value),
        );
      case "task_status":
        return yield* call(COLLABORATION_TOOLS[name].input, (value) =>
          service.status(source, value),
        );
      case "task_cancel":
        return yield* call(COLLABORATION_TOOLS[name].input, (value) =>
          service.cancel(source, value),
        );
      case "t3_thread_interrupt":
        return yield* call(COLLABORATION_TOOLS[name].input, (value) =>
          service.interrupt(source, value),
        );
    }
  }).pipe(
    Effect.map((result): ToolResult => ({ _tag: "ok", result })),
    Effect.catchTags({
      SchemaError: () =>
        Effect.succeed<ToolResult>({
          _tag: "failed",
          message: "Unreadable collaboration arguments.",
        }),
      OrchestratorMcpFailure: (error) =>
        Effect.succeed<ToolResult>({ _tag: "failed", message: error.message }),
    }),
  );
