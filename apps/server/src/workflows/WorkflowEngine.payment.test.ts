import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { WorkflowEngine } from "@signalbox/automations/WorkflowEngine";
import { DEFAULTS, monitorsOf, withEngine } from "./WorkflowEngine.testkit.ts";

/**
 * The "Payment" built-in (#579): an agent's browser reached a payment, and
 * the Runner started this attached to the thread. It asks the person beside
 * the agent's live browser and returns how it went, which the waiting agent
 * reads from the run.
 */

const startPayment = (engine: WorkflowEngine["Service"], ownBrowserUrl: string | null = null) =>
  Effect.gen(function* () {
    const run = yield* engine.startRun({
      automationId: "builtin:payment",
      input: { threadId: "thread-9", site: "shop.test", note: "Kettle, 12 CHF", ownBrowserUrl },
      attach: { threadId: ThreadId.make("thread-9"), key: "payment:tab-1", label: "Paying" },
      trigger: "manual",
      projectId: "project-automations",
      builtInDefaults: DEFAULTS,
    });
    yield* engine.drain;
    const ask = (yield* engine.getRun(run.id)).steps.find(
      (step) => step.verb === "ask" && step.status === "waiting",
    );
    if (!ask) throw new Error("Payment isn't asking.");
    return { runId: run.id, stepKey: ask.key };
  });

it.effect("asks beside the agent's live browser, then returns what the person said", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const { runId, stepKey } = yield* startPayment(engine);

      // The thread shows the needs-you, and the question opens the thread's browser.
      expect(monitorsOf("thread-9").map((task) => task.description)).toEqual([
        "Finish the payment on shop.test",
      ]);
      const waiting = (yield* engine.list()).flatMap((automation) => automation.waiting);
      expect(waiting).toEqual([
        expect.objectContaining({
          runId,
          label: "Finish the payment on shop.test",
          options: ["done", "failed"],
          open: { threadId: "thread-9", view: "browser" },
          question:
            "Kettle, 12 CHF\n\nOpen the agent's browser, take over and pay. The agent waits until you say how it went.",
        }),
      ]);

      yield* engine.answer({ runId, stepKey, choice: "done", values: { note: "Paid by Twint" } });
      yield* engine.drain;
      const run = yield* engine.getRun(runId);
      expect(run.run.status).toBe("succeeded");
      expect(run.output).toEqual({ outcome: "done", note: "Paid by Twint" });
      expect(monitorsOf("thread-9")).toEqual([]);
    }),
  ),
);

it.effect("offers the person's own browser when the cart lives in their account", () =>
  withEngine(
    {},
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const { runId, stepKey } = yield* startPayment(engine, "https://shop.test/cart");
      const [question] = (yield* engine.list()).flatMap((automation) => automation.waiting);
      expect(question?.question).toContain(
        "Or finish it in your own browser: https://shop.test/cart",
      );

      yield* engine.answer({ runId, stepKey, choice: "failed", values: {} });
      yield* engine.drain;
      expect((yield* engine.getRun(runId)).output).toEqual({ outcome: "failed", note: null });
    }),
  ),
);
