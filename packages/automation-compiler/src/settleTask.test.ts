import { describe, expect, it } from "vite-plus/test";

import { SETTLE_TASK } from "@signalbox/automations/defaults/settleTask";
import { compileWorkflow } from "./compileWorkflow.ts";

const compiled = compileWorkflow(SETTLE_TASK);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics, null, 2));
const workerModule = compiled.workflow.workerModule!;

type Receiver = Record<string, (...args: Array<unknown>) => unknown>;
type Body = (w: Receiver, input: unknown) => Promise<unknown>;

async function loadBody(): Promise<Body> {
  const module = await import(
    /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(workerModule)}`
  );
  return module.load((body: Body) => body) as Body;
}

function fixture(
  options: {
    readonly reason?: "dropped" | "done-enough";
    readonly answer?: "dropped" | "done-enough";
    readonly uncertain?: boolean;
    readonly staleAfterRead?: boolean;
    readonly alreadyRecorded?: boolean;
    readonly malformedGuess?: boolean;
  } = {},
) {
  let generation = 4;
  let settled = true;
  let outcome: string | null = options.alreadyRecorded ? "Merged and released." : null;
  let recordReason: string | null = null;
  let llmCalls = 0;
  const calls: Array<{ action: string; args: Record<string, unknown> }> = [];
  const asks: Array<Record<string, unknown>> = [];
  const agents: Array<Record<string, unknown>> = [];
  let reads = 0;

  const response = () => ({
    kind: "task",
    thread: {
      id: "thread-1",
      title: "Finish the task",
      settledAt: settled ? "2026-10-17T09:00:00.000Z" : null,
      settledOverride: settled ? "settled" : null,
      archivedAt: null,
    },
    messages: [{ role: "user", text: "This is useful; please polish it." }],
    runs: [],
    record: {
      generation,
      outcome,
      reason: recordReason,
      condition: { summary: "The PR is merged and live" },
    },
    applied: false,
  });
  const w = {
    $arm: () => {},
    call: async (...args: Array<unknown>) => {
      const operationIndex = args.indexOf("signalbox.task_lifecycle");
      const actionArgs = args[operationIndex + 1] as Record<string, unknown>;
      const action = String(actionArgs.action);
      calls.push({ action, args: actionArgs });
      if (action === "read") {
        reads++;
        if (options.staleAfterRead && reads === 2) {
          settled = false;
          generation++;
        }
        return response();
      }
      if (action === "record-settle") {
        if (actionArgs.expectedGeneration !== generation || !settled) return response();
        generation++;
        outcome = String(actionArgs.outcome);
        recordReason = String(actionArgs.reason);
        return { ...response(), applied: true };
      }
      throw new Error(`Unexpected lifecycle action: ${action}`);
    },
    llm: async () => {
      llmCalls++;
      if (options.malformedGuess) return "not JSON";
      return JSON.stringify({
        reason: options.reason ?? "done-enough",
        outcome: "Useful work is complete.",
        uncertain: options.uncertain ?? false,
        finishing: "Run focused tests and tidy the notes.",
      });
    },
    ask: async (...args: Array<unknown>) => {
      asks.push(args[args.length - 1] as Record<string, unknown>);
      return options.answer ?? options.reason ?? "done-enough";
    },
    agent: async (...args: Array<unknown>) => {
      agents.push(args[args.length - 1] as Record<string, unknown>);
      return { threadId: "finishing-thread" };
    },
  };
  return {
    w,
    calls,
    asks,
    agents,
    get llmCalls() {
      return llmCalls;
    },
    run: async (input = { threadId: "thread-1" }) => (await loadBody())(w, input),
  };
}

describe("Settle task automation", () => {
  it("compiles as an event automation and uses a low-priority ask", () => {
    expect(compiled.workflow.meta.triggers).toEqual([{ on: "thread.settled" }]);
    expect(compiled.workflow.graph.nodes.map((node) => node.type)).toContain("branch");
    expect(SETTLE_TASK).toContain('importance: "low"');
    expect(SETTLE_TASK).toContain('action: "record-settle"');
  });

  it("records a dropped settle without starting a finishing agent", async () => {
    const test = fixture({ reason: "dropped" });
    await test.run();
    expect(test.calls.filter((call) => call.action === "record-settle")).toHaveLength(1);
    expect(test.agents).toEqual([]);
    expect(test.asks).toEqual([]);
  });

  it("skips automatic completion records", async () => {
    const test = fixture({ alreadyRecorded: true });
    await test.run();
    expect(test.llmCalls).toBe(0);
    expect(test.calls.filter((call) => call.action === "record-settle")).toEqual([]);
    expect(test.agents).toEqual([]);
  });

  it("runs the folder finishing pass only for done-enough", async () => {
    const test = fixture({ reason: "done-enough" });
    await test.run();
    expect(test.agents).toHaveLength(1);
    expect(test.agents[0]).toMatchObject({
      prompt: expect.stringContaining("represent this project folder"),
    });
    expect(test.asks).toEqual([]);
  });

  it("records an uncertain guess, asks quietly, then records the answer for learning", async () => {
    const test = fixture({ reason: "dropped", answer: "done-enough", uncertain: true });
    await test.run();
    expect(test.asks).toEqual([expect.objectContaining({ importance: "low" })]);
    expect(
      test.calls.filter((call) => call.action === "record-settle").map((call) => call.args.reason),
    ).toEqual(["dropped", "done-enough"]);
    expect(test.agents).toHaveLength(1);
  });

  it("treats unreadable model output as uncertain and never guesses its way into a finishing pass", async () => {
    const test = fixture({ malformedGuess: true, answer: "dropped" });
    await test.run();
    expect(test.asks).toEqual([expect.objectContaining({ importance: "low" })]);
    expect(test.agents).toEqual([]);
  });

  it("does not record or launch finishing work if a message reopens during classification", async () => {
    const test = fixture({ staleAfterRead: true });
    await test.run();
    expect(test.llmCalls).toBe(1);
    expect(test.calls.filter((call) => call.action === "record-settle")).toEqual([]);
    expect(test.agents).toEqual([]);
    expect(test.asks).toEqual([]);
  });
});
