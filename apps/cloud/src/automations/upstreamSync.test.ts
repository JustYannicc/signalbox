import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { compileForCloud } from "@signalbox/automation-compiler/compileForCloud";
import {
  defineAutomationRun,
  type AutomationRunEnv,
  type EntrypointClass,
  type LoadAutomation,
} from "@signalbox/automations/workflow/runtime";
import { FakeHost, FakeWorkflows, payload } from "@signalbox/automations/workflow/testing";

const readWorkflowSource = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = yield* path.fromFileUrl(
    new URL("../../../../scripts/upstream-sync/automations/sync-upstream.ts", import.meta.url),
  );
  return yield* fileSystem.readFileString(sourcePath);
});

type PullRequest = {
  readonly state: string;
  readonly mergeability: string;
  readonly checks: ReadonlyArray<{ readonly name: string; readonly status: string }>;
  readonly openThreads: number;
};

type InboxEvent = {
  readonly sequence: number;
  readonly envelope: Readonly<Record<string, unknown>>;
};

class Entrypoint {
  readonly env: AutomationRunEnv;

  constructor(_ctx: unknown, env: AutomationRunEnv) {
    this.env = env;
  }
}

const verifyCandidate = async (source: string) => {
  const compiled = compileForCloud(source);
  assert.isTrue(compiled.ok, JSON.stringify(compiled.ok ? [] : compiled.diagnostics));
  if (!compiled.ok) return;

  const workerModule = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.compiled.workerModule).toString("base64")}`
  );
  const AutomationRun = defineAutomationRun(
    Entrypoint as EntrypointClass,
    workerModule.load as LoadAutomation,
  );
  const stale: InboxEvent[] = Array.from({ length: 8 }, (_, index) => ({
    sequence: index + 1,
    envelope: {
      event: "pr.conflicted",
      id: `stale-${index + 1}`,
      at: "2026-10-17T20:16:20.000Z",
      headSha: null,
    },
  }));
  const inbox = [...stale];
  let inboxSequence = 8;
  let repairs = 0;
  let reads = 0;
  let cursors = 0;
  let latestRead: PullRequest | undefined;
  let gateSaw: PullRequest | undefined;

  const host = new FakeHost((request, runId) => {
    assert.strictEqual(runId, "run-988");
    if (request.verb === "recall") return { type: "done", value: null };
    if (request.verb === "remember" || request.verb === "notify")
      return { type: "done", value: null };
    if (request.verb === "eventCursor") {
      cursors++;
      return { type: "done", value: { runId, sequence: inboxSequence } };
    }
    if (request.verb === "agent") {
      if (request.label === "Merge upstream into a branch") {
        return {
          type: "done",
          value: {
            text: "RESULT: pr-opened #900",
            threadId: "thread-900",
            pullRequest: {
              url: "https://github.com/JustYannicc/signalbox/pull/900",
              number: 900,
            },
          },
        };
      }
      if (request.label === "Fix the pull request") {
        repairs++;
        return { type: "done", value: { text: "Fixed and pushed." } };
      }
      throw new Error(`unexpected agent step: ${request.label}`);
    }
    if (request.verb === "call") {
      const [operation] = request.args as [string, unknown];
      assert.strictEqual(operation, "signalbox.pull_request_read");
      assert.strictEqual(cursors, reads + 1, "capture happens immediately before every PR read");
      reads++;
      if (reads <= 4) {
        latestRead = {
          state: "open",
          mergeability: "conflicting",
          checks: [{ name: "CI", status: "failure" }],
          openThreads: 0,
        };
      } else if (reads === 5) {
        latestRead = {
          state: "open",
          mergeability: "mergeable",
          checks: [{ name: "CI", status: "pending" }],
          openThreads: 0,
        };
        inboxSequence++;
        inbox.push({
          sequence: inboxSequence,
          envelope: {
            event: "pr.checks.passed",
            id: "fresh-ci-pass",
            at: "2026-10-17T20:16:20.000Z",
            headSha: null,
          },
        });
      } else if (reads === 6) {
        latestRead = {
          state: "open",
          mergeability: "mergeable",
          checks: [{ name: "CI", status: "success" }],
          openThreads: 0,
        };
      } else {
        latestRead = {
          state: "merged",
          mergeability: "mergeable",
          checks: [{ name: "CI", status: "success" }],
          openThreads: 0,
        };
      }
      return { type: "done", value: latestRead };
    }
    if (request.verb === "waitFor") {
      const options = request.args[0] as {
        readonly on: ReadonlyArray<string>;
        readonly after?: { readonly runId: string; readonly sequence: number };
      };
      const index = inbox.findIndex(
        ({ sequence, envelope }) =>
          sequence > (options.after?.sequence ?? 0) && options.on.includes(String(envelope.event)),
      );
      if (index < 0) throw new Error(`wait has no matching event after ${options.after?.sequence}`);
      const [event] = inbox.splice(index, 1);
      return { type: "done", value: event!.envelope };
    }
    if (request.verb === "start") {
      const [automationName] = request.args as [string, unknown];
      assert.strictEqual(automationName, "Merge gate");
      gateSaw = latestRead;
      assert.deepStrictEqual(gateSaw?.checks, [{ name: "CI", status: "success" }]);
      assert.strictEqual(gateSaw?.mergeability, "mergeable");
      assert.strictEqual(gateSaw?.openThreads, 0);
      inboxSequence++;
      inbox.push({
        sequence: inboxSequence,
        envelope: {
          event: "pr.merged",
          id: "fresh-pr-merge",
          at: "2026-10-17T20:16:21.000Z",
          headSha: null,
        },
      });
      return { type: "done", value: { runId: "merge-gate-run" } };
    }
    throw new Error(`unexpected workflow step: ${request.verb} (${request.label})`);
  });
  const instance = new AutomationRun({}, { HOST: host });
  const workflow = instance.run(payload("run-988"), new FakeWorkflows().step());

  assert.strictEqual(await workflow, "#900: merged");
  assert.strictEqual(repairs, 4);
  assert.strictEqual(reads, 7, "the fresh CI event completes well inside the 12-round budget");
  assert.strictEqual(cursors, reads);
  assert.isNotNull(gateSaw);
  assert.strictEqual(inbox.length, 8, "the eight old events remain buffered");
  assert.isTrue(inbox.every((event) => event.envelope.event === "pr.conflicted"));

  const waits = host
    .of("step")
    .filter((call) => call.request?.verb === "waitFor")
    .map((call) => call.request!.args[0] as { after?: { sequence: number } });
  assert.deepStrictEqual(
    waits.map((wait) => wait.after?.sequence),
    [8, 9],
  );
};

it.effect(
  "uses a fresh PR event after four repairs and reaches the merge gate only with passing CI",
  () =>
    readWorkflowSource.pipe(
      Effect.flatMap((source) => Effect.promise(() => verifyCandidate(source))),
      Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
    ),
);
