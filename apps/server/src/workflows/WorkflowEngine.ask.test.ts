import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { WorkflowEngine } from "./WorkflowEngine.ts";
import { fakeHttp, fakeThreads, saveOk, withEngine } from "./WorkflowEngine.testkit.ts";

const run = (source: string, input?: unknown) =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine;
    const automation = yield* saveOk(source);
    const started = yield* engine.startRun({
      automationId: automation.id,
      trigger: "manual",
      ...(input === undefined ? {} : { input }),
    });
    yield* engine.drain;
    return { engine, runId: started.id };
  });

const engineOptions = () => ({ threads: fakeThreads(), http: fakeHttp() });

it.effect("answers an ask with an edited field and checks the form", () =>
  withEngineOptions(
    Effect.gen(function* () {
      const { engine, runId } = yield* run(`
export const meta = { name: "Reply" } as const;
export default workflow(async (w) => {
  const answer = await w.ask("Send this reply?", {
    fields: {
      reply: { type: "longText", default: "Hi there", required: true },
      copies: { type: "number" },
      urgent: { type: "boolean" },
      tone: { type: "choice", options: ["warm", "short"], default: "warm" },
    },
    options: ["send", "skip"],
  });
  return answer;
});
`);
      const ask = (yield* engine.getRun(runId)).steps[0]!;
      expect((yield* engine.list())[0]?.waiting[0]).toMatchObject({
        options: ["send", "skip"],
        multi: false,
        fields: [
          { name: "reply", type: "longText", label: "Reply", default: "Hi there", required: true },
          { name: "copies", type: "number", label: "Copies", default: null, required: false },
          { name: "urgent", type: "boolean", label: "Urgent", default: null, required: false },
          { name: "tone", type: "choice", options: ["warm", "short"], default: "warm" },
        ],
      });

      const rejected = (values: Record<string, unknown>) =>
        engine.answer({ runId, stepKey: ask.key, choice: "send", values }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      expect(yield* rejected({ reply: "  " })).toBe("Reply is required.");
      expect(yield* rejected({ copies: "2" })).toBe("Copies must be a number.");
      expect(yield* rejected({ tone: "loud" })).toBe("Tone must be one of its options.");
      expect(
        yield* engine.answer({ runId, stepKey: ask.key, choice: "maybe" }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        ),
      ).toBe("Answer with one of: send, skip.");

      yield* engine.answer({
        runId,
        stepKey: ask.key,
        choice: "send",
        values: { reply: "Hi, edited", copies: 2 },
      });
      yield* engine.drain;
      expect((yield* engine.getRun(runId)).output).toEqual({
        choice: "send",
        values: { reply: "Hi, edited", copies: 2, urgent: false, tone: "warm" },
      });
    }),
  ),
);

it.effect("answers multi-select and computed options, and fails asks it can't show", () =>
  withEngineOptions(
    Effect.gen(function* () {
      const { engine, runId } = yield* run(
        `
export const meta = { name: "Pick" } as const;
export default workflow(async (w, input: { dates: { title: string }[] }) => {
  const date = await w.ask("Which date?", { options: input.dates.map((d) => d.title) });
  const extras = await w.ask("Bring anything?", { options: ["cake", "tea", "chairs"], multi: true });
  await w.ask("Broken", { fields: input.dates });
  return { date, extras };
});
`,
        { dates: [{ title: "Mon" }, { title: "Tue" }] },
      );
      let detail = yield* engine.getRun(runId);
      expect((yield* engine.list())[0]?.waiting[0]?.options).toEqual(["Mon", "Tue"]);
      yield* engine.answer({ runId, stepKey: detail.steps[0]!.key, choice: "Tue" });
      yield* engine.drain;

      detail = yield* engine.getRun(runId);
      const multi = detail.steps[1]!;
      expect(
        yield* engine.answer({ runId, stepKey: multi.key, choices: ["cake", "beer"] }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        ),
      ).toBe("Answer with any of: cake, tea, chairs.");
      yield* engine.answer({ runId, stepKey: multi.key, choices: ["chairs", "cake"] });
      yield* engine.drain;

      detail = yield* engine.getRun(runId);
      expect(detail.steps[1]?.result).toEqual(["cake", "chairs"]);
      expect(detail.steps[2]).toMatchObject({ label: "Broken", status: "failed" });
      expect(detail.steps[2]?.error).toContain("fields must be an object");
      expect(detail.run.status).toBe("failed");
    }),
  ),
);

it.effect("goes on with onTimeout and the fields' defaults when nobody answers", () =>
  withEngineOptions(
    Effect.gen(function* () {
      const { engine, runId } = yield* run(`
export const meta = { name: "Timeout" } as const;
export default workflow(async (w) => {
  return await w.ask("Send it?", {
    fields: { note: { type: "text", default: "auto", required: true } },
    options: ["send", "hold"],
    timeout: { hours: 1 },
    onTimeout: "hold",
  });
});
`);
      yield* TestClock.adjust("2 hours");
      yield* engine.tick;
      yield* engine.drain;
      expect(yield* engine.getRun(runId)).toMatchObject({
        run: { status: "succeeded" },
        output: { choice: "hold", values: { note: "auto" } },
      });
    }),
  ),
);

function withEngineOptions<A, E>(body: Effect.Effect<A, E, WorkflowEngine>) {
  return withEngine(engineOptions(), body);
}
