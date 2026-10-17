import { describe, expect, it } from "@effect/vitest";
import { COLLABORATION_TOOLS } from "@t3tools/contracts/signalboxCollaboration";
import * as Effect from "effect/Effect";

import { serve, TOKEN } from "./RunnerAutomationTools.testkit.ts";

describe("cloud collaboration MCP tools", () => {
  it.effect("declares the effects of sending, delegating and stopping work", () =>
    Effect.gen(function* () {
      const { mcp } = yield* serve({ threadId: "source" });
      const tools = (yield* mcp("tools/list", {})).result.tools as ReadonlyArray<{
        name: string;
        annotations?: {
          readOnlyHint?: boolean;
          destructiveHint?: boolean;
          openWorldHint?: boolean;
        };
      }>;
      for (const name of ["t3_thread_send", "delegate_task"])
        expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
        });
      for (const name of ["task_cancel", "t3_thread_interrupt"])
        expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
        });
    }).pipe(Effect.scoped),
  );

  it.effect(
    "exposes the collaboration tools and forwards the credential without accepting an actor",
    () =>
      Effect.gen(function* () {
        const { mcp, call, cloud } = yield* serve({ threadId: "source" });
        const tools = (yield* mcp("tools/list", {})).result.tools as ReadonlyArray<{
          name: string;
        }>;
        for (const name of Object.keys(COLLABORATION_TOOLS))
          expect(tools.some((tool) => tool.name === name)).toBe(true);
        cloud.answers.push({ _tag: "ok", result: { threads: [{ threadId: "target" }] } });
        const listed = yield* call("t3_thread_list", {});
        expect(listed.isError).toBeUndefined();
        expect(listed.content[0]?.text).toContain("target");
        cloud.answers.push({ _tag: "failed", message: "Thread not found." });
        expect(
          yield* call("t3_thread_send", { threadId: "private", message: "No access" }),
        ).toMatchObject({ isError: true, content: [{ text: "Thread not found." }] });
        expect(cloud.requests).toEqual([
          { name: "t3_thread_list", input: {}, bearer: `Bearer ${TOKEN}` },
          {
            name: "t3_thread_send",
            input: { threadId: "private", message: "No access" },
            bearer: `Bearer ${TOKEN}`,
          },
        ]);
      }).pipe(Effect.scoped),
  );
});
