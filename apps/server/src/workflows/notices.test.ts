import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { toJson } from "./json.ts";
import { automationNotice, failureNotice, relayNotificationForNotice } from "./notices.ts";
import * as WorkflowStore from "./WorkflowStore.ts";

const automation = { automation_id: "automation_1", name: "Triage Sentry" };
const AT = "2026-10-06T09:00:00.000Z";
const step = (verb: WorkflowStore.StepRow["verb"], label: string, args: unknown[]) => ({
  run_id: "run_1",
  step_key: "s3",
  verb,
  label,
  args_json: toJson(args),
});

it("an ask tells the user its question, or its label without one", () => {
  expect(
    automationNotice({
      automation,
      step: step("ask", "File it?", [{ question: "File 3 issues in Linear?" }]),
      at: AT,
    }),
  ).toEqual({
    id: "run_1/s3",
    kind: "ask",
    automationId: "automation_1",
    runId: "run_1",
    stepKey: "s3",
    title: "Triage Sentry",
    body: "File 3 issues in Linear?",
    importance: "high",
    at: AT,
  });
  expect(automationNotice({ automation, step: step("ask", "File it?", [{}]), at: AT })?.body).toBe(
    "File it?",
  );
});

it("a notify carries its message and importance, defaulting to normal", () => {
  const notice = (args: unknown[]) =>
    automationNotice({ automation, step: step("notify", "Done", args), at: AT });
  expect(notice(["Filed 3 issues"])).toMatchObject({
    kind: "notify",
    body: "Filed 3 issues",
    importance: "normal",
  });
  expect(notice(["Quiet", { importance: "low" }])?.importance).toBe("low");
  expect(notice(["Loud", { importance: "urgent" }])?.importance).toBe("normal");
  expect(notice([{ count: 3 }])?.body).toBe('{"count":3}');
  expect(notice(["  "])?.body).toBe("Done");
});

it("other steps tell the user nothing", () => {
  for (const verb of ["agent", "http", "sleep", "waitFor", "remember", "call"] as const) {
    expect(automationNotice({ automation, step: step(verb, "x", [{}]), at: AT })).toBeNull();
  }
});

it("phones get every notice but low ones, opening the run", () => {
  const ask = automationNotice({ automation, step: step("ask", "File it?", [{}]), at: AT })!;
  expect(relayNotificationForNotice(ask, "env 1")).toEqual({
    id: "run_1/s3",
    kind: "ask",
    title: "Triage Sentry",
    body: "File it?",
    deepLink: "/automations/env%201/runs/run_1",
  });
  expect(relayNotificationForNotice({ ...ask, importance: "low" }, "env")).toBeNull();
});

it("a failed run tells its owner why, loudly when nobody started it by hand", () => {
  const failed = (trigger: WorkflowStore.RunRow["trigger"]) =>
    failureNotice({
      automation,
      run: { run_id: "run_1", trigger },
      error: "Linear is down.",
      at: AT,
    });
  expect(failed("cron")).toEqual({
    id: "run_1/failed",
    kind: "failed",
    automationId: "automation_1",
    runId: "run_1",
    stepKey: "",
    title: "Triage Sentry",
    body: "Linear is down.",
    importance: "high",
    at: AT,
  });
  expect(failed("webhook").importance).toBe("high");
  expect(failed("manual").importance).toBe("normal");
  // Relays know ask and notify only; a failure alerts as a notify that says it failed.
  expect(relayNotificationForNotice(failed("cron"), "env")).toMatchObject({
    id: "run_1/failed",
    kind: "notify",
    title: "Triage Sentry failed",
    body: "Linear is down.",
  });
});

it.effect("a step moves into waiting or done only once, which is what gates notices", () =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore.make;
    yield* store.insertRun({
      run_id: "run_1",
      automation_id: "automation_1",
      version: 1,
      status: "running",
      trigger: "manual",
      input_json: "null",
      output_json: null,
      error: null,
      marks_json: "{}",
      trigger_json: null,
      parent_run_id: null,
      depth: 0,
      deadline_at: null,
      started_at: AT,
      finished_at: null,
    });
    const row = (step_key: string, verb: WorkflowStore.StepRow["verb"]) => ({
      run_id: "run_1",
      step_key,
      node_id: step_key,
      verb,
      label: step_key,
      status: "running" as const,
      args_json: "[]",
      result_json: null,
      error: null,
      error_detail_json: null,
      thread_id: null,
      wake_at: null,
      event: null,
      attempt: 1,
      started_at: AT,
      finished_at: null,
    });
    yield* store.insertStep(row("ask", "ask"));
    yield* store.insertStep(row("notify", "notify"));

    expect(yield* store.markWaiting("run_1", "ask", {})).toBe(true);
    expect(yield* store.markWaiting("run_1", "ask", {})).toBe(false);
    const done = { ok: true as const, value: "null" };
    expect(yield* store.completeStep("run_1", "notify", done, AT)).toMatchObject({
      step_key: "notify",
      status: "succeeded",
    });
    expect(yield* store.completeStep("run_1", "notify", done, AT)).toBeUndefined();
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
