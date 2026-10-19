import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as Platform from "../platform.ts";
import { makeGitHubOperationJournal } from "./githubOperationJournal.ts";

const dependencies = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  Platform.layerCrypto,
);

const workflow = {
  projectId: "project-1",
  repository: "acme/app",
  workflowFile: ".github/workflows/proof.yml",
  correlationId: "proof:codex:1.2.3",
  headSha: "a".repeat(40),
} as const;

it.effect("claims one durable workflow attempt and refuses a changed request", () =>
  Effect.gen(function* () {
    const firstJournal = yield* makeGitHubOperationJournal;
    const first = yield* firstJournal.claimWorkflow({
      ...workflow,
      request: { ref: "main", inputs: { runKey: workflow.correlationId } },
    });

    const secondJournal = yield* makeGitHubOperationJournal;
    const replay = yield* secondJournal.claimWorkflow({
      ...workflow,
      request: { inputs: { runKey: workflow.correlationId }, ref: "main" },
    });
    const conflict = yield* Effect.flip(
      secondJournal.claimWorkflow({
        ...workflow,
        request: { ref: "release", inputs: { runKey: workflow.correlationId } },
      }),
    );

    expect(first._tag).toBe("claimed");
    expect(replay._tag).toBe("pending");
    expect(conflict.message).toContain("already belongs to different input");
  }).pipe(Effect.provide(dependencies)),
);

it.effect("lets only one concurrent caller claim a workflow write", () =>
  Effect.gen(function* () {
    const journal = yield* makeGitHubOperationJournal;
    const claims = yield* Effect.all(
      [
        journal.claimWorkflow({ ...workflow, request: { ref: "main" } }),
        journal.claimWorkflow({ ...workflow, request: { ref: "main" } }),
      ],
      { concurrency: 2 },
    );

    expect(claims.map((claim) => claim._tag).sort()).toEqual(["claimed", "pending"]);
  }).pipe(Effect.provide(dependencies)),
);

it.effect("stores a completed result for replay without reopening the write", () =>
  Effect.gen(function* () {
    const journal = yield* makeGitHubOperationJournal;
    const attempt = yield* journal.claimIssue({
      projectId: "project-1",
      repository: "acme/app",
      correlationId: "issue:1",
      request: { title: "Hello", body: "World" },
    });
    expect(attempt._tag).toBe("claimed");
    if (attempt._tag !== "claimed") return;

    const result = { number: 12, title: "Hello", url: "https://github.com/acme/app/issues/12" };
    yield* journal.completeIssue({
      projectId: "project-1",
      repository: "acme/app",
      correlationId: "issue:1",
      requestHash: attempt.requestHash,
      result,
    });
    const replay = yield* journal.claimIssue({
      projectId: "project-1",
      repository: "acme/app",
      correlationId: "issue:1",
      request: { body: "World", title: "Hello" },
    });

    expect(replay).toMatchObject({
      _tag: "completed",
      resultJson: JSON.stringify(result),
    });
  }).pipe(Effect.provide(dependencies)),
);
