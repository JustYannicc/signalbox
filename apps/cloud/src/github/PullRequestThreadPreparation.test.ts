import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import {
  actor,
  headA,
  headB,
  makeHarness,
  makeInput,
  projectId,
  receipt,
  run,
} from "./PullRequestThreadPreparationTesting.ts";

describe("PullRequestThreadPreparation", () => {
  it.effect("requires an operation id before querying GitHub or changing child objects", () =>
    run(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const { operationId: _operationId, ...withoutOperationId } = makeInput();
        const failure = yield* Effect.flip(harness.prepare(actor, withoutOperationId));

        expect(failure._tag).toBe("GitManagerError");
        expect(harness.state.githubQueries).toHaveLength(0);
        expect(harness.state.driveRequests).toHaveLength(0);
        expect(harness.state.launchInputs).toHaveLength(0);
        expect(harness.state.dispatchInputs).toHaveLength(0);
      }),
    ),
  );

  it.effect("reserves the PR head before seeding and launches an empty linked thread", () =>
    run(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const result = yield* harness.prepare(actor, makeInput());
        const rows = yield* receipt(harness.sql, "prepare-operation-1");
        const driveRequest = harness.state.driveRequests[0]!.request;

        expect(rows).toHaveLength(1);
        expect(rows[0]!.selection).toContain(headA);
        expect(harness.state.driveObservedSelections).toHaveLength(1);
        expect(harness.state.driveObservedSelections[0]).toBe(rows[0]!.selection);
        expect(rows[0]!.selection).toContain(driveRequest.threadId);
        expect(driveRequest.headSha).toBe(headA);
        expect(result).toMatchObject({
          pullRequest: { number: 12, title: "Prepare PR 12", state: "open" },
          threadId: driveRequest.threadId,
          isOnPullRequestHead: true,
        });
        expect(harness.state.launchInputs).toHaveLength(1);
        expect(harness.state.launchInputs[0]).toMatchObject({
          threadId: driveRequest.threadId,
          projectId,
          title: "Prepare PR 12",
        });
        expect(harness.state.launchInputs[0]).not.toHaveProperty("initialMessage");
        expect(harness.state.launchInputs[0]).not.toHaveProperty("machine");
        expect(harness.state.dispatchInputs.map((command) => command.type)).toEqual([
          "thread.pull-request.link",
        ]);
        expect(harness.state.linkReceipts.size).toBe(1);
        expect(rows[0]!.completed).toBe(1);
      }),
    ),
  );

  it.effect("preserves a caller-supplied thread id", () =>
    run(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const requestedThreadId = ThreadId.make("chosen-thread");
        const result = yield* harness.prepare(
          actor,
          makeInput("chosen-operation", { threadId: requestedThreadId }),
        );
        const rows = yield* receipt(harness.sql, "chosen-operation");

        expect(rows[0]!.selection).toContain(requestedThreadId);
        expect(result.threadId).toBe(requestedThreadId);
        expect(harness.state.driveRequests[0]!.request.threadId).toBe(requestedThreadId);
      }),
    ),
  );

  it.effect(
    "retries a lost drive response against the reserved head even after GitHub advances",
    () =>
      run(
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          harness.state.failures.drive = 1;
          const firstFailure = yield* Effect.flip(harness.prepare(actor, makeInput()));
          expect(firstFailure._tag).toBe("GitManagerError");

          harness.state.headSha = headB;
          const result = yield* harness.prepare(actor, makeInput());

          expect(harness.state.githubQueries).toHaveLength(1);
          expect(harness.state.driveRequests.map(({ request }) => request.headSha)).toEqual([
            headA,
            headA,
          ]);
          expect(harness.state.seeds.size).toBe(1);
          expect(harness.state.launchInputs.map(({ threadId }) => threadId)).toEqual([
            result.threadId,
          ]);
        }),
      ),
  );

  it.effect.each(["drive", "launch", "link"] as const)(
    "recovers one thread after a lost %s response with the same operation",
    (stage) =>
      run(
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          harness.state.failures[stage] = 1;
          const firstFailure = yield* Effect.flip(harness.prepare(actor, makeInput()));
          expect(firstFailure._tag).toBe("GitManagerError");

          const recovered = yield* harness.prepare(actor, makeInput());
          const rows = yield* receipt(harness.sql, "prepare-operation-1");

          expect(rows[0]!.selection).toContain(recovered.threadId);
          expect(harness.state.seeds.size).toBe(1);
          expect(harness.state.threads.size).toBe(1);
          expect(new Set(harness.state.launchInputs.map(({ threadId }) => threadId))).toEqual(
            new Set([recovered.threadId]),
          );
          expect(harness.state.linkReceipts.size).toBe(1);
          expect(rows[0]!.completed).toBe(1);
        }),
      ),
  );

  it.effect("uses one stable thread identity for concurrent calls with the same operation id", () =>
    run(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const results = yield* Effect.all(
          [harness.prepare(actor, makeInput()), harness.prepare(actor, makeInput())],
          { concurrency: 2 },
        );

        expect(results[0]!.threadId).toBe(results[1]!.threadId);
        expect(new Set(harness.state.launchInputs.map(({ threadId }) => threadId))).toEqual(
          new Set([results[0]!.threadId]),
        );
        expect(yield* receipt(harness.sql, "prepare-operation-1")).toHaveLength(1);
      }),
    ),
  );

  it.effect("rechecks folder write access when replaying a completed operation", () =>
    run(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* harness.prepare(actor, makeInput());
        const accessChecks = harness.state.driveAccessCalls;
        const childCalls = harness.state.launchInputs.length;

        harness.state.role = "viewer";
        const failure = yield* Effect.flip(harness.prepare(actor, makeInput()));

        expect(failure._tag).toBe("GitManagerError");
        expect(harness.state.driveAccessCalls).toBe(accessChecks + 1);
        expect(harness.state.launchInputs).toHaveLength(childCalls);
      }),
    ),
  );

  it.effect("rejects a completed replay when the connected GitHub account changes", () =>
    run(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* harness.prepare(actor, makeInput());
        const childCalls = harness.state.launchInputs.length;
        harness.state.accountId = "account-B";

        const failure = yield* Effect.flip(harness.prepare(actor, makeInput()));

        expect(failure._tag).toBe("GitManagerError");
        expect(harness.state.repositoryCalls).toBe(2);
        expect(harness.state.launchInputs).toHaveLength(childCalls);
      }),
    ),
  );

  it.effect("rejects a completed replay when the folder repository changes", () =>
    run(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* harness.prepare(actor, makeInput());
        const childCalls = harness.state.launchInputs.length;
        harness.state.repository = "Acme/Other";

        const failure = yield* Effect.flip(harness.prepare(actor, makeInput()));

        expect(failure._tag).toBe("GitManagerError");
        expect(harness.state.repositoryCalls).toBe(2);
        expect(harness.state.launchInputs).toHaveLength(childCalls);
      }),
    ),
  );

  it.effect("rejects a completed replay when the acting folder owner changes", () =>
    run(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* harness.prepare(actor, makeInput());
        const childCalls = harness.state.launchInputs.length;
        harness.state.userId = "new-owner";

        const failure = yield* Effect.flip(harness.prepare(actor, makeInput()));

        expect(failure._tag).toBe("GitManagerError");
        expect(harness.state.launchInputs).toHaveLength(childCalls);
      }),
    ),
  );

  it.effect("rejects a completed replay when the prepared thread is no longer visible", () =>
    run(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const result = yield* harness.prepare(actor, makeInput());
        const thread = harness.state.threads.get(result.threadId!)!;
        thread.visible = false;

        const failure = yield* Effect.flip(harness.prepare(actor, makeInput()));

        expect(failure._tag).toBe("GitManagerError");
        expect(harness.state.launchInputs).toHaveLength(1);
      }),
    ),
  );

  it.effect("rejects reuse of an operation id for different input", () =>
    run(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* harness.prepare(actor, makeInput());
        const failure = yield* Effect.flip(
          harness.prepare(actor, makeInput("prepare-operation-1", { reference: "13" })),
        );

        expect(failure._tag).toBe("GitManagerError");
        expect(harness.state.githubQueries).toHaveLength(1);
        expect(harness.state.launchInputs).toHaveLength(1);
      }),
    ),
  );

  it.effect.each(["wrong-folder", "already-started", "already-linked"] as const)(
    "rejects a supplied %s thread before touching its drive or launching it",
    (kind) =>
      run(
        Effect.gen(function* () {
          const harness = yield* makeHarness;
          const existingThread = ThreadId.make(`existing-${kind}`);
          harness.state.threads.set(existingThread, {
            projectId: kind === "wrong-folder" ? ProjectId.make("other-folder") : projectId,
            runs: kind === "already-started" ? [{ id: "unrelated-run" }] : [],
            ...(kind === "already-linked"
              ? { pullRequests: [{ host: "github.com", repository: "Acme/Other", number: 3 }] }
              : {}),
            visible: true,
          });
          const failure = yield* Effect.flip(
            harness.prepare(actor, makeInput(`operation-${kind}`, { threadId: existingThread })),
          );

          expect(failure._tag).toBe("GitManagerError");
          expect(harness.state.driveRequests).toHaveLength(0);
          expect(harness.state.launchInputs).toHaveLength(0);
          expect(harness.state.dispatchInputs).toHaveLength(0);
        }),
      ),
  );
});
