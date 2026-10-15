// @effect-diagnostics globalDate:off - fake Workflows time is Date, as Workers' is.
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import type { StepRequest, HostStepStart } from "./hostProtocol.ts";
import { defineAutomationRun, type AutomationRunEnv } from "./runtime.ts";
import { FakeHost, FakeWorkflows, payload, type Receiver } from "./testing.ts";

class Entrypoint {
  readonly env: AutomationRunEnv;
  constructor(_ctx: unknown, env: AutomationRunEnv) {
    this.env = env;
  }
}

/** An automation as the compiler emits it: `load(workflow)` returning `workflow(body)`. */
const automation =
  (body: (w: Receiver, input: unknown, trigger: unknown) => Promise<unknown>) =>
  (workflow: (fn: (w: unknown, input: unknown, trigger: unknown) => Promise<unknown>) => unknown) =>
    workflow((w, input, trigger) => body(w as Receiver, input, trigger));

const runner = (
  host: FakeHost,
  body: (w: Receiver, input: unknown, trigger: unknown) => Promise<unknown>,
) => {
  const AutomationRun = defineAutomationRun(Entrypoint, automation(body));
  return new AutomationRun({}, { HOST: host });
};

const START = Date.UTC(2026, 9, 15, 9);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AutomationRun", () => {
  const answer = (request: StepRequest): HostStepStart => {
    switch (request.verb) {
      case "ask":
        return { type: "waiting", event: `answer-${request.key}`, timeoutMs: null };
      case "waitFor":
        return { type: "waiting", event: "ci-finished", timeoutMs: 60_000 };
      case "sleep":
        return { type: "sleep", until: Date.now() + 5_000 };
      case "judge":
        return { type: "done", value: (request.args[0] as { attempt: number }).attempt >= 1 };
      default:
        return { type: "done", value: `${request.verb}:${request.key}` };
    }
  };

  const everything = async (w: Receiver) => {
    const summary = await w.agent("n1", "Summarize", { prompt: "go" });
    const approval = await w.ask("n2", "Ship it?", { question: summary });
    let ci: unknown;
    try {
      ci = await w.waitFor("n3", "CI", { event: "ci" });
    } catch (error) {
      ci = `missed: ${(error as Error).message}`;
    }
    const slept = await w.sleep("n4", "Cool down", { ms: 5_000 });
    const both = await w.parallel("n5", "Fan out", {
      left: (b) => b.agent("n6", "Left", {}),
      right: (b) => b.notify("n7", "Right", {}),
    });
    const items = await w.each("n8", "Items", ["a", "b", "c"], { concurrency: 2 }, (b, item) =>
      b.llm("n9", `Item ${String(item)}`, { item }),
    );
    const loop = await w.repeat("n10", "Until good", { max: 3 }, async (b, attempt) => {
      const good = await b.judge("n11", "Good?", { attempt });
      if (b.when("n12", "Good", good)) return b.done(attempt);
      return undefined;
    });
    if (w.when("n13", "Again", false)) w.$arm("n14", 0);
    else w.$arm("n14", 1);
    await w.$frame("n15").remember("n16", "Save", { summary });
    await w.notify("n1", "Same site again", {});
    return { summary, approval, ci, slept, both, items, loop };
  };

  const OUTPUT = {
    summary: "agent:n1",
    approval: "ship",
    ci: "missed: CI never finished",
    slept: null,
    both: { left: "agent:n5.left/n6", right: "notify:n5.right/n7" },
    items: ["llm:n8[0]/n9", "llm:n8[1]/n9", "llm:n8[2]/n9"],
    loop: { done: true, value: 1, attempts: 2 },
  };

  const KEYS = [
    "n1",
    "n2",
    "n3",
    "n4",
    "n5.left/n6",
    "n5.right/n7",
    "n8[0]/n9",
    "n8[1]/n9",
    "n8[2]/n9",
    "n10[0]/n11",
    "n10[1]/n11",
    "n15/n16",
    "n1#1",
  ];

  const MARKS = new Map<string, unknown>([
    ["n8", { count: 3 }],
    ["n10[0]/n12", false],
    ["n10[1]/n12", true],
    ["n10", { attempts: 2, done: true }],
    ["n13", false],
    ["n14", 1],
  ]);

  it("runs every verb on Workflows steps, waits and sleeps, and replays without asking again", async () => {
    const engine = new FakeWorkflows();
    const late = new FakeHost(answer, () => ({ ok: false, error: "CI never finished" }));
    const entry = runner(late, everything);
    const result = entry.run(payload("run-1", { topic: "x" }), engine.step());

    await engine.idle();
    expect(engine.blocked()).toEqual(["n2~wait"]);
    engine.sendEvent("answer-n2", { ok: true, value: "ship" });
    await engine.idle();
    expect(engine.blocked()).toEqual(["n3~wait"]);
    engine.advance(60_000);
    await engine.idle();
    expect(engine.blocked()).toEqual(["n4~sleep"]);
    engine.advance(5_000);

    expect(await result).toEqual(OUTPUT);
    expect(late.stepKeys()).toEqual(KEYS);
    expect(late.of("timedOut").map((call) => call.key)).toEqual(["n3"]);
    expect(late.of("settled").map((call) => call.key)).toEqual(["n4"]);
    expect(late.of("failed")).toEqual([]);
    expect(late.finished().map(({ end }) => end)).toEqual([{ type: "completed", output: OUTPUT }]);
    expect(late.marks()).toEqual(MARKS);
    const args = late.of("step").find((call) => call.request?.key === "n2")?.request;
    expect(args).toEqual({
      key: "n2",
      verb: "ask",
      label: "Ship it?",
      args: [{ question: "agent:n1" }],
    });

    // The engine replays the finished run from the top: same names, no new host steps.
    const attempts = engine.attempts;
    const replayed = await runner(late, everything).run(payload("run-1"), engine.step());
    expect(replayed).toEqual(OUTPUT);
    expect(engine.attempts).toBe(attempts);
    expect(late.stepKeys()).toEqual(KEYS);
    // A sleep whose time has passed isn't asked for again; everything else replays by name.
    expect([...engine.runs[1]!].sort()).toEqual(
      engine.runs[0]!.filter((name) => name !== "n4~sleep").sort(),
    );
    expect(engine.runs[0]).toEqual(
      expect.arrayContaining(["n2~wait", "n3~wait", "n3~timeout", "n4~sleep"]),
    );
    // finish is journaled too; settled isn't, and repeats (the host makes it idempotent).
    expect(late.finished().map(({ end }) => end)).toEqual([{ type: "completed", output: OUTPUT }]);
    expect(late.of("settled").map((call) => call.key)).toEqual(["n4", "n4"]);
    expect(late.marks()).toEqual(MARKS);
  });

  it("resumes after the engine hibernates mid-wait, with the event buffered", async () => {
    const engine = new FakeWorkflows();
    const host = new FakeHost(answer);
    const body = async (w: Receiver) => {
      const summary = await w.agent("n1", "Summarize", {});
      if (w.when("n2", "Ask?", true)) return { summary, answer: await w.ask("n3", "OK?", {}) };
      return { summary };
    };
    void runner(host, body).run(payload("run-1"), engine.step());
    await engine.idle();
    expect(engine.blocked()).toEqual(["n3~wait"]);
    engine.evict();
    engine.sendEvent("answer-n3", { ok: false, error: "Declined" });

    await expect(runner(host, body).run(payload("run-1"), engine.step())).rejects.toThrow(
      "Declined",
    );
    expect(host.stepKeys()).toEqual(["n1", "n3"]);
    // n2 went out with n3's journaled step, so the replay doesn't send it again.
    expect(host.finished()).toEqual([{ end: { type: "failed", error: "Declined" }, marks: [] }]);
    expect(host.marks()).toEqual(new Map([["n2", true]]));
  });

  it("skips a sleep whose time passed while the engine was away", async () => {
    const engine = new FakeWorkflows();
    const host = new FakeHost(answer);
    const body = async (w: Receiver) => w.sleep("n1", "Nap", {});
    void runner(host, body).run(payload("run-1"), engine.step());
    await engine.idle();
    expect(engine.blocked()).toEqual(["n1~sleep"]);
    engine.evict();
    vi.setSystemTime(Date.now() + 10_000);

    expect(await runner(host, body).run(payload("run-1"), engine.step())).toBeNull();
    expect(host.of("settled").map((call) => call.key)).toEqual(["n1"]);
  });

  it("ends with a restart when the code returns w.restart", async () => {
    const engine = new FakeWorkflows();
    const host = new FakeHost(answer);
    const result = await runner(host, async (w, input) => {
      await w.notify("n1", "Ping", {});
      return w.restart({ round: (input as { round: number }).round + 1 });
    }).run(payload("run-1", { round: 1 }), engine.step());
    expect(result).toBeNull();
    expect(host.finished()).toEqual([{ end: { type: "restart", input: { round: 2 } }, marks: [] }]);
  });

  it("rejects a failed start into the code, which can catch it", async () => {
    const engine = new FakeWorkflows();
    const host = new FakeHost((request) =>
      request.key === "n1"
        ? { type: "failed", error: "No such tool", detail: { tool: "x" } }
        : { type: "done", value: "ok" },
    );
    const result = await runner(host, async (w) => {
      try {
        await w.call("n1", "Call", {});
      } catch (error) {
        return { caught: (error as Error).message, detail: (error as { detail?: unknown }).detail };
      }
      return "unreachable";
    }).run(payload("run-1"), engine.step());
    expect(result).toEqual({ caught: "No such tool", detail: { tool: "x" } });
  });

  it("retries a host that throws, then fails the step when Workflows gives up", async () => {
    const engine = new FakeWorkflows();
    let flaky = 0;
    const host = new FakeHost((request) => {
      if (request.key === "n1" && flaky++ < 2) throw new Error("host busy");
      if (request.key === "n2") throw new Error("host down");
      return { type: "done", value: "ok" };
    });
    const run = runner(host, async (w) => {
      const first = await w.agent("n1", "Flaky", {});
      if (w.when("n3", "Mark", true)) await w.agent("n2", "Down", {});
      return first;
    }).run(payload("run-1"), engine.step());
    await expect(run).rejects.toThrow("host down");
    expect(host.stepKeys()).toEqual(["n1", "n1", "n1", "n2", "n2", "n2", "n2"]);
    expect(host.of("failed").map(({ key, error }) => ({ key, error }))).toEqual([
      { key: "n2", error: "host down" },
    ]);
    // The mark the failed calls carried is retried with each attempt and lands with finish.
    expect(host.finished()).toEqual([
      { end: { type: "failed", error: "host down" }, marks: [["n3", true]] },
    ]);
    expect(
      host
        .of("step")
        .filter((call) => call.request?.key === "n2")
        .map((call) => call.marks),
    ).toEqual([[["n3", true]], [["n3", true]], [["n3", true]], [["n3", true]]]);
  });

  it("lets an engine abort through without finishing the run, even when the code catches it", async () => {
    const engine = new FakeWorkflows();
    const host = new FakeHost(() => {
      throw new Error("unused");
    });
    const step = engine.step();
    const aborting = {
      ...step,
      do: () => Promise.reject(new Error("Aborting engine: User called pause")),
    };
    const run = runner(host, async (w) => {
      try {
        await w.agent("n1", "Work", {});
      } catch {
        // Code that swallows the abort can't start anything else either.
        await w.notify("n2", "After", {});
      }
      return "done";
    }).run(payload("run-1"), aborting);
    await expect(run).rejects.toThrow("Aborting engine: User called pause");
    expect(host.of("failed")).toEqual([]);
    expect(host.finished()).toEqual([]);
  });

  it("hashes step names that Workflows would reject, the same way every replay", async () => {
    const engine = new FakeWorkflows();
    const host = new FakeHost(answer);
    const long = "x".repeat(300);
    const body = async (w: Receiver) =>
      w.parallel("n1", "Fan", {
        [long]: (b) => b.agent("n2", "Long", {}),
        "émoji 🚀": (b) => b.agent("n3", "Unicode", {}),
      });
    const first = await runner(host, body).run(payload("run-1"), engine.step());
    await runner(host, body).run(payload("run-1"), engine.step());
    expect(first).toEqual({ [long]: `agent:n1.${long}/n2`, "émoji 🚀": "agent:n1.émoji 🚀/n3" });
    expect(host.stepKeys()).toEqual([`n1.${long}/n2`, "n1.émoji 🚀/n3"]);
    for (const name of engine.runs[0]!) {
      expect(name.length).toBeLessThanOrEqual(256);
      expect(name).toMatch(/^[\x20-\x7e]+$/);
    }
    expect(engine.runs[1]).toEqual(engine.runs[0]);
  });

  it("keeps concurrent runs in one isolate apart, loading the automation per run", async () => {
    const engine = new FakeWorkflows();
    const other = new FakeWorkflows();
    const host = new FakeHost(answer);
    let loads = 0;
    const AutomationRun = defineAutomationRun(Entrypoint, (workflow) => {
      loads++;
      return workflow(async (w, input) => {
        const receiver = w as Receiver;
        receiver.when("n1", "Which", input);
        return receiver.ask("n2", "Answer", {});
      });
    });
    const entry = new AutomationRun({}, { HOST: host });
    const one = entry.run(payload("run-1", true), engine.step());
    const two = entry.run(payload("run-2", false), other.step());
    await engine.idle();
    engine.sendEvent("answer-n2", { ok: true, value: 1 });
    other.sendEvent("answer-n2", { ok: true, value: 2 });
    expect(await Promise.all([one, two])).toEqual([1, 2]);
    expect(loads).toBe(2);
    expect(host.marks("run-1")).toEqual(new Map([["n1", true]]));
    expect(host.marks("run-2")).toEqual(new Map([["n1", false]]));
  });

  it("fails a step whose wait breaks for another reason, and drops host notices that throw", async () => {
    const engine = new FakeWorkflows();
    const host = new FakeHost((request) =>
      request.key === "n1"
        ? { type: "waiting", event: "bad.type", timeoutMs: null }
        : { type: "sleep", until: Date.now() + 1_000 },
    );
    const notices: string[] = [];
    host.failed = async (_runId, key) => {
      notices.push(`failed ${key}`);
      throw new Error("host unreachable");
    };
    host.settled = async (_runId, key) => {
      notices.push(`settled ${key}`);
      throw new Error("host unreachable");
    };
    const step = engine.step();
    const broken: typeof step = {
      ...step,
      waitForEvent: () => Promise.reject(new Error("workflow.invalid_event_type")),
    };
    const run = runner(host, async (w) => {
      let caught = "";
      try {
        await w.ask("n1", "Ask", {});
      } catch (error) {
        caught = (error as Error).message;
      }
      const nap = w.sleep("n2", "Nap", {});
      await engine.idle();
      engine.advance(1_000);
      return { caught, slept: await nap };
    }).run(payload("run-1"), broken);
    expect(await run).toEqual({ caught: "workflow.invalid_event_type", slept: null });
    expect(notices).toEqual(["failed n1", "settled n2"]);
  });

  it("carries a settlement's detail onto the error the code sees", async () => {
    const engine = new FakeWorkflows();
    const host = new FakeHost(answer);
    const run = runner(host, async (w) => {
      try {
        return await w.ask("n1", "Approve?", {});
      } catch (error) {
        return {
          message: (error as Error).message,
          detail: (error as { detail?: unknown }).detail,
        };
      }
    }).run(payload("run-1"), engine.step());
    await engine.idle();
    engine.sendEvent("answer-n1", { ok: false, error: "Declined", detail: { why: "Too risky" } });
    expect(await run).toEqual({ message: "Declined", detail: { why: "Too risky" } });
  });

  it("refuses a module that doesn't export a workflow", async () => {
    const engine = new FakeWorkflows();
    const host = new FakeHost(answer);
    const AutomationRun = defineAutomationRun(Entrypoint, () => undefined);
    await expect(
      new AutomationRun({}, { HOST: host }).run(payload("run-1"), engine.step()),
    ).rejects.toThrow("The default export must be workflow");
    expect(host.finished().map(({ end }) => end?.type)).toEqual(["failed"]);
  });
});
