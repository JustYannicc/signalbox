// @effect-diagnostics globalDate:off - asserts on the sandbox's deterministic Date.
import { workflowNodeIdForStepKey, type WorkflowNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { compileWorkflow, type CompiledWorkflow } from "../compiler/compileWorkflow.ts";
import {
  replayWorkflow,
  type JournalResult,
  type ReplayInput,
  type StepRequest,
} from "./replayWorkflow.ts";

const STARTED_AT = Date.UTC(2026, 9, 5, 9, 0);

function script(body: string, prelude = "") {
  const result = compileWorkflow(
    `${prelude}export const meta = { name: "Test" } as const;\nexport default workflow(async (w, input: any) => {\n${body}\n});\n`,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.workflow;
}

function replay(
  compiled: CompiledWorkflow,
  journal: ReadonlyMap<string, JournalResult>,
  extra: Partial<ReplayInput> = {},
) {
  return replayWorkflow({
    script: compiled.script,
    input: {},
    startedAt: STARTED_AT,
    seed: "run-1",
    result: ({ key }) => journal.get(key),
    ...extra,
  });
}

type Answer = { ok: true; value: unknown } | { ok: false; error: string };

/** Replays until the run stops asking for new steps, answering each with `answer`. Steps finish a minute apart. */
async function runToEnd(
  compiled: CompiledWorkflow,
  answer: (request: StepRequest) => Answer,
  input: unknown = {},
) {
  const journal = new Map<string, JournalResult>();
  for (let replays = 1; replays <= 50; replays++) {
    const outcome = await replay(compiled, journal, { input });
    if (outcome.type !== "suspended") return { outcome, journal, replays };
    for (const request of outcome.requests) {
      journal.set(request.key, {
        ...answer(request),
        at: STARTED_AT + (journal.size + 1) * 60_000,
      });
    }
  }
  throw new Error("run never finished");
}

function graphIds(nodes: ReadonlyArray<WorkflowNode>, ids = new Set<string>()) {
  for (const node of nodes) {
    ids.add(node.id);
    if (node.type === "loop") graphIds(node.body, ids);
    if (node.type === "try") graphIds([...node.body, ...node.failure], ids);
    if (node.type === "branch") for (const arm of node.arms) graphIds(arm.body, ids);
    if (node.type === "parallel") for (const arm of node.branches) graphIds(arm.body, ids);
  }
  return ids;
}

const value = (): Answer => ({ ok: true, value: null });

describe("replayWorkflow", () => {
  it("suspends on pending steps and resumes from the journal", async () => {
    const compiled = script(`
      const found = await w.agent("Fetch", { prompt: "list" });
      if (!w.when("Any?", found.length > 0)) return "nothing";
      const fixed = await w.each("Each", found, { concurrency: 2 }, async (w, item) => {
        const kind = await w.judge("Kind?", { input: item, outcomes: ["bug", "noise"] });
        if (kind === "noise") return null;
        return (await w.agent("Fix", { prompt: item })).text;
      });
      return fixed;
    `);
    const first = await replay(compiled, new Map());
    expect(first.type).toBe("suspended");
    expect(first.requests).toEqual([
      { key: "s1", verb: "agent", label: "Fetch", args: [{ prompt: "list" }] },
    ]);

    const { outcome } = await runToEnd(compiled, (request) => {
      if (request.label === "Fetch") return { ok: true, value: ["a", "b", "c"] };
      const args = request.args[0] as { input?: string; prompt?: string };
      if (request.verb === "judge")
        return { ok: true, value: args.input === "b" ? "noise" : "bug" };
      return { ok: true, value: { text: `fixed ${args.prompt}` } };
    });
    expect(outcome).toMatchObject({ type: "completed", output: ["fixed a", null, "fixed c"] });
    const loop = compiled.graph.nodes.find((node) => node.type === "loop")!;
    const decision = compiled.graph.nodes.find((node) => node.type === "branch")!;
    expect(outcome.marks.get(loop.id)).toEqual({ count: 3 });
    expect(outcome.marks.get(decision.id)).toBe(true);
  });

  it("keys repeated calls by occurrence so every key lands on a graph node", async () => {
    const compiled = script(
      `
      for (const name of ["a", "b"]) {
        await review(w, name);
        await w.notify("Reviewed", name);
      }
      await w.parallel("Gather", {
        mail: async (w) => w.call("Mail", "gmail.list", {}),
        calendar: async (w) => w.call("Calendar", "calendar.list", {}),
      });
      await w.repeat("Until clean", { max: 2 }, async (w) => {
        await review(w, "final");
      });
      `,
      `async function review(w: any, name: string) { await w.agent("Review", { prompt: name }); }\n`,
    );
    const { outcome, journal } = await runToEnd(compiled, value);
    expect(outcome.type).toBe("completed");
    const keys = [...journal.keys()];
    expect(keys).toContain("s2#1/s3");
    expect(keys).toContain("s4#1");
    const ids = graphIds(compiled.graph.nodes);
    for (const key of keys) expect(ids.has(workflowNodeIdForStepKey(key)), key).toBe(true);
  });

  it("asks for concurrent steps together", async () => {
    const compiled = script(`
      await w.parallel("Gather", {
        mail: async (w) => w.call("Mail", "gmail.list", {}),
        calendar: async (w) => w.call("Calendar", "calendar.list", {}),
      });
    `);
    const outcome = await replay(compiled, new Map());
    expect(outcome.requests.map((request) => request.key).toSorted()).toEqual([
      "s1.calendar/s3",
      "s1.mail/s2",
    ]);
  });

  it("stops a review loop on done and gives up after max", async () => {
    const compiled = script(`
      return await w.repeat("Review", { max: 3 }, async (w, attempt) => {
        const verdict = await w.judge("Clean?", { input: attempt, outcomes: ["pass", "findings"] });
        if (verdict === "pass") return w.done(attempt);
        await w.agent("Fix", { prompt: "fix" });
      });
    `);
    const passing = await runToEnd(compiled, (request) => ({
      ok: true,
      value: request.verb === "judge" ? (request.key.includes("[1]") ? "pass" : "findings") : null,
    }));
    expect(passing.outcome).toMatchObject({
      type: "completed",
      output: { done: true, value: 1, attempts: 2 },
    });
    const failing = await runToEnd(compiled, (request) => ({
      ok: true,
      value: request.verb === "judge" ? "findings" : null,
    }));
    expect(failing.outcome).toMatchObject({
      type: "completed",
      output: { done: false, attempts: 3 },
    });
  });

  it("lets code catch a failed step", async () => {
    const compiled = script(`
      try {
        await w.call("Post", "slack.chat.postMessage", {});
        return "posted";
      } catch (error) {
        await w.notify("Slack failed", String(error));
        return "notified";
      }
    `);
    const { outcome } = await runToEnd(compiled, (request) =>
      request.verb === "call" ? { ok: false, error: "slack is down" } : { ok: true, value: null },
    );
    expect(outcome).toMatchObject({ type: "completed", output: "notified" });
  });

  it("fails the run when a step fails and nothing catches it", async () => {
    const compiled = script(`await w.notify("Tell me", "hi"); return "unreachable";`);
    const { outcome } = await runToEnd(compiled, () => ({
      ok: false,
      error: "push service is down",
    }));
    expect(outcome).toMatchObject({ type: "failed", error: "push service is down" });
  });

  it("gives time and randomness the same values on every replay", async () => {
    const compiled = script(`
      const before = Date.now();
      await w.notify("Tick", "t");
      return { before, after: new Date().toISOString(), random: Math.random(), id: crypto.randomUUID() };
    `);
    const first = await runToEnd(compiled, value);
    const second = await runToEnd(compiled, value);
    expect(first.outcome.type === "completed" && first.outcome.output).toEqual(
      second.outcome.type === "completed" && second.outcome.output,
    );
    const output = (first.outcome as { output: { before: number; after: string; id: string } })
      .output;
    expect(output.before).toBe(STARTED_AT);
    expect(output.after).toBe(new Date(STARTED_AT + 60_000).toISOString());
    expect(output.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  describe("keeps time and randomness stable when concurrent steps finish in either order", () => {
    const tell = "await w.notify(`${name} ${Date.now()} ${Math.random()}`, crypto.randomUUID());";
    const helper = `async function fetchAndTell(w: any, name: string) {\n  await w.http("Fetch", { url: name });\n  ${tell}\n}\n`;
    it.each([
      [
        "w.parallel",
        script(`
          await w.parallel("Race", {
            a: async (w) => { const name = "a"; await w.http("Fetch", { url: name }); ${tell} },
            b: async (w) => { const name = "b"; await w.http("Fetch", { url: name }); ${tell} },
          });
        `),
      ],
      [
        "w.each",
        script(`
          await w.each("Race", ["a", "b"], { concurrency: 2 }, async (w, name) => {
            await w.http("Fetch", { url: name });
            ${tell}
          });
        `),
      ],
      [
        "Promise.all",
        script(`await Promise.all([fetchAndTell(w, "a"), fetchAndTell(w, "b")]);`, helper),
      ],
    ])("%s", async (_name, compiled) => {
      const at = (minutes: number) => STARTED_AT + minutes * 60_000;
      const done = (minutes: number): JournalResult => ({ ok: true, value: null, at: at(minutes) });
      const fetches = (await replay(compiled, new Map())).requests;
      const keyOf = (url: string) =>
        fetches.find((request) => (request.args[0] as { url: string }).url === url)!.key;
      const [a, b] = [keyOf("a"), keyOf("b")];

      // a's fetch finishes first: a's notify is requested with a label built from time and randomness.
      const first = await replay(compiled, new Map([[a, done(2)]]));
      const labels = new Map(first.requests.map((request) => [request.key, request.label]));
      expect(first.requests.find((request) => request.verb === "notify")?.label).toMatch(
        new RegExp(`^a ${at(2)} 0\\.\\d+$`),
      );

      for (const bFinished of [1, 3]) {
        const journal = new Map<string, JournalResult>([
          [a, done(2)],
          [b, done(bFinished)],
        ]);
        const second = await replay(compiled, journal);
        for (const request of second.requests) {
          if (labels.has(request.key)) expect(request.label).toBe(labels.get(request.key));
        }
        // Finish the run like the engine: a recorded key reached with another label is a mismatch.
        const recorded = new Map(first.requests.map((request) => [request.key, request.label]));
        let mismatch: string | null = null;
        for (let minute = 4; ; minute++) {
          const outcome = await replay(compiled, journal, {
            result: ({ key, label }) => {
              const known = recorded.get(key);
              if (known !== undefined && known !== label) mismatch ??= key;
              return journal.get(key);
            },
          });
          if (outcome.type !== "suspended") {
            expect(outcome.type).toBe("completed");
            break;
          }
          for (const request of outcome.requests) {
            if (!recorded.has(request.key)) recorded.set(request.key, request.label);
            if (!journal.has(request.key)) journal.set(request.key, done(minute));
          }
        }
        expect(mismatch).toBeNull();
      }
    });
  });

  it("collects console output with its level and deterministic time", async () => {
    const compiled = script(`
      console.log("start", { n: 1 }, [1, 2]);
      console.info(42);
      await w.notify("Tick", "t");
      console.warn("after", undefined);
      console.error(new Error("boom"));
      console.debug(null);
    `);
    const { outcome } = await runToEnd(compiled, value);
    const after = STARTED_AT + 60_000;
    expect(outcome.logs).toEqual([
      { level: "log", message: 'start {"n":1} [1,2]', at: STARTED_AT },
      { level: "info", message: "42", at: STARTED_AT },
      { level: "warn", message: "after undefined", at: after },
      { level: "error", message: "Error: boom", at: after },
      { level: "debug", message: "null", at: after },
    ]);
  });

  it("caps console output", async () => {
    const compiled = script(`
      console.log("x".repeat(5000));
      for (let n = 0; n < 600; n++) console.log(n);
    `);
    const { logs } = await replay(compiled, new Map());
    // The newest 200 lines stay, after a line saying how many earlier ones went.
    expect(logs).toHaveLength(201);
    expect(logs[0]).toEqual({
      level: "warn",
      message: "401 earlier log lines were dropped.",
      at: STARTED_AT,
    });
    expect(logs[1]!.message).toBe("400");
    expect(logs[200]!.message).toBe("599");

    const long = script(`for (let n = 0; n < 100; n++) console.log("y".repeat(5000));`);
    const capped = (await replay(long, new Map())).logs;
    // Lines are cut to 2000 characters and the whole log to 64 KB.
    expect(capped[1]!.message).toHaveLength(2000);
    expect(
      capped.slice(1).reduce((total, line) => total + line.message.length, 0),
    ).toBeLessThanOrEqual(64 * 1024);
  });

  it("provides the web globals QuickJS lacks", async () => {
    const compiled = script(`
      const original = { when: new Date(0), tags: new Map([["k", [1, { deep: true }]]]), seen: new Set(["a"]) };
      const copy = structuredClone(original);
      const bytes = new TextEncoder().encode("héllo 👋");
      const order: string[] = [];
      queueMicrotask(() => order.push("microtask"));
      order.push("sync");
      await w.notify("Tick", "t");
      const params = new URLSearchParams("?q=a+b%26c&q=2&emoji=%F0%9F%91%8B");
      params.append("space", "a b!*'()~");
      params.set("q", "only");
      return {
        cloned: copy !== original && copy.tags.get("k") !== original.tags.get("k") &&
          copy.when instanceof Date && copy.when.getTime() === 0 && copy.seen.has("a"),
        deep: copy.tags.get("k")[1],
        bytes: Array.from(bytes),
        text: new TextDecoder().decode(bytes),
        invalid: new TextDecoder().decode(new Uint8Array([0x61, 0xff, 0xe2, 0x82, 0x62])),
        base64: btoa("hello\\u00ff"),
        plain: atob("aGVs bG8="),
        query: params.toString(),
        emoji: params.get("emoji"),
        entries: [...params],
        object: new URLSearchParams({ a: "1", b: "x y" }).toString(),
        order,
      };
    `);
    const { outcome } = await runToEnd(compiled, value);
    const params = new URLSearchParams("?q=a+b%26c&q=2&emoji=%F0%9F%91%8B");
    params.append("space", "a b!*'()~");
    params.set("q", "only");
    const bytes = new TextEncoder().encode("héllo 👋");
    expect(outcome).toMatchObject({
      type: "completed",
      output: {
        cloned: true,
        deep: { deep: true },
        bytes: Array.from(bytes),
        text: "héllo 👋",
        invalid: new TextDecoder().decode(new Uint8Array([0x61, 0xff, 0xe2, 0x82, 0x62])),
        base64: btoa("helloÿ"),
        plain: "hello",
        query: params.toString(),
        emoji: "👋",
        entries: [...params],
        object: new URLSearchParams({ a: "1", b: "x y" }).toString(),
        order: ["sync", "microtask"],
      },
    });
  });

  it("passes the trigger as the third argument", async () => {
    const result = compileWorkflow(
      `export const meta = { name: "Test" } as const;\nexport default workflow(async (w, input: any, trigger: any) => ({ input, trigger }));\n`,
    );
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const trigger = { webhook: { body: { action: "opened" } } };
    expect(await replay(result.workflow, new Map(), { input: 1, trigger })).toMatchObject({
      type: "completed",
      output: { input: 1, trigger },
    });
    expect(await replay(result.workflow, new Map())).toMatchObject({
      output: { input: {}, trigger: null },
    });
  });

  it("cuts off code that runs too long", async () => {
    const compiled = script(`let n = 0; while (input.forever) { n++; } return n;`);
    const outcome = await replay(compiled, new Map(), {
      input: { forever: true },
      timeLimitMs: 100,
    });
    expect(outcome).toMatchObject({
      type: "failed",
      error: "The automation's code ran too long between steps.",
    });
  });
});

describe("decision marks", () => {
  it("records exactly which option each decision, loop pass and try path took", async () => {
    const compiled = script(`
      const kind = await w.judge("Kind?", { input, outcomes: ["bug", "question", "spam"] });
      // Which kind?
      if (kind === "bug") {
        await w.notify("Bug", "b");
      } else if (kind === "question") await w.notify("Question", "q");
      switch (input.size) {
        case "big":
          await w.notify("Big", "b");
          break;
        default:
          return "small";
      }
      return "done";
    `);
    const answers =
      (kind: string) =>
      (request: StepRequest): Answer => ({
        ok: true,
        value: request.verb === "judge" ? kind : null,
      });
    const spam = await runToEnd(compiled, answers("spam"), { size: "small" });
    const [judgeIf, sizeSwitch] = compiled.graph.nodes.filter((node) => node.type === "branch");
    expect(spam.outcome.marks.get(judgeIf!.id)).toBe(2);
    expect(spam.outcome.marks.get(sizeSwitch!.id)).toBe(1);
    expect(spam.outcome).toMatchObject({ output: "small" });

    const question = await runToEnd(compiled, answers("question"), { size: "big" });
    expect(question.outcome.marks.get(judgeIf!.id)).toBe(1);
    expect(question.outcome.marks.get(sizeSwitch!.id)).toBe(0);
    expect(question.outcome).toMatchObject({ output: "done" });
  });

  it("marks plain loop passes, try paths and expression branches", async () => {
    const compiled = script(`
      for (const name of ["a", "b", "c"]) await w.notify("Hi", name);
      try {
        await w.call("Post", "slack.post", {});
      } catch {
        await w.notify("Failed", "f");
      }
      const extra = input.more ? await w.llm("More", { prompt: "m" }) : null;
      return extra;
    `);
    const { outcome } = await runToEnd(compiled, (request) =>
      request.verb === "call" ? { ok: false, error: "down" } : { ok: true, value: null },
    );
    const loop = compiled.graph.nodes.find((node) => node.type === "loop")!;
    const attempt = compiled.graph.nodes.find((node) => node.type === "try")!;
    const ternary = compiled.graph.nodes.find((node) => node.type === "branch")!;
    expect(
      [...outcome.marks.keys()].filter((key) => key === loop.id || key.startsWith(`${loop.id}#`)),
    ).toHaveLength(3);
    expect(outcome.marks.get(attempt.id)).toBe(0);
    expect(outcome.marks.get(`${attempt.id}#1`)).toBe(1);
    expect(outcome.marks.get(ternary.id)).toBe(1);
  });
});
