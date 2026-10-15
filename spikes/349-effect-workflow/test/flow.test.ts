import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";

import { makeHost } from "../src/host.ts";
import { fakeObjectState } from "./fakeObjectState.ts";

const PR = "https://github.com/acme/app/pull/7";

/** A host for one deploy; closing its scope is the deploy going away. */
const deploy = (fake: ReturnType<typeof fakeObjectState>, name: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const host = yield* makeHost(fake.state, { deploy: name, boot: name }).pipe(
      Scope.provide(scope),
    );
    return { host, retire: Scope.close(scope, Exit.void) };
  });

const execution = (
  status: {
    executions: ReadonlyArray<Record<string, unknown>>;
    runs: ReadonlyArray<Record<string, unknown>>;
  },
  runId: string,
) => {
  const run = status.runs.find((row) => row.run_id === runId)!;
  return status.executions.find((row) => row.execution_id === run.execution_id)!;
};

describe("#397 on effect/workflow: follow a PR to merge, across a redeploy", () => {
  it.live("Watch pull request + Merge gate, real built-ins", () =>
    Effect.gen(function* () {
      const fake = fakeObjectState();
      const first = yield* deploy(fake, "deploy-1");

      const watch = yield* first.host.start({
        automation: "watch-pull-request",
        input: { threadId: "t1", number: 7, repository: "acme/app", url: PR },
      });
      const gate = yield* first.host.start({
        automation: "merge-gate",
        input: { threadId: "t1", url: PR, repository: "acme/app", number: 7, note: "CI is green." },
      });
      let status = yield* first.host.status;
      assert.strictEqual(execution(status, watch).status, "suspended");
      assert.strictEqual(execution(status, gate).status, "suspended");
      assert.deepStrictEqual(
        status.asks.map((ask) => ask.label),
        ["Merge acme/app#7?"],
      );
      // "Wait for news" waits 30 minutes: that's a real clock, so the alarm is armed.
      assert.ok(fake.alarmAt()! > Date.now() + 29 * 60_000);

      // CI passes: the watch wakes the agent and waits again.
      yield* first.host.emit("pr.checks.passed", {
        threadId: "t1",
        number: 7,
        repository: "acme/app",
        url: PR,
      });
      status = yield* first.host.status;
      assert.match(String(status.messages.at(-1)?.message), /^Checks passed on pull request #7/);
      assert.strictEqual(execution(status, watch).status, "suspended");

      // Half an hour of quiet: the alarm fires the timeout, the watch checks the PR is still open and goes on.
      fake.fastForwardClocks();
      yield* first.host.alarm;
      status = yield* first.host.status;
      assert.strictEqual(execution(status, watch).status, "suspended");
      assert.strictEqual(status.messages.length, 1);

      // Redeploy while the merge gate waits on a person: nothing survives in memory.
      yield* first.retire;
      const second = yield* deploy(fake, "deploy-2");
      status = yield* second.host.status;
      assert.strictEqual(execution(status, gate).status, "suspended");

      // The person says merge, on the new deploy.
      yield* second.host.answer(Number(status.asks[0]!.ask_id), { choice: "merge" });
      status = yield* second.host.status;

      assert.strictEqual(execution(status, gate).status, "complete");
      assert.strictEqual(execution(status, watch).status, "complete");
      const messages = status.messages.map((row) => String(row.message));
      assert.ok(messages.some((message) => message.startsWith("Merged acme/app#7")));
      assert.deepStrictEqual(
        status.pullRequests.map((row) => [row.state, row.branch_deleted]),
        [["merged", 1]],
      );
      // The merge raised pr.merged, which ended the watch.
      assert.deepStrictEqual(
        status.events.map((row) => row.event),
        ["pr.checks.passed", "pr.merged"],
      );
      yield* second.retire;
    }),
  );
});

describe("#294 shape on effect/workflow: alert → reproduce → fix → gate", () => {
  it.live("judge, agent, hook, ask, call, waitFor with a timeout, notify", () =>
    Effect.gen(function* () {
      const fake = fakeObjectState();
      const { host, retire } = yield* deploy(fake, "deploy-1");
      const run = yield* host.start({
        automation: "fix-an-alert",
        input: { alertId: "A-1", title: "Blank login page", users: 40, release: "1.4.2" },
      });
      let status = yield* host.status;
      const repro = status.agents[0]!;
      yield* host.finishTurn(
        String(repro.thread_id),
        "Reproduced: login.test.ts fails on Safari 18.",
        null,
      );
      yield* host.finishTurn(String(repro.thread_id), "Fixed it.", {
        number: 12,
        url: "https://github.com/acme/app/pull/12",
      });
      status = yield* host.status;
      const ask = status.asks.at(-1)!;
      assert.strictEqual(ask.label, "Merge the fix for Blank login page?");
      yield* host.answer(Number(ask.ask_id), { choice: "merge" });

      // The deploy calls back through the link the run made; the run is listening for it.
      status = yield* host.status;
      const listening = status.listeners.find((row) => row.done_at === null)!;
      const { hookId } = JSON.parse(String(listening.filter)) as { hookId: string };
      yield* host.hookCalled(hookId, "POST", { version: "1.4.3" });

      status = yield* host.status;
      const done = execution(status, run);
      assert.strictEqual(done.status, "complete");
      assert.deepStrictEqual(
        status.notices.map((row) => row.message),
        ["Blank login page (1.4.2): it's live"],
      );
      yield* retire;
    }),
  );
});
